import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { allowedGoUrl, handleLlmRelay, type RelayOptions, type UpstreamReply } from '../relayServer'
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
      Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
      'x-layout-upstream': target, 'x-opencode-session': 'conversation-123', ...headers,
    } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body: text, relay: res.headers['x-layout-llm-relay'] }))
      res.on('error', reject)
    })
    req.on('error', reject); req.end(body)
  })
}

describe('local Go relay', () => {
  it('only allows fixed HTTPS Go paths, without credentials, query or port', () => {
    expect(allowedGoUrl(target)?.href).toBe(target)
    for (const url of ['http://opencode.ai/zen/go/v1/chat/completions', 'https://opencode.ai.evil.com/zen/go/v1/chat/completions',
      'https://user:pass@opencode.ai/zen/go/v1/chat/completions', target + '?key=x', target + '#x',
      'https://127.0.0.1/chat/completions', 'https://opencode.ai:999/zen/go/v1/chat/completions']) {
      expect(allowedGoUrl(url)).toBeNull()
    }
  })
  it('passes identity, session, JSON and upstream success', async () => {
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
      'User-Agent': '3d-layout/0.1.0', 'x-opencode-session': 'conversation-123',
      Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
    })
    expect(seen?.body.toString()).toBe('{"model":"mimo-v2.5"}')
  })
  it('rejects foreign origins, arbitrary targets and malformed JSON before forwarding', async () => {
    let calls = 0
    options = { transport: async () => { calls++; return reply(200, ['{}']) } }
    expect((await send({ Origin: 'https://evil.example' })).status).toBe(403)
    expect((await send({ 'x-layout-upstream': 'https://example.com' })).status).toBe(400)
    expect((await send({}, 'invalid')).status).toBe(400)
    expect(calls).toBe(0)
  })
  it('preserves upstream status and removes echoed API keys', async () => {
    options = { transport: async () => reply(429, [`quota exceeded ${key}`]) }
    const result = await send()
    expect(result.status).toBe(429); expect(result.body).toContain('quota exceeded')
    expect(result.body).not.toContain(key)
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
    expect(result.body).toContain('等待 OpenCode Go 响应超过 0.3 秒')
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
        Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
        'x-layout-upstream': target, 'x-opencode-session': 'session-stream',
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
