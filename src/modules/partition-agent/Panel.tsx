import { useEffect, useRef, useState } from 'react'
import { useSceneStore } from '../../core/store'
import { partitionAgent } from './runtime'
import { usePartitionAgentStore } from './store'
import { DEFAULT_PARTITION_CONFIG, partitionConfig } from './partitionWorkflow'
import { LlmSettingsModal } from './LlmSettingsModal'
import { GLOBAL, type PartitionConfig } from './types'
import './panel.css'

export function PartitionAgentPanel() {
  const { session, busy, loading, progress, error, workers, partitionPreview } = usePartitionAgentStore()
  const assets = useSceneStore(s => s.document?.assets)
  const [input, setInput] = useState('')
  const [settings, setSettings] = useState(false)
  const [draft, setDraft] = useState<PartitionConfig>(DEFAULT_PARTITION_CONFIG)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setDraft(partitionConfig(session?.partitionConfig))
  }, [session?.sessionId]) // Restore settings on scene/conversation changes, not each progress update.
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [session?.chat.length, busy])
  const act = (task: Promise<unknown>) => { void task.catch(e => usePartitionAgentStore.setState({ error: String(e) })) }
  const submit = () => { const text = input.trim(); if (!text || busy || !session) return; setInput(''); act(partitionAgent.send(text)) }
  return <div className="partition-agent-panel">
    <div className="pa-toolbar"><span className={`pa-status ${busy ? 'active' : ''}`}>{loading ? '加载会话中' : busy ? '正在协作' : '场景会话'}</span><button onClick={() => setSettings(true)}>模型设置</button></div>
    <p className="pa-muted">各区并行编辑 · 修改立即生效 · 对话随场景保存</p>
    <div className="pa-toolbar"><span className="pa-head">内置 LLM 分区</span><button disabled={busy || loading || !session} onClick={() => act(partitionAgent.preprocess())}>{session?.partition ? '重新分区' : '拍摄并分区'}</button></div>
    <p className="pa-muted">鸟瞰图 → 看图绘制与修订 → 边界平滑 → 分区预览</p>
    <details className="pa-regions"><summary>分区提示词与运行限制</summary>
      <p className="pa-muted">沿用“LLM分区”原工作流的提示词与默认配置。</p>
      <label className="pa-field">分区提示词<textarea aria-label="分区提示词" disabled={busy} value={draft.prompt_text} onChange={e => setDraft(v => ({ ...v, prompt_text: e.target.value }))} /></label>
      <label className="pa-field">最多模型调用轮数<input aria-label="分区最多轮数" type="number" min={1} max={50} disabled={busy} value={draft.max_rounds} onChange={e => setDraft(v => ({ ...v, max_rounds: Number(e.target.value) }))} /></label>
      <label className="pa-field">分区时间预算（秒）<input aria-label="分区时间预算" type="number" min={5} max={7200} disabled={busy} value={draft.max_duration_seconds} onChange={e => setDraft(v => ({ ...v, max_duration_seconds: Number(e.target.value) }))} /></label>
      <div className="pa-toolbar"><button disabled={busy || !session} onClick={() => act(Promise.resolve().then(() => partitionAgent.configurePartition(draft)))}>保存分区设置</button><button disabled={busy} onClick={() => setDraft({ ...DEFAULT_PARTITION_CONFIG })}>恢复原工作流配置</button></div>
    </details>
    {progress && <p className="pa-progress" role="status">{progress}</p>}
    {busy && partitionPreview && <img className="pa-live-preview" alt="正在绘制的分区" src={partitionPreview} />}
    {session?.partition && <details className="pa-regions" open><summary>分区与对象归属 · {session.partition.regions.length} 区</summary>
      {session.partition.preview && <img alt="场景分区预览" src={session.partition.preview} />}
      {session.partition.rawPreview && <details><summary>查看平滑前的分区</summary><img alt="平滑前的场景分区" src={session.partition.rawPreview} /></details>}
      {session.partition.stopReason && session.partition.stopReason !== 'model_finished' && <p className="pa-muted">达到运行限制，保留最后有效分区；模型尚未确认完成。</p>}
      {!!session.partition.drawingHistory?.length && <details><summary>分区绘制记录</summary>{session.partition.drawingHistory.map(h => <p key={h.round} className="pa-muted">第 {h.round} 轮 · {{ drawn: '已绘制', reviewed: '已确认', rejected: '修订反馈' }[h.status]}：{h.note}</p>)}</details>}
      {[...session.partition.regions.map(r => ({ id: r.id, name: r.name, design: r.design })), { id: GLOBAL, name: '全局／边界对象', design: '由总 Agent 协调' }].map(r => {
        const owned = assets?.filter(a => session.partition!.owners[a.id] === r.id) ?? []
        return <details key={r.id}><summary>{r.name}<span className="pa-count">{owned.length}</span></summary><p className="pa-muted">{r.design}</p>{owned.map(a => <div className="pa-object" key={a.id} title={a.id}>{a.name ?? a.id}</div>)}</details>
      })}
    </details>}
    {workers.length > 0 && <div className="pa-workers" aria-label="SubAgent 执行状态">{workers.map(w => <details key={w.id} open={w.status === 'running'}><summary>{session?.partition?.regions.find(r => r.id === w.regionId)?.name ?? w.regionId} · {{ running: '执行中', completed: '已结束', failed: '失败', stopped: '已停止' }[w.status]}</summary><p>{w.task}</p><p className="pa-muted">{w.detail}</p></details>)}</div>}
    <div className={`pa-chat${session?.chat.length ? '' : ' is-empty'}`} role="log" aria-label="场景总 Agent 对话">
      {!session?.chat.length && <p className="pa-empty">描述你的场景任务。总 Agent 会为相关区域分包，各区 Agent 同时执行。</p>}
      {session?.chat.map((m, i) => <div key={i} className={`pa-message ${m.role}`}><small>{m.role === 'user' ? '你' : m.role === 'assistant' ? '总 Agent' : '运行记录'}</small><div>{m.text}</div></div>)}
      <div ref={end} />
    </div>
    {error && <p className="pa-error" role="alert">{error}</p>}
    <textarea aria-label="场景任务" placeholder="例如：为各区域补充植被，并统一场景风格…" value={input} disabled={busy || loading || !session} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
    <div className="pa-toolbar"><button disabled={!session || loading} onClick={() => act(partitionAgent.clear())}>清除总 Agent 上下文</button>{busy ? <button onClick={() => partitionAgent.abort()}>停止</button> : <button className="pa-send" disabled={!input.trim() || !session || loading} onClick={submit}>发送任务</button>}</div>
    <p className="pa-muted">清除会停止当前任务，保留分区与已应用的场景修改。Enter 发送，Shift+Enter 换行。</p>
    {settings && <LlmSettingsModal onClose={() => setSettings(false)} />}
  </div>
}
