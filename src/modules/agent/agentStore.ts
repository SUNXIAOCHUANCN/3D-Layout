import { create } from 'zustand'

/**
 * Agent 模块的 UI 状态（不含业务逻辑：任务编排在 session.ts）。
 * phase !== 'idle' 即「预览期」——App 据此暂停人工编辑模块。
 * permissionMode：confirm=变更前确认（提案式人工裁决）/ auto=自动编辑（直接入账并保存）。
 */

export type AgentPhase = 'idle' | 'task' | 'awaiting_user'

export type PermissionMode = 'confirm' | 'auto'

const PREFS_KEY = 'agent-prefs-v1'

function loadPermissionMode(): PermissionMode {
  try {
    const v = localStorage.getItem(PREFS_KEY)
    return v === 'auto' ? 'auto' : 'confirm'
  } catch {
    return 'confirm'
  }
}

export interface AgentLogLine {
  id: number
  time: number
  kind: 'info' | 'call' | 'ok' | 'error' | 'verdict'
  text: string
}

export interface AgentTaskView {
  taskId: string
  label: string
  /** 任务内已执行的读 / 写调用数 */
  reads: number
  writes: number
}

/** 聊天消息：user/assistant 为气泡，note 为居中的灰色过程行（工具调用/裁决/错误） */
export interface ChatMsg {
  id: number
  role: 'user' | 'assistant' | 'note'
  text: string
  /** 流式输出中的 assistant 气泡 */
  streaming?: boolean
}

interface AgentState {
  transportName: string
  connected: boolean
  /** 当前传输是否支持聊天输入（浏览器直连 LLM 模式） */
  chatEnabled: boolean
  /** 对话循环进行中（含等待人工裁决），此时输入框禁用 */
  llmBusy: boolean
  /** 权限模式：confirm=变更前确认 / auto=自动编辑 */
  permissionMode: PermissionMode
  phase: AgentPhase
  task: AgentTaskView | null
  /** 最近一次 viewport.screenshot 的缩略图（面板预览） */
  lastScreenshot: string | null
  log: AgentLogLine[]
  chat: ChatMsg[]

  pushLog: (kind: AgentLogLine['kind'], text: string) => void
  setTransport: (name: string, connected: boolean) => void
  setConnected: (connected: boolean) => void
  setChatEnabled: (enabled: boolean) => void
  setLlmBusy: (busy: boolean) => void
  setPermissionMode: (mode: PermissionMode) => void
  beginTask: (task: AgentTaskView) => void
  /** 任务内调用计数（读+导出计入 reads，写计入 writes） */
  countCall: (access: 'read' | 'write' | 'export') => void
  awaitVerdict: () => void
  endTask: () => void
  setScreenshot: (dataUrl: string) => void
  pushChat: (role: ChatMsg['role'], text: string, streaming?: boolean) => number
  appendChat: (id: number, delta: string) => void
  /** 流结束；最终文本为空（模型只发工具调用）则移除气泡 */
  finishChat: (id: number) => void
  clearChat: () => void
}

const LOG_CAP = 80
const CHAT_CAP = 200
let logId = 0
let chatId = 0

export const useAgentStore = create<AgentState>((set, get) => ({
  transportName: '（未启动）',
  connected: false,
  chatEnabled: false,
  llmBusy: false,
  permissionMode: loadPermissionMode(),
  phase: 'idle',
  task: null,
  lastScreenshot: null,
  log: [],
  chat: [],

  pushLog: (kind, text) =>
    set(s => ({
      log: [...s.log, { id: ++logId, time: Date.now(), kind, text }].slice(-LOG_CAP),
    })),

  setTransport: (name, connected) => set({ transportName: name, connected }),

  setConnected: connected => {
    if (get().connected !== connected) set({ connected })
  },

  setChatEnabled: enabled => set({ chatEnabled: enabled }),

  setLlmBusy: busy => set({ llmBusy: busy }),

  setPermissionMode: mode => {
    if (get().permissionMode === mode) return
    set({ permissionMode: mode })
    try {
      localStorage.setItem(PREFS_KEY, mode)
    } catch {
      /* 写不进就算了 */
    }
  },

  beginTask: task => set({ phase: 'task', task }),

  countCall: access => {
    const t = get().task
    if (!t) return
    set({
      task: {
        ...t,
        reads: t.reads + (access === 'write' ? 0 : 1),
        writes: t.writes + (access === 'write' ? 1 : 0),
      },
    })
  },

  awaitVerdict: () => set({ phase: 'awaiting_user' }),

  endTask: () => set({ phase: 'idle', task: null }),

  setScreenshot: dataUrl => set({ lastScreenshot: dataUrl }),

  pushChat: (role, text, streaming) => {
    const id = ++chatId
    set(s => ({ chat: [...s.chat, { id, role, text, ...(streaming ? { streaming: true } : {}) }].slice(-CHAT_CAP) }))
    return id
  },

  appendChat: (id, delta) =>
    set(s => ({
      chat: s.chat.map(m => (m.id === id ? { ...m, text: m.text + delta } : m)),
    })),

  /** 流结束：清掉流式光标；最终文本为空（模型只发工具调用/被中止）则移除气泡 */
  finishChat: id =>
    set(s => ({
      chat: s.chat
        .filter(m => !(m.id === id && m.role === 'assistant' && m.text === ''))
        .map(m => (m.id === id && m.role === 'assistant' ? { ...m, streaming: false } : m)),
    })),

  clearChat: () => set({ chat: [] }),
}))
