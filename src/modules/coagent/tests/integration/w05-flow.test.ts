/**
 * W05 端到端闭环测试（假模型）——SPEC §W05 的固定脚本场景与错误用例。
 *
 * 覆盖：
 * 1. 两区各两个对象，指令生成每区任务；
 * 2. 所有初始基线在第一次写入前完成；
 * 3. A 区首次失败后修正成功、B 区较慢但成功（执行顺序由 director 脚本控制）；
 * 4. 同区第二任务取得即时基线（每个任务各自 task_before）；
 * 5. 整轮检查后一次 commit（走 runtime 的用例）；
 * 6. B 区终止失败时 A 区已完成修改也回滚（runtime rollback）。
 *
 * 错误用例：schema 错误计划、越权工具、错误证据 ID、后续任务破坏前任务约束。
 */

import { describe, expect, it } from 'vitest'
import type { EditorReadPort, GeometryResult, ModelRequest, Plan, UnitTask } from '../../contracts'
import { createMainWorkflow } from '../../workflow/mainGraph'
import { createRuntime } from '../../runtime/createRuntime'
import { createFakeRender } from '../fakes/FakeRender'
import { createFakeEditor } from '../fakes/FakeEditor'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import {
  createDirectorModel,
  evidenceIdsFromPrompt,
  jsonReply,
  textReply,
  toolReply,
  verdictReply,
  type DirectorModel,
} from '../fakes/directorModel'
import { TWO_REGION_ASSETS, TWO_REGION_CATALOG, makeTwoRegionPartition } from '../fixtures/twoRegionScene'

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
    criteria: [{ id: `crit-${over.id}`, kind: 'visual', description: `${over.id} 达成` }],
    constraints: [{ kind: 'stay_in_region' }],
    dependsOn: [],
    ...over,
  }
}

function planOf(tasks: UnitTask[]): Plan {
  return { schemaVersion: 1, kind: 'tasks', assumptions: ['W05 测试计划'], tasks }
}

function defaultPlan(): Plan {
  return planOf([
    task({ id: 'task-n1', regionId: 'region-north', targetObjectIds: ['tree-1'] }),
    task({ id: 'task-n2', regionId: 'region-north', targetObjectIds: ['tree-2'] }),
    task({ id: 'task-s1', regionId: 'region-south', targetObjectIds: ['house-1'] }),
    task({
      id: 'task-s2',
      regionId: 'region-south',
      allowedOperations: ['add'],
      // W08.1：南区当前 2 个对象（house-1/rock-1），add 一块石头后应为 3；之前写 6 是因为判据尚未真正计算
      criteria: [{ id: 'crit-task-s2', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 3, unit: 'count' }],
      constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_count' }],
    }),
  ])
}

const lastUserText = (req: ModelRequest): string =>
  req.messages
    .filter(m => m.role === 'user')
    .map(m => (m as { text: string }).text)
    .join('\n')

const taskIdOf = (req: ModelRequest): string => {
  const m = lastUserText(req).match(/"id"\s*:\s*"(task-[\w-]+)"/)
  if (!m) throw new Error(`无法从请求里解析 taskId：${lastUserText(req).slice(0, 160)}`)
  return m[1]
}

interface ExecScript {
  /** 每个执行轮次要发的工具调用；空数组表示收尾 */
  rounds: Array<Array<{ name: string; args: () => Record<string, unknown> }>>
}

/**
 * 按任务编排 executor：每个任务维护自己的轮次计数（修正轮会继续往下走）。
 * 工具参数里的指纹在调用时从当前状态取，正好覆盖 stale 语义。
 */
function scriptExecutor(model: DirectorModel, scripts: Record<string, ExecScript>): void {
  const rounds = new Map<string, number>()
  model.on('executor', req => {
    const id = taskIdOf(req)
    const script = scripts[id]
    if (!script) throw new Error(`executor 脚本缺少任务 ${id}`)
    const round = rounds.get(id) ?? 0
    rounds.set(id, round + 1)
    const step = script.rounds[round]
    if (!step || step.length === 0) return textReply(`${id} 执行完毕`)
    return toolReply(
      `${id} 执行第 ${round + 1} 轮`,
      step.map((c, i) => ({ name: c.name, args: c.args(), id: `${id}-r${round}-c${i}` })),
    )
  })
}

interface JudgeScript {
  /** 每次判定：pass/fail/uncertain，或 'bad-evidence' 表示编造证据 id */
  verdicts: Array<'pass' | 'fail' | 'uncertain' | 'bad-evidence'>
}

