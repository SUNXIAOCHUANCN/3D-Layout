import { edit, type TxHandle } from '../../core/edit'
import { bus } from '../../core/events'
import { saveScene } from '../../core/io'
import { useSceneStore } from '../../core/store'
import { useAgentStore } from './agentStore'
import { LlmChatTransport } from './llmChatTransport'
import { AGENT_PROTOCOL_VERSION } from './protocol'
import type { AgentInbound, AgentTransport } from './protocol'
import { recorder } from './recorder'
import { AGENT_TOOLS, runAgentTool } from './tools'
import { runLog } from './runLog'
import { createTransport, retryIfWs, runDemoIfLoopback } from './transports'

/**
 * AgentSession —— 任务编排单例（bus / engine 同款模式，非 React 代码）。
 *
 * 职责：传输层生命周期；task_begin/call/task_end 的协议处理；
 * 一个任务 = 一个 edit 事务（source:'agent'），task_end 后进入「等待人工裁决」，
 * accept()=commit 入账 / reject()=rollback 回滚——提案即回滚边界。
 * 入站消息经 promise 队列串行，避免截图 await 期间与写操作交错。
 */
class AgentSession {
  private transport: AgentTransport | null = null
  private tx: TxHandle | null = null
  private taskId: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private offBus: (() => void) | null = null
  private callAbort: AbortController | null = null

  get running(): boolean {
    return this.transport !== null
  }

  start(): void {
    if (this.transport) return
    const t = createTransport()
    this.transport = t
    const st = useAgentStore.getState()
    st.setTransport(t.name, false)
    st.setChatEnabled(t instanceof LlmChatTransport)
    st.pushLog('info', `Agent 模块启动（${t.name}）`)
    t.start({
      onInbound: msg => this.enqueue(() => this.handleInbound(msg)),
      onStatus: connected => {
        useAgentStore.getState().setConnected(connected)
        if (connected) this.sendHello()
      },
    })
    this.offBus = bus.on('scene:changed', () => this.onSceneChanged())
  }

  stop(): void {
    this.callAbort?.abort()
    this.offBus?.()
    this.offBus = null
    if (this.tx) {
      this.tx.rollback()
      useAgentStore.getState().pushLog('verdict', '模块关闭，未裁决提案已回滚')
      this.resetTask()
    }
    this.transport?.stop()
    this.transport = null
    useAgentStore.getState().setTransport('（未启动）', false)
    useAgentStore.getState().setChatEnabled(false)
  }

  // ---------- 面板动作 ----------

  /** 面板聊天输入：仅浏览器直连 LLM 传输支持 */
  sendChat(text: string): void {
    const t = this.transport
    if (!(t instanceof LlmChatTransport)) {
      useAgentStore.getState().pushChat('note', '当前传输不支持聊天（仅浏览器直连 LLM 模式）')
      return
    }
    if (useAgentStore.getState().phase !== 'idle') {
      useAgentStore.getState().pushChat('note', '请先裁决当前提案（接受 / 拒绝）')
      return
    }
    void t.sendUserMessage(text)
  }

  /** 中止生成（不裁决已打开的提案） */
  abortChat(): void {
    this.callAbort?.abort()
    if (this.transport instanceof LlmChatTransport) this.transport.abortChat()
    if (this.tx) this.reject()
  }

  /** 清空对话历史 */
  clearChat(): void {
    if (this.transport instanceof LlmChatTransport) this.transport.resetConversation()
    else useAgentStore.getState().clearChat()
  }

  /** origin：user=面板点击接受；auto=自动编辑模式直接入账 */
  accept(origin: 'user' | 'auto' = 'user'): void {
    if (!this.tx || !this.taskId) return
    const t = useAgentStore.getState().task
    this.tx.commit()
    runLog.event('transaction.committed', { taskId: this.taskId, origin, writes: t?.writes ?? 0 })
    recorder.recordTaskVerdict(this.taskId, 'accepted', t?.writes ?? 0)
    this.send({ kind: 'task_result', taskId: this.taskId, verdict: 'accepted', writes: t?.writes ?? 0 })
    useAgentStore.getState().pushLog(
      'verdict',
      origin === 'auto'
        ? `自动入账「${t?.label ?? this.taskId}」：${t?.writes ?? 0} 次写操作`
        : `已接受「${t?.label ?? this.taskId}」：${t?.writes ?? 0} 次写操作入账`,
    )
    this.resetTask()
    // LLM 改动入账后直接落盘
    runLog.track(this.saveAfterAgentEdit(origin))
  }

