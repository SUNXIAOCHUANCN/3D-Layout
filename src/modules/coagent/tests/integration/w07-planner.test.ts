/**
 * W07 集成：真实规划器的"只读工具 + 精简上下文 + 分层校验 + 澄清/不支持"通路。
 *
 * 用 director 模拟模型：先调只读工具核对事实，再输出计划；错误计划必须被同一套
 * 校验拒掉（没有"真实模型免校验"分支）。
 */

import { describe, expect, it } from 'vitest'
import type { Plan, RunInput, TasksPlan, UnitTask } from '../../contracts'
import { CoAgentError } from '../../contracts'
import { createRuntime } from '../../runtime/createRuntime'
import { makePlan } from '../../agents/planner'
import { buildPlannerContext } from '../../agents/plannerContext'
import { executorTaskText, SYSTEM_PLANNER } from '../../agents/prompts'
import { composeClarifiedRequest, isUsableAnswer } from '../../clarify'
import { createToolRegistry } from '../../tools/registry'
import { createMainWorkflow } from '../../workflow/mainGraph'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { createFakeEditor } from '../fakes/FakeEditor'
import { createFakeRender } from '../fakes/FakeRender'
import { createDirectorModel, jsonReply, toolReply, type DirectorModel } from '../fakes/directorModel'
import { TWO_REGION_ASSETS, TWO_REGION_CATALOG, makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const task = (over: Partial<UnitTask> & { id: string; regionId: string }): UnitTask => ({
  schemaVersion: 1,
  objective: '把北树一往西挪一点',
  targetObjectIds: ['tree-1'],
  allowedOperations: ['transform'],
  criteria: [{ id: 'c1', kind: 'visual', description: '两棵树间距变大' }],
  constraints: [{ kind: 'stay_in_region' }],
  dependsOn: [],
  ...over,
})

const goodPlan: TasksPlan = { schemaVersion: 1, kind: 'tasks', assumptions: ['按 1 米调整'], tasks: [task({ id: 'task-n1', regionId: 'region-north' })] }

function plannerInput(model: DirectorModel, over: Partial<Parameters<typeof makePlan>[0]> = {}) {
  const ctx = createFakeWorkflowContext({ model })
  const registry = createToolRegistry(ctx, { maxCallsPerTask: 10 })
  const assets = ctx.editorRead.snapshot({}).assets
  const partition = makeTwoRegionPartition()
  const bundle = buildPlannerContext({ request: '把北边林地拉稀疏一点', partition, assets, catalog: [] })
  return {
    ctx,
    args: {
      runId: 'run-w07',
      model,
      signal: new AbortController().signal,
      config: ctx.config,
      registry,
      contextText: bundle.text,
      partition,
      assets,
      ...over,
    } as Parameters<typeof makePlan>[0],
  }
}

describe('W07 规划器：只读工具 + 结构化输出', () => {
  it('先调只读工具核对对象，再输出计划；工具清单里没有写工具', async () => {
    const director = createDirectorModel()
    director.on('planner', (_req, i) =>
      i === 0
        ? toolReply('先核对一下对象', [{ name: 'scene.get_objects', args: { objectIds: ['tree-1'] }, id: 'p-call-1' }])
        : jsonReply(goodPlan),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan(args)

    expect(plan.kind).toBe('tasks')
    expect((plan as TasksPlan).tasks.length).toBe(1)

    const first = director.requests[0]
    const toolNames = first.tools.map(t => t.name)
    expect(toolNames).toContain('scene.get_objects')
    expect(toolNames.some(n => n.startsWith('edit.'))).toBe(false) // main 角色没有写工具
    // 工具结果确实回灌给了模型
    const second = director.requests.find(r => r.messages.some(m => m.role === 'toolResult'))
    expect(second).toBeTruthy()
  }, 15_000)

  it('编造对象 id → 同一套语义校验拒绝（invalid_plan）', async () => {
    const director = createDirectorModel()
    director.on('planner', () => jsonReply({ ...goodPlan, tasks: [task({ id: 't1', regionId: 'region-north', targetObjectIds: ['tree-404'] })] }))
    const { args } = plannerInput(director, { limits: { maxTasks: 8, maxTargetsPerTask: 6, maxObjectiveChars: 300 } })
    const err = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 0 } }).catch(e => e)
    expect(err.code).toBe('invalid_plan')
    expect(String(err.message)).toContain('不存在于当前场景')
  })

  it('threshold 超出场景尺度 → 拒绝', async () => {
    const director = createDirectorModel()
    const bad = {
      ...goodPlan,
      tasks: [
        task({
          id: 't1',
          regionId: 'region-north',
          criteria: [{ id: 'c1', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'gte', value: 500, unit: 'm' }],
        }),
      ],
    }
    director.on('planner', () => jsonReply(bad))
    const { args } = plannerInput(director)
    const err = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 0 } }).catch(e => e)
    expect(err.code).toBe('invalid_plan')
    expect(String(err.message)).toContain('超过场景尺度')
  })
})

