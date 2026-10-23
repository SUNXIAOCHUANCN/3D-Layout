/**
 * validation（W08.1，SPEC §3.5/§6.2/§6.6）——**真正把判据算出来**的那一层。
 *
 * W05 的 judge 只校验"形状 + 证据 id 合法"，metric 与 constraints 都还只是文字；
 * 本文件把下面三件事变成程序事实，真实模型与假模型走同一套：
 *
 * 1. metric：`region.object_count` / `region.min_pair_distance_xz` 用**最终场景**计算，
 *    模型说 pass 但程序算 fail 时，判定会被降级（`applyComputedToVerdict`）；
 * 2. constraints：`stay_in_region` 用保守的世界 AABB 地面投影检查（§6.2），
 *    `preserve_objects` / `preserve_count` 查最终对象集合，`no_collision` 只认
 *    clear，unknown 不能当通过（§6.5/§6.6）；
 * 3. finalCheck：对最终场景逐任务重算 metric/constraint；visual 仍以最后一轮
 *    Verdict 为准（后续编辑使早期判定失效的重判属 W08.5）。
 *
 * 约束：
 * - 纯函数，不 import core/react/three；可在 node 单测；
 * - 不修改传入的 snapshot/DTO；
 * - 区域边界使用数值容差（§6.1），不靠数组顺序决定归属。
 */

import type {
  AssetDTO,
  Constraint,
  Criterion,
  FinalCheckItem,
  GeometryResult,
  ModelCatalogEntry,
  Observation,
  PartitionSnapshot,
  Region,
  RegionResult,
  SceneSnapshot,
  TaskResult,
  TransformDTO,
  UnitTask,
  Verdict,
} from '../contracts'

/** 区域边界容差（米）：顶点/角点落在线附近按"在区内"处理（§6.1） */
export const REGION_BOUNDARY_TOLERANCE_M = 0.1

const EPS = 1e-6

export type ValidationStatus = 'pass' | 'fail' | 'uncertain'

export type CriterionEvaluation = {
  criterionId: string
  kind: 'metric' | 'visual'
  status: ValidationStatus
  /** metric 的实际值；visual 或无法计算时为 null */
  actual: number | null
  expected?: { operator: 'gte' | 'lte' | 'eq'; value: number; unit: string }
  reason: string
}

export type ConstraintEvaluation = {
  kind: Constraint['kind']
  status: ValidationStatus
  reason: string
  objectIds: string[]
}

export type TaskValidation = {
  taskId: string
  regionId: string
  criteria: CriterionEvaluation[]
  constraints: ConstraintEvaluation[]
  /** 只聚合 metric + constraint；visual 由判定器负责 */
  status: ValidationStatus
  /** 只包含 metric/constraint 的问题（visual 不在这里冒充失败） */
  problems: string[]
}

export type RegionContainmentResult = {
  status: 'inside' | 'outside' | 'unknown'
  reason: string
  /** 世界 AABB 的地面投影；缺少模型尺寸时为 undefined */
  footprint?: { minX: number; maxX: number; minZ: number; maxZ: number }
  /** true = 缺少尺寸，只用中心点判断，不能宣称"完整在区内" */
  approximate: boolean
}

/**
 * W08.2：before/after 必须是同一 run、同一任务、同一区域、同一分区版本、
 * 同一完整相机快照和输出尺寸（§6.3）。不满足就不能拿两张图做视觉比较。
 */
