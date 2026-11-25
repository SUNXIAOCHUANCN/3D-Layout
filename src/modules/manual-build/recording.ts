import { create } from 'zustand'
import { edit } from '../../core/edit'
import { engine, type ViewportPose } from '../../core/engine'
import { bus } from '../../core/events'
import { useSceneStore } from '../../core/store'
import type { SceneAsset } from '../../core/types'
import { DEFAULT_ANALYSIS, modelResource, recordingRequest, type Change, type Recording, type TerrainDelta, type ViewportSample } from './recordingData'
import { heightAt } from '../terrain/surface'

interface Capture {
  data: Recording
  startTime: number
  startedOnServer: boolean
  revision: number
  seq: number
  sentEdits: number
  sentSamples: number
  sentResourceCount: number
  saving: Promise<void> | null
  interval: number
  unsubscribe: () => void
  nextSampleAt: number
}

export const useRecording = create<{
  phase: 'idle' | 'recording' | 'saving' | 'error'
  elapsedMs: number
  message: string
  updated: number
  jobs: Recording[]
  progress: number
  analysisError: string
  autoAnalyze: boolean
}>(() => ({ phase: 'idle', elapsedMs: 0, message: '', updated: 0, jobs: [], progress: 0, analysisError: '', autoAnalyze: false }))

let current: Capture | null = null
let unsaved: { capture: Capture; autoAnalyze: boolean } | null = null

function addResources(data: Recording, asset: SceneAsset) {
  if (!asset.terrain && !asset.group && !asset.shape) data.session.resources[asset.ref] ??= modelResource(useSceneStore.getState().manifest?.models[asset.ref])
  for (const material of asset.terrain?.surface?.materials ?? []) {
    for (const path of Object.values(material.maps ?? {})) {
      if (path && !data.session.resourcePaths.includes(path)) data.session.resourcePaths.push(path)
    }
  }
}

function terrainDelta(before: SceneAsset | null, after: SceneAsset | null): TerrainDelta | undefined {
  const a = before?.terrain, b = after?.terrain
  if (!a || !b || a === b) return undefined
  const result: TerrainDelta = {}
  const low = [Infinity, Infinity], high = [-Infinity, -Infinity]
  const difference = (next: number[], width: number, height: number, channels: number, previous: (index: number, x: number, z: number) => number) => {
    const changes: [number, number][] = []
    next.forEach((value, i) => {
      const sample = Math.floor(i / channels)
      const x = (sample % width / (width - 1) - 0.5) * b.width
      const z = (Math.floor(sample / width) / (height - 1) - 0.5) * b.depth
      const delta = value - previous(i, x, z)
      if (Math.abs(delta) < 1e-8) return
      changes.push([i, delta])
      low[0] = Math.min(low[0], x); low[1] = Math.min(low[1], z)
      high[0] = Math.max(high[0], x); high[1] = Math.max(high[1], z)
    })
    return changes.length ? { size: [width, height] as [number, number], changes } : undefined
  }
  if (a.heights !== b.heights) {
    const sameGrid = a.samplesX === b.samplesX && a.samplesZ === b.samplesZ && a.width === b.width && a.depth === b.depth
    result.heights = difference(b.heights, b.samplesX, b.samplesZ, 1, (index, x, z) => sameGrid ? a.heights[index] : heightAt(a, x, z))
  }
  const from = a.surface?.weightMap, to = b.surface?.weightMap
  if (from && to && from.data !== to.data && from.width === to.width && from.height === to.height) {
    result.weights = difference(to.data, to.width, to.height, 4, i => from.data[i])
  }
  if (!result.heights && !result.weights) return undefined
  result.localBounds = [[low[0], low[1]], [high[0], high[1]]]
  return result
}

function sample(capture: Capture, reason: ViewportSample['reason'], pose: ViewportPose, time = performance.now()) {
  const seq = ++capture.seq
  capture.data.samples.push({
    ...pose, sampleId: `v${seq}`, seq, tMs: time - capture.startTime, sceneRevision: capture.revision, reason,
    hiddenAssetIds: useSceneStore.getState().editorHiddenIds,
  })
}

export function sampleViewport(time: number, resized = false) {
  const capture = current
  if (!capture || (!resized && time < capture.nextSampleAt)) return
  capture.nextSampleAt = time + 1000 / capture.data.session.analysis.sampleHz
  const pose = engine.readViewport()
  if (!pose) return
  const previous = capture.data.samples.at(-1)
  const resize = !previous || previous.width !== pose.width || previous.height !== pose.height
  const viewSettings = previous?.hiddenAssetIds !== useSceneStore.getState().editorHiddenIds
  const changed = (a: number[], b?: number[]) => a.some((n, i) => Math.abs(n - (b?.[i] ?? Infinity)) > 1e-6)
  if (resize || viewSettings || changed(pose.position, previous?.position) || changed(pose.quaternion, previous?.quaternion)
    || changed(pose.projectionMatrix, previous?.projectionMatrix)) {
    sample(capture, resize ? 'resize' : viewSettings ? 'view-settings' : 'camera', pose, time)
  }
}