describe('W07 空任务计划：引导模型改为澄清', () => {
  it('第一次返回空 tasks → 修复提示要求改为 clarify；模型照做后返回 clarify', async () => {
    const director = createDirectorModel()
    director.on('planner', (_req, i) =>
      i === 0
        ? jsonReply({ schemaVersion: 1, kind: 'tasks', assumptions: [], tasks: [] })
        : jsonReply({ schemaVersion: 1, kind: 'clarify', question: '“乱一点”具体指什么程度？', options: ['随机偏移 0.5 米内', '随机偏移 1~2 米'] }),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan(args)
    expect(plan.kind).toBe('clarify')
    if (plan.kind === 'clarify') expect(plan.options.length).toBe(2)
    // 第二次请求（修复轮）里必须明确告诉模型"可以/应该返回 clarify"
    const second = director.requests[1]
    const text = second.messages.map(m => ('text' in m ? m.text : '')).join('\n')
    expect(text).toContain('clarify')
    expect(text).toContain('tasks 不能为空')
  })

  it('模型两次都给空 tasks → 失败消息里给出可操作提示（改成可量化要求）', async () => {
    const director = createDirectorModel()
    director.on('planner', () => jsonReply({ schemaVersion: 1, kind: 'tasks', assumptions: [], tasks: [] }))
    const { args } = plannerInput(director)
    const err = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 0 } }).catch(e => e)
    expect(err.code).toBe('invalid_plan')
    expect(String(err.message)).toContain('至少一个任务')
    expect(String(err.message)).toContain('可量化')
  })
})

