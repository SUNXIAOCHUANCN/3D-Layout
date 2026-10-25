/**
 * planner（W07）——真实规划器外壳：只读工具核对事实 + 结构化计划 + 分层校验。
 *
 * 与 W05 的差别（SPEC §W07）：
 * - **精简上下文**：由 plannerContext 生成（关键词命中 + 每区样本 + 视口近邻 + 相关模型库），
 *   不再把全场景/全库塞给模型；
 * - **按需观察**：规划器可以用只读工具（scene.get_objects / camera.capture / library.search…）
 *   核对对象与数量，再输出计划；写工具对 main 角色根本不可见（registry 过滤）；
 * - **同一套校验**：schema（validatePlan）+ 语义（planValidation：id 存在/指标自洽/阈值不超尺/约束冲突），
 *   真实模型与假模型没有"免校验"分支。
 *
 * clarify / unsupported 原样返回，由 mainGraph 映射成 needs_clarification / rolled_back。
 */

import type { AssetDTO, CoAgentConfig, ModelMessage, ModelPort, Plan, PartitionSnapshot, TasksPlan, UnitTask } from '../contracts'
import { CoAgentError } from '../contracts'
import { checkTaskDag, isSupportedMetric, METRIC_UNITS, normalizeConstraintKind, validatePlan } from '../schemas'
import { validatePlanSemantics, type PlanLimits } from '../services/planValidation'
import { runToolLoop } from './modelLoop'
import { SYSTEM_PLANNER } from './prompts'
import type { ToolRegistry } from '../tools/registry'
import { logError, logStage, logWarn } from '../runtime/runLog'