  /** Agent 任务入账后的自动保存（dev/preview 走保存接口；静态托管降级为下载） */
  private async saveAfterAgentEdit(origin: 'user' | 'auto'): Promise<void> {
    try {
      const r = await saveScene()
      runLog.event('scene.saved', { mode: r.mode, version: r.version })
      const where = `scenes/${useSceneStore.getState().sceneId ?? '?'}/scene.json`
      const text =
        r.mode === 'server'
          ? `已保存 ${where}（v${r.version}）`
          : '保存服务不可用，已降级为下载 scene.json'
      useAgentStore.getState().pushChat('note', origin === 'auto' ? `自动编辑：${text}` : text)
    } catch (e) {
      runLog.event('scene.save_failed', { error: e instanceof Error ? e.message : String(e) })
      useAgentStore.getState().pushChat('note', `自动保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  reject(): void {
    if (!this.tx || !this.taskId) return
    const t = useAgentStore.getState().task
    this.tx.rollback()
    runLog.event('transaction.rolled_back', { taskId: this.taskId, writes: t?.writes ?? 0 })
    recorder.recordTaskVerdict(this.taskId, 'rejected', t?.writes ?? 0)
    this.send({ kind: 'task_result', taskId: this.taskId, verdict: 'rejected', writes: t?.writes ?? 0 })
    useAgentStore.getState().pushLog('verdict', `已拒绝「${t?.label ?? this.taskId}」：提案全部回滚`)
    this.resetTask()
  }

  /** 面板「运行演示任务」：走真实协议链路的自测脚本（仅 loopback 传输） */
  runDemo(): void {
    const t = this.transport
    if (!t) return
    if (useAgentStore.getState().phase !== 'idle') {
      useAgentStore.getState().pushLog('error', '任务进行中，先裁决当前提案')
      return
    }
    if (!runDemoIfLoopback(t)) {
      useAgentStore.getState().pushLog('error', '当前传输是 WebSocket，自测脚本仅演示回环可用')
    }
  }

  /** 面板「重连」按钮（仅 WebSocket 传输有意义） */
  reconnect(): void {
    if (!this.transport) return
    if (!retryIfWs(this.transport)) {
      useAgentStore.getState().pushLog('info', '演示回环无需重连')
    }
  }

  // ---------- 内部 ----------

  private sendHello(): void {
    this.send({
      kind: 'hello',
      protocol: AGENT_PROTOCOL_VERSION,
      sceneId: useSceneStore.getState().sceneId,
    })
  }

  private send(msg: Parameters<AgentTransport['send']>[0]): void {
    this.transport?.send(msg)
  }

  /** 入站处理串行化：前序失败不断链 */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn, fn).catch(() => {})
  }

  private async handleInbound(msg: AgentInbound): Promise<void> {
    switch (msg.kind) {
      case 'task_begin': {
        if (this.tx) {
          useAgentStore.getState().pushLog('error', `任务 ${this.taskId} 未裁决，新任务开始前先回滚它`)
          this.reject()
        }
        this.taskId = msg.taskId
        this.tx = edit.begin(msg.label, 'agent')
        runLog.event('transaction.started', { taskId: msg.taskId, label: msg.label })
        recorder.recordTaskBegin(msg.taskId, msg.label)
        useAgentStore.getState().beginTask({ taskId: msg.taskId, label: msg.label, reads: 0, writes: 0 })
        useAgentStore.getState().pushLog('info', `任务开始：${msg.label}（人工编辑暂停）`)
        break
      }

      case 'call': {
        const def = AGENT_TOOLS.find(t => t.name === msg.tool)
        if (!def) {
          const error = `工具 ${String(msg.tool)} 未授权（不在编辑器开放清单内）`
          this.send({ kind: 'call_result', callId: msg.callId, ok: false, error })
          useAgentStore.getState().pushLog('error', error)
          return
        }
        if (def.access === 'write' && (!this.tx || msg.taskId !== this.taskId)) {
          const error = '写工具仅在任务事务内可用（先 task_begin 且 taskId 一致）'
          this.send({ kind: 'call_result', callId: msg.callId, ok: false, error })
          useAgentStore.getState().pushLog('error', `${def.name} 被拒绝：任务外写操作`)
          return
        }
        useAgentStore.getState().pushLog('call', def.name)
        const controller = new AbortController()
        this.callAbort = controller
        const res = await runAgentTool(msg.tool, msg.args ?? {}, { tx: this.tx, signal: controller.signal })
        if (this.callAbort === controller) this.callAbort = null
        // 黑匣子：每次调用（含参数与成败）落进 recorder，供日志第三部分自动生成
        recorder.recordCall({
          tool: def.name,
          access: def.access,
          args: msg.args ?? {},
          ok: res.ok,
          ...(res.ok ? {} : { error: res.error }),
          ...(msg.taskId ? { taskId: msg.taskId } : {}),
        })
        useAgentStore.getState().countCall(def.access)
        if (res.ok) {
          if (def.name === 'viewport.screenshot') {
            const d = res.data as { image?: string }
            if (typeof d.image === 'string') useAgentStore.getState().setScreenshot(d.image)
          }
          this.send({ kind: 'call_result', callId: msg.callId, ok: true, data: res.data })
          useAgentStore.getState().pushLog('ok', `${def.name} 完成`)
        } else {
          this.send({ kind: 'call_result', callId: msg.callId, ok: false, error: res.error })
          useAgentStore.getState().pushLog('error', `${def.name} 失败：${res.error}`)
        }
        break
      }

      case 'task_end': {
        if (!this.tx || msg.taskId !== this.taskId) {
          useAgentStore.getState().pushLog('error', `task_end 与当前任务不匹配（${msg.taskId}）`)
          return
        }
        if (useAgentStore.getState().permissionMode === 'auto') {
          // 自动编辑模式：不经人工裁决直接入账（随后的 task_result 会驱动对话续跑）
          this.accept('auto')
        } else {
          useAgentStore.getState().awaitVerdict()
          useAgentStore.getState().pushLog('info', '提案完成，等待人工裁决')
        }
        break
      }
    }
  }

  private resetTask(): void {
    this.tx = null
    this.taskId = null
    useAgentStore.getState().endTask()
  }

  /** 场景切换：edit 已整体清空历史与打开的事务，会话状态跟随复位并通知对端 */
  private onSceneChanged(): void {
    this.callAbort?.abort()
    this.sendHello()
    recorder.reset()
    if (this.tx || this.taskId) {
      const taskId = this.taskId
      this.resetTask()
      useAgentStore.getState().pushLog('error', '场景已切换，进行中的任务终止')
      if (taskId) this.send({ kind: 'task_result', taskId, verdict: 'rejected', writes: 0 })
    }
  }
}

export const agentSession = new AgentSession()
