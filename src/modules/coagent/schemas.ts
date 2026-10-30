/**
 * 运行时 schema 校验（W01 冻结）。
 *
 * 选型决策（记录于 IMPLEMENTATION-STATUS）：不引入 zod 等第三方库——宿主 deps 极简
 * （react/three/zustand/drei），契约层保持零运行时依赖，任何工作包可安全引用。
 * 校验器全部返回 ValidationResult，不抛异常；错误信息带 path 便于日志定位。
 * 不导入任何宿主运行时。
 */

import type { PointXZ, UnitTask, Vec3 } from './contracts'

// ---------- 基础形状 ----------

export type ValidationIssue = { path: string; message: string }
export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] }

const ok: ValidationResult = { ok: true }

function fail(path: string, message: string): ValidationResult {
  return { ok: false, issues: [{ path, message }] }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 数值坐标容差（米/度）：边界判定与"面积大于容差"共用（§6.1） */
export const GEOMETRY_EPSILON = 1e-6

export function validateVec3(v: unknown, path: string): ValidationResult {
  if (!Array.isArray(v) || v.length !== 3) return fail(path, '必须是长度为 3 的数组')
  for (let i = 0; i < 3; i++) {
    if (!isFiniteNumber(v[i])) return fail(`${path}[${i}]`, '必须是有限数字')
  }
  return ok
}

export function validateTransformDTO(v: unknown, path: string): ValidationResult {
  if (!isRecord(v)) return fail(path, '必须是对象')
  if (validateVec3(v.position, `${path}.position`).ok === false) {
    return fail(`${path}.position`, 'position 必须是 [x,y,z] 有限数字')
  }
  if (validateVec3(v.rotationDeg, `${path}.rotationDeg`).ok === false) {
    return fail(`${path}.rotationDeg`, 'rotationDeg 必须是 [x,y,z] 有限数字（角度制）')
  }
  if (validateVec3(v.scale, `${path}.scale`).ok === false) {
    return fail(`${path}.scale`, 'scale 必须是 [x,y,z] 有限数字（缺省请显式填 [1,1,1]）')
  }
  return ok
}

// ---------- 多边形（§6.1） ----------

/** 鞋带公式面积（绝对值，平方米） */
export function polygonAreaXZ(points: PointXZ[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, z1] = points[i]
    const [x2, z2] = points[(i + 1) % points.length]
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

function segmentsProperlyIntersect(
  p1: PointXZ,
  p2: PointXZ,
  p3: PointXZ,
  p4: PointXZ,
): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
  if (Math.abs(d) < 1e-12) return false // 平行/共线交由顶点去重与面积校验兜底
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
  return t > GEOMETRY_EPSILON && t < 1 - GEOMETRY_EPSILON && u > GEOMETRY_EPSILON && u < 1 - GEOMETRY_EPSILON
}

/** 自交检测：非相邻边是否真交（相邻边共享顶点的接触不算） */
export function polygonSelfIntersects(points: PointXZ[]): boolean {
  const n = points.length
  for (let i = 0; i < n; i++) {
    const a1 = points[i]
    const a2 = points[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      if (j === i) continue
      const shareVertex =
        j === (i + 1) % n || (j + 1) % n === i || (j + 1) % n === (i + 1) % n
      if (shareVertex) continue
      const b1 = points[j]
      const b2 = points[(j + 1) % n]
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true
    }
  }
  return false
}

export function validatePolygonXZ(v: unknown, path: string): ValidationResult {
  if (!Array.isArray(v) || v.length < 3) return fail(path, '多边形至少需要 3 个顶点')
  for (let i = 0; i < v.length; i++) {
    const p = v[i]
    if (!Array.isArray(p) || p.length !== 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
      return fail(`${path}[${i}]`, '顶点必须是 [x,z] 有限数字')
    }
  }
  const points = v as PointXZ[]
  // 至少 3 个互不相同顶点（按容差去重）
  const distinct: PointXZ[] = []
  for (const p of points) {
    if (!distinct.some(q => Math.abs(q[0] - p[0]) < GEOMETRY_EPSILON && Math.abs(q[1] - p[1]) < GEOMETRY_EPSILON)) {
      distinct.push(p)
    }
  }
  if (distinct.length < 3) return fail(path, '去重后不足 3 个不同顶点')
  if (polygonSelfIntersects(points)) return fail(path, '多边形自交')
  if (polygonAreaXZ(points) <= GEOMETRY_EPSILON) return fail(path, '多边形面积必须大于容差')
  return ok
}

// ---------- 分区 ----------

export function validateRegion(v: unknown): ValidationResult {
  if (!isRecord(v)) return fail('region', '必须是对象')
  if (v.schemaVersion !== 1) return fail('region.schemaVersion', '必须是 1')
  if (!isNonEmptyString(v.id)) return fail('region.id', '必须是非空字符串')
  if (!isNonEmptyString(v.name)) return fail('region.name', '必须是非空字符串')
  const poly = validatePolygonXZ(v.polygonXZ, 'region.polygonXZ')
  if (!poly.ok) return poly
  if (!Array.isArray(v.objectIds) || !v.objectIds.every(isNonEmptyString)) {
    return fail('region.objectIds', '必须是字符串数组')
  }
  if (!isNonEmptyString(v.cameraId)) return fail('region.cameraId', '必须是非空字符串')
  if (!isFiniteNumber(v.partitionVersion) || !Number.isInteger(v.partitionVersion) || v.partitionVersion < 1) {
    return fail('region.partitionVersion', '必须是 ≥1 的整数')
  }
  return ok
}

export function validatePartitionSnapshot(v: unknown): ValidationResult {
  if (!isRecord(v)) return fail('partition', '必须是对象')
  if (!isFiniteNumber(v.partitionVersion) || !Number.isInteger(v.partitionVersion) || v.partitionVersion < 1) {
    return fail('partition.partitionVersion', '必须是 ≥1 的整数')
  }
  if (!Array.isArray(v.regions)) return fail('partition.regions', '必须是数组')
  for (let i = 0; i < v.regions.length; i++) {
    const r = validateRegion(v.regions[i])
    if (!r.ok) return { ok: false, issues: r.issues.map(x => ({ ...x, path: `regions[${i}].${x.path}` })) }
  }
  const ids = new Set(v.regions.map((r: Record<string, unknown>) => r.id))
  if (ids.size !== v.regions.length) return fail('partition.regions', 'region id 重复')
  if (!Array.isArray(v.globalReadonlyObjectIds) || !v.globalReadonlyObjectIds.every(isNonEmptyString)) {
    return fail('partition.globalReadonlyObjectIds', '必须是字符串数组')
  }
  return ok
}

// ---------- 任务与计划 ----------

/** 第一批指标白名单（§4.2）：未实现/未注册指标 → unsupported_metric */
export const SUPPORTED_METRICS = ['region.object_count', 'region.min_pair_distance_xz'] as const
export type MetricName = (typeof SUPPORTED_METRICS)[number]

/**
 * 白名单指标的量纲。
 *
 * 只用于判定文案（`validation.ts` 把 unit 拼进 reason），**不参与任何计算**。
 * 因此模型漏填 unit 时可以按指标补一个确定性默认值（见 `planner.normalizePlanJson`），
 * 这不属于"猜语义"：量纲由指标本身唯一决定。
 */
export const METRIC_UNITS: Record<MetricName, string> = {
  'region.object_count': 'count',
  'region.min_pair_distance_xz': 'm',
}

export function isSupportedMetric(name: unknown): name is MetricName {
  return typeof name === 'string' && (SUPPORTED_METRICS as readonly string[]).includes(name)
}

// ---------- 约束白名单 ----------

/**
 * 任务约束白名单（与 `contracts.Constraint` 一一对应）。
 *
 * 真机实测（2026-10-22）：提示词只举例了 `stay_in_region`，真实模型于是自创了
 * `no_overlap_existing`（语义上就是 `no_collision`），被校验器判"未知约束类型"，
 * 修复轮又没给出白名单 → 两次机会用完 → `invalid_plan`，整轮失败。
 *
 * 因此这里导出白名单，供提示词、修复轮、归一化层共用同一份事实。
 */
export const SUPPORTED_CONSTRAINTS = [
  'stay_in_region',
  'no_collision',
  'preserve_count',
  'preserve_objects',
] as const
export type ConstraintKind = (typeof SUPPORTED_CONSTRAINTS)[number]

export function isSupportedConstraint(name: unknown): name is ConstraintKind {
  return typeof name === 'string' && (SUPPORTED_CONSTRAINTS as readonly string[]).includes(name)
}

/**
 * 同义写法 → 白名单约束的映射（归一化层用）。
 *
 * 只收**语义等价**的写法（在本系统里就是同一件事），不收"看起来像但含义不同"的：
 * - `no_overlap_existing` / `no_overlap` / `avoid_collision` / `no_overlap_with_existing`
 *   → `no_collision`（都是"本轮对象之间不许碰撞"，判定口径一致：几何检查 clear 才算通过）
 * - `keep_in_region` / `remain_in_region` / `inside_region` → `stay_in_region`
 * - `preserve_object_count` / `keep_count` → `preserve_count`
 * - `preserve_existing_objects` / `keep_objects` → `preserve_objects`
 *
 * 不在表里的名字一律**不猜**，仍由校验器报"未知约束类型"。
 */
export const CONSTRAINT_ALIASES: Record<string, ConstraintKind> = {
  no_overlap_existing: 'no_collision',
  no_overlap: 'no_collision',
  avoid_collision: 'no_collision',
  no_overlap_with_existing: 'no_collision',
  keep_in_region: 'stay_in_region',
  remain_in_region: 'stay_in_region',
  inside_region: 'stay_in_region',
  preserve_object_count: 'preserve_count',
  keep_count: 'preserve_count',
  preserve_existing_objects: 'preserve_objects',
  keep_objects: 'preserve_objects',
}

/** 把约束 kind 归一化到白名单：同义名映射；未知名原样返回（交给校验器报错） */
export function normalizeConstraintKind(kind: unknown): unknown {
  if (typeof kind !== 'string') return kind
  if (isSupportedConstraint(kind)) return kind
  return CONSTRAINT_ALIASES[kind] ?? kind
}

function validateCriterion(v: unknown, path: string): ValidationResult {
  if (!isRecord(v)) return fail(path, '必须是对象')
  if (!isNonEmptyString(v.id)) return fail(`${path}.id`, '必须是非空字符串')
  if (v.kind === 'visual') {
    if (!isNonEmptyString(v.description)) return fail(`${path}.description`, 'visual 判据必须有描述')
    return ok
  }
  if (v.kind === 'metric') {
    if (!isNonEmptyString(v.metric)) return fail(`${path}.metric`, 'metric 判据必须指定指标名')
    if (!(SUPPORTED_METRICS as readonly string[]).includes(v.metric)) {
      return fail(`${path}.metric`, `unsupported_metric：${String(v.metric)} 不在白名单 ${SUPPORTED_METRICS.join(', ')}`)
    }
    if (v.operator !== 'gte' && v.operator !== 'lte' && v.operator !== 'eq') {
      return fail(`${path}.operator`, '必须是 gte/lte/eq')
    }
    if (!isFiniteNumber(v.value)) return fail(`${path}.value`, '必须是有限数字')
    if (!isNonEmptyString(v.unit)) return fail(`${path}.unit`, '必须是非空字符串（如 m、count）')
    return ok
  }
  return fail(`${path}.kind`, '必须是 visual 或 metric')
}

function validateConstraint(v: unknown, path: string): ValidationResult {
  if (!isRecord(v)) return fail(path, '必须是对象')
  switch (v.kind) {
    case 'preserve_objects':
      if (!Array.isArray(v.objectIds) || !v.objectIds.every(isNonEmptyString)) {
        return fail(`${path}.objectIds`, 'preserve_objects 必须带字符串数组')
      }
      return ok
    case 'no_collision':
      if (v.basis !== undefined) {
        if (!isRecord(v.basis) || v.basis.source !== 'user_request') {
          return fail(`${path}.basis.source`, 'no_collision 的依据来源只能是 user_request')
        }
        if (!isNonEmptyString(v.basis.quote) || !v.basis.quote.trim()) {
          return fail(`${path}.basis.quote`, 'no_collision 必须引用原始用户请求中的非空原文')
        }
      }
      return ok
    case 'stay_in_region':
    case 'preserve_count':
      return ok
    default:
      return fail(
        `${path}.kind`,
        `未知约束类型 ${String(v.kind)}；只允许 ${SUPPORTED_CONSTRAINTS.join(' / ')}`,
      )
  }
}

const OPERATIONS = ['add', 'transform', 'remove'] as const
/** P1：单任务新增上限（防止一个任务把整个区填满；也约束 creationTarget.maxCount） */
export const MAX_CREATIONS_PER_TASK = 24

export function validateUnitTask(v: unknown): ValidationResult {
  if (!isRecord(v)) return fail('task', '必须是对象')
  if (v.schemaVersion !== 1) return fail('task.schemaVersion', '必须是 1')
  if (!isNonEmptyString(v.id)) return fail('task.id', '必须是非空字符串')
  if (!isNonEmptyString(v.regionId)) return fail('task.regionId', '必须是非空字符串')
  if (!isNonEmptyString(v.objective)) return fail('task.objective', '必须是非空字符串')
  if (!Array.isArray(v.targetObjectIds) || !v.targetObjectIds.every(isNonEmptyString)) {
    return fail('task.targetObjectIds', '必须是字符串数组')
  }
  if (
    !Array.isArray(v.allowedOperations) ||
    v.allowedOperations.length === 0 ||
    !v.allowedOperations.every((op: unknown) => (OPERATIONS as readonly string[]).includes(op as string))
  ) {
    return fail('task.allowedOperations', '必须是非空的 add/transform/remove 子集')
  }
  if (!Array.isArray(v.criteria) || v.criteria.length === 0) {
    return fail('task.criteria', '必须至少有一条判据')
  }
  for (let i = 0; i < v.criteria.length; i++) {
    const c = validateCriterion(v.criteria[i], `criteria[${i}]`)
    if (!c.ok) return c
  }
  if (!Array.isArray(v.constraints)) return fail('task.constraints', '必须是数组')
  for (let i = 0; i < v.constraints.length; i++) {
    const c = validateConstraint(v.constraints[i], `constraints[${i}]`)
    if (!c.ok) return c
  }
  if (!Array.isArray(v.dependsOn) || !v.dependsOn.every(isNonEmptyString)) {
    return fail('task.dependsOn', '必须是字符串数组')
  }
  // P1：结构化数量目标（可选；新 add 计划由 planValidation 强制要求）
  if (v.creationTarget !== undefined) {
    const ct = v.creationTarget
    if (!isRecord(ct)) return fail('task.creationTarget', '必须是 { minCount, maxCount } 对象')
    const min = ct.minCount
    const max = ct.maxCount
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
      return fail('task.creationTarget.minCount', '必须是非负整数')
    }
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
      return fail('task.creationTarget.maxCount', '必须是非负整数')
    }
    if (min > max) return fail('task.creationTarget', 'minCount 不能大于 maxCount')
    if (max > MAX_CREATIONS_PER_TASK) {
      return fail('task.creationTarget.maxCount', `单任务新增上限不能超过 ${MAX_CREATIONS_PER_TASK}`)
    }
  }
  return ok
}

