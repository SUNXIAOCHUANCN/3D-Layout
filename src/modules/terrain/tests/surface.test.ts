import { createSurfaceMaterial } from '../material'
import { loadSceneDocument } from '../../../core/loader'
import { saveScene } from '../../../core/io'
import { AGENT_TOOLS } from '../../llm-agent/tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureSurface, brushMask, paintSurface, slopeAt, validateSurface } from '../surface'
import { TERRAIN_SURFACE_TOOLS } from '../../llm-agent/terrainSurfaceTools'
import { GENERATION_TOOLS } from '../../llm-agent/generationTools'
import { SCENE_TOOLS } from '../../llm-agent/sceneTools'
import { useSceneStore } from '../../../core/store'
import { edit } from '../../../core/edit'
import { bus } from '../../../core/events'
import type { AgentToolContext } from '../../llm-agent/tools'
const layers = [ { id: 'grass', presetId: 'grass' as const, tileSize: 2 }, { id: 'sand', presetId: 'sand' as const, tileSize: 2 }, { id: 'snow', presetId: 'snow' as const, tileSize: 2 }, { id: 'rock', presetId: 'rock' as const, tileSize: 2 } ]
const terrain = () => ({ width: 10, depth: 10, samplesX: 2, samplesZ: 2, heights: [0, 10, 0, 10], seed: 0, surface: configureSurface(layers, 'grass', 11) })
function call(name: string, args: Record<string, unknown>, ctx: AgentToolContext = { tx: null }) {
  return [...TERRAIN_SURFACE_TOOLS, ...GENERATION_TOOLS, ...SCENE_TOOLS].find(t => t.name === name)!.exec({ assetId: 't', ...args }, ctx)
}
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  useSceneStore.setState({ sceneId: 'surface-test', document: { meta: { id: 'surface-test', name: 'test', version: 1, unit: 'm', up: '+Y' }, environment: {}, cameras: [], assets: [{ id: 't', ref: 'generated/terrain', transform: { position: [20, 0, 30], rotation: [0, 90, 0], scale: [2, 1, 3] }, terrain: terrain() }] } })
  bus.emit('scene:changed', { sceneId: 'surface-test' })
})
describe('terrain surface', () => {
  it('binds custom materials and edits layer parameters without resetting paint; supports undo', () => {
    const before = useSceneStore.getState().document!.assets[0].terrain!.surface!
    const weights = before.weightMap
    const tx = edit.begin('custom material', 'agent')
    call('terrain.surface.set_material', { layerId: 'sand', material: { id: 'earth', color: '#ad7850', maps: { color: '/assets/materials/terrain-example/color.png', normal: '/assets/materials/terrain-example/normal.png' } }, normalStrength: 0.5, tileSize: 3 }, { tx })
    call('terrain.surface.set_blend', { blend: { mode: 'height', heightContrast: 6, noiseStrength: 0.4, noiseScale: 2, seed: 42 } }, { tx })
    tx.commit()
    const surface = useSceneStore.getState().document!.assets[0].terrain!.surface!
    expect(surface.weightMap).toBe(weights)
    expect(surface.layers[1]).toMatchObject({ materialId: 'earth', normalStrength: 0.5, tileSize: 3 })
    expect(surface.materials?.[0].id).toBe('earth')
    validateSurface(JSON.parse(JSON.stringify(surface)))
    expect(edit.undo()).toBe(true)
    expect(useSceneStore.getState().document!.assets[0].terrain!.surface).toEqual(before)
    expect(edit.redo()).toBe(true)
    expect(useSceneStore.getState().document!.assets[0].terrain!.surface!.blend?.mode).toBe('height')
  })
  it('rejects missing resources, unsafe texture paths and invalid blend atomically', () => {
    const before = useSceneStore.getState().document
    const tx = edit.begin('invalid material', 'agent')
    for (const path of ['https://example.com/image.png', '/assets/../image.png', '/assets/%2e%2e/image.png', '/assets/image.svg']) {
      expect(() => call('terrain.surface.set_material', { layerId: 'sand', material: { id: 'bad', maps: { color: path } } }, { tx })).toThrow()
    }
    expect(() => call('terrain.surface.set_material', { layerId: 'sand', materialId: 'missing' }, { tx })).toThrow()
    expect(() => call('terrain.surface.set_blend', { blend: { mode: 'height', noiseScale: 0 } }, { tx })).toThrow()
    expect(useSceneStore.getState().document).toBe(before)
    tx.rollback()
  })
  it('configures a custom-only layer and switches it back to a preset without losing weights', () => {
    const tx = edit.begin('custom configure', 'agent')
    call('terrain.surface.configure', { layers: [{ id: 'earth', materialId: 'custom' }], materials: [{ id: 'custom', color: '#556677' }], baseLayerId: 'earth', resolution: 8, blend: { mode: 'weight' } }, { tx })
    const weights = useSceneStore.getState().document!.assets[0].terrain!.surface!.weightMap
    call('terrain.surface.set_material', { layerId: 'earth', presetId: 'grass' }, { tx })
    const result = useSceneStore.getState().document!.assets[0].terrain!.surface!
    expect(result.weightMap).toBe(weights)
    expect(result.layers[0].materialId).toBeUndefined()
    validateSurface(result)
    tx.rollback()
  })
  it('renders parameter-only resources without network loading and disposes resources', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const surface = configureSurface([{ id: 'earth', materialId: 'custom', tileSize: 2 }], 'earth', 8, [{ id: 'custom', color: '#556677' }])
    const runtime = createSurfaceMaterial(surface, 10, 10)
    await runtime.ready
    expect(fetch).not.toHaveBeenCalled()
    expect(runtime.errors).toEqual([])
    runtime.dispose()
  })
  it('reports texture loading errors and safely handles disposal during loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const surface = configureSurface([{ id: 'earth', materialId: 'custom', tileSize: 2 }], 'earth', 8, [{ id: 'custom', maps: { color: '/assets/missing.png' } }])
      const runtime = createSurfaceMaterial(surface, 10, 10)
      await runtime.ready
      expect(runtime.errors.length).toBeGreaterThan(0)
      expect(runtime.errors[0]).toContain('404')
      runtime.dispose()
      const disposed = createSurfaceMaterial(surface, 10, 10)
      disposed.dispose(); await disposed.ready
      expect(disposed.errors).toEqual([])
    } finally { log.mockRestore() }
  })
  it('registers every surface tool for the agent', () => {
    for (const tool of TERRAIN_SURFACE_TOOLS) expect(AGENT_TOOLS.some(t => t.name === tool.name)).toBe(true)
  })
  it('saves complete surface data and validates it when loading', async () => {
    let saved: unknown
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        saved = JSON.parse(init.body as string)
        return { ok: true }
      }
      return { ok: true, json: async () => saved }
    }))
    await saveScene()
    const loaded = await loadSceneDocument('surface-test')
    expect(loaded.assets[0].terrain!.surface).toEqual(terrain().surface)
    loaded.assets[0].terrain!.surface!.version = 2 as 1
    await expect(loadSceneDocument('surface-test')).rejects.toThrow('版本')
  })
  it('paints soft edges without mutating input; keeps byte sums and unused channels valid', () => {
    const t = terrain(), original = JSON.stringify(t)
    const result = paintSurface(t, [{ layerId: 'sand', mask: brushMask({ layerId: 'sand', shape: 'circle', center: [0, 0], radius: 3, feather: 2 }) }])
    validateSurface(result.surface)
    expect(JSON.stringify(t)).toBe(original)
    const d = result.surface.weightMap.data
    expect(d[(5 * 11 + 5) * 4 + 1]).toBe(255)
    expect(d[(5 * 11 + 7) * 4 + 1]).toBeGreaterThan(0)
    expect(d[(5 * 11 + 7) * 4 + 1]).toBeLessThan(255)
    expect(d[0]).toBe(255)
  })
  it('supports polygons, paths and targeted erasing', () => {
    expect(brushMask({ layerId: 'sand', shape: 'polygon', points: [[-2, -2], [2, -2], [0, 2]] })([0, 0])).toBe(1)
    expect(brushMask({ layerId: 'sand', shape: 'path', points: [[-2, 0], [2, 0]], radius: 1 })([0, 2])).toBe(0)
    const t = terrain()
    const first = paintSurface(t, [{ layerId: 'sand', strength: 0.5, mask: () => 1 }, { layerId: 'snow', strength: 0.5, mask: () => 1 }])
    const snow = first.surface.weightMap.data[2]
    const erased = paintSurface({ ...t, surface: first.surface }, [{ layerId: 'sand', erase: true, mask: () => 1 }])
    expect(erased.surface.weightMap.data[1]).toBe(0)
    expect(erased.surface.weightMap.data[2]).toBe(snow)
    validateSurface(erased.surface)
  })
  it('calculates slope in metres including boundaries and applies ordered rules', () => {
    expect(slopeAt(terrain(), -5, -5)).toBeCloseTo(45)
    const tx = edit.begin('rules', 'agent')
    call('terrain.surface.apply_rules', { rules: [{ layerId: 'snow', height: { min: 8 } }, { layerId: 'rock', slope: { min: 40 } }] }, { tx })
    const result = useSceneStore.getState().document!.assets[0].terrain!.surface!
    expect(result.weightMap.data[3]).toBe(255)
    expect(result.weightMap.data[2]).toBe(0)
    tx.rollback()
  })
  it('uses world distances with rotation and nonuniform scale; supports undo and JSON round trip', () => {
    const before = useSceneStore.getState().document!.assets[0].terrain!.surface!
    const tx = edit.begin('paint', 'agent')
    call('terrain.surface.paint', { operations: [{ layerId: 'sand', shape: 'circle', center: [20, 30], radius: 2.5, space: 'world' }] }, { tx })
    tx.commit()
    const after = useSceneStore.getState().document!.assets[0].terrain!.surface!
    expect(after.weightMap.data[(5 * 11 + 6) * 4 + 1]).toBe(255)
    expect(after.weightMap.data[(6 * 11 + 5) * 4 + 1]).toBe(0)
    expect(edit.undo()).toBe(true)
    expect(useSceneStore.getState().document!.assets[0].terrain!.surface).toEqual(before)
    expect(edit.redo()).toBe(true)
    const restored = JSON.parse(JSON.stringify(useSceneStore.getState().document))
    validateSurface(restored.assets[0].terrain.surface)
    expect(restored.assets[0].terrain.surface).toEqual(after)
  })
  it('rejects an invalid batch atomically and guards whole-object material tools', () => {
    const before = useSceneStore.getState().document
    const tx = edit.begin('invalid', 'agent')
    expect(() => call('terrain.surface.paint', { operations: [{ layerId: 'sand', shape: 'circle', center: [0, 0], radius: 3 }, { layerId: 'missing', shape: 'circle', center: [0, 0], radius: 3 }] }, { tx })).toThrow()
    expect(useSceneStore.getState().document).toBe(before)
    expect(() => call('material.apply', { color: '#ffffff' }, { tx })).toThrow('分层地形')
    expect(() => call('material.batch', { assetIds: ['t'], color: '#ffffff' }, { tx })).toThrow('分层地形')
    expect(() => call('terrain.surface.reset', {}, { tx: null })).toThrow()
    tx.rollback()
  })
  it('validates persisted data and supports configuring and resetting', () => {
    const s = configureSurface(layers.slice(0, 2), 'sand', 8)
    validateSurface(s)
    s.weightMap.data[3] = 1
    expect(() => validateSurface(s)).toThrow()
    const tx = edit.begin('configure', 'agent')
    call('terrain.surface.configure', { layers, baseLayerId: 'grass', resolution: 8 }, { tx })
    call('terrain.surface.reset', { mode: 'base' }, { tx })
    expect(call('terrain.surface.get', {})).toHaveProperty('surface')
    expect(call('terrain.surface.sample', { points: [[0, 0], [99, 99]] })).toHaveProperty('samples')
    call('terrain.surface.reset', {}, { tx })
    expect(useSceneStore.getState().document!.assets[0].terrain!.surface).toBeUndefined()
    tx.rollback()
  })
})
