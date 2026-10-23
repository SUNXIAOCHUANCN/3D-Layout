/**
 * uiProjection（W06.5）单测：事件流 → 进度视图 / 事件行文案。
 *
 * 这些断言保证"进度不是假动画"：百分比、完成数、当前动作都必须能从 recorder 事件推导。
 */

import { describe, expect, it } from 'vitest'
import type { CoAgentEventEnvelope } from '../../contracts'
import { deriveRunProgress, formatEvent, keepRecent } from '../../uiProjection'

let seq = 0
function ev(type: CoAgentEventEnvelope['type'], payload: Record<string, unknown> = {}, extra: Partial<CoAgentEventEnvelope> = {}): CoAgentEventEnvelope {
  return { schemaVersion: 1, eventSeq: ++seq, time: new Date().toISOString(), runId: 'run-1', type, payload, ...extra }
}

describe('deriveRunProgress', () => {
  it('空事件 + 空闲：0%，没有编造的"当前动作"', () => {
    const v = deriveRunProgress([], 'idle')
    expect(v.percent).toBe(0)
    expect(v.total).toBe(0)
    expect(v.current).toBe('—')
    expect(v.active).toBe(false)
  })

  it('计划 4 个任务、完成 1 个 → 25%，并给出当前动作', () => {
    const events = [
      ev('plan.ready', { kind: 'tasks', tasks: 4 }),
      ev('baseline.ready', { phase: 'baseline' }, { regionId: 'region-north' }),
      ev('task.started', { repair: 0 }, { taskId: 'task-n1', regionId: 'region-north' }),
      ev('verdict.ready', { status: 'pass', credible: true }, { taskId: 'task-n1', regionId: 'region-north' }),
      ev('task.finished', { status: 'pass' }, { taskId: 'task-n1', regionId: 'region-north' }),
    ]
    const v = deriveRunProgress(events, 'executing')
    expect(v.total).toBe(4)
    expect(v.passed).toBe(1)
    expect(v.percent).toBe(25)
    expect(v.current).toContain('判定')
    expect(v.regions).toEqual(['region-north'])
  })

  it('失败任务计入 failed，百分比按 (passed+failed)/total', () => {
    const events = [
      ev('plan.ready', { tasks: 4 }),
      ev('task.finished', { status: 'pass' }, { taskId: 'a' }),
      ev('task.finished', { status: 'fail' }, { taskId: 'b' }),
    ]
    const v = deriveRunProgress(events, 'executing')
    expect(v.passed).toBe(1)
    expect(v.failed).toBe(1)
    expect(v.percent).toBe(50)
  })

  it('相位 completed 强制 100%；committing 也按 100 显示', () => {
    const events = [ev('plan.ready', { tasks: 4 })]
    expect(deriveRunProgress(events, 'completed').percent).toBe(100)
    expect(deriveRunProgress(events, 'committing').percent).toBe(100)
  })

  it('没有 plan.ready 时按相位给保守进度（不是 0 卡住）', () => {
    expect(deriveRunProgress([], 'planning').percent).toBe(10)
    expect(deriveRunProgress([], 'executing').percent).toBe(50)
    expect(deriveRunProgress([], 'validating').percent).toBe(80)
  })

  it('修正轮：task.started 的 repair 字段体现在当前动作里', () => {
    const v = deriveRunProgress([ev('task.started', { repair: 1 }, { taskId: 'task-n1' })], 'executing')
    expect(v.current).toContain('修正第 1 次')
  })

  it('verdict 与 run 终态都会更新当前动作', () => {
    const v1 = deriveRunProgress([ev('verdict.ready', { status: 'fail' }, { taskId: 't1' })], 'validating')
    expect(v1.current).toContain('fail')
    const v2 = deriveRunProgress([ev('run.committed', {})], 'completed')
    expect(v2.current).toBe('已提交')
    const v3 = deriveRunProgress([ev('run.rolled_back', { reason: 'x' })], 'rolled_back')
    expect(v3.current).toBe('已回滚')
  })
})

describe('formatEvent / keepRecent', () => {
  it('关键事件都有可读行（带序号、类型、位置与摘要）', () => {
    const line = formatEvent(ev('task.started', { repair: 0 }, { taskId: 'task-n1', regionId: 'region-north' }))
    expect(line).toContain('task.started')
    expect(line).toContain('region-north / task-n1')
    expect(line).toContain('首次执行')

    const verdict = formatEvent(ev('verdict.ready', { status: 'pass', credible: true }, { taskId: 't1' }))
    expect(verdict).toContain('pass')

    const partition = formatEvent(ev('partition.ready', { partitionVersion: 2, issues: 3 }))
    expect(partition).toContain('v2')
    expect(partition).toContain('3 个问题')
  })

  it('keepRecent 只保留最近 N 条（防止 UI 无限增长）', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev('tool.finished', { step: i }))
    const kept = keepRecent(events, 4)
    expect(kept.length).toBe(4)
    expect(kept[kept.length - 1].eventSeq).toBe(events[9].eventSeq)
  })
})
