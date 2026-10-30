/**
 * P1 runState 单测：任务台账、新增名额、区域成员口径。
 *
 * 这些是"修复轮不再重复新增"的地基，所以断言的都是行为语义：
 * 存活新增数、名额释放、幂等重放不占名额、跨任务不串账。
 */

import { describe, expect, it } from 'vitest'
import type { UnitTask } from '../../contracts'
import { createRunState } from '../../runtime/runState'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const T = (position: [number, number, number]) => ({
  position,
  rotationDeg: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
})

function addTask(over: Partial<UnitTask> = {}): UnitTask {
  return {
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
    ...over,
  }
}

const addCommand = (ref = 'models/rock') => ({ kind: 'add' as const, ref, transform: T([0, 0, 0]) })

describe('P1 新增名额', () => {
  it('前两次 add 允许，第三次被拒并给出 current/max 与存活对象', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask()])

    expect(state.checkWrite('task-add', addCommand(), 'c1')).toBeNull()
    state.recordWrite('task-add', addCommand(), 'rock-1', 'c1')

    expect(state.checkWrite('task-add', addCommand(), 'c2')).toBeNull()
    state.recordWrite('task-add', addCommand(), 'rock-2', 'c2')

    const rejected = state.checkWrite('task-add', addCommand(), 'c3')
    expect(rejected?.code).toBe('task_creation_limit')
    expect(rejected?.details?.current).toBe(2)
    expect(rejected?.details?.max).toBe(2)
    expect(rejected?.details?.liveCreatedObjectIds).toEqual(['rock-1', 'rock-2'])
  })

  it('删除一个后释放名额，可以再建一个', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask()])
    for (const [id, call] of [
      ['rock-1', 'c1'],
      ['rock-2', 'c2'],
    ] as const) {
      state.recordWrite('task-add', addCommand(), id, call)
    }
    expect(state.checkWrite('task-add', addCommand(), 'c3')?.code).toBe('task_creation_limit')

    state.recordWrite('task-add', { kind: 'remove', objectId: 'rock-1', expectedFingerprint: 'fp' }, 'rock-1', 'c3')
    expect(state.checkWrite('task-add', addCommand(), 'c4')).toBeNull()

    const live = new Set(['rock-2'])
    expect(state.getTaskLedger('task-add', live)?.liveCreatedObjectIds).toEqual(['rock-2'])
    expect(state.getTaskLedger('task-add', live)?.removedObjectIds).toEqual(['rock-1'])
  })

  it('同一幂等键重放即使已满名额也放行（不重复消耗）', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask({ creationTarget: { minCount: 1, maxCount: 1 } })])
    state.recordWrite('task-add', addCommand(), 'rock-1', 'c1')

    // 同一 toolCallId + 同参数 = 重放，放行（由写门面返回原 receipt）
    expect(state.checkWrite('task-add', addCommand(), 'c1')).toBeNull()
    // 不同 toolCallId = 新新增，超额
    expect(state.checkWrite('task-add', addCommand(), 'c2')?.code).toBe('task_creation_limit')
  })

  it('未声明 add 的任务不能新增（out_of_scope）', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask({ id: 'task-move', allowedOperations: ['transform'], creationTarget: undefined })])
    const rejected = state.checkWrite('task-move', addCommand(), 'c1')
    expect(rejected?.code).toBe('out_of_scope')
  })

  it('没有 creationTarget 的旧任务不受名额限制', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask({ id: 'legacy', creationTarget: undefined })])
    for (let i = 0; i < 5; i++) state.recordWrite('legacy', addCommand(), `rock-${i}`, `c${i}`)
    expect(state.checkWrite('legacy', addCommand(), 'c9')).toBeNull()
  })

  it('未登记的任务不施加任务级规则（不误伤主干/判定期）', () => {
    const state = createRunState({ runId: 'r1' })
    expect(state.checkWrite(null, addCommand(), 'c1')).toBeNull()
    expect(state.checkWrite('not-registered', addCommand(), 'c1')).toBeNull()
  })
})

