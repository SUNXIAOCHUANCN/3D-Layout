/**
 * DirectorModel（W05）——按"用途 + 第几次调用"编排回复的假模型。
 *
 * 为什么不用队尾脚本（FakeModel）：W05 的 judge 回复必须引用**运行时才知道**的
 * observation id（判据证据），静态队列写不出来。Director 让测试注册一个
 * `(request, index) => ModelReply` 函数，在里面读取 judge 提示词里给出的证据 id。
 *
 * 未注册用途直接抛 model_protocol_error（测试漏写脚本要立刻炸，而不是静默通过）。
 */

import type { ModelReply, ModelRequest, ModelToolCall } from '../../contracts'
import { CoAgentError } from '../../contracts'

export type DirectorHandler = (request: ModelRequest, index: number) => ModelReply

export interface DirectorModel {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>
  on(purpose: string, handler: DirectorHandler): void
  readonly requests: ModelRequest[]
  count(purpose: string): number
}

export function createDirectorModel(): DirectorModel {
  const handlers = new Map<string, DirectorHandler>()
  const counters = new Map<string, number>()
  const requests: ModelRequest[] = []

  return {
    async complete(request, signal) {
      if (signal.aborted) throw new CoAgentError('cancelled', '模型请求被取消')
      requests.push(structuredClone(request))
      const handler = handlers.get(request.purpose)
      if (!handler) {
        throw new CoAgentError('model_protocol_error', `Director 没有为 purpose=${request.purpose} 注册回复`)
      }
      const index = counters.get(request.purpose) ?? 0
      counters.set(request.purpose, index + 1)
      return structuredClone(handler(request, index))
    },
    on(purpose, handler) {
      handlers.set(purpose, handler)
    },
    get requests() {
      return requests
    },
    count: purpose => counters.get(purpose) ?? 0,
  }
}

const call = (name: string, args: Record<string, unknown>, id: string): ModelToolCall => ({ id, name, args })

export function textReply(text: string): ModelReply {
  return { stopReason: 'end', text, toolCalls: [] }
}

export function jsonReply(value: unknown): ModelReply {
  return textReply(JSON.stringify(value))
}

export function toolReply(text: string, calls: Array<{ name: string; args: Record<string, unknown>; id: string }>): ModelReply {
  return { stopReason: 'tool_use', text, toolCalls: calls.map(c => call(c.name, c.args, c.id)) }
}

/** 从 judge 提示词里取本轮证据 id（测试据此构造合法 Verdict） */
export function evidenceIdsFromPrompt(request: ModelRequest): { baselineId: string; afterId: string } {
  const text = request.messages
    .filter(m => m.role === 'user')
    .map(m => (m as { text: string }).text)
    .join('\n')
  const m = text.match(/baseline=(obs-[\w-]+)[，,]\s*after=(obs-[\w-]+)/)
  if (!m) throw new Error('judge 提示词里没有证据 id（测试断言失效）')
  return { baselineId: m[1], afterId: m[2] }
}

/** 构造 Verdict 回复：status 由参数决定，evidence 默认引用本轮真实证据 */
export function verdictReply(input: {
  taskId: string
  criteria: string[]
  status: 'pass' | 'fail' | 'uncertain'
  evidenceIds: string[]
  repairSuggestions?: string[]
}): ModelReply {
  return jsonReply({
    schemaVersion: 1,
    taskId: input.taskId,
    status: input.status,
    criteria: input.criteria.map(id => ({
      criterionId: id,
      status: input.status === 'pass' ? 'pass' : input.status,
      evidenceIds: input.evidenceIds,
      reason: input.status === 'pass' ? '与任务目标一致' : '与任务目标不一致',
    })),
    repairSuggestions: input.repairSuggestions ?? (input.status === 'pass' ? [] : ['按任务目标修正后重试']),
  })
}