/** 依赖图检查：未知依赖 + 循环（§W01 测试项"任务循环"） */
export function checkTaskDag(tasks: UnitTask[]): ValidationResult {
  const byId = new Map(tasks.map(t => [t.id, t]))
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) return fail(`task[${t.id}].dependsOn`, `依赖了不存在的任务 ${dep}`)
    }
  }
  // DFS 三色标记找环
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(tasks.map(t => [t.id, WHITE]))
  const stack: string[] = []
  const visit = (id: string): boolean => {
    const c = color.get(id)
    if (c === GRAY) {
      stack.push(id)
      return false
    }
    if (c === BLACK) return true
    color.set(id, GRAY)
    stack.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!visit(dep)) return false
    }
    stack.pop()
    color.set(id, BLACK)
    return true
  }
  for (const t of tasks) {
    if (color.get(t.id) === WHITE) {
      stack.length = 0
      if (!visit(t.id)) {
        return fail('tasks', `任务依赖成环：${[...stack, stack[0]].join(' -> ')}`)
      }
    }
  }
  return ok
}

export function validatePlan(v: unknown): ValidationResult {
  if (!isRecord(v)) return fail('plan', '必须是对象')
  if (v.schemaVersion !== 1) return fail('plan.schemaVersion', '必须是 1')
  if (v.kind === 'clarify') {
    if (!isNonEmptyString(v.question)) return fail('plan.question', 'clarify 必须有问题')
    if (!Array.isArray(v.options) || !v.options.every(isNonEmptyString)) {
      return fail('plan.options', '必须是字符串数组（可为空数组外的候选项）')
    }
    return ok
  }
  if (v.kind === 'unsupported') {
    if (!isNonEmptyString(v.reason)) return fail('plan.reason', 'unsupported 必须有原因')
    return ok
  }
  if (v.kind === 'tasks') {
    if (!Array.isArray(v.tasks) || v.tasks.length === 0) return fail('plan.tasks', '必须至少一个任务')
    if (!Array.isArray(v.assumptions) || !v.assumptions.every(isNonEmptyString)) {
      return fail('plan.assumptions', '必须是字符串数组')
    }
    for (let i = 0; i < v.tasks.length; i++) {
      const t = validateUnitTask(v.tasks[i])
      if (!t.ok) return { ok: false, issues: t.issues.map(x => ({ ...x, path: `tasks[${i}].${x.path}` })) }
    }
    return checkTaskDag(v.tasks as UnitTask[])
  }
  return fail('plan.kind', '必须是 tasks/clarify/unsupported')
}

