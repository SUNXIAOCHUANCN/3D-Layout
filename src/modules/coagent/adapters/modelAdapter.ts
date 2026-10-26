/**
 * modelAdapter（W06）——把 CoAgent 的 `ModelPort` 接到宿主现有的 `llmChat`。
 *
 * 选型（用户确认）：**OpenAI 兼容协议 + 单一多模态模型**。宿主 `llmClient` 已实现
 * openai-chat / openai-response / anthropic 三种 wire，这里只做"契约翻译 + 错误翻译"：
 *
 * - `ModelRequest.system/messages/tools` → `LlmChatOptions.system/turns/tools`；
 * - 图像（W06 新增）：`ModelMessage.images` → 用户轮附图，三个协议各自映射；
 * - 错误：401/403 → 密钥问题、429 → 可重试、超时 → `model_timeout`、
 *   取消 → `cancelled`，且**任何错误消息都不允许包含 apiKey**（脱敏后才抛出）；
 * - 未配置（无 key/model）直接 `model_protocol_error`，不偷偷发请求。
 *
 * 密钥来源：宿主 `llmSettings`（localStorage，浏览器本地）；本文件不改、不记、不导出。
 */

import { llmChat, type LlmChatOptions, type LlmChatResult, type LlmTurn } from '../../agent/llmClient'
import { useLlmSettingsStore, type LlmSettings } from '../../agent/llmSettings'
import type { ModelMessage, ModelPort, ModelReply, ModelRequest } from '../contracts'
import { CoAgentError } from '../contracts'

export interface ModelAdapterOptions {
  /** 设置快照来源（默认读宿主 store；测试可注入固定设置） */
  getSettings?: () => LlmSettings
  /** 注入底层实现（测试用本地 SSE 服务时走同一路径，无需替换） */
  chat?: (opts: LlmChatOptions) => Promise<LlmChatResult>
  /** 超时宽限（毫秒）：给流式收尾留一点余量 */
  timeoutGraceMs?: number
}

export function currentLlmSettings(): LlmSettings {
  return useLlmSettingsStore.getState()
}

/** 是否已配置到"可以发请求"的程度（不含在线校验） */
export function isModelConfigured(s: LlmSettings = currentLlmSettings()): boolean {
  return s.apiKey.trim().length > 0 && s.model.trim().length > 0 && s.baseURL.trim().length > 0
}

/** 脱敏摘要：只给 provider/model/baseURL 的 host，绝不返回 key */
export function modelConfigSummary(s: LlmSettings = currentLlmSettings()): string {
  let host = s.baseURL
  try {
    host = new URL(s.baseURL).host
  } catch {
    /* 保留原文（如相对路径代理） */
  }
  return `${s.provider} / ${s.protocol} / ${s.model} @ ${host}`
}

/** 把模型消息翻成 llmClient 的 turns；system 单独抽出 */
export function toTurns(messages: ModelMessage[]): { system: string[]; turns: LlmTurn[] } {
  const system: string[] = []
  const turns: LlmTurn[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.text)
    } else if (m.role === 'user') {
      turns.push({
        role: 'user',
        text: m.text,
        ...(m.images && m.images.length > 0 ? { images: m.images.map(i => ({ dataUrl: i.dataUrl })) } : {}),
      })
    } else if (m.role === 'assistant') {
      turns.push({
        role: 'assistant',
        text: m.text,
        toolCalls: m.toolCalls.map(c => ({ id: c.id, name: c.name, args: c.args })),
      })
    } else {
      const result = {
        callId: m.callId,
        ok: m.ok,
        content: m.content,
        ...(m.images && m.images.length > 0 ? { images: m.images.map(i => ({ dataUrl: i.dataUrl })) } : {}),
      }
      // 同一轮的工具结果必须连续回传；llmClient 会在整个回合后统一追加附图。
      // 逐条建回合会让截图的 user 图片消息插到尚未回应的 tool_calls 中间，触发 HTTP 400。
      const previous = turns[turns.length - 1]
      if (previous?.role === 'toolResults') previous.results.push(result)
      else turns.push({ role: 'toolResults', results: [result] })
    }
  }
  return { system, turns }
}

function sanitize(message: string, apiKey: string): string {
  const key = apiKey.trim()
  if (key.length < 8) return message
  return message.split(key).join('***')
}

