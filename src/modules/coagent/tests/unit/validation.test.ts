/**
 * W08.1 单元测试：指标真正计算 + 约束用最终场景 + 区域 AABB 包容 + 判定覆盖。
 *
 * 这里不跑 workflow/模型；用 FakeEditor 的确定性场景直接调用 validation 服务，
 * 让"程序算 fail 就不能被模型 pass 掩盖"这类规则可在毫秒级重复验证。
 */

import { describe, expect, it } from 'vitest'
import type {
  AssetDTO,
  Criterion,
  GeometryResult,
  RegionResult,
  SceneSnapshot,
  TaskResult,
  UnitTask,
  Verdict,
} from '../../contracts'
import {
  applyComputedToVerdict,
  checkRegionContainment,
  evaluateCriteria,
  regionObjectsFromSnapshot,
  validateFinalScene,
  validateTaskAgainstScene,
} from '../../services/validation'
import { createFakeEditor } from '../fakes/FakeEditor'
import { TWO_REGION_ASSETS, TWO_REGION_CATALOG, makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const T = (position: [number, number, number], rotationDeg: [number, number, number] = [0, 0, 0]): AssetDTO['transform'] => ({
  position,
  rotationDeg,
  scale: [1, 1, 1],
})

const catalogEntry = (ref: string) => TWO_REGION_CATALOG.find(c => c.ref === ref)

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

function fixture(): { snapshot: SceneSnapshot; partition: ReturnType<typeof makeTwoRegionPartition> } {
  const editor = createFakeEditor({ assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
  return { snapshot: editor.snapshot({ includeCatalog: true }), partition: makeTwoRegionPartition() }
}

function withExtraAsset(snapshot: SceneSnapshot, asset: AssetDTO): SceneSnapshot {
  return { ...snapshot, assets: [...snapshot.assets, asset] }
}

function withoutAsset(snapshot: SceneSnapshot, id: string): SceneSnapshot {
  return { ...snapshot, assets: snapshot.assets.filter(a => a.id !== id) }
}

const newRock: AssetDTO = {
  id: 'rock-new',
  ref: 'models/rock',
  name: '新增岩石',
  transform: T([5, 0, 6]),
  visible: true,
  catalog: catalogEntry('models/rock') ?? null,
  fingerprint: 'fp-rock-new',
}

function passVerdict(t: UnitTask): Verdict {
  return {
    schemaVersion: 1,
    taskId: t.id,
    status: 'pass',
    criteria: t.criteria.map(c => ({ criterionId: c.id, status: 'pass', evidenceIds: [], reason: 'ok' })),
    repairSuggestions: [],
  }
}

function resultOf(t: UnitTask, over: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: t.id,
    status: 'pass',
    verdicts: [passVerdict(t)],
    createdObjectIds: [],
    modifiedObjectIds: [],
    evidenceIds: [],
    ...over,
  }
}

function regionResultOf(tasks: TaskResult[]): RegionResult {
  return { regionId: 'region-north', status: 'pass', tasks }
}

describe('W08.1 区域指标', () => {
  it('object_count 用最终地面锚点归属，排除 global_readonly', () => {
    const { snapshot, partition } = fixture()
    // 把北区扩到包含中线，road-1 在区内但属 global_readonly，不应计数
    partition.regions[0].polygonXZ = [
      [-8, -8],
      [8, -8],
      [8, 0.5],
      [-8, 0.5],
    ]
    const objects = regionObjectsFromSnapshot(snapshot, partition, partition.regions[0])
    expect(objects.map(a => a.id).sort()).toEqual(['tree-1', 'tree-2'])
  })

  it('min_pair_distance_xz：满足/不满足都给出实际值', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-distance',
      regionId: 'region-north',
      targetObjectIds: ['tree-1', 'tree-2'],
      criteria: [{ id: 'c-dist', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'gte', value: 5, unit: 'm' }],
    })
    const objects = regionObjectsFromSnapshot(snapshot, partition, partition.regions[0])
    const [pass] = evaluateCriteria(t, objects)
    expect(pass.status).toBe('pass')
    expect(pass.actual).toBeCloseTo(Math.hypot(5, 1), 5)

    const strict = { ...t, criteria: [{ ...t.criteria[0], value: 6 } as Criterion] }
    const [fail] = evaluateCriteria(strict, objects)
    expect(fail.status).toBe('fail')
    expect(fail.reason).toContain('region.min_pair_distance_xz')
  })

  it('object_count：新增对象计入，eq 不满足时 fail', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-count',
      regionId: 'region-south',
      allowedOperations: ['add'],
      criteria: [{ id: 'c-count', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 3, unit: 'count' }],
      constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_count' }],
    })
    const withRock = withExtraAsset(snapshot, newRock)
    const validation = validateTaskAgainstScene({
      task: t,
      snapshot: withRock,
      partition,
      createdObjectIds: ['rock-new'],
    })
    const count = validation.criteria.find(c => c.criterionId === 'c-count')
    expect(count?.status).toBe('pass')
    expect(count?.actual).toBe(3)

    const four = { ...t, criteria: [{ ...t.criteria[0], value: 4 } as Criterion] }
    const bad = validateTaskAgainstScene({ task: four, snapshot: withRock, partition, createdObjectIds: ['rock-new'] })
    expect(bad.criteria.find(c => c.criterionId === 'c-count')?.status).toBe('fail')
  })

  it('visual 判据保持 uncertain，不参与程序 status 聚合', () => {
    const { snapshot, partition } = fixture()
    const t = task({ id: 't-visual', regionId: 'region-north', targetObjectIds: ['tree-1'] })
    const validation = validateTaskAgainstScene({ task: t, snapshot, partition })
    expect(validation.criteria[0].status).toBe('uncertain')
    expect(validation.status).toBe('pass') // 只有 visual 时，程序不冒充失败
  })
})

