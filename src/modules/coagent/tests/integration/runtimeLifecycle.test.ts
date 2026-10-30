/**
 * runtime 生命周期与解锁（W03）：SPEC §3.1（StrictMode/重复启停不重复订阅）、
 * §5.4（rollback 失败 → error_locked → 人工 reset）、§5.2（工具排队 = 场景队列）
 * 以及"结束后迟到写入一律拒绝"。
 */

import { describe, expect, it, vi } from 'vitest'
import type { EditReceipt, PartitionSnapshot, RunInput, RunOutcome, TasksPlan, ToolResult, WorkflowContext, WorkflowRunner } from '../../contracts'
import { createRuntime } from '../../runtime/createRuntime'
import { createFakeEditor } from '../fakes/FakeEditor'
import { createKnownTransformWorkflow } from '../fakes/fakeWorkflow'
import { TWO_REGION_ASSETS, TWO_REGION_CATALOG, makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const T = (position: [number, number, number]) => ({
  position,
  rotationDeg: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
})

const STEPS = [
  { regionId: 'region-north', objectId: 'tree-1', transform: T([-6, 0, -6]) },
  { regionId: 'region-north', objectId: 'tree-2', transform: T([6, 0, -2]) },
]

const completed: RunOutcome = {
  kind: 'completed',
  summary: '自定义 runner 完成',
  plan: { schemaVersion: 1, kind: 'tasks', assumptions: [], tasks: [] },
  regions: {},
  finalCheck: { passed: true, checkedAt: new Date().toISOString(), checks: [] },
}

function setup(opts: { rollbackFails?: boolean; workflow?: (captured: { ctx: WorkflowContext | null }) => WorkflowRunner } = {}) {
  const editor = createFakeEditor({ sceneId: 'scene-fixture', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
  const disposed = vi.fn()
  const write = opts.rollbackFails ? { ...editor, rollbackRun: () => false } : editor
  const captured: { ctx: WorkflowContext | null } = { ctx: null }
  const runtime = createRuntime({
    editor: { read: editor, write, dispose: disposed },
    workflowFactory: () => opts.workflow?.(captured) ?? createKnownTransformWorkflow({ steps: STEPS }),
    partitionProvider: () => makeTwoRegionPartition(),
  })
  return { editor, runtime, disposed, captured }
}

describe('error_locked 与人工解锁（§5.4）', () => {
  it('rollback 失败 → error_locked：新 run 被拒，reset 后恢复可用并留下 runtime.reset 事件', async () => {
    const { runtime } = setup({ rollbackFails: true, workflow: () => createKnownTransformWorkflow({ steps: STEPS, failAtStep: 1 }) })
    const first = await runtime.start('会回滚失败')
    expect(first.ok).toBe(true)
    expect(runtime.phase()).toBe('error_locked')
    expect(runtime.locked()).toBe(true)

    const blocked = await runtime.start('锁定期间再试')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe('run_busy')

    const reset = runtime.reset()
    expect(reset.ok).toBe(true)
    expect(runtime.phase()).toBe('idle')
    expect(runtime.locked()).toBe(false)
    expect(runtime.recorder.events().map(e => e.type)).toContain('runtime.reset')

    const again = await runtime.start('解锁后重来')
    expect(again.ok).toBe(true)
  })

  it('无锁定时 reset 明确报错（不假装成功）', () => {
    const { runtime } = setup()
    const r = runtime.reset()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_plan')
  })

  it('活跃 run 中 reset 被拒绝，run 不受影响', async () => {
    const { runtime } = setup({
      workflow: () => createKnownTransformWorkflow({ steps: [{ ...STEPS[0], delayMs: 120 }, STEPS[1]] }),
    })
    const pending = runtime.start('进行中')
    await new Promise(r => setTimeout(r, 40))
    const r = runtime.reset()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('run_busy')
    await pending
    expect(runtime.phase()).toBe('completed')
  })

  it('禁用（requestDisable）后重新 enable：锁定态仍然可见，不会被伪装成空闲', async () => {
    const { runtime } = setup({ rollbackFails: true, workflow: () => createKnownTransformWorkflow({ steps: STEPS, failAtStep: 0 }) })
    await runtime.start('回滚失败')
    expect(runtime.phase()).toBe('error_locked')
    await runtime.requestDisable()
    expect(runtime.phase()).toBe('disabled')
    runtime.enable()
    expect(runtime.phase()).toBe('error_locked')
    expect(runtime.locked()).toBe(true)
    expect((await runtime.start('仍被锁')).ok).toBe(false)
  })
})

describe('清理路径与生命周期（T16 雏形）', () => {
  it('dispose：退订相位监听、释放 editor、拒绝再 start，且重复调用无副作用', async () => {
    const { runtime, disposed } = setup()
    const off = runtime.onPhase(() => undefined)
    expect(runtime.diagnostics()).toEqual({ phaseListeners: 1, disposed: false })
    off()
    expect(runtime.diagnostics().phaseListeners).toBe(0)

    runtime.onPhase(() => undefined)
    runtime.dispose()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(runtime.diagnostics()).toEqual({ phaseListeners: 0, disposed: true })

    runtime.dispose()
    expect(disposed).toHaveBeenCalledTimes(1)

    const r = await runtime.start('已释放')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('run_busy')
  })

  it('反复订阅/退订不增长监听数（StrictMode 双挂载等价路径）', () => {
    const { runtime } = setup()
    for (let i = 0; i < 5; i++) {
      const off = runtime.onPhase(() => undefined)
      off()
    }
    expect(runtime.diagnostics().phaseListeners).toBe(0)
  })
})

describe('写入排队与迟到写入', () => {
  it('两次并发 applyWrite 经场景队列串行落盘（工具排队不丢写）', async () => {
    const order: string[] = []
    const { editor, runtime } = setup({
      workflow: () => ({
        async run(_input: RunInput, ctx: WorkflowContext): Promise<RunOutcome> {
          editor.subscribe(c => {
            for (const id of c.changedObjectIds ?? []) order.push(id)
          })
          const fp = (id: string) => ctx.editorRead.snapshot({ objectIds: [id] }).assets[0].fingerprint
          const results = await Promise.all([
            ctx.applyWrite(
              { kind: 'transform', objectId: 'tree-1', transform: T([1, 0, 1]), expectedFingerprint: fp('tree-1') },
              { taskId: null, toolCallId: 'parallel-1', regionId: 'region-north' },
            ),
            ctx.applyWrite(
              { kind: 'transform', objectId: 'tree-2', transform: T([2, 0, 2]), expectedFingerprint: fp('tree-2') },
              { taskId: null, toolCallId: 'parallel-2', regionId: 'region-north' },
            ),
          ])
          return results.every(r => r.ok) ? completed : { kind: 'rolled_back', reason: { code: 'write_failed', message: '并发写失败', retryable: false } }
        },
      }),
    })
    const r = await runtime.start('并发写')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.kind).toBe('completed')
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([1, 0, 1])
    expect(editor.snapshot({ objectIds: ['tree-2'] }).assets[0].transform.position).toEqual([2, 0, 2])
    expect(order).toEqual(['tree-1', 'tree-2'])
  })

  it('run 结束（已 commit）后工作流再写 → write_failed，且场景不变', async () => {
    const { editor, runtime, captured } = setup({ workflow: () => ({ run: async (_i, ctx) => { captured.ctx = ctx; return completed } }) })
    await runtime.start('什么都不写')
    expect(runtime.phase()).toBe('completed')

    const late = await captured.ctx!.applyWrite(
      { kind: 'transform', objectId: 'tree-1', transform: T([9, 9, 9]), expectedFingerprint: 'whatever' },
      { taskId: null, toolCallId: 'late-1', regionId: null },
    )
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.error.code).toBe('write_failed')
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
  })

  it('requestDisable 之后工作流残留引用再写 → 被拒；资产恢复原状', async () => {
    const { editor, runtime, captured } = setup({
      workflow: () => ({
        run: async (_i, ctx) => {
          captured.ctx = ctx
          await ctx.applyWrite(
            { kind: 'transform', objectId: 'tree-1', transform: T([4, 0, 4]), expectedFingerprint: ctx.editorRead.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint },
            { taskId: null, toolCallId: 'during-1', regionId: 'region-north' },
          )
          await new Promise(r => setTimeout(r, 300))
          return ctx.signal.aborted ? { kind: 'cancelled' } : completed
        },
      }),
    })
    const pending = runtime.start('会被禁用打断')
    await new Promise(r => setTimeout(r, 60))
    await runtime.requestDisable()
    await pending
    expect(runtime.phase()).toBe('disabled')
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])

    const late = await captured.ctx!.applyWrite(
      { kind: 'transform', objectId: 'tree-1', transform: T([7, 7, 7]), expectedFingerprint: 'x' },
      { taskId: null, toolCallId: 'late-2', regionId: null },
    )
    expect(late.ok).toBe(false)
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
  })
})

