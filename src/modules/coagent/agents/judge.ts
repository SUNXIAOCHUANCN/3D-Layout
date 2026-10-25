/**
 * judge（W05）——只看证据下结论，没有写权限。
 *
 * 代码在这里做三件"不信模型"的事：
 * 1. 证据 ID 必须存在且属于本轮（before/after/执行期捕获）；编造 ID → 直接 fail；
 * 2. criterionId 必须来自任务本身的判据；漏判/多判 → fail（判定不可跳过判据）；
 * 3. 状态自洽：status=pass 但任一 criterion 不是 pass → 降级为 fail。
 *
 * 判定输出不合格（schema 错）同样视为 fail，而不是"当作通过"。
 */

import type {
  CoAgentConfig,
  GeometryResult,
  ModelImage,
  ModelPort,
  Observation,
  ObservationId,
  UnitTask,
  Verdict,
  WorkflowContext,
} from '../contracts'
import { CoAgentError } from '../contracts'
import { validateVerdict } from '../schemas'
import { applyComputedToVerdict, observationPairIssues, validateTaskAgainstScene, type TaskValidation } from '../services/validation'
import { judgeRequestText, SYSTEM_JUDGE } from './prompts'
import { logStage, logWarn } from '../runtime/runLog'

export interface JudgeInput {
  task: UnitTask
  /** 当前 run（证据必须属于它，§6.3） */
  runId: string
  before: Observation
  after: Observation
  /** 执行期捕获（camera.capture 工具返回） */
  extraEvidenceIds?: ObservationId[]
  /** 本任务执行期新增的对象（add 任务没有 target，区域检查必须靠它） */
  createdObjectIds?: string[]
  geometry?: GeometryResult
  model: ModelPort
  signal: AbortSignal
  config: CoAgentConfig
  context: WorkflowContext
}

export interface JudgeOutput {
  verdict: Verdict
  /** 判定是否可信（false = schema/证据/判据不自洽，已按 fail 处理） */
  credible: boolean
  issues: string[]
  /** W08.1：程序侧 metric/constraint 计算结果（诊断与测试用） */
  validation: TaskValidation
}

function failVerdict(task: UnitTask, reason: string): Verdict {
  return {
    schemaVersion: 1,
    taskId: task.id,
    status: 'fail',
    criteria: task.criteria.map(c => ({ criterionId: c.id, status: 'fail' as const, evidenceIds: [], reason })),
    repairSuggestions: [reason],
  }
}

function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON 对象')
  return JSON.parse(text.slice(start, end + 1))
}

