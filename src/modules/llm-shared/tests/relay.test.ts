import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { allowedUpstreamUrl, handleLlmRelay, type RelayOptions, type UpstreamReply } from '../relayServer'
import { GO_BASE_URL } from '../request'

let server: Server
let origin: string
let options: RelayOptions = {}
const key = 'test-secret-never-log'
const target = GO_BASE_URL + '/chat/completions'

const reply = (status: number, chunks: string[], headers: Record<string, string> = {}): UpstreamReply => ({
  status,
  contentType: headers['content-type'] ?? 'application/json',
  encoding: headers['content-encoding'],
  body: Readable.from(chunks),
})

const packagedHeaders = (headers: Record<string, string>): string =>
  Buffer.from(JSON.stringify(headers), 'utf8').toString('base64')

const defaultPackaged = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
  'x-opencode-session': 'conversation-123',
})

beforeEach(async () => {
  options = {}
  server = createServer((req, res) => { if (!handleLlmRelay(req, res, options)) { res.statusCode = 404; res.end() } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) })

function send(headers: Record<string, string> = {}, body = '{"model":"mimo-v2.5"}') {
  return new Promise<{ status: number; body: string; relay: string | string[] | undefined }>((resolve, reject) => {
    const req = request(origin + '/api/llm/request', { method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json',
      'x-layout-upstream': target, 'x-layout-upstream-headers': packagedHeaders(defaultPackaged()), ...headers,
    } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body: text, relay: res.headers['x-layout-llm-relay'] }))
      res.on('error', reject)
    })
    req.on('error', reject); req.end(body)
  })
}