/** 跨区依赖非法（§3.3 regionGraph 禁止跨区依赖） */
export function checkTasksSameRegion(tasks: UnitTask[]): ValidationResult {
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      const target = tasks.find(x => x.id === dep)
      if (target && target.regionId !== t.regionId) {
        return fail(`task[${t.id}]`, `跨区依赖非法：${t.id}(${t.regionId}) 依赖 ${dep}(${target.regionId})`)
      }
    }
  }
  return ok
}

// ---------- 相机快照 ----------

export function validateCameraSnapshot(v: unknown): ValidationResult {
  if (!isRecord(v)) return fail('camera', '必须是对象')
  if (v.schemaVersion !== 1) return fail('camera.schemaVersion', '必须是 1')
  if (!isNonEmptyString(v.id)) return fail('camera.id', '必须是非空字符串')
  if (v.projection !== 'perspective' && v.projection !== 'orthographic') {
    return fail('camera.projection', '必须是 perspective 或 orthographic')
  }
  for (const key of ['position', 'target', 'up'] as const) {
    if (validateVec3(v[key], `camera.${key}`).ok === false) {
      return fail(`camera.${key}`, `${key} 必须是 [x,y,z] 有限数字`)
    }
  }
  if (!isFiniteNumber(v.near) || !isFiniteNumber(v.far) || !(v.near < v.far)) {
    return fail('camera.near/far', '必须是有限数字且 near < far')
  }
  if (!isFiniteNumber(v.aspect) || v.aspect <= 0) return fail('camera.aspect', '必须 > 0')
  if (v.projection === 'perspective') {
    if (!isFiniteNumber(v.fovDeg) || !(v.fovDeg > 0 && v.fovDeg < 180)) {
      return fail('camera.fovDeg', 'perspective 必须带 (0,180) 内的 fovDeg')
    }
  } else if (!isRecord(v.ortho) || ![v.ortho.left, v.ortho.right, v.ortho.top, v.ortho.bottom].every(isFiniteNumber)) {
    return fail('camera.ortho', 'orthographic 必须带 left/right/top/bottom 有限数字')
  }
  return ok
}