function flush(capture: Capture, finish?: { endedAt: string; durationMs: number }): Promise<void> {
  const send = async () => {
    const { data } = capture
    const url = `/${data.session.sessionId}`
    const { resources, resourcePaths } = data.session
    const resourceCount = Object.keys(resources).length + resourcePaths.length
    if (!capture.startedOnServer) {
      await recordingRequest(data.session.sceneId, url + '/start', { session: data.session, initial: data.initial })
      capture.startedOnServer = true
      capture.sentResourceCount = resourceCount
    }
    const edits = data.edits.slice(capture.sentEdits)
    const samples = data.samples.slice(capture.sentSamples)
    const resourceUpdate = finish || resourceCount !== capture.sentResourceCount ? { resources, resourcePaths } : {}
    const payload = { edits, samples, ...finish, ...resourceUpdate }
    await recordingRequest(data.session.sceneId, url + (finish ? '/finish' : '/batch'), payload)
    capture.sentEdits += edits.length
    capture.sentSamples += samples.length
    capture.sentResourceCount = resourceCount
  }
  if (capture.saving && !finish) return capture.saving
  const pending = (capture.saving?.catch(() => {}) ?? Promise.resolve()).then(send)
  capture.saving = pending
  const clear = () => { if (capture.saving === pending) capture.saving = null }
  void pending.then(clear, clear)
  return pending
}

export function startRecording(analysis = DEFAULT_ANALYSIS) {
  const { sceneId, document, view, loading } = useSceneStore.getState()
  const pose = engine.readViewport()
  if (current || unsaved || !sceneId || !document || loading || !edit.canBegin || !pose) return
  const hdri = view.environment?.hdri !== undefined ? view.environment.hdri : document.environment.hdri
  const data: Recording = {
    session: {
      schemaVersion: 1, sceneId, sessionId: crypto.randomUUID(), startedAt: new Date().toISOString(),
      captureStatus: 'recording', analysisStatus: 'pending', unit: 'm', up: '+Y', resources: {},
      resourcePaths: hdri ? [hdri] : [], analysis: { ...analysis },
    },
    initial: structuredClone({ document, view }), edits: [], samples: [], visibility: [],
  }
  for (const asset of document.assets) addResources(data, asset)
  const startTime = performance.now()
  const capture: Capture = {
    data, startTime, startedOnServer: false, revision: 0, seq: 0, sentEdits: 0, sentSamples: 0, sentResourceCount: 0,
    saving: null, interval: 0, unsubscribe: () => {}, nextSampleAt: startTime,
  }
  sample(capture, 'start', pose, startTime)
  capture.unsubscribe = bus.on('edit:applied', event => {
    const time = performance.now()
    const camera = engine.readViewport() ?? data.samples.at(-1)!
    sample(capture, 'before-edit', camera, time)
    const revisionBefore = capture.revision++
    const seq = ++capture.seq
    const changes: Change[] = event.entries.map(entry => {
      const beforeSide = event.direction === 'undo' ? 'after' : 'before'
      const afterSide = event.direction === 'undo' ? 'before' : 'after'
      if ('lightId' in entry) {
        const before = entry[beforeSide], after = entry[afterSide]
        return {
          objectType: 'light', objectId: entry.lightId, action: entry.cmd, before, after,
          worldPositionBefore: before?.position ?? null, worldPositionAfter: after?.position ?? null,
        }
      }
      const before = entry[beforeSide], after = entry[afterSide]
      if (before) addResources(data, before)
      if (after) addResources(data, after)
      return {
        objectType: before?.terrain || after?.terrain ? 'terrain' : before?.group || after?.group ? 'group'
          : after?.shape || !after && before?.shape ? 'shape' : 'model', objectId: entry.assetId, action: entry.cmd, before, after,
        worldPositionBefore: before?.transform.position ?? null, worldPositionAfter: after?.transform.position ?? null,
        terrainDelta: terrainDelta(before, after),
      }
    })
    data.edits.push({
      eventId: `e${seq}`, seq, tMs: time - startTime, txId: event.txId, source: event.source,
      action: event.direction === 'commit' ? (changes.length === 1 ? changes[0].action : 'transaction') : event.direction,
      parameters: { label: event.label }, revisionBefore, revisionAfter: capture.revision, changes,
    })
    sample(capture, 'after-edit', camera, time)
  })
  current = capture
  useRecording.setState({ phase: 'recording', elapsedMs: 0, message: '' })
  const persist = () => void flush(capture).then(
    () => { if (current === capture) useRecording.setState({ message: '' }) },
    error => { if (current === capture) useRecording.setState({ message: `录制暂未写入，将重试：${error.message}` }) },
  )
  let lastFlush = startTime
  capture.interval = window.setInterval(() => {
    const now = performance.now()
    useRecording.setState({ elapsedMs: now - startTime })
    if (now - lastFlush >= 1900) {
      lastFlush = now
      persist()
    }
  }, 500)
  persist()
}

