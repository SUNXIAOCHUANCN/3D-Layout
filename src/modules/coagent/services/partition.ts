/**
 * partition（W06）——鸟瞰 VLM 给出的多边形 → 世界坐标分区 → 归属校验。
 *
 * 为什么不能"VLM 说一段话就算分区"（SPEC §W06 完成条件）：
 * 1. 模型只允许给**归一化图像坐标**（左上原点 u/v），世界坐标由程序用**同一台相机**
 *    反算，避免模型瞎猜尺度；
 * 2. 多边形要程序校验（≥3 唯一顶点、无自交、面积 > ε、u/v 在合理范围）；
 * 3. 对象归属由程序按地面锚点判（多命中=歧义、零命中=未归属，都显式列出）；
 * 4. 分区之间重叠也要显式报出来（多区重叠会让"越权写入"变得说不清）。
 *
 * 本文件不碰渲染/浏览器 API（`blobToDataUrl` 兼容 node 与浏览器），因此可单测。
 */

import type { AssetDTO, CameraSnapshot, ModelPort, PartitionSnapshot, Region } from '../contracts'
import { CoAgentError } from '../contracts'
import { polygonAreaXZ, polygonSelfIntersects, validatePartitionSnapshot } from '../schemas'

export interface PartitionProposalRegion {
  name: string
  description?: string
  /** 归一化图像坐标（左上原点，u∈[0,1], v∈[0,1]） */
  polygonUV: Array<[number, number]>
}

export interface PartitionProposal {
  regions: PartitionProposalRegion[]
  notes?: string
}

export interface RegionDraft {
  id: string
  name: string
  description?: string
  polygonXZ: Array<[number, number]>
}

export interface AssignmentIssue {
  objectId: string
  kind: 'ambiguous' | 'unassigned'
  regionIds: string[]
}

export interface PartitionReport {
  cameraId: string
  proposal: PartitionProposal
  issues: string[]
  ambiguous: AssignmentIssue[]
  unassigned: string[]
  readonlyObjectIds: string[]
  createdAt: string
}

export const PARTITION_PROMPT_VERSION = 'w06-v1'

/** 兼容旧导入：实现已抽到 services/imageData（W08.2 判定/执行也要用） */
export { blobToDataUrl } from './imageData'

