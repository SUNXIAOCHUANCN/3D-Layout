import { create } from 'zustand'
import { useSceneStore } from '../../core/store'
import type { AgentToolDef } from './tools'

export const DEFAULT_LIMITS = { requests: 100, minutes: 20, tools: 400 }
export type Limits = typeof DEFAULT_LIMITS
export type Checkpoint = {
  status: string; requests: number; tools: number; elapsedSeconds: number; reason: string
  objectCount: number; updatedAt: string
}
type Task = { goal: string; instructions: string[]; criteria: string[]; limits: Limits; checkpoint?: Checkpoint }
const tasks = new Map<string, Task>()
const empty: Task = { goal: '', instructions: [], criteria: [], limits: DEFAULT_LIMITS }

export const useTaskState = create<{ sceneId: string | null; task: Task }>(() => ({ sceneId: null, task: empty }))

export function selectTask(sceneId: string | null) {
  if (!sceneId) { useTaskState.setState({ sceneId, task: empty }); return }
  if (!tasks.has(sceneId)) {
    let task: Task = { ...empty }
    try {
      const saved = JSON.parse(localStorage.getItem('llm-agent-task:' + sceneId) ?? 'null')
      if (saved && typeof saved.goal === 'string' && Array.isArray(saved.instructions) &&
          saved.instructions.every((x: unknown) => typeof x === 'string') && Array.isArray(saved.criteria) &&
          saved.criteria.every((x: unknown) => typeof x === 'string')) {
        task = { ...saved, limits: validLimits(saved.limits) }
      }
    } catch { /* A task remains usable when browser storage is unavailable. */ }
    tasks.set(sceneId, task)
  }
  useTaskState.setState({ sceneId, task: tasks.get(sceneId)! })
}

function validLimits(value: Partial<Limits> | null = {}): Limits {
  value ??= {}
  const limit = (n: unknown, fallback: number, max: number) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max ? n : fallback
  return { requests: limit(value.requests, 100, 300), minutes: limit(value.minutes, 20, 120), tools: limit(value.tools, 400, 2000) }
}

function update(patch: Partial<Task>) {
  const { sceneId, task } = useTaskState.getState()
  if (!sceneId) throw new Error('未加载场景')
  const next = { ...task, ...patch }
  try { localStorage.setItem('llm-agent-task:' + sceneId, JSON.stringify(next)) } catch { /* Keep the live checkpoint. */ }
  tasks.set(sceneId, next)
  useTaskState.setState({ task: next })
}

export function beginTaskInput(sceneId: string | null, text: string) {
  selectTask(sceneId)
  const task = useTaskState.getState().task
  // Keep the first request verbatim. Later user instructions are separately retained.
  update(task.goal ? { instructions: [...task.instructions, text] } : { goal: text })
}

export function resetTask() {
  update({ ...empty, limits: useTaskState.getState().task.limits })
}
export function setLimits(limits: Limits) { update({ limits: validLimits(limits) }) }
export function checkpoint(value: Checkpoint) { update({ checkpoint: value }) }

export function taskContext() {
  return JSON.stringify(useTaskState.getState().task)
}

export const TASK_TOOLS: AgentToolDef[] = [
  {
    name: 'task.criteria', access: 'generate', summary: '设置总体验收条件',
    description: '设置场景总体可检查的验收条件。原始目标独立保留，此工具不能修改目标。应包含边界、密度、布局、贴地和视觉检查。',
    argsDoc: '{ criteria: string[] }',
    schema: { type: 'object', properties: { criteria: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 300 } } }, required: ['criteria'], additionalProperties: false },
    exec(args) {
      selectTask(useSceneStore.getState().sceneId)
      const values = args.criteria
      if (!Array.isArray(values) || !values.length || values.length > 12 ||
          values.some(x => typeof x !== 'string' || !x.trim() || x.length > 300)) throw new Error('验收条件需为 1–12 条，每条最多 300 字')
      update({ criteria: values })
      return { criteria: values }
    },
  },
]

export class RunGuard {
  requests = 0
  tools = 0
  failures = 0
  readRounds = 0
  private repeats = new Map<string, number>()
  private repairs = new Map<string, number>()
  readonly started = Date.now()

  constructor(readonly limits: Limits) {}
  reason(includeRequests = true) {
    if (includeRequests && this.requests >= this.limits.requests) return '达到 API 请求预算'
    if (this.tools >= this.limits.tools) return '达到工具调用预算'
    if (Date.now() - this.started >= this.limits.minutes * 60_000) return '达到运行时间预算'
    if (this.failures >= 8) return '连续 8 次调用失败或未产生效果'
    if (this.readRounds >= 12) return '连续 12 轮未推进场景或计划'
    return ''
  }
  request() {
    const reason = this.reason()
    if (reason) throw new Error(reason)
    this.requests++
  }
  beforeTool(name: string, args: Record<string, unknown>, write: boolean): string {
    this.tools++
    const signature = name + JSON.stringify(args)
    const repeat = (this.repeats.get(signature) ?? 0) + 1
    this.repeats.set(signature, repeat)
    // Read cache is invalidated only by a committed edit, below.
    if (repeat > 3 && name !== 'plan.get') return '同一调用已重复三次，请复用结果、改变方法、更新计划或报告未解决问题'
    const ids = typeof args.assetId === 'string' ? [args.assetId] :
      name === 'asset.batch' && args.operation === 'transform' && Array.isArray(args.items)
        ? args.items.map(item => item?.assetId).filter((id): id is string => typeof id === 'string') : []
    if (write) {
      const keys = [...new Set(ids)].map(id => name + ':' + id)
      if (keys.some(key => (this.repairs.get(key) ?? 0) >= 6)) return '该对象同类修复已达六次，请停止局部重试并更新计划或报告受阻'
      keys.forEach(key => this.repairs.set(key, (this.repairs.get(key) ?? 0) + 1))
    }
    return ''
  }
  result(ok: boolean, effective: boolean) {
    this.failures = ok && effective ? 0 : this.failures + 1
  }
  committed() { this.repeats.clear() }
  round(progress: boolean) { this.readRounds = progress ? 0 : this.readRounds + 1 }
  warning() {
    return this.readRounds >= 6 ? '连续多轮仅观察或查询。请更新验收结论，明确下一步，或报告未完成并结束。' : ''
  }
}