/** 从 judge 提示词里的任务 JSON 取判据 id（W08.1 的 metric 判据不再固定叫 crit-<taskId>） */
function criteriaIdsOfPrompt(req: ModelRequest): string[] {
  const line = lastUserText(req)
    .split('\n')
    .find(l => l.startsWith('任务（JSON）：'))
  if (!line) return []
  try {
    const task = JSON.parse(line.slice('任务（JSON）：'.length)) as UnitTask
    return task.criteria.map(c => c.id)
  } catch {
    return []
  }
}

function scriptJudge(model: DirectorModel, scripts: Record<string, JudgeScript>): void {
  const rounds = new Map<string, number>()
  model.on('judge', req => {
    const id = taskIdOf(req)
    const script = scripts[id]
    if (!script) throw new Error(`judge 脚本缺少任务 ${id}`)
    const round = rounds.get(id) ?? 0
    rounds.set(id, round + 1)
    const want = script.verdicts[Math.min(round, script.verdicts.length - 1)]
    const { baselineId, afterId } = evidenceIdsFromPrompt(req)
    const parsed = criteriaIdsOfPrompt(req)
    const criteria = parsed.length > 0 ? parsed : [`crit-${id}`]
    if (want === 'bad-evidence') {
      return verdictReply({ taskId: id, criteria, status: 'pass', evidenceIds: ['obs-fabricated-999'] })
    }
    return verdictReply({
      taskId: id,
      criteria,
      status: want,
      evidenceIds: [baselineId, afterId],
    })
  })
}

const fpOf = (reader: EditorReadPort) => (id: string) => reader.snapshot({ objectIds: [id] }).assets[0].fingerprint

/** W08.1：no_collision 现在必须拿到 clear；默认 fake 的 unknown 会被判 uncertain（不能当通过） */
const clearGeometry = (): GeometryResult => ({ status: 'clear', highestLevel: 'aabb', pairs: [] })

function setup(options: { plan?: Plan; config?: Record<string, unknown> } = {}) {
  const model = createDirectorModel()
  model.on('planner', () => jsonReply(options.plan ?? defaultPlan()))
  const render = createFakeRender({ geometryResult: clearGeometry() })
  const ctx = createFakeWorkflowContext({
    model,
    render,
    ...(options.config ? { config: options.config as never } : {}),
  })
  const fp = fpOf(ctx.editorRead)
  const run = () =>
    createMainWorkflow().run(
      { runId: 'run-w05', request: '把两个区整理一下', partition: makeTwoRegionPartition(), sceneRevisionAtStart: 1 },
      ctx,
    )
  return { model, ctx, fp, run }
}

