import { useSceneStore } from '../../core/store'
import { engine } from '../../core/engine'
import type { SceneDocument } from '../../core/types'
import { llmChat, type LlmChatOptions, type LlmToolSpec, type LlmTurn } from './llmClient'
import { getActiveSettings, isLlmConfigured } from './llmSettings'
import { AGENT_TOOLS, runAgentTool } from './tools'
import { createScope } from './scopedEdit'
import { cacheSession, loadSession, saveSession, saveSceneSnapshot } from './persistence'
import { ownerAt, overhead } from './geometry'
import { runPartitionWorkflow, partitionConfig } from './partitionWorkflow'
import { usePartitionAgentStore as store } from './store'
import { boundHistoricalResults, retainImages } from './history'
import { clearGeneratedResults } from './generatedResults'
import type { Region, SceneSession, WorkerStatus, PartitionConfig } from './types'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
/** 单次请求最多附带的截图张数与总字符（约 1.8MB 二进制）：并行截图也要受控。 */
const MAX_TURN_IMAGES = 3
const MAX_TURN_IMAGE_CHARS = 2_400_000
const wire = (name: string) => name.replaceAll('.', '__')
const available = AGENT_TOOLS.filter(t => !t.name.startsWith('log.'))
const specs: LlmToolSpec[] = available.map(t => ({ name: wire(t.name), description: `${t.description}\n本插件所有合法编辑立即提交，不需要用户接受；分区权限由工具检查。`, schema: t.schema }))
const dispatch: LlmToolSpec = {
  name: 'agent_dispatch', description: '给多个分区派发任务；数组中的各区 SubAgent 同时运行和编辑共享场景，工具完成后返回实际结果。每个任务使用全新上下文。存在先后依赖时分多次调用。优先通过此工具完成场景编辑。',
  schema: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, items: { type: 'object', properties: { regionId: { type: 'string' }, task: { type: 'string' }, constraints: { type: 'string' } }, required: ['regionId', 'task'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false },
}
type Execute = (name: string, args: Record<string, unknown>) => Promise<unknown>

// Each instance owns its lifecycle; exported class also supports deterministic integration tests.
export class PartitionAgentRuntime {
  private controller: AbortController | null = null
  private epoch = 0
  private saveChain: Promise<void> = Promise.resolve()
  private pendingSessions = new Map<string, SceneSession>()
  private pendingScenes = new Map<string, SceneDocument>()
  private off: (() => void) | null = null
  constructor(private chat: (options: LlmChatOptions) => ReturnType<typeof llmChat> = llmChat) {}

  start() {
    if (this.off) return
    let id = useSceneStore.getState().sceneId
    void this.selectScene(id)
    this.off = useSceneStore.subscribe(s => { if (s.sceneId !== id) { id = s.sceneId; void this.selectScene(id) } })
  }
  stop() {
    this.abort(); this.epoch++; this.off?.(); this.off = null
    store.setState(state => ({ busy: false, loading: false, progress: '', workers: state.workers.map(w => w.status === 'running' ? { ...w, status: 'stopped', detail: '插件已关闭，已应用修改保留' } : w) }))
  }
  abort() { this.controller?.abort(new Error('用户停止；已应用的修改保留')) }
  async selectScene(id: string | null) {
    this.abort(); const epoch = ++this.epoch
    store.setState({ session: null, loading: !!id, busy: false, workers: [], progress: '', error: '', partitionPreview: null })
    if (!id) return
    try {
      await this.saveChain
      const session = await loadSession(id)
      if (epoch !== this.epoch) return
      if (session.partition) this.refreshOwners(session)
      store.setState({ session, loading: false })
    } catch (e) { if (epoch === this.epoch) store.setState({ loading: false, error: message(e) }) }
  }
  private refreshOwners(s: SceneSession) {
    const p = s.partition, doc = useSceneStore.getState().document
    if (!p || !doc) return
    const owners: Record<string, string> = {}
    for (const a of doc.assets) owners[a.id] = p.owners[a.id] ?? ownerAt(p.regions, a.transform.position)
    p.owners = owners
  }
  private persist(s: SceneSession) {
    s.updatedAt = Date.now()
    if (store.getState().session?.sessionId === s.sessionId) store.setState({ session: { ...s } })
    const cache = cacheSession(s)
    // 镜像可以精简甚至暂缺（磁盘仍保存完整会话）；只有整档写入失败才提示，恢复后自动清除。
    if (cache.ok) {
      if (store.getState().error.startsWith('浏览器缓存未更新')) store.setState({ error: '' })
    } else store.setState({ error: `浏览器缓存未更新：${cache.reason ?? '存储空间不足'}；会话仍在写入磁盘，刷新后以磁盘副本恢复。` })
    this.pendingSessions.set(s.sceneId, structuredClone(s))
    this.queueSave()
  }
  private queueSave() {
    this.saveChain = this.saveChain.then(async () => {
      const sessions = [...this.pendingSessions.values()]; this.pendingSessions.clear()
      const scenes = [...this.pendingScenes.entries()]; this.pendingScenes.clear()
      const results = await Promise.allSettled([
        ...sessions.map(saveSession), ...scenes.map(([id, doc]) => saveSceneSnapshot(id, doc)),
      ])
      for (const result of results) if (result.status === 'rejected') store.setState({ error: message(result.reason) })
    })
  }
  private changed(s: SceneSession) {
    const state = useSceneStore.getState()
    if (state.sceneId === s.sceneId && state.document) this.pendingScenes.set(s.sceneId, state.document)
    if (store.getState().session?.sessionId === s.sessionId) this.persist(s)
    else this.queueSave()
  }
  configurePartition(patch: Partial<PartitionConfig>) {
    const s = store.getState().session
    if (s && !store.getState().busy) { s.partitionConfig = partitionConfig({ ...s.partitionConfig, ...patch }); this.persist(s) }
  }
  async clear() {
    this.abort(); this.epoch++
    const s = store.getState().session
    if (!s) return
    const next = { ...s, sessionId: crypto.randomUUID(), turns: [], chat: [] }
    store.setState({ session: next, busy: false, workers: [], progress: '', error: '' })
    this.persist(next); await this.saveChain
  }
  private begin() {
    if (store.getState().busy || store.getState().loading) throw new Error('当前任务正在执行')
    const s = store.getState().session
    if (!s || useSceneStore.getState().sceneId !== s.sceneId || !useSceneStore.getState().document) throw new Error('请先加载场景与会话')
    const controller = new AbortController(); this.controller = controller
    const epoch = ++this.epoch
    store.setState({ busy: true, error: '', workers: [], partitionPreview: null })
    return { s, signal: controller.signal, epoch }
  }
  private current(s: SceneSession, signal: AbortSignal) {
    signal.throwIfAborted()
    if (store.getState().session?.sessionId !== s.sessionId || useSceneStore.getState().sceneId !== s.sceneId) throw new Error('会话或场景已切换')
  }
  async preprocess() {
    const { s, signal, epoch } = this.begin()
    try { await this.preprocessSession(s, signal) }
    catch (e) { if (epoch === this.epoch) store.setState({ error: message(e) }) }
    finally { if (epoch === this.epoch) store.setState({ busy: false, progress: '' }) }
  }
  private async preprocessSession(s: SceneSession, signal: AbortSignal) {
    this.current(s, signal)
    const { camera, bounds } = overhead(useSceneStore.getState().document!)
    // Partitioning needs surface colours and landmarks, rather than mirror-like ocean glare.
    const image = engine.captureFromCamera(camera, 1200, 900, { minRoughness: 0.65 })
    const partition = await runPartitionWorkflow(image, bounds, signal, (progress, preview) => { if (!signal.aborted) store.setState({ progress, ...(preview ? { partitionPreview: preview } : {}) }) }, s.partitionConfig)
    this.current(s, signal)
    s.partition = partition; this.refreshOwners(s)
    s.chat.push({ role: 'note', text: `分区已生成：${partition.regions.map(r => r.name).join('、')}。${partition.stopReason === 'model_finished' ? '模型已查看并确认。' : '达到运行限制，保留最后有效分区，模型尚未确认完成。'}` })
    this.persist(s)
  }
  private worker(status: WorkerStatus) { store.setState(s => ({ workers: [...s.workers.filter(w => w.id !== status.id), { ...status }] })) }
  private async execute(s: SceneSession, signal: AbortSignal, name: string, args: Record<string, unknown>, region?: Region, contextId = s.sessionId) {
    this.current(s, signal)
    const def = available.find(t => wire(t.name) === name)
    if (!def) throw new Error(`未授权工具：${name}`)
    if (def.name === 'viewport.pick' && !args.screenshotId) throw new Error('并行编辑时必须提供自己截图返回的 screenshotId，使用独立相机截图')
    let modified = false
    const tx = createScope({ sceneId: s.sceneId, regionId: region?.id, partition: s.partition!, signal, changed: () => { modified = true } })
    const result = await runAgentTool(def.name, def.name === 'viewport.pick' ? { ...args, highlight: false } : args, { tx, signal, contextId })
    if (modified) this.changed(s)
    this.current(s, signal)
    if (!result.ok) throw new Error(result.error)
    if (def.name === 'scene.get_state' && result.data && typeof result.data === 'object') {
      const data = result.data as { assets?: Array<{ id: string }> }
      return { ...data, assets: data.assets?.map(a => ({ ...a, regionId: s.partition!.owners[a.id] })), region: region ?? null }
    }
    return result.data
  }
  private async loop(s: SceneSession, signal: AbortSignal, turns: LlmTurn[], system: string, tools: LlmToolSpec[], execute: Execute, sessionId: string, checkpoint?: () => void): Promise<string> {
    const settings = getActiveSettings()
    for (;;) {
      this.current(s, signal); retainImages(turns); boundHistoricalResults(turns)
      const response = await this.chat({ settings, signal, sessionId, system, tools, turns, onEvent: () => {} })
      this.current(s, signal)
      if (!response.toolCalls.length && response.stopReason === 'max_tokens') throw new Error('模型输出达到上限，请缩小任务后继续')
      if (!response.toolCalls.length) { turns.push({ role: 'assistant', text: response.text, toolCalls: [] }); checkpoint?.(); return response.text }
      // A complete tool exchange is checkpointed atomically so restart never leaves orphan calls.
      const results = []
      // 一轮里可能并行拍多张图：按张数与总字符设上限，避免请求体被截图撑爆。
      let attached = 0, attachedChars = 0
      for (const call of response.toolCalls) {
        try {
          this.current(s, signal)
          const data = await execute(call.name, call.args)
          const value = data as { image?: string } | null
          const image = value?.image
          const attachable = !!image && settings.sendImages && attached < MAX_TURN_IMAGES && attachedChars + image.length <= MAX_TURN_IMAGE_CHARS
          if (image && attachable) { attached += 1; attachedChars += image.length }
          const images = image && attachable ? [{ dataUrl: image }] : undefined
          const content = image
            ? { ...value, image: undefined, ...(attachable ? {} : { note: '本次请求未附该截图（图片数量或体积超出上限），需要时请重新截图。' }) }
            : data
          results.push({ callId: call.id, ok: true, content, images })
        } catch (e) { results.push({ callId: call.id, ok: false, content: message(e) }) }
      }
      turns.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls }, { role: 'toolResults', results })
      if (!signal.aborted) checkpoint?.()
      this.current(s, signal)
    }
  }
  async dispatch(s: SceneSession, signal: AbortSignal, args: Record<string, unknown>) {
    this.current(s, signal)
    if (!Array.isArray(args.tasks) || !args.tasks.length) throw new Error('tasks 不能为空')
    const seen = new Set<string>()
    const tasks = args.tasks.map((input: unknown) => {
      const t = input as { regionId?: string; task?: string; constraints?: string }
      const region = s.partition!.regions.find(r => r.id === t?.regionId)
      if (!region || typeof t.task !== 'string' || !t.task.trim() || (t.constraints !== undefined && typeof t.constraints !== 'string')) throw new Error('分区任务无效')
      if (seen.has(region.id)) throw new Error('同一分区每批只能派发一个任务')
      seen.add(region.id); return { region, task: t.task, constraints: t.constraints ?? '' }
    })
    return Promise.all(tasks.map(async ({ region, task, constraints }) => {
      const status: WorkerStatus = { id: crypto.randomUUID(), regionId: region.id, task, status: 'running', detail: '正在执行' }
      this.worker(status)
      try {
        const turns: LlmTurn[] = [{ role: 'user', text: JSON.stringify({ task, constraints, region, ownedObjectIds: Object.keys(s.partition!.owners).filter(id => s.partition!.owners[id] === region.id), neighbors: s.partition!.regions.filter(r => r.id !== region.id) }) }]
        const text = await this.loop(s, signal, turns, '你是场景分区 SubAgent。每次任务都是新会话。只修改本区对象；可以读取全场景。新建与移动对象必须留在本区，使用对象锚点判断归属。所有合法修改立即生效，其他区域正在同时编辑。先读取当前场景，再使用工具执行任务；可以截图查看。无需等待验收，不评价或回滚其他 Agent 的结果。最后报告实际修改、工具失败和未完成事项。不要声称完成未执行的操作。', specs, (name, a) => this.execute(s, signal, name, a, region, status.id), status.id)
        status.status = 'completed'; status.detail = text
      } catch (e) { status.status = signal.aborted ? 'stopped' : 'failed'; status.detail = message(e) }
      clearGeneratedResults(status.id)
      if (!signal.aborted) this.worker(status)
      return status
    }))
  }
  async send(text: string) {
    if (!text.trim()) return
    const { s, signal, epoch } = this.begin()
    try {
      if (!isLlmConfigured()) throw new Error('请先配置总 Agent 与 SubAgent 使用的模型')
      s.chat.push({ role: 'user', text }); this.persist(s)
      if (!s.partition) await this.preprocessSession(s, signal)
      this.refreshOwners(s)
      s.turns.push({ role: 'user', text })
      const answer = await this.loop(s, signal, s.turns,
        '你是与场景绑定的总 Agent。主要负责理解用户任务、分包给区域 SubAgent、协调并汇报。尽量通过 agent_dispatch 完成编辑，只在跨区或全局操作无法合理委派时亲自使用编辑工具。单次 agent_dispatch 的 tasks 数组会同时启动多个独立 SubAgent 并行编辑同一个场景；无依赖的分区必须放在同一批，依赖任务在上一批返回后派发。每次分包 SubAgent 都清空上下文，所以任务包必须包含目标、完成标准、全局约束及前序任务结果。合法编辑立即生效，无审核、验收、回滚和统一提交队列。工具权限拒绝不等于验收。汇报必须依据工具返回的真实执行情况，包含失败与未完成。场景对象上的 regionId 是所属分区，__global__ 表示边界或未归属对象，仅总 Agent 可修改。不要向用户要求接受修改。当前分区：' + JSON.stringify(s.partition!.regions),
        [dispatch, ...specs], (name, a) => name === dispatch.name ? this.dispatch(s, signal, a) : this.execute(s, signal, name, a), s.sessionId, () => this.persist(s))
      this.current(s, signal); s.chat.push({ role: 'assistant', text: answer }); this.persist(s)
    } catch (e) {
      if (epoch === this.epoch) { s.chat.push({ role: 'note', text: message(e) }); this.persist(s); store.setState({ error: message(e) }) }
    } finally {
      if (epoch === this.epoch) {
        store.setState(state => ({ busy: false, progress: '', workers: state.workers.map(w => w.status === 'running' ? { ...w, status: 'stopped', detail: '已停止，已应用修改保留' } : w) }))
      }
      await this.saveChain; clearGeneratedResults(s.sessionId)
    }
  }
}
export const partitionAgent = new PartitionAgentRuntime()
