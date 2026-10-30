/**
 * planValidation（W07）单测：schema 之后的那层"事实校验"。
 * 重点覆盖模型最容易编造的东西：不存在的 id、离谱阈值、与现状矛盾的对象数、空目标。
 */

import { describe, expect, it } from 'vitest'
import type { AssetDTO, TasksPlan, UnitTask } from '../../contracts'
import { DEFAULT_PLAN_LIMITS, sceneDiagonal, validateTaskPlanSemantics } from '../../services/planValidation'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const asset = (id: string, x: number, z: number): AssetDTO => ({
  id,
  ref: 'models/box',
  name: id,
  transform: { position: [x, 0, z], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
  visible: true,
  catalog: null,
  fingerprint: `fp-${id}`,
})

const assets = [asset('tree-1', -3, -4), asset('tree-2', 2, -5), asset('house-1', -2, 4), asset('rock-1', 4, 3), asset('road-1', 0, 0)]
const partition = makeTwoRegionPartition() // road-1 是 globalReadonly

function task(over: Partial<UnitTask> & { id: string; regionId: string }): UnitTask {
  return {
    schemaVersion: 1,
    objective: '把树挪一下',
    targetObjectIds: ['tree-1'],
    allowedOperations: ['transform'],
    criteria: [{ id: 'c1', kind: 'visual', description: '看起来更稀疏' }],
    constraints: [{ kind: 'stay_in_region' }],
    dependsOn: [],
    ...over,
  }
}

function plan(...tasks: UnitTask[]): TasksPlan {
  return { schemaVersion: 1, kind: 'tasks', assumptions: [], tasks }
}

const issuesOf = (p: TasksPlan): string[] => validateTaskPlanSemantics(p, partition, assets).map(i => `${i.path}:${i.message}`)

describe('新计划的碰撞硬约束依据', () => {
  const collisionPlan = (constraints: UnitTask['constraints']) => plan(task({ id: 't1', regionId: 'region-north', constraints }))
  const validate = (p: TasksPlan, userRequest: string) => validateTaskPlanSemantics(p, partition, assets, undefined, { userRequest })

  it('普通任务允许不声明碰撞硬约束，旧计划读取仍兼容无依据的约束', () => {
    expect(validate(collisionPlan([]), '种一片茂密树林，允许树冠交叠')).toEqual([])
    expect(issuesOf(collisionPlan([{ kind: 'no_collision' }]))).toEqual([])
  })

  it('新计划缺少依据时拒绝，即使 objective 自行声明了不相交', () => {
    const p = collisionPlan([{ kind: 'no_collision' }])
    p.tasks[0].objective = '树木不得相交'
    expect(validate(p, '添加几棵树')).toEqual([expect.objectContaining({ path: 'tasks[0].constraints[0].basis', message: expect.stringContaining('缺少原始用户请求依据') })])
  })

  it.each(['', '   ', '用户没说过的禁止碰撞要求'])('空白或伪造引用 %j 被拒绝', quote => {
    expect(validate(collisionPlan([{ kind: 'no_collision', basis: { source: 'user_request', quote } }]), '移动两棵树')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('必须引用原始用户请求') }),
    ])
  })

  it('明确要求的真实原文引用可以通过', () => {
    const quote = '移动的树不得与其他对象相交'
    expect(validate(collisionPlan([{ kind: 'no_collision', basis: { source: 'user_request', quote } }]), `调整树木位置，${quote}。`)).toEqual([])
  })
})

describe('sceneDiagonal', () => {
  it('按对象位置计算平面尺度', () => {
    expect(sceneDiagonal(assets)).toBeCloseTo(Math.hypot(7, 9), 6)
  })
})

describe('validateTaskPlanSemantics：合法计划', () => {
  it('基本合法计划没有 issue', () => {
    expect(issuesOf(plan(task({ id: 't1', regionId: 'region-north' })))).toEqual([])
  })

  it('add 任务不需要目标对象，且对象数可以变成当前+1', () => {
    const t = task({
      id: 't1',
      regionId: 'region-south',
      targetObjectIds: [],
      allowedOperations: ['add'],
      criteria: [{ id: 'c1', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 3, unit: 'count' }],
      constraints: [],
    })
    expect(issuesOf(plan(t))).toEqual([])
  })
})

