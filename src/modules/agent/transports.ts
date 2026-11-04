import { ServerAgentTransport } from '../../core/serverAgentTransport'
import { AGENT_TOOLS, runAgentTool } from './tools'
import { useAgentStore } from './agentStore'
import { getActiveSettings } from '../agent/llmSettings'
import { LlmChatTransport, SYSTEM_PROMPT } from './llmChatTransport'
import type { AgentInbound, AgentOutbound, AgentTransport, AgentTransportHandlers } from './protocol'

/**
 * 传输层实现（三种，可换）：
 * - LlmChatTransport：浏览器直连 LLM（默认）——本地 Harness 驱动聊天 + 工具循环 + 提案裁决；
 * - LoopbackTransport：演示回环——本进程内扮演 Harness，跑一段固定脚本
 *   （读场景 → 无UI截图 → 截图中心视觉点选 → 提案增量调整+补箱子 → 等待人工裁决），
 *   无后端/无 Key 即可演示权限流程与视觉点选链路；
 * - WebSocketTransport：三期远端 Harness（Node 后端）的接入位，JSON 文本帧，自动重连。
 * 用 ?agent= 选择：缺省=浏览器直连 LLM；loopback|demo=演示回环；1|ws=默认地址 ws://localhost:5174；
 * ?agent=ws://host:port=指定地址。
 */

const STEP_GAP_MS = 350

class LoopbackTransport implements AgentTransport {
  readonly name = '演示回环（loopback）'
  private handlers: AgentTransportHandlers | null = null
  private timers: number[] = []
  private step: 'idle' | 'state' | 'shot' | 'pick' | 'op1' | 'op2' = 'idle'
  /** 演示兜底：pick 落空时调整场景里的首个资产 */
  private firstAssetId: string | null = null

  start(handlers: AgentTransportHandlers): void {
    this.handlers = handlers
    handlers.onStatus(true)
  }

  stop(): void {
    this.clearTimers()
    this.handlers = null
    this.step = 'idle'
  }

  /** 插件回给"Harness"的消息：驱动演示脚本的状态机 */
  send(msg: AgentOutbound): void {
    if (msg.kind !== 'call_result') return
    if (msg.ok) this.onOkResult(msg.callId, msg.data)
    else this.abort(`调用 ${msg.callId} 失败：${msg.error}`)
  }

  /** 面板「运行演示任务」按钮入口（session 会在非 idle / 非 loopback 时拦截） */
  runDemo(): boolean {
    if (!this.handlers || this.step !== 'idle') return false
    this.step = 'state'
    this.firstAssetId = null
    this.deliver({ kind: 'call', callId: 'demo-state', tool: 'scene.get_state', args: {} })
    return true
  }

  private onOkResult(callId: string, data: unknown): void {
    if (callId === 'demo-state' && this.step === 'state') {
      const state = data as { assets?: Array<{ id: string }> }
      this.firstAssetId = state?.assets?.[0]?.id ?? null
      this.step = 'shot'
      this.deliverLater({ kind: 'call', callId: 'demo-shot', tool: 'viewport.screenshot', args: { maxWidth: 480 } })
      return
    }
    if (callId === 'demo-shot' && this.step === 'shot') {
      const shot = data as { width?: number; height?: number }
      const w = typeof shot?.width === 'number' ? shot.width : 480
      const h = typeof shot?.height === 'number' ? shot.height : 360
      this.step = 'pick'
      // 视觉点选自测：拿截图的中心像素去拾取（拾取口径与截图一致）
      this.deliverLater({
        kind: 'call',
        callId: 'demo-pick',
        tool: 'viewport.pick',
        args: { x: Math.floor(w / 2), y: Math.floor(h / 2), imageWidth: w, imageHeight: h },
      })
      return
    }
    if (callId === 'demo-pick' && this.step === 'pick') {
      const pick = data as { assetId?: string | null }
      const target = typeof pick?.assetId === 'string' ? pick.assetId : this.firstAssetId
      this.step = 'op1'
      this.deliverLater({ kind: 'task_begin', taskId: 'demo-task', label: '演示：点选物整队并补一个箱子' })
      if (!target) {
        // 空场景且点选落空：直接结束提案（用户可拒绝空事务，或接受无事发生）
        this.deliverLater({ kind: 'task_end', taskId: 'demo-task' })
        return
      }
      // 增量调整自测：不需要先读当前变换再复述全量
      this.deliverLater({
        kind: 'call',
        callId: 'demo-op1',
        taskId: 'demo-task',
        tool: 'asset.adjust_transform',
        args: { assetId: target, translate: [0.6, 0, 0.4], rotateDeg: [0, 25, 0] },
      })
      return
    }
    if (callId === 'demo-op1' && this.step === 'op1') {
      this.step = 'op2'
      this.deliverLater({
        kind: 'call',
        callId: 'demo-op2',
        taskId: 'demo-task',
        tool: 'asset.add',
        args: { ref: 'models/placeholder-box', position: [1.4, 0, 0.8], name: 'Agent 放置的箱子' },
      })
      return
    }
    if (callId === 'demo-op2' && this.step === 'op2') {
      this.step = 'idle'
      this.deliverLater({ kind: 'task_end', taskId: 'demo-task' })
    }
  }

