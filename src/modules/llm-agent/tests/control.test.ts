import { beforeEach, expect, it, vi } from 'vitest'
import { RunGuard, beginTaskInput, selectTask, taskContext, resetTask, TASK_TOOLS } from '../taskState'
import { boundHistoricalResults, compactionCut, historyText, HISTORY_BUDGET } from '../history'
import type { LlmTurn } from '../llmClient'
import { PLAN_TOOLS } from '../plan'
import { useSceneStore } from '../../../core/store'

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
})

it('keeps the original request separate from follow-up instructions and checkpoints', () => {
  selectTask('goal-test')
  resetTask()
  beginTaskInput('goal-test', '雪山森林海洋')
  beginTaskInput('goal-test', '继续修码头')
  expect(JSON.parse(taskContext())).toMatchObject({ goal: '雪山森林海洋', instructions: ['继续修码头'] })
  selectTask('other-scene')
  expect(JSON.parse(taskContext()).goal).toBe('')
  selectTask('goal-test')
  expect(JSON.parse(taskContext()).goal).toBe('雪山森林海洋')
})

it('counts summary requests in the hard request budget', () => {
  const guard = new RunGuard({ requests: 2, minutes: 10, tools: 100 })
  guard.request()
  guard.request()
  expect(() => guard.request()).toThrow('API 请求预算')
  expect(guard.requests).toBe(2)
})

it('blocks repeated queries, resets their cache on commit and caps local repairs', () => {
  const guard = new RunGuard({ requests: 100, minutes: 10, tools: 100 })
  for (let i = 0; i < 3; i++) expect(guard.beforeTool('terrain.sample', { assetId: 'a' }, false)).toBe('')
  expect(guard.beforeTool('terrain.sample', { assetId: 'a' }, false)).toContain('重复')
  guard.committed()
  expect(guard.beforeTool('terrain.sample', { assetId: 'a' }, false)).toBe('')
  for (let i = 0; i < 6; i++) expect(guard.beforeTool('terrain.sculpt', { assetId: 'a', value: i }, true)).toBe('')
  expect(guard.beforeTool('terrain.sculpt', { assetId: 'a', value: 99 }, true)).toContain('六次')
  for (let i = 0; i < 12; i++) guard.round(false)
  expect(guard.reason()).toContain('未推进')
})

it('shrinks legacy large results and selects a size-based complete exchange boundary', () => {
  const turns: LlmTurn[] = [
    { role: 'user', text: 'goal' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'scene_get_state', args: {} }] },
    { role: 'toolResults', results: [{ callId: 'a', ok: true, content: { manifest: 'x'.repeat(400_000) } }] },
  ]
  boundHistoricalResults(turns)
  expect(historyText(turns).length).toBeLessThan(10_000)
  expect(historyText(turns)).toContain('分页重新查询')
  const many = Array.from({ length: 20 }, () => turns.slice(1)).flat()
  const cut = compactionCut(many)
  expect(cut).toBeGreaterThan(0)
  expect(many[cut].role).toBe('assistant')
  expect(historyText(many.slice(cut)).length).toBeLessThan(HISTORY_BUDGET * 0.4)
})

it('requires acceptance evidence for completion and prevents silently dropping plan steps', () => {
  useSceneStore.setState({ sceneId: 'plan-control-test' })
  selectTask('plan-control-test')
  const set = PLAN_TOOLS.find(t => t.name === 'plan.set')!
  set.exec({ steps: [{ id: 'layout', title: '整体布局', status: 'active', acceptance: '四分区存在' }] }, { tx: null })
  expect(() => set.exec({ steps: [] }, { tx: null })).toThrow('保留已有步骤')
  expect(() => set.exec({ steps: [{ id: 'layout', title: '整体布局', status: 'done' }] }, { tx: null })).toThrow()
  set.exec({ steps: [{ id: 'layout', title: '整体布局', status: 'done', evidence: '已确认四块地形' }] }, { tx: null })
  TASK_TOOLS[0].exec({ criteria: ['四个地貌区域和密度检查通过'] }, { tx: null })
  expect(JSON.parse(taskContext()).criteria).toHaveLength(1)
})