export async function retryRecordingSave() {
  if (!unsaved || useRecording.getState().phase === 'saving') return
  const { capture, autoAnalyze } = unsaved
  const { session } = capture.data
  useRecording.setState({ phase: 'saving', message: '正在保存录制…' })
  try {
    await flush(capture, { endedAt: session.endedAt!, durationMs: session.durationMs! })
    session.captureStatus = 'saved'
    unsaved = null
    useRecording.setState(state => ({ phase: 'idle', message: '录制已保存', updated: state.updated + 1 }))
    if (autoAnalyze) queueAnalysis(capture.data)
  } catch (error) {
    useRecording.setState({ phase: 'error', message: `保存录制失败：${error instanceof Error ? error.message : error}` })
  }
}

export function stopRecording() {
  const capture = current
  if (!capture) return
  current = null
  const { session, samples } = capture.data
  const now = performance.now()
  sample(capture, 'end', engine.readViewport() ?? samples.at(-1)!, now)
  session.endedAt = new Date().toISOString()
  session.durationMs = now - capture.startTime
  capture.unsubscribe()
  window.clearInterval(capture.interval)
  unsaved = { capture, autoAnalyze: useRecording.getState().autoAnalyze }
  void retryRecordingSave()
}

bus.on('scene:will-change', stopRecording)

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const capture = current
    if (!capture?.startedOnServer || capture.saving) return
    const { sceneId, sessionId, resources, resourcePaths } = capture.data.session
    const body = JSON.stringify({
      edits: capture.data.edits.slice(capture.sentEdits),
      samples: capture.data.samples.slice(capture.sentSamples),
      resources, resourcePaths,
    })
    // The host lease marks the session as interrupted if the page disappears.
    if (new TextEncoder().encode(body).length > 60_000) return
    void fetch(`/api/recordings/${sceneId}/${sessionId}/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Layout-Client': '1' }, body, keepalive: true,
    }).catch(() => {})
  })
}

export function queueAnalysis(recording: Recording) {
  if (!recording.samples.length) return
  useRecording.setState(state => ({
    jobs: state.jobs.some(job => job.session.sessionId === recording.session.sessionId) ? state.jobs : [...state.jobs, recording],
    analysisError: '',
  }))
}

const VISIBILITY_BATCH_BYTES = 512 * 1024

export function createVisibilityUpload({ session: { sceneId, sessionId } }: Recording) {
  const uploadId = crypto.randomUUID()
  const encoder = new TextEncoder()
  let offset = 0
  let size = 0
  let lines: string[] = []
  async function post(status: 'chunk' | 'ready' | 'failed', payload?: string) {
    const send = () => recordingRequest(sceneId, `/${sessionId}/visibility`, { uploadId, status, offset, lines: payload })
    for (let attempt = 0; ; attempt++) {
      try { await send(); return }
      catch (error) {
        if (attempt === 2) throw error
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
  }
  async function flush() {
    if (!size) return
    await post('chunk', lines.join(''))
    offset += size
    lines = []
    size = 0
  }
  return {
    async append(rows: Recording['visibility']) {
      for (const row of rows) {
        const line = JSON.stringify(row) + '\n'
        const length = encoder.encode(line).length
        if (size && size + length > VISIBILITY_BATCH_BYTES) await flush()
        lines.push(line)
        size += length
      }
    },
    async complete() {
      await flush()
      await post('ready')
    },
    abort: () => post('failed'),
  }
}

export async function finishAnalysis(recording: Recording, upload: ReturnType<typeof createVisibilityUpload>, error?: string) {
  const { sessionId } = recording.session
  let message = error ?? ''
  try {
    if (error) await upload.abort()
    else await upload.complete()
  } catch (cause) {
    message ||= `可见性写入失败：${cause instanceof Error ? cause.message : cause}`
    if (!error) await upload.abort().catch(() => {})
  }
  useRecording.setState(state => ({
    jobs: state.jobs.filter(job => job.session.sessionId !== sessionId),
    updated: state.updated + 1,
    progress: 0,
    analysisError: message,
  }))
}