describe('local model relay', () => {
  it('allows any https upstream and loopback http, rejecting userinfo, query and external http', () => {
    expect(allowedUpstreamUrl(target)?.href).toBe(target)
    expect(allowedUpstreamUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions')).not.toBeNull()
    expect(allowedUpstreamUrl('https://api.anthropic.com/v1/messages')).not.toBeNull()
    expect(allowedUpstreamUrl('https://gateway.internal:8443/v1')).not.toBeNull()
    expect(allowedUpstreamUrl('http://localhost:11434/v1/chat/completions')).not.toBeNull()
    expect(allowedUpstreamUrl('http://127.0.0.1:1234/v1')).not.toBeNull()
    for (const url of ['http://example.com/v1/chat/completions', 'https://user:pass@opencode.ai/v1/chat/completions',
      target + '?key=x', target + '#x', 'ftp://opencode.ai/v1/chat/completions']) {
      expect(allowedUpstreamUrl(url)).toBeNull()
    }
  })
  it('forwards packaged protocol headers with identity encoding and upstream success', async () => {
    let seen: { url: URL; headers: Record<string, string>; body: Buffer } | undefined
    options = {
      transport: async (url, headers, body) => {
        seen = { url, headers, body }
        return reply(200, ['{"choices":[]}'])
      },
    }
    const result = await send()
    expect(result.status).toBe(200); expect(result.relay).toBe('1'); expect(result.body).toBe('{"choices":[]}')
    expect(seen?.url.href).toBe(target)
    expect(seen?.headers).toMatchObject({
      'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
      'x-opencode-session': 'conversation-123',
      'User-Agent': '3d-layout/0.1.0', 'Accept-Encoding': 'identity',
    })
    expect(seen?.body.toString()).toBe('{"model":"mimo-v2.5"}')
  })
  it('fills default headers when the browser omits them and forwards anthropic keys', async () => {
    const seen: Record<string, Record<string, string>> = {}
    let call = 0
    options = { transport: async (_url, headers) => { seen[call++] = headers; return reply(200, ['{}']) } }
    await send({ 'x-layout-upstream-headers': packagedHeaders({ Authorization: `Bearer ${key}` }) })
    expect(seen[0]).toMatchObject({ 'User-Agent': '3d-layout/0.1.0', Accept: '*/*', 'Content-Type': 'application/json' })
    await send({ 'x-layout-upstream-headers': packagedHeaders({
      'Content-Type': 'application/json', 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true' }) })
    expect(seen[1]).toMatchObject({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' })
  })
  it('drops forbidden headers instead of forwarding them upstream', async () => {
    let seen: Record<string, string> | undefined
    options = { transport: async (_url, headers) => { seen = headers; return reply(200, ['{}']) } }
    await send({ 'x-layout-upstream-headers': packagedHeaders({
      Authorization: `Bearer ${key}`, Cookie: 'stolen=1', Host: 'evil.example', 'X-Layout-Upstream': 'https://evil.example' }) })
    expect(seen?.Cookie).toBeUndefined()
    expect(seen?.Host).toBeUndefined()
    expect(seen?.['X-Layout-Upstream']).toBeUndefined()
    expect(seen?.Authorization).toBe(`Bearer ${key}`)
  })
  it('rejects foreign origins, disallowed upstreams, missing keys and malformed JSON before forwarding', async () => {
    let calls = 0
    options = { transport: async () => { calls++; return reply(200, ['{}']) } }
    expect((await send({ Origin: 'https://evil.example' })).status).toBe(403)
    expect((await send({ 'x-layout-upstream': 'http://example.com/v1/chat/completions' })).status).toBe(400)
    expect((await send({ 'x-layout-upstream-headers': 'not-valid-base64!!' })).status).toBe(400)
    expect((await send({ 'x-layout-upstream-headers': packagedHeaders({ 'Content-Type': 'application/json' }) })).status).toBe(400)
    expect((await send({}, 'invalid')).status).toBe(400)
    expect(calls).toBe(0)
  })
  it('preserves upstream status and removes echoed API keys in both auth styles', async () => {
    options = { transport: async () => reply(429, [`quota exceeded ${key}`]) }
    let result = await send()
    expect(result.status).toBe(429); expect(result.body).toContain('quota exceeded')
    expect(result.body).not.toContain(key)
    const antKey = 'sk-ant-echoed-secret'
    options = { transport: async () => reply(401, [`invalid x-api-key ${antKey}`]) }
    result = await send({ 'x-layout-upstream-headers': packagedHeaders({ 'x-api-key': antKey }) })
    expect(result.status).toBe(401); expect(result.body).not.toContain(antKey)
  })
  it('does not follow upstream redirects', async () => {
    let calls = 0
    options = { transport: async () => { calls++; return reply(302, [], { Location: 'https://evil.example' }) } }
    expect((await send()).status).toBe(502); expect(calls).toBe(1)
  })
  it('gives up on a slow first byte with an explicit 504 message', async () => {
    options = {
      firstByteMs: 300,
      transport: (_url, _headers, _body, signal) => new Promise<UpstreamReply>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('请求已取消')), { once: true })
      }),
    }
    const started = Date.now()
    const result = await send()
    expect(result.status).toBe(504)
    expect(result.body).toContain('等待上游模型服务响应超过 0.3 秒')
    expect(Date.now() - started).toBeLessThan(5_000)
  })
  it('delivers an SSE chunk before completion and aborts upstream on client disconnect', async () => {
    let aborted = false
    options = {
      transport: async (_url, _headers, _body, signal) => {
        const body = new Readable({ read() { /* stays open until aborted */ } })
        body.push('data: first\n\n')
        signal.addEventListener('abort', () => { aborted = true; body.destroy() }, { once: true })
        return { status: 200, contentType: 'text/event-stream', body }
      },
    }
    await new Promise<void>((resolve, reject) => {
      const req = request(origin + '/api/llm/request', { method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json',
        'x-layout-upstream': target, 'x-layout-upstream-headers': packagedHeaders({
          Authorization: `Bearer ${key}`, 'x-opencode-session': 'session-stream' }),
      } }, res => {
        res.once('data', chunk => {
          expect(String(chunk)).toBe('data: first\n\n')
          req.destroy()
          setTimeout(resolve, 100)
        })
      })
      req.on('error', reject); req.end('{}')
    })
    expect(aborted).toBe(true)
  })
})
