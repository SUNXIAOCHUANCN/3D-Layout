/**
 * 场景只读工具（W05）：region 摘要 / 对象详情 / 模型库检索。
 *
 * 全部走 EditorReadPort 快照（带 plugin sceneRevision），不读 UI 状态、不写场景。
 * 返回结构保持小：模型看到的是"可判定的事实"，不是整份 SceneDocument。
 */

import type { AssetDTO, ModelCatalogEntry, ObjectId, PartitionSnapshot, Region, WorkflowContext } from '../contracts'
import { CoAgentError } from '../contracts'

export type RegionSummary = {
  regionId: string
  name: string
  objectCount: number
  objectIds: ObjectId[]
  /** 跨区共享只读对象（global_readonly）：可看不可改 */
  readonlyObjectIds: ObjectId[]
}

export function regionSummary(context: WorkflowContext, region: Region): RegionSummary {
  const readonly = new Set(context.partition.globalReadonlyObjectIds)
  return {
    regionId: region.id,
    name: region.name,
    objectCount: region.objectIds.length,
    objectIds: [...region.objectIds],
    readonlyObjectIds: region.objectIds.filter(id => readonly.has(id)),
  }
}

export function listRegion(context: WorkflowContext, partition: PartitionSnapshot, regionId?: string): RegionSummary[] {
  const regions = regionId ? partition.regions.filter(r => r.id === regionId) : partition.regions
  if (regionId && regions.length === 0) {
    throw new CoAgentError('invalid_arguments', `分区里没有 region ${regionId}`)
  }
  return regions.map(r => regionSummary(context, r))
}

export function getObjects(context: WorkflowContext, objectIds: ObjectId[]): { objects: AssetDTO[]; sceneRevision: number } {
  const snap = context.editorRead.snapshot({ objectIds })
  const found = new Map(snap.assets.map(a => [a.id, a]))
  const missing = objectIds.filter(id => !found.has(id))
  if (missing.length > 0) {
    throw new CoAgentError('asset_not_found', `对象不存在：${missing.slice(0, 5).join(', ')}`, { details: { missing } })
  }
  return { objects: objectIds.map(id => found.get(id) as AssetDTO), sceneRevision: snap.sceneRevision }
}

/**
 * 模型库检索。
 *
 * 查询串按空白拆成多个词，**任一命中**即算匹配（而不是整串子串匹配）。
 * 真机实测（2026-10-22）：模型自然地会发 "box crate 料箱" 这种多关键词查询，
 * 整串匹配必然返回空 → 模型再换 3~4 个关键词反复试 → 轮次预算耗尽。
 */
export function searchLibrary(context: WorkflowContext, query: string, limit: number): { entries: ModelCatalogEntry[] } {
  const snap = context.editorRead.snapshot({ objectIds: [], includeCatalog: true })
  const all = snap.catalog ?? []
  const terms = query.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0)
  const matches = (e: ModelCatalogEntry): boolean => {
    if (terms.length === 0) return true
    const hay = `${e.ref} ${e.name} ${e.category ?? ''} ${e.description ?? ''} ${(e.tags ?? []).join(' ')} ${(e.retrievalTerms ?? []).join(' ')} ${Object.values(e.style ?? {}).join(' ')}`.toLowerCase()
    return terms.some(t => hay.includes(t))
  }
  return { entries: all.filter(matches).slice(0, limit) }
}
