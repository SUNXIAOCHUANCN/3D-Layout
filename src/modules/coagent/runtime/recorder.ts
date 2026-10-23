/**
 * Recorder（W03 最小实现）——独立于图的单调 eventSeq 分配器（§3.2/§5.5）。
 *
 * 职责：接收 WorkflowEventInput → 补 schemaVersion/eventSeq/time → 存档；
 * 写入前对 payload 做凭据/请求头递归过滤（导出与脱敏的完整实现属 W09，
 * 这里保证事件从第一天起就不携带敏感字段形状）。
 * 禁止日志反向驱动业务（§5.1）：本类型只被写入和读取。
 */

import type { CoAgentEventEnvelope, WorkflowEventInput } from '../contracts'

const SENSITIVE_KEY_RE = /authorization|api[-_]?key|token|secret|cookie|password/i

export interface Recorder {
  append(input: WorkflowEventInput): CoAgentEventEnvelope
  events(): CoAgentEventEnvelope[]
  /** 深拷贝并过滤敏感键后的快照（导出/调试用） */
  sanitizedEvents(): CoAgentEventEnvelope[]
  /** 追加通知（UI 进度计数用；单向，不可反向影响业务） */
  subscribe(listener: (envelope: CoAgentEventEnvelope) => void): () => void
  reset(): void
}

export function createRecorder(): Recorder {
  let seq = 0
  const log: CoAgentEventEnvelope[] = []
  const listeners = new Set<(envelope: CoAgentEventEnvelope) => void>()

  const sanitize = (value: unknown, depth: number): unknown => {
    if (depth > 6) return '[深度截断]'
    if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1))
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? '[已过滤]' : sanitize(v, depth + 1)
      }
      return out
    }
    return value
  }

  return {
    append(input: WorkflowEventInput): CoAgentEventEnvelope {
      const envelope: CoAgentEventEnvelope = {
        schemaVersion: 1,
        eventSeq: ++seq,
        time: new Date().toISOString(),
        runId: input.runId,
        ...(input.regionId !== undefined ? { regionId: input.regionId } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        type: input.type,
        payload: sanitize(input.payload, 0) as Record<string, unknown>,
      }
      log.push(envelope)
      for (const l of listeners) l(envelope)
      return envelope
    },
    events: () => [...log],
    sanitizedEvents: () => log.map(e => ({ ...e, payload: sanitize(e.payload, 0) as Record<string, unknown> })),
    subscribe(listener: (envelope: CoAgentEventEnvelope) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    reset: () => {
      seq = 0
      log.length = 0
    },
  }
}
