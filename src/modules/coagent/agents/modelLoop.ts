/**
 * modelLoop（W05）——"模型说 → 工具做 → 结果回灌"的最小循环。
 *
 * 三条边界（§3.4/§5.2）：
 * 1. 工具集按角色给（registry.specs(role)），judge 的主循环里根本看不到写工具；
 * 2. 每一轮都检查 AbortSignal（取消要能打断等待中的工具/后续模型请求）；
 * 3. 显式指定的轮次上限与工具预算仍然有效；不限轮数时保留取消与超时机制。
 *
 * 这里不做"对话记忆压缩"：W05 的上下文是任务级的小数据，压缩属 W07 的预算问题。
 */

import type {
  AgentRole,
  CoAgentConfig,
  ModelImage,
  ModelMessage,
  ModelPort,
  ModelReply,
  ModelToolCall,
  ToolResult,
} from '../contracts'
import { CoAgentError } from '../contracts'
import type { ToolRegistry } from '../tools/registry'
import { activeRunLog, logError, logStage } from '../runtime/runLog'

export interface ToolLoopInput {
  role: AgentRole
  purpose: string
  system: string
  messages: ModelMessage[]
  model: ModelPort
  registry: ToolRegistry
  site: { runId: string; taskId: string | null; regionId: string | null }
  signal: AbortSignal
  config: CoAgentConfig
  /** 模型-工具往返的最大轮次；省略时不限轮数 */
  maxRounds?: number
  onToolResult?: (call: ModelToolCall, result: ToolResult<unknown>) => void
  /**
   * W08.2：把真实工具结果对应的证据图附到 toolResult 消息上（如 camera.capture）。
   * 不返回图片就是纯文本结果，不造假图。
   */
  imagesForToolResult?: (call: ModelToolCall, result: ToolResult<unknown>) => Promise<ModelImage[]>
}

export interface ToolLoopResult {
  text: string
  transcript: ModelMessage[]
  toolCalls: number
  toolResults: Array<{ call: ModelToolCall; result: ToolResult<unknown> }>
  stopReason: ModelReply['stopReason']
}

/**
 * 把发给模型的 transcript 裁成"有界最新证据窗口"。
 *
 * 为什么需要：旧实现只在**产生图片时**限流（executor 里前 2 张），
 * 一旦图进了 transcript，之后每一轮都会重发——模型看到的永远是**最早**两张，
 * 后拍的新图反而进不去（样本日志"两次判定都不能辨认新增房屋"的直接原因）。
 *
 * 这里改成每轮请求重建窗口：保留最新 max 张，旧图只去掉图片、保留文字与 callId，
 * 不破坏 tool call / toolResult 的配对。
 */
export function boundImages(messages: ModelMessage[], max: number): ModelMessage[] {
  const out = [...messages]
  if (max <= 0) {
    return out.map(m => (m.role === 'toolResult' && m.images ? { ...m, images: undefined } : m))
  }
  let budget = max
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role !== 'toolResult') continue
    if (!m.images || m.images.length === 0) continue
    if (budget >= m.images.length) {
      budget -= m.images.length
      continue
    }
    // 超出窗口：整条去图（不截半张，避免"给了图但不知道是哪一张"）
    out[i] = { ...m, images: undefined }
  }
  return out
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const transcript: ModelMessage[] = [...input.messages]
  const toolResults: Array<{ call: ModelToolCall; result: ToolResult<unknown> }> = []
  let toolCallCount = 0
  const maxRounds = input.maxRounds ?? Infinity
  const roundLimit = Number.isFinite(maxRounds) ? `最多 ${maxRounds} 轮` : '不限轮数'
  // 工具清单按角色过滤：judge 根本看不到写工具（这里也把清单记进日志，便于核对"角色权限没给错"）
  const specs = input.registry.specs(input.role)
  logStage(
    'llm.loop',
    `${input.purpose} 工具循环开始（role=${input.role}，${roundLimit}，初始消息 ${transcript.length} 条）`,
    `可用工具：${specs.length > 0 ? specs.map(s => s.name).join(', ') : '（无，纯文本回合）'}`,
  )

  for (let round = 0; round < maxRounds; round++) {
    if (input.signal.aborted) throw new CoAgentError('cancelled', '模型循环被取消')
    const roundLabel = Number.isFinite(maxRounds) ? `第 ${round + 1}/${maxRounds} 轮` : `第 ${round + 1} 轮（不限轮数）`
    logStage('llm.round', `${input.purpose} ${roundLabel}（transcript ${transcript.length} 条）`)
    const reply = await input.model.complete(
      {
        purpose: input.purpose,
        system: input.system,
        // P2：每轮重建"最新 N 张"的图片窗口，而不是让 transcript 无限累积旧图
        messages: boundImages(transcript, input.config.maxImagesPerRequest),
        tools: specs,
        timeoutMs: input.config.modelTimeoutMs,
      },
      input.signal,
    )

    if (reply.toolCalls.length === 0) {
      logStage(
        'llm.loop',
        `${input.purpose} 收尾：共 ${toolCallCount} 次工具调用，stop=${reply.stopReason}，最终文本 ${reply.text.length} 字符`,
      )
      return { text: reply.text, transcript, toolCalls: toolCallCount, toolResults, stopReason: reply.stopReason }
    }

    transcript.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls })

    for (const call of reply.toolCalls) {
      if (input.signal.aborted) throw new CoAgentError('cancelled', '工具执行前被取消')
      toolCallCount++
      const callStartedAt = Date.now()
      const result = await input.registry.call(call.name, call.args, {
        runId: input.site.runId,
        taskId: input.site.taskId,
        regionId: input.site.regionId,
        role: input.role,
        toolCallId: call.id,
      })
      activeRunLog()?.toolCall(call, result, Date.now() - callStartedAt)
      toolResults.push({ call, result })
      input.onToolResult?.(call, result)
      const images = input.imagesForToolResult ? await input.imagesForToolResult(call, result) : []
      transcript.push({
        role: 'toolResult',
        callId: call.id,
        ok: result.ok,
        content: result.ok ? result.data : result.error,
        ...(images.length > 0 ? { images } : {}),
      })
    }
  }

  logError('llm.loop', `${input.purpose} 超过 ${maxRounds} 轮仍未收尾（budget_exceeded）`, `已用工具调用 ${toolCallCount} 次`)
  throw new CoAgentError('budget_exceeded', `模型-工具往返超过 ${maxRounds} 轮仍未收尾`)
}
