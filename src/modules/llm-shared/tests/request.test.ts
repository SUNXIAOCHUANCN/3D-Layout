import { afterEach, expect, it, vi } from 'vitest'
import { GO_BASE_URL, joinLlmUrl, requestLlm, usesGoRelay } from '../request'
import { llmChat as agentChat, testLlmConnection } from '../../agent/llmClient'
import { llmChat as editorChat } from '../../llm-agent/llmClient'
import { createProfileFromPreset } from '../../agent/llmSettings'
import { createProfileFromPreset as editorProfile } from '../../llm-agent/llmSettings'

const settings = { ...createProfileFromPreset('opencode-go'), apiKey: 'test-key' }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('recognizes old custom Go settings and normalizes pasted endpoints', () => {
  expect(usesGoRelay({ ...settings, provider: 'custom', baseURL: 'https://opencode.ai/zen/go/v1' })).toBe(true)
  expect(usesGoRelay({ ...settings, provider: 'custom', baseURL: 'https://api.deepseek.com/v1' })).toBe(false)
  expect(joinLlmUrl(' ' + GO_BASE_URL + '/chat/completions/ ', '/chat/completions')).toBe(GO_BASE_URL + '/chat/completions')
  expect(editorProfile('opencode-go').baseURL).toBe(GO_BASE_URL)
})

it('both clients relay tools, screenshots, and a stable conversation ID', async () => {
  const calls = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
    'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'x-layout-llm-relay': '1', 'Content-Type': 'text/event-stream' } },
  ))
  for (const chat of [agentChat, editorChat]) {
    const result = await chat({ settings, sessionId: 'stable-session', system: 'layout',
      turns: [{ role: 'user', text: 'arrange', images: [{ dataUrl: 'data:image/png;base64,AAAA' }] }],
      tools: [{ name: 'scene_read', description: 'read', schema: { type: 'object', properties: {} } }],
      signal: new AbortController().signal, onEvent: () => {},
    })
    expect(result.text).toBe('hello')
  }
  for (const [url, init] of calls.mock.calls) {
    expect(url).toBe('/api/llm/request')
    expect(init?.headers).toMatchObject({ 'x-opencode-session': 'stable-session' })
    expect(String(init?.body)).toContain('image_url'); expect(String(init?.body)).toContain('scene_read')
  }
})

it('keeps other providers direct and identifies missing relay on static hosting', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  const direct = { ...settings, provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1' }
  await requestLlm(direct, direct.baseURL + '/chat/completions', '{}', new AbortController().signal)
  expect(fetch.mock.calls[0][0]).toBe(direct.baseURL + '/chat/completions')
  fetch.mockResolvedValue(new Response('<html>fallback</html>'))
  await expect(requestLlm(settings, GO_BASE_URL, '{}', new AbortController().signal)).rejects.toThrow('未提供模型转发服务')
})

it('connection test uses relay and reports actual upstream errors without leaking keys', async () => {
  vi.stubGlobal('window', globalThis)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied test-key', { status: 403, headers: { 'x-layout-llm-relay': '1' } }))
  const result = await testLlmConnection(settings)
  expect(result.ok).toBe(false); expect(result.message).toContain('HTTP 403')
  expect(result.message).not.toContain('test-key')
})

it('preserves cancellation instead of reporting CORS', async () => {
  const ac = new AbortController(); ac.abort()
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(ac.signal.reason)
  await expect(requestLlm(settings, GO_BASE_URL, '{}', ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
