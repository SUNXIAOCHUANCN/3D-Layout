import { requestLlm, joinLlmUrl as joinUrl, newLlmSession, redactLlmError } from '../llm-shared/request'
import { runLog } from './runLog'
import type { LlmSettings } from '../agent/llmSettings'

/**
 * LLM 流式客户端 —— 三种 wire 协议适配到统一接口：
 *   openai-chat      POST {base}/chat/completions（OpenAI 兼容面最广）
 *   openai-response  POST {base}/responses（OpenAI 新一代接口）
 *   anthropic        POST {base}/v1/messages（Claude 系，浏览器直连需专用头）
 * 统一产出：文本增量流式回调 + 完整工具调用列表（参数已 JSON.parse）。
 * 共享请求层：OpenCode Go 经本地服务转发，其他厂商保持浏览器直连。
 */

// ---------- 统一对话格式 ----------

export interface ToolCallOut {
  id: string
  name: string
  args: Record<string, unknown>
}

/** 工具结果附图（如 viewport.screenshot 的 PNG dataURL） */
export interface LlmResultImage {
  dataUrl: string
}

export type LlmTurn =
  | { role: 'user'; text: string; /** W06：用户轮附图（如鸟瞰分区图）；不造"无主工具结果" */ images?: LlmResultImage[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCallOut[] }
  | {
      role: 'toolResults'
      results: Array<{ callId: string; ok: boolean; content: unknown; images?: LlmResultImage[] }>
    }

export interface LlmToolSpec {
  name: string
  description: string
  schema: Record<string, unknown>
}

export type LlmStreamEvent = { type: 'text'; delta: string }

export type LlmStopReason = 'end' | 'tool_use' | 'max_tokens'

export interface LlmChatResult {
  stopReason: LlmStopReason
  text: string
  toolCalls: ToolCallOut[]
}

export interface LlmChatOptions {
  settings: LlmSettings
  sessionId?: string
  system: string
  turns: LlmTurn[]
  tools: LlmToolSpec[]
  signal: AbortSignal
  /** 文本增量（工具调用不增量，流结束时整体给出） */
  onEvent: (ev: LlmStreamEvent) => void
}

// ---------- 基础设施 ----------

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** dataURL → Anthropic base64 源块所需的两段（media_type + 纯 base64） */
function dataUrlParts(dataUrl: string): { mediaType: string; data: string } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  return m ? { mediaType: m[1], data: m[2] } : { mediaType: 'image/png', data: '' }
}

/** 收集一个 toolResults 回合里的附图 dataUrl（仅成功结果携带） */
function collectImages(results: Array<{ callId: string; ok: boolean; images?: LlmResultImage[] }>): string[] {
  const urls: string[] = []
  for (const r of results) {
    if (r.ok) for (const im of r.images ?? []) urls.push(im.dataUrl)
  }
  return urls
}

async function postSse(
  settings: LlmSettings,
  url: string,
  body: unknown,
  signal: AbortSignal,
  sessionId?: string,
): Promise<Response> {
  // Summarize the serialized request without storing image bytes or credentials.
  const serialized = JSON.stringify(body)
  const imageCount = [...serialized.matchAll(/"type":"(?:image_url|input_image|image)"/g)].length
  runLog.event('api.request_prepared', { protocol: settings.protocol, imageCount, characters: serialized.length })
  const res = await requestLlm(settings, url, serialized, signal, sessionId)
  if (!res.body) throw new Error('模型服务返回空响应')
  return res
}

/** 逐帧解析 SSE：只认 data: 行（Anthropic 的 event: 行信息在 data JSON 里也有） */
async function readSse(res: Response, onData: (obj: Record<string, unknown>) => void): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(payload) as Record<string, unknown>
      } catch {
        continue // 忽略坏帧
      }
      onData(obj)
    }
  }
}

// ---------- 入口 ----------

export async function llmChat(opts: LlmChatOptions): Promise<LlmChatResult> {
  switch (opts.settings.protocol) {
    case 'openai-chat':
      return openaiChat(opts)
    case 'openai-response':
      return openaiResponse(opts)
    case 'anthropic':
      return anthropicMessages(opts)
  }
}

// ---------- OpenAI Chat Completions ----------

