import { afterEach, expect, it, vi } from 'vitest'
import { LlmChatTransport } from '../../agent/llmChatTransport'
import { LlmChatTransport as EditorTransport } from '../../llm-agent/llmChatTransport'
import { llmChat } from '../../agent/llmClient'
import { llmChat as editorChat } from '../../llm-agent/llmClient'
import { createModelAdapter } from '../../coagent/adapters/modelAdapter'
import { useSceneStore } from '../../../core/store'
import { resetTask, selectTask } from '../../llm-agent/taskState'

vi.mock('../../agent/llmClient', () => ({ llmChat: vi.fn() }))
vi.mock('../../llm-agent/llmClient', () => ({ llmChat: vi.fn() }))
vi.mock('../../llm-agent/runLog', () => ({ runLog: {
  start: vi.fn(), finish: vi.fn(), event: vi.fn(), track: vi.fn(), screenshot: vi.fn(),
} }))
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

it('both chat panels keep the session across messages and change it after reset', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: false }) }))
  useSceneStore.setState({ sceneId: 'session-test', document: {
    meta: { id: 'session-test', name: 'test', version: 1, unit: 'm', up: '+Y' },
    environment: {}, cameras: [], assets: [],
  } })
  selectTask('session-test'); resetTask()
  for (const [Transport, chat] of [[LlmChatTransport, llmChat], [EditorTransport, editorChat]] as const) {
    vi.mocked(chat).mockResolvedValue({ text: 'ok', stopReason: 'end', toolCalls: [] })
    const transport = new Transport()
    transport.start({ onStatus: () => {}, onInbound: () => {} })
    try {
      await transport.sendUserMessage('describe scene')
      await transport.sendUserMessage('continue')
      transport.resetConversation()
      await transport.sendUserMessage('new conversation')
      const calls = vi.mocked(chat).mock.calls
      expect(calls).toHaveLength(3)
      expect(calls[0][0].sessionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(calls[1][0].sessionId).toBe(calls[0][0].sessionId)
      expect(calls[2][0].sessionId).not.toBe(calls[0][0].sessionId)
    } finally { transport.stop() }
  }
})

it('CoAgent passes the run session through and keeps fallback calls stable', async () => {
  vi.mocked(llmChat).mockResolvedValue({ text: 'ok', stopReason: 'end', toolCalls: [] })
  const adapter = createModelAdapter({ getSettings: () => ({
    provider: 'opencode-go', protocol: 'openai-chat', apiKey: 'test-key',
    baseURL: 'https://opencode.ai/inference/go/openai/v1', model: 'mimo-v2.5', sendImages: false,
  }) })
  const request = { purpose: 'planner', system: 'layout', messages: [], tools: [], timeoutMs: 1000 }
  for (let i = 0; i < 2; i++) await adapter.complete(request, new AbortController().signal)
  const calls = vi.mocked(llmChat).mock.calls
  expect(calls[0][0].sessionId).toBe(calls[1][0].sessionId)
  await adapter.complete({ ...request, sessionId: 'coagent-run-new' }, new AbortController().signal)
  expect(calls[2][0].sessionId).toBe('coagent-run-new')
  expect(editorChat).not.toHaveBeenCalled()
})
