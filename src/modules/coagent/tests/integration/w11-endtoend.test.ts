/**
 * P5 端到端复现：把样本日志（2026-10-26 15:46:29）的失败链条编成回归测试。
 *
 * 原链条：
 *   1. 规划"新增两栋" → 首轮在别处加了两栋（撞山体）
 *   2. 判定看不清 + 碰撞失败
 *   3. **修复轮没有调整原来的两栋，而是在别处又加了两栋** → 32 个对象变 36 个
 *   4. 修复用尽 → 终检失败 → **整轮回滚**，用户一无所获
 *
 * 本轮修订后应当发生：
 *   1. 首轮建 2 栋（名额用尽）
 *   2. 判定失败 → 修复轮拿到"已创建 2 栋、还可新增 0"的实时状态
 *   3. 修复轮再 add → **被程序拒绝（task_creation_limit）**，且无场景副作用
 *   4. 修复用尽 → 结果**保留**（retained_with_issues），判据如实 fail
 *
 * 用 fake 模型驱动：证明的是**流程与不变量**，不是真实模型的布局质量。
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
    allowedOperations: ['add'],
    criteria: [{ id: `crit-${over.id}`, kind: 'visual', description: '房屋摆得自然、贴地' }],
    constraints: [{ kind: 'stay_in_region' }],
    dependsOn: [],
    ...over,
  }
}

function planOf(tasks: UnitTask[]): Plan {
  return { schemaVersion: 1, kind: 'tasks', assumptions: ['“几栋”取 2 栋'], tasks }
}

function textOf(req: ModelRequest): string {
  return req.messages
    .filter(m => m.role === 'user')
    .map(m => (m as { text: string }).text)
    .join('\n')
}

function parseTaskId(req: ModelRequest): string {
  const m = textOf(req).match(/"id"\s*:\s*"(task-[\w-]+)"/)
  if (!m) throw new Error('提示词里没有任务 id')
  return m[1]
}

/** 每任务按轮次给固定脚本；超出脚本就收尾 */
function scriptExecutor(model: DirectorModel, scripts: Record<string, Array<Array<{ name: string; args: () => Record<string, unknown> }>>>): void {
  const rounds = new Map<string, number>()
  model.on('executor', req => {
    const id = parseTaskId(req)
    const round = rounds.get(id) ?? 0
    rounds.set(id, round + 1)
    const step = scripts[id]?.[round]
    if (!step || step.length === 0) return textReply('完成')
    return toolReply('执行', step.map((c, i) => ({ name: c.name, args: c.args(), id: `${id}-r${round}-c${i}` })))
  })
}

function scriptJudge(model: DirectorModel, statuses: Record<string, Array<'pass' | 'fail'>>): void {
  const rounds = new Map<string, number>()
  model.on('judge', req => {
    const id = parseTaskId(req)
    const round = rounds.get(id) ?? 0
    rounds.set(id, round + 1)
    const status = statuses[id]?.[round] ?? 'fail'
    const task = JSON.parse((textOf(req).match(/任务（JSON）：(.*)/)?.[1] ?? '{}') as string) as UnitTask
    const { baselineId, afterId } = evidenceIdsFromPrompt(req)
    const criteria = (task.criteria ?? []).map(c => c.id)
    return verdictReply({
      taskId: id,
      criteria,
      status,
      evidenceIds: [baselineId, afterId],
    }) as ModelReply
  })
}

