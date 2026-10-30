/**
 * partitionPersistence（P4）——分区配套文件的契约、序列化与恢复核对。
 *
 * 为什么要有它：分区原先只活在 runtime 内存里（`partitionOverride`），
 * 刷新或重开就要重新调模型划区，区域 ID、边界和人工修正都留不住。
 *
 * 设计边界（与 [07-分区长期存储](../../../../develop-guide/CoAgent/revision-2026-10-27/07-分区长期存储.md) 一致）：
 * - 只保存**区域定义 + 经过核对的对象归属**，不保存"永远正确的对象列表"；
 * - 保存世界米制 XZ 多边形与稳定区域 ID，恢复时**不重新按名字生成 ID**；
 * - 不保存 objectCount / token / runState / 对话 / 证据图 / 未提交事务；
 * - schemaVersion 管格式迁移，partitionVersion 管内容变化，两者分离。
 *
 * 本文件是纯函数（不碰 fetch / 磁盘），IO 在 adapters/partitionAdapter.ts。
 */

import type { PartitionSnapshot, Region } from '../contracts'
import { validatePolygonXZ } from '../schemas'

export const PARTITION_FILE_SCHEMA_VERSION = 1
/** 指纹算法版本：算法变了要改它，否则新旧指纹会被当成可比 */
export const PARTITION_FINGERPRINT_VERSION = 'pfp1'
export const PARTITION_FILE_NAME = 'partition.json'
/** 区域默认相机（与 services/partition.ts 的 birdseyeCamera 一致） */
const DEFAULT_REGION_CAMERA = 'cam-birdseye'

export type AssignmentSource = 'auto' | 'manual' | 'agent'

export type PartitionFileRegion = {
  id: string
  name: string
  polygonXZ: Array<[number, number]>
}

export type PartitionFileAssignment = {
  objectId: string
  regionId: string
  source: AssignmentSource
  /** 便于发现"同 ID 换了资产"；不当作全局身份证明 */
  ref?: string
}

export type PartitionFile = {
  schemaVersion: number
  sceneId: string
  partitionVersion: number
  savedAt: string
  sceneFingerprint: string
  regions: PartitionFileRegion[]
  assignments: PartitionFileAssignment[]
  readonlyAssignments: Array<{ objectId: string; source: AssignmentSource; ref?: string }>
  unresolvedObjectIds: string[]
}

export type PartitionFileParse = { ok: true; file: PartitionFile } | { ok: false; issues: string[] }

// ---------------------------------------------------------------------------
// 内容指纹
// ---------------------------------------------------------------------------

/**
 * 指纹与核对只需要这几个字段（结构化类型，方便测试夹具直接传）。
 * 注意 scale 在 core 的 SceneAsset 里是可选的，必须先归一化再参与摘要。
 */
export type FingerprintAsset = {
  id: string
  ref: string
  transform: {
    position: ReadonlyArray<number>
    rotationDeg: ReadonlyArray<number>
    scale?: ReadonlyArray<number>
  }
  visible?: boolean
}

const round = (n: number): number => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0)

/**
 * 场景内容指纹：只取与布局有关的规范化序列化内容。
 *
 * 不能用 `sceneRevision`（adapter 的内存计数器，实例重建即归 1），
 * 也不能用 `meta.version`（只在落盘副本里递增，同一会话重复保存写出同一版本）。
 */
