/**
 * uiProjection（W06.5）——把 recorder 的事件流投影成"人能看懂的进度"。
 *
 * 原则：**不新造状态**。进度、当前动作、完成数全部从真实事件推导（§3.1 UI 是投影），
 * 这样 W07/W08 新增事件类型时，面板不需要改结构，只需要在文案表里补一行。
 */

import type { CoAgentEventEnvelope, CoAgentPhase } from './contracts'

export interface RunProgressView {
  /** 计划里的任务总数（来自 plan.ready；没有计划时为 0） */
  total: number
  passed: number
  failed: number
  /** 0~100；无任务数时按相位给一个粗略值 */
  percent: number
  /** 相位的人话（"执行中"…） */
  step: string
  /** 最近一条具体动作（"执行 task-n1（第 1 次）"） */
  current: string
  /** 已出现的区域 id（按出现顺序） */
  regions: string[]
  /** 是否还在跑 */
  active: boolean
}

const PHASE_STEP: Record<CoAgentPhase, string> = {
  disabled: '已停用',
  initializing: '初始化',
  idle: '空闲',
  preprocessing: '分区预处理',
  planning: '规划',
  awaiting_clarification: '等待澄清',
  baselining: '取证基线',
  executing: '执行中',
  validating: '判定中',
  committing: '提交中',
  completed: '已完成',
  retained: '已保留（有未通过项）',
  cancelling: '取消中',
  rolled_back: '已回滚',
  failed: '失败',
  error_locked: '错误锁定',
}

const BUSY: ReadonlySet<CoAgentPhase> = new Set<CoAgentPhase>([
  'preprocessing',
  'planning',
  'awaiting_clarification',
  'baselining',
  'executing',
  'validating',
  'committing',
  'cancelling',
])

const MAX_EVENTS = 300

export function keepRecent(events: CoAgentEventEnvelope[], max = MAX_EVENTS): CoAgentEventEnvelope[] {
  return events.length > max ? events.slice(events.length - max) : events
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 从事件推导进度视图（纯函数，可单测） */
export function deriveRunProgress(events: CoAgentEventEnvelope[], phase: CoAgentPhase): RunProgressView {
  let total = 0
  let passed = 0
  let failed = 0
  let current = ''
  const regions: string[] = []
  const rememberRegion = (id: string): void => {
    if (id && !regions.includes(id)) regions.push(id)
  }

  for (const e of events) {
    rememberRegion(str(e.regionId))
    if (e.type === 'plan.ready') total = Math.max(total, num(e.payload.tasks))
    if (e.type === 'baseline.ready') current = `基线证据：${str(e.regionId) || '场景'}（${str(e.payload.phase) || 'baseline'}）`
    if (e.type === 'task.started') {
      const repair = num(e.payload.repair)
      current = `执行 ${str(e.taskId)}${repair > 0 ? `（修正第 ${repair} 次）` : '（第 1 次）'}`
    }
    if (e.type === 'tool.finished') {
      const step = num(e.payload.step)
      current = step > 0 ? `工具第 ${step + 1} 步完成（${str(e.taskId)}）` : `工具完成（${str(e.taskId)}）`
    }
    if (e.type === 'verdict.ready') current = `判定 ${str(e.taskId)}：${str(e.payload.status) || '?'}`
    if (e.type === 'task.finished') {
      if (str(e.payload.status) === 'fail') failed++
      else passed++
    }
    if (e.type === 'run.committed') current = str(e.payload.validationStatus) === 'issues' ? '已保留（有未通过项）' : '已提交'
    if (e.type === 'run.rolled_back') current = '已回滚'
    if (e.type === 'run.failed') current = `失败：${str(e.payload.reason)}`
    if (e.type === 'partition.ready') current = `分区 v${num(e.payload.partitionVersion)} 已生成`
  }

  const active = BUSY.has(phase)
  let percent: number
  if (total > 0) {
    percent = Math.min(100, Math.round(((passed + failed) / total) * 100))
    if (phase === 'committing' || phase === 'completed' || phase === 'retained') percent = 100
  } else {
    const fallback: Partial<Record<CoAgentPhase, number>> = {
      planning: 10,
      baselining: 25,
      executing: 50,
      validating: 80,
      committing: 95,
      completed: 100,
      retained: 100,
    }
    percent = fallback[phase] ?? 0
  }

  return {
    total,
    passed,
    failed,
    percent,
    step: PHASE_STEP[phase] ?? phase,
    current: current || (active ? '准备中…' : '—'),
    regions,
    active,
  }
}

/** 事件列表的一行文案（面板与导出共用口径） */
export function formatEvent(e: CoAgentEventEnvelope): string {
  const where = [str(e.regionId), str(e.taskId)].filter(Boolean).join(' / ')
  const payload = e.payload ?? {}
  let detail = ''
  switch (e.type) {
    case 'plan.ready':
      detail = `${str(payload.kind)}，${num(payload.tasks)} 个任务`
      break
    case 'baseline.ready':
      detail = `${str(payload.phase)} ${str(payload.observationId)}`
      break
    case 'task.started':
      detail = num(payload.repair) > 0 ? `修正第 ${num(payload.repair)} 次` : '首次执行'
      break
    case 'tool.finished':
      detail = num(payload.step) >= 0 ? `第 ${num(payload.step) + 1} 步` : JSON.stringify(payload).slice(0, 60)
      break
    case 'verdict.ready':
      detail = `${str(payload.status)}${payload.credible === false ? '（不可信）' : ''}`
      break
    case 'task.finished':
      detail = str(payload.status)
      break
    case 'run.committed':
      detail = '事务已提交'
      break
    case 'run.rolled_back':
      detail = [
        str(payload.reason),
        str(payload.stage) ? `@${str(payload.stage)}` : '',
        str(payload.message) ? `：${str(payload.message)}` : '',
      ].join('')
      break
    case 'run.failed':
      detail = str(payload.reason)
      break
    case 'save.failed':
      detail = str(payload.message)
      break
    case 'partition.ready':
      detail = `v${num(payload.partitionVersion)} / ${num(payload.issues)} 个问题`
      break
    default:
      detail = JSON.stringify(payload).slice(0, 80)
  }
  return `#${e.eventSeq} ${e.type}${where ? `（${where}）` : ''}${detail ? ` — ${detail}` : ''}`
}