describe('W05 正常闭环（场景 1/2/3/4/5）', () => {
  it('两区四任务：baseline 先于一切写入、A 区失败后修正通过、同区第二任务各有 task_before、整轮一次通过', async () => {
    const { model, ctx, fp, run } = setup()

    scriptExecutor(model, {
      'task-n1': {
        rounds: [
          [{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) }],
          [],
          // 修正轮
          [{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-5.5, 0, -5.5]), expectedFingerprint: fp('tree-1') }) }],
          [],
        ],
      },
      'task-n2': {
        rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-2', transform: T([6, 0, -2]), expectedFingerprint: fp('tree-2') }) }], []],
      },
      'task-s1': {
        rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'house-1', transform: T([-3.5, 0, 4.5]), expectedFingerprint: fp('house-1') }) }], []],
      },
      'task-s2': {
        rounds: [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', name: '新增岩石', transform: T([5, 0, 6]) }) }], []],
      },
    })
    scriptJudge(model, {
      'task-n1': { verdicts: ['fail', 'pass'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
      'task-s2': { verdicts: ['pass'] },
    })

    // 记录"第一次写入发生时已有几条证据"
    let observationsAtFirstWrite = -1
    ctx.fakeEditor.subscribe(() => {
      if (observationsAtFirstWrite < 0) observationsAtFirstWrite = ctx.observations.size
    })

    const outcome = await run()
    expect(outcome.kind, JSON.stringify(outcome)).toBe('completed')
    if (outcome.kind !== 'completed') return

    // 场景 2：baseline 必须先于所有写入（第一条/第二条观测是两区 baseline）
    const phases = [...ctx.observations.values()].map(o => o.phase)
    expect(phases.slice(0, 2)).toEqual(['baseline', 'baseline'])
    expect(observationsAtFirstWrite).toBeGreaterThanOrEqual(2)

    // 场景 4：两个区各两个任务 → 各自 task_before；A 区 n1 判定两次（fail → 修正 → pass）
    expect(phases.filter(p => p === 'task_before').length).toBe(4)
    expect(phases.filter(p => p === 'after').length).toBe(5)
    expect(outcome.regions['region-north'].tasks.find(t => t.taskId === 'task-n1')?.verdicts.length).toBe(2)
    expect(outcome.regions['region-north'].tasks.find(t => t.taskId === 'task-n1')?.verdicts[0].status).toBe('fail')

    // 场景 3：最终场景符合脚本
    const assets = ctx.fakeEditor.snapshot({})
    expect(assets.assets.find(a => a.id === 'tree-1')?.transform.position).toEqual([-5.5, 0, -5.5])
    expect(assets.assets.find(a => a.id === 'tree-2')?.transform.position).toEqual([6, 0, -2])
    expect(assets.assets.find(a => a.id === 'house-1')?.transform.position).toEqual([-3.5, 0, 4.5])
    expect(assets.assets.filter(a => a.ref === 'models/rock').length).toBe(2)

    // add 任务确实创建了对象（回执进了 TaskResult）
    const s2 = outcome.regions['region-south'].tasks.find(t => t.taskId === 'task-s2')
    expect(s2?.createdObjectIds.length).toBe(1)
    expect(outcome.plan.tasks.length).toBe(4)

    // 终检：通过且检查项覆盖两个区与四任务
    expect(outcome.finalCheck.passed).toBe(true)
    expect(outcome.finalCheck.checks.filter(c => c.name.startsWith('region:')).every(c => c.passed)).toBe(true)

    // 事件顺序：plan.ready 在 baseline.ready 之前，baseline 在 task.started 之前
    const types = ctx.events.map(e => e.type)
    expect(types.indexOf('plan.ready')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('plan.ready')).toBeLessThan(types.indexOf('baseline.ready'))
    expect(types.indexOf('baseline.ready')).toBeLessThan(types.indexOf('task.started'))
  })
})

