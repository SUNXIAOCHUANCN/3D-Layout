/**
 * W10 图页投影：事件流 → 节点状态 / 阶段 / 时间轴文案。
 * 纯函数，node 环境下直接可测（不碰 DOM、不碰 BroadcastChannel）。
 */

import { describe, expect, it } from 'vitest'
import type { CoAgentEventEnvelope, CoAgentEventType } from '../../contracts'
import { deriveView, formatEventLine, relatedEvents } from '../../graph/derive'

let seq = 0
function ev(
  type: CoAgentEventType,
  payload: Record<string, unknown>,
  opts: { regionId?: string; taskId?: string; at?: number } = {},
): CoAgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventSeq: ++seq,
    time: new Date(opts.at ?? Date.now()).toISOString(),
    runId: 'run-1',
    type,
    payload,
    ...(opts.regionId ? { regionId: opts.regionId } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
  }
}

describe('deriveView', () => {
  it('并行分支：多个节点同时 running，完成/失败各自落状态', () => {
    seq = 0
    const t0 = Date.now()
    const events = [
      ev('run.started', {}, { at: t0 }),
      ev('node.started', { node: 'dispatch' }, { at: t0 + 10 }),
      ev('node.finished', { node: 'dispatch', status: 'ok', ms: 5 }, { at: t0 + 15 }),
      ev('node.started', { node: 'region-A' }, { at: t0 + 20 }),
      ev('node.started', { node: 'region-B' }, { at: t0 + 21 }),
      ev('node.started', { node: 'A/execute', regionId: 'A' }, { at: t0 + 22 }),
      ev('node.finished', { node: 'region-B', status: 'error', ms: 900, message: '判定不过' }, { at: t0 + 30 }),
    ]
    const view = deriveView(events)
    expect(view.active.sort()).toEqual(['A/execute', 'region-A'])
    expect(view.visuals.get('dispatch')?.state).toBe('ok')
    expect(view.visuals.get('region-B')?.state).toBe('error')
    expect(view.visuals.get('region-B')?.message).toBe('判定不过')
    expect(view.phase).toEqual({ label: '运行中', tone: 'running' })
    expect(view.startedAt).toBe(t0)
  })

  it('子图节点折叠成区域节点的子步骤', () => {
    seq = 0
    const events = [
      ev('node.started', { node: 'region-A' }, { regionId: 'A' }),
      ev('node.started', { node: 'A/execute' }, { regionId: 'A' }),
    ]
    const view = deriveView(events)
    expect(view.visuals.get('region-A')?.state).toBe('running')
    expect(view.visuals.get('region-A')?.substep).toBe('execute')
  })

  it('终态与失败节点来自 run.rolled_back.payload.stage', () => {
    seq = 0
    const events = [
      ev('run.started', {}),
      ev('node.finished', { node: 'finalCheck', status: 'error', ms: 12, message: '缺结果' }),
      ev('run.rolled_back', { reason: 'validation_failed', stage: 'finalCheck', message: '缺结果' }),
    ]
    const view = deriveView(events)
    expect(view.phase).toEqual({ label: '已回滚', tone: 'error' })
    expect(view.failedNode).toBe('finalCheck')
  })

  it('run.end 的 outcome 优先于事件推导', () => {
    seq = 0
    const events = [ev('run.started', {})]
    expect(deriveView(events, 'run.committed').phase).toEqual({ label: '已完成', tone: 'ok' })
  })

  it('空事件流 = 空闲', () => {
    const view = deriveView([])
    expect(view.active).toEqual([])
    expect(view.phase.tone).toBe('idle')
    expect(view.startedAt).toBeNull()
  })
})

describe('formatEventLine / relatedEvents', () => {
  it('节点事件带耗时，业务事件按 regionId 归到区域节点', () => {
    seq = 0
    const events = [
      ev('node.finished', { node: 'A/judge', status: 'ok', ms: 320 }, { regionId: 'A' }),
      ev('task.started', { index: 0, repair: 0 }, { regionId: 'A', taskId: 't1' }),
      ev('verdict.ready', { status: 'pass' }, { regionId: 'A', taskId: 't1' }),
      ev('task.started', { index: 0 }, { regionId: 'B', taskId: 't2' }),
    ]
    expect(formatEventLine(events[0])).toContain('A/judge')
    expect(formatEventLine(events[0])).toContain('320ms')

    const relatedA = relatedEvents(events, 'region-A')
    expect(relatedA.map(e => e.type)).toEqual(['node.finished', 'task.started', 'verdict.ready'])
    const relatedB = relatedEvents(events, 'region-B')
    expect(relatedB.map(e => e.type)).toEqual(['task.started'])
  })
})
