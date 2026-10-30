/**
 * W08.1 集成：程序计算的 metric/constraint 真正影响判定与终检。
 *
 * 覆盖三件事：
 * 1. 只覆盖一个区域的计划也能跑完（dispatch 会为无任务区建空子图）；
 * 2. 模型判 pass 但程序算 metric 不满足 → 判定降级、整轮不通过；
 * 3. add 落点越界在写前被 out_of_scope 拒绝，最终不通过且回滚。
 */

import { describe, expect, it, vi } from 'vitest'
import type { ModelRequest, Plan, UnitTask } from '../../contracts'
import { createMainWorkflow } from '../../workflow/mainGraph'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { createFakeRender } from '../fakes/FakeRender'
import { createDirectorModel, evidenceIdsFromPrompt, jsonReply, textReply, toolReply, verdictReply, type DirectorModel } from '../fakes/directorModel'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const T = (position: [number, number, number]) => ({
  position,
  rotationDeg: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
})

function task(over: Partial<UnitTask> & { id: string; regionId: string }): UnitTask {
  return {
    schemaVersion: 1,
    objective: `${over.id} 的目标`,
    targetObjectIds: [],
    allowedOperations: ['transform'],
    criteria: [{ id: `crit-${over.id}`, kind: 'visual', description: '达成' }],
    constraints: [{ kind: 'stay_in_region' }],
    dependsOn: [],
    ...over,
  }
}

function planOf(tasks: UnitTask[]): Plan {
  return { schemaVersion: 1, kind: 'tasks', assumptions: ['W08 测试计划'], tasks }
}

function parseTask(req: ModelRequest): UnitTask {
  const text = req.messages
    .filter(m => m.role === 'user')
    .map(m => (m as { text: string }).text)
    .join('\n')
  const line = text.split('\n').find(l => l.startsWith('任务（JSON）：'))
  if (!line) throw new Error('judge 提示词里没有任务 JSON')
  return JSON.parse(line.slice('任务（JSON）：'.length)) as UnitTask
}

/** 判定器永远 pass；真正的 fail 必须由程序 metric/constraint 覆盖 */
function installPassJudge(model: DirectorModel): void {
  model.on('judge', req => {
    const t = parseTask(req)
    const { baselineId, afterId } = evidenceIdsFromPrompt(req)
    return verdictReply({
      taskId: t.id,
      criteria: t.criteria.map(c => c.id),
      status: 'pass',
      evidenceIds: [baselineId, afterId],
    })
  })
}

/** 第一轮发给定工具调用，后续轮收尾（修正轮不会重复执行工具） */
function installExecutorOnce(
  model: DirectorModel,
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): void {
  let round = 0
  model.on('executor', () => {
    const current = round++
    if (current > 0) return textReply('已完成')
    return toolReply('执行', calls.map((c, i) => ({ ...c, id: `call-${i}` })))
  })
}

function setup(plan: Plan, config: Record<string, unknown> = {}, options: { request?: string; render?: ReturnType<typeof createFakeRender> } = {}) {
  const model = createDirectorModel()
  model.on('planner', () => jsonReply(plan))
  const ctx = createFakeWorkflowContext({
    model,
    render: options.render ?? createFakeRender(),
    ...(Object.keys(config).length > 0 ? { config: config as never } : {}),
  })
  const fp = (id: string) => ctx.editorRead.snapshot({ objectIds: [id] }).assets[0].fingerprint
  const run = () =>
    createMainWorkflow().run(
      { runId: 'run-w08', request: options.request ?? '按计划整理场景', partition: makeTwoRegionPartition(), sceneRevisionAtStart: 1 },
      ctx,
    )
  return { model, ctx, fp, run }
}

describe('W08.1 计划只覆盖一个区域', () => {
  it('另一区无任务时，空子图正常结束；preserve_objects 的非 target 对象不误报', async () => {
    const plan = planOf([
      task({
        id: 'task-n1',
        regionId: 'region-north',
        targetObjectIds: ['tree-1'],
        criteria: [{ id: 'c-visual', kind: 'visual', description: '树在区内' }],
        constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_objects', objectIds: ['tree-2'] }],
      }),
    ])
    const { model, ctx, fp, run } = setup(plan)
    installExecutorOnce(model, [
      { name: 'edit.transform', args: { objectId: 'tree-1', transform: T([-5.5, 0, -5.5]), expectedFingerprint: fp('tree-1') } },
    ])
    installPassJudge(model)

    const outcome = await run()
    expect(outcome.kind, JSON.stringify(outcome)).toBe('completed')
    if (outcome.kind !== 'completed') return
    expect(outcome.regions['region-south'].status).toBe('pass')
    expect(outcome.regions['region-south'].tasks).toEqual([])
    expect(outcome.finalCheck.checks.find(c => c.name === 'constraint:task-n1:preserve_objects')?.passed).toBe(true)
    expect(outcome.finalCheck.passed).toBe(true)
    expect(ctx.fakeEditor.snapshot({ objectIds: ['tree-2'] }).assets[0].id).toBe('tree-2')
  })
})

