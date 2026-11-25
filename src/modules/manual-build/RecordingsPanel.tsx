import { Canvas } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { LightInstance } from '../../components/LightInstance'
import { ViewRig } from '../../components/ViewRig'
import { useSceneStore } from '../../core/store'
import {
  queueAnalysis, retryRecordingSave, startRecording, stopRecording, useRecording,
} from './recording'
import { DEFAULT_ANALYSIS, exportRecording, recordingRequest, sceneAt, type EditEvent, type Recording, type Session, type ViewportSample } from './recordingData'
import { matchAsset, RecordedAssets, recordedCamera } from './visibility'

const formatTime = (ms = 0) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const formatPercent = (ratio: number | null | undefined) => ratio == null ? '—' : `${(ratio * 100).toFixed(1)}%`
const sessionLabel = (s: Session) => {
  if (s.captureStatus !== 'saved') return s.captureStatus === 'recording' ? '录制中' : '录制中断'
  return s.analysisStatus === 'ready' ? '可回放' : s.analysisStatus === 'failed' ? '分析失败' : '待分析'
}
const eventLabel = (event: EditEvent) => `${event.action === 'undo' ? '撤销 ' : event.action === 'redo' ? '重做 ' : ''}${event.parameters.label}`
const visibilityLabels = {
  measured: '', out_of_view: '出画', unresolved: '低分辨率下无法判定',
  not_applicable: '无自身几何', hidden: '已隐藏', resource_unavailable: '资源缺失或已变化',
}

export function RecordingsPanel() {
  const sceneId = useSceneStore(state => state.sceneId)
  const loading = useSceneStore(state => !state.document || state.loading)
  const { phase, elapsedMs, message, updated, jobs, progress, analysisError, autoAnalyze } = useRecording()
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<Session[]>([])
  const [replay, setReplay] = useState<Recording | null>(null)
  const [error, setError] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [config, setConfig] = useState({ ...DEFAULT_ANALYSIS })
  const job = jobs[0]
  useEffect(() => {
    if (!open || !sceneId) return
    let cancelled = false
    void recordingRequest<Session[]>(sceneId).then(
      result => { if (!cancelled) setSessions(result) },
      cause => { if (!cancelled) setError(cause.message) },
    )
    return () => { cancelled = true }
  }, [sceneId, updated, open])

  async function useSession(session: Session, action: 'play' | 'export' | 'analyze') {
    setRequesting(true)
    setError('')
    try {
      const data = await recordingRequest<Recording>(session.sceneId, `/${session.sessionId}`)
      if (!data.samples.length && action !== 'export') throw new Error('会话没有已保存的视口样本')
      if (action === 'play') setReplay(data)
      else if (action === 'analyze') queueAnalysis(data)
      else await exportRecording(data)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRequesting(false)
    }
  }

  return <section className="build-recordings">
    <div className="panel-label">会话录制</div>
    <div className="btn-grid g2">
      <button type="button" role="switch" aria-label="录制" aria-checked={phase === 'recording'}
        className={phase === 'recording' ? 'toggle on' : 'toggle'}
        disabled={loading || phase === 'saving' || phase === 'error'}
        onClick={() => phase === 'recording' ? stopRecording() : startRecording(config)}>
        {phase === 'recording' ? `停止录制 · ${formatTime(elapsedMs)}` : '开始录制'}
      </button>
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); setSessions([]); setError('') }}>录制会话</button>
    </div>
    <label className="build-checkbox" title="停止录制并保存后自动计算物体可见性">
      <input type="checkbox" role="switch" checked={autoAnalyze}
        onChange={event => useRecording.setState({ autoAnalyze: event.target.checked })} />
      计算可见性空间
    </label>
    {message && <div className="save-status" role="status">{message}</div>}
    {phase === 'error' && <button className="btn" onClick={() => void retryRecordingSave()}>重试保存录制</button>}
    {job && <div className="build-progress" role="status">
      正在计算物体可见性 <progress aria-label="可见性计算进度" max={1} value={progress} />
    </div>}
    {analysisError && <div className="error" role="alert">{analysisError}</div>}
    {open && <div className="build-session-list">
      {(phase === 'idle' || phase === 'error') && <details>
        <summary>录制参数</summary>
        <label>相机采样<select className="llm-input" value={config.sampleHz} onChange={e => setConfig({ ...config, sampleHz: Number(e.target.value) })}>
          {[5, 10, 15, 20].map(value => <option key={value} value={value}>{value} Hz</option>)}
        </select></label>
        <label>离屏宽度<select className="llm-input" value={config.width} onChange={e => setConfig({ ...config, width: Number(e.target.value) })}>
          {[160, 320, 640].map(value => <option key={value} value={value}>{value} px</option>)}
        </select></label>
        <label>初始场景参照物数量<select className="llm-input" value={config.referenceCount} onChange={e => setConfig({ ...config, referenceCount: Number(e.target.value) })}>
          {[0, 3, 6, 12].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </details>}
      {error && <div className="error" role="alert">{error}</div>}
      {sessions.filter(item => item.sceneId === sceneId).map(session => <div className="build-session" key={session.sessionId}>
        <strong>{new Date(session.startedAt).toLocaleString()}</strong>
        <small>{formatTime(session.durationMs)} · {sessionLabel(session)}</small>
        <div className="build-actions">
          <button className="btn" disabled={requesting || session.captureStatus === 'recording'} onClick={() => void useSession(session, 'play')}>回放</button>
          <button className="btn" disabled={requesting || session.captureStatus === 'recording'} onClick={() => void useSession(session, 'export')}>导出 ZIP</button>
          {session.captureStatus !== 'recording' && session.analysisStatus !== 'ready'
            && !jobs.some(item => item.session.sessionId === session.sessionId)
            && <button className="btn" disabled={requesting} onClick={() => void useSession(session, 'analyze')}>计算可见性</button>}
        </div>
      </div>)}
      {!sessions.some(item => item.sceneId === sceneId) && !error && <div className="inspector-empty">当前场景暂无已保存的会话</div>}
    </div>}
    {replay && replay.session.sceneId === sceneId && <Playback recording={replay} close={() => setReplay(null)} />}
  </section>
}

