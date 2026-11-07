import { beforeEach, expect, it, vi } from 'vitest'
import { useSceneStore } from '../../../core/store'
import { edit as coreEdit } from '../../../core/edit'
import { createScope, edit } from '../scopedEdit'
import { runAgentTool } from '../tools'
import { partition, scene } from './fixtures'
import { getGeneratedResult, saveGeneratedResult } from '../generatedResults'
beforeEach(scene)
function scope(regionId?: string, signal = new AbortController().signal) {
  return createScope({ sceneId: 'test', regionId, partition: partition(), signal, changed: vi.fn() })
}
it('immediately applies own edits without opening or committing a long transaction', async () => {
  const begin = vi.spyOn(coreEdit, 'begin')
  const result = await runAgentTool('asset.set_transform', { assetId: 'a', transform: { position: [-4, 0, 1], rotation: [0, 0, 0] } }, { tx: scope('left') })
  expect(result.ok).toBe(true)
  expect(useSceneStore.getState().document!.assets[0].transform.position).toEqual([-4, 0, 1])
  expect(begin).not.toHaveBeenCalled(); begin.mockRestore()
})
it('rejects foreign deletes, material writes, moves outside and new objects outside', async () => {
  const tx = scope('left')
  expect((await runAgentTool('asset.remove', { assetId: 'b' }, { tx })).ok).toBe(false)
  const material = await runAgentTool('material.apply', { assetId: 'b', color: '#ff0000', roughness: .5, metalness: 0 }, { tx })
  expect(material.ok).toBe(false)
  expect(!material.ok && material.error).toContain('越权')
  expect(() => edit.setTransform('a', { position: [1, 0, 0], rotation: [0, 0, 0] }, { tx })).toThrow('越权')
  expect(() => edit.addAsset({ id: 'new', ref: 'test', transform: { position: [1, 0, 0], rotation: [0, 0, 0] } }, { tx })).toThrow('越权')
  expect(useSceneStore.getState().document!.assets).toHaveLength(2)
})
it('checks every edit in batches and retains earlier legal modifications on failure', async () => {
  const result = await runAgentTool('asset.batch', { operation: 'transform', items: [
    { assetId: 'a', position: [-4, 0, 0] }, { assetId: 'b', position: [4, 0, 0] },
  ] }, { tx: scope('left') })
  expect(result.ok).toBe(false)
  expect(useSceneStore.getState().document!.assets.map(a => a.transform.position[0])).toEqual([-4, 5])
})
it('labels created objects and updates ownership for coordinator transfers', () => {
  const p = partition(), tx = createScope({ sceneId: 'test', regionId: 'left', partition: p, signal: new AbortController().signal, changed() {} })
  edit.addAsset({ id: 'new', ref: 'test', transform: { position: [-1, 0, 0], rotation: [0, 0, 0] } }, { tx })
  expect(p.owners.new).toBe('left')
  const root = createScope({ sceneId: 'test', partition: p, signal: new AbortController().signal, changed() {} })
  edit.setTransform('new', { position: [1, 0, 0], rotation: [0, 0, 0] }, { tx: root })
  expect(p.owners.new).toBe('right')
})
it('prevents writes after cancellation and after switching scenes', () => {
  const ac = new AbortController(), tx = scope('left', ac.signal)
  ac.abort(); expect(() => edit.removeAsset('a', { tx })).toThrow()
  const old = scope('left'); useSceneStore.setState({ sceneId: 'other' })
  expect(() => edit.removeAsset('a', { tx: old })).toThrow('场景已切换')
})
it('isolates Python results between SubAgent contexts', () => {
  const id = saveGeneratedResult({ heights: [1] }, 'first')
  expect(() => getGeneratedResult(id, 'second')).toThrow('不属于当前运行')
  expect(getGeneratedResult(id, 'first')).toEqual({ heights: [1] })
})