describe('碰撞诊断与硬性验收', () => {
  const collision = () => createFakeRender({ geometryResult: {
    status: 'collision', highestLevel: 'mesh', pairs: [{ a: 'tree-1', b: 'tree-2', status: 'collision', level: 'mesh' }],
  } })

  it.each([false, true])('未声明硬约束：主动诊断=%s，任务与终检可以通过', async diagnostic => {
    const plan = planOf([task({ id: 'task-n1', regionId: 'region-north', targetObjectIds: ['tree-1'] })])
    const { model, ctx, fp, run } = setup(plan, {}, { render: collision() })
    const geometry = vi.spyOn(ctx.render, 'geometry')
    installExecutorOnce(model, [
      { name: 'edit.transform', args: { objectId: 'tree-1', transform: T([-5.5, 0, -5.5]), expectedFingerprint: fp('tree-1') } },
      ...(diagnostic ? [{ name: 'geometry.check', args: { objectIds: ['tree-1', 'tree-2'] } }] : []),
    ])
    installPassJudge(model)
    const outcome = await run()
    expect(outcome.kind, JSON.stringify(outcome)).toBe('completed')
    // 仅执行器主动调用会发生检查；区域判定与终检均不自动添加硬约束。
    expect(geometry).toHaveBeenCalledTimes(diagnostic ? 1 : 0)
    if (outcome.kind === 'completed') {
      expect(outcome.finalCheck.passed).toBe(true)
      expect(outcome.finalCheck.checks.some(c => c.name.endsWith(':no_collision'))).toBe(false)
    }
  })

  it('用户明确启用硬约束：即使模型判 pass，碰撞仍导致终检失败', async () => {
    const request = '移动树木，移动的树不得与其他对象相交'
    const plan = planOf([task({ id: 'task-n1', regionId: 'region-north', targetObjectIds: ['tree-1'], constraints: [
      { kind: 'stay_in_region' },
      { kind: 'no_collision', basis: { source: 'user_request', quote: '移动的树不得与其他对象相交' } },
    ] })])
    const { model, ctx, fp, run } = setup(plan, { maxRepairsPerTask: 0 }, { request, render: collision() })
    const geometry = vi.spyOn(ctx.render, 'geometry')
    installExecutorOnce(model, [
      { name: 'edit.transform', args: { objectId: 'tree-1', transform: T([-5.5, 0, -5.5]), expectedFingerprint: fp('tree-1') } },
    ])
    installPassJudge(model)
    const outcome = await run()
    expect(geometry).toHaveBeenCalled()
    // P3：硬约束未通过 → 判据仍 fail、结果保留（不再整轮回滚）
    expect(outcome.kind).toBe('retained_with_issues')
    if (outcome.kind === 'retained_with_issues') {
      expect(outcome.finalCheck.passed).toBe(false)
      expect(outcome.issues.some(i => i.reason.includes('no_collision'))).toBe(true)
    }
  })
})

describe('W08.1 程序指标覆盖模型判定', () => {
  it('模型判 pass，但 region.object_count 实际 3 ≠ 4 → 判定降级，改动保留', async () => {
    const plan = planOf([
      task({
        id: 'task-s2',
        regionId: 'region-south',
        allowedOperations: ['add'],
        creationTarget: { minCount: 1, maxCount: 1 },
        criteria: [
          { id: 'c-count', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 4, unit: 'count' },
        ],
        constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_count' }],
      }),
    ])
    const { model, run } = setup(plan)
    installExecutorOnce(model, [
      { name: 'edit.add', args: { ref: 'models/rock', transform: T([5, 0, 6]) } },
    ])
    installPassJudge(model)

    const outcome = await run()
    // 程序指标覆盖模型判定：仍然是 fail，但成果保留
    expect(outcome.kind).toBe('retained_with_issues')
    if (outcome.kind === 'retained_with_issues') {
      expect(outcome.finalCheck.passed).toBe(false)
      expect(outcome.issues.some(i => i.reason.includes('region.object_count') || i.name.includes('task-s2'))).toBe(true)
    }
  })

  it('add 落点越界 → 工具返回 out_of_scope，最终不通过但场景不变', async () => {
    const plan = planOf([
      task({
        id: 'task-s2',
        regionId: 'region-south',
        allowedOperations: ['add'],
        creationTarget: { minCount: 1, maxCount: 1 },
        criteria: [{ id: 'c-count', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 3, unit: 'count' }],
        constraints: [{ kind: 'stay_in_region' }],
      }),
    ])
    const { model, ctx, run } = setup(plan, { maxRepairsPerTask: 0 })
    installExecutorOnce(model, [
      { name: 'edit.add', args: { ref: 'models/rock', transform: T([20, 0, 20]) } },
    ])
    installPassJudge(model)

    const outcome = await run()
    // 写入被拒 → 没有实际改动可保留，但结果仍是"有问题"而不是内部异常
    expect(outcome.kind).toBe('retained_with_issues')
    if (outcome.kind === 'retained_with_issues') expect(outcome.finalCheck.passed).toBe(false)
    // 写前检查直接拒绝，不是静默写入
    const toolResults = model.requests
      .flatMap(r => r.messages)
      .filter(m => m.role === 'toolResult')
      .map(m => JSON.stringify((m as { content: unknown }).content))
    expect(toolResults.some(t => t.includes('out_of_scope'))).toBe(true)
    expect(ctx.fakeEditor.snapshot({}).assets.length).toBe(5)
  })
})