export function observationPairIssues(
  task: UnitTask,
  before: Observation,
  after: Observation,
  opts: { runId?: string } = {},
): string[] {
  const issues: string[] = []
  if (before.id === after.id) issues.push('before/after 指向同一条证据')
  if (before.phase !== 'task_before') issues.push(`before.phase=${before.phase}（应为 task_before）`)
  if (after.phase !== 'after') issues.push(`after.phase=${after.phase}（应为 after）`)
  if (before.runId !== after.runId) issues.push(`before/after 来自不同 run（${before.runId} vs ${after.runId}）`)
  if (opts.runId && before.runId !== opts.runId) issues.push(`before 的 runId=${before.runId} 不属于当前 run ${opts.runId}`)
  if (opts.runId && after.runId !== opts.runId) issues.push(`after 的 runId=${after.runId} 不属于当前 run ${opts.runId}`)
  if (before.taskId !== task.id) issues.push(`before.taskId=${before.taskId ?? 'null'} 与任务 ${task.id} 不一致`)
  if (after.taskId !== task.id) issues.push(`after.taskId=${after.taskId ?? 'null'} 与任务 ${task.id} 不一致`)
  if (before.regionId !== task.regionId) issues.push(`before.regionId=${before.regionId ?? 'null'} 与任务区域 ${task.regionId} 不一致`)
  if (after.regionId !== task.regionId) issues.push(`after.regionId=${after.regionId ?? 'null'} 与任务区域 ${task.regionId} 不一致`)
  if (before.partitionVersion !== after.partitionVersion) {
    issues.push(`before/after 的分区版本不同（${before.partitionVersion} vs ${after.partitionVersion}）`)
  }
  if (JSON.stringify(before.camera) !== JSON.stringify(after.camera)) {
    issues.push('before/after 相机快照不同（不是同视角复拍）')
  }
  if (before.width !== after.width || before.height !== after.height) {
    issues.push(`before/after 输出尺寸不同（${before.width}×${before.height} vs ${after.width}×${after.height}）`)
  }
  if (after.sceneRevision < before.sceneRevision) {
    issues.push(`after.sceneRevision=${after.sceneRevision} 早于 before=${before.sceneRevision}`)
  }
  return issues
}

// ---------------------------------------------------------------------------
// 基础几何（XZ 平面；不依赖 three）
// ---------------------------------------------------------------------------

function pointInPolygonXZ(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]
    const [xj, zj] = polygon[j]
    const intersects = zi > point[1] !== zj > point[1] && point[0] < ((xj - xi) * (point[1] - zi)) / (zj - zi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function distancePointSegment(point: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz
  if (len2 <= EPS) return Math.hypot(point[0] - a[0], point[1] - a[1])
  let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dz))
}

/** 点是否在多边形内；tolerance>0 时边界附近也算在内（数值容差，§6.1） */
export function polygonContainsPointXZ(
  point: [number, number],
  polygon: Array<[number, number]>,
  toleranceM = 0,
): boolean {
  if (polygon.length < 3) return false
  if (pointInPolygonXZ(point, polygon)) return true
  if (toleranceM <= 0) return false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (distancePointSegment(point, polygon[j], polygon[i]) <= toleranceM) return true
  }
  return false
}

/** 欧拉角 XYZ（角度制）旋转一个局部点；用于把 OBB 的 8 个角变成世界坐标 */
function rotateXYZ(local: [number, number, number], rotationDeg: [number, number, number]): [number, number, number] {
  const [rx, ry, rz] = rotationDeg.map(d => (d * Math.PI) / 180)
  const [x0, y0, z0] = local

  // Rx
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  const y1 = y0 * cx - z0 * sx
  const z1 = y0 * sx + z0 * cx
  const x1 = x0

  // Ry
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const x2 = x1 * cy + z1 * sy
  const z2 = -x1 * sy + z1 * cy
  const y2 = y1

  // Rz
  const cz = Math.cos(rz)
  const sz = Math.sin(rz)
  return [x2 * cz - y2 * sz, x2 * sz + y2 * cz, z2]
}

/**
 * 世界 AABB 的地面投影。
 *
 * 模型原点约定为底面中心：局部 y ∈ [0, h]，x/z 各占一半（§1.4）。
 * 旋转后的 AABB 是保守上界：宁可拒绝靠边但实际合法的位置，也不放过越界（§6.2）。
 */
