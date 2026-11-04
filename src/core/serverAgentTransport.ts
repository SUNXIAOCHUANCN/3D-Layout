import { edit, type TxHandle } from './edit'
import { bus } from './events'
import { flushWorkspace } from './persistence'
import { useSceneStore } from './store'
import { clearAiReview, useAiReview } from './aiReview'
import { agentSystemPrompt, enabledAgentTools, useAgentCapabilities } from './agentCapabilities'
import type { SceneDocument } from './types'
import type { AgentTransport, AgentTransportHandlers, AgentOutbound } from '../modules/agent/protocol'
import type { LlmSettings } from '../modules/agent/llmSettings'

interface Call {
  id: string
  name: string
  args: Record<string, unknown>
  access: string
  result?: { ok: boolean; data?: unknown; error?: string }
}
interface Task {
  id: string
  sceneId: string
  status: string
  text: string
  error?: string
  retryable?: boolean
  pauseReason?: string
  streamingText?: string
  reviewVersion?: number
  epoch: number
  draft: SceneDocument
  before: SceneDocument
  chat: Array<{ role: 'user' | 'assistant' | 'note'; text: string }>
  calls: Call[]
  batch: Call[] | null
  modelRequests?: Array<{ index: number; startedAt: string; firstTextAt?: string; durationMs?: number; timeoutMs: number; status: string; contextChars?: number; activity?: string; connectedAt?: string }>
}
interface AgentView {
  llmBusy: boolean
  permissionMode: string
  setLlmBusy(value: boolean): void
  beginTask(task: { taskId: string; label: string; reads: number; writes: number; detail?: string; retryable?: boolean }): void
  awaitVerdict(): void
  endTask(): void
  pushChat(role: 'user' | 'assistant' | 'note', text: string): number
  clearChat(): void
  replaceChat(messages: Array<{ role: 'user' | 'assistant' | 'note'; text: string }>): void
}
interface Adapter {
  channel: 'agent' | 'llm-agent'
  view(): AgentView
  settings(): LlmSettings
  system: string
  tools: ReadonlyArray<{ name: string; access: string; description: string; argsDoc: string; schema: Record<string, unknown> }>
  runTool(name: string, args: Record<string, unknown>, tx: TxHandle): Promise<{ ok: boolean; data?: unknown; error?: string }>
}
const ended = new Set(['completed', 'failed', 'cancelled', 'conflict'])

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/tasks' + path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Layout-Client': '1' }, body: JSON.stringify(body),
  })
  const raw = await response.text()
  let result
  try { result = JSON.parse(raw) }
  catch {
    const message = response.status === 404
      ? '后端接口不存在（HTTP 404），请重启开发服务后重试；本次操作未确认成功'
      : `后端返回${raw.trim() ? '非 JSON' : '空'}响应（HTTP ${response.status}），请检查开发服务；本次操作未确认成功`
    throw Object.assign(new Error(message), { status: response.status })
  }
  if (!response.ok) throw Object.assign(new Error(result?.error ?? `HTTP ${response.status}`), { status: response.status })
  return result
}

