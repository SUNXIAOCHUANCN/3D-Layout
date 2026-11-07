import { describeModel } from './modelCatalog'
import { useSceneStore } from './store'
import type { ModelMeta } from './types'

// Small bilingual expansions help Chinese instructions find English catalogue labels.
const synonyms = [
  ['豪华', '奢华', 'luxury', 'luxurious', 'chandelier', 'marble', 'velvet', '水晶', '大理石'],
  ['沙发', 'sofa', 'couch'], ['椅子', 'chair', 'armchair'], ['桌子', 'table', 'desk'],
  ['灯具', '灯', 'lamp', 'light', 'chandelier'], ['地毯', 'rug', 'carpet'],
  ['树', 'tree', '植物', 'plant'], ['床', 'bed'], ['柜', 'cabinet', 'wardrobe'],
]

export function searchModels(models: Record<string, ModelMeta>, args: Record<string, unknown>) {
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200) throw new Error('query 须为 1–200 字的关键词')
  const limit = args.limit ?? 12, offset = args.offset ?? 0
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw new Error('limit 须为 1–20 的整数')
  if (!Number.isInteger(offset) || Number(offset) < 0) throw new Error('offset 须为非负整数')
  if (args.category !== undefined && typeof args.category !== 'string') throw new Error('category 须为字符串')
  const query = args.query.trim().toLowerCase()
  const terms = query.split(/[\s,，、;；]+/u).filter(Boolean)
  const expanded = new Set(terms)
  for (const group of synonyms) if (group.some(word => query.includes(word))) for (const word of group) expanded.add(word)
  const category = String(args.category ?? '').trim().toLowerCase()
  const matches = Object.entries(models).map(([ref, meta]) => {
    if (category && ![meta.category, ...(meta.categoryPath ?? [])].some(c => c?.toLowerCase().includes(category))) return { ref, meta, score: 0 }
    const name = `${meta.name} ${ref}`.toLowerCase()
    const text = JSON.stringify([meta.description, meta.tags, meta.retrievalTerms, meta.category, meta.categoryPath, meta.style]).toLowerCase()
    let score = 0
    for (const term of expanded) score += name.includes(term) ? (terms.includes(term) ? 8 : 3) : text.includes(term) ? (terms.includes(term) ? 4 : 1) : 0
    return { ref, meta, score }
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
  return {
    query: args.query, total: matches.length, offset, limit,
    nextOffset: Number(offset) + Number(limit) < matches.length ? Number(offset) + Number(limit) : null,
    models: matches.slice(Number(offset), Number(offset) + Number(limit)).map(({ ref, meta }) => {
      const result = describeModel(ref, meta)
      return { ...result, description: result.description?.slice(0, 500), tags: result.tags?.slice(0, 20), retrievalTerms: result.retrievalTerms?.slice(0, 20) }
    }),
    note: matches.length ? '使用返回的 ref 新增模型；需要更多候选时分页或调整关键词。' : '没有匹配模型，请换用具体物体名称或英文关键词，不要编造 ref。',
  }
}

export const modelSearchTool = {
  name: 'model.search' as const, access: 'read' as const,
  summary: '按关键词检索模型库（分页，最多 20 项）',
  description: '按物体名称、标签、描述和类别检索模型库。需要新家具或装饰时先检索，如“豪华 吊灯”“sofa”。这是关键词匹配，找不到时换关键词。只返回少量候选，不读取全量目录。',
  argsDoc: '{ query: string, category?: string, limit?: number, offset?: number }',
  schema: { type: 'object', properties: {
    query: { type: 'string', minLength: 1, maxLength: 200 }, category: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 20, default: 12 }, offset: { type: 'integer', minimum: 0, default: 0 },
  }, required: ['query'], additionalProperties: false },
  exec: (args: Record<string, unknown>) => searchModels(useSceneStore.getState().manifest?.models ?? {}, args),
}
