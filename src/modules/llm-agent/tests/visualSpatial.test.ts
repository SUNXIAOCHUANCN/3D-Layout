import { beforeEach, expect, it, vi } from 'vitest'
import { bus } from '../../../core/events'
import { engine } from '../../../core/engine'
import { edit } from '../../../core/edit'
import { useSceneStore } from '../../../core/store'
import { runAgentTool } from '../tools'
import type { ModelMeta } from '../../../core/types'

beforeEach(() => {
  vi.restoreAllMocks()
  useSceneStore.setState({
    sceneId: 'spatial',
    manifest: { generatedAt: '', models: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['models/tree-' + i, {
      id: String(i), name: 'tree ' + i, category: 'forest', dimensions: { w: 1, h: 2, d: 1 },
      source: { type: 'primitive', shape: 'box' },
    } satisfies ModelMeta])) },
    document: { meta: { id: 'spatial', name: 'spatial', version: 1, unit: 'm', up: '+Y' },
      environment: {}, cameras: [], assets: Array.from({ length: 100 }, (_, i) => ({
        id: 'a' + i, ref: 'models/tree-0', transform: { position: [i, 0, 0], rotation: [0, 0, 0] },
      })) },
  })
  bus.emit('scene:changed', { sceneId: 'spatial' })
})

it('returns bounded scene and model pages with resolvable IDs', async () => {
  const result = await runAgentTool('scene.get_state', {}, { tx: null })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const data = result.data as { assets: { id: string }[]; manifest: unknown; pagination: { nextOffset: number }; assetCount: number }
  expect(data.assets).toHaveLength(24)
  expect(data.manifest).toBeNull()
  expect(data.pagination.nextOffset).toBe(24)
  expect(data.assetCount).toBe(100)
  expect(JSON.stringify(data).length).toBeLessThan(16_000)
  const catalog = await runAgentTool('catalog.search', { query: 'tree', offset: 12, limit: 12 }, { tx: null })
  expect(catalog.ok && (catalog.data as { models: unknown[] }).models).toHaveLength(12)
  const selected = await runAgentTool('scene.get_state', { assetIds: ['a99'] }, { tx: null })
  expect(selected.ok && (selected.data as { assets: { id: string }[] }).assets[0].id).toBe('a99')
})

it('accepts a top-down default up vector and permits picking an older cached camera', async () => {
  const capture = vi.spyOn(engine, 'captureFromCamera').mockReturnValue('data:image/png;base64,abc')
  vi.spyOn(engine, 'pickFromCamera').mockReturnValue(null)
  const first = await runAgentTool('viewport.screenshot', { camera: {
    projection: 'orthographic', position: [0, 900, 0], target: [0, 0, 0], viewHeight: 700, far: 2000,
  } }, { tx: null })
  expect(first.ok).toBe(true)
  expect(capture.mock.calls[0][0].up).toEqual([0, 0, -1])
  await runAgentTool('viewport.screenshot', { camera: {
    projection: 'perspective', position: [20, 20, 20], target: [0, 0, 0],
  } }, { tx: null })
  if (!first.ok) return
  const args = { screenshotId: (first.data as { screenshotId: string }).screenshotId, imageWidth: 1024, imageHeight: 768, x: 0, y: 0 }
  expect((await runAgentTool('viewport.pick', args, { tx: null })).ok).toBe(true)
  const tx = edit.begin('changed', 'agent')
  edit.setTransform('a0', { position: [1, 2, 3], rotation: [0, 0, 0] }, { tx, source: 'agent' })
  expect((await runAgentTool('viewport.pick', args, { tx: null })).ok).toBe(false)
  tx.rollback()
})

it('sculpts a translated, rotated, scaled terrain in world coordinates and flags zero changes', async () => {
  const tx = edit.begin('terrain', 'agent')
  edit.addAsset({ id: 'land', ref: 'generated/terrain',
    transform: { position: [100, 10, 200], rotation: [0, 90, 0], scale: [2, 2, 2] },
    terrain: { width: 10, depth: 10, samplesX: 3, samplesZ: 3, heights: Array(9).fill(0), seed: 1 },
  }, { tx, source: 'agent' })
  const result = await runAgentTool('terrain.sculpt', {
    assetId: 'land', mode: 'flatten', space: 'world', center: [100, 200], radius: 2, plateau: 1, value: 14,
  }, { tx })
  expect(result.ok && result.data).toMatchObject({ changedSamples: 1, effective: true })
  expect(useSceneStore.getState().document!.assets.find(a => a.id === 'land')!.terrain!.heights[4]).toBe(2)
  const unchanged = await runAgentTool('terrain.sculpt', {
    assetId: 'land', mode: 'flatten', space: 'world', center: [500, 500], radius: 2, value: 14,
  }, { tx })
  expect(unchanged.ok && unchanged.data).toMatchObject({ changedSamples: 0, effective: false, warning: expect.any(String) })
  tx.rollback()
})

it('scatters deterministically on terrain and supports rollback of the full batch', async () => {
  const tx = edit.begin('scatter', 'agent')
  edit.addAsset({ id: 'land', ref: 'generated/terrain', transform: { position: [0, 3, 0], rotation: [0, 0, 0] },
    terrain: { width: 20, depth: 20, samplesX: 2, samplesZ: 2, heights: [0, 0, 0, 0], seed: 1 },
  }, { tx, source: 'agent' })
  const args = { refs: ['models/tree-0'], min: [-8, -8], max: [8, 8], count: 8, terrainId: 'land', seed: 42 }
  expect((await runAgentTool('asset.scatter', args, { tx })).ok).toBe(true)
  const first = useSceneStore.getState().document!.assets.slice(-8).map(a => a.transform)
  expect(first.every(t => t.position[1] === 3)).toBe(true)
  await runAgentTool('asset.scatter', args, { tx })
  expect(useSceneStore.getState().document!.assets.slice(-8).map(a => a.transform)).toEqual(first)
  tx.rollback()
  expect(useSceneStore.getState().document!.assets).toHaveLength(100)
})
