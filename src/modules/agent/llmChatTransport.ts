import { newLlmSession } from '../llm-shared/request'
import { bus } from '../../core/events'
import { useAgentStore } from './agentStore'
import { llmChat } from './llmClient'
import type { LlmChatResult, LlmResultImage, LlmToolSpec, LlmTurn, ToolCallOut } from './llmClient'
import { getActiveSettings } from './llmSettings'
import type { AgentInbound, AgentOutbound, AgentTransport, AgentTransportHandlers } from './protocol'
import { recorder } from './recorder'
import { AGENT_TOOLS } from './tools'

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

// 视觉点选循环一轮要走 截图→点选→调整→复核 四步，比纯文本任务耗轮数
const MAX_ROUNDS = 24

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

const TOOL_SPECS: LlmToolSpec[] = AGENT_TOOLS.map(t => ({
  name: wireName(t.name),
  description: `${t.description}\n参数：${t.argsDoc}`,
  schema: t.schema,
}))

const SYSTEM_PROMPT = `你是 3D-Layout 场景编辑器里的布局助手，通过工具直接操作用户的 3D 场景。

场景约定：单位米；+Y 向上；欧拉角为角度制（XYZ 顺序）；资产原点在底面中心，position 即底面中心的世界坐标。

工作规则：
1. 动手前先调用 scene_get_state 了解场景与可用模型；asset_add 的 ref 必须来自 manifest，assetId 必须来自现有资产。
2. 修改场景只用写工具。同一轮回复里的所有写操作会作为一项任务整体提交。编辑器有两种权限模式——「变更前确认」（用户接受才入账，拒绝则全部回滚）与「自动编辑」（直接应用并保存）；无论哪种，任务结果都会以系统消息回告。
3. 任务被回滚时你会收到系统消息说明，请调整方案后重新提案，不要原样重复。
4. 视觉工作流：viewport_screenshot 截图当前视口，图像会作为附图回传（左上原点、像素坐标，宽高见结果字段）。看图后用 viewport_pick 点选图上物体：传像素 (x,y) 加该图的 width/height，射线拾取返回 assetId、当前 transform 与命中点 hit.point（世界坐标，米）。注意：pick 坐标必须基于最近一次截图，期间你改过场景就重新截图再 pick；未命中不报错（assetId 为 null），换相邻像素重试。历史里只保留最近一批附图，旧图会被省略，需要回看就重新截图。
5. 调整物体：asset_adjust_transform 做增量微调（translate 米 / rotateDeg 度 / scaleMul 倍率；不动的轴不填即可），asset_set_transform 设定绝对变换；改完用 viewport_screenshot 复核。
6. 世界包围盒 worldAabb 已计入旋转和有符号缩放，摆放时用它避免穿模重叠。模型库尺寸为标准化后的米单位尺寸，新增模型默认 scale=[1,1,1]，只在明确需要时调整。scaleStatus=estimated 是估计尺寸，frontStatus=unverified 时须检查物体正面。
7. 用中文简洁说明你要做什么；一次任务做完整的一件事（如"摆一组会客区"），不要零碎多次。
8. 调用记录：用户要求写「调用记录 / 操作日志」时用 log_write。name 给日志起名（进文件名，可中文）；editsRecap = 第一部分，凭你自己的回忆写本轮的编辑清单与每次参数（只读调用可略述）；explanation = 第二部分，写总目的与每一步为什么这么做。第三部分由编辑器按实际记录自动生成，不要伪造。round 默认最近一轮；要修改已生成的日志，把上次结果返回的 filename 原样传入即可覆写。`

type CallResultMsg = Extract<AgentOutbound, { kind: 'call_result' }>

export class LlmChatTransport implements AgentTransport {
  readonly name = '本地 LLM'
  private handlers: AgentTransportHandlers | null = null
  private turns: LlmTurn[] = []
  private sessionId = newLlmSession()
  private ac: AbortController | null = null
  private pendingCalls = new Map<string, (r: CallResultMsg) => void>()
  private pendingVerdict: ((v: 'accepted' | 'rejected') => void) | null = null
  private seq = 0
  private offBus: (() => void) | null = null

