/**
 * plannerContext（W07）——把"整个场景"压成**精简上下文**给规划器（SPEC §W07 操作 1）。
 *
 * 原则：
 * - 用户请求里的关键词先匹配（对象名/ref/类别/区域名），命中优先；
 * - 每个区再给少量样本（避免"只给匹配项"导致看不见别处）；
 * - 视口附近给最近的若干对象（"按需观察用户视口"的第一版：相机 + 近邻对象）；
 * - 模型库只给相关类别或前 N 个；
 * - 所有上限都显式写进文本（模型知道边界，就少编造）。
 *
 * 纯函数，方便单测；不依赖 React/DOM/three。
 */

import type { AssetDTO, CameraSnapshot, ModelCatalogEntry, PartitionSnapshot } from '../contracts'
import { SUPPORTED_METRICS } from '../schemas'
import { DEFAULT_PLAN_LIMITS, type PlanLimits } from '../services/planValidation'

export interface PlannerContextLimits {
  maxCandidates: number
  maxCatalog: number
  perRegionSamples: number
  viewportNearest: number
}

export const DEFAULT_CONTEXT_LIMITS: PlannerContextLimits = {
  maxCandidates: 24,
  maxCatalog: 12,
  perRegionSamples: 3,
  viewportNearest: 8,
}

export interface PlannerContextBundle {
  text: string
  candidateIds: string[]
  matchedIds: string[]
  truncated: { assets: boolean; catalog: boolean }
}

export interface PlannerContextInput {
  request: string
  partition: PartitionSnapshot
  assets: AssetDTO[]
  catalog: ModelCatalogEntry[]
  /** 用户当前主视口相机（拿不到就不给，规划器会退回"全场景摘要"） */
  viewport?: CameraSnapshot | null
  contextLimits?: Partial<PlannerContextLimits>
  planLimits?: PlanLimits
}

/** 中文没有空格：除整词外再拆 2-gram，避免"林地/村舍"这类词匹配不到 */
export function keywordsOf(request: string): string[] {
  const raw = request.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2)
  const out = new Set<string>()
  for (const token of raw) {
    out.add(token)
    if (/[\u4e00-\u9fa5]/.test(token)) {
      for (let i = 0; i + 2 <= token.length; i++) out.add(token.slice(i, i + 2))
    }
  }
  return [...out].slice(0, 24)
}

function scoreAsset(a: AssetDTO, keywords: string[]): number {
  const hay = `${a.name ?? ''} ${a.ref} ${a.catalog?.name ?? ''} ${a.catalog?.category ?? ''} ${a.id}`.toLowerCase()
  let score = 0
  for (const k of keywords) if (hay.includes(k)) score += k.length >= 3 ? 2 : 1
  return score
}

function distanceTo(point: [number, number], a: AssetDTO): number {
  return Math.hypot(a.transform.position[0] - point[0], a.transform.position[2] - point[1])
}

function brief(a: AssetDTO): Record<string, unknown> {
  return {
    id: a.id,
    ref: a.ref,
    name: a.name,
    category: a.catalog?.category ?? null,
    size: a.catalog ? [a.catalog.dimensions.w, a.catalog.dimensions.h, a.catalog.dimensions.d] : null,
    position: [Number(a.transform.position[0].toFixed(2)), Number(a.transform.position[1].toFixed(2)), Number(a.transform.position[2].toFixed(2))],
    scale: a.transform.scale.map(v => Number(v.toFixed(2))),
  }
}