describe('W07 诊断：失败要能定位到阶段', () => {
  it('规划阶段模型报错 → rolled_back 带 stage=planner 与原始消息', async () => {
    const director = createDirectorModel()
    director.on('planner', () => {
      throw new CoAgentError('model_protocol_error', '该模型/接口不支持函数调用（tools）')
    })
    const ctx = createFakeWorkflowContext({ model: director })
    const outcome = await createMainWorkflow().run(
      { runId: 'run-w07', request: '把林地拉稀疏一点', partition: makeTwoRegionPartition(), sceneRevisionAtStart: 1 },
      ctx,
    )
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') {
      expect(outcome.reason.code).toBe('model_protocol_error')
      expect(outcome.reason.details?.stage).toBe('planner')
      expect(outcome.reason.message).toContain('不支持函数调用')
    }
  })

  it('runtime 的 run.rolled_back 事件带上 code/message/stage（日志可诊断）', async () => {
    const director = createDirectorModel()
    director.on('planner', () => {
      throw new CoAgentError('model_protocol_error', '该模型/接口不支持函数调用（tools）')
    })
    const editor = createFakeEditor({ sceneId: 'scene-fixture', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
    const runtime = createRuntime({
      editor: { read: editor, write: editor },
      modelPort: director,
      partitionProvider: () => makeTwoRegionPartition(),
    })
    runtime.registerRenderPort(createFakeRender())

    const result = await runtime.start('把林地拉稀疏一点')
    expect(result.ok).toBe(true)
    const event = runtime.recorder.events().find(e => e.type === 'run.rolled_back')
    expect(event?.payload).toMatchObject({ reason: 'model_protocol_error', stage: 'planner' })
    expect(String(event?.payload.message)).toContain('不支持函数调用')
  })
})

describe('W07 计划形状归一化（真实模型常见偏差）', () => {
  it('任务省略 schemaVersion/dependsOn/constraints → 归一化后通过（不放松语义校验）', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [
          {
            id: 'task-n1',
            regionId: 'region-north',
            objective: '把北树一往西挪一点',
            targetObjectIds: ['tree-1'],
            allowedOperations: ['transform'],
            criteria: [{ id: 'c1', kind: 'visual', description: '北树一在区内' }],
          },
        ],
      }),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan(args)
    expect(plan.kind).toBe('tasks')
    if (plan.kind !== 'tasks') return
    expect(plan.tasks[0].schemaVersion).toBe(1)
    expect(plan.tasks[0].dependsOn).toEqual([])
    expect(plan.tasks[0].constraints).toEqual([])
  })

  it('每个任务包在 {task:…} 里 → 解包后通过', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [{ task: task({ id: 'task-n1', regionId: 'region-north' }) }],
      }),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan(args)
    expect(plan.kind).toBe('tasks')
    if (plan.kind === 'tasks') expect(plan.tasks[0].id).toBe('task-n1')
  })

  it('整个计划包在 {plan:…} 里 → 解包后通过', async () => {
    const director = createDirectorModel()
    director.on('planner', () => jsonReply({ plan: goodPlan }))
    const { args } = plannerInput(director)
    const plan = await makePlan(args)
    expect(plan.kind).toBe('tasks')
    if (plan.kind === 'tasks') expect(plan.tasks[0].id).toBe('task-n1')
  })

  it('显式写错 schemaVersion 仍然拒绝（归一化不掩盖错误）', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [{ ...task({ id: 'task-n1', regionId: 'region-north' }), schemaVersion: 3 }],
      }),
    )
    const { args } = plannerInput(director)
    const err = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 0 } }).catch(e => e)
    expect(err.code).toBe('invalid_plan')
    expect(String(err.message)).toContain('schemaVersion')
  })

  /**
   * 真实模型实测（2026-10-22 T14，deepseek-flash）：
   * `计划连续 2 次不合格：tasks[0].criteria[0].unit 必须是非空字符串（如 m、count）`。
   * 根因是提示词只给了 visual 判据示例，metric 判据的 unit 从没被要求过。
   */
  it('metric 判据漏 unit → 按白名单指标补量纲（距离 m / 计数 count），计划通过', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [
          task({
            id: 'task-n1',
            regionId: 'region-north',
            criteria: [
              { id: 'c1', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'gte', value: 0.5 },
              { id: 'c2', kind: 'metric', metric: 'region.object_count', operator: 'gte', value: 2 },
            ] as unknown as UnitTask['criteria'],
          }),
        ],
      }),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan(args)
    expect(plan.kind).toBe('tasks')
    if (plan.kind !== 'tasks') return
    expect(plan.tasks[0].criteria[0]).toMatchObject({ unit: 'm' })
    expect(plan.tasks[0].criteria[1]).toMatchObject({ unit: 'count' })
  })

  it('模型自己写的 unit 不被覆盖；operator 写错仍然是 invalid_plan（归一化只补缺省）', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [
          task({
            id: 'task-n1',
            regionId: 'region-north',
            criteria: [
              { id: 'c1', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'roughly', value: 0.5, unit: '米' },
            ] as unknown as UnitTask['criteria'],
          }),
        ],
      }),
    )
    const { args } = plannerInput(director)
    const err = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 0 } }).catch(e => e)
    expect(err.code).toBe('invalid_plan')
    expect(String(err.message)).toContain('operator')
  })

  it('判据不合格时，修复轮给出 metric 判据的完整示例', async () => {
    const director = createDirectorModel()
    director.on('planner', (_req, index) =>
      index === 0
        ? jsonReply({
            schemaVersion: 1,
            kind: 'tasks',
            assumptions: [],
            tasks: [
              task({
                id: 'task-n1',
                regionId: 'region-north',
                criteria: [{ id: 'c1', kind: 'metric', metric: 'region.min_pair_distance_xz', value: 0.5 }] as unknown as UnitTask['criteria'],
              }),
            ],
          })
        : jsonReply(goodPlan),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 1 } })
    expect(plan.kind).toBe('tasks')
    const repair = director.requests.at(-1)?.messages.at(-1)
    const repairText = repair && 'text' in repair ? repair.text : ''
    expect(repairText).toContain('"kind":"metric"')
    expect(repairText).toContain('operator')
    expect(repairText).toContain('unit')
  })
})

/**
 * 2026-10-22 真机实测：用户跑「雪屋有点少，再摆几栋」失败于
 * `tasks[0].constraints[1].kind 未知约束类型 no_overlap_existing`。
 * 根因同 metric 判据那次：**提示词只举例了 stay_in_region，没给约束白名单**，
 * 模型自创了同义名，修复轮又无从纠正 → 两次机会用完 → invalid_plan。
 */