describe('P5 原请求复现：在雪原添加几栋房屋（fake 驱动）', () => {
  it('修复轮不再重复新增、结果保留：场景只多两栋，第三次 add 被拒', async () => {
    const plan = planOf([
      task({ id: 'task-1', regionId: 'region-north', creationTarget: { minCount: 2, maxCount: 2 } }),
    ])
    const model = createDirectorModel()
    model.on('planner', () => jsonReply(plan))
    const ctx = createFakeWorkflowContext({ model, config: { maxRepairsPerTask: 1 } })
    const before = ctx.fakeEditor.state().assetCount

    scriptExecutor(model, {
      'task-1': [
        // 首轮：在区内加两栋（占满名额）
        [
          { name: 'edit.add', args: () => ({ ref: 'models/rock', name: '房屋一', transform: T([-6, 0, -3]) }) },
          { name: 'edit.add', args: () => ({ ref: 'models/rock', name: '房屋二', transform: T([-2, 0, -3]) }) },
        ],
        // 修复轮：旧行为会"在别处再加两栋"；本轮第三个 add 必须被程序拒绝
        [
          { name: 'edit.add', args: () => ({ ref: 'models/rock', name: '房屋三', transform: T([3, 0, -3]) }) },
        ],
      ],
    })
    // 两轮都判失败 → 修复用尽
    scriptJudge(model, { 'task-1': ['fail', 'fail'] })

    const outcome = await createMainWorkflow().run(
      { runId: 'run-w11', request: '在中央白色雪原添加几栋房屋', partition: makeTwoRegionPartition(), sceneRevisionAtStart: 1 },
      ctx,
    )

    // ---- 1. 结果保留（P3），判据如实 fail（不冒充通过）----
    expect(outcome.kind, JSON.stringify(outcome).slice(0, 300)).toBe('retained_with_issues')
    if (outcome.kind !== 'retained_with_issues') return
    expect(outcome.finalCheck.passed).toBe(false)
    expect(outcome.issues.some(i => i.taskId === 'task-1' && i.status === 'fail')).toBe(true)

    // ---- 2. 场景只多了两栋（第三次 add 被拒，无副作用）----
    // 若名额没生效，这里会是 before+3 —— 这条断言就是"两栋变四栋"的回归锁。
    expect(ctx.fakeEditor.state().assetCount).toBe(before + 2)
    // 场内确实存在新加的两栋（按名字认，不靠数量巧合）
    const added = ctx.fakeEditor.snapshot({}).assets.filter(a => a.name === '房屋一' || a.name === '房屋二')
    expect(added).toHaveLength(2)
    expect(ctx.fakeEditor.snapshot({}).assets.some(a => a.name === '房屋三')).toBe(false)

    // ---- 3. 拒绝原因确实回灌给了模型 ----
    const toolResults = model.requests
      .flatMap(r => r.messages)
      .filter(m => m.role === 'toolResult')
      .map(m => JSON.stringify((m as { content: unknown }).content))
    expect(toolResults.some(t => t.includes('task_creation_limit'))).toBe(true)

    // ---- 4. 修复轮的上下文里明确写着"已有 2 栋、还能加 0 栋"----
    const repairPrompt = model.requests
      .filter(r => r.purpose === 'executor')
      .map(textOf)
      .find(t => t.includes('第 2 次修正') || t.includes('已创建且仍存活 2 个'))
    expect(repairPrompt, '没有抓到修复轮的提示词').toBeTruthy()
    expect(repairPrompt!).toContain('已创建且仍存活 2 个')
    expect(repairPrompt!).toContain('还可新增 0 个')

    // ---- 5. 任务台账与判据口径一致 ----
    const taskResult = outcome.regions['region-north'].tasks.find(t => t.taskId === 'task-1')
    expect(taskResult?.status).toBe('fail')
    expect(taskResult?.liveCreatedObjectIds).toHaveLength(2)
    expect(taskResult?.createdObjectIds).toHaveLength(2)
  })

  it('两个任务各算各的名额：前一个任务建满不影响后一个任务的配额', async () => {
    const plan = planOf([
      task({ id: 'task-a', regionId: 'region-north', creationTarget: { minCount: 1, maxCount: 1 } }),
      task({ id: 'task-b', regionId: 'region-north', creationTarget: { minCount: 1, maxCount: 1 } }),
    ])
    const model = createDirectorModel()
    model.on('planner', () => jsonReply(plan))
    const ctx = createFakeWorkflowContext({ model })
    const before = ctx.fakeEditor.state().assetCount

    scriptExecutor(model, {
      'task-a': [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', transform: T([-6, 0, -3]) }) }]],
      'task-b': [[{ name: 'edit.add', args: () => ({ ref: 'models/rock', transform: T([4, 0, -3]) }) }]],
    })
    scriptJudge(model, { 'task-a': ['pass'], 'task-b': ['pass'] })

    const outcome = await createMainWorkflow().run(
      { runId: 'run-w11b', request: '在雪原加两栋', partition: makeTwoRegionPartition(), sceneRevisionAtStart: 1 },
      ctx,
    )

    expect(outcome.kind, JSON.stringify(outcome).slice(0, 300)).toBe('completed')
    expect(ctx.fakeEditor.state().assetCount).toBe(before + 2)
    if (outcome.kind !== 'completed') return
    const tasks = outcome.regions['region-north'].tasks
    expect(tasks.map(t => t.taskId)).toEqual(['task-a', 'task-b'])
    expect(tasks[0].liveCreatedObjectIds).toHaveLength(1)
    expect(tasks[1].liveCreatedObjectIds).toHaveLength(1)
  })
})
