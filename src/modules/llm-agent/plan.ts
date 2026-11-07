import { useSyncExternalStore } from 'react'
import type { AgentToolDef } from './tools'
import { useSceneStore } from '../../core/store'

const states = ['pending', 'active', 'done', 'blocked'] as const
type Step = { id: string; title: string; status: typeof states[number]; evidence?: string; acceptance?: string }
const empty: Step[] = []
const plans = new Map<string, Step[]>()
const listeners = new Set<() => void>()
const key = (id: string) => 'llm-agent-plan:' + id

export function readPlan(id: string | null): Step[] {
  if (!id) return empty
  const cached = plans.get(id)
  if (cached) return cached
  let steps = empty
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key(id)) ?? 'null')
    if (Array.isArray(saved)) steps = saved.filter(s => s && typeof s.id === 'string' && typeof s.title === 'string' && states.includes(s.status))
  } catch { /* Storage may be unavailable. */ }
  plans.set(id, steps)
  return steps
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePlan() {
  const sceneId = useSceneStore(s => s.sceneId)
  return useSyncExternalStore(subscribe, () => readPlan(sceneId))
}

export const PLAN_TOOLS: AgentToolDef[] = [
  {
    name: 'plan.get', access: 'read', summary: '读取场景计划',
    description: '读取当前场景独立保存的工作计划。', argsDoc: '{}',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    exec: () => readPlan(useSceneStore.getState().sceneId),
  },
  {
    name: 'plan.set', access: 'generate', summary: '建立或更新工作计划',
    description: '保存完整计划。更新时保留原步骤 ID。每步先设置 acceptance 验收条件，完成或受阻时须附依据。更新须保留原步骤 ID，待确认的场景修改不算完成。',
    argsDoc: '{ steps: [{ id, title, status, evidence? }] }',
    schema: { type: 'object', required: ['steps'], properties: { steps: {
      type: 'array', maxItems: 30, items: { type: 'object', required: ['id', 'title', 'status'], properties: {
        id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: [...states] }, evidence: { type: 'string' }, acceptance: { type: 'string', maxLength: 300 },
      }, additionalProperties: false },
    } }, additionalProperties: false },
    exec(args) {
      const id = useSceneStore.getState().sceneId
      if (!id) throw new Error('未加载场景')
      if (!Array.isArray(args.steps) || args.steps.length > 30) throw new Error('计划最多 30 步')
      const ids = new Set<string>()
      const previous = readPlan(id)
      if (previous.some(step => !(args.steps as { id?: string }[]).some((item: { id?: string }) => item.id === step.id))) throw new Error('更新计划须保留已有步骤 ID，避免丢失整体范围。新任务请在面板新建目标。')
      const steps: Step[] = args.steps.map(s => {
        if (!s || typeof s.id !== 'string' || !s.id.trim() || s.id.length > 64 || ids.has(s.id) ||
            typeof s.title !== 'string' || !s.title.trim() || s.title.length > 200 || !states.includes(s.status) ||
            (s.acceptance !== undefined && (typeof s.acceptance !== 'string' || !s.acceptance.trim() || s.acceptance.length > 300)) ||
            (s.evidence !== undefined && (typeof s.evidence !== 'string' || s.evidence.length > 500)) ||
            (['done', 'blocked'].includes(s.status) && !s.evidence?.trim())) throw new Error('步骤无效、ID 重复或缺少依据')
        const prior = previous.find(step => step.id === s.id)
        if (s.status === 'done' && !s.acceptance && !prior?.acceptance) throw new Error('完成步骤必须有 acceptance 验收条件和 evidence 依据')
        ids.add(s.id)
        return { id: s.id, title: s.title, status: s.status, evidence: s.evidence, acceptance: s.acceptance ?? prior?.acceptance }
      })
      localStorage.setItem(key(id), JSON.stringify(steps))
      plans.set(id, steps)
      listeners.forEach(listener => listener())
      return steps
    },
  },
]

export function clearPlan(id: string) {
  localStorage.removeItem(key(id))
  plans.set(id, [])
  listeners.forEach(listener => listener())
}