function Frame({ recording, sample, label }: { recording: Recording; sample: ViewportSample; label?: string }) {
  const doc = useMemo(() => sceneAt(recording, sample.sceneRevision), [recording, sample.sceneRevision])
  const camera = useMemo(() => recordedCamera(sample), [sample])
  const manifest = useSceneStore(state => state.manifest)
  const missing = doc.assets.filter(asset => !matchAsset(asset, recording, manifest))
  const aspectRatio = sample.width / sample.height
  return <figure className="build-frame">
    <figcaption>
      {label && <strong>{label} · </strong>}{(sample.tMs / 1000).toFixed(2)} s · 场景版本 {sample.sceneRevision}
      <span>相机 XYZ ({sample.position.map(value => value.toFixed(2)).join(', ')}) m</span>
    </figcaption>
    <div className="build-frame-view" style={{ aspectRatio, maxWidth: `${52 * aspectRatio}vh` }}>
      <Canvas camera={camera} shadows dpr={1}>
        <Suspense fallback={null}>
          <ViewRig env={doc.environment} view={recording.initial.view} />
          <RecordedAssets doc={doc} recording={recording} hiddenIds={sample.hiddenAssetIds} />
          {doc.lights?.map(light => <LightInstance key={light.id} light={light} showHelpers={false} />)}
        </Suspense>
      </Canvas>
    </div>
    {missing.length > 0 && <div className="error">资源缺失或版本已变化 · {missing.map(asset => asset.name ?? asset.ref).join('、')}</div>}
  </figure>
}