describe('W05 失败路径', () => {
  it('场景 6：B 区终局失败 → 整轮 rolled_back，A 区已完成修改一并回滚（runtime 真实事务）', async () => {
    const model = createDirectorModel()
    model.on('planner', () => jsonReply(defaultPlan()))
    const editor = createFakeEditor({ sceneId: 'scene-fixture', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
    const render = createFakeRender({ geometryResult: clearGeometry() })
    const runtime = createRuntime({
      editor: { read: editor, write: editor },
      modelPort: model,
      partitionProvider: () => makeTwoRegionPartition(),
      workflowFactory: () => createMainWorkflow(),
      config: { maxRepairsPerTask: 1 },
    })
    runtime.registerRenderPort(render)

    const fp = fpOf(editor)
    scriptExecutor(model, {
      'task-n1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) }], []] },
      'task-n2': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-2', transform: T([6, 0, -2]), expectedFingerprint: fp('tree-2') }) }], []] },
      'task-s1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'house-1', transform: T([-3.5, 0, 4.5]), expectedFingerprint: fp('house-1') }) }], []] },
      'task-s2': { rounds: [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', transform: T([5, 0, 6]) }) }], []] },
    })
    scriptJudge(model, {
      'task-n1': { verdicts: ['pass'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
      'task-s2': { verdicts: ['fail', 'fail'] }, // 修正一轮后仍失败 → 南区终局失败
    })

    const result = await runtime.start('两个区都整理')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('rolled_back')

    const st = editor.state()
    expect(st.rolledBackRuns).toBe(1)
    expect(st.committedRuns).toBe(0)
    // A 区的修改被回滚
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
    expect(editor.snapshot({ objectIds: ['tree-2'] }).assets[0].transform.position).toEqual([2, 0, -5])
    expect(editor.snapshot({}).assets.filter(a => a.ref === 'models/rock').length).toBe(1)
    expect(st.savedVersions).toEqual([])
  })

  it('场景 5：正常一轮只 commit 一次、只 save 一次', async () => {
    const model = createDirectorModel()
    model.on('planner', () => jsonReply(defaultPlan()))
    const editor = createFakeEditor({ sceneId: 'scene-fixture', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
    const runtime = createRuntime({
      editor: { read: editor, write: editor },
      modelPort: model,
      partitionProvider: () => makeTwoRegionPartition(),
      workflowFactory: () => createMainWorkflow(),
    })
    runtime.registerRenderPort(createFakeRender({ geometryResult: clearGeometry() }))

    const fp = fpOf(editor)
    scriptExecutor(model, {
      'task-n1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) }], []] },
      'task-n2': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-2', transform: T([6, 0, -2]), expectedFingerprint: fp('tree-2') }) }], []] },
      'task-s1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'house-1', transform: T([-3.5, 0, 4.5]), expectedFingerprint: fp('house-1') }) }], []] },
      'task-s2': { rounds: [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', transform: T([5, 0, 6]) }) }], []] },
    })
    scriptJudge(model, {
      'task-n1': { verdicts: ['pass'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
      'task-s2': { verdicts: ['pass'] },
    })

    const result = await runtime.start('两个区都整理')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('completed')
    expect(editor.state().committedRuns).toBe(1)
    expect(editor.state().savedVersions).toEqual([1])
  })

  it('并发上限：modelConcurrency=1 时两区并行也只发一个模型请求（scheduler semaphore）', async () => {
    const director = createDirectorModel()
    director.on('planner', () => jsonReply(defaultPlan()))
    let inFlight = 0
    let peak = 0
    const observed = {
      async complete(req: ModelRequest, signal: AbortSignal) {
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          await new Promise(r => setTimeout(r, 15))
          return await director.complete(req, signal)
        } finally {
          inFlight--
        }
      },
    }

    const editor = createFakeEditor({ sceneId: 'scene-fixture', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
    const runtime = createRuntime({
      editor: { read: editor, write: editor },
      modelPort: observed,
      partitionProvider: () => makeTwoRegionPartition(),
      workflowFactory: () => createMainWorkflow(),
      config: { modelConcurrency: 1 },
    })
    runtime.registerRenderPort(createFakeRender({ geometryResult: clearGeometry() }))

    const fp = fpOf(editor)
    scriptExecutor(director, {
      'task-n1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) }], []] },
      'task-n2': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-2', transform: T([6, 0, -2]), expectedFingerprint: fp('tree-2') }) }], []] },
      'task-s1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'house-1', transform: T([-3.5, 0, 4.5]), expectedFingerprint: fp('house-1') }) }], []] },
      'task-s2': { rounds: [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', transform: T([5, 0, 6]) }) }], []] },
    })
    scriptJudge(director, {
      'task-n1': { verdicts: ['pass'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
      'task-s2': { verdicts: ['pass'] },
    })

    const result = await runtime.start('并发受限验证')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('completed')
    expect(peak).toBe(1)
  })

  it('schema 错误计划：不进入执行、不产生写入、返回 invalid_plan', async () => {
    const bad = { schemaVersion: 1, kind: 'tasks', assumptions: [], tasks: [{ schemaVersion: 1, id: 'task-x' }] }
    const { model, ctx, run } = setup({ plan: bad as never, config: { schemaRepairAttempts: 0 } })
    const outcome = await run()
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') expect(outcome.reason.code).toBe('invalid_plan')
    expect(model.count('executor')).toBe(0)
    expect(ctx.observations.size).toBe(0)
    expect(ctx.fakeEditor.snapshot({}).assets.length).toBe(5)
  })

  it('越权工具：写邻区/只读对象被工具层拒绝，整轮不通过且对象未变', async () => {
    const { model, ctx, fp, run } = setup({ config: { maxRepairsPerTask: 0 } })
    scriptExecutor(model, {
      'task-n1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'road-1', transform: T([9, 0, 9]), expectedFingerprint: fp('road-1') }) }], []] },
      'task-n2': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-2', transform: T([6, 0, -2]), expectedFingerprint: fp('tree-2') }) }], []] },
      'task-s1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'house-1', transform: T([-3.5, 0, 4.5]), expectedFingerprint: fp('house-1') }) }], []] },
      'task-s2': { rounds: [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', transform: T([5, 0, 6]) }) }], []] },
    })
    scriptJudge(model, {
      'task-n1': { verdicts: ['fail'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
      'task-s2': { verdicts: ['pass'] },
    })

    const outcome = await run()
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') expect(outcome.reason.code).toBe('write_failed')
    // road-1 是 globalReadonly：工具层直接拒绝，场景未变
    expect(ctx.fakeEditor.snapshot({ objectIds: ['road-1'] }).assets[0].transform.position).toEqual([0, 0, 0])
    // 拒绝原因确实回灌给了模型（toolResult 里是 out_of_scope，而不是静默失败）
    const toolResults = model.requests
      .flatMap(r => r.messages)
      .filter(m => m.role === 'toolResult')
      .map(m => JSON.stringify((m as { content: unknown }).content))
    expect(toolResults.some(t => t.includes('out_of_scope'))).toBe(true)
  })

  /**
   * 真机实测（2026-10-22 T14）暴露的定位缺陷：
   * 区域子图是**并行**跑的，主图那个共享的 `stage` 变量会被后完成的区覆盖，
   * 于是失败信息指向的区可能根本不是出错的那个区（当时报「南侧建筑带」，
   * 实际错的是北区的任务）。修复：区域子图抛出的错误自带 regionId，主图优先用它。
   */
  it('北区任务超预算 → 失败信息必须指向 region-north（并行下也不能被别的区覆盖）', async () => {
    const { model, fp, run } = setup({ config: { maxRepairsPerTask: 0 } })
    // task-n1 一直调工具不收尾 → 6 轮后 budget_exceeded
    const spin = Array.from({ length: 8 }, () => [
      { name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) },
    ])
    scriptExecutor(model, {
      'task-n1': { rounds: spin },
      'task-n2': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-2', transform: T([6, 0, -2]), expectedFingerprint: fp('tree-2') }) }], []] },
      'task-s1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'house-1', transform: T([-3.5, 0, 4.5]), expectedFingerprint: fp('house-1') }) }], []] },
      'task-s2': { rounds: [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', transform: T([5, 0, 6]) }) }], []] },
    })
    scriptJudge(model, {
      'task-n1': { verdicts: ['pass'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
      'task-s2': { verdicts: ['pass'] },
    })

    const outcome = await run()
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind !== 'rolled_back') return
    expect(outcome.reason.code).toBe('budget_exceeded')
    // 关键断言：定位到真正出错的区，而不是并行下被覆盖的最后一个区
    expect(String(outcome.reason.details?.stage)).toContain('region-north')
    expect(String(outcome.reason.details?.stage)).not.toContain('region-south')
  })

  it('错误证据 ID：判定引用不存在的 observation → 不可信，按 fail 处理，整轮不通过', async () => {    const { model, fp, run } = setup({ config: { maxRepairsPerTask: 0 } })
    scriptExecutor(model, {
      'task-n1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) }], []] },
      'task-n2': { rounds: [[], []] },
      'task-s1': { rounds: [[], []] },
      'task-s2': { rounds: [[], []] },
    })
    scriptJudge(model, {
      'task-n1': { verdicts: ['bad-evidence'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
      'task-s2': { verdicts: ['pass'] },
    })

    const outcome = await run()
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') {
      // 走的是"区域未通过"的流程失败，而不是内部异常收口
      expect(outcome.reason.code).toBe('write_failed')
      expect(outcome.reason.message).toContain('未通过')
    }
  })

  it('T17 最终一致性：后任务破坏前任务的 metric 条件（仍在同一区内）→ finalCheck 不通过、整轮回滚', async () => {
    const plan = planOf([
      task({
        id: 'task-n1',
        regionId: 'region-north',
        targetObjectIds: ['tree-1'],
        criteria: [
          { id: 'crit-n1-distance', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'gte', value: 5, unit: 'm' },
          { id: 'crit-n1-visual', kind: 'visual', description: '两棵树都完整位于北林地内' },
        ],
      }),
      // 第二个任务把 tree-1 挪到 tree-2 旁边：仍在北区内（写前检查会放行），但破坏 n1 的间距条件
      task({ id: 'task-n2', regionId: 'region-north', targetObjectIds: ['tree-1'] }),
      task({ id: 'task-s1', regionId: 'region-south', targetObjectIds: ['house-1'] }),
    ])
    const { model, fp, run } = setup({ plan })

    scriptExecutor(model, {
      'task-n1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([-6, 0, -6]), expectedFingerprint: fp('tree-1') }) }], []] },
      'task-n2': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'tree-1', transform: T([1, 0, -5]), expectedFingerprint: fp('tree-1') }) }], []] },
      'task-s1': { rounds: [[{ name: 'edit.transform', args: () => ({ objectId: 'house-1', transform: T([-3.5, 0, 4.5]), expectedFingerprint: fp('house-1') }) }], []] },
    })
    scriptJudge(model, {
      'task-n1': { verdicts: ['pass'] },
      'task-n2': { verdicts: ['pass'] },
      'task-s1': { verdicts: ['pass'] },
    })

    const outcome = await run()
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') {
      expect(outcome.reason.code).toBe('write_failed')
      expect(outcome.reason.message).toContain('min_pair_distance_xz')
    }
  })
})