describe('validateTaskPlanSemantics：编造与矛盾', () => {
  it('目标 id 不存在 → 拒绝（不允许编造）', () => {
    const issues = issuesOf(plan(task({ id: 't1', regionId: 'region-north', targetObjectIds: ['tree-404'] })))
    expect(issues.join()).toContain('不存在于当前场景')
  })

  it('目标不属于该区 / 是 global_readonly → 拒绝', () => {
    expect(issuesOf(plan(task({ id: 't1', regionId: 'region-north', targetObjectIds: ['house-1'] }))).join()).toContain('不属于区域')
    expect(issuesOf(plan(task({ id: 't1', regionId: 'region-north', targetObjectIds: ['road-1'] }))).join()).toContain('global_readonly')
  })

  it('声明 transform 却没有目标 → 拒绝', () => {
    expect(issuesOf(plan(task({ id: 't1', regionId: 'region-north', targetObjectIds: [] }))).join()).toContain('没有目标对象')
  })

  it('add 与 targetObjectIds 同时出现 → 拒绝', () => {
    const t = task({ id: 't1', regionId: 'region-north', allowedOperations: ['add'], targetObjectIds: ['tree-1'] })
    expect(issuesOf(plan(t)).join()).toContain('add 任务不应同时列 targetObjectIds')
  })

  it('未声明 add/remove 却要求对象数变化 → 拒绝（编造的事实）', () => {
    const t = task({
      id: 't1',
      regionId: 'region-north',
      criteria: [{ id: 'c1', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 5, unit: 'count' }],
    })
    expect(issuesOf(plan(t)).join()).toContain('未声明 add/remove')
  })

  it('距离阈值超过场景尺度 → 拒绝', () => {
    const t = task({
      id: 't1',
      regionId: 'region-north',
      criteria: [{ id: 'c1', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'gte', value: 999, unit: 'm' }],
    })
    expect(issuesOf(plan(t)).join()).toContain('超过场景尺度')
  })

  it('preserve_count 与 remove 冲突 → 拒绝（add 不冲突）', () => {
    const removing = task({
      id: 't1',
      regionId: 'region-south',
      targetObjectIds: ['house-1'],
      allowedOperations: ['remove'],
      criteria: [{ id: 'c1', kind: 'visual', description: '删掉村舍' }],
      constraints: [{ kind: 'preserve_count' }],
    })
    expect(issuesOf(plan(removing)).join()).toContain('preserve_count 与 remove 冲突')

    const adding = task({
      id: 't2',
      regionId: 'region-south',
      targetObjectIds: [],
      allowedOperations: ['add'],
      criteria: [{ id: 'c1', kind: 'visual', description: '加一块石头' }],
      constraints: [{ kind: 'preserve_count' }],
    })
    expect(issuesOf(plan(adding))).toEqual([])
  })

  it('任务数/目标数超限 → 拒绝', () => {
    const manyTasks = Array.from({ length: DEFAULT_PLAN_LIMITS.maxTasks + 1 }, (_, i) =>
      task({ id: `t${i}`, regionId: 'region-north', targetObjectIds: ['tree-1'] }),
    )
    expect(issuesOf(plan(...manyTasks)).join()).toContain('超过上限')

    const manyTargets = Array.from({ length: DEFAULT_PLAN_LIMITS.maxTargetsPerTask + 1 }, () => 'tree-1')
    expect(issuesOf(plan(task({ id: 't1', regionId: 'region-north', targetObjectIds: manyTargets }))).join()).toContain('目标数')
  })

  it('跨区依赖 → 拒绝', () => {
    const t1 = task({ id: 't1', regionId: 'region-south', targetObjectIds: ['house-1'] })
    const t2 = task({ id: 't2', regionId: 'region-north', dependsOn: ['t1'] })
    expect(issuesOf(plan(t1, t2)).join()).toContain('禁止跨区依赖')
  })

  it('依赖不存在的任务 → 拒绝', () => {
    expect(issuesOf(plan(task({ id: 't1', regionId: 'region-north', dependsOn: ['nope'] }))).join()).toContain('依赖的任务 nope 不存在')
  })
})
