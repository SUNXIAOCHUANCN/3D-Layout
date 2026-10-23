/**
 * W01 契约校验器测试（T01 雏形）：
 * 非法数字、缺失 ID、错误 schemaVersion、自交多边形、任务循环、未支持指标。
 */

import { describe, expect, it } from 'vitest'
import type { CameraSnapshot, TransformDTO, UnitTask } from '../../contracts'
import {
  checkTaskDag,
  checkTasksSameRegion,
  computeAssetFingerprint,
  polygonAreaXZ,
  polygonSelfIntersects,
  validateCameraSnapshot,
  validatePartitionSnapshot,
  validatePlan,
  validateTransformDTO,
  validateUnitTask,
  validateVerdict,
} from '../../schemas'
import {
  makeTwoRegionPlan,
  makeTwoRegionPartition,
  REGION_NORTH,
  TWO_REGION_ASSETS,
} from '../fixtures/twoRegionScene'

const validTransform: TransformDTO = { position: [1, 2, 3], rotationDeg: [0, 90, 0], scale: [1, 1, 1] }

describe('validateTransformDTO', () => {
  it('接受合法变换', () => {
    expect(validateTransformDTO(validTransform, 't').ok).toBe(true)
  })
  it('拒绝 NaN / Infinity / 缺失字段', () => {
    expect(validateTransformDTO({ ...validTransform, position: [0, Number.NaN, 0] }, 't').ok).toBe(false)
    expect(validateTransformDTO({ ...validTransform, scale: [1, Infinity, 1] }, 't').ok).toBe(false)
    expect(validateTransformDTO({ position: [0, 0, 0], rotationDeg: [0, 0, 0] }, 't').ok).toBe(false) // 缺 scale
    expect(validateTransformDTO({ ...validTransform, rotationDeg: [0, 0] }, 't').ok).toBe(false) // 长度错
  })
})

describe('多边形（分区几何）', () => {
  it('矩形不自交、面积正确', () => {
    expect(polygonSelfIntersects(REGION_NORTH.polygonXZ)).toBe(false)
    expect(polygonAreaXZ(REGION_NORTH.polygonXZ)).toBeCloseTo(16 * 7.5, 6)
  })
  it('领结形（bowtie）自交被拒', () => {
    const bowtie: Array<[number, number]> = [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
    ]
    expect(polygonSelfIntersects(bowtie)).toBe(true)
  })
  it('相邻边共享顶点不算自交', () => {
    expect(polygonSelfIntersects(REGION_NORTH.polygonXZ.slice().reverse())).toBe(false)
  })
})

describe('validatePartitionSnapshot / Region', () => {
  it('接受两区夹具', () => {
    expect(validatePartitionSnapshot(makeTwoRegionPartition()).ok).toBe(true)
  })
  it('错误 schemaVersion / 缺失 id / 少于三顶点被拒', () => {
    const bad = { ...REGION_NORTH, schemaVersion: 2 }
    expect(validatePartitionSnapshot({ ...makeTwoRegionPartition(), regions: [bad] }).ok).toBe(false)
    const noId = { ...REGION_NORTH, id: '' }
    expect(validatePartitionSnapshot({ ...makeTwoRegionPartition(), regions: [noId] }).ok).toBe(false)
    const degenerate = { ...REGION_NORTH, polygonXZ: [[0, 0], [1, 1]] }
    expect(validatePartitionSnapshot({ ...makeTwoRegionPartition(), regions: [degenerate] }).ok).toBe(false)
  })
  it('顶点重复坍缩（不足 3 个不同点）被拒', () => {
    const collapsed = { ...REGION_NORTH, polygonXZ: [[0, 0], [1, 0], [1, 0]] }
    expect(validatePartitionSnapshot({ ...makeTwoRegionPartition(), regions: [collapsed] }).ok).toBe(false)
  })
})

function northTask(overrides: Partial<UnitTask> = {}): UnitTask {
  const base = makeTwoRegionPlan()
  if (base.kind !== 'tasks') throw new Error('夹具必须是 tasks 计划')
  return { ...base.tasks[0], ...overrides }
}

describe('validateUnitTask', () => {
  it('接受夹具任务', () => {
    const plan = makeTwoRegionPlan()
    if (plan.kind !== 'tasks') throw new Error('unreachable')
    for (const t of plan.tasks) expect(validateUnitTask(t).ok).toBe(true)
  })
  it('缺失 id / 空 objective / 空操作集被拒', () => {
    expect(validateUnitTask(northTask({ id: '' })).ok).toBe(false)
    expect(validateUnitTask(northTask({ objective: '' })).ok).toBe(false)
    expect(validateUnitTask(northTask({ allowedOperations: [] })).ok).toBe(false)
    expect(validateUnitTask(northTask({ allowedOperations: ['delete'] as unknown as UnitTask['allowedOperations'] })).ok).toBe(false)
  })
  it('未注册指标 → unsupported_metric 拒绝', () => {
    const t = northTask({
      criteria: [
        { id: 'c1', kind: 'metric', metric: 'aesthetic.score', operator: 'gte', value: 1, unit: 'score' },
      ],
    })
    const r = validateUnitTask(t)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0].message).toContain('unsupported_metric')
  })
  it('metric 值非有限数字被拒；visual 缺描述被拒', () => {
    const nanMetric = northTask({
      criteria: [{ id: 'c1', kind: 'metric', metric: 'region.object_count', operator: 'gte', value: Number.NaN, unit: 'count' }],
    })
    expect(validateUnitTask(nanMetric).ok).toBe(false)
    const noDesc = northTask({ criteria: [{ id: 'c1', kind: 'visual', description: '' }] })
    expect(validateUnitTask(noDesc).ok).toBe(false)
  })
  it('未知约束类型被拒', () => {
    const t = northTask({ constraints: [{ kind: 'teleport' } as unknown as UnitTask['constraints'][number]] })
    expect(validateUnitTask(t).ok).toBe(false)
  })
})