async function openaiChat(o: LlmChatOptions): Promise<LlmChatResult> {
  const messages: unknown[] = [{ role: 'system', content: o.system }]
  for (const t of o.turns) {
    if (t.role === 'user') {
      const imgs = t.images ?? []
      messages.push(
        imgs.length === 0
          ? { role: 'user', content: t.text }
          : {
              role: 'user',
              content: [
                { type: 'text', text: t.text },
                ...imgs.map(im => ({ type: 'image_url', image_url: { url: im.dataUrl } })),
              ],
            },
      )
    } else if (t.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: t.text || null }
      if (t.toolCalls.length > 0) {
        msg.tool_calls = t.toolCalls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }))
      }
      messages.push(msg)
    } else {
      for (const r of t.results) {
        messages.push({ role: 'tool', tool_call_id: r.callId, content: JSON.stringify(r.content) })
      }
      // 工具消息装不下图：紧跟一条 user 图文消息回传附图（OpenAI 推荐的折中做法）
      const images = collectImages(t.results)
      if (images.length > 0) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: '（以上工具结果的附图，按产生顺序；图像坐标左上原点）' },
            ...images.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        })
      }
    }
  }
  const body = {
    model: o.settings.model,
    stream: true,
    messages,
    ...(o.tools.length > 0
      ? {
          tools: o.tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.schema },
          })),
          tool_choice: 'auto',
        }
      : {}),
  }
  const res = await postSse(o.settings, joinUrl(o.settings.baseURL, '/chat/completions'), body, o.signal, o.sessionId)

  let text = ''
  const acc = new Map<number, { id: string; name: string; args: string }>()
  interface ChatChoice {
    delta?: {
      content?: string | null
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
  }
  await readSse(res, data => {
    const choice = (data.choices as ChatChoice[] | undefined)?.[0]
    if (!choice?.delta) return
    if (typeof choice.delta.content === 'string' && choice.delta.content) {
      text += choice.delta.content
      o.onEvent({ type: 'text', delta: choice.delta.content })
    }
    for (const tc of choice.delta.tool_calls ?? []) {
      const a = acc.get(tc.index) ?? { id: '', name: '', args: '' }
      if (tc.id) a.id = tc.id
      if (tc.function?.name) a.name += tc.function.name
      if (tc.function?.arguments) a.args += tc.function.arguments
      acc.set(tc.index, a)
    }
  })
  const toolCalls = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, a], i) => ({
      id: a.id || `call_${i}`,
      name: a.name,
      args: parseArgs(a.args),
    }))
  return { stopReason: toolCalls.length > 0 ? 'tool_use' : 'end', text, toolCalls }
}

// ---------- OpenAI Responses ----------

async function openaiResponse(o: LlmChatOptions): Promise<LlmChatResult> {
  const input: unknown[] = []
  for (const t of o.turns) {
    if (t.role === 'user') {
      const imgs = t.images ?? []
      input.push(
        imgs.length === 0
          ? { role: 'user', content: t.text }
          : {
              role: 'user',
              content: [
                { type: 'input_text', text: t.text },
                ...imgs.map(im => ({ type: 'input_image', image_url: im.dataUrl })),
              ],
            },
      )
    } else if (t.role === 'assistant') {
      if (t.text) input.push({ role: 'assistant', content: t.text })
      for (const c of t.toolCalls) {
        input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })
      }
    } else {
      for (const r of t.results) {
        input.push({ type: 'function_call_output', call_id: r.callId, output: JSON.stringify(r.content) })
      }
      // function_call_output 装不下图：紧跟一条 user 图文消息回传附图
      const images = collectImages(t.results)
      if (images.length > 0) {
        input.push({
          role: 'user',
          content: [
            { type: 'input_text', text: '（以上工具结果的附图，按产生顺序；图像坐标左上原点）' },
            ...images.map(url => ({ type: 'input_image', image_url: url })),
          ],
        })
      }
    }
  }
  const body = {
    model: o.settings.model,
    stream: true,
    instructions: o.system,
    input,
    ...(o.tools.length > 0
      ? {
          // 注意：Responses API 的工具定义是扁平结构（无 function 包装层）
          tools: o.tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.schema,
          })),
          tool_choice: 'auto',
        }
      : {}),
  }
  const res = await postSse(o.settings, joinUrl(o.settings.baseURL, '/responses'), body, o.signal, o.sessionId)

  let text = ''
  let incomplete = false
  const toolCalls: ToolCallOut[] = []
  interface RespItem {
    type?: string
    call_id?: string
    id?: string
    name?: string
    arguments?: string
  }
  await readSse(res, data => {
    const type = data.type as string | undefined
    if (type === 'response.output_text.delta' && typeof data.delta === 'string') {
      text += data.delta
      o.onEvent({ type: 'text', delta: data.delta })
    } else if (type === 'response.output_item.done') {
      const item = data.item as RespItem | undefined
      if (item?.type === 'function_call') {
        toolCalls.push({
          id: String(item.call_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          args: parseArgs(typeof item.arguments === 'string' ? item.arguments : '{}'),
        })
      }
    } else if (type === 'response.incomplete') {
      incomplete = true
    }
  })
  const stopReason: LlmStopReason = incomplete ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : 'end'
  return { stopReason, text, toolCalls }
}

// ---------- Anthropic Messages ----------

type CurBlock = { kind: 'text' } | { kind: 'tool'; id: string; name: string; json: string }