describe('P1 任务台账隔离', () => {
  it('两个任务各自记自己的新增，互不串账', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([
      addTask({ id: 't1', creationTarget: { minCount: 1, maxCount: 2 } }),
      addTask({ id: 't2', creationTarget: { minCount: 1, maxCount: 1 } }),
    ])
    state.recordWrite('t1', addCommand(), 'a1', 'c1')
    state.recordWrite('t1', addCommand(), 'a2', 'c2')
    state.recordWrite('t2', addCommand(), 'b1', 'c3')

    const live = new Set(['a1', 'a2', 'b1'])
    expect(state.getTaskLedger('t1', live)?.liveCreatedObjectIds).toEqual(['a1', 'a2'])
    expect(state.getTaskLedger('t2', live)?.liveCreatedObjectIds).toEqual(['b1'])
    expect(state.getTaskLedger('t2', live)?.remainingAddCapacity).toBe(0)
  })

  it('重复 registerTasks 不重置已有台账', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask()])
    state.recordWrite('task-add', addCommand(), 'rock-1', 'c1')
    state.registerTasks([addTask()])
    expect(state.getTaskLedger('task-add', new Set(['rock-1']))?.liveCreatedObjectIds).toEqual(['rock-1'])
  })

  it('外部删除的对象不算存活（快照过滤）', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask({ creationTarget: { minCount: 1, maxCount: 3 } })])
    state.recordWrite('task-add', addCommand(), 'rock-1', 'c1')
    state.recordWrite('task-add', addCommand(), 'rock-2', 'c2')

    const ledger = state.getTaskLedger('task-add', new Set(['rock-2']))
    expect(ledger?.liveCreatedObjectIds).toEqual(['rock-2'])
    expect(ledger?.remainingAddCapacity).toBe(2)
  })

  it('phase/attempt 只影响展示，不重置台账', () => {
    const state = createRunState({ runId: 'r1' })
    state.registerTasks([addTask()])
    state.recordWrite('task-add', addCommand(), 'rock-1', 'c1')
    state.setPhase('task-add', 'repair', 2)
    const ledger = state.getTaskLedger('task-add', new Set(['rock-1']))
    expect(ledger?.phase).toBe('repair')
    expect(ledger?.attempt).toBe(2)
    expect(ledger?.liveCreatedObjectIds).toEqual(['rock-1'])
  })
})

describe('P1 区域成员口径', () => {
  it('成员 = (初始归属 ∪ 本轮该区创建) ∩ 当前存在，只读单独返回', () => {
    const partition = makeTwoRegionPartition()
    const region = partition.regions.find(r => r.id === 'region-north')!
    const readonlyId = partition.globalReadonlyObjectIds[0] ?? 'shared-1'
    const withReadonly = { ...region, objectIds: [...region.objectIds, readonlyId] }

    const state = createRunState({ runId: 'r1', readonlyObjectIds: [readonlyId] })
    state.registerTasks([addTask({ regionId: 'region-north' })])
    state.recordWrite('task-add', addCommand(), 'new-rock', 'c1')

    const live = new Set([...withReadonly.objectIds, 'new-rock'])
    const view = state.resolveRegion(withReadonly, live, 7)

    expect(view.memberIds).toContain('new-rock')
    expect(view.readonlyIds).toEqual([readonlyId])
    expect(view.writableIds).not.toContain(readonlyId)
    expect(view.writableIds).toContain('new-rock')
    expect(view.sceneRevision).toBe(7)
  })

  it('已删除的对象不进成员（不制造幽灵对象）', () => {
    const partition = makeTwoRegionPartition()
    const region = partition.regions.find(r => r.id === 'region-north')!
    const state = createRunState({ runId: 'r1' })
    const live = new Set<string>() // 场景里什么都没有
    expect(state.resolveRegion(region, live, 1).memberIds).toEqual([])
  })
})
