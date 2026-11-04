import { assetBox } from './aiReview'
import { useSceneStore } from './store'
import type { ModelManifest, SceneDocument } from './types'

/** Broad-phase only: AABBs can overlap while the actual meshes remain separate. */
export function checkSceneOverlaps(document: SceneDocument, manifest: ModelManifest | null, args: Record<string, unknown>) {
  const limit = args.limit ?? 30, offset = args.offset ?? 0, tolerance = args.tolerance ?? 0.01
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error('limit 须为 1–100 的整数')
  if (!Number.isInteger(offset) || Number(offset) < 0) throw new Error('offset 须为非负整数')
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) throw new Error('tolerance 须为非负米数')
  const ids = (key: string) => {
    const value = args[key]
    if (value === undefined) return null
    if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) throw new Error(`${key} 须为物体 ID 数组`)
    const known = new Set(document.assets.map(asset => asset.id))
    for (const id of value) if (!known.has(id)) throw new Error(`物体 ${id} 不存在`)
    return new Set<string>(value)
  }
  const targets = ids('assetIds'), ignored = ids('ignoreAssetIds')
  const skipped: string[] = []
  const entries = document.assets.filter(asset => asset.visible !== false && !ignored?.has(asset.id)).flatMap(asset => {
    if (!asset.terrain && !manifest?.models[asset.ref]) { skipped.push(asset.id);return [] }
    return [{ asset, box: assetBox(asset, manifest) }]
  }).sort((a, b) => a.box.min.x - b.box.min.x || a.asset.id.localeCompare(b.asset.id))
  const describe = (entry: typeof entries[number]) => ({
    id: entry.asset.id, name: entry.asset.name ?? manifest?.models[entry.asset.ref]?.name ?? entry.asset.id,
    position: entry.asset.transform.position, worldAabb: { min: entry.box.min.toArray(), max: entry.box.max.toArray() },
  })
  const overlaps = []
  let matches = 0, checkedPairs = 0, hasMore = false
  outer: for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j]
    if (b.box.min.x >= a.box.max.x - tolerance) break
    if (targets && !targets.has(a.asset.id) && !targets.has(b.asset.id)) continue
    checkedPairs++
    const intersection = a.box.clone().intersect(b.box)
    const min = intersection.min.toArray(), max = intersection.max.toArray()
    const size = max.map((n, axis) => n - min[axis])
    if (intersection.isEmpty() || size.some(n => n <= tolerance)) continue
    if (matches++ < Number(offset)) continue
    if (overlaps.length === limit) { hasMore = true;break outer }
    overlaps.push({ a: describe(a), b: describe(b), overlap: { min, max, size, volume: size[0] * size[1] * size[2] } })
  }
  return {
    method: 'world-aabb', exactCollision: false, tolerance, checkedPairs, skippedAssets: skipped,
    overlaps, hasMore, nextOffset: hasMore ? Number(offset) + Number(limit) : null,
    note: '仅为疑似包围盒重叠，不是网格穿模判定。旋转物体、空心结构、墙体和地板可能产生误报；没有结果也不能证明无穿模。隐藏物体未参与，缺少模型元数据的物体列在 skippedAssets。',
  }
}

export const sceneOverlapTool = {
  name: 'scene.check_overlaps' as const, access: 'read' as const,
  summary: '检查世界包围盒疑似重叠（非精确穿模判定）',
  description: '检查当前草稿的疑似物体重叠，返回两物体 ID、名称、位置、世界包围盒及重叠范围。修改后优先指定 assetIds 检查修改物体与其余物体；可忽略地板等结构。只做粗筛，不可宣称“无穿模”。结果分页，必要时继续查询。',
  argsDoc: '{ assetIds?: string[], ignoreAssetIds?: string[], tolerance?: number, limit?: number, offset?: number }',
  schema: { type: 'object', properties: {
    assetIds: { type: 'array', items: { type: 'string' } }, ignoreAssetIds: { type: 'array', items: { type: 'string' } },
    tolerance: { type: 'number', minimum: 0, default: 0.01 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, offset: { type: 'integer', minimum: 0, default: 0 },
  }, additionalProperties: false },
  exec(args: Record<string, unknown>) {
    const state = useSceneStore.getState()
    if (!state.document) throw new Error('场景未加载')
    return checkSceneOverlaps(state.document, state.manifest, args)
  },
}