export async function judgeTask(input: JudgeInput): Promise<JudgeOutput> {
  // W08.1：先把程序能算的事实算出来，再让模型看着这些事实判定。
  // metric 与 hard constraint 不再由模型"口头保证"。
  const snapshot = input.context.editorRead.snapshot({})
  const validation = validateTaskAgainstScene({
    task: input.task,
    snapshot,
    partition: input.context.partition,
    createdObjectIds: input.createdObjectIds ?? [],
    ...(input.geometry ? { geometry: input.geometry } : {}),
  })

  logStage(
    'judge.start',
    `[${input.task.regionId}/${input.task.id}] 判定开始`,
    [
      `判据：${input.task.criteria.map(c => `${c.id}:${c.kind}`).join('，')}`,
      `约束：${input.task.constraints.map(c => c.kind).join('，') || '（无）'}`,
      `证据：before=${input.before.id}，after=${input.after.id}，执行期 ${input.extraEvidenceIds?.length ?? 0} 条`,
      `几何检测：${input.geometry ? input.geometry.status : '未执行'}`,
      `程序计算（metric/constraint，模型不能推翻 pass→fail）：`,
      JSON.stringify({ criteria: validation.criteria, constraints: validation.constraints }, null, 2),
    ].join('\n'),
  )

  // W08.2：before/after 必须同 run/任务/区域/分区版本/相机/尺寸，否则不能拿两张图比较（§6.3）。
  const pairIssues = observationPairIssues(input.task, input.before, input.after, { runId: input.runId })
  if (pairIssues.length > 0) {
    const reason = `before/after 证据不可配对：${pairIssues.join('；')}`
    logWarn('judge.pair', `[${input.task.regionId}/${input.task.id}] before/after 不可配对（直接判 fail，不调模型）`, reason)
    return { verdict: failVerdict(input.task, reason), credible: false, issues: pairIssues, validation }
  }

  // W08.2：把真实证据图送进判定请求。visual 判据没有图就不能 pass。
  const hasVisual = input.task.criteria.some(c => c.kind === 'visual')
  const images: ModelImage[] = []
  const imageLabels: string[] = []
  const imageIssues: string[] = []
  const addImage = async (label: string, observation: Observation): Promise<void> => {
    try {
      const dataUrl = await input.context.getImageDataUrl(observation.rgbImageId)
      if (dataUrl) {
        images.push({ mediaType: 'image/png', dataUrl })
        imageLabels.push(label)
        return
      }
      imageIssues.push(`${label} 证据图无法取回（${observation.rgbImageId}）`)
    } catch (e) {
      imageIssues.push(`${label} 证据图读取失败（${observation.rgbImageId}）：${CoAgentError.from(e).message}`)
    }
  }
  await addImage('before', input.before)
  await addImage('after', input.after)
  logStage(
    'judge.images',
    `[${input.task.regionId}/${input.task.id}] 附带证据图 ${images.length} 张（${imageLabels.join(' → ') || '无'}）`,
    imageIssues.join('\n'),
  )
  if (hasVisual && imageIssues.length > 0) {
    const reason = `visual 判定缺少证据图：${imageIssues.join('；')}`
    logWarn('judge.images', `[${input.task.regionId}/${input.task.id}] visual 缺少证据图（直接判 fail）`, reason)
    return { verdict: failVerdict(input.task, reason), credible: false, issues: [reason, ...imageIssues], validation }
  }

  const reply = await input.model.complete(
    {
      purpose: 'judge',
      system: SYSTEM_JUDGE,
      messages: [
        {
          role: 'user',
          text: judgeRequestText({
            task: input.task,
            evidence: { baselineId: input.before.id, afterId: input.after.id },
            ...(input.geometry ? { geometry: input.geometry } : {}),
            computed: { criteria: validation.criteria, constraints: validation.constraints },
            imageLabels,
          }),
          ...(images.length > 0 ? { images } : {}),
        },
      ],
      tools: [], // judge 没有工具（写工具在 registry 里也不给它）
      timeoutMs: input.config.modelTimeoutMs,
    },
    input.signal,
  )

  let parsed: unknown
  try {
    parsed = extractJson(reply.text)
  } catch (e) {
    const reason = `判定不是合法 JSON：${e instanceof Error ? e.message : String(e)}`
    logWarn('judge.parse', `[${input.task.regionId}/${input.task.id}] 判定回包不是合法 JSON`, `${reason}\n\n回包：${reply.text.slice(0, 4_000)}`)
    return { verdict: failVerdict(input.task, reason), credible: false, issues: [reason], validation }
  }

  const shape = validateVerdict(parsed)
  if (!shape.ok) {
    const issues = shape.issues.map(i => `${i.path} ${i.message}`)
    logWarn('judge.schema', `[${input.task.regionId}/${input.task.id}] 判定 schema 不合法`, issues.map(i => `- ${i}`).join('\n'))
    return { verdict: failVerdict(input.task, `判定 schema 不合法：${issues.join('; ')}`), credible: false, issues, validation }
  }

  const verdict = parsed as Verdict
  const issues: string[] = []

  if (verdict.taskId !== input.task.id) issues.push(`verdict.taskId=${verdict.taskId} 与任务 ${input.task.id} 不一致`)

  const allowedEvidence = new Set<string>([input.before.id, input.after.id, ...(input.extraEvidenceIds ?? [])])
  const knownCriteria = new Set(input.task.criteria.map(c => c.id))
  for (const c of verdict.criteria) {
    if (!knownCriteria.has(c.criterionId)) issues.push(`判据 ${c.criterionId} 不属于该任务`)
    for (const id of c.evidenceIds) {
      if (!allowedEvidence.has(id)) {
        issues.push(`证据 ${id} 不在本轮证据集合内（不允许编造/跨任务引用）`)
        continue
      }
      const obs = input.context.getObservation(id)
      if (!obs) {
        issues.push(`证据 ${id} 无法从证据库取回`)
        continue
      }
      if (obs.runId !== input.runId) issues.push(`证据 ${id} 属于 run ${obs.runId}，不是当前 run ${input.runId}`)
      if (obs.taskId !== undefined && obs.taskId !== input.task.id) {
        issues.push(`证据 ${id} 属于任务 ${obs.taskId}，不是当前任务 ${input.task.id}`)
      }
      if (obs.partitionVersion !== input.context.partition.partitionVersion) {
        issues.push(`证据 ${id} 的分区版本 ${obs.partitionVersion} 与当前 ${input.context.partition.partitionVersion} 不一致`)
      }
    }
  }
  const judged = new Set(verdict.criteria.map(c => c.criterionId))
  for (const c of input.task.criteria) {
    if (!judged.has(c.id)) issues.push(`判据 ${c.id} 没有被判定（不允许漏判）`)
  }

  if (issues.length > 0) {
    const merged: Verdict = {
      ...verdict,
      status: 'fail',
      repairSuggestions: [...verdict.repairSuggestions, ...issues],
    }
    logWarn(
      'judge.inconsistent',
      `[${input.task.regionId}/${input.task.id}] 判定不可信（证据/判据引用不自洽），按 fail 处理`,
      issues.map(i => `- ${i}`).join('\n'),
    )
    return { verdict: applyComputedToVerdict(merged, validation).verdict, credible: false, issues, validation }
  }

  const allPass = verdict.criteria.every(c => c.status === 'pass')
  if (verdict.status === 'pass' && !allPass) {
    const issues2 = ['verdict.status=pass 但存在非 pass 的判据，按 fail 处理']
    const merged: Verdict = { ...verdict, status: 'fail', repairSuggestions: [...verdict.repairSuggestions, ...issues2] }
    logWarn('judge.inconsistent', `[${input.task.regionId}/${input.task.id}] status=pass 但判据并非全 pass，降级为 fail`, issues2[0])
    return { verdict: applyComputedToVerdict(merged, validation).verdict, credible: false, issues: issues2, validation }
  }

  // W08.1：程序 metric/constraint 的 fail/uncertain 覆盖模型的 pass（§6.6）。
  const applied = applyComputedToVerdict(verdict, validation)
  logStage(
    'judge.outcome',
    `[${input.task.regionId}/${input.task.id}] 判定完成：模型给 ${verdict.status} → 应用程序事实后 ${applied.verdict.status}`,
    [
      `模型判据：${verdict.criteria.map(c => `${c.criterionId}:${c.status}`).join('，')}`,
      `最终判据：${applied.verdict.criteria.map(c => `${c.criterionId}:${c.status}`).join('，')}`,
      ...(applied.verdict.repairSuggestions.length > 0
        ? ['修正建议：', ...applied.verdict.repairSuggestions.map(s => `- ${s}`)]
        : []),
    ].join('\n'),
  )
  return { verdict: applied.verdict, credible: true, issues: [], validation }
}

/** 判定为 pass 且可信才允许该任务前进（否则进入修正轮或终局失败） */
export function taskPassed(output: JudgeOutput): boolean {
  return output.credible && output.verdict.status === 'pass'
}

export function repairSuggestionsOf(output: JudgeOutput): string[] {
  const list = output.verdict.repairSuggestions.length > 0 ? output.verdict.repairSuggestions : output.issues
  return list.slice(0, 5)
}

/** 供测试断言：把被判定的任务与判定对齐（避免误用旧 verdict） */
export function assertVerdictTask(verdict: Verdict, task: UnitTask): void {
  if (verdict.taskId !== task.id) {
    throw new CoAgentError('internal_error', `判定与任务不匹配：${verdict.taskId} vs ${task.id}`)
  }
}
