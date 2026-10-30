import { bus } from '../../core/events'
import { useAgentStore } from './agentStore'
import { llmChat } from './llmClient'
import type { LlmChatResult, LlmResultImage, LlmToolSpec, LlmTurn, ToolCallOut } from './llmClient'
import { getActiveSettings } from '../agent/llmSettings'
import type { LlmSettings } from '../agent/llmSettings'
import type { AgentInbound, AgentOutbound, AgentTransport, AgentTransportHandlers } from './protocol'
import { recorder } from './recorder'
import { AGENT_TOOLS } from './tools'
import { runLog } from './runLog'
import { clearGeneratedResults } from './generatedResults'

/**
 * LlmChatTransport —— 浏览器直连 LLM 的"本地 Harness"。
 * 它是第三种传输：把用户在面板里输入的指令喂给 LLM（function calling），
 * 再把 LLM 的工具调用按协议（task_begin/call/task_end）投递给 session，
 * 等待 call_result / task_result 回流后继续循环。
 *
 * 提案语义与远端 Harness 完全一致：一轮回复里的所有写工具 = 一个任务事务，
 * task_end 后阻塞等待人工裁决（接受=commit / 拒绝=rollback），裁决结果以
 * 系统消息回告，模型可据此调整后重新提案。
 *
 * 视觉工作流（多模态模型）：viewport.screenshot 的截图作为工具结果附图回传，
 * 模型看图后用 viewport.pick 像素点选；历史对话只保留最近一批附图（省 token）。
 */

/** 写工具集合从注册表派生——新增写工具即自动并入任务事务 */
const WRITE_TOOLS = new Set<string>(AGENT_TOOLS.filter(t => t.access === 'write').map(t => t.name))

/**
 * 线上函数名约束：OpenAI 系（含 GLM 等兼容实现）与 Anthropic 都要求工具名
 * 匹配 ^[a-zA-Z0-9_-]+$——点号会直接 400。内部协议保持可读的点名（scene.get_state），
 * 只在 LLM 边界双向翻译：发出时点→下划线，收回时映射回注册表的规范名。
 */
const wireName = (n: string) => n.replace(/\./g, '_')
const WIRE_TO_CANONICAL = new Map<string, string>(AGENT_TOOLS.map(t => [wireName(t.name), t.name]))
const resolveToolName = (n: string) => WIRE_TO_CANONICAL.get(n) ?? n

const TOOL_SPECS: LlmToolSpec[] = AGENT_TOOLS.filter(t => !t.name.startsWith('log.')).map(t => ({
  name: wireName(t.name),
  description: `${t.description}\n参数：${t.argsDoc}`,
  schema: t.schema,
}))

const SYSTEM_PROMPT = `你是 3D-Layout 的场景编辑助手。根据用户任务自行选择是否使用工具及调用顺序。
场景单位为米，+Y 向上，旋转为 XYZ 欧拉角度制；模型原点位于底面中心。
asset.add 的 ref 必须来自模型目录，对象 ID 必须存在。场景写入通过工具进行，同一批写调用形成一个可接受或撤回的事务；自动编辑模式会直接提交。截图能否传给模型取决于模型配置。`

type CallResultMsg = Extract<AgentOutbound, { kind: 'call_result' }>

export class LlmChatTransport implements AgentTransport {
  readonly name = '浏览器直连 LLM'
  private handlers: AgentTransportHandlers | null = null
  private turns: LlmTurn[] = []
  private ac: AbortController | null = null
  private pendingCalls = new Map<string, (r: CallResultMsg) => void>()
  private pendingVerdict: ((v: 'accepted' | 'rejected') => void) | null = null
  private seq = 0
  private offBus: (() => void) | null = null

  start(handlers: AgentTransportHandlers): void {
    this.handlers = handlers
    // 场景切换后资产 id 全变，历史对话作废
    this.offBus = bus.on('scene:changed', () => {
      this.ac?.abort()
      if (this.turns.length > 0) {
        this.turns = []
        useAgentStore.getState().pushChat('note', '场景已切换，对话已重置')
      }
    })
    handlers.onStatus(true)
  }

  stop(): void {
    this.offBus?.()
    this.offBus = null
    this.ac?.abort()
    this.ac = null
    // 唤醒所有挂起的等待，让 runLoop 干净退出
    this.pendingVerdict?.('rejected')
    this.pendingVerdict = null
    for (const resolve of this.pendingCalls.values()) {
      resolve({ kind: 'call_result', callId: '', ok: false, error: '会话已停止' })
    }
    this.pendingCalls.clear()
    this.handlers = null
  }

  /** 插件 → 本地 Harness：工具结果 / 人工裁决回流 */
  send(msg: AgentOutbound): void {
    if (msg.kind === 'call_result') {
      this.pendingCalls.get(msg.callId)?.(msg)
    } else if (msg.kind === 'task_result') {
      this.pendingVerdict?.(msg.verdict)
      this.pendingVerdict = null
    }
  }