describe('W08.1 区域包容（§6.2 保守 AABB）', () => {
  const north = makeTwoRegionPartition().regions[0]

  it('完全在区内 pass；靠边界容差内的角点仍算 inside', () => {
    const inside = checkRegionContainment({
      region: north,
      transform: T([-6, 0, -6], [0, 30, 0]),
      catalog: catalogEntry('models/oak-tree') ?? null,
    })
    expect(inside.status).toBe('inside')
  })

  it('房舍放在 -5 时 AABB 超出北侧边界 → outside（不能只看 position）', () => {
    const check = checkRegionContainment({
      region: north,
      transform: T([-5, 0, -6], [0, 15, 0]),
      catalog: catalogEntry('models/cottage') ?? null,
    })
    expect(check.status).toBe('outside')
    expect(check.reason).toContain('超出区域')
  })

  it('pitch/roll 用外接球保守上界（避免欧拉顺序低估占地）', () => {
    const tilted: AssetDTO['transform'] = { position: [-3, 0, -4], rotationDeg: [30, 20, 10], scale: [1, 1, 1] }
    const check = checkRegionContainment({
      region: north,
      transform: tilted,
      catalog: catalogEntry('models/oak-tree') ?? null,
    })
    expect(check.footprint).toBeDefined()
    const width = (check.footprint?.maxX ?? 0) - (check.footprint?.minX ?? 0)
    // oak 3×3×3：hx=hz=1.5，hy=5（底面中心）→ 外接球直径 2*sqrt(1.5²+5²+1.5²)
    expect(width).toBeCloseTo(2 * Math.hypot(1.5, 5, 1.5), 5)
  })

  it('scale 放大后超出 → outside；无模型尺寸只能 unknown', () => {
    const scaled: AssetDTO['transform'] = { ...T([-6, 0, -6], [0, 30, 0]), scale: [3, 3, 3] }
    expect(
      checkRegionContainment({ region: north, transform: scaled, catalog: catalogEntry('models/oak-tree') ?? null }).status,
    ).toBe('outside')

    const noCatalog = checkRegionContainment({ region: north, transform: T([-3, 0, -4]), catalog: null })
    expect(noCatalog.status).toBe('unknown')
    expect(noCatalog.approximate).toBe(true)

    const outside = checkRegionContainment({ region: north, transform: T([20, 0, 20]), catalog: null })
    expect(outside.status).toBe('outside')
  })
})