export function footprintAabbXZ(
  transform: TransformDTO,
  catalog: ModelCatalogEntry | null | undefined,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (!catalog) return null
  const { w, h, d } = catalog.dimensions
  if (![w, h, d].every(v => Number.isFinite(v) && v >= 0)) return null
  const hx = (Math.abs(w) * Math.abs(transform.scale[0])) / 2
  const hy = Math.abs(h) * Math.abs(transform.scale[1])
  const hz = (Math.abs(d) * Math.abs(transform.scale[2])) / 2

  // 只有 yaw 时，OBB 的 AABB 与欧拉顺序无关，逐角点计算最精确。
  // 一旦有 pitch/roll，Three 的 XYZ 顺序与自行展开的顺序可能不同；用外接球半径
  // 做保守上界，宁可比实际大，也不在"越界"上给出错误结论。
  if (Math.abs(transform.rotationDeg[0]) > 1e-6 || Math.abs(transform.rotationDeg[2]) > 1e-6) {
    const radius = Math.hypot(hx, hy, hz)
    return {
      minX: transform.position[0] - radius,
      maxX: transform.position[0] + radius,
      minZ: transform.position[2] - radius,
      maxZ: transform.position[2] + radius,
    }
  }

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const lx of [-hx, hx]) {
    for (const ly of [0, hy]) {
      for (const lz of [-hz, hz]) {
        const r = rotateXYZ([lx, ly, lz], transform.rotationDeg)
        const x = transform.position[0] + r[0]
        const z = transform.position[2] + r[2]
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minZ = Math.min(minZ, z)
        maxZ = Math.max(maxZ, z)
      }
    }
  }
  return { minX, maxX, minZ, maxZ }
}

function pointStrictlyInsideBox(point: [number, number], box: { minX: number; maxX: number; minZ: number; maxZ: number }, tolerance: number): boolean {
  return (
    point[0] > box.minX + tolerance &&
    point[0] < box.maxX - tolerance &&
    point[1] > box.minZ + tolerance &&
    point[1] < box.maxZ - tolerance
  )
}

/**
 * 分区包容检查（§6.2）：
 * - 有模型尺寸：AABB 四角 + 中心 + 边中点都在区内，且多边形顶点不在 AABB 内（凹多边形兜底）；
 * - 无模型尺寸：只判中心点，返回 unknown（不能宣称完整在区内）。
 */
export function checkRegionContainment(input: {
  region: Region
  transform: TransformDTO
  catalog?: ModelCatalogEntry | null
  toleranceM?: number
}): RegionContainmentResult {
  const tolerance = input.toleranceM ?? REGION_BOUNDARY_TOLERANCE_M
  const polygon = input.region.polygonXZ
  if (polygon.length < 3) {
    return { status: 'outside', reason: `区域 ${input.region.id} 的多边形不足 3 点`, approximate: false }
  }
  const center: [number, number] = [input.transform.position[0], input.transform.position[2]]
  const footprint = footprintAabbXZ(input.transform, input.catalog ?? null)

  if (!footprint) {
    const inside = polygonContainsPointXZ(center, polygon, tolerance)
    return {
      status: inside ? 'unknown' : 'outside',
      reason: inside
        ? '缺少模型尺寸，只能确认中心点在区内，无法确认占地范围'
        : `中心点 (${center[0].toFixed(2)}, ${center[1].toFixed(2)}) 已在区域 ${input.region.id} 外`,
      approximate: true,
    }
  }

  const corners: Array<[number, number]> = [
    [footprint.minX, footprint.minZ],
    [footprint.minX, footprint.maxZ],
    [footprint.maxX, footprint.minZ],
    [footprint.maxX, footprint.maxZ],
    [(footprint.minX + footprint.maxX) / 2, footprint.minZ],
    [(footprint.minX + footprint.maxX) / 2, footprint.maxZ],
    [footprint.minX, (footprint.minZ + footprint.maxZ) / 2],
    [footprint.maxX, (footprint.minZ + footprint.maxZ) / 2],
    [(footprint.minX + footprint.maxX) / 2, (footprint.minZ + footprint.maxZ) / 2],
  ]
  for (const corner of corners) {
    if (!polygonContainsPointXZ(corner, polygon, tolerance)) {
      return {
        status: 'outside',
        reason: `占地范围 (${footprint.minX.toFixed(2)}..${footprint.maxX.toFixed(2)}, ${footprint.minZ.toFixed(2)}..${footprint.maxZ.toFixed(2)}) 超出区域 ${input.region.id}`,
        footprint,
        approximate: false,
      }
    }
  }

  // 凹多边形：如果多边形顶点落在物体占地 AABB 内，AABB 覆盖了区外空间
  for (const v of polygon) {
    if (pointStrictlyInsideBox(v, footprint, tolerance)) {
      return {
        status: 'outside',
        reason: `区域 ${input.region.id} 的凹角落在物体占地范围内`,
        footprint,
        approximate: false,
      }
    }
  }

  return { status: 'inside', reason: '占地范围完整位于区域内', footprint, approximate: false }
}