  resetConversation(): void {
    this.turns = []
    recorder.reset()
    useAgentStore.getState().clearChat()
  }

  abortChat(): void {
    this.ac?.abort()
  }

  /** 面板输入入口：一轮用户指令 → LLM 循环（工具调用 → 提案 → 裁决 → 续跑） */
  async sendUserMessage(text: string): Promise<void> {
    const store = useAgentStore.getState()
    if (store.llmBusy) return
    store.setLlmBusy(true)
    this.ac = new AbortController()
    const settings = { ...getActiveSettings() }
    let pythonAvailable = false
    try {
      const response = await fetch('/api/llm-agent-python/capabilities', { signal: AbortSignal.any([this.ac.signal, AbortSignal.timeout(6000)]) })
      if (response.ok) pythonAvailable = (await response.json() as { available?: boolean }).available === true
    } catch { /* Python 服务不可用时不暴露该工具 */ }
    if (this.ac?.signal.aborted || !this.handlers) {
      store.pushChat('note', '已停止生成')
      store.setLlmBusy(false)
      this.ac = null
      return
    }
    const tools = pythonAvailable ? TOOL_SPECS : TOOL_SPECS.filter(t => t.name !== 'python_execute')
    if (!pythonAvailable) store.pushChat('note', 'Python 工具不可用：需要 Docker 和本地 python:3.12-alpine 镜像。本次运行未开放该工具。')
    try {
      await runLog.start(text, { provider: settings.provider, model: settings.model, protocol: settings.protocol, sendImages: settings.sendImages, system: SYSTEM_PROMPT, tools, pythonAvailable, maxRounds: null, permissionMode: store.permissionMode }, settings.apiKey)
    } catch (e) {
      store.pushChat('note', `无法开始：日志服务不可用（${e instanceof Error ? e.message : String(e)}）`)
      store.setLlmBusy(false)
      this.ac = null
      return
    }
    store.pushChat('user', text)
    clearGeneratedResults()
    recorder.beginRound(text) // 一条用户指令 = 一轮（日志的轮次口径）
    this.turns.push({ role: 'user', text })
    let outcome = 'completed'
    try {
      this.ac?.signal.throwIfAborted()
      await this.runLoop(settings, tools)
    } catch (e) {
      outcome = e instanceof DOMException && e.name === 'AbortError' ? 'cancelled' : 'failed'
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof DOMException && e.name === 'AbortError') {
        useAgentStore.getState().pushChat('note', '已停止生成')
      } else {
        useAgentStore.getState().pushChat('note', `出错：${msg}`)
      }
    } finally {
      await runLog.finish(outcome)
      useAgentStore.getState().setLlmBusy(false)
      this.ac = null
    }
  }

  private async runLoop(settings: LlmSettings, tools: LlmToolSpec[]): Promise<void> {
    const labelBase = [...this.turns].reverse().find(t => t.role === 'user')
    const label = `AI：${(labelBase && labelBase.role === 'user' ? labelBase.text : '编辑场景').slice(0, 18)}`

    // 不限制工具循环轮数；保留对话历史，直到模型结束、用户中止或运行出错。
    for (let round = 0; ; round++) {
      if (!this.handlers) return
      this.ac?.signal.throwIfAborted()
      const bubbleId = useAgentStore.getState().pushChat('assistant', '', true)
      let result: LlmChatResult
      try {
        runLog.event('model.requested', { round, turns: this.turns })
        result = await llmChat({
          settings,
          system: SYSTEM_PROMPT,
          turns: this.turns,
          tools,
          signal: this.ac!.signal,
          onEvent: ev => {
            if (ev.type === 'text') {
              useAgentStore.getState().appendChat(bubbleId, ev.delta)
            }
          },
        })
      } catch (e) {
        runLog.event('model.failed', { round, error: e instanceof Error ? e.message : String(e) })
        throw e
      } finally {
        // 中止/出错也要收尾气泡（清光标；空文本则移除）
        useAgentStore.getState().finishChat(bubbleId)
      }
      runLog.event('model.responded', { round, result })
      this.turns.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls })
      if (result.toolCalls.length === 0) {
        if (result.text === '') useAgentStore.getState().pushChat('note', '（模型未返回内容）')
        return
      }
      await this.executeCalls(result.toolCalls, label, settings)
    }
  }

  /** 按顺序执行工具调用：写工具自动并入一个任务事务，task_end 后等待人工裁决 */
  private async executeCalls(calls: ToolCallOut[], label: string, settings: LlmSettings): Promise<void> {
    const results: Array<{ callId: string; ok: boolean; content: unknown; images?: LlmResultImage[] }> = []
    let taskOpen = false
    let taskId = ''

    for (const c of calls) {
      this.ac?.signal.throwIfAborted()
      if (!this.handlers) return
      // LLM 给的是线上名（下划线），翻回注册表规范名（点名）；未知名原样透传给 session 拒绝
      const toolName = resolveToolName(c.name)
      const callId = `c${++this.seq}`
      runLog.event('tool.requested', { callId, modelCallId: c.id, tool: toolName, args: c.args })
      if (WRITE_TOOLS.has(toolName) && !taskOpen) {
        taskOpen = true
        taskId = `t${this.seq}`
        this.deliver({ kind: 'task_begin', taskId, label })
      }
      useAgentStore.getState().pushChat('note', `⟦工具⟧ ${toolName}`)
      const resultPromise = new Promise<CallResultMsg>(resolve => {
        this.pendingCalls.set(callId, resolve)
      })
      this.deliver({
        kind: 'call',
        callId,
        tool: toolName,
        args: c.args && typeof c.args === 'object' ? c.args : {},
        ...(taskOpen ? { taskId } : {}),
      })
      const r = await resultPromise
      this.ac?.signal.throwIfAborted()
      if (toolName === 'viewport.screenshot' && r.ok) {
        const image = (r.data as { image?: unknown }).image
        if (typeof image === 'string') runLog.screenshot(callId, image)
      }
      runLog.event('tool.result', { callId, result: r })
      this.pendingCalls.delete(callId)
      const { content, images } = r.ok
        ? this.sanitize(toolName, r.data, settings)
        : { content: { error: r.error }, images: undefined }
      useAgentStore
        .getState()
        .pushChat('note', r.ok ? `✓ ${toolName} 完成` : `✗ ${toolName}：${r.error}`)
      // 回传 LLM 的 callId 必须是模型发放的那个（c.id），否则下一轮重放历史时配对校验失败
      results.push({ callId: c.id || callId, ok: r.ok, content, ...(images ? { images } : {}) })
      runLog.event('tool.result_delivered', { callId, content, imageDelivered: !!images?.length })
    }

    // 视觉上下文限长：只保留最近一批工具附图，更早的从历史里裁掉
    // （附图 base64 很贵；Anthropic 官方亦建议用占位替换旧图。模型需要回看时会重新截图）
    if (results.some(r => r.images && r.images.length > 0)) {
      for (const t of this.turns) {
        if (t.role !== 'toolResults') continue
        for (const r of t.results) {
          if (r.images) r.images = undefined
        }
      }
    }

    this.turns.push({ role: 'toolResults', results })

    if (taskOpen) {
      this.deliver({ kind: 'task_end', taskId })
      const verdict = await new Promise<'accepted' | 'rejected'>(resolve => {
        this.pendingVerdict = resolve
      })
      const auto = useAgentStore.getState().permissionMode === 'auto'
      // 裁决结果不走伪 tool_result（id 配对过不了校验），以系统口吻的 user 消息回告
      if (verdict === 'accepted') {
        useAgentStore
          .getState()
          .pushChat('note', auto ? '✓ 自动编辑：改动已入账，保存结果另行通知' : '✓ 提案已被接受，改动入账')
        this.turns.push({
          role: 'user',
          text: auto
            ? '[系统] 自动编辑模式：改动已直接应用。'
            : '[系统] 用户接受了本提案，全部改动已生效。',
        })
      } else {
        useAgentStore.getState().pushChat('note', '⟦回滚⟧ 提案被拒绝，改动已全部撤销')
        this.turns.push({
          role: 'user',
          text: '[系统] 用户拒绝了本提案，所有改动已回滚。',
        })
      }
    }
  }

  /** 回传 LLM 的结果瘦身：截图抽出为附图（sendImages 开启时），面板展示不受影响 */
  private sanitize(tool: string, data: unknown, settings: LlmSettings): { content: unknown; images?: LlmResultImage[] } {
    if (tool === 'viewport.screenshot') {
      const d = data as { image?: string; width?: number; height?: number; screenshotId?: string; camera?: unknown }
      const base = { width: d?.width ?? null, height: d?.height ?? null, screenshotId: d?.screenshotId, camera: d?.camera }
      if (settings.sendImages && typeof d?.image === 'string') {
        return {
          content: { ...base, note: '截图已随本结果附图回传；图像坐标左上原点（像素），供 viewport_pick 使用' },
          images: [{ dataUrl: d.image }],
        }
      }
      return {
        content: { ...base, note: '截图已生成并展示在用户面板（图像未回传：设置中关闭了截图回传，或需在设置中开启）' },
      }
    }
    return { content: data }
  }

  private deliver(msg: AgentInbound): void {
    this.handlers?.onInbound(msg)
  }
}