  /** 任一调用失败：结束提案让用户裁决，脚本复位 */
  private abort(reason: string): void {
    if (this.step === 'op1' || this.step === 'op2') {
      this.deliverLater({ kind: 'task_end', taskId: 'demo-task' })
    }
    this.step = 'idle'
    console.warn('[agent/loopback] 演示中断：', reason)
  }

  private deliver(msg: AgentInbound): void {
    this.handlers?.onInbound(msg)
  }

  private deliverLater(msg: AgentInbound): void {
    this.timers.push(window.setTimeout(() => this.deliver(msg), STEP_GAP_MS))
  }

  private clearTimers(): void {
    for (const t of this.timers) window.clearTimeout(t)
    this.timers = []
  }
}

class WebSocketTransport implements AgentTransport {
  readonly name: string
  private url: string
  private handlers: AgentTransportHandlers | null = null
  private ws: WebSocket | null = null
  private stopped = false
  private retries = 0
  private timer: number | null = null

  constructor(url = 'ws://localhost:5174') {
    this.url = url
    this.name = `WebSocket（${url}）`
  }

  start(handlers: AgentTransportHandlers): void {
    this.handlers = handlers
    this.stopped = false
    this.connect()
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws.onopen = () => {
      this.retries = 0
      this.handlers?.onStatus(true)
    }
    this.ws.onmessage = e => {
      try {
        this.handlers?.onInbound(JSON.parse(String(e.data)) as AgentInbound)
      } catch (err) {
        console.warn('[agent/ws] 无法解析入站消息：', err)
      }
    }
    this.ws.onclose = () => {
      this.handlers?.onStatus(false)
      this.scheduleRetry()
    }
    this.ws.onerror = () => {
      /* onclose 随后会触发重连调度 */
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    if (++this.retries > 8) {
      console.warn('[agent/ws] 多次重连失败，暂停；在面板点击「重连」可重试')
      return
    }
    const delay = Math.min(1000 * 2 ** (this.retries - 1), 10_000)
    this.timer = window.setTimeout(() => this.connect(), delay)
  }

  /** 手动重连入口（面板按钮） */
  retry(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.retries = 0
    this.connect()
  }

  send(msg: AgentOutbound): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
    this.handlers?.onStatus(false)
  }
}

/** 依据 URL 参数选择传输层 */
export function createTransport(): AgentTransport {
  const param = new URLSearchParams(location.search).get('agent')
  if (param === 'browser') return new LlmChatTransport()
  if (param === null) return new ServerAgentTransport({
    channel: 'agent', view: () => useAgentStore.getState(), settings: getActiveSettings,
    system: SYSTEM_PROMPT, tools: AGENT_TOOLS,
    runTool: (name, args, tx) => runAgentTool(name as Parameters<typeof runAgentTool>[0], args, { tx }),
  })
  if (param === 'loopback' || param === 'demo' || param === '0') return new LoopbackTransport()
  if (param === '1' || param === 'ws') return new WebSocketTransport()
  return new WebSocketTransport(param)
}

/** 面板「重连」按钮：仅 WebSocket 传输有意义 */
export function retryIfWs(t: AgentTransport): boolean {
  if (t instanceof ServerAgentTransport) { t.reconnect();return true }
  if (t instanceof WebSocketTransport) {
    t.retry()
    return true
  }
  return false
}

/** 面板「运行演示任务」按钮：仅 loopback 支持自测脚本 */
export function runDemoIfLoopback(t: AgentTransport): boolean {
  return t instanceof LoopbackTransport && t.runDemo()
}
