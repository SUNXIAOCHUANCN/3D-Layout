import { beforeEach, expect, it } from 'vitest'
import { bus } from '../../../core/events'
import { edit } from '../../../core/edit'
import { useSceneStore } from '../../../core/store'
import type { LlmTurn } from '../llmClient'
import { retainImages, compactionCut } from '../history'
import { runAgentTool } from '../tools'

beforeEach(() => {
  useSceneStore.setState({
    sceneId: 'test',
    document: {
      meta: { id: 'test', name: 'test', version: 1, unit: 'm', up: '+Y' },
      environment: {}, cameras: [],
      assets: ['a', 'b'].map(id => ({ id, ref: 'test', transform: { position: [0, 0, 0], rotation: [0, 0, 0] } })),
    },
  })
  bus.emit('scene:changed', { sceneId: 'test' })
})

it('validates the entire batch before editing and rolls back successful writes', async () => {
  const tx = edit.begin('batch', 'agent')
  const change = { assetId: 'a', position: [2, 3, 4] }
  const run = (items: unknown[]) => runAgentTool('asset.batch', { operation: 'transform', items }, { tx })
  expect((await run([change, { assetId: 'b', position: [0, 0] }])).ok).toBe(false)
  expect(useSceneStore.getState().document!.assets[0].transform.position).toEqual([0, 0, 0])
  expect((await run([change, { assetId: 'b', scale: [2, 2, 2] }])).ok).toBe(true)
  expect(useSceneStore.getState().document!.assets[0].transform.position).toEqual([2, 3, 4])
  tx.rollback()
  expect(useSceneStore.getState().document!.assets[0].transform.position).toEqual([0, 0, 0])
  expect(useSceneStore.getState().document!.assets[1].transform.scale).toBeUndefined()
})

it('retains recent screenshots and removes stale claims from older results', () => {
  const turns: LlmTurn[] = Array.from({ length: 4 }, (_, i) => ({
    role: 'toolResults',
    results: [{ callId: String(i), ok: true, content: { screenshotId: String(i), note: '已附图' }, images: [{ dataUrl: 'test' }] }],
  }))
  retainImages(turns)
  const [old, ...recent] = turns.map(turn => turn.role === 'toolResults' ? turn.results[0] : undefined)
  expect(old?.images).toBeUndefined()
  expect(old?.content).toMatchObject({ screenshotId: '0', note: expect.stringContaining('已移出') })
  expect(recent.every(result => result?.images?.length === 1)).toBe(true)
})

it('keeps an assistant tool call with its results at the compaction boundary', () => {
  const user: LlmTurn = { role: 'user', text: 'test' }
  const turns: LlmTurn[] = [{ role: 'user', text: 'x'.repeat(50_000) }, { role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'test', args: {} }] },
    { role: 'toolResults', results: [{ callId: 'a', ok: true, content: {} }] }, ...Array<LlmTurn>(15).fill(user)]
  expect(compactionCut(turns)).toBe(1)
})