// ---------- 判定 ----------

export function validateVerdict(v: unknown): ValidationResult {
  if (!isRecord(v)) return fail('verdict', '必须是对象')
  if (v.schemaVersion !== 1) return fail('verdict.schemaVersion', '必须是 1')
  if (!isNonEmptyString(v.taskId)) return fail('verdict.taskId', '必须是非空字符串')
  if (v.status !== 'pass' && v.status !== 'fail' && v.status !== 'uncertain') {
    return fail('verdict.status', '必须是 pass/fail/uncertain')
  }
  if (!Array.isArray(v.criteria) || v.criteria.length === 0) {
    return fail('verdict.criteria', '必须至少一项判据结果')
  }
  for (let i = 0; i < v.criteria.length; i++) {
    const c = v.criteria[i] as Record<string, unknown>
    if (!isRecord(c)) return fail(`verdict.criteria[${i}]`, '必须是对象')
    if (!isNonEmptyString(c.criterionId)) return fail(`verdict.criteria[${i}].criterionId`, '必须是非空字符串')
    if (c.status !== 'pass' && c.status !== 'fail' && c.status !== 'uncertain') {
      return fail(`verdict.criteria[${i}].status`, '必须是 pass/fail/uncertain')
    }
    if (!Array.isArray(c.evidenceIds) || !c.evidenceIds.every(isNonEmptyString)) {
      return fail(`verdict.criteria[${i}].evidenceIds`, '必须是字符串数组')
    }
    if (!isNonEmptyString(c.reason)) return fail(`verdict.criteria[${i}].reason`, '必须给出理由')
  }
  if (!Array.isArray(v.repairSuggestions) || !v.repairSuggestions.every(isNonEmptyString)) {
    return fail('verdict.repairSuggestions', '必须是字符串数组')
  }
  return ok
}

// ---------- 指纹（§6.4） ----------

/**
 * 对象指纹：规范化 ref/transform/visible 派生。
 * 真实 editorAdapter 与 FakeEditor 共用本函数，保证契约测试口径一致。
 * scale 缺省按 [1,1,1]；visible 缺省按 true（与 core 语义一致）。
 */
export function computeAssetFingerprint(input: {
  ref: string
  transform: { position: Vec3; rotationDeg?: Vec3; rotation?: Vec3; scale?: Vec3 }
  visible?: boolean
}): string {
  const t = input.transform
  const rot = (t.rotationDeg ?? t.rotation ?? [0, 0, 0]) as Vec3
  const scale = t.scale ?? [1, 1, 1]
  const visible = input.visible !== false
  // 轻量 FNV-1a：无需加密强度，只要稳定且能区分字段差异
  const canonical = JSON.stringify([
    input.ref,
    t.position,
    rot,
    scale,
    visible,
  ])
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fp1-${hash.toString(16).padStart(8, '0')}`
}