describe('W08.1 约束（preserve / stay / collision）', () => {
  it('preserve_objects 的对象不是 target 时也必须查最终场景（回归：W05 曾只查 target）', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-preserve',
      regionId: 'region-north',
      targetObjectIds: ['tree-1'],
      constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_objects', objectIds: ['tree-2'] }],
    })
    const ok = validateTaskAgainstScene({ task: t, snapshot, partition })
    expect(ok.constraints.find(c => c.kind === 'preserve_objects')?.status).toBe('pass')

    const missing = validateTaskAgainstScene({ task: t, snapshot: withoutAsset(snapshot, 'tree-2'), partition })
    expect(missing.constraints.find(c => c.kind === 'preserve_objects')?.status).toBe('fail')
    expect(missing.problems.join('\n')).toContain('tree-2')
  })

  it('stay_in_region 检查 add 任务的新增对象，而不是空 target', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-add-stay',
      regionId: 'region-south',
      allowedOperations: ['add'],
      constraints: [{ kind: 'stay_in_region' }],
    })
    const good = validateTaskAgainstScene({ task: t, snapshot: withExtraAsset(snapshot, newRock), partition, createdObjectIds: ['rock-new'] })
    expect(good.constraints.find(c => c.kind === 'stay_in_region')?.status).toBe('pass')

    const far = { ...newRock, id: 'rock-far', transform: T([20, 0, 20]) }
    const bad = validateTaskAgainstScene({
      task: t,
      snapshot: withExtraAsset(snapshot, far),
      partition,
      createdObjectIds: ['rock-far'],
    })
    expect(bad.constraints.find(c => c.kind === 'stay_in_region')?.status).toBe('fail')
  })

  it('preserve_count：已有对象被删才 fail，新增不算删', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-preserve-count',
      regionId: 'region-south',
      allowedOperations: ['add'],
      constraints: [{ kind: 'preserve_count' }],
    })
    expect(
      validateTaskAgainstScene({ task: t, snapshot: withExtraAsset(snapshot, newRock), partition, createdObjectIds: ['rock-new'] })
        .constraints.find(c => c.kind === 'preserve_count')?.status,
    ).toBe('pass')
    expect(
      validateTaskAgainstScene({ task: t, snapshot: withoutAsset(snapshot, 'rock-1'), partition })
        .constraints.find(c => c.kind === 'preserve_count')?.status,
    ).toBe('fail')
  })

  it('no_collision：undefined/unknown 都不能当 pass', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-collision',
      regionId: 'region-north',
      targetObjectIds: ['tree-1'],
      constraints: [{ kind: 'no_collision' }],
    })
    const noCheck = validateTaskAgainstScene({ task: t, snapshot, partition })
    expect(noCheck.constraints.find(c => c.kind === 'no_collision')?.status).toBe('uncertain')

    const unknown: GeometryResult = { status: 'unknown', highestLevel: 'aabb', pairs: [] }
    expect(
      validateTaskAgainstScene({ task: t, snapshot, partition, geometry: unknown }).constraints.find(c => c.kind === 'no_collision')?.status,
    ).toBe('uncertain')

    const clear: GeometryResult = { status: 'clear', highestLevel: 'mesh+containment', pairs: [] }
    expect(
      validateTaskAgainstScene({ task: t, snapshot, partition, geometry: clear }).constraints.find(c => c.kind === 'no_collision')?.status,
    ).toBe('pass')

    const collision: GeometryResult = {
      status: 'collision',
      highestLevel: 'mesh',
      pairs: [{ a: 'tree-1', b: 'tree-2', status: 'collision', level: 'mesh' }],
    }
    expect(
      validateTaskAgainstScene({ task: t, snapshot, partition, geometry: collision }).constraints.find(c => c.kind === 'no_collision')?.status,
    ).toBe('fail')
  })
})

