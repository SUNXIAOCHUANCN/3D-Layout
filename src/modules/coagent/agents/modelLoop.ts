/**
 * modelLoop（W05）——"模型说 → 工具做 → 结果回灌"的最小循环。
 *
 * 三条边界（§3.4/§5.2）：
 * 1. 工具集按角色给（registry.specs(role)），judge 的主循环里根本看不到写工具；
 * 2. 每一轮都检查 AbortSignal（取消要能打断等待中的工具/后续模型请求）；
 * 3. 轮次与工具预算都是硬上限（budget_exceeded），不靠模型自觉收尾。
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
  /** 模型-工具往返的最大轮次（防止脚本/模型死循环） */
  maxRounds: number
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

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const transcript: ModelMessage[] = [...input.messages]
  const toolResults: Array<{ call: ModelToolCall; result: ToolResult<unknown> }> = []
  let toolCallCount = 0
  // 工具清单按角色过滤：judge 根本看不到写工具（这里也把清单记进日志，便于核对"角色权限没给错"）
  const specs = input.registry.specs(input.role)
  logStage(
    'llm.loop',
    `${input.purpose} 工具循环开始（role=${input.role}，最多 ${input.maxRounds} 轮，初始消息 ${transcript.length} 条）`,
    `可用工具：${specs.length > 0 ? specs.map(s => s.name).join(', ') : '（无，纯文本回合）'}`,
  )

  for (let round = 0; round < input.maxRounds; round++) {
    if (input.signal.aborted) throw new CoAgentError('cancelled', '模型循环被取消')
    logStage('llm.round', `${input.purpose} 第 ${round + 1}/${input.maxRounds} 轮（transcript ${transcript.length} 条）`)
    const reply = await input.model.complete(
      {
        purpose: input.purpose,
        system: input.system,
        messages: transcript,
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

  logError('llm.loop', `${input.purpose} 超过 ${input.maxRounds} 轮仍未收尾（budget_exceeded）`, `已用工具调用 ${toolCallCount} 次`)
  throw new CoAgentError('budget_exceeded', `模型-工具往返超过 ${input.maxRounds} 轮仍未收尾`)
}
