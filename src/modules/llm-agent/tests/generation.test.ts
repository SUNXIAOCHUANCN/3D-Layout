import { beforeEach, describe, expect, it } from 'vitest'
import { bus } from '../../../core/events'
import { edit } from '../../../core/edit'
import { useSceneStore } from '../../../core/store'
import { GENERATION_TOOLS } from '../generationTools'
import type { AgentToolName } from '../protocol'
import { clearGeneratedResults, saveGeneratedResult } from '../generatedResults'

function tool(name: AgentToolName) {
  const result = GENERATION_TOOLS.find(t => t.name === name)
  if (!result) throw new Error(`Missing tool: ${name}`)
  return result
}

beforeEach(() => {
  useSceneStore.setState({ sceneId: 'test', document: { meta: { id: 'test', name: 'test', version: 1, unit: 'm', up: '+Y' }, environment: {}, cameras: [], assets: [] } })
  bus.emit('scene:changed', { sceneId: 'test' })
})

describe('generation tools', () => {
  it('generates deterministic terrain, samples its surface and supports undo/redo', () => {
    const tx = edit.begin('terrain', 'agent')
    const result = tool('terrain.generate').exec({ width: 10, depth: 10, samples: 3, amplitude: 3, seed: 42 }, { tx }) as { assetId: string }
    tx.commit()
    const first = useSceneStore.getState().document!.assets[0].terrain!
    expect(JSON.parse(JSON.stringify(useSceneStore.getState().document)).assets[0].terrain).toEqual(first)
    const sample = tool('terrain.sample').exec({ assetId: result.assetId, points: [[-5, -5], [5, 5], [6, 0]] }, { tx: null }) as { heights: Array<number | null> }
    expect(sample.heights).toEqual([first.heights[0], first.heights[8], null])
    expect(edit.undo()).toBe(true)
    expect(useSceneStore.getState().document!.assets).toHaveLength(0)
    expect(edit.redo()).toBe(true)
    expect(useSceneStore.getState().document!.assets[0].terrain).toEqual(first)
    const tx2 = edit.begin('same seed', 'agent')
    tool('terrain.generate').exec({ width: 10, depth: 10, samples: 3, amplitude: 3, seed: 42 }, { tx: tx2 })
    expect(useSceneStore.getState().document!.assets[1].terrain!.heights).toEqual(first.heights)
    tx2.rollback()
  })

  it('rolls back an instance material without changing other assets', () => {
    const add = edit.begin('assets', 'agent')
    for (const id of ['a', 'b']) edit.addAsset({ id, ref: 'models/test', transform: { position: [0, 0, 0], rotation: [0, 0, 0] } }, { tx: add, source: 'agent' })
    add.commit()
    const tx = edit.begin('material', 'agent')
    tool('material.apply').exec({ assetId: 'a', color: '#abcdef', roughness: 0.3 }, { tx })
    expect(useSceneStore.getState().document!.assets[0].materialOverride?.color).toBe('#abcdef')
    expect(useSceneStore.getState().document!.assets[1].materialOverride).toBeUndefined()
    tx.rollback()
    expect(useSceneStore.getState().document!.assets[0].materialOverride).toBeUndefined()
  })

  it('samples a translated, rotated and scaled terrain in world coordinates', () => {
    const tx = edit.begin('terrain', 'agent')
    const { assetId } = tool('terrain.generate').exec({ samples: 2, width: 10, depth: 10, seed: 3, amplitude: 2 }, { tx }) as { assetId: string }
    edit.setTransform(assetId, { position: [3, 5, 7], rotation: [0, 90, 0], scale: [2, 3, 4] }, { tx, source: 'agent' })
    tx.commit()
    const terrain = useSceneStore.getState().document!.assets[0].terrain!
    const sampled = tool('terrain.sample').exec({ assetId, points: [[-17, 17]] }, { tx: null }) as { heights: number[] }
    expect(sampled.heights[0]).toBeCloseTo(5 + terrain.heights[0] * 3)
  })

  it('creates a custom heightfield and rejects invalid data without editing the scene', () => {
    const tx = edit.begin('custom terrain', 'agent')
    expect(() => tool('terrain.create_heightfield').exec({ width: 10, depth: 10, samplesX: 2, samplesZ: 2, heights: [0, 1, 2] }, { tx })).toThrow()
    expect(useSceneStore.getState().document!.assets).toHaveLength(0)
    const { assetId } = tool('terrain.create_heightfield').exec({ width: 10, depth: 10, samplesX: 2, samplesZ: 2, heights: [0, 1, 2, 3] }, { tx }) as { assetId: string }
    const sampled = tool('terrain.sample').exec({ assetId, points: [[-5, -5], [5, 5]] }, { tx: null }) as { heights: number[] }
    expect(sampled.heights).toEqual([0, 3])
    tx.rollback()
    expect(useSceneStore.getState().document!.assets).toHaveLength(0)
  })

  it('imports a Python result by reference and rejects expired references', () => {
    const id = saveGeneratedResult({ width: 8, depth: 6, samplesX: 2, samplesZ: 2, heights: [0, 1, 2, 3] })
    const tx = edit.begin('Python result', 'agent')
    tool('terrain.create_heightfield').exec({ pythonResultId: id }, { tx })
    expect(useSceneStore.getState().document!.assets[0].terrain?.heights).toEqual([0, 1, 2, 3])
    tx.rollback()
    clearGeneratedResults()
    expect(() => tool('terrain.create_heightfield').exec({ pythonResultId: id }, { tx })).toThrow('当前运行')
  })
})