/** 把宿主/网络错误翻成 §4.3 的错误码，并保证消息可读、无密钥 */
export function mapModelError(e: unknown, settings: LlmSettings, timedOut: boolean): CoAgentError {
  if (e instanceof CoAgentError) return e
  if (timedOut) return new CoAgentError('model_timeout', '模型请求超时（已按配置中断）', { cause: e })
  if (e instanceof Error && e.name === 'AbortError') return new CoAgentError('cancelled', '模型请求已取消', { cause: e })
  const raw = sanitize(e instanceof Error ? e.message : String(e), settings.apiKey)
  const m = /HTTP\s+(\d{3})/.exec(raw)
  if (m) {
    const status = Number(m[1])
    if (status === 401 || status === 403) {
      return new CoAgentError('model_protocol_error', `模型鉴权失败（HTTP ${status}）：请检查 API Key 与模型权限`, {
        retryable: false,
        details: { status },
        cause: e,
      })
    }
    if (status === 429) {
      return new CoAgentError('model_protocol_error', '模型限流（HTTP 429）：请稍后重试或降低请求频率', {
        retryable: true,
        details: { status },
        cause: e,
      })
    }
    if (status === 400 || status === 422) {
      // 两个最常见的"接口能力不匹配"：不支持 tools / 上下文超长。
      // 把服务商原文翻成可操作的建议，避免用户只看到 HTTP 400。
      // 注意：原文里出现 "tool" 字样**不等于**不支持 tools——服务商可能只是在
      // 描述参数（比如 tool_call_id、tools 数量超限、tool 参数 schema 不合法）。
      // 因此只有原文明确说"不支持/不支持 tools/function calling not supported"时才翻成能力问题，
      // 其余 400 一律回落到通用分支，把原文带给用户。
      if (/not\s+support|does\s+not\s+support|unsupported|不支持|不支持函数/i.test(raw) && /tool|function[_ ]?call/i.test(raw)) {
        return new CoAgentError(
          'model_protocol_error',
          '该模型/接口不支持函数调用（tools）：请在「AI 编辑 → 设置」里换一个支持 function calling 的模型',
          { retryable: false, details: { status, supportsTools: false, raw: raw.slice(0, 300) }, cause: e },
        )
      }
      if (/context|length|too many tokens|maximum token|上下文/i.test(raw)) {
        return new CoAgentError(
          'model_protocol_error',
          '请求超出模型上下文长度：请减小场景规模（少选资产）或换更大上下文的模型',
          { retryable: false, details: { status, contextOverflow: true, raw: raw.slice(0, 300) }, cause: e },
        )
      }
    }
    return new CoAgentError('model_protocol_error', `模型服务返回 HTTP ${status}：${raw.slice(0, 200)}`, {
      details: { status },
      cause: e,
    })
  }
  if (raw.includes('网络请求失败')) {
    return new CoAgentError('model_protocol_error', `${raw}（密钥不会出现在日志里）`, { cause: e })
  }
  return new CoAgentError('model_protocol_error', raw.slice(0, 300), { cause: e })
}

export function createModelAdapter(opts: ModelAdapterOptions = {}): ModelPort {
  const getSettings = opts.getSettings ?? currentLlmSettings
  const chat = opts.chat ?? llmChat
  const grace = opts.timeoutGraceMs ?? 2_000

  return {
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
      const settings = getSettings()
      if (!isModelConfigured(settings)) {
        throw new CoAgentError(
          'model_protocol_error',
          '未配置模型：请在「AI 编辑 → 设置」里填写 baseURL / API Key / 模型名（密钥只存在本浏览器）',
        )
      }
      if (signal.aborted) throw new CoAgentError('cancelled', '模型请求开始前已取消')

      const { system, turns } = toTurns(request.messages)
      /**
       * OpenAI 的函数名规范是 `^[a-zA-Z0-9_-]{1,64}$`——**不允许点号**。
       * 我们的工具名是 `scene.get_objects` 这种命名，直连 OpenAI 兼容端点会 400
       * （分区请求不带 tools 所以看起来"模型是好的"）。这里发出去用下划线版，
       * 回包再映射回原名，业务侧完全无感。
       */
      const wireName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
      const nameMap = new Map<string, string>(request.tools.map(t => [wireName(t.name), t.name]))
      const controller = new AbortController()
      let timedOut = false
      const onAbort = (): void => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, Math.max(1_000, request.timeoutMs + grace))

      try {
        const result = await chat({
          settings,
          system: [request.system, ...system].filter(s => s.length > 0).join('\n\n'),
          turns,
          tools: request.tools.map(t => ({ name: wireName(t.name), description: t.description, schema: t.schema })),
          signal: controller.signal,
          onEvent: () => undefined, // MVP 不消费增量；进度投影需要时再接线
        })
        return {
          stopReason: result.stopReason,
          text: result.text,
          // 回包里的函数名是下划线版，映射回业务工具名（找不到就原样返回）
          toolCalls: result.toolCalls.map(c => ({ id: c.id, name: nameMap.get(c.name) ?? c.name, args: c.args })),
        }
      } catch (e) {
        throw mapModelError(e, settings, timedOut)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
