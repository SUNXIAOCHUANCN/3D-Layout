/**
 * uiStore（W03，SPEC §3.1）——纯投影层。
 *
 * 消费 runtime 相位通知后更新进度展示；不驱动业务跳转（唯一业务入口是
 * runtime.start/cancel）。busy 由相位派生，不在 UI 侧自造状态。
 */

import { create } from 'zustand'
import type { ClarifyState } from './clarify'
import type { CoAgentEventEnvelope, CoAgentPhase } from './contracts'

export interface CoAgentUiState {
  phase: CoAgentPhase
  /** 最近一轮结果（completed/rolled_back/... 的展示摘要；code/stage 用于区分回滚原因与失败节点） */
  lastResult: {
    kind: string
    summary?: string
    reason?: string
    code?: string
    stage?: string
    /** P3：retained_with_issues 的未通过项数量 */
    issueCount?: number
    /** P3：未通过项的一句话说明（面板直接展示） */
    issues?: string[]
  } | null
  lastError: string | null
  /** recorder 事件数（面板轻量展示；导出属 W09） */
  eventCount: number
  /** 事件流投影（W06.5：进度/执行明细用；只保存最近若干条） */
  events: CoAgentEventEnvelope[]
  /** W07：等待用户回答的澄清问题（回答后拼回原请求再规划） */
  pendingClarify: ClarifyState | null
  runtimeLocked: boolean

  setPhase: (phase: CoAgentPhase) => void
  setResult: (result: CoAgentUiState['lastResult']) => void
  setError: (message: string | null) => void
  setEventCount: (n: number) => void
  setEvents: (events: CoAgentEventEnvelope[]) => void
  setPendingClarify: (state: ClarifyState | null) => void
  setLocked: (locked: boolean) => void
  /** 新 run 开始时清上一轮展示 */
  beginRun: () => void
}

const BUSY_PHASES: ReadonlySet<CoAgentPhase> = new Set<CoAgentPhase>([
  'preprocessing',
  'planning',
  'baselining',
  'executing',
  'validating',
  'committing',
  'cancelling',
])

export const useCoAgentStore = create<CoAgentUiState>(set => ({
  phase: 'disabled',
  lastResult: null,
  lastError: null,
  eventCount: 0,
  events: [],
  pendingClarify: null,
  runtimeLocked: false,

  setPhase: phase => set({ phase }),
  setResult: result => set({ lastResult: result }),
  setError: message => set({ lastError: message }),
  setEventCount: n => set({ eventCount: n }),
  setEvents: events => set({ events }),
  setPendingClarify: state => set({ pendingClarify: state }),
  setLocked: locked => set({ runtimeLocked: locked }),
  beginRun: () => set({ lastResult: null, lastError: null, events: [], pendingClarify: null }),
}))

export const isBusyPhase = (phase: CoAgentPhase): boolean => BUSY_PHASES.has(phase)
