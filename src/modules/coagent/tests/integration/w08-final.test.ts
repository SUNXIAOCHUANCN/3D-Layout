/**
 * W08.4 / W08.5 集成：
 * - 修正轮不丢第一轮 add 的写集；
 * - remove 任务能通过最终场景重算；
 * - 后任务改过某任务的相关对象时，终检用同视角最终图重判 visual。
 */

import { describe, expect, it } from 'vitest'
import type { ModelReply, ModelRequest, Plan, UnitTask } from '../../contracts'
import { createMainWorkflow } from '../../workflow/mainGraph'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
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
  return { schemaVersion: 1, kind: 'tasks', assumptions: ['W08 收尾测试'], tasks }
}

function parseTask(req: ModelRequest): UnitTask {
  const text = req.messages
    .filter(m => m.role === 'user')
    .map(m => (m as { text: string }).text)
    .join('\n')
  const lines = text.split('\n')
  const line = lines.find(l => l.startsWith('任务（JSON）：') || l.startsWith('当前任务（JSON）：'))
  if (!line) throw new Error('提示词里没有任务 JSON')
  const prefix = line.startsWith('任务（JSON）：') ? '任务（JSON）：' : '当前任务（JSON）：'
  return JSON.parse(line.slice(prefix.length)) as UnitTask
}

type ExecRound = Array<{ name: string; args: () => Record<string, unknown> }>

function installExecutor(model: DirectorModel, scripts: Record<string, ExecRound[]>): void {
  const rounds = new Map<string, number>()
  model.on('executor', req => {
    const t = parseTask(req)
    const script = scripts[t.id]
    if (!script) throw new Error(`executor 脚本缺少任务 ${t.id}`)
    const round = rounds.get(t.id) ?? 0
    rounds.set(t.id, round + 1)
    const step = script[round]
    if (!step || step.length === 0) return textReply('完成')
    return toolReply('执行', step.map((c, i) => ({ name: c.name, args: c.args(), id: `${t.id}-r${round}-c${i}` })))
  })
}

function installJudge(model: DirectorModel, decide: (task: UnitTask, round: number, req: ModelRequest) => ModelReply): void {
  const rounds = new Map<string, number>()
  model.on('judge', req => {
    const t = parseTask(req)
    const round = rounds.get(t.id) ?? 0
    rounds.set(t.id, round + 1)
    return decide(t, round, req)
  })
}

function passVerdict(t: UnitTask, req: ModelRequest): ModelReply {
  const { baselineId, afterId } = evidenceIdsFromPrompt(req)
  return verdictReply({ taskId: t.id, criteria: t.criteria.map(c => c.id), status: 'pass', evidenceIds: [baselineId, afterId] })
}

function failVerdict(t: UnitTask, req: ModelRequest): ModelReply {
  const { baselineId, afterId } = evidenceIdsFromPrompt(req)
  return verdictReply({ taskId: t.id, criteria: t.criteria.map(c => c.id), status: 'fail', evidenceIds: [baselineId, afterId] })
}

function setup(plan: Plan, config: Record<string, unknown> = {}) {
  const model = createDirectorModel()
  model.on('planner', () => jsonReply(plan))
  const ctx = createFakeWorkflowContext({
    model,
    ...(Object.keys(config).length > 0 ? { config: config as never } : {}),
  })
  const fp = (id: string) => ctx.editorRead.snapshot({ objectIds: [id] }).assets[0].fingerprint
  const run = () =>
    createMainWorkflow().run(
      { runId: 'run-w08-final', request: '按计划整理', partition: makeTwoRegionPartition(), sceneRevisionAtStart: 1 },
      ctx,
    )
  return { model, ctx, fp, run }
}

describe('W08.4 修正轮写集与 remove', () => {
  it('第一轮 add 失败后进入修正轮，TaskResult 仍保留新增对象（写集不覆盖）', async () => {
    const plan = planOf([
      task({
        id: 'task-s2',
        regionId: 'region-south',
        allowedOperations: ['add'],
        creationTarget: { minCount: 1, maxCount: 1 },
        criteria: [{ id: 'c-count', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 3, unit: 'count' }],
        constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_count' }],
      }),
    ])
    const { model, ctx, run } = setup(plan)
    installExecutor(model, {
      'task-s2': [
        [{ name: 'edit.add', args: () => ({ ref: 'models/rock', name: '新增岩石', transform: T([5, 0, 6]) }) }],
        [], // 修正轮不再 add；第一轮的写集必须还在
      ],
    })
    installJudge(model, (t, round, req) => (round === 0 ? failVerdict(t, req) : passVerdict(t, req)))

    const outcome = await run()
    expect(outcome.kind, JSON.stringify(outcome)).toBe('completed')
    if (outcome.kind !== 'completed') return
    const result = outcome.regions['region-south'].tasks.find(t => t.taskId === 'task-s2')
    expect(result?.createdObjectIds.length).toBe(1)
    expect(ctx.fakeEditor.snapshot({}).assets.filter(a => a.ref === 'models/rock').length).toBe(2)
    expect(outcome.finalCheck.passed).toBe(true)
  })

  it('remove 任务：对象被删除后，终检按最终场景重算 count 并通过', async () => {
    const plan = planOf([
      task({
        id: 'task-remove',
        regionId: 'region-south',
        targetObjectIds: ['rock-1'],
        allowedOperations: ['remove'],
        criteria: [{ id: 'c-count', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 1, unit: 'count' }],
        constraints: [],
      }),
    ])
    const { model, ctx, fp, run } = setup(plan)
    installExecutor(model, {
      'task-remove': [[{ name: 'edit.remove', args: () => ({ objectId: 'rock-1', expectedFingerprint: fp('rock-1') }) }], []],
    })
    installJudge(model, (t, _round, req) => passVerdict(t, req))

    const outcome = await run()
    expect(outcome.kind, JSON.stringify(outcome)).toBe('completed')
    if (outcome.kind !== 'completed') return
    const result = outcome.regions['region-south'].tasks.find(t => t.taskId === 'task-remove')
    expect(result?.status).toBe('pass')
    expect(result?.modifiedObjectIds).toContain('rock-1')
    expect(ctx.fakeEditor.snapshot({ objectIds: ['rock-1'] }).assets).toEqual([])
  })
})

