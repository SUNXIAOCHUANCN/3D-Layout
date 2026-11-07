import { randomUUID, createHash } from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { ApiError, sceneId } from './workspaces.mjs'
import { modelClientSource } from './model-source.mjs'

const terminal = new Set(['completed', 'cancelled', 'failed', 'conflict'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requireValue = (value, message) => { if (!value) throw new ApiError(400, message) }
const workflowRules = '\n状态规则：变更前确认模式下，写工具只修改待确认提案，未接受前不得声称已保存、已入账或已提交；最终应说明“提案已准备好，等待你接受”。自动模式也由程序确认保存。修改后优先用 scene_check_overlaps 对修改物体做疑似重叠检查；包围盒仅为粗筛，截图或拾取都不能证明无穿模。用户局部修改意见默认保留当前草稿，只修正相关部分；只有明确要求回滚时才从基线重做。'
const originalRules = '\n执行方式：每批写工具完成后等待用户裁决，接受后继续模型循环，拒绝只撤销本批修改。保存成功由程序确认。'
const serviceFailure = task => /模型服务返回流式错误|data_inspection_failed/.test(task.error ?? '')
const retryable = task => task.status === 'paused' || task.status === 'failed' && (task.modelRequests?.at(-1)?.status === 'timed_out' || serviceFailure(task))
function initialTurns(chat, text, revision, count) {
  const users = chat.filter(message => message.role === 'user').map(message => message.text)
  if (users.at(-1) === text) users.pop()
  const intent = users.slice(-6).map(value => value.slice(0, 400)).join('\n')
  return [
    ...(intent ? [{ role: 'user', text: `[历史用户意见，仅供参考，不代表本轮新指令或已执行]\n${intent}` }] : []),
    { role: 'user', text: `${text}\n\n[当前任务状态：正式场景版本 ${revision}，物体 ${count} 个。先重新读取当前场景。旧工具结果和未接受草稿不作为当前状态。]` },
  ]
}
// Older conversations may contain the entire catalogue. Keep only scene references.
function compactCatalogues(turns) {
  for (const turn of turns) if (turn.role === 'toolResults') for (const result of turn.results) {
    const content = result.content
    if (!Array.isArray(content?.assets) || !content.manifest || typeof content.manifest !== 'object') continue
    const refs = new Set(content.assets.map(asset => asset.ref))
    content.manifest = Object.fromEntries(Object.entries(content.manifest).filter(([ref]) => refs.has(ref)))
    content.modelLibrary = { searchTool: 'model.search', note: '目录已精简为当前场景引用；其他模型请按关键词检索。' }
  }
}
let modelClient
async function model(options) {
  // Reuse the existing three-protocol streaming adapter without browser imports.
  // 服务端没有 CORS，OpenCode Go 直连上游，不走浏览器的本机转发。
  globalThis.__LAYOUT_NO_RELAY__ = true
  modelClient ??= import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(
    modelClientSource('llm-agent'),
  )).toString('base64'))
  return (await modelClient).llmChat(options)
}