  start(handlers: AgentTransportHandlers): void {
    this.handlers = handlers
    // 场景切换后资产 id 全变，历史对话作废
    this.offBus = bus.on('scene:changed', () => {
      if (this.turns.length > 0) {
        this.turns = []
        this.sessionId = newLlmSession()
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
    this.sessionId = newLlmSession()
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
    store.pushChat('user', text)
    recorder.beginRound(text) // 一条用户指令 = 一轮（日志的轮次口径）
    this.turns.push({ role: 'user', text })
    store.setLlmBusy(true)
    try {
      await this.runLoop()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof DOMException && e.name === 'AbortError') {
        useAgentStore.getState().pushChat('note', '已停止生成')
      } else {
        useAgentStore.getState().pushChat('note', `出错：${msg}`)
      }
    } finally {
      useAgentStore.getState().setLlmBusy(false)
      this.ac = null
    }
  }

  private async runLoop(): Promise<void> {
    const labelBase = [...this.turns].reverse().find(t => t.role === 'user')
    const label = `AI：${(labelBase && labelBase.role === 'user' ? labelBase.text : '编辑场景').slice(0, 18)}`

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (!this.handlers) return
      this.ac = new AbortController()
      // 取当前生效档案的连接配置（多档案：只有 active 那份参与本次会话）
      const settings = getActiveSettings()

      const bubbleId = useAgentStore.getState().pushChat('assistant', '', true)
      let result: LlmChatResult
      try {
        result = await llmChat({
          sessionId: this.sessionId,
          settings,
          system: SYSTEM_PROMPT,
          turns: this.turns,
          tools: TOOL_SPECS,
          signal: this.ac.signal,
          onEvent: ev => {
            if (ev.type === 'text') {
              useAgentStore.getState().appendChat(bubbleId, ev.delta)
            }
          },
        })
      } finally {
        // 中止/出错也要收尾气泡（清光标；空文本则移除）
        useAgentStore.getState().finishChat(bubbleId)
      }
      this.turns.push({ role: 'assistant', text: result.text, toolCalls: result.toolCalls })
      if (result.toolCalls.length === 0) {
        if (result.text === '') useAgentStore.getState().pushChat('note', '（模型未返回内容）')
        return
      }
      await this.executeCalls(result.toolCalls, label)
    }
    useAgentStore.getState().pushChat('note', `已达单轮最大步数（${MAX_ROUNDS} 轮），可继续输入以延续任务`)
  }

  /** 按顺序执行工具调用：写工具自动并入一个任务事务，task_end 后等待人工裁决 */
  private async executeCalls(calls: ToolCallOut[], label: string): Promise<void> {
    const results: Array<{ callId: string; ok: boolean; content: unknown; images?: LlmResultImage[] }> = []
    let taskOpen = false
    let taskId = ''

    for (const c of calls) {
      if (!this.handlers) return
      // LLM 给的是线上名（下划线），翻回注册表规范名（点名）；未知名原样透传给 session 拒绝
      const toolName = resolveToolName(c.name)
      const callId = `c${++this.seq}`
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
      this.pendingCalls.delete(callId)
      const { content, images } = r.ok
        ? this.sanitize(toolName, r.data)
        : { content: { error: r.error }, images: undefined }
      useAgentStore
        .getState()
        .pushChat('note', r.ok ? `✓ ${toolName} 完成` : `✗ ${toolName}：${r.error}`)
      // 回传 LLM 的 callId 必须是模型发放的那个（c.id），否则下一轮重放历史时配对校验失败
      results.push({ callId: c.id || callId, ok: r.ok, content, ...(images ? { images } : {}) })
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
          .pushChat('note', auto ? '✓ 自动编辑：改动已入账并保存' : '✓ 提案已被接受，改动入账')
        this.turns.push({
          role: 'user',
          text: auto
            ? '[系统] 自动编辑模式：改动已直接应用并保存。'
            : '[系统] 用户接受了本提案，全部改动已生效。',
        })
      } else {
        useAgentStore.getState().pushChat('note', '⟦回滚⟧ 提案被拒绝，改动已全部撤销')
        this.turns.push({
          role: 'user',
          text: '[系统] 用户拒绝了本提案，所有改动已回滚。请调整方案后重新提案。',
        })
      }
    }
  }

  /** 回传 LLM 的结果瘦身：截图抽出为附图（sendImages 开启时），面板展示不受影响 */
  private sanitize(tool: string, data: unknown): { content: unknown; images?: LlmResultImage[] } {
    if (tool === 'viewport.screenshot') {
      const d = data as { image?: string; width?: number; height?: number }
      const base = { width: d?.width ?? null, height: d?.height ?? null }
      if (getActiveSettings().sendImages && typeof d?.image === 'string') {
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
