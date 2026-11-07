/**
 * modelAdapter（W06）单测：用**本地假装 OpenAI 兼容的 SSE 服务**验证真实 wire 协议。
 *
 * 覆盖 SPEC §W06 测试项里不依赖厂商的部分：文本、工具调用、图片确实进请求、
 * 401/429 可读化与脱敏、超时、取消、未配置时不发请求。
 * 真实厂商的"文本+图片+工具+取消"由用户手动验收（见 IMPLEMENTATION-STATUS §7 清单）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LlmSettings } from '../../../agent/llmSettings'
import { createModelAdapter } from '../../adapters/modelAdapter'
import type { ModelRequest } from '../../contracts'

const KEY = 'sk-test-secret-should-never-leak-123456'

// 本套件用本地假上游验证 wire 协议，不走 /api/llm/request 转发，显式声明无转发环境（调用时读取）。
beforeAll(() => { (globalThis as { __LAYOUT_NO_RELAY__?: boolean }).__LAYOUT_NO_RELAY__ = true })
afterAll(() => { delete (globalThis as { __LAYOUT_NO_RELAY__?: boolean }).__LAYOUT_NO_RELAY__ })

function settings(baseURL: string, over: Partial<LlmSettings> = {}): LlmSettings {
  return {
    provider: 'test',
    protocol: 'openai-chat',
    baseURL,
    apiKey: KEY,
    model: 'test-vl-model',
    sendImages: true,
    ...over,
  }
}

interface FakeServer {
  baseURL: string
  close: () => Promise<void>
  bodies: unknown[]
}

async function startServer(handler: (body: Record<string, unknown>, res: ServerResponse) => void): Promise<FakeServer> {
  const bodies: unknown[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 404
      res.end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      bodies.push(body)
      handler(body, res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server address 异常')
  return {
    baseURL: `http://127.0.0.1:${addr.port}`,
    bodies,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function sse(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  purpose: 'executor',
  system: '你是执行器',
  messages: [{ role: 'user', text: '把树挪开' }],
  tools: [{ name: 'scene.get_objects', description: '读对象', schema: { type: 'object', properties: { objectIds: { type: 'array' } } } }],
  timeoutMs: 5_000,
  ...over,
})

describe('modelAdapter：真实 wire 协议', () => {
  it('文本回复：system/messages/model 都按协议发出，返回聚合文本', async () => {
    const srv = await startServer((_body, res) =>
      sse(res, [
        { choices: [{ delta: { content: '已' } }] },
        { choices: [{ delta: { content: '完成' } }] },
      ]),
    )
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const reply = await adapter.complete(request(), new AbortController().signal)
      expect(reply.text).toBe('已完成')
      expect(reply.stopReason).toBe('end')
      expect(reply.toolCalls).toEqual([])

      const body = srv.bodies[0] as Record<string, unknown>
      expect(body.model).toBe('test-vl-model')
      expect(body.stream).toBe(true)
      const messages = body.messages as Array<Record<string, unknown>>
      expect(messages[0]).toEqual({ role: 'system', content: '你是执行器' })
      expect(messages[1]).toEqual({ role: 'user', content: '把树挪开' })
      expect((body.tools as unknown[]).length).toBe(1)
    } finally {
      await srv.close()
    }
  })

  it('工具调用：函数名在线上用下划线版（OpenAI 不允许点号），回包映射回原名', async () => {
    const srv = await startServer((_body, res) =>
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'scene_get_objects', arguments: '{"objectIds":' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '["tree-1","tree-2"]}' } }] } }] },
      ]),
    )
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const reply = await adapter.complete(request(), new AbortController().signal)
      expect(reply.stopReason).toBe('tool_use')
      // 业务侧拿到的仍是原名
      expect(reply.toolCalls).toEqual([{ id: 'call_1', name: 'scene.get_objects', args: { objectIds: ['tree-1', 'tree-2'] } }])
      // 线上发出去的是下划线版
      const body = srv.bodies[0] as { tools: Array<{ function: { name: string } }> }
      expect(body.tools[0].function.name).toBe('scene_get_objects')
    } finally {
      await srv.close()
    }
  })

  it('图片确实进入请求：用户轮 content 变成 text + image_url 数组', async () => {
    const srv = await startServer((_body, res) => sse(res, [{ choices: [{ delta: { content: 'ok' } }] }]))
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      await adapter.complete(
        request({
          purpose: 'partition',
          messages: [
            {
              role: 'user',
              text: '这是鸟瞰图，请分区',
              images: [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }],
            },
          ],
          tools: [],
        }),
        new AbortController().signal,
      )
      const body = srv.bodies[0] as { messages: Array<{ role: string; content: unknown }> }
      const user = body.messages[1]
      expect(user.role).toBe('user')
      expect(Array.isArray(user.content)).toBe(true)
      const parts = user.content as Array<Record<string, unknown>>
      expect(parts[0]).toEqual({ type: 'text', text: '这是鸟瞰图，请分区' })
      expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
    } finally {
      await srv.close()
    }
  })

  it('toolResult 图片确实进入请求：tool 消息后跟一条 user 图文消息', async () => {
    const srv = await startServer((_body, res) => sse(res, [{ choices: [{ delta: { content: 'ok' } }] }]))
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      await adapter.complete(
        request({
          purpose: 'executor',
          messages: [
            { role: 'assistant', text: '', toolCalls: [{ id: 'call-1', name: 'camera.capture', args: {} }] },
            {
              role: 'toolResult',
              callId: 'call-1',
              ok: true,
              content: { id: 'obs-1' },
              images: [{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,BBBB' }],
            },
          ],
          tools: [],
        }),
        new AbortController().signal,
      )
      const body = srv.bodies[0] as { messages: Array<{ role: string; content: unknown }> }
      const roles = body.messages.map(m => m.role)
      expect(roles).toEqual(['system', 'assistant', 'tool', 'user'])
      const user = body.messages[3]
      const parts = user.content as Array<Record<string, unknown>>
      expect(String(parts[0].text)).toContain('工具结果的附图')
      expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } })
    } finally {
      await srv.close()
    }
  })

  it.each([
    { label: '截图后还有几何结果', images: [['AAAA'], []], secondOk: true },
    { label: '多个截图按工具结果顺序附图', images: [['AAAA'], ['BBBB']], secondOk: true },
    { label: '无图片的多个工具结果', images: [[], []], secondOk: true },
    { label: '截图后的工具失败也必须回传', images: [['AAAA'], []], secondOk: false },
  ])('$label：全部工具结果连续回传后才发送图片', async ({ images, secondOk }) => {
    const srv = await startServer((body, res) => {
      // 模拟服务商校验：一批 tool_calls 全部回应前，不能插入 user 图片或下一轮 assistant。
      const pending = new Set<string>()
      const messages = body.messages as Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>
      for (const message of messages) {
        if ((pending.size > 0 && message.role !== 'tool') ||
            (message.role === 'tool' && !pending.delete(message.tool_call_id ?? ''))) {
          res.statusCode = 400
          res.end('insufficient tool messages following tool_calls message')
          return
        }
        for (const call of message.tool_calls ?? []) pending.add(call.id)
      }
      if (pending.size > 0) {
        res.statusCode = 400
        res.end('missing tool results')
        return
      }
      sse(res, [{ choices: [{ delta: { content: 'ok' } }] }])
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const results = [{ id: 'obs-1' }, secondOk ? { status: 'clear' } : { code: 'invalid_arguments' }]
      const reply = await adapter.complete(
        request({
          messages: [
            { role: 'user', text: '检查场景' },
            {
              role: 'assistant', text: '', toolCalls: [
                { id: 'capture-1', name: 'camera.capture', args: {} },
                { id: 'check-1', name: images[1].length > 0 ? 'camera.capture' : 'geometry.check', args: {} },
              ],
            },
            ...results.map((content, i) => ({
              role: 'toolResult' as const,
              callId: i === 0 ? 'capture-1' : 'check-1',
              ok: i === 0 || secondOk,
              content,
              images: images[i].map(data => ({ mediaType: 'image/png' as const, dataUrl: `data:image/png;base64,${data}` })),
            })),
            // 下一轮结果必须独立，不能合并到上一批工具结果中。
            { role: 'assistant', text: '', toolCalls: [{ id: 'read-2', name: 'scene.get_objects', args: {} }] },
            { role: 'toolResult', callId: 'read-2', ok: true, content: { objects: [] } },
          ],
          tools: [],
        }),
        new AbortController().signal,
      )
      expect(reply.text).toBe('ok')
      const body = srv.bodies[0] as { messages: Array<Record<string, unknown>> }
      const urls = images.flat().map(data => `data:image/png;base64,${data}`)
      expect(body.messages.map(m => m.role)).toEqual([
        'system', 'user', 'assistant', 'tool', 'tool', ...(urls.length > 0 ? ['user'] : []), 'assistant', 'tool',
      ])
      expect(body.messages.slice(3, 5)).toEqual([
        { role: 'tool', tool_call_id: 'capture-1', content: JSON.stringify(results[0]) },
        { role: 'tool', tool_call_id: 'check-1', content: JSON.stringify(results[1]) },
      ])
      if (urls.length > 0) {
        const parts = body.messages[5].content as Array<Record<string, unknown>>
        expect(parts.slice(1)).toEqual(urls.map(url => ({ type: 'image_url', image_url: { url } })))
      }
      expect(body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'read-2', content: '{"objects":[]}' })
    } finally {
      await srv.close()
    }
  })

  it('401：错误可读、不可重试，且消息里不出现 API Key', async () => {
    const srv = await startServer((_body, res) => {
      res.statusCode = 401
      res.end(`unauthorized: ${KEY}`)
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const err = await adapter.complete(request(), new AbortController().signal).catch(e => e)
      expect(err.code).toBe('model_protocol_error')
      expect(err.retryable).toBe(false)
      expect(err.message).toContain('鉴权失败')
      expect(err.message).not.toContain(KEY)
    } finally {
      await srv.close()
    }
  })

  it('429：标记为可重试', async () => {
    const srv = await startServer((_body, res) => {
      res.statusCode = 429
      res.end('rate limited')
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const err = await adapter.complete(request(), new AbortController().signal).catch(e => e)
      expect(err.code).toBe('model_protocol_error')
      expect(err.retryable).toBe(true)
    } finally {
      await srv.close()
    }
  })

  it('400 且提到 tools：翻成"不支持函数调用"并带 supportsTools=false', async () => {
    const srv = await startServer((_body, res) => {
      res.statusCode = 400
      res.end('{"error":"tools are not supported for this model"}')
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const err = await adapter.complete(request(), new AbortController().signal).catch(e => e)
      expect(err.code).toBe('model_protocol_error')
      expect(err.message).toContain('不支持函数调用')
      expect(err.details?.supportsTools).toBe(false)
    } finally {
      await srv.close()
    }
  })

  /**
   * 2026-10-22 T14 实测踩到：服务商 400 原文里**只是提到** "tool"
   * （例如 tool_call_id 不合法、tools 数量超限、tool 参数 schema 不合法），
   * 旧实现只要看到 "tool" 字样就一律翻成"该模型不支持函数调用"——误导用户去换模型。
   * 现在只有原文明确表达"不支持"时才翻成能力问题，其余回落到通用分支（带原文）。
   */
  it('400 原文只是提到 tool（并非说不支持）→ 不误判为"不支持函数调用"，原文要能读到', async () => {
    const srv = await startServer((_body, res) => {
      res.statusCode = 400
      res.end('{"error":{"message":"invalid tool_call_id: tool_call_abc"}}')
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const err = await adapter.complete(request(), new AbortController().signal).catch(e => e)
      expect(err.code).toBe('model_protocol_error')
      expect(err.message).not.toContain('不支持函数调用')
      expect(err.details?.supportsTools).toBeUndefined()
      // 原文必须能透出来，否则用户无从判断
      expect(err.message).toContain('tool_call_abc')
    } finally {
      await srv.close()
    }
  })

  it('400 且提到 context length：翻成"超出上下文长度"', async () => {
    const srv = await startServer((_body, res) => {
      res.statusCode = 400
      res.end('{"error":"maximum context length exceeded"}')
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const err = await adapter.complete(request(), new AbortController().signal).catch(e => e)
      expect(err.message).toContain('上下文长度')
      expect(err.details?.contextOverflow).toBe(true)
    } finally {
      await srv.close()
    }
  })

  it('超时 → model_timeout（默认最小 1s，测试给 50ms 也会按 1s 生效）', async () => {
    const srv = await startServer((_body, res) => {
      setTimeout(() => sse(res, [{ choices: [{ delta: { content: 'late' } }] }]), 3_000)
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL), timeoutGraceMs: 0 })
      const start = Date.now()
      const err = await adapter.complete(request({ timeoutMs: 50 }), new AbortController().signal).catch(e => e)
      expect(err.code).toBe('model_timeout')
      // 超时（最小 1s）必须早于服务端 3s 后的响应；上界留足余量，避免 CPU 忙时定时器抖动误报
      expect(Date.now() - start).toBeLessThan(2_900)
    } finally {
      await srv.close()
    }
  }, 10_000)

  it('取消 → cancelled（不是超时、不是协议错误）', async () => {
    const srv = await startServer((_body, res) => {
      setTimeout(() => sse(res, [{ choices: [{ delta: { content: 'late' } }] }]), 2_000)
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL) })
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 50)
      const err = await adapter.complete(request({ timeoutMs: 5_000 }), ac.signal).catch(e => e)
      expect(err.code).toBe('cancelled')
    } finally {
      await srv.close()
    }
  })

  it('未配置：直接报模型未配置，不发任何请求', async () => {
    let hit = 0
    const srv = await startServer((_body, res) => {
      hit++
      sse(res, [])
    })
    try {
      const adapter = createModelAdapter({ getSettings: () => settings(srv.baseURL, { apiKey: '' }) })
      const err = await adapter.complete(request(), new AbortController().signal).catch(e => e)
      expect(err.code).toBe('model_protocol_error')
      expect(err.message).toContain('未配置模型')
      expect(hit).toBe(0)
    } finally {
      await srv.close()
    }
  })
})