/** The durable scheduler owns model requests; browsers only execute leased tools. */
export class TaskService {
  constructor(repository, requestModel = model, options = {}) {
    const configured = options.modelTimeoutMs ?? (process.env.LAYOUT_MODEL_TIMEOUT_MS === undefined ? undefined : Number(process.env.LAYOUT_MODEL_TIMEOUT_MS))
    requireValue(configured === undefined || Number.isFinite(configured) && configured >= 0, '模型超时时间必须为非负数')
    this.modelTimeoutMs = configured ?? 180000
    this.originalTimeoutMs = configured ?? 0
    this.repository = repository
    this.requestModel = requestModel
    this.secrets = new Map()
    this.running = new Map()
    this.waiters = new Map()
    this.closed = false
    repository.db.exec(`CREATE TABLE IF NOT EXISTS ai_tasks (
      id TEXT PRIMARY KEY, scene_id TEXT NOT NULL, channel TEXT NOT NULL,
      state TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_tasks_scene ON ai_tasks(scene_id,channel,updated_at);`)
    for (const row of repository.db.prepare('SELECT state FROM ai_tasks').all()) {
      const task = JSON.parse(row.state)
      if (task.commitPending) {
        try {
          const saved = repository.commit(task.sceneId, task.commitPending)
          task.base = task.commitPending.workspace;task.baseRevision = saved.revision
          if (task.workflow === 'original') task.acceptedRound = task.round
          delete task.commitPending;task.status = task.finishedModel ? 'completed' : 'awaiting_credentials'
          this.save(task)
        } catch (error) { task.status = 'conflict';task.error = error.message;this.save(task) }
      }
      if (task.workflow === 'original' && task.pendingDecision && task.acceptedRound === task.pendingDecision.round) this.finishBatch(task, 'accepted')
      if (!terminal.has(task.status)) {
        task.resumeStatus = task.status === 'awaiting_credentials' ? task.resumeStatus : task.status
        task.status = 'awaiting_credentials'; task.owner = null; this.save(task)
      }
    }
  }
  save(task) {
    task.updatedAt = new Date().toISOString()
    this.repository.db.prepare('INSERT INTO ai_tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at')
      .run(task.id, task.sceneId, task.channel, JSON.stringify(task), task.updatedAt)
  }
  get(id) {
    const row = this.repository.db.prepare('SELECT state FROM ai_tasks WHERE id=?').get(id)
    if (!row) throw new ApiError(404, '任务不存在')
    return JSON.parse(row.state)
  }
  latest(scene, channel) {
    sceneId(scene)
    const row = this.repository.db.prepare("SELECT state FROM ai_tasks WHERE scene_id=? AND channel=? AND COALESCE(json_extract(state,'$.conversationCleared'),0)=0 ORDER BY updated_at DESC LIMIT 1").get(scene, channel)
    return row ? JSON.parse(row.state) : null
  }
  clearConversation(id) {
    const task = this.get(id)
    const tasks = this.repository.db.prepare('SELECT state FROM ai_tasks WHERE scene_id=? AND channel=?').all(task.sceneId, task.channel)
    if (retryable(task) || tasks.some(row => !terminal.has(JSON.parse(row.state).status))) {
      throw new ApiError(409, '请先停止当前任务，再清除对话')
    }
    // Archive the conversation atomically; keep task receipts for diagnostics.
    this.repository.db.prepare("UPDATE ai_tasks SET state=json_set(state,'$.conversationCleared',1) WHERE scene_id=? AND channel=?").run(task.sceneId, task.channel)
    return { cleared: true }
  }
  public(task) {
    if (!task) return null
    const { base, tools, system, settings, turns, commitPending, ...view } = task
    return { ...view, retryable: retryable(task), pauseReason: serviceFailure(task) ? 'service_error' : task.pauseReason, before: base.document }
  }
  create(input) {
    requireValue(input && ['agent', 'llm-agent'].includes(input.channel), '非法任务通道')
    sceneId(input.sceneId)
    requireValue(typeof input.text === 'string' && input.text.trim() && input.text.length <= 100000, '任务指令为空或过长')
    requireValue(input.settings && typeof input.settings.apiKey === 'string' && typeof input.settings.baseURL === 'string', '缺少模型连接配置')
    requireValue(Array.isArray(input.tools) && input.tools.length <= 100 && typeof input.system === 'string', '非法工具配置')
    const active = this.repository.db.prepare('SELECT state FROM ai_tasks WHERE scene_id=?').all(input.sceneId).map(row => JSON.parse(row.state)).find(t => !terminal.has(t.status))
    if (active) throw new ApiError(409, '此场景已有未完成 AI 任务，请重连或取消该任务')
    const base = this.repository.get(input.sceneId)
    const previous = input.reset ? null : this.latest(input.sceneId, input.channel)
    const { apiKey, ...settings } = input.settings
    const workflow = input.workflow === 'original' ? 'original' : 'proposal'
    const turns = workflow === 'original'
      ? [...structuredClone(previous?.workflow === 'original' ? previous.turns : []), { role: 'user', text: input.text }]
      : initialTurns(previous?.chat ?? [], input.text, base.revision, base.workspace.document.assets.length)
    const task = {
      id: randomUUID(), sceneId: input.sceneId, channel: input.channel, status: 'running',
      text: input.text, settings, workflow, features: input.features ?? {}, system: input.system + (workflow === 'original' ? originalRules : workflowRules), tools: input.tools,
      baseRevision: base.revision, base: base.workspace, draft: base.workspace.document,
      turns,
      chat: [...(previous?.chat ?? []), { role: 'note', text: `新任务 · ${input.text} · 从当前正式场景开始，历史调用不计入本轮。` }, { role: 'user', text: input.text }],
      calls: [], batch: null, round: 0, permissionMode: input.permissionMode === 'auto' ? 'auto' : 'confirm',
      owner: null, leaseUntil: 0, epoch: 0, createdAt: new Date().toISOString(),
    }
    this.secrets.set(task.id, apiKey); this.save(task); this.start(task.id)
    return this.public(task)
  }
  attach(id, owner, apiKey) {
    requireValue(typeof owner === 'string' && owner.length <= 100, '缺少浏览器身份')
    const t = this.get(id)
    if (t.owner && t.owner !== owner && t.leaseUntil > Date.now()) throw new ApiError(409, '任务正在另一页面连接，请稍后重试')
    if (t.owner !== owner) { t.epoch++; t.owner = owner }
    t.leaseUntil = Date.now() + 8000
    if (t.status === 'awaiting_credentials') {
      requireValue(typeof apiKey === 'string' && apiKey.length > 0, '服务重启后需要重新提供模型密钥')
      this.secrets.set(id, apiKey)
      t.status = t.resumeStatus ?? (t.batch ? 'awaiting_browser' : 'running')
      delete t.resumeStatus
    }
    this.save(t); this.start(id)
    return this.public(t)
  }
  result(id, input) {
    const t = this.get(id)
    const call = t.calls.find(c => c.id === input.callId)
    requireValue(call, '工具调用不存在')
    const digest = hash([input.result, input.document])
    if (call.result) {
      if (call.digest !== digest) throw new ApiError(409, '同一工具结果内容不一致')
      return this.public(t)
    }
    if (t.owner !== input.owner || t.epoch !== input.epoch || t.leaseUntil < Date.now()) throw new ApiError(409, '工具租约已失效，请重新连接')
    if (terminal.has(t.status)) throw new ApiError(409, '任务已结束')
    requireValue(input.result && typeof input.result.ok === 'boolean' && input.document?.meta?.id === t.sceneId, '非法工具结果或草稿')
    // Draft and receipt share one SQLite row update; the model never sees half a checkpoint.
    t.draft = input.document
    call.result = input.result; call.digest = digest; call.finishedAt = new Date().toISOString()
    t.chat.push({ role: 'note', text: `${call.result.ok ? '✓' : '✗'} ${call.name}${call.result.error ? `：${call.result.error}` : ''}` })
    t.status = 'running'; this.save(t); this.wake(id)
    return this.public(t)
  }
  renewLease(id, owner, epoch) {
    const t = this.get(id)
    if (terminal.has(t.status)) throw new ApiError(409, '任务已结束')
    if (t.owner !== owner || t.epoch !== epoch) throw new ApiError(409, '任务已由其他页面接管，请重新连接')
    // An expired owner can renew only while no newer epoch has taken over.
    t.leaseUntil = Date.now() + 8000
    this.save(t)
    return { epoch: t.epoch, leaseUntil: t.leaseUntil }
  }
  verdict(id, input) {
    const t = this.get(id)
    if (terminal.has(t.status)) return this.public(t)
    requireValue(t.status === 'awaiting_user', '任务尚未等待裁决')
    requireValue(['accepted', 'rejected', 'revised'].includes(input.verdict), '非法裁决')
    if (input.reviewVersion !== undefined && input.reviewVersion !== (t.reviewVersion ?? 0)) throw new ApiError(409, '提案已更新，请重新确认当前方案')
    requireValue(input.reason === undefined || typeof input.reason === 'string' && input.reason.length <= 4000, '拒绝原因须为不超过 4000 字的文本')
    if (t.workflow === 'original' && t.pendingDecision && input.verdict !== 'revised') {
      if (input.verdict === 'accepted') this.commitDraft(t)
      this.finishBatch(t, input.verdict, input.reason)
      this.wake(id)
      return this.public(t)
    }
    if (input.verdict === 'accepted') this.commitDraft(t)
    else {
      const reason = input.reason?.trim() || '用户未填写具体原因，请重新检查需求并调整方案，避免重复原方案。'
      const rollback = input.verdict === 'rejected'
      if (t.workflow === 'original') t.pendingDecision = null
      if (rollback) t.draft = structuredClone(t.base.document)
      t.reviewVersion = (t.reviewVersion ?? 0) + 1
      t.finishedModel = false;t.batch = null;t.streamingText = ''
      delete t.commitTime
      const feedback = rollback
        ? `用户拒绝了本次提案，所有预览修改已回滚到任务基线。原因：${reason}。请先重新读取当前场景，再调整方案继续编辑；不要重复原方案。`
        : `用户希望在当前提案上继续局部修改，草稿和物体 ID 均已保留，未回滚。修改意见：${reason}。先读取当前草稿，仅修正相关物体，保留其他满意部分；不要重新添加已有物体。需要排查重叠时优先调用 scene_check_overlaps，截图仅辅助判断。`
      t.turns.push({ role: 'user', text: feedback })
      t.chat.push({ role: 'user', text: input.reason?.trim() || (rollback ? '回滚本次提案，请继续调整。' : '保留当前提案，请继续调整。') })
      t.chat.push({ role: 'note', text: rollback ? '本次提案已回滚，AI 将根据你的意见继续修改。' : '当前提案已保留，AI 将根据你的意见局部调整。' })
      t.status = 'running';this.save(t);this.wake(id)
      return this.public(t)
    }
    t.chat.push({ role: 'note', text: '编辑已接受并保存' })
    t.status = 'completed'; this.save(t); this.wake(id)
    return this.public(t)
  }
  finishBatch(t, verdict, reason) {
    const final = t.pendingDecision?.final === true
    const accepted = verdict === 'accepted'
    if (!accepted) t.draft = structuredClone(t.base.document)
    const message = accepted ? '[系统] 用户接受了本批提案，改动已生效并保存，请继续。'
      : `[系统] 用户拒绝了本批提案，本批修改已回滚，之前接受的改动保留。${reason?.trim() ? `原因：${reason.trim()}。` : ''}请调整方案后继续。`
    t.turns.push({ role: 'user', text: message })
    if (reason?.trim()) t.chat.push({ role: 'user', text: reason.trim() })
    t.chat.push({ role: 'note', text: accepted ? '本批修改已接受并保存，AI 继续处理。' : '本批修改已回滚，之前接受的修改保留，AI 继续调整。' })
    t.pendingDecision = null;t.reviewVersion = (t.reviewVersion ?? 0) + 1
    delete t.commitTime
    t.status = final && accepted ? 'completed' : 'running'
    this.save(t)
  }
  commitDraft(t) {
    if (!t.commitTime) { t.commitTime = Date.now();this.save(t) }
    const state = structuredClone(t.base)
    const before = new Map(state.document.assets.map(a => [a.id, a]))
    const after = new Map(t.draft.assets.map(a => [a.id, a]))
    const txId = ++state.txCounter
    const entries = []
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(id) ?? null, b = after.get(id) ?? null
      if (!isDeepStrictEqual(a,b)) entries.push({ cmd: a === null ? 'add_asset' : b === null ? 'remove_asset' : 'set_transform', assetId: id, before: a, after: b, source: 'agent', txId, label: t.text.slice(0,100), time: t.commitTime })
    }
    state.document = structuredClone(t.draft)
    if (entries.length) { state.journal.push({ txId, label: t.text.slice(0,100), source: 'agent', entries }); state.redoStack = [] }
    const requestId = `ai-${t.id}-${t.round}`
    // Nested savepoint is avoided: repository commit owns its transaction. Its requestId
    // makes recovery after a process crash between commit and task save idempotent.
    t.commitPending = { requestId, baseRevision: t.baseRevision, workspace: state, label: `AI：${t.text.slice(0,80)}` }
    this.save(t)
    const result = this.repository.commit(t.sceneId, t.commitPending)
    t.baseRevision = result.revision; t.base = state
    if (t.workflow === 'original') t.acceptedRound = t.round
    delete t.commitPending
    this.save(t)
  }
  cancel(id) {
    const t = this.get(id)
    if (!terminal.has(t.status) || retryable(t)) { t.status = 'cancelled'; this.save(t); this.running.get(id)?.abort(); this.wake(id) }
    return this.public(t)
  }
  retry(id, input) {
    const t = this.get(id)
    requireValue(typeof input.requestId === 'string' && input.requestId.length <= 100, '缺少重试编号')
    if (t.retryRequestId === input.requestId) return this.public(t)
    if (!retryable(t)) throw new ApiError(409, '任务未处于可重试的暂停状态')
    const competing = this.repository.db.prepare('SELECT state FROM ai_tasks WHERE scene_id=? AND id<>?').all(t.sceneId, id)
      .some(row => !terminal.has(JSON.parse(row.state).status))
    if (competing) throw new ApiError(409, '此场景已有其他未完成任务，不能同时恢复旧提案')
    if (this.repository.get(t.sceneId).revision !== t.baseRevision) throw new ApiError(409, '正式场景已变更，无法安全恢复旧提案')
    const apiKey = input.settings?.apiKey ?? input.apiKey
    requireValue(typeof apiKey === 'string' && apiKey.length > 0, '重试需要模型密钥')
    if (input.settings !== undefined) {
      const next = input.settings
      requireValue(['openai-chat', 'openai-response', 'anthropic'].includes(next.protocol) &&
        typeof next.model === 'string' && next.model.trim() && typeof next.baseURL === 'string' && /^https?:\/\//.test(next.baseURL), '模型配置不完整')
      const { apiKey: _key, ...settings } = next
      const changed = ['model', 'baseURL', 'protocol'].some(key => settings[key] !== t.settings[key])
      if (changed) t.chat.push({ role: 'note', text: `本轮改用模型 ${settings.model}；保留当前提案和已完成工具结果。` })
      t.settings = settings
    }
    if (input.tools !== undefined) {
      requireValue(Array.isArray(input.tools) && input.tools.length <= 100 && typeof input.system === 'string', '非法工具配置')
      t.tools = input.tools;t.system = input.system + (t.workflow === 'original' ? originalRules : workflowRules)
    }
    const currentImages = new Set(t.calls.filter(call => call.name === 'viewport.screenshot').map(call => call.modelId))
    for (const turn of t.turns) {
      delete turn.images
      if (turn.role === 'toolResults') for (const result of turn.results) if (!t.settings.sendImages || !currentImages.has(result.callId)) delete result.images
    }
    if (t.workflow !== 'original' && !t.calls.length && t.round === 0) t.turns = initialTurns(t.chat, t.text, t.baseRevision, t.base.document.assets.length)
    t.status = 'running';t.streamingText = '';t.retryRequestId = input.requestId;delete t.error
    // Keep the same turns, draft, completed calls and stable IDs; retry inference only.
    t.chat.push({ role: 'note', text: '正在重试本轮模型请求；当前提案和已完成工具结果已保留。' })
    this.secrets.set(id, apiKey);this.save(t);this.start(id)
    return this.public(t)
  }
  wake(id) { this.waiters.get(id)?.(); this.waiters.delete(id) }
  async wait(id, signal) {
    if (signal.aborted) return
    await new Promise(resolve => {
      const done = () => { signal.removeEventListener('abort', done);resolve() }
      this.waiters.set(id, done);signal.addEventListener('abort', done, { once: true })
    })
  }
  start(id) {
    if (this.closed || this.running.has(id) || !this.secrets.has(id) || retryable(this.get(id))) return
    const controller = new AbortController();this.running.set(id, controller)
    void this.run(id, controller.signal).catch(error => {
      if (this.closed) return
      const t = this.get(id)
      if (!terminal.has(t.status)) {
        t.status = ['MODEL_TIMEOUT', 'MODEL_EMPTY_RESPONSE', 'MODEL_SERVICE_ERROR'].includes(error.code) ? 'paused' : error.status === 409 ? 'conflict' : 'failed'
        t.pauseReason = error.code === 'MODEL_SERVICE_ERROR' ? 'service_error' : error.code === 'MODEL_EMPTY_RESPONSE' ? 'empty_response' : 'timeout'
        t.error = String(error.message).replaceAll(this.secrets.get(id) ?? '\0', '[redacted]');t.streamingText = '';this.save(t)
      }
    }).finally(() => {
      this.running.delete(id)
      if (!this.closed && this.get(id).status === 'running' && this.secrets.has(id)) this.start(id)
      else this.secrets.delete(id)
    })
  }
  async infer(t, signal) {
    if (t.workflow !== 'original' || t.features?.modelSearch) compactCatalogues(t.turns)
    const requests = t.modelRequests ??= []
    const timeoutMs = t.workflow === 'original' ? this.originalTimeoutMs : this.modelTimeoutMs
    const stats = { index: requests.length + 1, startedAt: new Date().toISOString(), timeoutMs,
      contextChars: JSON.stringify(t.turns).length, status: 'running' }
    requests.push(stats);this.save(t)
    const controller = new AbortController()
    let timer, rejectStopped
    const stopped = new Promise((_, reject) => { rejectStopped = reject })
    const abort = () => { controller.abort();rejectStopped(new Error('模型请求已停止')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    if (timeoutMs > 0) timer = setTimeout(() => {
      rejectStopped(Object.assign(new Error(`第 ${stats.index} 轮模型请求超过 ${Math.round(timeoutMs / 1000)} 秒，已暂停；当前提案与工具结果已保留，可点击“重试本轮”。`), { code: 'MODEL_TIMEOUT' }))
      controller.abort()
    }, timeoutMs)
    let lastStreamSave = 0, partial = ''
    try {
      const response = await Promise.race([stopped, Promise.resolve().then(() => this.requestModel({
        settings: { ...t.settings, apiKey: this.secrets.get(t.id) }, system: t.system, turns: t.turns,
        // 稳定的会话标识：OpenCode Go 用它做路由，重试/重连沿用同一个任务 ID。
        sessionId: t.id,
        tools: t.tools.map(tool => ({ ...tool, name: tool.name.replaceAll('.', '_') })), signal: controller.signal,
        onEvent: event => {
          if (this.closed || controller.signal.aborted) return
          const now = new Date().toISOString()
          if (event.type === 'activity') {
            stats.activity = event.stage;stats.lastActivityAt = now
            if (event.stage === 'connected') stats.connectedAt = now
          } else if (event.type === 'text') {
            partial += event.delta
            if (!stats.firstTextAt) stats.firstTextAt = now
            stats.activity = 'text';stats.lastActivityAt = now
          } else return
          if (Date.now() - lastStreamSave < 200) return
          const current = this.get(t.id)
          if (terminal.has(current.status)) return
          current.modelRequests[stats.index - 1] = { ...stats }
          current.streamingText = partial;this.save(current);lastStreamSave = Date.now()
        },
      }))])
      if (!response.text?.trim() && !response.toolCalls.length) {
        throw Object.assign(new Error('模型返回了空回复，未产生新的工具调用或修改。当前草稿已保留，请检查模型服务后重试本轮。'), { code: 'MODEL_EMPTY_RESPONSE' })
      }
      stats.status = 'completed'
      return response
    } catch (error) {
      stats.status = error.code === 'MODEL_TIMEOUT' ? 'timed_out' : signal.aborted ? 'cancelled' : 'failed'
      if (error.providerCode) stats.providerCode = error.providerCode
      throw error
    } finally {
      clearTimeout(timer);controller.abort();signal.removeEventListener('abort', abort)
      if (!this.closed) {
        const current = this.get(t.id)
        stats.finishedAt = new Date().toISOString();stats.durationMs = Date.now() - Date.parse(stats.startedAt)
        current.modelRequests[stats.index - 1] = stats
        current.chat.push({ role: 'note', text: `第 ${stats.index} 轮模型请求 · ${(stats.durationMs / 1000).toFixed(1)} 秒${stats.status === 'timed_out' ? ' · 超时' : stats.status === 'completed' ? ' · 完成' : ' · 已停止或失败'}` })
        this.save(current)
      }
    }
  }
  async run(id, signal) {
    for (;;) {
      let t = this.get(id)
      if (terminal.has(t.status) || signal.aborted) return
      if (t.status === 'awaiting_user' || t.status === 'paused') { await this.wait(id, signal);continue }
      if (!t.batch) {
        if (t.workflow === 'original' && (t.completedRounds ?? 0) >= 24) {
          t.chat.push({ role: 'note', text: '已达单条指令 24 轮上限，可继续输入以延续对话。' })
          t.status = 'completed';this.save(t);return
        }
        t.status = 'running';t.streamingText = '';this.save(t)
        const response = await this.infer(t, signal)
        t = this.get(id)
        t.streamingText = ''
        if (terminal.has(t.status) || signal.aborted) return
        t.completedRounds = (t.completedRounds ?? 0) + 1
        t.turns.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls })
        if (response.text) t.chat.push({ role: 'assistant', text: response.text })
        if (!response.toolCalls.length) {
          t.finishedModel = true
          if (!isDeepStrictEqual(t.draft, t.base.document)) {
            if (t.permissionMode === 'auto') this.commitDraft(t)
            else {
              if (t.workflow === 'original') t.pendingDecision = { round: t.round, final: true }
              t.chat.push({ role: 'note', text: '提案已准备好，等待你接受。尚未保存；也可填写意见继续局部调整。' })
              t.status = 'awaiting_user';t.finishedModel = true;this.save(t);continue
            }
          }
          if (isDeepStrictEqual(t.draft, t.base.document) && !t.commitTime) t.chat.push({ role: 'note', text: '本轮未产生场景修改；历史对话中的工具调用不代表当前场景已改变。' })
          if (t.permissionMode === 'auto' && t.commitTime) t.chat.push({ role: 'note', text: '自动编辑已由程序提交并保存。' })
          t.status = 'completed';this.save(t);return
        }
        t.round++
        t.batch = response.toolCalls.map((c,index) => {
          const spec = t.tools.find(tool => tool.name.replaceAll('.', '_') === c.name || tool.name === c.name)
          return { id: `${id}-${t.round}-${index}`, modelId: c.id, name: spec?.name ?? c.name, args: c.args, access: spec?.access ?? 'unknown' }
        })
        t.calls.push(...t.batch.map(c => ({ ...c, issuedAt: new Date().toISOString() })));this.save(t)
      }
      const next = t.batch.map(c => t.calls.find(x => x.id === c.id)).find(c => !c.result)
      if (next) {
        if (next.access === 'unknown') { next.result = { ok: false, error: '未授权工具' };this.save(t);continue }
        t.status = 'awaiting_browser';this.save(t);await this.wait(id, signal);continue
      }
      const results = t.batch.map(c => {
        const r = t.calls.find(x => x.id === c.id).result
        let content = r.ok ? r.data : { error: r.error }, images
        if (c.name === 'viewport.screenshot' && r.ok && content?.image) {
          const { image, ...metadata } = content;content = metadata
          if (t.settings.sendImages) images = [{ dataUrl: image }]
        }
        return { callId: c.modelId, ok: r.ok, content, ...(images ? { images } : {}) }
      })
      if (results.some(result => result.images?.length)) {
        for (const turn of t.turns) if (turn.role === 'toolResults') for (const result of turn.results) delete result.images
      }
      const hasWrites = t.batch.some(call => call.access === 'write')
      t.turns.push({ role: 'toolResults', results });t.batch = null
      if (t.workflow === 'original' && hasWrites) {
        t.pendingDecision = { round: t.round };t.finishedModel = false
        if (t.permissionMode === 'auto') { this.commitDraft(t);this.finishBatch(t, 'accepted') }
        else { t.status = 'awaiting_user';t.chat.push({ role: 'note', text: '本批修改等待裁决；接受后保存并继续，拒绝仅回滚本批。' });this.save(t) }
      } else this.save(t)
    }
  }
  close() { this.closed = true;for (const controller of this.running.values()) controller.abort();this.secrets.clear() }
}