describe('W07 约束白名单（真实模型自创约束名的回归锁）', () => {
  it('同义名 no_overlap_existing 被归一化成 no_collision，计划通过', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [
          task({
            id: 'task-n1',
            regionId: 'region-north',
            constraints: [
              { kind: 'stay_in_region' },
              { kind: 'no_overlap_existing' },
            ] as unknown as UnitTask['constraints'],
          }),
        ],
      }),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan(args)
    expect(plan.kind).toBe('tasks')
    if (plan.kind !== 'tasks') return
    expect(plan.tasks[0].constraints.map(c => c.kind)).toEqual(['stay_in_region', 'no_collision'])
  })

  it('其余同义写法也归一化（keep_in_region / preserve_object_count）', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [
          task({
            id: 'task-n1',
            regionId: 'region-north',
            constraints: [
              { kind: 'keep_in_region' },
              { kind: 'preserve_object_count' },
            ] as unknown as UnitTask['constraints'],
          }),
        ],
      }),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan(args)
    expect(plan.kind).toBe('tasks')
    if (plan.kind !== 'tasks') return
    expect(plan.tasks[0].constraints.map(c => c.kind)).toEqual(['stay_in_region', 'preserve_count'])
  })

  it('**未知**约束名仍被拒（不猜语义），且错误信息列出白名单', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({
        schemaVersion: 1,
        kind: 'tasks',
        assumptions: [],
        tasks: [
          task({
            id: 'task-n1',
            regionId: 'region-north',
            constraints: [{ kind: 'totally_made_up' }] as unknown as UnitTask['constraints'],
          }),
        ],
      }),
    )
    const { args } = plannerInput(director)
    const err = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 0 } }).catch(e => e)
    expect(err.code).toBe('invalid_plan')
    expect(String(err.message)).toContain('stay_in_region')
    expect(String(err.message)).toContain('no_collision')
  })

  it('约束不合格时，修复轮给出 4 个白名单约束', async () => {
    const director = createDirectorModel()
    director.on('planner', (_req, index) =>
      index === 0
        ? jsonReply({
            schemaVersion: 1,
            kind: 'tasks',
            assumptions: [],
            tasks: [
              task({
                id: 'task-n1',
                regionId: 'region-north',
                constraints: [{ kind: 'totally_made_up' }] as unknown as UnitTask['constraints'],
              }),
            ],
          })
        : jsonReply(goodPlan),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 1 } })
    expect(plan.kind).toBe('tasks')
    const repair = director.requests.at(-1)?.messages.at(-1)
    const repairText = repair && 'text' in repair ? repair.text : ''
    expect(repairText).toContain('stay_in_region')
    expect(repairText).toContain('no_collision')
    expect(repairText).toContain('preserve_count')
    expect(repairText).toContain('preserve_objects')
  })

  it('系统提示词本身就列出 4 个白名单约束（预防性，不等模型犯错）', () => {
    const sys = SYSTEM_PLANNER
    for (const k of ['stay_in_region', 'no_collision', 'preserve_count', 'preserve_objects']) {
      expect(sys).toContain(k)
    }
  })

  /**
   * 2026-10-22 跑示例时又撞上同类问题：add 任务却列了 targetObjectIds
   * （`add 任务不应同时列 targetObjectIds`）。同样是提示词没讲清。
   */
  it('add 任务的 targetObjectIds 修复轮提示要改成空数组', async () => {
    const director = createDirectorModel()
    director.on('planner', (_req, index) =>
      index === 0
        ? jsonReply({
            schemaVersion: 1,
            kind: 'tasks',
            assumptions: [],
            tasks: [
              task({
                id: 'task-n1',
                regionId: 'region-north',
                allowedOperations: ['add'],
                targetObjectIds: ['tree-1'],
              }),
            ],
          })
        : jsonReply(goodPlan),
    )
    const { args } = plannerInput(director)
    const plan = await makePlan({ ...args, config: { ...args.config, schemaRepairAttempts: 1 } })
    expect(plan.kind).toBe('tasks')
    const repair = director.requests.at(-1)?.messages.at(-1)
    const repairText = repair && 'text' in repair ? repair.text : ''
    expect(repairText).toContain('targetObjectIds')
    expect(repairText).toContain('空数组')
  })

  it('系统提示词讲清 add 与 targetObjectIds 的自洽关系', () => {
    expect(SYSTEM_PLANNER).toContain('targetObjectIds')
    expect(SYSTEM_PLANNER).toContain('add')
  })
})

