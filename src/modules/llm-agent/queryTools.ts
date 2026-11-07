import { useSceneStore } from '../../core/store'
import { describeModel } from '../../core/modelCatalog'
import type { AgentToolDef } from './tools'

export const QUERY_TOOLS: AgentToolDef[] = [
  {
    name: 'catalog.search', access: 'read', summary: '按需检索模型目录',
    description: '按名称、分类和标签检索模型，分页返回尺寸、朝向和风格。空 query 可浏览目录。添加对象的 ref 必须来自此目录。',
    argsDoc: '{ query?, offset?, limit? }',
    schema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false },
    exec(args) {
      const query = args.query ?? ''
      const offset = args.offset ?? 0, limit = args.limit ?? 12
      if (typeof query !== 'string' || query.length > 200 ||
          typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 ||
          typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('检索参数无效')
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const entries = Object.entries(useSceneStore.getState().manifest?.models ?? {}).filter(([ref, m]) => {
        const text = [ref, m.name, m.category, m.description, ...(m.tags ?? []), ...(m.retrievalTerms ?? [])].join(' ').toLowerCase()
        return terms.every(term => text.includes(term))
      })
      return { total: entries.length, offset, nextOffset: offset + limit < entries.length ? offset + limit : null,
        models: entries.slice(offset, offset + limit).map(([ref, m]) => describeModel(ref, m)) }
    },
  },
  {
    name: 'scene.density', access: 'read', summary: '检查区域对象密度',
    description: '统计世界 XZ 矩形内可见对象的中心点数量，排除地形。每百平方米数量仅用于布局规划，不代表视觉质量。可选 refs 只统计某类资产。',
    argsDoc: '{ min: [x,z], max: [x,z], refs?, targetPer100m2? }',
    schema: { type: 'object', required: ['min', 'max'], properties: {
      min: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      max: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      refs: { type: 'array', maxItems: 50, items: { type: 'string' } },
      targetPer100m2: { type: 'number', minimum: 0, maximum: 100 },
    }, additionalProperties: false },
    exec(args) {
      const valid = (v: unknown): v is number[] => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))
      if (!valid(args.min) || !valid(args.max)) throw new Error('需要世界坐标 [x,z]')
      const min = args.min, max = args.max
      const area = (max[0] - min[0]) * (max[1] - min[1])
      if (max.some((n, i) => n <= min[i]) || !Number.isFinite(area)) throw new Error('区域尺寸无效')
      if (args.refs !== undefined && (!Array.isArray(args.refs) || args.refs.length > 50 || args.refs.some(ref => typeof ref !== 'string'))) throw new Error('refs 无效')
      const assets = (useSceneStore.getState().document?.assets ?? []).filter(a => !a.terrain && a.visible !== false &&
        a.transform.position[0] >= min[0] && a.transform.position[0] <= max[0] &&
        a.transform.position[2] >= min[1] && a.transform.position[2] <= max[1] &&
        (args.refs === undefined || (args.refs as string[]).includes(a.ref)))
      let targetCount: number | undefined
      if (args.targetPer100m2 !== undefined) {
        const density = args.targetPer100m2
        if (typeof density !== 'number' || !Number.isFinite(density) || density < 0 || density > 100) throw new Error('目标密度无效')
        targetCount = Math.ceil(area * density / 100)
      }
      return { areaM2: area, count: assets.length, per100m2: assets.length * 100 / area,
        targetCount, missing: targetCount === undefined ? undefined : Math.max(0, targetCount - assets.length) }
    },
  },
]
