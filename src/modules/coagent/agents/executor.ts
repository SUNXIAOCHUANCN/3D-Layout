/**
 * executor（W05）——单项任务的执行循环。
 *
 * 只做三件事：拼任务上下文、跑 modelLoop、把工具结果摘要出来给判定层。
 * 写入规则不在提示词里，而在 registry（角色/作用域/基线）与 writeFacade（指纹/幂等/事务）。
 */

import type { CoAgentConfig, ModelPort, Observation, UnitTask, WorkflowContext, ModelCatalogEntry } from '../contracts'
import { runToolLoop, type ToolLoopResult } from './modelLoop'
import { executorTaskText, SYSTEM_EXECUTOR } from './prompts'
import type { ToolRegistry } from '../tools/registry'
import type { ObservationId } from '../contracts'
import { logStage } from '../runtime/runLog'
export interface ExecutorInput {
  task: UnitTask
  context: WorkflowContext
  registry: ToolRegistry
  model: ModelPort
  signal: AbortSignal
  config: CoAgentConfig
  /** 运行标识：捕获证据时要带（否则 observation 的 runId 会是空串） */
  runId: string
  regionObjectIds: string[]
  readonlyObjectIds: string[]
  /** 本任务的 task_before 证据（让模型能直接用 basisObservationId 写入） */
  baselineObservationId?: string
  baselineFingerprints?: Record<string, string>
  /**
   * 可新增的模型库候选（add 任务用）。
   * 真机实测（2026-10-22）：不给的话，执行器只能靠 library.search 反复猜关键词，
   * 把 6 轮预算耗在检索上 → budget_exceeded。
   */
  catalog?: ModelCatalogEntry[]
  /** 上一轮判定的修正建议（修正轮才传） */
  feedback?: string[]
}

export interface ExecutorOutput extends ToolLoopResult {
  /** 本区执行过程中产生的证据 id（camera.capture 的返回值） */
  evidenceIds: ObservationId[]
}

export async function runExecutor(input: ExecutorInput): Promise<ExecutorOutput> {
  const evidenceIds: ObservationId[] = []
  const maxRounds = Math.max(2, Math.min(6, input.config.toolBudgetPerTask))
  let toolImages = 0

  logStage(
    'executor.start',
    `[${input.task.regionId}/${input.task.id}] 执行器开始（最多 ${maxRounds} 轮）`,
    [
      `目标：${input.task.objective}`,
      `目标对象：${input.task.targetObjectIds.join(', ') || '（无：add 任务）'}`,
      `允许操作：${input.task.allowedOperations.join('/') || '（空）'}`,
      `判据：${input.task.criteria.map(c => `${c.id}:${c.kind}`).join('，')}`,
      `约束：${input.task.constraints.map(c => c.kind).join('，') || '（无）'}`,
      `本区可写对象：${input.regionObjectIds.length} 个；只读对象：${input.readonlyObjectIds.length} 个`,
      `本任务基线证据：${input.baselineObservationId ?? '（无）'}`,
      `可选新增资产：${input.catalog?.length ?? 0} 个`,
      ...(input.feedback && input.feedback.length > 0 ? ['', '上一轮修正建议：', ...input.feedback.map(f => `- ${f}`)] : []),
    ].join('\n'),
  )

  const result = await runToolLoop({
    role: 'executor',
    purpose: 'executor',
    system: SYSTEM_EXECUTOR,
    messages: [
      {
        role: 'user',
        text: executorTaskText({
          task: input.task,
          regionObjectIds: input.regionObjectIds,
          readonlyObjectIds: input.readonlyObjectIds,
          ...(input.baselineObservationId !== undefined ? { baselineObservationId: input.baselineObservationId } : {}),
          ...(input.baselineFingerprints !== undefined ? { fingerprints: input.baselineFingerprints } : {}),
          ...(input.catalog !== undefined ? { catalog: input.catalog } : {}),
          ...(input.feedback ? { feedback: input.feedback } : {}),
        }),
      },
    ],
    model: input.model,
    registry: input.registry,
    site: { runId: input.runId, taskId: input.task.id, regionId: input.task.regionId },
    signal: input.signal,
    config: input.config,
    maxRounds,
    onToolResult: (call, toolResult) => {
      if (call.name === 'camera.capture' && toolResult.ok) {
        const data = toolResult.data as { id?: string }
        if (typeof data?.id === 'string') evidenceIds.push(data.id)
      }
    },
    imagesForToolResult: async (call, toolResult) => {
      // W08.2：camera.capture 的真实结果附图给模型看；每任务最多 2 张，防止请求膨胀。
      if (call.name !== 'camera.capture' || !toolResult.ok || toolImages >= 2) return []
      const data = toolResult.data as Observation | undefined
      if (!data?.rgbImageId) return []
      const dataUrl = await input.context.getImageDataUrl(data.rgbImageId)
      if (!dataUrl) return []
      toolImages++
      return [{ mediaType: 'image/png', dataUrl }]
    },
  })

  logStage(
    'executor.end',
    `[${input.task.regionId}/${input.task.id}] 执行器结束：${result.toolCalls} 次工具调用，证据 ${evidenceIds.length} 条`,
    result.text,
  )
  return { ...result, evidenceIds }
}