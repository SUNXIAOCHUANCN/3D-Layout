import { afterEach, expect, it, vi } from 'vitest'
import { GO_BASE_URL, joinLlmUrl, requestLlm } from '../request'
import { llmChat as agentChat, testLlmConnection } from '../../agent/llmClient'
import { llmChat as editorChat } from '../../llm-agent/llmClient'
import { createProfileFromPreset } from '../../agent/llmSettings'
import { createProfileFromPreset as editorProfile } from '../../llm-agent/llmSettings'

const settings = { ...createProfileFromPreset('opencode-go'), apiKey: 'test-key' }
const headersOf = (init: RequestInit | undefined): Record<string, string> => (init?.headers ?? {}) as Record<string, string>
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('normalizes pasted endpoints and keeps both preset copies in sync', () => {
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
    expect(headersOf(init)).toMatchObject({
      'x-layout-upstream': GO_BASE_URL + '/chat/completions',
      'x-layout-upstream-headers': expect.any(String),
    })
    const forwarded = JSON.parse(atob(headersOf(init)['x-layout-upstream-headers']))
    expect(forwarded['x-opencode-session']).toBe('stable-session')
    expect(forwarded.Authorization).toBe('Bearer test-key')
    expect(String(init?.body)).toContain('image_url'); expect(String(init?.body)).toContain('scene_read')
  }
})

it('routes every provider through the relay first, packaging protocol-specific headers', async () => {
  const calls = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { headers: { 'x-layout-llm-relay': '1' } }))
  const glm = { ...createProfileFromPreset('glm'), apiKey: 'glm-key' }
  await requestLlm(glm, glm.baseURL + '/chat/completions', '{}', new AbortController().signal)
  expect(calls).toHaveBeenCalledTimes(1)
  expect(calls.mock.calls[0][0]).toBe('/api/llm/request')
  expect(calls.mock.calls[0][1]?.headers).toMatchObject({ 'x-layout-upstream': glm.baseURL + '/chat/completions' })
  const anthropic = { ...createProfileFromPreset('anthropic'), apiKey: 'ant-key' }
  await requestLlm(anthropic, anthropic.baseURL + '/v1/messages', '{}', new AbortController().signal)
  const forwarded = JSON.parse(atob(headersOf(calls.mock.calls[1][1])['x-layout-upstream-headers']))
  expect(forwarded).toMatchObject({ 'x-api-key': 'ant-key', 'anthropic-version': '2023-06-01' })
})

it('falls back to browser-direct only when the relay middleware is absent (static hosting)', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response('<html>fallback</html>'))
    .mockResolvedValueOnce(new Response('{"ok":true}'))
  const direct = { ...settings, provider: 'deepseek', baseURL: 'https://api.deepseek.com/v1' }
  const res = await requestLlm(direct, direct.baseURL + '/chat/completions', '{}', new AbortController().signal)
  expect(await res.text()).toBe('{"ok":true}')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[0][0]).toBe('/api/llm/request')
  expect(fetch.mock.calls[1][0]).toBe(direct.baseURL + '/chat/completions')
  expect((fetch.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
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
