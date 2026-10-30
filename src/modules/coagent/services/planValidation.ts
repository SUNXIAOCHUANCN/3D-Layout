/**
 * planValidation（W07）——计划进入执行前的**语义**校验（schema 之外的那一层）。
 *
 * 为什么不能只靠 schema：形状合法 ≠ 事实成立。模型常见编造：
 * - 目标 id 不存在（或不属于该区）；
 * - "更稀疏"给一个超出场景尺度的阈值；
 * - 目标数量与当前区对象数矛盾（没声明 add 却要求 count 变成 3）；
 * - 声明 transform 却一个目标都不给（等于"你猜"）；
 * - 既声明 preserve_count 又要 add/remove。
 *
 * 这些全部在这里拒掉，且**真实模型与假模型走同一套**（SPEC §W07 完成条件：不允许
 * "真实模型免校验"分支）。
 */

import type { AssetDTO, PartitionSnapshot, Plan, TasksPlan, UnitTask } from '../contracts'

export interface PlanLimits {
  maxTasks: number
  maxTargetsPerTask: number
  /** 单条请求最长字符数（objective） */
  maxObjectiveChars: number
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  maxTasks: 8,
  maxTargetsPerTask: 6,
  maxObjectiveChars: 300,
}

export interface PlanIssue {
  path: string
  message: string
}

/** 仅新生成计划传入；旧计划读取与执行期事实校验不要求补写依据。 */
export interface PlanPolicyContext {
  userRequest: string
}

export function sceneDiagonal(assets: Array<{ transform: { position: [number, number, number] } }>): number {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const a of assets) {
    minX = Math.min(minX, a.transform.position[0])
    maxX = Math.max(maxX, a.transform.position[0])
    minZ = Math.min(minZ, a.transform.position[2])
    maxZ = Math.max(maxZ, a.transform.position[2])
  }
  if (!Number.isFinite(minX)) return 0
  return Math.hypot(maxX - minX, maxZ - minZ)
}