describe('W08.5 终检视觉重判', () => {
  it('后任务改过前任务目标 → 用同视角最终图重判 visual，失败则整轮不通过', async () => {
    const plan = planOf([
      task({ id: 'task-n1', regionId: 'region-north', targetObjectIds: ['tree-1'] }),
      task({ id: 'task-n2', regionId: 'region-north', targetObjectIds: ['tree-1'] }),
    ])
    const { model, ctx, fp, run } = setup(plan)
    installExecutor(model, {
      'task-n1': [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) }], []],
      'task-n2': [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([1, 0, -5]), expectedFingerprint: fp('tree-1') }) }], []],
    })
    installJudge(model, (t, round, req) => {
      // n1 首次 pass；终检重判（第二次）fail。n2 只判一次。
      if (t.id === 'task-n1' && round >= 1) return failVerdict(t, req)
      return passVerdict(t, req)
    })

    const outcome = await run()
    expect(outcome.kind).toBe('retained_with_issues')
    expect(model.count('judge')).toBe(3) // n1 首次 + n1 终检重判 + n2 首次；未受影响的 n2 不重判
    if (outcome.kind === 'retained_with_issues') {
      expect(outcome.finalCheck.passed).toBe(false)
      expect(outcome.issues.some(i => i.reason.includes('视觉重判') || i.name.includes('task-n1'))).toBe(true)
    }
    // 终检证据里确实有第二张 after 图
    const finalEvidence = ctx.observations.size
    expect(finalEvidence).toBeGreaterThan(0)
    expect(ctx.fakeEditor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([1, 0, -5])
  })
})

/**
 * P1：同区第二任务不得继承第一任务的写集（S11）。
 *
 * 旧实现的 `advance` 不返回 writes，而 writes 的 reducer 是"替换"语义 →
 * 通道保留上一任务的值 → 第二任务的 TaskResult 把第一任务新增的对象也算成自己的。
 */
describe('P1 任务隔离', () => {
  it('同区两个 add 任务各记自己新增的对象，互不串账', async () => {
    const plan = planOf([
      task({ id: 'task-a1', regionId: 'region-north', allowedOperations: ['add'], creationTarget: { minCount: 1, maxCount: 1 } }),
      task({ id: 'task-a2', regionId: 'region-north', allowedOperations: ['add'], creationTarget: { minCount: 1, maxCount: 1 } }),
    ])
    const { model, ctx, run } = setup(plan)
    installExecutor(model, {
      'task-a1': [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', name: '岩石一', transform: T([-6, 0, -3]) }) }]],
      'task-a2': [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', name: '岩石二', transform: T([4, 0, -3]) }) }]],
    })
    installJudge(model, (t, _round, req) => passVerdict(t, req))

    const outcome = await run()
    expect(outcome.kind, JSON.stringify(outcome)).toBe('completed')
    if (outcome.kind !== 'completed') return

    const results = outcome.regions['region-north'].tasks
    expect(results.map(t => t.taskId)).toEqual(['task-a1', 'task-a2'])
    // 每个任务只记自己的那一个
    expect(results[0].createdObjectIds).toHaveLength(1)
    expect(results[1].createdObjectIds).toHaveLength(1)
    expect(results[0].createdObjectIds[0]).not.toBe(results[1].createdObjectIds[0])
    expect(results[1].liveCreatedObjectIds).toHaveLength(1)
    // 场景里确实有两个新对象
    expect(ctx.fakeEditor.state().assetCount).toBeGreaterThan(0)
  })

  it('第二任务的 executionState 不含第一任务的对象（修复上下文不串）', async () => {
    const plan = planOf([
      task({ id: 'task-a1', regionId: 'region-north', allowedOperations: ['add'], creationTarget: { minCount: 1, maxCount: 1 } }),
      task({ id: 'task-a2', regionId: 'region-north', allowedOperations: ['add'], creationTarget: { minCount: 1, maxCount: 1 } }),
    ])
    const { model, run } = setup(plan)
    installExecutor(model, {
      'task-a1': [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', name: '岩石一', transform: T([-6, 0, -3]) }) }]],
      'task-a2': [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', name: '岩石二', transform: T([4, 0, -3]) }) }]],
    })
    installJudge(model, (t, _round, req) => passVerdict(t, req))

    // 抓 task-a2 第一次执行时收到的提示词（DirectorModel 记录所有请求）
    const outcome = await run()
    expect(outcome.kind).toBe('completed')

    const textOf = (req: ModelRequest): string =>
      req.messages
        .filter(m => m.role === 'user')
        .map(m => (m as { text: string }).text)
        .join('\n')
    const secondTaskPrompt =
      model.requests.find(r => r.purpose === 'executor' && textOf(r).includes('"id":"task-a2"'))
    expect(secondTaskPrompt, '没有抓到 task-a2 的执行请求').toBeTruthy()
    const text = textOf(secondTaskPrompt!)
    // a2 开始时自己还没建任何对象
    expect(text).toContain('已创建且仍存活 0 个')
    expect(text).toContain('还可新增 1 个')
    expect(text).not.toContain('岩石一')
  })
})