export function buildPlannerContext(input: PlannerContextInput): PlannerContextBundle {
  const limits = { ...DEFAULT_CONTEXT_LIMITS, ...input.contextLimits }
  const planLimits = input.planLimits ?? DEFAULT_PLAN_LIMITS
  const keywords = keywordsOf(input.request)

  // 1) 关键词命中
  const scored = input.assets
    .map(a => ({ a, score: scoreAsset(a, keywords) }))
    .filter(x => x.score > 0)
    .sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id))
  const matched = scored.slice(0, 12).map(x => x.a)

  // 2) 每区样本
  const perRegion: AssetDTO[] = []
  for (const region of input.partition.regions) {
    const inside = input.assets.filter(a => region.objectIds.includes(a.id)).slice(0, limits.perRegionSamples)
    perRegion.push(...inside)
  }

  // 3) 视口近邻（没有视口就用场景中心）
  let focus: [number, number] = [0, 0]
  if (input.viewport) focus = [input.viewport.target[0], input.viewport.target[2]]
  const nearest = [...input.assets].sort((a, b) => distanceTo(focus, a) - distanceTo(focus, b)).slice(0, limits.viewportNearest)

  const chosen: AssetDTO[] = []
  const seen = new Set<string>()
  for (const a of [...matched, ...perRegion, ...nearest]) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    chosen.push(a)
    if (chosen.length >= limits.maxCandidates) break
  }

  // 4) 模型库：有命中就给命中，否则给前 N
  const matchedCatalog = input.catalog.filter(c => {
    const hay = `${c.ref} ${c.name} ${c.category ?? ''}`.toLowerCase()
    return keywords.some(k => hay.includes(k))
  })
  const catalogChosen = (matchedCatalog.length > 0 ? matchedCatalog : input.catalog).slice(0, limits.maxCatalog)

  const regionSummaries = input.partition.regions.map(r => ({
    regionId: r.id,
    name: r.name,
    objectCount: r.objectIds.length,
    sampleObjectIds: r.objectIds.slice(0, 6),
    readonlyObjectIds: r.objectIds.filter(id => input.partition.globalReadonlyObjectIds.includes(id)),
  }))

  const metrics = SUPPORTED_METRICS.map(m => ({
    metric: m,
    meaning:
      m === 'region.object_count'
        ? '该区域对象总数（整数）。只有声明 add/remove 时才允许改变；否则必须等于当前数量'
        : '该区域任意两对象在 XZ 平面上的最小距离（米，>0，不得超过场景尺度）',
  }))

  const text = [
    `用户请求：${input.request}`,
    '',
    '本轮可用信息（不要臆造列表之外的对象 id）：',
    `- 分区：${JSON.stringify(regionSummaries)}`,
    `- 候选对象（每项含 id/ref/类别/尺寸/位置/缩放）：${JSON.stringify(chosen.map(brief))}`,
    input.viewport
      ? `- 用户视口相机：${JSON.stringify({ position: input.viewport.position, target: input.viewport.target, projection: input.viewport.projection })}`
      : '- 用户视口相机：不可用（按场景摘要规划）',
    `- 模型库（可新增的资产，最多 ${limits.maxCatalog} 项）：${JSON.stringify(catalogChosen.map(c => ({ ref: c.ref, name: c.name, category: c.category, dimensions: c.dimensions })))}`,
    '',
    '指标白名单（criteria 只能用这些）：',
    JSON.stringify(metrics),
    '',
    '硬性限制：',
    `- 最多 ${planLimits.maxTasks} 个任务；每条任务最多 ${planLimits.maxTargetsPerTask} 个目标；objective ≤ ${planLimits.maxObjectiveChars} 字；`,
    '- 只能操作分区内的对象；global_readonly 不可修改；跨区依赖非法；',
    '- 请求里的"那个/它"等指代不清时，返回 clarify 并给 2~4 个选项；',
    '- 跨区搬移对象（例如"把这个房子移到另一片区域"）返回 unsupported 并说明原因；',
    '- 不要编造对象 id、不要给超出场景尺度的阈值。',
    '',
    '你可以先调用只读工具（scene.* / camera.* / library.search）核对事实，再输出最终 JSON 计划。',
    '最终回复只包含 JSON：{"schemaVersion":1,"kind":"tasks"|"clarify"|"unsupported",...}。',
  ].join('\n')

  return {
    text,
    candidateIds: chosen.map(a => a.id),
    matchedIds: matched.map(a => a.id),
    truncated: {
      assets: chosen.length < input.assets.length,
      catalog: catalogChosen.length < input.catalog.length,
    },
  }
}