export interface PlannerInput {
  runId: string
  model: ModelPort
  signal: AbortSignal
  config: CoAgentConfig
  registry: ToolRegistry
  /** plannerContext.buildPlannerContext(...).text */
  contextText: string
  partition: PartitionSnapshot
  assets: AssetDTO[]
  limits?: PlanLimits
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON 对象')
  return JSON.parse(text.slice(start, end + 1))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 真实模型常见的"形状偏差"，在进入 schema 前做**安全归一化**：
 * - 整个计划包在 `{ plan: {...} }` 里；
 * - 每个任务包在 `{ task: {...} }` 里；
 * - 省略重复的 `schemaVersion`，或省略空的 `assumptions/dependsOn/constraints`；
 * - metric 判据漏填 `unit`（真实模型实测：`criteria[0].unit 必须是非空字符串`）——
 *   量纲由白名单指标唯一决定（m / count），且 unit 只进判定文案、不参与计算。
 *
 * 只补"值已知且无歧义"的缺省（schemaVersion=1、空数组、指标量纲），不猜 objective/target/region；
 * 显式写错的版本号、operator、value 仍然会被 validator 拒绝。
 */
export function normalizePlanJson(value: unknown): unknown {
  if (!isRecord(value)) return value
  const plan = isRecord(value.plan) && value.kind === undefined ? value.plan : value
  if (!isRecord(plan) || plan.kind !== 'tasks' || !Array.isArray(plan.tasks)) return plan

  const tasks = plan.tasks.map(item => {
    if (!isRecord(item)) return item
    const task = isRecord(item.task) ? item.task : item
    return {
      ...task,
      schemaVersion: task.schemaVersion ?? 1,
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
      constraints: Array.isArray(task.constraints) ? task.constraints.map(fillConstraintKind) : [],
      ...(Array.isArray(task.criteria) ? { criteria: task.criteria.map(fillCriterionUnit) } : {}),
    }
  })

  return {
    ...plan,
    schemaVersion: plan.schemaVersion ?? 1,
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions : [],
    tasks,
  }
}

/**
 * 约束 kind 的**同义名**归一化。
 *
 * 真机实测（2026-10-22）：提示词只举例了 `stay_in_region`，模型自创了
 * `no_overlap_existing`（语义上等于系统的 `no_collision`）→ 校验器判"未知约束类型"
 * → 修复轮没有白名单可依 → 两次机会用完，整轮 `invalid_plan`。
 *
 * 这里只映射**语义等价**的写法（见 `schemas.CONSTRAINT_ALIASES`）；不在表里的名字
 * 原样保留，仍由校验器报"未知约束类型"——不猜语义。
 */
function fillConstraintKind(constraint: unknown): unknown {
  if (!isRecord(constraint)) return constraint
  const kind = normalizeConstraintKind(constraint.kind)
  if (kind === constraint.kind) return constraint
  return { ...constraint, kind }
}

/** 只给白名单 metric 判据补量纲；其它情况原样返回，交给 validator 报错 */
function fillCriterionUnit(criterion: unknown): unknown {
  if (!isRecord(criterion) || criterion.kind !== 'metric') return criterion
  const unit = criterion.unit
  if (typeof unit === 'string' && unit.trim().length > 0) return criterion
  if (!isSupportedMetric(criterion.metric)) return criterion
  return { ...criterion, unit: METRIC_UNITS[criterion.metric] }
}

function repairText(issues: string[]): string {
  const emptyTasks = issues.some(i => i.includes('至少一个任务'))
  const shapeIssues = issues.some(i => i.includes('schemaVersion') || i.includes('tasks[') || i.includes('task.'))
  // 真实模型实测：metrics 判据漏 unit/operator（`criteria[0].unit 必须是非空字符串`）
  const criteriaIssues = issues.some(i => i.includes('criteria') || i.includes('unit') || i.includes('operator'))
  // 真实模型实测：自创约束名（`constraints[1].kind 未知约束类型 no_overlap_existing`）
  const constraintIssues = issues.some(i => i.includes('constraints') || i.includes('未知约束类型'))
  // 真实模型实测：add 任务却列了 targetObjectIds（`add 任务不应同时列 targetObjectIds`）
  const targetIssues = issues.some(i => i.includes('targetObjectIds') || i.includes('allowedOperations'))
  return [
    '上一份计划不合格，只修这些地方后重新输出完整 JSON：',
    ...issues.slice(0, 12).map(i => `- ${i}`),
    ...(shapeIssues
      ? [
          '形状要求：每个 tasks[i] 必须**直接**是任务对象，不能再包一层 {"task": …} 或 {"plan": …}。',
          '每个任务必须写全：schemaVersion(1)、id、regionId、objective、targetObjectIds、allowedOperations、criteria、constraints、dependsOn。',
          '示例：{"schemaVersion":1,"kind":"tasks","assumptions":[],"tasks":[{"schemaVersion":1,"id":"task-1","regionId":"region-x","objective":"…","targetObjectIds":["obj-1"],"allowedOperations":["transform"],"criteria":[{"id":"c1","kind":"visual","description":"…"}],"constraints":[{"kind":"stay_in_region"}],"dependsOn":[]}]}',
        ]
      : []),
    ...(criteriaIssues
      ? [
          '判据形状：visual 用 {"id":"c1","kind":"visual","description":"…"}；',
          'metric 必须写全 metric/operator/value/unit，例如',
          '{"id":"c2","kind":"metric","metric":"region.min_pair_distance_xz","operator":"gte","value":1.5,"unit":"m"}',
          '（operator 只能是 gte/lte/eq；距离类 unit 用 m，region.object_count 用 count）。',
        ]
      : []),
    ...(emptyTasks
      ? [
          '注意：tasks 不能为空。',
          '如果你认为这个请求无法拆成可执行任务（例如"乱一点/好一点"无法量化、缺少明确对象），',
          '不要返回空 tasks，请改为输出：{"schemaVersion":1,"kind":"clarify","question":"…","options":["…","…"]}',
          '并在 question 里问清楚程度或对象。',
        ]
      : []),
    ...(constraintIssues
      ? [
          '约束白名单：constraints[].kind 只能是这 4 个之一（不要自创名字，也不要用同义写法）：',
          '{"kind":"stay_in_region"} | {"kind":"no_collision"} | {"kind":"preserve_count"} | {"kind":"preserve_objects","objectIds":["obj-1"]}',
          '（例如想表达"不与已有的重叠"就写 {"kind":"no_collision"}，不要写 no_overlap_existing。）',
        ]
      : []),
    ...(targetIssues
      ? [
          '目标对象与操作要自洽：声明 transform/remove 时 targetObjectIds 必须非空；',
          '声明 add（新增对象）时 targetObjectIds 必须是空数组 []（新增对象此刻还没有 id），',
          '"要新增几个"写进 objective 即可。',
        ]
      : []),
    '不要解释，不要新增未要求的操作。',
  ].join('\n')
}

export async function makePlan(input: PlannerInput): Promise<Plan> {
  let messages: ModelMessage[] = [{ role: 'user', text: input.contextText }]
  let issues: string[] = []

  for (let attempt = 0; attempt <= input.config.schemaRepairAttempts; attempt++) {
    if (input.signal.aborted) throw new CoAgentError('cancelled', '规划被取消')
    logStage(
      'planner.attempt',
      `第 ${attempt + 1}/${input.config.schemaRepairAttempts + 1} 次规划请求`,
      messages.length > 1 ? `携带 ${messages.length - 1} 条上文（含上一次的修复要求）` : '首次请求',
    )
    const loop = await runToolLoop({
      role: 'main',
      purpose: 'planner',
      system: SYSTEM_PLANNER,
      messages,
      model: input.model,
      registry: input.registry,
      site: { runId: input.runId, taskId: null, regionId: null },
      signal: input.signal,
      config: input.config,
      maxRounds: 4,
    })
    logStage(
      'planner.reply',
      `第 ${attempt + 1} 次回包（${loop.text.length} 字符，工具调用 ${loop.toolCalls} 次，stop=${loop.stopReason}）`,
      loop.text,
    )

    let parsed: unknown = null
    try {
      parsed = normalizePlanJson(extractJson(loop.text))
    } catch (e) {
      issues = [`计划不是合法 JSON：${e instanceof Error ? e.message : String(e)}`]
      logWarn('planner.parse', `第 ${attempt + 1} 次回包不是合法 JSON`, issues[0])
    }

    if (parsed !== null) {
      const shape = validatePlan(parsed)
      if (!shape.ok) {
        issues = shape.issues.map(i => `${i.path} ${i.message}`)
        logWarn('planner.schema', `第 ${attempt + 1} 次计划 schema 不合格（${issues.length} 项）`, issues.map(i => `- ${i}`).join('\n'))
      } else {
        const plan = parsed as Plan
        if (plan.kind !== 'tasks') {
          logStage('planner.plan', `第 ${attempt + 1} 次计划为 ${plan.kind}（不需要执行）`, JSON.stringify(plan))
          return plan // clarify / unsupported：由上层映射
        }
        const semantic = validatePlanSemantics(plan, input.partition, input.assets, input.limits)
        const dag = checkTaskDag(plan.tasks)
        if (!dag.ok) semantic.push(...dag.issues.map(i => ({ path: i.path, message: i.message })))
        if (semantic.length === 0) {
          logStage('planner.plan', `第 ${attempt + 1} 次计划通过全部校验（${plan.tasks.length} 个任务）`, JSON.stringify(plan))
          return plan
        }
        issues = semantic.map(i => `${i.path} ${i.message}`)
        logWarn('planner.semantics', `第 ${attempt + 1} 次计划语义不合格（${issues.length} 项）`, issues.map(i => `- ${i}`).join('\n'))
      }
    }

    const repair = repairText(issues)
    messages = [...loop.transcript, { role: 'user', text: repair }]
    logStage('planner.repair', `发起第 ${attempt + 1} 次修复请求`, repair)
  }

  const emptyTasks = issues.some(i => i.includes('至少一个任务'))
  const hint = emptyTasks
    ? '（模型没有给出可执行任务：请把要求改成可量化的，例如"每个建筑随机偏移 0.5~1 米"）'
    : ''
  logError('planner.fail', `计划连续 ${input.config.schemaRepairAttempts + 1} 次不合格`, issues.map(i => `- ${i}`).join('\n'), { issues })
  throw new CoAgentError('invalid_plan', `计划连续 ${input.config.schemaRepairAttempts + 1} 次不合格：${issues.join('; ')}${hint}`, {
    details: { issues },
  })
}

/** 计划里某区的任务（按 dependsOn 拓扑序，只在本区） */
export function tasksOfRegion(plan: TasksPlan, regionId: string): UnitTask[] {
  const tasks = plan.tasks.filter(t => t.regionId === regionId)
  const byId = new Map(tasks.map(t => [t.id, t]))
  const visited = new Set<string>()
  const out: UnitTask[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    visited.add(id)
    const task = byId.get(id)
    if (!task) return
    for (const dep of task.dependsOn) visit(dep)
    out.push(task)
  }
  for (const t of tasks) visit(t.id)
  return out
}
