/**
 * plannerContext（W07）单测：精简上下文确实"精简且相关"，并显式给模型边界。
 */

import { describe, expect, it } from 'vitest'
import type { AssetDTO, ModelCatalogEntry } from '../../contracts'
import { buildPlannerContext, keywordsOf } from '../../agents/plannerContext'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const asset = (id: string, ref: string, name: string, x: number, z: number, category: string | null = null): AssetDTO => ({
  id,
  ref,
  name,
  transform: { position: [x, 0, z], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
  visible: true,
  catalog: { ref, name, dimensions: { w: 2, h: 2, d: 2 }, category },
  fingerprint: `fp-${id}`,
})

const assets: AssetDTO[] = [
  asset('tree-1', 'models/oak-tree', '北树一', -3, -4, 'vegetation'),
  asset('tree-2', 'models/oak-tree', '北树二', 2, -5, 'vegetation'),
  asset('house-1', 'models/cottage', '村舍一', -2, 4, 'building'),
  asset('rock-1', 'models/rock', '南岩一', 4, 3, 'props'),
  asset('road-1', 'models/road-stretch', '中枢道路', 0, 0, 'infra'),
]

const catalog: ModelCatalogEntry[] = [
  { ref: 'models/oak-tree', name: '橡树', dimensions: { w: 3, h: 5, d: 3 }, category: 'vegetation' },
  { ref: 'models/cottage', name: '村舍', dimensions: { w: 6, h: 4, d: 5 }, category: 'building' },
  { ref: 'models/rock', name: '岩石', dimensions: { w: 1.5, h: 1, d: 1.5 }, category: 'props' },
]

describe('keywordsOf', () => {
  it('中文请求会拆出 2-gram，英文/数字保留整词', () => {
    const k = keywordsOf('把北边林地拉稀疏一点，加 2 块 rock')
    expect(k).toContain('林地')
    expect(k).toContain('稀疏')
    expect(k).toContain('rock')
  })

  it('短词与空串不会污染关键词', () => {
    expect(keywordsOf('   ')).toEqual([])
    const k = keywordsOf('a 的')
    expect(k.every(x => x.length >= 2)).toBe(true)
  })
})

describe('buildPlannerContext', () => {
  it('关键词命中的对象优先进入候选，且文本带指标白名单与限制', () => {
    const bundle = buildPlannerContext({
      request: '把 tree 拉稀疏一点',
      partition: makeTwoRegionPartition(),
      assets,
      catalog,
    })
    expect(bundle.matchedIds).toEqual(expect.arrayContaining(['tree-1', 'tree-2']))
    expect(bundle.candidateIds).toEqual(expect.arrayContaining(['tree-1', 'tree-2']))
    expect(bundle.text).toContain('region.object_count')
    expect(bundle.text).toContain('min_pair_distance_xz')
    expect(bundle.text).toContain('不要编造')
  })

  it('候选与模型库都有上限（不会把整场景塞进上下文）', () => {
    const many = Array.from({ length: 200 }, (_, i) => asset(`obj-${i}`, 'models/oak-tree', `树${i}`, i, i, 'vegetation'))
    const bundle = buildPlannerContext({ request: '树太多', partition: makeTwoRegionPartition(), assets: many, catalog })
    expect(bundle.candidateIds.length).toBeLessThanOrEqual(24)
    expect(bundle.truncated.assets).toBe(true)
    expect(bundle.text.length).toBeLessThan(20_000)
  })

  it('有视口时把视口目标附近的近邻纳入候选', () => {
    const viewport = {
      schemaVersion: 1 as const,
      id: 'main',
      projection: 'perspective' as const,
      position: [0, 10, 20] as [number, number, number],
      target: [-2, 0, 4] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
      near: 0.1,
      far: 100,
      aspect: 4 / 3,
      fovDeg: 50,
    }
    const bundle = buildPlannerContext({ request: '整理一下', partition: makeTwoRegionPartition(), assets, catalog, viewport })
    expect(bundle.candidateIds).toContain('house-1') // 距 target(-2,4) 最近
    expect(bundle.text).toContain('用户视口相机')
  })

  it('没有视口时明确写"不可用"，不假装有视口', () => {
    const bundle = buildPlannerContext({ request: '整理一下', partition: makeTwoRegionPartition(), assets, catalog })
    expect(bundle.text).toContain('不可用')
  })
})