/** Durable browser receipts bridge a completed local operation and its server ACK. */
let receipts: Promise<IDBDatabase> | undefined
function receiptDatabase(): Promise<IDBDatabase> {
  return receipts ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('3d-layout-ai-receipts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('receipts')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function receipt<T>(id: string, value?: T): Promise<T | undefined> {
  const database = await receiptDatabase()
  return new Promise((resolve, reject) => {
    const tx = database.transaction('receipts', value === undefined ? 'readonly' : 'readwrite')
    const request = value === undefined ? tx.objectStore('receipts').get(id) : tx.objectStore('receipts').put(value, id)
    tx.oncomplete = () => resolve(value ?? request.result)
    tx.onerror = tx.onabort = () => reject(tx.error)
  })
}

export class ServerAgentTransport implements AgentTransport {
  readonly name = '后端持久化任务'
  private timer: ReturnType<typeof setTimeout> | null = null
  private owner = crypto.randomUUID()
  private task: Task | null = null
  private tx: TxHandle | null = null
  private previewId = ''
  private previewVersion = -1
  private rendered = ''
  private stopped = true
  private reset = false
  private busy = false
  private screenshotEpoch = -1
  private lastMessage = ''
  private retryPending = false
  private sceneVersion = 0
  private offScene: (() => void) | null = null
  private originalDocument: SceneDocument | null = null
  private onStatus: ((connected: boolean) => void) | null = null

  constructor(private adapter: Adapter) {}
  start(handlers: AgentTransportHandlers): void {
    this.stopped = false;this.onStatus = handlers.onStatus;handlers.onStatus(true)
    this.offScene = bus.on('scene:changed', () => {
      clearAiReview(this.adapter.channel)
      this.sceneVersion++
      this.tx = null;this.previewId = '';this.previewVersion = -1;this.originalDocument = null;this.task = null;this.rendered = ''
      this.reset = false;this.lastMessage = '';this.screenshotEpoch = -1
      this.adapter.view().clearChat()
      this.adapter.view().endTask();this.adapter.view().setLlmBusy(false)
    })
    void this.poll()
  }
  stop(): void {
    clearAiReview(this.adapter.channel)
    this.stopped = true
    this.sceneVersion++
    this.offScene?.();this.offScene = null
    this.onStatus = null
    if (this.timer) clearTimeout(this.timer)
    this.tx?.rollback();this.tx = null
    if (this.originalDocument && this.previewId) useSceneStore.setState({ document: this.originalDocument })
    this.adapter.view().setLlmBusy(false);this.adapter.view().endTask()
    // Detach only: never cancel a backend task on refresh or component cleanup.
  }
  send(_message: AgentOutbound): void {}
  reconnect(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.busy && !this.stopped) void this.poll()
  }
  async resetConversation(): Promise<void> {
    if (this.adapter.view().llmBusy) return
    const version = ++this.sceneVersion
    this.adapter.view().setLlmBusy(true)
    try {
      if (this.task) await api(`/${this.task.id}/clear`, {})
      if (version !== this.sceneVersion) return
      this.task = null;this.reset = true;this.rendered = '';this.lastMessage = ''
      this.adapter.view().clearChat()
    } catch (error) { if (version === this.sceneVersion) this.note(error) }
    finally { if (version === this.sceneVersion) this.adapter.view().setLlmBusy(false) }
  }
  abortChat(): void { if (this.task) void api(`/${this.task.id}/cancel`, {}).catch(error => this.note(error)) }
  async verdict(verdict: 'accepted' | 'rejected' | 'revised', reason?: string): Promise<void> {
    if (!this.task) return
    const version = ++this.sceneVersion
    try {
      const task = await api<Task>(`/${this.task.id}/verdict`, { verdict, reason, reviewVersion: this.task.reviewVersion ?? 0 })
      if (version === this.sceneVersion) { this.task = task;this.renderChat(task) }
    } catch (error) { if (version === this.sceneVersion) this.note(error) }
  }
  async retry(): Promise<void> {
    if (!this.task?.retryable || this.retryPending) return
    this.retryPending = true
    const version = ++this.sceneVersion
    try {
      const task = await api<Task>(`/${this.task.id}/retry`, {
        requestId: crypto.randomUUID(), settings: this.adapter.settings(), ...this.toolConfig(),
      })
      if (version === this.sceneVersion) { this.task = task;this.renderChat(task) }
    } catch (error) { if (version === this.sceneVersion) this.note(error) }
    finally { this.retryPending = false }
  }
  private toolConfig() {
    const features = useAgentCapabilities.getState()
    return {
      workflow: 'original', features,
      system: agentSystemPrompt(this.adapter.system, features),
      tools: enabledAgentTools(this.adapter.tools, features).filter(t => !t.name.startsWith('log.')).map(t => ({ name: t.name, access: t.access, description: `${t.description}\n参数：${t.argsDoc}`, schema: t.schema })),
    }
  }
  async sendUserMessage(text: string): Promise<void> {
    if (this.adapter.view().llmBusy) return
    const version = ++this.sceneVersion
    this.adapter.view().setLlmBusy(true)
    try {
      const id = useSceneStore.getState().sceneId
      if (!id) throw new Error('请先加载场景')
      await flushWorkspace(id)
      if (!this.isCurrent(id, version)) return
      const task = await api<Task>('', {
        sceneId: id, channel: this.adapter.channel, text, settings: this.adapter.settings(),
        ...this.toolConfig(),
        permissionMode: this.adapter.view().permissionMode, reset: this.reset,
      })
      if (!this.isCurrent(id, version)) return
      this.task = task
      this.renderChat(task)
      this.reset = false;this.adapter.view().setLlmBusy(true)
    } catch (error) { if (version === this.sceneVersion) { this.adapter.view().setLlmBusy(false);this.note(error) } }
  }
  private isCurrent(sceneId: string, version: number): boolean {
    const scene = useSceneStore.getState()
    return !this.stopped && version === this.sceneVersion && scene.sceneId === sceneId && !scene.loading
  }
  private note(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error)
    if (text !== this.lastMessage) { this.adapter.view().pushChat('note', text);this.lastMessage = text }
  }
  private async poll(): Promise<void> {
    if (this.stopped || this.busy) return
    this.busy = true
    const version = this.sceneVersion
    try {
      const scene = useSceneStore.getState()
      if (!scene.sceneId || scene.loading) return
      let task = await api<Task | null>(`?sceneId=${encodeURIComponent(scene.sceneId)}&channel=${this.adapter.channel}`)
      if (!this.isCurrent(scene.sceneId, version)) return
      this.onStatus?.(true)
      if (this.stopped || !task || this.reset) return
      this.task = task
      this.renderChat(task)
      this.adapter.view().setLlmBusy(!ended.has(task.status) || !!task.retryable)
      if ((!ended.has(task.status) || task.retryable) && !this.previewId) this.adapter.view().beginTask({ taskId: task.id, label: '正在恢复后端任务', reads: 0, writes: 0 })
      if (!ended.has(task.status)) task = await api<Task>(`/${task.id}/attach`, { owner: this.owner, apiKey: this.adapter.settings().apiKey })
      if (!this.isCurrent(task.sceneId, version)) return
      this.task = task
      this.renderChat(task)
      if (ended.has(task.status) && !task.retryable) {
        clearAiReview(this.adapter.channel)
        if (task.error && task.status !== 'cancelled') this.note(task.error)
        this.adapter.view().setLlmBusy(false);this.adapter.view().endTask()
        if (this.previewId) {
          this.tx?.rollback();this.tx = null;this.previewId = ''
          await useSceneStore.getState().loadScene(task.sceneId)
        }
        return
      }
      this.adapter.view().setLlmBusy(true)
      const stage = task.retryable ? (task.pauseReason === 'service_error' ? '模型服务拒绝或出错，已暂停' : task.pauseReason === 'empty_response' ? '模型返回空回复，已暂停' : '模型请求超时，已暂停') : task.status === 'awaiting_browser' ? '等待浏览器工具' : task.status === 'awaiting_user' ? '提案已准备好，等待你接受' : '模型推理中'
      const request = task.modelRequests?.at(-1)
      const seconds = request ? Math.max(0, Math.floor((request.durationMs ?? Date.now() - Date.parse(request.startedAt)) / 1000)) : 0
      const detail = request ? `第 ${request.index} 轮模型请求 · ${seconds} 秒${request.status === 'running'
        ? ` · ${request.firstTextAt ? '正在接收输出' : request.activity === 'reasoning' ? '模型正在推理' : request.activity === 'tool' ? '正在接收工具调用' : request.connectedAt ? '已连接，等待输出' : '等待服务响应'} · ${request.timeoutMs > 0 ? `上限 ${Math.round(request.timeoutMs / 1000)} 秒` : '可手动停止'}${seconds >= 30 ? '；响应较慢，可继续等待或停止生成' : ''}` : ' · 已结束'}${request.contextChars !== undefined ? ` · 上下文 ${request.contextChars.toLocaleString()} 字符` : ''}` : undefined
      this.adapter.view().beginTask({ taskId: task.id, label: `${task.text.slice(0,24)} · ${stage}`, detail: task.retryable ? task.error : detail, retryable: task.retryable, reads: task.calls.filter(c => c.result && c.access !== 'write').length, writes: task.calls.filter(c => c.result && c.access === 'write').length })
      if (!this.previewId || this.previewVersion !== (task.reviewVersion ?? 0)) {
        this.originalDocument = structuredClone(task.before)
        this.tx?.rollback()
        this.tx = edit.begin(task.text.slice(0,100), 'agent')
        useSceneStore.setState({ document: structuredClone(task.draft) })
        this.previewId = task.id
        this.previewVersion = task.reviewVersion ?? 0
        this.screenshotEpoch = -1
        useAiReview.setState({ sceneId: task.sceneId, channel: this.adapter.channel, before: task.before, focusedId: null })
      }
      if (task.retryable) return
      if (task.status === 'awaiting_user') { this.adapter.view().awaitVerdict();return }
      const call = task.batch?.map(c => task!.calls.find(x => x.id === c.id)!).find(c => !c.result)
      if (call && this.tx) await this.execute(task, call, this.tx, version)
    } catch (error) {
      if (!this.stopped && version === this.sceneVersion) {
        if (!(error instanceof Error && 'status' in error && Number(error.status) < 500)) this.onStatus?.(false)
        this.note(error)
      }
    }
    finally {
      this.busy = false
      if (!this.stopped) this.timer = setTimeout(() => void this.poll(), 800)
    }
  }
  private renderChat(task: Task): void {
    const messages = task.streamingText ? [...task.chat, { role: 'assistant' as const, text: task.streamingText }] : task.chat
    const rendered = JSON.stringify(messages)
    if (rendered === this.rendered) return
    this.adapter.view().replaceChat(messages)
    this.rendered = rendered
  }
  private async execute(task: Task, call: Call, tx: TxHandle, version: number): Promise<void> {
    let pending: Promise<void> | null = null
    const renew = (): Promise<void> => {
      if (!this.isCurrent(task.sceneId, version)) return Promise.reject(new Error('场景或连接已切换，停止当前工具回传'))
      return pending ??= api(`/${task.id}/lease`, { owner: this.owner, epoch: task.epoch })
        .then(() => {}).finally(() => { pending = null })
    }
    await renew()
    // Tool execution blocks poll(), so its lease needs an independent heartbeat.
    const heartbeat = setInterval(() => {
      if (this.isCurrent(task.sceneId, version)) void renew().catch(() => {})
    }, 2000)
    try { await this.executeWithLease(task, call, tx, version, renew) }
    finally { clearInterval(heartbeat);await Promise.allSettled([pending]) }
  }
  private async executeWithLease(task: Task, call: Call, tx: TxHandle, version: number, renew: () => Promise<void>): Promise<void> {
    type Checkpoint = { result: { ok: boolean; data?: unknown; error?: string }; document: SceneDocument }
    let saved = await receipt<Checkpoint>(call.id)
    if (!this.isCurrent(task.sceneId, version)) return
    if (!saved) {
      // A durable issued marker distinguishes "never executed" from "outcome unknown".
      const marker = await receipt<boolean>(call.id + '-issued')
      if (!this.isCurrent(task.sceneId, version)) return
      let result: Checkpoint['result']
      if (call.name === 'viewport.pick' && this.screenshotEpoch !== task.epoch) {
        result = { ok: false, error: '页面已重新连接，原截图对应的视口已失效；请重新截图后再拾取' }
      } else if (marker && ['generate', 'export'].includes(call.access) && !window.confirm(`工具 ${call.name} 上次执行结果未确认，重新执行可能产生重复结果。是否重新执行？`)) {
        result = { ok: false, error: '用户拒绝重复执行结果未确认的外部副作用工具' }
      } else {
        await receipt(call.id + '-issued', true)
        if (!this.isCurrent(task.sceneId, version)) return
        if (call.name.startsWith('viewport.')) {
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        }
        if (!this.isCurrent(task.sceneId, version)) return
        await renew()
        result = await this.adapter.runTool(call.name, call.args ?? {}, tx)
        if (!this.isCurrent(task.sceneId, version)) return
        if (call.name === 'viewport.screenshot' && result.ok) this.screenshotEpoch = task.epoch
      }
      saved = { result, document: structuredClone(useSceneStore.getState().document!) }
      await receipt(call.id, saved)
    } else {
      await renew()
      useSceneStore.setState({ document: structuredClone(saved.document) })
    }
    if (!this.isCurrent(task.sceneId, version)) return
    await renew()
    const checkpoint = { callId: call.id, owner: this.owner, epoch: task.epoch, ...saved }
    try { await api(`/${task.id}/result`, checkpoint) }
    catch (error) {
      if (!(error instanceof Error && 'status' in error && error.status === 409)) throw error
      // Retry the durable receipt once, never the tool; a takeover still fails renew().
      await renew()
      await api(`/${task.id}/result`, checkpoint)
    }
  }
}
