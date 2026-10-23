/**
 * W03 假 workflow —— 对两个区域执行已知 transform/add（SPEC §W03"接入假 workflow，
 * 对两个区域做已知 transform"）。
 *
 * 所有写入只经 context.applyWrite（完整门面路径：作用域/指纹/幂等/惰性事务/串行队列），
 * 不触碰 editorWrite —— 与真实 workflow 的约束一致。支持故障注入：指定步抛错、
 * 信号中止后尝试迟到写入（断言被拒）。
 */

import type {
  EditorCommand,
  RunInput,
  RunOutcome,
  TransformDTO,
  WorkflowContext,
  WorkflowRunner,
} from '../../contracts'

export interface KnownTransformStep {
  regionId: string
  /** 目标对象（transform/remove）；add 步骤留空 */
  objectId?: string
  /** add：模型 ref（与 objectId 二选一） */
  addRef?: string
  transform: TransformDTO
  /** 步前延时（毫秒），制造可取消窗口 */
  delayMs?: number
}

export interface KnownTransformSpec {
  steps: KnownTransformStep[]
  /** 在第 N 步（0 基）执行前抛错，模拟执行失败（整轮回滚） */
  failAtStep?: number
  /** 信号中止后追加一次迟到写入尝试；结果记录到 lateWriteResults 供断言 */
  lateWriteAfterAbort?: { objectId: string; transform: TransformDTO }
}

export interface KnownTransformWorkflow extends WorkflowRunner {
  /** lateWriteAfterAbort 的实际结果（ok 与错误码） */
  readonly lateWriteResults: Array<{ code?: string; ok: boolean }>
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export function createKnownTransformWorkflow(spec: KnownTransformSpec): KnownTransformWorkflow {
  const lateWriteResults: Array<{ code?: string; ok: boolean }> = []

  const runner: KnownTransformWorkflow = {
    lateWriteResults,
    async run(input: RunInput, context: WorkflowContext): Promise<RunOutcome> {
      context.emit({ type: 'task.started', runId: input.runId, payload: { steps: spec.steps.length } })
      let toolSeq = 0
      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i]
        if (spec.failAtStep === i) {
          throw new Error(`已知故障注入：第 ${i} 步失败`)
        }
        if (step.delayMs && step.delayMs > 0) {
          await sleep(step.delayMs)
          if (context.signal.aborted) {
            // 取消路径：先执行迟到写注入（断言被拒），再返回 cancelled
            if (spec.lateWriteAfterAbort) {
              const lw = spec.lateWriteAfterAbort
              const fp = context.editorRead.snapshot({ objectIds: [lw.objectId] }).assets[0]?.fingerprint ?? 'stale'
              const r = await context.applyWrite(
                { kind: 'transform', objectId: lw.objectId, transform: lw.transform, expectedFingerprint: fp },
                { taskId: null, toolCallId: `w03-late-${toolSeq}`, regionId: null },
              )
              lateWriteResults.push(r.ok ? { ok: true } : { ok: false, code: r.error.code })
            }
            return { kind: 'cancelled' }
          }
        }
        const callId = `w03-${i}`
        let command: EditorCommand
        if (step.addRef) {
          command = { kind: 'add', ref: step.addRef, transform: step.transform }
        } else {
          const objectId = step.objectId ?? ''
          const fp = context.editorRead.snapshot({ objectIds: [objectId] }).assets[0]?.fingerprint
          if (!fp) throw new Error(`步骤 ${i}：对象 ${objectId} 不在场景中`)
          command = { kind: 'transform', objectId, transform: step.transform, expectedFingerprint: fp }
        }
        const result = await context.applyWrite(command, {
          taskId: `w03-task-${step.regionId}`,
          toolCallId: callId,
          regionId: step.regionId,
        })
        if (!result.ok) {
          throw new Error(`步骤 ${i} 写入被拒：${result.error.code} ${result.error.message}`)
        }
        context.emit({
          type: 'tool.finished',
          runId: input.runId,
          regionId: step.regionId,
          taskId: `w03-task-${step.regionId}`,
          payload: { step: i, objectId: result.data.objectId },
        })
        toolSeq++
      }

      // 迟到写入注入（循环正常结束但信号已中止的场景）
      if (spec.lateWriteAfterAbort && context.signal.aborted) {
        const lw = spec.lateWriteAfterAbort
        const fp = context.editorRead.snapshot({ objectIds: [lw.objectId] }).assets[0]?.fingerprint ?? 'stale'
        const r = await context.applyWrite(
          { kind: 'transform', objectId: lw.objectId, transform: lw.transform, expectedFingerprint: fp },
          { taskId: null, toolCallId: `w03-late-${toolSeq}`, regionId: null },
        )
        lateWriteResults.push(r.ok ? { ok: true } : { ok: false, code: r.error.code })
      }

      context.emit({ type: 'task.finished', runId: input.runId, payload: { steps: toolSeq } })
      return {
        kind: 'completed',
        summary: `假 workflow 完成 ${toolSeq} 步已知变换（两区域）`,
        plan: {
          schemaVersion: 1,
          kind: 'tasks',
          assumptions: ['W03 假 workflow：已知 transform，不经模型'],
          tasks: [],
        },
        regions: Object.fromEntries(
          [...new Set(spec.steps.map(s => s.regionId))].map(regionId => [
            regionId,
            { regionId, status: 'pass', tasks: [] },
          ]),
        ),
        finalCheck: {
          passed: true,
          checkedAt: new Date().toISOString(),
          checks: spec.steps.map((s, i) => ({ name: `step-${i}-${s.regionId}`, passed: true, evidenceIds: [] })),
        },
      }
    },
  }
  return runner
}