describe('任务依赖 DAG', () => {
  it('夹具计划无环、同区', () => {
    const plan = makeTwoRegionPlan()
    if (plan.kind !== 'tasks') throw new Error('unreachable')
    expect(checkTaskDag(plan.tasks).ok).toBe(true)
    expect(checkTasksSameRegion(plan.tasks).ok).toBe(true)
  })
  it('循环依赖被拒', () => {
    const a = northTask({ id: 'a', dependsOn: ['b'] })
    const b = northTask({ id: 'b', dependsOn: ['a'] })
    const r = checkTaskDag([a, b])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0].message).toContain('成环')
  })
  it('自依赖被拒', () => {
    expect(checkTaskDag([northTask({ dependsOn: ['task-north-spread'] })]).ok).toBe(false)
  })
  it('依赖不存在的任务被拒', () => {
    expect(checkTaskDag([northTask({ dependsOn: ['ghost-task'] })]).ok).toBe(false)
  })
  it('跨区依赖被拒', () => {
    const plan = makeTwoRegionPlan()
    if (plan.kind !== 'tasks') throw new Error('unreachable')
    const [north, south] = plan.tasks
    const crossed = checkTasksSameRegion([north, { ...south, dependsOn: [north.id] }])
    expect(crossed.ok).toBe(false)
  })
})

describe('validatePlan', () => {
  it('tasks / clarify / unsupported 三态各自合法', () => {
    expect(validatePlan(makeTwoRegionPlan()).ok).toBe(true)
    expect(validatePlan({ schemaVersion: 1, kind: 'clarify', question: '要稀疏多少？', options: ['轻微', '明显'] }).ok).toBe(true)
    expect(validatePlan({ schemaVersion: 1, kind: 'unsupported', reason: '涉及跨区移动' }).ok).toBe(true)
  })
  it('错误 schemaVersion 与未知 kind 被拒', () => {
    expect(validatePlan({ ...makeTwoRegionPlan(), schemaVersion: 3 }).ok).toBe(false)
    expect(validatePlan({ schemaVersion: 1, kind: 'magic' }).ok).toBe(false)
  })
})

describe('validateCameraSnapshot', () => {
  const base: CameraSnapshot = {
    schemaVersion: 1,
    id: 'cam',
    projection: 'perspective',
    position: [0, 10, 10],
    target: [0, 0, 0],
    up: [0, 1, 0],
    near: 0.1,
    far: 300,
    aspect: 16 / 9,
    fovDeg: 50,
  }
  it('perspective 合法；缺 fovDeg 非法', () => {
    expect(validateCameraSnapshot(base).ok).toBe(true)
    const { fovDeg: _omit, ...noFov } = base
    expect(validateCameraSnapshot(noFov).ok).toBe(false)
  })
  it('orthographic 必须带 ortho；near≥far 非法', () => {
    const ortho: CameraSnapshot = {
      ...base,
      projection: 'orthographic',
      ortho: { left: -10, right: 10, top: 8, bottom: -8 },
    }
    expect(validateCameraSnapshot(ortho).ok).toBe(true)
    const { ortho: _o, fovDeg: _f, ...noOrtho } = ortho
    expect(validateCameraSnapshot(noOrtho).ok).toBe(false)
    expect(validateCameraSnapshot({ ...base, near: 300, far: 0.1 }).ok).toBe(false)
  })
})

describe('validateVerdict', () => {
  it('合法判定通过；空证据 pass 也形状合法（是否有证据由 validation 服务管）', () => {
    const v = {
      schemaVersion: 1,
      taskId: 'task-north-spread',
      status: 'pass',
      criteria: [
        { criterionId: 'crit-north-distance', status: 'pass', evidenceIds: ['obs-1'], reason: '间距 5.2m ≥ 5m' },
      ],
      repairSuggestions: [],
    }
    expect(validateVerdict(v).ok).toBe(true)
  })
  it('非法 status / 缺 reason / 错误 schemaVersion 被拒', () => {
    expect(validateVerdict({ schemaVersion: 1, taskId: 't', status: 'maybe', criteria: [], repairSuggestions: [] }).ok).toBe(false)
    expect(
      validateVerdict({
        schemaVersion: 1,
        taskId: 't',
        status: 'fail',
        criteria: [{ criterionId: 'c', status: 'fail', evidenceIds: [], reason: '' }],
        repairSuggestions: [],
      }).ok,
    ).toBe(false)
    expect(validateVerdict({ schemaVersion: 2, taskId: 't', status: 'pass', criteria: [], repairSuggestions: [] }).ok).toBe(false)
  })
})

describe('computeAssetFingerprint', () => {
  it('同输入同指纹；任何字段变化都变指纹；缺省归一化一致', () => {
    const tree = TWO_REGION_ASSETS[0]
    const a = computeAssetFingerprint({ ref: tree.ref, transform: tree.transform, visible: true })
    const b = computeAssetFingerprint({ ref: tree.ref, transform: tree.transform })
    expect(a).toBe(b) // visible 缺省=true 等价
    const moved = computeAssetFingerprint({
      ref: tree.ref,
      transform: { ...tree.transform, position: [tree.transform.position[0] + 0.1, 0, -4] },
    })
    expect(moved).not.toBe(a)
    const hidden = computeAssetFingerprint({ ref: tree.ref, transform: tree.transform, visible: false })
    expect(hidden).not.toBe(a)
  })
})
