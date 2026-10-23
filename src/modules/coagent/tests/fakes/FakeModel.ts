/**
 * FakeModel —— ModelPort 的脚本化假实现（W01）。
 *
 * 回复按队列顺序消费；队列耗尽抛 model_protocol_error（暴露测试脚本没写全）。
 * 支持"挂起下一请求"用于取消语义测试：请求永不完成，直到 AbortSignal 触发，
 * 与真实网络取消路径一致地以 CoAgentError('cancelled') 拒绝。
 * 所有收到的请求留档（ModelRequest 不含凭据——密钥留在适配层，契约如此规定）。
 */

import type { ModelPort, ModelReply, ModelRequest } from '../../contracts'
import { CoAgentError } from '../../contracts'

export interface FakeModel extends ModelPort {
  /** 追加脚本回复（队尾） */
  queueMore(...replies: ModelReply[]): void
  /** 下一次（组）请求挂起直到 abort，用于取消测试 */
  hangNext(count?: number): void
  /** 已收到的请求副本（时间序；含 tools/messages 结构供断言） */
  readonly requests: ReadonlyArray<Readonly<ModelRequest>>
  /** 被 abort 中止的请求次数 */
  readonly abortedCount: number
  /** 尚未消费的脚本回复数 */
  readonly pendingReplies: number
}

export function createFakeModel(initial: ModelReply[] = []): FakeModel {
  const queue: ModelReply[] = [...initial]
  const requests: ModelRequest[] = []
  let abortedCount = 0
  let hangCount = 0

  const waitAbort = (signal: AbortSignal): Promise<never> =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          abortedCount++
          reject(new CoAgentError('cancelled', '模型请求被取消'))
        },
        { once: true },
      )
    })

  return {
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
      requests.push(structuredClone(request))
      if (signal.aborted) {
        abortedCount++
        throw new CoAgentError('cancelled', '模型请求被取消')
      }
      if (hangCount > 0) {
        hangCount--
        return waitAbort(signal)
      }
      const reply = queue.shift()
      if (!reply) {
        throw new CoAgentError('model_protocol_error', 'FakeModel 脚本回复耗尽（测试未覆盖该次调用）')
      }
      return structuredClone(reply)
    },

    queueMore(...replies: ModelReply[]): void {
      queue.push(...replies)
    },

    hangNext(count = 1): void {
      hangCount = Math.max(hangCount, count)
    },

    get requests(): ReadonlyArray<Readonly<ModelRequest>> {
      return requests
    },
    get abortedCount(): number {
      return abortedCount
    },
    get pendingReplies(): number {
      return queue.length
    },
  }
}