describe('recorder 订阅（UI 计数）', () => {
  it('append 触发订阅者，退订后不再收到', async () => {
    const { runtime } = setup()
    const seen: string[] = []
    const off = runtime.recorder.subscribe(e => seen.push(e.type))
    await runtime.start('一次完成')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toBe('run.started')
    const before = seen.length
    off()
    await runtime.start('第二次')
    expect(seen.length).toBe(before)
  })
})

/**
 * T0-5：分区的场景归属。
 *
 * 原实现从不监听 scene:changed，切场景后仍返回上一场景的分区，
 * 于是能用错误的边界启动 run（权限判定建在错的区域上）。
 */
describe('T0-5 场景切换必须作废分区', () => {
  it('切场景后 partition() 变为 null，并通知分区订阅者', () => {
    const editor = createFakeEditor({ sceneId: 'scene-a', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
    const runtime = createRuntime({ editor: { read: editor, write: editor } })
    const seen: Array<PartitionSnapshot | null> = []
    runtime.onPartition(p => seen.push(p))

    runtime.debugSetPartition(makeTwoRegionPartition())
    expect(runtime.partition()).not.toBeNull()

    editor.simulateSceneSwitch('scene-b', TWO_REGION_ASSETS)

    expect(runtime.partition()).toBeNull()
    expect(seen.at(-1)).toBeNull()
    runtime.dispose()
  })

  it('同一场景的对象级变更不误清分区', () => {
    const editor = createFakeEditor({ sceneId: 'scene-a', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
    const runtime = createRuntime({ editor: { read: editor, write: editor } })
    runtime.debugSetPartition(makeTwoRegionPartition())

    const fingerprint = editor.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint
    const token = editor.beginRun('测试写')
    const receipt = editor.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: T([-6, 0, -3]), expectedFingerprint: fingerprint },
      { runId: 'run-x', taskId: null, toolCallId: 'c1', token, writableObjectIds: new Set(['tree-1']) },
    )
    editor.endRun(token)

    expect(receipt.ok).toBe(true)
    expect(runtime.partition()).not.toBeNull()
    runtime.dispose()
  })

  it('本来就没有分区时，切场景不会产生多余的分区通知', () => {
    const editor = createFakeEditor({ sceneId: 'scene-a', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
    const runtime = createRuntime({ editor: { read: editor, write: editor } })
    const seen: Array<PartitionSnapshot | null> = []
    runtime.onPartition(p => seen.push(p))

    editor.simulateSceneSwitch('scene-b', TWO_REGION_ASSETS)

    expect(seen).toEqual([])
    runtime.dispose()
  })
})

/**
 * P1：新增名额必须在**真实写路径**上生效。
 *
 * 这是样本日志"两栋变四栋"的直接回归：第二轮修复若再 add，会被程序拒绝而不是默默多建。
 */
describe('P1 新增名额（runController 写路径）', () => {
  const planFor = (): TasksPlan => ({
    schemaVersion: 1,
    kind: 'tasks',
    assumptions: ['P1 名额测试'],
    tasks: [
      {
        schemaVersion: 1,
        id: 'task-add',
        regionId: 'region-north',
        objective: '新增两栋',
        targetObjectIds: [],
        allowedOperations: ['add'],
        criteria: [{ id: 'c1', kind: 'visual', description: '看起来合理' }],
        constraints: [{ kind: 'stay_in_region' }],
        dependsOn: [],
        creationTarget: { minCount: 2, maxCount: 2 },
      },
    ],
  })

  it('第三次新增被拒（task_creation_limit），场景只多两个对象', async () => {
    const results: Array<ToolResult<EditReceipt>> = []
    const { runtime, editor } = setup({
      workflow: () => ({
        async run(_input: RunInput, ctx: WorkflowContext): Promise<RunOutcome> {
          ctx.runState.registerTasks(planFor().tasks)
          for (let i = 0; i < 3; i++) {
            results.push(
              await ctx.applyWrite(
                { kind: 'add', ref: 'models/rock', name: `岩石${i}`, transform: T([i * 3, 0, 0]) },
                { taskId: 'task-add', toolCallId: `c${i}`, regionId: 'region-north' },
              ),
            )
          }
          return completed
        },
      }),
    })

    const before = editor.state().assetCount
    const outcome = await runtime.start('在雪原加两栋')

    expect(outcome.ok).toBe(true)
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(true)
    expect(results[2].ok).toBe(false)
    if (!results[2].ok) {
      expect(results[2].error.code).toBe('task_creation_limit')
      expect(results[2].error.message).toContain('名额已用尽')
    }
    expect(editor.state().assetCount).toBe(before + 2)
  })

  it('被拒的写入留下 write.rejected 事件（便于对账）', async () => {
    const { runtime } = setup({
      workflow: () => ({
        async run(_input: RunInput, ctx: WorkflowContext): Promise<RunOutcome> {
          ctx.runState.registerTasks(planFor().tasks)
          for (let i = 0; i < 3; i++) {
            await ctx.applyWrite(
              { kind: 'add', ref: 'models/rock', transform: T([i * 3, 0, 0]) },
              { taskId: 'task-add', toolCallId: `c${i}`, regionId: 'region-north' },
            )
          }
          return completed
        },
      }),
    })

    await runtime.start('加两栋')
    const rejected = runtime.recorder.events().filter(e => e.type === 'write.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0].payload).toMatchObject({ code: 'task_creation_limit', command: 'add' })
  })

  it('删除一个后可以再建一个（释放名额）', async () => {
    const results: Array<ToolResult<EditReceipt>> = []
    const { runtime, editor } = setup({
      workflow: () => ({
        async run(_input: RunInput, ctx: WorkflowContext): Promise<RunOutcome> {
          ctx.runState.registerTasks(planFor().tasks)
          const add = async (i: number): Promise<void> => {
            results.push(
              await ctx.applyWrite(
                { kind: 'add', ref: 'models/rock', transform: T([i * 3, 0, 0]) },
                { taskId: 'task-add', toolCallId: `a${i}`, regionId: 'region-north' },
              ),
            )
          }
          await add(0)
          await add(1)
          const second = results[1]
          if (second.ok) {
            results.push(
              await ctx.applyWrite(
                { kind: 'remove', objectId: second.data.objectId, expectedFingerprint: second.data.fingerprintAfter },
                { taskId: 'task-add', toolCallId: 'r0', regionId: 'region-north' },
              ),
            )
          }
          await add(2)
          return completed
        },
      }),
    })

    const before = editor.state().assetCount
    await runtime.start('删一个再建一个')

    expect(results.map(r => r.ok)).toEqual([true, true, true, true])
    expect(editor.state().assetCount).toBe(before + 2)
  })
})

// 类型守卫：确保 ToolResult 与 RunOutcome 的联合形状未被测试误用
const _typecheck: (r: ToolResult<RunOutcome>) => void = () => undefined
void _typecheck
