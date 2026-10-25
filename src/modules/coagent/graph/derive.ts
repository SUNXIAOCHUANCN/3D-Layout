/**
 * 图页的纯投影函数（W10）：事件流 → 节点状态 / 阶段 / 时间。
 *
 * 与宿主 uiProjection 同款原则：**不新造状态**，全部从 recorder 事件推导。
 * 这里只关心 node.started / node.finished 与 run.*，业务事件（task/tool/verdict）
 * 只用于详情抽屉，不参与节点状态判定。
 */

import type { CoAgentEventEnvelope } from '../contracts'

export type VisualState = 'idle' | 'running' | 'ok' | 'error'

export interface NodeVisual {
  state: VisualState
  /** node.finished 的耗时 */
  ms?: number
  /** node.finished(status=error) 的错误消息 */
  message?: string
  /** 区域子图节点的子步骤（`A/execute` → `execute`） */
  substep?: string
}

export interface DerivedView {
  /** node id → 视觉状态（主图节点 id：'planner' / 'region-A' / '__start__' …） */
  visuals: Map<string, NodeVisual>
  /** 正在跑的节点（并行时可能多个） */
  active: string[]
  /** 阶段徽标 */
  phase: { label: string; tone: 'idle' | 'running' | 'ok' | 'error' }
  /** 本轮开始时间 / 最近一条事件时间（ms 时间戳） */
  startedAt: number | null
  lastAt: number | null
  /** 失败节点（run.rolled_back 的 payload.stage） */
  failedNode: string | null
}

const PHASES: Record<string, { label: string; tone: DerivedView['phase']['tone'] }> = {
  'run.started': { label: '运行中', tone: 'running' },
  'run.cancelling': { label: '取消中', tone: 'running' },
  'run.committed': { label: '已完成', tone: 'ok' },
  'run.rolled_back': { label: '已回滚', tone: 'error' },
  'run.failed': { label: '失败', tone: 'error' },
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function timeOf(e: CoAgentEventEnvelope): number | null {
  const t = Date.parse(e.time)
  return Number.isFinite(t) ? t : null
}

export function deriveView(
  events: readonly CoAgentEventEnvelope[],
  outcome: string | null = null,
): DerivedView {
  const visuals = new Map<string, NodeVisual>()
  let startedAt: number | null = null
  let lastAt: number | null = null
  let failedNode: string | null = null
  let phaseKey: string | null = null

  for (const e of events) {
    const t = timeOf(e)
    if (t !== null) lastAt = t

    if (e.type === 'run.started') {
      startedAt = t ?? Date.now()
      phaseKey = e.type
    } else if (e.type === 'run.cancelling' || e.type === 'run.committed' || e.type === 'run.failed') {
      phaseKey = e.type
    } else if (e.type === 'run.rolled_back') {
      phaseKey = e.type
      const stage = str(e.payload.stage)
      if (stage) failedNode = stage
    } else if (e.type === 'node.started') {
      const node = str(e.payload.node)
      if (node) visuals.set(node, { state: 'running', ...(node.includes('/') ? { substep: node.split('/')[1] } : {}) })
    } else if (e.type === 'node.finished') {
      const node = str(e.payload.node)
      if (!node) continue
      const status = str(e.payload.status)
      const ms = typeof e.payload.ms === 'number' ? e.payload.ms : undefined
      const message = str(e.payload.message)
      visuals.set(node, {
        state: status === 'error' ? 'error' : 'ok',
        ...(ms !== undefined ? { ms } : {}),
        ...(message ? { message } : {}),
        ...(node.includes('/') ? { substep: node.split('/')[1] } : {}),
      })
    }
  }

  // 区域子图节点（`A/execute`）折叠成主图节点上的子步骤标签
  for (const [node, visual] of visuals) {
    if (!node.includes('/') || !visual.substep) continue
    const regionNode = `region-${node.split('/')[0]}`
    const existing = visuals.get(regionNode)
    if (existing && existing.state === 'running') {
      visuals.set(regionNode, { ...existing, substep: visual.substep })
    }
  }

  const active = [...visuals.entries()].filter(([, v]) => v.state === 'running').map(([node]) => node)
  const phase = (outcome && PHASES[outcome]) || (phaseKey && PHASES[phaseKey]) || { label: '空闲', tone: 'idle' as const }

  return { visuals, active, phase, startedAt, lastAt, failedNode }
}

/** 面板时间轴与详情抽屉共用的单行文案 */
export function formatEventLine(e: CoAgentEventEnvelope): string {
  const where = [str(e.regionId), str(e.taskId)].filter(Boolean).join('/')
  const node = str(e.payload.node)
  const detail = node
    ? e.type === 'node.finished'
      ? `${node} · ${str(e.payload.status) || '?'}${typeof e.payload.ms === 'number' ? ` ${e.payload.ms}ms` : ''}`
      : node
    : JSON.stringify(e.payload).slice(0, 80)
  return `#${e.eventSeq} ${e.type}${where ? `（${where}）` : ''} — ${detail}`
}

/** 某节点相关的最近事件（详情抽屉用）：同名节点事件 + 同区域业务事件 */
export function relatedEvents(
  events: readonly CoAgentEventEnvelope[],
  node: string,
  limit = 12,
): CoAgentEventEnvelope[] {
  const regionFromNode = node.startsWith('region-') ? node.slice('region-'.length) : node.includes('/') ? node.split('/')[0] : ''
  const out: CoAgentEventEnvelope[] = []
  for (const e of events) {
    const sameNode = str(e.payload.node) === node || str(e.payload.node).startsWith(`${regionFromNode}/`)
    const sameRegion = !!regionFromNode && str(e.regionId) === regionFromNode && e.type !== 'node.started' && e.type !== 'node.finished'
    if (sameNode || sameRegion) out.push(e)
  }
  return out.slice(-limit)
}