function Playback({ recording, close }: { recording: Recording; close: () => void }) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [event, selectEvent] = useState<EditEvent | null>(null)
  const { edits, samples, initial, visibility } = recording
  const frames = useMemo(() => new Map(samples.map((sample, i) => [sample.seq, i])), [samples])
  const objects = useMemo(() => {
    const names = new Map(initial.document.assets.map(asset => [asset.id, asset.name ?? asset.id]))
    for (const light of initial.document.lights ?? []) names.set(light.id, light.name ?? light.id)
    for (const item of edits) for (const change of item.changes) {
      const object = change.after ?? change.before
      names.set(change.objectId, object?.name ?? change.objectId)
    }
    return names
  }, [edits, initial])
  const bySample = useMemo(() => {
    const map = new Map<string, Map<string, Recording['visibility'][number]>>()
    for (const row of visibility) {
      if (!map.has(row.sampleId)) map.set(row.sampleId, new Map())
      map.get(row.sampleId)!.set(row.objectId, row)
    }
    return map
  }, [visibility])
  const current = samples[index]
  const beforeIndex = event ? frames.get(event.seq - 1) : undefined
  const before = beforeIndex === undefined ? undefined : samples[beforeIndex]
  const afterIndex = event ? frames.get(event.seq + 1) : undefined
  const after = afterIndex === undefined ? undefined : samples[afterIndex]
  const earlier = before && after ? bySample.get(before.sampleId) : undefined
  const later = bySample.get((after ?? current).sampleId)
  const objectIds = [...new Set([...(event?.changes.map(change => change.objectId) ?? []), ...(earlier?.keys() ?? []), ...(later?.keys() ?? [])])]
  useEffect(() => {
    if (!playing || index >= samples.length - 1) return
    const timeout = setTimeout(() => setIndex(index + 1), Math.max(16, samples[index + 1].tMs - current.tMs))
    return () => clearTimeout(timeout)
  }, [playing, index, current.tMs, samples])
  return <div className="modal-mask build-modal-mask" onClick={close}>
    <section className="modal build-replay" role="dialog" aria-modal="true" aria-label="搭建回放" onClick={event => event.stopPropagation()}>
      <header className="build-replay-head">
        <strong>搭建回放</strong>
        <span>{new Date(recording.session.startedAt).toLocaleString()}</span>
        <button className="btn" autoFocus onClick={close}>关闭</button>
      </header>
      <div className="build-replay-layout">
        <div className="build-event-list">
          <div className="panel-label">编辑事件</div>
          {!edits.length && <div className="inspector-empty">没有已提交的编辑</div>}
          {edits.map(item => <button className="btn" key={item.eventId} aria-pressed={event === item} onClick={() => {
            setPlaying(false)
            selectEvent(item)
            setIndex(frames.get(item.seq + 1) ?? frames.get(item.seq - 1) ?? 0)
          }}><small>{(item.tMs / 1000).toFixed(2)} s</small>{eventLabel(item)}</button>)}
        </div>
        <div className="build-replay-main">
          <div className="build-frame-grid">
            {before && after ? <>
              <Frame key="before" recording={recording} sample={before} label="编辑前" />
              <Frame key="after" recording={recording} sample={after} label="编辑后" />
            </> : <Frame key="current" recording={recording} sample={current} />}
          </div>
          <div className="build-timeline">
            <button className="btn" onClick={() => {
              selectEvent(null)
              if (index === samples.length - 1) { setIndex(0); setPlaying(true) } else setPlaying(!playing)
            }}>{playing && index < samples.length - 1 ? '暂停' : '播放'}</button>
            <input type="range" aria-label="回放时间线" min={0} max={samples.length - 1} value={index} onChange={e => {
              setPlaying(false); selectEvent(null); setIndex(Number(e.target.value))
            }} />
            <span>{formatTime(current.tMs)} / {formatTime(samples.at(-1)?.tMs)}</span>
          </div>
          <div className="build-visibility">
            <div className="panel-label">物体可见性</div>
            {!later && !earlier ? <div className="inspector-empty">此会话暂无物体可见性结果</div> : <table>
              <thead><tr><th>对象</th><th>画幅占比</th><th>可见比例</th><th>状态</th></tr></thead>
              <tbody>{objectIds.map(id => {
                const a = earlier?.get(id), b = later?.get(id)
                const values = (field: 'screenOccupancy' | 'visibilityRatio') =>
                  earlier ? `${formatPercent(a?.[field])} → ${formatPercent(b?.[field])}` : formatPercent(b?.[field])
                const status = (row: typeof b) => row ? visibilityLabels[row.status] || '已测量' : '未在场景中'
                return <tr key={id}><th scope="row">{objects.get(id) ?? id}</th>
                  <td>{values('screenOccupancy')}</td><td>{values('visibilityRatio')}</td>
                  <td>{earlier ? `${status(a)} → ${status(b)}` : status(b)}</td></tr>
              })}</tbody>
            </table>}
          </div>
        </div>
      </div>
    </section>
  </div>
}
