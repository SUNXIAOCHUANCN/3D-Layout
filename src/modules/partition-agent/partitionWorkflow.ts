import presetJson from './python/preset.json?raw'
import { llmChat, type LlmChatOptions, type LlmChatResult } from './llmClient'
import { getActiveSettings, isLlmConfigured } from './llmSettings'
import { convertBoundaries, type BoundaryMap } from './geometry'
import type { Partition, PartitionConfig, PartitionRound } from './types'
import { DrawingValidationError } from './processingErrors'

export interface Preset { id: string; name: string; source_revision: number; canvas: Pick<PartitionConfig, 'prompt_text' | 'max_rounds' | 'max_duration_seconds'> & Partial<PartitionConfig> }
export const PARTITION_PRESET = JSON.parse(presetJson) as Preset
export const DEFAULT_PARTITION_CONFIG: PartitionConfig = { max_points: 5000, max_operations: 200, canvas_width: 1000, ...PARTITION_PRESET.canvas }
type Process = <T>(request: Record<string, unknown>, signal: AbortSignal) => Promise<T>
export const processImage: Process = async <T>(request: Record<string, unknown>, signal: AbortSignal): Promise<T> => {
  const res = await fetch('/api/partition-agent/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal })
  const result = await res.json() as T & { error?: string }
  if (!res.ok) {
    const error = result.error ?? `本地分区处理失败：HTTP ${res.status}`
    throw res.status === 422 ? new DrawingValidationError(error) : new Error(error)
  }
  return result
}
export function partitionConfig(config?: Partial<PartitionConfig>): PartitionConfig {
  const value = { ...DEFAULT_PARTITION_CONFIG, ...config }
  const integer = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max
  if (typeof value.prompt_text !== 'string' || !value.prompt_text.trim() || value.prompt_text.length > 30000 ||
      !integer(value.max_rounds, 1, 50) || !integer(value.max_duration_seconds, 5, 7200) || !integer(value.max_points, 10, 30000) ||
      !integer(value.max_operations, 1, 2000) || !integer(value.canvas_width, 200, 4000)) throw new Error('分区提示词或运行限制无效')
  return value
}
export interface WorkflowDependencies {
  process: Process
  chat: (options: LlmChatOptions) => Promise<LlmChatResult>
}
export async function runPartitionWorkflow(
  image: string, bounds: [number, number, number, number], signal: AbortSignal,
  progress: (text: string, preview?: string) => void,
  options?: Partial<PartitionConfig>,
  dependencies: WorkflowDependencies = { process: processImage, chat: llmChat },
): Promise<Partition> {
  if (!isLlmConfigured()) throw new Error('请先在模型设置中配置支持看图的模型')
  const config = partitionConfig(options), settings = getActiveSettings()
  if (!settings.sendImages) throw new Error('LLM 分区需要看图，请在模型设置中开启截图回传并使用视觉模型')
  const runId = crypto.randomUUID(), history: PartitionRound[] = []
  progress('正在适配鸟瞰图')
  const initial = await dependencies.process<{ image: string; drawing: BoundaryMap; fitNote: string }>({ action: 'initialize', image, config }, signal)
  const original = initial.image
  let drawing = initial.drawing, preview: string | undefined, feedback = '', stopReason: 'model_finished' | 'max_rounds' | 'time_limit' = 'max_rounds'
  const started = Date.now()
  for (let round = 1; round <= config.max_rounds; round++) {
    signal.throwIfAborted()
    const remaining = config.max_duration_seconds * 1000 - (Date.now() - started)
    if (remaining <= 0) { stopReason = 'time_limit'; break }
    progress(`分区第 ${round}/${config.max_rounds} 轮：模型正在看图`, preview)
    const request = await dependencies.process<{ prompt: string; review: string }>({ action: 'prepare', image: original, drawing, preview, round, history, feedback, config }, signal)
    const budget = config.max_duration_seconds * 1000 - (Date.now() - started)
    if (budget <= 0) { stopReason = 'time_limit'; break }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(budget)))])
    // Use the original Canvas prompt as the user request, including its exact drawing protocol.
    // Network failures and unknown remote outcomes are not retried as drawing mistakes.
    const reply = await dependencies.chat({ settings, signal: requestSignal, sessionId: runId, system: '', turns: [{ role: 'user', text: request.prompt, images: [{ dataUrl: request.review }] }], tools: [], onEvent: () => {} })
    requestSignal.throwIfAborted()
    let command: Record<string, unknown>
    try {
      if (reply.toolCalls.length) throw new Error('请使用提示词中的声明式 JSON 绘图协议')
      if (reply.text.length > Math.min(12_000_000, config.max_points * 600 + 50000)) throw new Error('模型输出超过绘图大小限制')
      const raw = reply.text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\s*```$/, '')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('回复必须是 JSON 对象')
      command = parsed as Record<string, unknown>
      if (command.action === 'finish') {
        if (!preview) throw new Error('尚未绘图；需要先绘制，再查看渲染图后结束')
        history.push({ round, status: 'reviewed', note: String(command.note ?? '').slice(0, 2000) }); stopReason = 'model_finished'; break
      }
      if (command.action !== 'draw') throw new Error('action 必须为 draw 或 finish')
    } catch (error) {
      feedback = String(error).slice(0, 1800); history.push({ round, status: 'rejected', note: feedback }); continue
    }
    try {
      const result = await dependencies.process<{ drawing: BoundaryMap; preview: string }>({ action: 'apply', image: original, drawing, command, config }, signal)
      drawing = result.drawing; preview = result.preview
      feedback = '绘制成功，返回图右侧为实际渲染结果。请检查后修改或finish。'
      history.push({ round, status: 'drawn', note: String(command.note ?? '').slice(0, 2000) })
      progress(`分区第 ${round}/${config.max_rounds} 轮：已绘制，等待模型检查`, preview)
    } catch (error) {
      signal.throwIfAborted()
      if (!(error instanceof DrawingValidationError)) throw error
      feedback = String(error).slice(0, 1800); history.push({ round, status: 'rejected', note: feedback })
      progress(`分区第 ${round}/${config.max_rounds} 轮：绘图未通过，返回反馈修订`, preview)
    }
  }
  signal.throwIfAborted()
  if (!preview) throw new Error('达到限制但尚未得到有效分区；请查看提示词或调整运行限制')
  const rawDrawing = drawing, rawPreview = preview
  progress('正在执行边界平滑与分区渲染', preview)
  const refined = await dependencies.process<{ drawing: BoundaryMap; preview: string; report: Record<string, unknown> }>({ action: 'refine', image: original, drawing }, signal)
  signal.throwIfAborted()
  const regions = convertBoundaries(refined.drawing, bounds)
  progress(stopReason === 'model_finished' ? '分区完成：模型已查看并确认' : '分区已生成：达到运行限制，模型尚未确认完成', refined.preview)
  return { regions, owners: {}, workflowId: PARTITION_PRESET.id, workflowRevision: 1, runId, createdAt: new Date().toISOString(), preview: refined.preview,
    rawPreview, boundaryMap: refined.drawing, rawBoundaryMap: rawDrawing, refinementReport: refined.report, stopReason, drawingHistory: history, config }
}
