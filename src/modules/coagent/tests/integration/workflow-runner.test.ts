/**
 * 占位外壳（W02 拓扑回归）测试。
 *
 * W05 起真实流程在 mainGraph/regionGraph；本文件只保证 W02 验证过的外壳语义没有漂移：
 * 正常完成（结果齐、保底摘要、run.started、场景零修改）、非法分区、分支失败映射、取消。
 */

import { describe, expect, it } from 'vitest'
import type { RunInput } from '../../contracts'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'
import { createPlaceholderWorkflow } from '../../workflow/placeholderWorkflow'

const makeRun = (over: Partial<RunInput> = {}): RunInput => ({
  runId: 'run-w02',
  request: '整理两个区域',
  partition: makeTwoRegionPartition(),
  sceneRevisionAtStart: 1,
  ...over,
})

describe('占位外壳（W02 拓扑回归）', () => {
  it('正常路径：completed、两区结果齐、保底摘要非空、emit 记录 run.started、场景零修改', async () => {
    const ctx = createFakeWorkflowContext()
    const outcome = await createPlaceholderWorkflow().run(makeRun(), ctx)
    expect(outcome.kind).toBe('completed')
    if (outcome.kind !== 'completed') return
    expect(Object.keys(outcome.regions).sort()).toEqual(['region-north', 'region-south'])
    expect(outcome.summary.length).toBeGreaterThan(0)
    expect(outcome.finalCheck.passed).toBe(true)
    expect(ctx.events.some(e => e.type === 'run.started')).toBe(true)
    // 占位分支不写场景：资产数不变
    expect(ctx.fakeEditor.snapshot({}).assets.length).toBe(5)
  })

  it('非法分区快照 → rolled_back(invalid_plan)，不发出 run.started', async () => {
    const base = makeTwoRegionPartition()
    const broken = {
      ...base,
      regions: [{ ...base.regions[0], polygonXZ: [[0, 0], [1, 1]] }],
    }
    const ctx = createFakeWorkflowContext()
    const outcome = await createPlaceholderWorkflow().run(makeRun({ partition: broken as never }), ctx)
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') expect(outcome.reason.code).toBe('invalid_plan')
    expect(ctx.events.some(e => e.type === 'run.started')).toBe(false)
  })

  it('分支注入失败 → rolled_back(write_failed)', async () => {
    const ctx = createFakeWorkflowContext()
    const runner = createPlaceholderWorkflow({ failRegions: ['region-south'] })
    const outcome = await runner.run(makeRun(), ctx)
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') expect(outcome.reason.code).toBe('write_failed')
  })

  it('运行中 abort → cancelled（错误形状无关，只看信号状态）', async () => {
    const controller = new AbortController()
    const ctx = createFakeWorkflowContext({ signal: controller.signal })
    const runner = createPlaceholderWorkflow({ branchDelayMs: 300 })
    setTimeout(() => controller.abort(), 50)
    const outcome = await runner.run(makeRun(), ctx)
    expect(outcome.kind).toBe('cancelled')
  })
})