/** 从模型文本里抠出提案 JSON（允许 ```json 围栏与前后噪声） */
export function parsePartitionProposal(text: string): PartitionProposal {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new CoAgentError('invalid_plan', '分区提案不是 JSON：模型没有按要求输出对象')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (e) {
    throw new CoAgentError('invalid_plan', `分区提案 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
  const obj = parsed as Record<string, unknown>
  const regions = obj.regions
  if (!Array.isArray(regions) || regions.length < 2) {
    throw new CoAgentError('invalid_plan', `分区提案需要至少 2 个区域，实际 ${Array.isArray(regions) ? regions.length : 0}`)
  }
  const out: PartitionProposalRegion[] = []
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i] as Record<string, unknown>
    if (typeof r.name !== 'string' || r.name.trim().length === 0) {
      throw new CoAgentError('invalid_plan', `regions[${i}].name 缺失`)
    }
    if (!Array.isArray(r.polygonUV) || r.polygonUV.length < 3) {
      throw new CoAgentError('invalid_plan', `regions[${i}].polygonUV 至少需要 3 个点`)
    }
    const polygonUV: Array<[number, number]> = []
    for (const p of r.polygonUV) {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(n => typeof n === 'number' && Number.isFinite(n))) {
        throw new CoAgentError('invalid_plan', `regions[${i}].polygonUV 含非法点`)
      }
      polygonUV.push([p[0] as number, p[1] as number])
    }
    out.push({
      name: r.name,
      ...(typeof r.description === 'string' ? { description: r.description } : {}),
      polygonUV,
    })
  }
  return { regions: out, ...(typeof obj.notes === 'string' ? { notes: obj.notes } : {}) }
}

/**
 * 归一化图像坐标 → 世界 XZ（仅支持俯视正交相机，W06 的鸟瞰分区就是这种）。
 * 约定与 regionCamera 一致：up=(0,0,-1) 时画面向上 = 世界 -Z。
 */
export function uvToWorldXZ(camera: CameraSnapshot, uv: [number, number]): [number, number] {
  if (camera.projection !== 'orthographic' || !camera.ortho) {
    throw new CoAgentError('invalid_plan', '分区只支持正交相机（鸟瞰）')
  }
  const [u, v] = uv
  if (!Number.isFinite(u) || !Number.isFinite(v)) throw new CoAgentError('invalid_plan', 'uv 必须是有限数字')
  const o = camera.ortho
  const [cx, , cz] = camera.position
  const localX = o.left + u * (o.right - o.left)
  const localY = o.bottom + (1 - v) * (o.top - o.bottom)
  // 相机局部 +Y = up 向量：up=(0,0,-1) 时局部 +Y 指向世界 -Z
  const upZ = camera.up[2] >= 0 ? 1 : -1
  return [cx + localX, cz + upZ * localY]
}

function slug(name: string, index: number): string {
  const base = name
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `region-${base || index + 1}`
}

/** 提案 → 世界坐标区域草稿（含几何校验） */
export function proposalToDrafts(proposal: PartitionProposal, camera: CameraSnapshot): { drafts: RegionDraft[]; issues: string[] } {
  const drafts: RegionDraft[] = []
  const issues: string[] = []
  proposal.regions.forEach((r, i) => {
    const polygonXZ = r.polygonUV.map(uv => uvToWorldXZ(camera, uv))
    if (polygonSelfIntersects(polygonXZ)) {
      issues.push(`区域「${r.name}」多边形自交，已跳过`)
      return
    }
    const area = polygonAreaXZ(polygonXZ)
    if (!(area > 1e-3)) {
      issues.push(`区域「${r.name}」面积过小（${area.toFixed(4)} m²），已跳过`)
      return
    }
    const id = slug(r.name, i)
    if (drafts.some(d => d.id === id)) {
      issues.push(`区域「${r.name}」与已有区重名，已跳过`)
      return
    }
    drafts.push({
      id,
      name: r.name,
      ...(r.description !== undefined ? { description: r.description } : {}),
      polygonXZ,
    })
  })
  return { drafts, issues }
}

/** 点在多边形内（射线法） */
export function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]
    const [xj, zj] = polygon[j]
    const intersects = zi > point[1] !== zj > point[1] && point[0] < ((xj - xi) * (point[1] - zi)) / (zj - zi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** 对象归属：按地面锚点判；多命中与零命中都显式返回 */
export function assignByAnchor(
  drafts: RegionDraft[],
  assets: Array<{ id: string; transform: { position: [number, number, number] } }>,
): { assignments: Record<string, string[]>; issues: AssignmentIssue[] } {
  const assignments: Record<string, string[]> = {}
  for (const d of drafts) assignments[d.id] = []
  const issues: AssignmentIssue[] = []
  for (const a of assets) {
    const anchor: [number, number] = [a.transform.position[0], a.transform.position[2]]
    const hits = drafts.filter(d => pointInPolygon(anchor, d.polygonXZ)).map(d => d.id)
    if (hits.length === 1) assignments[hits[0]].push(a.id)
    else if (hits.length === 0) issues.push({ objectId: a.id, kind: 'unassigned', regionIds: [] })
    else issues.push({ objectId: a.id, kind: 'ambiguous', regionIds: hits })
  }
  return { assignments, issues }
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const cross = (o: [number, number], p: [number, number], q: [number, number]): number =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** 两多边形的内部是否相交（含边相交与顶点包含） */
export function polygonsOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.some(p => pointInPolygon(p, b)) || b.some(p => pointInPolygon(p, a))) return true
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i]
    const a2 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true
    }
  }
  return false
}

export function detectOverlaps(drafts: RegionDraft[]): Array<{ a: string; b: string }> {
  const pairs: Array<{ a: string; b: string }> = []
  for (let i = 0; i < drafts.length; i++) {
    for (let j = i + 1; j < drafts.length; j++) {
      if (polygonsOverlap(drafts[i].polygonXZ, drafts[j].polygonXZ)) pairs.push({ a: drafts[i].id, b: drafts[j].id })
    }
  }
  return pairs
}

/** 场景鸟瞰相机（正交俯视，up=(0,0,-1)）：分区截图与 uv 反算共用同一台 */
export function birdseyeCamera(assets: Array<{ transform: { position: [number, number, number] } }>, pad = 2, aspect = 4 / 3): CameraSnapshot {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const a of assets) {
    minX = Math.min(minX, a.transform.position[0])
    maxX = Math.max(maxX, a.transform.position[0])
    minZ = Math.min(minZ, a.transform.position[2])
    maxZ = Math.max(maxZ, a.transform.position[2])
  }
  if (!Number.isFinite(minX)) {
    minX = -10
    maxX = 10
    minZ = -10
    maxZ = 10
  }
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const needW = Math.max((maxX - minX) / 2, 1) + pad
  const needD = Math.max((maxZ - minZ) / 2, 1) + pad
  // 正交视锥的宽高比必须等于输出图宽高比，同时不能裁掉任何一个方向的场景：
  // 按"更受限的那一边"放大，两个方向都覆盖
  let halfW = needW
  let halfH = needD
  if (needW / needD > aspect) halfH = needW / aspect
  else halfW = needD * aspect
  const height = Math.max(halfW, halfH) * 2 + 10
  return {
    schemaVersion: 1,
    id: 'cam-birdseye',
    projection: 'orthographic',
    position: [cx, height, cz],
    target: [cx, 0, cz],
    up: [0, 0, -1],
    near: 0.1,
    far: height * 3 + 100,
    aspect,
    ortho: { left: -halfW, right: halfW, top: halfH, bottom: -halfH },
  }
}

export interface BuiltPartition {
  partition: PartitionSnapshot
  report: PartitionReport
}

/**
 * 组装最终分区快照。歧义对象的处理策略显式传入：
 * - 'skip'：先不归任何区（留给人工修正），并进 issues；
 * - 'readonly'：标记为 global_readonly（跨区大对象，如道路/地形）。
 */
export function buildPartition(input: {
  proposal: PartitionProposal
  camera: CameraSnapshot
  assets: AssetDTO[]
  partitionVersion: number
  ambiguousPolicy?: 'skip' | 'readonly'
}): BuiltPartition {
  const { drafts, issues } = proposalToDrafts(input.proposal, input.camera)
  if (drafts.length < 2) {
    throw new CoAgentError('invalid_plan', `有效区域不足 2 个：${issues.join('；') || '无有效多边形'}`)
  }
  const overlaps = detectOverlaps(drafts)
  for (const o of overlaps) issues.push(`区域 ${o.a} 与 ${o.b} 在平面上重叠，请修正多边形`)
  const { assignments, issues: assignIssues } = assignByAnchor(drafts, input.assets)
  const policy = input.ambiguousPolicy ?? 'skip'
  const readonly: string[] = []
  for (const it of assignIssues) {
    if (it.kind === 'ambiguous') {
      if (policy === 'readonly') readonly.push(it.objectId)
      else issues.push(`对象 ${it.objectId} 同时落在 ${it.regionIds.join('/')}，需人工归属`)
    } else {
      issues.push(`对象 ${it.objectId} 未落在任何区（未归属）`)
    }
  }

  const regions: Region[] = drafts.map(d => ({
    schemaVersion: 1,
    id: d.id,
    name: d.name,
    polygonXZ: d.polygonXZ,
    objectIds: assignments[d.id] ?? [],
    cameraId: input.camera.id,
    partitionVersion: input.partitionVersion,
  }))

  const partition: PartitionSnapshot = {
    partitionVersion: input.partitionVersion,
    regions,
    globalReadonlyObjectIds: [...new Set(readonly)],
  }
  const check = validatePartitionSnapshot(partition)
  if (!check.ok) {
    throw new CoAgentError('invalid_plan', `分区快照非法：${check.issues.map(i => `${i.path} ${i.message}`).join('; ')}`)
  }

  return {
    partition,
    report: {
      cameraId: input.camera.id,
      proposal: input.proposal,
      issues,
      ambiguous: assignIssues.filter(i => i.kind === 'ambiguous'),
      unassigned: assignIssues.filter(i => i.kind === 'unassigned').map(i => i.objectId),
      readonlyObjectIds: readonly,
      createdAt: new Date().toISOString(),
    },
  }
}

/** 鸟瞰分区提示词（版本化：写入 report 便于复盘） */
export function partitionPrompt(input: { objectCount: number; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }): string {
  return [
    '你是场景分区助手。下面是一张正交俯视图（正上方俯视，画面向上 = 世界 -Z）。',
    `场景共 ${input.objectCount} 个资产，平面范围 x∈[${input.bounds.minX.toFixed(1)}, ${input.bounds.maxX.toFixed(1)}]，z∈[${input.bounds.minZ.toFixed(1)}, ${input.bounds.maxZ.toFixed(1)}]（米）。`,
    '请把画面划分成 2~4 个语义区域（例如林地/村庄/空地），输出 JSON：',
    '{"regions":[{"name":"…","description":"…","polygonUV":[[u,v],[u,v],[u,v]]}],"notes":"…"}',
    '要求：',
    '- polygonUV 用**归一化图像坐标**（左上原点，u 向右、v 向下，0~1），不要给世界坐标；',
    '- 每个区域至少 3 个顶点、按顺序给出、不自交；区域之间不要重叠；',
    '- 只输出 JSON，不要解释文字。',
  ].join('\n')
}

/** 调模型拿提案（无工具；图像走用户轮） */
export async function requestPartition(input: {
  model: ModelPort
  imageDataUrl: string
  cameraId: string
  objectCount: number
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  signal: AbortSignal
  timeoutMs: number
}): Promise<{ proposal: PartitionProposal; text: string }> {
  const reply = await input.model.complete(
    {
      purpose: 'partition',
      system: '你只输出 JSON，不输出解释文字。',
      messages: [
        {
          role: 'user',
          text: partitionPrompt({ objectCount: input.objectCount, bounds: input.bounds }),
          images: [{ mediaType: 'image/png', dataUrl: input.imageDataUrl }],
        },
      ],
      tools: [],
      timeoutMs: input.timeoutMs,
    },
    input.signal,
  )
  return { proposal: parsePartitionProposal(reply.text), text: reply.text }
}