describe('W08.1 判定合并', () => {
  it('模型 pass + 程序 metric fail → 降级 fail，并写入 repairSuggestions', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-merge',
      regionId: 'region-north',
      targetObjectIds: ['tree-1', 'tree-2'],
      criteria: [{ id: 'c-dist', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'gte', value: 99, unit: 'm' }],
    })
    const validation = validateTaskAgainstScene({ task: t, snapshot, partition })
    const applied = applyComputedToVerdict(passVerdict(t), validation)
    expect(applied.verdict.status).toBe('fail')
    expect(applied.verdict.criteria[0].status).toBe('fail')
    expect(applied.issues.join('\n')).toContain('程序计算为 fail')
    expect(applied.verdict.repairSuggestions.join('\n')).toContain('min_pair_distance_xz')
  })

  it('模型 pass + 程序 uncertain → 降级 uncertain；模型 fail 不会被程序 pass 抬回', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 't-merge-2',
      regionId: 'region-north',
      targetObjectIds: ['tree-1'],
      criteria: [{ id: 'c-visual', kind: 'visual', description: '看起来对' }],
      constraints: [{ kind: 'no_collision' }],
    })
    const uncertain = validateTaskAgainstScene({ task: t, snapshot, partition })
    expect(applyComputedToVerdict(passVerdict(t), uncertain).verdict.status).toBe('uncertain')

    const failVerdict: Verdict = { ...passVerdict(t), status: 'fail', criteria: [{ criterionId: 'c-visual', status: 'fail', evidenceIds: [], reason: '不对' }] }
    const passComputed = { ...uncertain, status: 'pass' as const, constraints: [], criteria: [] }
    expect(applyComputedToVerdict(failVerdict, passComputed).verdict.status).toBe('fail')
  })
})

describe('W08.1 终检用最终场景重算', () => {
  it('后任务把树挪近 → 前任务的 min_pair_distance 在终检再次失败（T17）', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 'task-n1',
      regionId: 'region-north',
      targetObjectIds: ['tree-1'],
      criteria: [
        { id: 'c-dist', kind: 'metric', metric: 'region.min_pair_distance_xz', operator: 'gte', value: 5, unit: 'm' },
        { id: 'c-visual', kind: 'visual', description: '两树在区内' },
      ],
    })
    const moved = {
      ...snapshot,
      assets: snapshot.assets.map(a => (a.id === 'tree-1' ? { ...a, transform: T([1, 0, -5]) } : a)),
    }
    const validation = validateFinalScene({
      plan: { tasks: [t] },
      partition,
      snapshot: moved,
      regions: { 'region-north': regionResultOf([resultOf(t)]) },
    })
    expect(validation.checks.find(c => c.name === 'criterion:task-n1:c-dist')?.passed).toBe(false)
    expect(validation.checks.find(c => c.name === 'criterion:task-n1:c-visual')?.passed).toBe(true)
    expect(validation.problems.join('\n')).toContain('min_pair_distance_xz')
  })

  it('preserve_objects 的非 target 对象在终检也查存在性，不误报', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 'task-preserve',
      regionId: 'region-north',
      targetObjectIds: ['tree-1'],
      constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_objects', objectIds: ['tree-2'] }],
    })
    const ok = validateFinalScene({
      plan: { tasks: [t] },
      partition,
      snapshot,
      regions: { 'region-north': regionResultOf([resultOf(t)]) },
    })
    expect(ok.checks.find(c => c.name === 'constraint:task-preserve:preserve_objects')?.passed).toBe(true)
    expect(ok.problems).toEqual([])
  })

  it('added 对象越界 → stay_in_region 终检失败', () => {
    const { snapshot, partition } = fixture()
    const t = task({
      id: 'task-add',
      regionId: 'region-south',
      allowedOperations: ['add'],
      criteria: [{ id: 'c-count', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 3, unit: 'count' }],
      constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_count' }],
    })
    const far = { ...newRock, id: 'rock-far', transform: T([20, 0, 20]) }
    const validation = validateFinalScene({
      plan: { tasks: [t] },
      partition,
      snapshot: withExtraAsset(snapshot, far),
      regions: { 'region-south': { regionId: 'region-south', status: 'pass', tasks: [resultOf(t, { createdObjectIds: ['rock-far'] })] } },
    })
    expect(validation.checks.find(c => c.name === 'constraint:task-add:stay_in_region')?.passed).toBe(false)
    expect(validation.problems.join('\n')).toContain('超出区域')
  })
})
