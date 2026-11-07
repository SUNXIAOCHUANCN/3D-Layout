import { beforeEach, expect, it, vi } from 'vitest'
import { LlmChatTransport } from '../llmChatTransport'
import { llmChat } from '../llmClient'
import { useSceneStore } from '../../../core/store'
import { useAgentStore } from '../agentStore'
import { useTaskState, selectTask, resetTask, setLimits } from '../taskState'
import { runAgentTool } from '../tools'
import type { AgentOutbound } from '../protocol'
import type { LlmTurn } from '../llmClient'

vi.mock('../llmClient', () => ({ llmChat: vi.fn() }))
vi.mock('../runLog', () => ({
  runLog: { start: vi.fn(), finish: vi.fn(), event: vi.fn(), screenshot: vi.fn(), track: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: false }) }))
  useSceneStore.setState({ sceneId: 'transport-test', document: {
    meta: { id: 'transport-test', name: 'test', version: 1, unit: 'm', up: '+Y' }, environment: {}, cameras: [], assets: [],
  } })
  useAgentStore.setState({ llmBusy: false })
  selectTask('transport-test')
  resetTask()
})

function start() {
  const transport = new LlmChatTransport()
  transport.start({
    onStatus: () => {},
    onInbound: message => {
      if (message.kind !== 'call') return
      void runAgentTool(message.tool, message.args ?? {}, { tx: null }).then(result => {
        transport.send({ kind: 'call_result', callId: message.callId, ...result } as AgentOutbound)
      })
    },
  })
  return transport
}

it('stops at the shared API budget and preserves original goals across continuation', async () => {
  setLimits({ requests: 3, minutes: 20, tools: 400 })
  vi.mocked(llmChat).mockResolvedValue({
    text: '', stopReason: 'tool_use',
    toolCalls: [{ id: 'call1', name: 'scene_get_state', args: {} }],
  })
  const transport = start()
  await transport.sendUserMessage('建立四种地貌')
  expect(llmChat).toHaveBeenCalledTimes(3)
  expect(useTaskState.getState().task.checkpoint).toMatchObject({ status: 'limited', requests: 3, reason: '达到 API 请求预算' })
  expect(useAgentStore.getState().llmBusy).toBe(false)
  vi.mocked(llmChat).mockResolvedValue({ text: '暂停检查', stopReason: 'end', toolCalls: [] })
  await transport.sendUserMessage('继续修码头')
  const last = vi.mocked(llmChat).mock.calls.at(-1)![0]
  expect(last.system).toContain('建立四种地貌')
  expect(last.system).toContain('继续修码头')
  expect(useTaskState.getState().task.goal).toBe('建立四种地貌')
  transport.stop()
})

it('does not issue a normal request after a fatal summary API error', async () => {
  const transport = start()
  // Simulate a restored long conversation whose individual results are already bounded.
  const turns: LlmTurn[] = Array.from({ length: 24 }, (_, i) => ({ role: 'user', text: i + 'x'.repeat(6000) }))
  Object.assign(transport, { turns })
  vi.mocked(llmChat).mockRejectedValue(new Error('HTTP 402: insufficient_balance'))
  await transport.sendUserMessage('继续')
  expect(llmChat).toHaveBeenCalledTimes(1)
  expect(vi.mocked(llmChat).mock.calls[0][0].tools).toEqual([])
  expect(useTaskState.getState().task.checkpoint).toMatchObject({ status: 'failed', requests: 1 })
  expect(useAgentStore.getState().llmBusy).toBe(false)
  transport.stop()
})

it('cools down successful compaction and retains a bounded recent tail', async () => {
  const transport = start()
  Object.assign(transport, { turns: Array.from({ length: 24 }, (_, i) => ({ role: 'user', text: i + 'x'.repeat(6000) })) })
  vi.mocked(llmChat).mockImplementation(async options => options.tools.length === 0
    ? { text: '已完成布局，待检查主体', stopReason: 'end', toolCalls: [] }
    : { text: '布局检查结束', stopReason: 'end', toolCalls: [] })
  await transport.sendUserMessage('检查整体布局')
  expect(llmChat).toHaveBeenCalledTimes(2)
  const normal = vi.mocked(llmChat).mock.calls[1][0]
  expect(normal.system).toContain('检查整体布局')
  expect(JSON.stringify(normal.turns).length).toBeLessThan(50_000)
  expect(useTaskState.getState().task.checkpoint?.requests).toBe(2)
  transport.stop()
})