/** 语义校验：只处理 tasks 计划；clarify/unsupported 由调用方按 kind 处理 */
export function validateTaskPlanSemantics(
  plan: TasksPlan,
  partition: PartitionSnapshot,
  assets: AssetDTO[],
  limits: PlanLimits = DEFAULT_PLAN_LIMITS,
  policy?: PlanPolicyContext,
): PlanIssue[] {
  const issues: PlanIssue[] = []
  const assetById = new Map(assets.map(a => [a.id, a]))
  const regionById = new Map(partition.regions.map(r => [r.id, r]))
  const diagonal = sceneDiagonal(assets)

  if (plan.tasks.length === 0) issues.push({ path: 'plan.tasks', message: '没有任何任务' })
  if (plan.tasks.length > limits.maxTasks) {
    issues.push({ path: 'plan.tasks', message: `任务数 ${plan.tasks.length} 超过上限 ${limits.maxTasks}` })
  }

  const seenTaskIds = new Set<string>()
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i]
    const at = `tasks[${i}]`
    if (seenTaskIds.has(t.id)) issues.push({ path: `${at}.id`, message: `任务 id 重复：${t.id}` })
    seenTaskIds.add(t.id)

    if (t.objective.length > limits.maxObjectiveChars) {
      issues.push({ path: `${at}.objective`, message: `目标描述超过 ${limits.maxObjectiveChars} 字` })
    }

    const region = regionById.get(t.regionId)
    if (!region) {
      issues.push({ path: `${at}.regionId`, message: `区域 ${t.regionId} 不在分区里` })
      continue
    }

    if (t.targetObjectIds.length > limits.maxTargetsPerTask) {
      issues.push({ path: `${at}.targetObjectIds`, message: `目标数 ${t.targetObjectIds.length} 超过上限 ${limits.maxTargetsPerTask}` })
    }
    if (t.allowedOperations.length === 0) {
      issues.push({ path: `${at}.allowedOperations`, message: '至少声明一种操作' })
    }

    const mutating = t.allowedOperations.some(op => op === 'transform' || op === 'remove')
    if (mutating && t.targetObjectIds.length === 0) {
      issues.push({ path: `${at}.targetObjectIds`, message: '声明了 transform/remove 却没有目标对象（不允许"你猜"）' })
    }
    if (t.allowedOperations.includes('add') && t.targetObjectIds.length > 0) {
      issues.push({
        path: `${at}.targetObjectIds`,
        message: 'add 任务不应同时列 targetObjectIds（新增对象此时还不存在，请改成空数组 []）',
      })
    }

    for (const id of t.targetObjectIds) {
      const asset = assetById.get(id)
      if (!asset) {
        issues.push({ path: `${at}.targetObjectIds`, message: `对象 ${id} 不存在于当前场景（不允许编造 id）` })
        continue
      }
      if (!region.objectIds.includes(id)) {
        issues.push({ path: `${at}.targetObjectIds`, message: `对象 ${id} 不属于区域 ${region.id}` })
      }
      if (partition.globalReadonlyObjectIds.includes(id)) {
        issues.push({ path: `${at}.targetObjectIds`, message: `对象 ${id} 是 global_readonly，首版禁止修改` })
      }
    }

    // ---- 指标事实一致性（防止编造阈值） ----
    for (let c = 0; c < t.criteria.length; c++) {
      const crit = t.criteria[c]
      if (crit.kind !== 'metric') continue
      const atC = `${at}.criteria[${c}]`
      if (!(crit.value > 0) && crit.metric !== 'region.min_pair_distance_xz') {
        issues.push({ path: `${atC}.value`, message: `指标值必须为正数（当前 ${crit.value}）` })
      }
      if (crit.metric === 'region.object_count') {
        if (!Number.isInteger(crit.value)) issues.push({ path: `${atC}.value`, message: '对象数必须是整数' })
        const current = region.objectIds.length
        const canAdd = t.allowedOperations.includes('add')
        const canRemove = t.allowedOperations.includes('remove')
        if (!canAdd && !canRemove) {
          if (crit.value !== current) {
            issues.push({
              path: `${atC}.value`,
              message: `未声明 add/remove 却要求对象数变为 ${crit.value}（当前 ${region.id} 有 ${current} 个）`,
            })
          }
        } else if (canAdd && !canRemove && crit.value < current) {
          issues.push({ path: `${atC}.value`, message: `只能新增却要求对象数降到 ${crit.value}（当前 ${current}）` })
        } else if (canRemove && !canAdd && crit.value > current) {
          issues.push({ path: `${atC}.value`, message: `只能删除却要求对象数升到 ${crit.value}（当前 ${current}）` })
        }
      }
      if (crit.metric === 'region.min_pair_distance_xz') {
        if (!(crit.value > 0)) issues.push({ path: `${atC}.value`, message: '距离阈值必须为正' })
        if (diagonal > 0 && crit.value > diagonal + 1e-6) {
          issues.push({
            path: `${atC}.value`,
            message: `距离阈值 ${crit.value}m 超过场景尺度 ${diagonal.toFixed(1)}m（编造的阈值）`,
          })
        }
      }
    }

    // ---- 约束自洽 ----
    for (let k = 0; k < t.constraints.length; k++) {
      const con = t.constraints[k]
      if (con.kind === 'no_collision' && policy) {
        const path = `${at}.constraints[${k}].basis`
        if (!con.basis) {
          issues.push({ path, message: 'no_collision 缺少原始用户请求依据；普通布局不默认要求零碰撞' })
        } else if (con.basis.source !== 'user_request' || !con.basis.quote.trim() || !policy.userRequest.includes(con.basis.quote)) {
          issues.push({ path, message: 'no_collision 的依据必须引用原始用户请求中的非空原文，不能引用任务 objective 或自行编造' })
        }
      }
      if (con.kind === 'stay_in_region' && t.targetObjectIds.length === 0 && !t.allowedOperations.includes('add')) {
        // add 任务的新对象此刻还没有 id，stay_in_region 约束的是"落点"，允许没有 target
        issues.push({ path: `${at}.constraints[${k}]`, message: 'stay_in_region 需要至少一个目标对象（或 add 操作）' })
      }
      if (con.kind === 'preserve_objects') {
        for (const id of con.objectIds) {
          if (!assetById.has(id)) issues.push({ path: `${at}.constraints[${k}].objectIds`, message: `要保留的对象 ${id} 不存在` })
        }
      }
      // preserve_count 的语义是"别把已有对象删掉"（新增允许）；只有 remove 才冲突
      if (con.kind === 'preserve_count' && t.allowedOperations.includes('remove')) {
        issues.push({ path: `${at}.constraints[${k}]`, message: 'preserve_count 与 remove 冲突（不能一边要求保留数量一边删对象）' })
      }
    }

    // ---- 依赖 ----
    for (const dep of t.dependsOn) {
      const depTask: UnitTask | undefined = plan.tasks.find(x => x.id === dep)
      if (!depTask) issues.push({ path: `${at}.dependsOn`, message: `依赖的任务 ${dep} 不存在` })
      else if (depTask.regionId !== t.regionId) issues.push({ path: `${at}.dependsOn`, message: `禁止跨区依赖（${dep}）` })
    }

    // ---- P1：add 任务必须有结构化数量目标 ----
    // 只在"新生成计划"的路径（传了 policy）强制；旧计划重放/执行期事实校验不补写。
    if (policy && t.allowedOperations.includes('add')) {
      if (!t.creationTarget) {
        issues.push({
          path: `${at}.creationTarget`,
          message: 'add 任务必须给出结构化数量目标 { minCount, maxCount }；"几栋"要落成具体数字，不能只写在 objective 里',
        })
      } else if (t.creationTarget.minCount > t.creationTarget.maxCount) {
        issues.push({ path: `${at}.creationTarget`, message: 'minCount 不能大于 maxCount' })
      }
    } else if (t.creationTarget && !t.allowedOperations.includes('add')) {
      issues.push({ path: `${at}.creationTarget`, message: '非 add 任务不能声明 creationTarget（不能借此获得新增权限）' })
    }
  }

  return issues
}

/** 统一出口：tasks 才查语义；其它 kind 返回空（由调用方按 kind 处理） */
export function validatePlanSemantics(
  plan: Plan,
  partition: PartitionSnapshot,
  assets: AssetDTO[],
  limits: PlanLimits = DEFAULT_PLAN_LIMITS,
  policy?: PlanPolicyContext,
): PlanIssue[] {
  if (plan.kind !== 'tasks') return []
  return validateTaskPlanSemantics(plan, partition, assets, limits, policy)
}