// ---------------------------------------------------------------------------
// 指标（§4.2 白名单；不在白名单就是 unsupported_metric）
// ---------------------------------------------------------------------------

/** 区域内的"可编辑对象"：最终地面锚点落在多边形内，排除 global_readonly（§6.1） */
export function regionObjectsFromSnapshot(
  snapshot: SceneSnapshot,
  partition: PartitionSnapshot,
  region: Region,
  toleranceM = REGION_BOUNDARY_TOLERANCE_M,
): AssetDTO[] {
  const readonly = new Set(partition.globalReadonlyObjectIds)
  return snapshot.assets.filter(a => {
    if (readonly.has(a.id)) return false
    return polygonContainsPointXZ([a.transform.position[0], a.transform.position[2]], region.polygonXZ, toleranceM)
  })
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

function compareMetric(actual: number, operator: 'gte' | 'lte' | 'eq', expected: number): boolean {
  const scale = Math.max(1, Math.abs(expected))
  const eps = Math.max(EPS, scale * 1e-9)
  if (operator === 'eq') return Math.abs(actual - expected) <= eps
  if (operator === 'gte') return actual >= expected - eps
  return actual <= expected + eps
}

function computeRegionMetric(
  metric: string,
  objects: AssetDTO[],
): { value: number | null; status: ValidationStatus; reason: string } {
  if (metric === 'region.object_count') {
    return { value: objects.length, status: 'pass', reason: `区域对象数 ${objects.length}` }
  }
  if (metric === 'region.min_pair_distance_xz') {
    if (objects.length < 2) {
      return { value: null, status: 'uncertain', reason: `区域只有 ${objects.length} 个对象，无法计算最小间距` }
    }
    let min = Infinity
    for (let i = 0; i < objects.length; i++) {
      for (let j = i + 1; j < objects.length; j++) {
        const a = objects[i].transform.position
        const b = objects[j].transform.position
        min = Math.min(min, Math.hypot(a[0] - b[0], a[2] - b[2]))
      }
    }
    return { value: min, status: 'pass', reason: `最小间距 ${formatNumber(min)}m` }
  }
  return { value: null, status: 'uncertain', reason: `unsupported_metric：${metric} 不在白名单` }
}

function evaluateMetricCriterion(
  criterion: Extract<Criterion, { kind: 'metric' }>,
  objects: AssetDTO[],
): CriterionEvaluation {
  const computed = computeRegionMetric(criterion.metric, objects)
  const expected = { operator: criterion.operator, value: criterion.value, unit: criterion.unit }
  if (computed.value === null) {
    return {
      criterionId: criterion.id,
      kind: 'metric',
      status: computed.status,
      actual: null,
      expected,
      reason: computed.reason,
    }
  }
  const pass = compareMetric(computed.value, criterion.operator, criterion.value)
  return {
    criterionId: criterion.id,
    kind: 'metric',
    status: pass ? 'pass' : 'fail',
    actual: computed.value,
    expected,
    reason: `${criterion.metric}：${formatNumber(computed.value)}${criterion.unit} ${criterion.operator} ${formatNumber(criterion.value)}${criterion.unit}：${pass ? '满足' : '不满足'}（${computed.reason}）`,
  }
}

/** 逐条判据：metric 真正计算；visual 交由 judge，程序只标记"待判定" */
export function evaluateCriteria(
  task: UnitTask,
  objects: AssetDTO[],
): CriterionEvaluation[] {
  return task.criteria.map(criterion => {
    if (criterion.kind === 'metric') return evaluateMetricCriterion(criterion, objects)
    return {
      criterionId: criterion.id,
      kind: 'visual',
      status: 'uncertain',
      actual: null,
      reason: 'visual 判据需要判定器结合证据，程序不代替视觉判断',
    }
  })
}

// ---------------------------------------------------------------------------
// 约束（§6.2 / §6.5 / §6.6）
// ---------------------------------------------------------------------------

function aggregate(statuses: ValidationStatus[]): ValidationStatus {
  if (statuses.some(s => s === 'fail')) return 'fail'
  if (statuses.some(s => s === 'uncertain')) return 'uncertain'
  return 'pass'
}

function evaluateConstraints(
  task: UnitTask,
  input: {
    snapshot: SceneSnapshot
    partition: PartitionSnapshot
    region: Region
    createdObjectIds: string[]
    geometry?: GeometryResult
  },
): ConstraintEvaluation[] {
  const byId = new Map(input.snapshot.assets.map(a => [a.id, a]))
  const created = [...new Set(input.createdObjectIds)]
  const results: ConstraintEvaluation[] = []

  for (const constraint of task.constraints) {
    if (constraint.kind === 'stay_in_region') {
      const ids = [...new Set([...task.targetObjectIds, ...created])]
      if (ids.length === 0) {
        results.push({
          kind: 'stay_in_region',
          status: 'uncertain',
          reason: task.allowedOperations.includes('add')
            ? 'add 任务还没有产生对象，无法检查落点'
            : '没有目标对象，无法检查是否在区内',
          objectIds: [],
        })
        continue
      }
      const statuses: ValidationStatus[] = []
      const problems: string[] = []
      for (const id of ids) {
        const asset = byId.get(id)
        if (!asset) {
          statuses.push('fail')
          problems.push(`对象 ${id} 不存在`)
          continue
        }
        const containment = checkRegionContainment({ region: input.region, transform: asset.transform, catalog: asset.catalog })
        statuses.push(containment.status === 'inside' ? 'pass' : containment.status === 'outside' ? 'fail' : 'uncertain')
        if (containment.status !== 'inside') problems.push(`${id}：${containment.reason}`)
      }
      results.push({
        kind: 'stay_in_region',
        status: aggregate(statuses),
        reason: problems.length > 0 ? problems.join('；') : '目标/新增对象均在区域内',
        objectIds: ids,
      })
      continue
    }

    if (constraint.kind === 'preserve_objects') {
      const missing = constraint.objectIds.filter(id => !byId.has(id))
      results.push({
        kind: 'preserve_objects',
        status: missing.length > 0 ? 'fail' : 'pass',
        reason: missing.length > 0 ? `要求保留的对象被删除：${missing.join(', ')}` : '要求保留的对象都存在',
        objectIds: [...constraint.objectIds],
      })
      continue
    }

    if (constraint.kind === 'preserve_count') {
      // 语义是"别把已有对象删掉"（新增允许，W05 夹具已确认）；按 run 开始时的本区对象查存在性
      const baseline = input.region.objectIds
      const missing = baseline.filter(id => !byId.has(id))
      results.push({
        kind: 'preserve_count',
        status: missing.length > 0 ? 'fail' : 'pass',
        reason: missing.length > 0 ? `本区已有对象被删除：${missing.join(', ')}` : `本区 ${baseline.length} 个已有对象都还在`,
        objectIds: [...baseline],
      })
      continue
    }

    // no_collision：只认 clear；unknown / 未检查都不能当通过（§6.5/§6.6）
    if (constraint.kind === 'no_collision') {
      const g = input.geometry
      if (!g) {
        results.push({ kind: 'no_collision', status: 'uncertain', reason: '本轮未执行几何检查，不能宣称无碰撞', objectIds: [] })
      } else if (g.status === 'clear') {
        results.push({ kind: 'no_collision', status: 'pass', reason: `几何检查 clear（${g.highestLevel}）`, objectIds: [] })
      } else if (g.status === 'collision') {
        const hits = g.pairs.filter(p => p.status === 'collision').map(p => `${p.a}×${p.b}`)
        results.push({
          kind: 'no_collision',
          status: 'fail',
          reason: `检测到碰撞：${hits.length > 0 ? hits.join(', ') : '存在 collision 对象对'}`,
          objectIds: [],
        })
      } else {
        results.push({
          kind: 'no_collision',
          status: 'uncertain',
          reason: `几何检查返回 unknown（最高级别 ${g.highestLevel}），不能当 clear`,
          objectIds: [],
        })
      }
    }
  }

  return results
}

/**
 * 对一个任务做程序侧校验（metric + constraint）。
 * visual 判据会出现在 criteria 中但状态为 uncertain，不参与 status 聚合。
 */
export function validateTaskAgainstScene(input: {
  task: UnitTask
  snapshot: SceneSnapshot
  partition: PartitionSnapshot
  createdObjectIds?: string[]
  geometry?: GeometryResult
}): TaskValidation {
  const region = input.partition.regions.find(r => r.id === input.task.regionId)
  if (!region) {
    return {
      taskId: input.task.id,
      regionId: input.task.regionId,
      criteria: input.task.criteria.map(c => ({
        criterionId: c.id,
        kind: c.kind,
        status: 'fail' as const,
        actual: null,
        reason: `区域 ${input.task.regionId} 不在分区里`,
      })),
      constraints: [],
      status: 'fail',
      problems: [`区域 ${input.task.regionId} 不在分区里`],
    }
  }

  const objects = regionObjectsFromSnapshot(input.snapshot, input.partition, region)
  const criteria = evaluateCriteria(input.task, objects)
  const constraints = evaluateConstraints(input.task, {
    snapshot: input.snapshot,
    partition: input.partition,
    region,
    createdObjectIds: input.createdObjectIds ?? [],
    ...(input.geometry ? { geometry: input.geometry } : {}),
  })

  const metricCriteria = criteria.filter(c => c.kind === 'metric')
  const status = aggregate([...metricCriteria.map(c => c.status), ...constraints.map(c => c.status)])
  const problems = [
    ...metricCriteria.filter(c => c.status !== 'pass').map(c => `判据 ${c.criterionId}：${c.reason}`),
    ...constraints.filter(c => c.status !== 'pass').map(c => `约束 ${c.kind}：${c.reason}`),
  ]

  return { taskId: input.task.id, regionId: input.task.regionId, criteria, constraints, status, problems }
}

// ---------------------------------------------------------------------------
// 判定合并：程序算 fail/uncertain 时，不允许模型把它说成 pass
// ---------------------------------------------------------------------------

export type ComputedVerdict = {
  verdict: Verdict
  /** 程序覆盖/降级的原因（进 repairSuggestions 与诊断） */
  issues: string[]
}

export function applyComputedToVerdict(verdict: Verdict, validation: TaskValidation): ComputedVerdict {
  const computedById = new Map(validation.criteria.filter(c => c.kind === 'metric').map(c => [c.criterionId, c]))
  const issues: string[] = []

  const criteria = verdict.criteria.map(entry => {
    const computed = computedById.get(entry.criterionId)
    if (!computed) return entry
    if (computed.status === 'pass') return entry
    if (entry.status === 'pass') {
      issues.push(`判据 ${entry.criterionId} 程序计算为 ${computed.status}：${computed.reason}`)
      return { ...entry, status: computed.status, reason: `${entry.reason}；程序计算：${computed.reason}` }
    }
    return entry
  })

  const constraintFailures = validation.constraints.filter(c => c.status === 'fail')
  const constraintUncertain = validation.constraints.filter(c => c.status === 'uncertain')
  for (const c of constraintFailures) issues.push(`约束 ${c.kind} 未满足：${c.reason}`)
  for (const c of constraintUncertain) issues.push(`约束 ${c.kind} 证据不足：${c.reason}`)

  let status = verdict.status
  const anyFail = criteria.some(c => c.status === 'fail') || constraintFailures.length > 0
  const anyUncertain = criteria.some(c => c.status === 'uncertain') || constraintUncertain.length > 0
  if (anyFail) status = 'fail'
  else if (status === 'pass' && anyUncertain) status = 'uncertain'

  const repairSuggestions = [...verdict.repairSuggestions]
  for (const issue of issues) if (!repairSuggestions.includes(issue)) repairSuggestions.push(issue)

  return {
    verdict: { ...verdict, status, criteria, repairSuggestions },
    issues,
  }
}

// ---------------------------------------------------------------------------
// 终检：最终场景逐任务重算（§6.6）
// ---------------------------------------------------------------------------

export type FinalSceneValidation = {
  checks: FinalCheckItem[]
  problems: string[]
  tasks: Record<string, TaskValidation>
}

function latestVerdict(result: TaskResult | undefined): Verdict | undefined {
  if (!result || result.verdicts.length === 0) return undefined
  return result.verdicts[result.verdicts.length - 1]
}

/**
 * 终检只做两件事：
 * - metric/constraint 用**最终场景**重算（不是汇总历史 pass）；
 * - visual 用该任务最后一轮 Verdict 的对应判据（后续编辑失效重判留 W08.5）。
 */
export function validateFinalScene(input: {
  plan: { tasks: UnitTask[] }
  partition: PartitionSnapshot
  snapshot: SceneSnapshot
  regions: Record<string, RegionResult>
  geometryByTask?: Record<string, GeometryResult | undefined>
}): FinalSceneValidation {
  const checks: FinalCheckItem[] = []
  const problems: string[] = []
  const tasks: Record<string, TaskValidation> = {}

  for (const task of input.plan.tasks) {
    const result = input.regions[task.regionId]?.tasks.find(t => t.taskId === task.id)
    const validation = validateTaskAgainstScene({
      task,
      snapshot: input.snapshot,
      partition: input.partition,
      createdObjectIds: result?.createdObjectIds ?? [],
      ...(input.geometryByTask?.[task.id] ? { geometry: input.geometryByTask[task.id] } : {}),
    })
    tasks[task.id] = validation

    checks.push({
      name: `task-result:${task.id}`,
      passed: result?.status === 'pass',
      evidenceIds: result?.evidenceIds ?? [],
      ...(result ? {} : { note: '任务没有结果' }),
    })
    if (!result || result.status !== 'pass') problems.push(`任务 ${task.id} 没有通过的结果`)

    const verdict = latestVerdict(result)

    for (const criterion of task.criteria) {
      const computed = validation.criteria.find(c => c.criterionId === criterion.id)
      if (criterion.kind === 'metric') {
        checks.push({
          name: `criterion:${task.id}:${criterion.id}`,
          passed: computed?.status === 'pass',
          evidenceIds: result?.evidenceIds ?? [],
          ...(computed ? { note: computed.reason } : { note: '没有计算结果' }),
        })
        if (computed?.status !== 'pass') problems.push(`任务 ${task.id} 判据 ${criterion.id}：${computed?.reason ?? '未计算'}`)
      } else {
        const judged = verdict?.criteria.find(c => c.criterionId === criterion.id)
        checks.push({
          name: `criterion:${task.id}:${criterion.id}`,
          passed: judged?.status === 'pass',
          evidenceIds: judged?.evidenceIds ?? result?.evidenceIds ?? [],
          ...(judged ? { note: judged.reason } : { note: '没有判定结果' }),
        })
        if (judged?.status !== 'pass') problems.push(`任务 ${task.id} 视觉判据 ${criterion.id} 未通过`)
      }
    }

    for (const constraint of validation.constraints) {
      checks.push({
        name: `constraint:${task.id}:${constraint.kind}`,
        passed: constraint.status === 'pass',
        evidenceIds: result?.evidenceIds ?? [],
        note: constraint.reason,
      })
      if (constraint.status !== 'pass') problems.push(`任务 ${task.id} 约束 ${constraint.kind}：${constraint.reason}`)
    }
  }

  return { checks, problems, tasks }
}