export function sceneContentFingerprint(assets: ReadonlyArray<FingerprintAsset>): string {
  const lines = [...assets]
    .map(a => ({
      id: a.id,
      ref: a.ref,
      p: a.transform.position.map(round),
      r: a.transform.rotationDeg.map(round),
      // core 的 scale 可选；缺省按 [1,1,1] 归一，避免"有没有写 scale"产生不同摘要
      s: (a.transform.scale ?? [1, 1, 1]).map(round),
      v: a.visible !== false,
    }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map(a => `${a.id}|${a.ref}|${a.p.join(',')}|${a.r.join(',')}|${a.s.join(',')}|${a.v ? 1 : 0}`)
  return `${PARTITION_FINGERPRINT_VERSION}:${fnv1a(lines.join(';'))}`
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 把当前分区导出成文件形态。
 *
 * 归属来源目前只有两种事实可依：分区边界内由程序分配的算 `auto`；
 * 运行期由 Agent 创建的对象带 `agent` 标记（P1 台账能给出）。人工覆盖属后续能力，
 * 这里保留 `manual` 取值但不会凭空产生。
 */
export function buildPartitionFile(input: {
  sceneId: string
  partition: PartitionSnapshot
  assets: ReadonlyArray<FingerprintAsset>
  /** 运行期由 agent 创建的对象 → 其归属区 */
  agentAssignments?: Record<string, string>
  savedAt?: string
}): PartitionFile {
  const byId = new Map(input.assets.map(a => [a.id, a]))
  const readonlySet = new Set(input.partition.globalReadonlyObjectIds)
  const agent = input.agentAssignments ?? {}
  const assignments: PartitionFileAssignment[] = []
  const readonlyAssignments: PartitionFile['readonlyAssignments'] = []
  const seen = new Set<string>()

  for (const region of input.partition.regions) {
    for (const id of region.objectIds) {
      const asset = byId.get(id)
      seen.add(id)
      if (readonlySet.has(id)) {
        readonlyAssignments.push({
          objectId: id,
          source: agent[id] ? 'agent' : 'auto',
          ...(asset ? { ref: asset.ref } : {}),
        })
        continue
      }
      assignments.push({
        objectId: id,
        regionId: region.id,
        source: agent[id] ? 'agent' : 'auto',
        ...(asset ? { ref: asset.ref } : {}),
      })
    }
  }

  // 跨区共享只读对象不一定落在任何区的 objectIds 里（如中线道路），必须单独补上，
  // 否则恢复后它会被当成"文件没记录的新对象"而丢掉只读语义。
  for (const id of input.partition.globalReadonlyObjectIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const asset = byId.get(id)
    readonlyAssignments.push({
      objectId: id,
      source: agent[id] ? 'agent' : 'auto',
      ...(asset ? { ref: asset.ref } : {}),
    })
  }

  return {
    schemaVersion: PARTITION_FILE_SCHEMA_VERSION,
    sceneId: input.sceneId,
    partitionVersion: input.partition.partitionVersion,
    savedAt: input.savedAt ?? new Date().toISOString(),
    sceneFingerprint: sceneContentFingerprint(input.assets),
    regions: input.partition.regions.map(r => ({
      id: r.id,
      name: r.name,
      polygonXZ: r.polygonXZ.map(([x, z]) => [x, z] as [number, number]),
    })),
    assignments,
    readonlyAssignments,
    unresolvedObjectIds: [],
  }
}

// ---------------------------------------------------------------------------
// 读取校验
// ---------------------------------------------------------------------------

const SOURCES: readonly string[] = ['auto', 'manual', 'agent']

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const finitePair = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))

/**
 * 解析并校验分区文件。**损坏/未知版本一律拒绝，不用默认值掩盖**——
 * 静默修复会让"文件坏了"看起来像"分区就是这个样子"。
 */
export function parsePartitionFile(raw: unknown): PartitionFileParse {
  const issues: string[] = []
  if (!isRecord(raw)) return { ok: false, issues: ['文件内容不是 JSON 对象'] }

  if (raw.schemaVersion !== PARTITION_FILE_SCHEMA_VERSION) {
    issues.push(`schemaVersion 必须是 ${PARTITION_FILE_SCHEMA_VERSION}（读到 ${String(raw.schemaVersion)}），未知版本不自动迁移`)
  }
  if (!nonEmpty(raw.sceneId)) issues.push('sceneId 必须是非空字符串')
  if (typeof raw.partitionVersion !== 'number' || !Number.isInteger(raw.partitionVersion) || raw.partitionVersion < 1) {
    issues.push('partitionVersion 必须是 ≥1 的整数')
  }
  if (typeof raw.savedAt !== 'string') issues.push('savedAt 必须是字符串')
  if (typeof raw.sceneFingerprint !== 'string') issues.push('sceneFingerprint 必须是字符串')

  const regionIds = new Set<string>()
  const regions: PartitionFileRegion[] = []
  if (!Array.isArray(raw.regions) || raw.regions.length === 0) {
    issues.push('regions 必须是非空数组')
  } else {
    raw.regions.forEach((r, i) => {
      if (!isRecord(r)) {
        issues.push(`regions[${i}] 必须是对象`)
        return
      }
      if (!nonEmpty(r.id)) issues.push(`regions[${i}].id 必须是非空字符串`)
      if (!nonEmpty(r.name)) issues.push(`regions[${i}].name 必须是非空字符串`)
      if (nonEmpty(r.id) && regionIds.has(r.id)) issues.push(`regions[${i}].id 重复：${r.id}`)
      const polygon = Array.isArray(r.polygonXZ) ? r.polygonXZ : null
      if (!polygon || !polygon.every(finitePair)) {
        issues.push(`regions[${i}].polygonXZ 必须是 [number, number][]`)
        return
      }
      const geo = validatePolygonXZ(polygon, `regions[${i}].polygonXZ`)
      if (!geo.ok) {
        for (const g of geo.issues) issues.push(`regions[${i}].polygonXZ ${g.message}`)
        return
      }
      if (nonEmpty(r.id) && nonEmpty(r.name)) {
        regionIds.add(r.id)
        regions.push({ id: r.id, name: r.name, polygonXZ: polygon as Array<[number, number]> })
      }
    })
  }

  const assignments: PartitionFileAssignment[] = []
  const parseAssignment = (a: unknown, path: string, needRegion: boolean): PartitionFileAssignment | null => {
    if (!isRecord(a)) {
      issues.push(`${path} 必须是对象`)
      return null
    }
    if (!nonEmpty(a.objectId)) {
      issues.push(`${path}.objectId 必须是非空字符串`)
      return null
    }
    if (!SOURCES.includes(String(a.source))) {
      issues.push(`${path}.source 必须是 auto/manual/agent`)
      return null
    }
    const regionId = needRegion ? a.regionId : '__readonly__'
    if (needRegion && !nonEmpty(a.regionId)) {
      issues.push(`${path}.regionId 必须是非空字符串`)
      return null
    }
    if (needRegion && nonEmpty(a.regionId) && !regionIds.has(a.regionId)) {
      issues.push(`${path}.regionId 指向不存在的区域：${String(a.regionId)}`)
      return null
    }
    if (a.ref !== undefined && typeof a.ref !== 'string') {
      issues.push(`${path}.ref 必须是字符串`)
      return null
    }
    return {
      objectId: a.objectId,
      regionId: String(regionId),
      source: a.source as AssignmentSource,
      ...(typeof a.ref === 'string' ? { ref: a.ref } : {}),
    }
  }

  if (!Array.isArray(raw.assignments)) {
    issues.push('assignments 必须是数组')
  } else {
    raw.assignments.forEach((a, i) => {
      const parsed = parseAssignment(a, `assignments[${i}]`, true)
      if (parsed) assignments.push(parsed)
    })
  }

  const readonlyAssignments: PartitionFile['readonlyAssignments'] = []
  if (raw.readonlyAssignments !== undefined) {
    if (!Array.isArray(raw.readonlyAssignments)) {
      issues.push('readonlyAssignments 必须是数组')
    } else {
      raw.readonlyAssignments.forEach((a, i) => {
        const parsed = parseAssignment(a, `readonlyAssignments[${i}]`, false)
        if (parsed) readonlyAssignments.push({ objectId: parsed.objectId, source: parsed.source, ...(parsed.ref ? { ref: parsed.ref } : {}) })
      })
    }
  }

  const unresolvedObjectIds: string[] = []
  if (raw.unresolvedObjectIds !== undefined) {
    if (!Array.isArray(raw.unresolvedObjectIds) || !raw.unresolvedObjectIds.every(nonEmpty)) {
      issues.push('unresolvedObjectIds 必须是字符串数组')
    } else {
      unresolvedObjectIds.push(...(raw.unresolvedObjectIds as string[]))
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    file: {
      schemaVersion: PARTITION_FILE_SCHEMA_VERSION,
      sceneId: raw.sceneId as string,
      partitionVersion: raw.partitionVersion as number,
      savedAt: raw.savedAt as string,
      sceneFingerprint: raw.sceneFingerprint as string,
      regions,
      assignments,
      readonlyAssignments,
      unresolvedObjectIds,
    },
  }
}

// ---------------------------------------------------------------------------
// 恢复核对
// ---------------------------------------------------------------------------

export type PartitionReconcileReport = {
  sceneId: string
  /** 文件与当前场景内容是否一致（不一致仍可恢复，但要提示核对） */
  fingerprintMatch: boolean
  /** 文件里存在但场景已删除 → 丢弃，不制造幽灵对象 */
  droppedObjectIds: string[]
  /** 同一 ID 但 ref 变了 → 身份存疑，不授写权限 */
  identityChangedObjectIds: string[]
  /** 归属有歧义/无法确定 → 可见不可写 */
  unresolvedObjectIds: string[]
  /** 场景里存在但文件没记录的（新对象），不自动归属 */
  unassignedObjectIds: string[]
}

export type PartitionRestoreResult = {
  partition: PartitionSnapshot
  report: PartitionReconcileReport
}

/**
 * 用当前场景核对分区文件，产出可用的 PartitionSnapshot。
 *
 * 核对规则（与 07 §5 一致）：
 * - 对象已删除 → 从快照排除并记录；
 * - 对象仍存在且 ref 一致 → 保留原归属与来源；
 * - ID 相同但 ref 变了 → 进 unresolved（不盲用旧归属）；
 * - 文件里 unresolved 的仍在场景 → 继续 unresolved；
 * - 场景里新增但文件没记录 → 进 unassigned，不自动归属（**避免猜测**）。
 */
export function reconcilePartitionFile(file: PartitionFile, assets: ReadonlyArray<FingerprintAsset>): PartitionRestoreResult {
  const byId = new Map(assets.map(a => [a.id, a]))
  const live = new Set(byId.keys())
  const dropped: string[] = []
  const identityChanged: string[] = []
  const unresolved = new Set<string>(file.unresolvedObjectIds.filter(id => live.has(id)))
  const assigned = new Set<string>()

  const regionObjectIds = new Map<string, string[]>(file.regions.map(r => [r.id, []]))
  for (const a of file.assignments) {
    if (!live.has(a.objectId)) {
      dropped.push(a.objectId)
      continue
    }
    const asset = byId.get(a.objectId)
    if (a.ref !== undefined && asset && asset.ref !== a.ref) {
      identityChanged.push(a.objectId)
      unresolved.add(a.objectId)
      continue
    }
    regionObjectIds.get(a.regionId)?.push(a.objectId)
    assigned.add(a.objectId)
  }

  const readonlyIds: string[] = []
  for (const a of file.readonlyAssignments) {
    if (!live.has(a.objectId)) {
      dropped.push(a.objectId)
      continue
    }
    const asset = byId.get(a.objectId)
    if (a.ref !== undefined && asset && asset.ref !== a.ref) {
      identityChanged.push(a.objectId)
      unresolved.add(a.objectId)
      continue
    }
    readonlyIds.push(a.objectId)
    assigned.add(a.objectId)
  }

  const unresolvedIds = [...unresolved]
  const unassigned = [...live].filter(id => !assigned.has(id) && !unresolved.has(id))

  const regions: Region[] = file.regions.map(r => ({
    schemaVersion: 1 as const,
    id: r.id,
    name: r.name,
    polygonXZ: r.polygonXZ.map(([x, z]) => [x, z] as [number, number]),
    objectIds: regionObjectIds.get(r.id) ?? [],
    cameraId: DEFAULT_REGION_CAMERA,
    partitionVersion: file.partitionVersion,
  }))

  return {
    partition: {
      partitionVersion: file.partitionVersion,
      regions,
      globalReadonlyObjectIds: [...new Set([...readonlyIds, ...unresolvedIds])],
    },
    report: {
      sceneId: file.sceneId,
      fingerprintMatch: sceneContentFingerprint(assets) === file.sceneFingerprint,
      droppedObjectIds: [...new Set(dropped)],
      identityChangedObjectIds: [...new Set(identityChanged)],
      unresolvedObjectIds: unresolvedIds,
      unassignedObjectIds: unassigned,
    },
  }
}

// ---------------------------------------------------------------------------
// 保存链决策（与场景保存用同一份内容快照）
// ---------------------------------------------------------------------------

export type PartitionSource = 'generated' | 'restored' | 'manual' | 'injected'

export type PartitionSavePlan =
  | { action: 'skip'; reason: string }
  | { action: 'write'; file: PartitionFile }

/**
 * 决定"这一轮提交后要不要写分区文件，写什么"。
 *
 * 关键点：分区文件必须用**保存场景时那份快照**构造，否则 `sceneFingerprint`
 * 描述的是另一个时刻的场景，下次恢复会对不上（文档 07 §6 的要求）。
 * 抽成纯函数是为了把每种跳过理由都测到，而不是埋在 async 流程里。
 */
export function planPartitionSave(input: {
  /** 是否开启了自动持久化 */
  enabled: boolean
  partition: PartitionSnapshot | null
  source: PartitionSource | null
  /** 与场景保存同源的快照 */
  snapshot: { sceneId: string | null; assets: ReadonlyArray<FingerprintAsset> }
  /** 场景保存结果；null = 保存失败或未保存 */
  saved: { mode: string } | null
  saveError?: string
  savedAt?: string
}): PartitionSavePlan {
  if (!input.enabled) return { action: 'skip', reason: '未开启分区持久化' }
  if (!input.partition) return { action: 'skip', reason: '当前没有分区' }
  if (input.source === 'injected') {
    // 脚本/测试注入的分区不属于这个场景，绝不能落盘（实测会污染真实场景目录）
    return { action: 'skip', reason: '调试注入的分区不写入磁盘' }
  }
  if (!input.saved) {
    return {
      action: 'skip',
      reason: `场景未保存（${input.saveError ?? '未知原因'}），分区不写入——否则指纹会描述一个没落盘的场景`,
    }
  }
  if (!input.snapshot.sceneId) return { action: 'skip', reason: '快照缺少 sceneId' }

  return {
    action: 'write',
    file: buildPartitionFile({
      sceneId: input.snapshot.sceneId,
      partition: input.partition,
      assets: input.snapshot.assets,
      ...(input.savedAt !== undefined ? { savedAt: input.savedAt } : {}),
    }),
  }
}

/** 没有发生过核对时的空报告（只用于展示，不代表"核对过且一致"的权威结论） */
export function emptyReconcileReport(sceneId: string): PartitionReconcileReport {
  return {
    sceneId,
    fingerprintMatch: true,
    droppedObjectIds: [],
    identityChangedObjectIds: [],
    unresolvedObjectIds: [],
    unassignedObjectIds: [],
  }
}

/** 恢复/保存的 UI 状态（读写失败与"本来就没有文件"必须区分） */export type PartitionPersistenceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'absent' }
  | { status: 'ready'; report: PartitionReconcileReport }
  | { status: 'needs_review'; report: PartitionReconcileReport; issues: string[] }
  /** 文件损坏/未知版本/场景不匹配：不启用、不覆盖，保留原文件 */
  | { status: 'invalid'; issues: string[] }
  | { status: 'load_failed'; message: string }
  | { status: 'save_failed'; message: string }