async function anthropicMessages(o: LlmChatOptions): Promise<LlmChatResult> {
  const messages: unknown[] = []
  for (const t of o.turns) {
    if (t.role === 'user') {
      const imgs = t.images ?? []
      messages.push(
        imgs.length === 0
          ? { role: 'user', content: t.text }
          : {
              role: 'user',
              content: [
                { type: 'text', text: t.text },
                ...imgs.map(im => {
                  const { mediaType, data } = dataUrlParts(im.dataUrl)
                  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
                }),
              ],
            },
      )
    } else if (t.role === 'assistant') {
      const content: unknown[] = []
      if (t.text) content.push({ type: 'text', text: t.text })
      for (const c of t.toolCalls) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args })
      }
      if (content.length === 0) content.push({ type: 'text', text: '' })
      messages.push({ role: 'assistant', content })
    } else {
      messages.push({
        role: 'user',
        content: t.results.map(r => {
          const images = r.ok ? (r.images ?? []) : []
          if (images.length === 0) {
            return {
              type: 'tool_result',
              tool_use_id: r.callId,
              content: JSON.stringify(r.content),
              is_error: !r.ok,
            }
          }
          // Anthropic 原生支持在 tool_result 里内联 image block（图像与调用一一对应）
          return {
            type: 'tool_result',
            tool_use_id: r.callId,
            is_error: !r.ok,
            content: [
              { type: 'text', text: JSON.stringify(r.content) },
              ...images.map(im => {
                const { mediaType, data } = dataUrlParts(im.dataUrl)
                return { type: 'image', source: { type: 'base64', media_type: mediaType, data } }
              }),
            ],
          }
        }),
      })
    }
  }
  const body = {
    model: o.settings.model,
    stream: true,
    max_tokens: 4096,
    system: o.system,
    messages,
    ...(o.tools.length > 0
      ? {
          tools: o.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })),
        }
      : {}),
  }
  const res = await postSse(o.settings, joinUrl(o.settings.baseURL, '/v1/messages'), body, o.signal, o.sessionId)

  let text = ''
  let stopReason: LlmStopReason = 'end'
  const doneBlocks: CurBlock[] = []
  let cur: CurBlock | null = null
  interface AnthropicDelta {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: string
  }
  await readSse(res, data => {
    switch (data.type as string | undefined) {
      case 'content_block_start': {
        const block = data.content_block as { type?: string; id?: string; name?: string } | undefined
        cur =
          block?.type === 'tool_use'
            ? { kind: 'tool', id: block.id ?? '', name: block.name ?? '', json: '' }
            : { kind: 'text' }
        break
      }
      case 'content_block_delta': {
        const d = data.delta as AnthropicDelta | undefined
        if (d?.type === 'text_delta' && d.text) {
          text += d.text
          o.onEvent({ type: 'text', delta: d.text })
        } else if (d?.type === 'input_json_delta' && cur?.kind === 'tool' && d.partial_json) {
          cur.json += d.partial_json
        }
        break
      }
      case 'content_block_stop':
        if (cur) doneBlocks.push(cur)
        cur = null
        break
      case 'message_delta': {
        const d = data.delta as AnthropicDelta | undefined
        if (d?.stop_reason === 'tool_use') stopReason = 'tool_use'
        else if (d?.stop_reason === 'max_tokens') stopReason = 'max_tokens'
        break
      }
      case 'error': {
        const err = data.error as { message?: string } | undefined
        throw new Error(err?.message ?? 'Anthropic 流式返回错误')
      }
    }
  })
  if (cur) doneBlocks.push(cur) // 容错：个别实现缺 content_block_stop
  const toolCalls: ToolCallOut[] = doneBlocks
    .filter((b): b is Extract<CurBlock, { kind: 'tool' }> => b.kind === 'tool')
    .map(b => ({ id: b.id, name: b.name, args: parseArgs(b.json) }))
  return { stopReason, text, toolCalls }
}

// ---------- 测试连接（非流式最小请求） ----------

export async function testLlmConnection(
  s: LlmSettings,
): Promise<{ ok: boolean; message: string }> {
  const ac = new AbortController()
  const timer = window.setTimeout(() => ac.abort(), 20_000)
  try {
    let url: string
    let body: Record<string, unknown>
    let pick: (j: Record<string, unknown>) => string
    if (s.protocol === 'anthropic') {
      url = joinUrl(s.baseURL, '/v1/messages')
      body = { model: s.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }
      pick = j => String((j.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '')
    } else if (s.protocol === 'openai-response') {
      url = joinUrl(s.baseURL, '/responses')
      body = { model: s.model, input: 'ping' }
      pick = j => String(j.output_text ?? '')
    } else {
      url = joinUrl(s.baseURL, '/chat/completions')
      body = { model: s.model, messages: [{ role: 'user', content: 'ping' }] }
      pick = j =>
        String(
          (j.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content ?? '',
        )
    }
    const res = await requestLlm(s, url, JSON.stringify(body), ac.signal, newLlmSession())
    const j = (await res.json()) as Record<string, unknown>
    const reply = j ? pick(j).slice(0, 60) : ''
    return { ok: true, message: reply ? `连接成功，模型回复：${reply}` : '连接成功' }
  } catch (error) {
    return { ok: false, message: ac.signal.aborted ? '连接测试超时（20 秒），请检查网络或稍后重试'
      : redactLlmError(error instanceof Error ? error.message : String(error), s.apiKey) }
  } finally {
    window.clearTimeout(timer)
  }
}