describe('clarify/unsupported', () => {
  const runInput = (): RunInput => ({
    runId: 'run-w07',
    request: '把那个挪一下',
    partition: makeTwoRegionPartition(),
    sceneRevisionAtStart: 1,
  })

  it('clarify 计划 → needs_clarification（携带问题与选项）', async () => {
    const director = createDirectorModel()
    director.on('planner', () =>
      jsonReply({ schemaVersion: 1, kind: 'clarify', question: '“那个”指哪个对象？', options: ['北树一', '北树二'] } satisfies Plan),
    )
    const ctx = createFakeWorkflowContext({ model: director })
    const outcome = await createMainWorkflow().run(runInput(), ctx)
    expect(outcome).toEqual({ kind: 'needs_clarification', question: '“那个”指哪个对象？', options: ['北树一', '北树二'] })
  })

  it('unsupported 计划 → rolled_back，原因原样带给用户', async () => {
    const director = createDirectorModel()
    director.on('planner', () => jsonReply({ schemaVersion: 1, kind: 'unsupported', reason: '暂不支持把对象搬到另一个区域' } satisfies Plan))
    const ctx = createFakeWorkflowContext({ model: director })
    const outcome = await createMainWorkflow().run(runInput(), ctx)
    expect(outcome.kind).toBe('rolled_back')
    if (outcome.kind === 'rolled_back') {
      expect(outcome.reason.code).toBe('invalid_plan')
      expect(outcome.reason.message).toContain('不支持该请求')
      expect(outcome.reason.message).toContain('暂不支持') // 原文保留
    }
  })
})

describe('executor 提示词：把基线直接交给模型', () => {
  it('包含 task_before 证据 id 与指纹（模型不必靠猜/多调一次工具）', () => {
    const text = executorTaskText({
      task: task({ id: 't1', regionId: 'region-north' }),
      regionObjectIds: ['tree-1', 'tree-2'],
      readonlyObjectIds: ['road-1'],
      baselineObservationId: 'obs-run-1-1',
      fingerprints: { 'tree-1': 'fp-1', 'tree-2': 'fp-2' },
    })
    expect(text).toContain('obs-run-1-1')
    expect(text).toContain('basisObservationId')
    expect(text).toContain('fp-1')
  })

  /**
   * 2026-10-22 真机实测：add 任务里执行器不知道该用哪个 ref，
   * 只能靠 library.search 反复猜关键词 → 6 轮预算耗尽 → budget_exceeded。
   * 修复：把模型库候选直接写进执行器上下文。
   */
  it('add 任务时把可新增的模型库候选交给模型（不必自己猜 ref）', () => {
    const text = executorTaskText({
      task: task({ id: 't1', regionId: 'region-north', allowedOperations: ['add'] }),
      regionObjectIds: [],
      readonlyObjectIds: [],
      catalog: [
        { ref: 'models/placeholder-box', name: '占位·方块', category: 'placeholder', dimensions: { w: 1, h: 1, d: 1 } },
      ],
    })
    expect(text).toContain('models/placeholder-box')
    expect(text).toContain('占位·方块')
    expect(text).toContain('不要自己猜名字')
  })

  it('没有 catalog 时不出现"可新增的模型库资产"这一行（不留空占位）', () => {
    const text = executorTaskText({
      task: task({ id: 't1', regionId: 'region-north' }),
      regionObjectIds: ['tree-1'],
      readonlyObjectIds: [],
    })
    expect(text).not.toContain('可新增的模型库资产')
  })
})

describe('澄清回答拼回原请求', () => {
  it('回答被标注为"补充说明"，空回答不可提交', () => {
    const composed = composeClarifiedRequest('把那个挪一下', '  北树二，往西 2 米 ')
    expect(composed.startsWith('把那个挪一下')).toBe(true)
    expect(composed).toContain('补充说明：北树二，往西 2 米')
    expect(isUsableAnswer('   ')).toBe(false)
    expect(isUsableAnswer('北树二')).toBe(true)
  })

  it('超长回答被截断，不会把请求撑爆', () => {
    const composed = composeClarifiedRequest('x', 'a'.repeat(5000))
    expect(composed.length).toBeLessThanOrEqual(1_200)
  })
})
