import { beforeEach, expect, it, vi } from 'vitest'
import { PartitionAgentRuntime } from '../runtime'
import { usePartitionAgentStore as store } from '../store'
import { useSceneStore } from '../../../core/store'
import { emptySession, type SceneSession } from '../types'
import { partition, scene } from './fixtures'
import type { LlmChatOptions, LlmChatResult } from '../llmClient'
import { loadSession, saveSceneSnapshot } from '../persistence'
vi.mock('../persistence', () => ({ cacheSession: vi.fn(() => ({ ok: true })), saveSession: vi.fn().mockResolvedValue(undefined), saveSceneSnapshot: vi.fn().mockResolvedValue(undefined), loadSession: vi.fn() }))
vi.mock('../llmSettings', () => ({ getActiveSettings: () => ({ provider: 'test', protocol: 'openai-chat', baseURL: 'https://test', apiKey: 'test', model: 'test', sendImages: true }), isLlmConfigured: () => true }))
let session: SceneSession
beforeEach(() => {
  vi.clearAllMocks()
  scene(); session = emptySession('test'); session.partition = partition()
  store.setState({ session, busy: false, loading: false, error: '', workers: [] })
})
const done = (text = '已完成'): LlmChatResult => ({ stopReason: 'end', text, toolCalls: [] })
it('starts both regions before either returns and edits the shared scene immediately', async () => {
  let release!: () => void, ready!: () => void
  const gate = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { ready = r })
  const ids: string[] = [], counts = new Map<string, number>()
  const runtime = new PartitionAgentRuntime(async (options: LlmChatOptions) => {
    const id = options.sessionId!, count = counts.get(id) ?? 0; counts.set(id, count + 1)
    if (count) return done()
    expect(options.turns).toHaveLength(1)
    const task = JSON.parse((options.turns[0] as { text: string }).text)
    ids.push(id); if (ids.length === 2) ready()
    await gate
    const left = task.region.id === 'left'
    return { stopReason: 'tool_use', text: '', toolCalls: [{ id: 'move', name: 'asset__set_transform', args: { assetId: left ? 'a' : 'b', transform: { position: [left ? -3 : 3, 0, 0], rotation: [0, 0, 0] } } }] }
  })
  const task = { tasks: [{ regionId: 'left', task: '调整左区' }, { regionId: 'right', task: '调整右区' }] }
  const run = runtime.dispatch(session, new AbortController().signal, task)
  await started; expect(new Set(ids).size).toBe(2); release()
  const results = await run
  expect(results.map(r => r.status)).toEqual(['completed', 'completed'])
  expect(useSceneStore.getState().document!.assets.map(a => a.transform.position[0])).toEqual([-3, 3])
  const previous = new Set(ids)
  await runtime.dispatch(session, new AbortController().signal, task)
  expect(ids.slice(2).every(id => !previous.has(id))).toBe(true)
})
it('keeps applied edits when clearing context and ignores late model replies', async () => {
  let release!: (value: LlmChatResult) => void, reached!: () => void
  const waiting = new Promise<void>(r => { reached = r })
  let n = 0
  const runtime = new PartitionAgentRuntime(async () => {
    if (n++ === 0) return { stopReason: 'tool_use', text: '', toolCalls: [{ id: 'move', name: 'asset__set_transform', args: { assetId: 'a', transform: { position: [-2, 0, 0], rotation: [0, 0, 0] } } }] }
    reached(); return new Promise(r => { release = r })
  })
  const run = runtime.send('移动对象')
  await waiting
  expect(useSceneStore.getState().document!.assets[0].transform.position[0]).toBe(-2)
  const oldId = session.sessionId; await runtime.clear()
  release(done('不应该写入的新回复')); await run
  expect(store.getState().session!.sessionId).not.toBe(oldId)
  expect(store.getState().session!.chat).toEqual([])
  expect(store.getState().session!.turns).toEqual([])
  expect(store.getState().session!.partition).not.toBeNull()
  expect(useSceneStore.getState().document!.assets[0].transform.position[0]).toBe(-2)
})
it('rejects duplicate region tasks before starting workers', async () => {
  const chat = vi.fn().mockResolvedValue(done()), runtime = new PartitionAgentRuntime(chat)
  await expect(runtime.dispatch(session, new AbortController().signal, { tasks: [{ regionId: 'left', task: 'a' }, { regionId: 'left', task: 'b' }] })).rejects.toThrow('同一分区')
  expect(chat).not.toHaveBeenCalled()
})
it('runs coordinator delegation through to the final report and persists scene snapshots', async () => {
  const counts = new Map<string, number>()
  const runtime = new PartitionAgentRuntime(async options => {
    const id = options.sessionId!, count = counts.get(id) ?? 0; counts.set(id, count + 1)
    if (id === session.sessionId) {
      if (count) {
        const result = options.turns.at(-1)
        expect(result?.role).toBe('toolResults')
        return done('两个分区均已执行')
      }
      return { stopReason: 'tool_use', text: '', toolCalls: [{ id: 'dispatch', name: 'agent_dispatch', args: { tasks: [{ regionId: 'left', task: '调整' }, { regionId: 'right', task: '调整' }] } }] }
    }
    if (count) return done()
    const left = JSON.parse((options.turns[0] as { text: string }).text).region.id === 'left'
    return { stopReason: 'tool_use', text: '', toolCalls: [{ id: 'move', name: 'asset__set_transform', args: { assetId: left ? 'a' : 'b', transform: { position: [left ? -1 : 1, 0, 0], rotation: [0, 0, 0] } } }] }
  })
  await runtime.send('分别调整两个分区')
  expect(store.getState().session!.chat.at(-1)?.text).toBe('两个分区均已执行')
  expect(store.getState().workers.map(w => w.status)).toEqual(['completed', 'completed'])
  expect(saveSceneSnapshot).toHaveBeenCalled()
  expect(store.getState().busy).toBe(false)
})
it('ignores old-scene responses while restoring a different scene conversation', async () => {
  let release!: (value: LlmChatResult) => void, ready!: () => void
  const waiting = new Promise<void>(r => { ready = r })
  const runtime = new PartitionAgentRuntime(async () => { ready(); return new Promise(r => { release = r }) })
  const run = runtime.send('旧场景任务'); await waiting
  const other = emptySession('other'); other.chat.push({ role: 'user', text: '另一个场景的历史' })
  vi.mocked(loadSession).mockResolvedValue(other)
  useSceneStore.setState({ sceneId: 'other' }); await runtime.selectScene('other')
  release({ stopReason: 'tool_use', text: '', toolCalls: [{ id: 'late', name: 'asset__remove', args: { assetId: 'a' } }] }); await run
  expect(store.getState().session!.chat).toEqual(other.chat)
  expect(useSceneStore.getState().document!.assets).toHaveLength(2)
})
it('releases host busy state when the plugin is disabled during a request', async () => {
  let release!: (value: LlmChatResult) => void, ready!: () => void
  const waiting = new Promise<void>(r => { ready = r })
  const runtime = new PartitionAgentRuntime(async () => { ready(); return new Promise(r => { release = r }) })
  const run = runtime.send('工作'); await waiting
  expect(store.getState().busy).toBe(true)
  runtime.stop(); expect(store.getState().busy).toBe(false)
  release(done('迟到结果')); await run
  expect(store.getState().busy).toBe(false)
  expect(store.getState().session!.chat.some(m => m.text === '迟到结果')).toBe(false)
})
