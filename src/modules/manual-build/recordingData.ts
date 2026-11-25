import type { EditCommand, EditSource } from '../../core/edit'
import type { ViewportPose } from '../../core/engine'
import type { ModelMeta, SceneAsset, SceneDocument, SceneLight, ViewBinding } from '../../core/types'

export const DEFAULT_ANALYSIS = { sampleHz: 10, width: 320, maxWidth: 1280, referenceCount: 6 }
export type Resources = Record<string, {
  modelId: string | null
  version: number | null
  manifestUrl?: string
  source?: ModelMeta['source']
}>

export interface Session {
  schemaVersion: 1
  sessionId: string
  sceneId: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  captureStatus: 'recording' | 'saved' | 'interrupted'
  analysisStatus: 'pending' | 'ready' | 'failed'
  unit: 'm'
  up: '+Y'
  resources: Resources
  resourcePaths: string[]
  analysis: typeof DEFAULT_ANALYSIS
}

export type Change = (
  | { objectType: 'model' | 'terrain' | 'shape' | 'group'; before: SceneAsset | null; after: SceneAsset | null
      terrainDelta?: TerrainDelta }
  | { objectType: 'light'; before: SceneLight | null; after: SceneLight | null }
) & {
  objectId: string
  action: EditCommand
  worldPositionBefore: SceneAsset['transform']['position'] | null
  worldPositionAfter: SceneAsset['transform']['position'] | null
}

export interface TerrainDelta {
  heights?: { size: [number, number]; changes: [index: number, delta: number][] }
  weights?: { size: [number, number]; changes: [index: number, delta: number][] }
  localBounds?: [[number, number], [number, number]]
}

export interface EditEvent {
  eventId: string
  seq: number
  tMs: number
  txId: number
  source: EditSource
  action: EditCommand | 'transaction' | 'undo' | 'redo'
  parameters: { label: string }
  revisionBefore: number
  revisionAfter: number
  changes: Change[]
}

export interface ViewportSample extends ViewportPose {
  sampleId: string
  seq: number
  tMs: number
  sceneRevision: number
  hiddenAssetIds?: string[]
  reason: 'start' | 'end' | 'before-edit' | 'after-edit' | 'camera' | 'resize' | 'view-settings'
}

export interface Visibility {
  sampleId: string
  sceneRevision: number
  objectId: string
  status: 'measured' | 'out_of_view' | 'unresolved' | 'not_applicable' | 'hidden' | 'resource_unavailable'
  visiblePixels: number | null
  projectedPixels: number | null
  screenOccupancy: number | null
  visibilityRatio: number | null
  rasterWidth?: number
  rasterHeight?: number
}

export interface Recording {
  session: Session
  initial: { document: SceneDocument; view: ViewBinding }
  edits: EditEvent[]
  samples: ViewportSample[]
  visibility: Visibility[]
}

export function modelResource(meta?: ModelMeta): Resources[string] {
  return { modelId: meta?.id ?? null, version: meta?.assetVersion ?? null, manifestUrl: meta?.manifestUrl, source: meta?.source }
}

export function applyEvent(doc: SceneDocument, event: EditEvent): SceneDocument {
  const assets = new Map(doc.assets.map(asset => [asset.id, asset]))
  const lights = new Map(doc.lights?.map(light => [light.id, light]))
  for (const change of event.changes) {
    if (change.objectType === 'light') {
      if (change.after) lights.set(change.objectId, change.after)
      else lights.delete(change.objectId)
    } else {
      if (change.after) assets.set(change.objectId, change.after)
      else assets.delete(change.objectId)
    }
  }
  const result = { ...doc, assets: [...assets.values()] }
  if (doc.lights || event.changes.some(change => change.objectType === 'light')) result.lights = [...lights.values()]
  return result
}

export function sceneAt(recording: Recording, revision: number): SceneDocument {
  let doc = recording.initial.document
  for (const event of recording.edits) {
    if (event.revisionAfter > revision) break
    doc = applyEvent(doc, event)
  }
  return doc
}

export async function recordingRequest<T>(sceneId: string, suffix = '', payload?: unknown): Promise<T> {
  const response = await fetch(`/api/recordings/${encodeURIComponent(sceneId)}${suffix}`, payload === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Layout-Client': '1' },
    body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || result === null) throw new Error(result?.error ?? `录制服务不可用（HTTP ${response.status}）`)
  return result as T
}

export async function exportRecording(recording: Recording): Promise<void> {
  const { strToU8, zipSync } = await import('three/addons/libs/fflate.module.js')
  const rows = (items: unknown[]) => strToU8(items.map(item => JSON.stringify(item) + '\n').join(''))
  const bytes = zipSync({
    'session.json': strToU8(JSON.stringify(recording.session, null, 2) + '\n'),
    'initial-scene.json': strToU8(JSON.stringify(recording.initial, null, 2) + '\n'),
    'edit-events.jsonl': rows(recording.edits),
    'viewport-samples.jsonl': rows(recording.samples),
    'object-visibility.jsonl': rows(recording.visibility),
  })
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/zip' }))
  const link = document.createElement('a')
  link.download = `${recording.session.sceneId}-${recording.session.sessionId}.zip`
  link.href = url
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
