/**
 * evidenceStore（W04，SPEC §3.2）——证据图片的唯一登记处。
 *
 * 职责：接收 CaptureFrame（Blob + 元数据），铸造不可变 observationId，登记图片并
 * 提供临时 URL；有内存/条目上限（§7.2），**接近上限时明确失败**而不是静默删掉判定
 * 仍需的证据；释放时撤销 objectURL（否则浏览器会一直占着像素）。
 *
 * 不碰 GPU、不碰 core：只认 Blob 与契约 DTO，因此能在 node 环境单测。
 */

import type {
  CaptureFrame,
  ImageId,
  Observation,
  ObservationPhase,
  ObjectId,
  RegionId,
  RunId,
  TaskId,
} from '../contracts'
import { CoAgentError } from '../contracts'
import { blobToDataUrl } from '../services/imageData'

export type EvidenceImage = {
  imageId: ImageId
  /** 原始 Blob：dataURL（判定/执行送模型）与 W09 导出都靠它；不复制像素 */
  blob: Blob
  /** 临时 URL；宿主不支持 createObjectURL 时为 null（导出仍可用 Blob） */
  url: string | null
  width: number
  height: number
  bytes: number
  kind: 'rgb' | 'marked'
}

export type EvidenceEntry = {
  observation: Observation
  rgb: EvidenceImage
  marked: EvidenceImage | null
  /** 本条目占用的图片字节数（rgb + marked） */
  bytes: number
  createdAt: number
}

export type EvidenceStoreStats = {
  entries: number
  bytes: number
  bytesCap: number
  entriesCap: number
  /** 仍存活的 objectURL 数（应等于 2×有 marked 的条目 + 1×其余） */
  urls: number
  runs: number
}

export type EvidenceStore = {
  add(frame: CaptureFrame, meta: CaptureMeta): Observation
  entry(observationId: string): EvidenceEntry | undefined
  observation(observationId: string): Observation | undefined
  urlFor(imageId: ImageId): string | null
  /** W08.2：按 imageId 取 dataURL（判定/执行送模型；不影响 objectURL 生命周期） */
  dataUrlFor(imageId: ImageId): Promise<string | null>
  release(observationId: string): boolean
  releaseRun(runId: RunId): number
  reset(): void
  stats(): EvidenceStoreStats
}

export type CaptureMeta = {
  runId: RunId
  taskId?: TaskId
  regionId?: RegionId
  phase: ObservationPhase
  partitionVersion: number
}

export interface EvidenceStoreOptions {
  maxBytes: number
  maxEntries: number
}

function makeUrl(blob: Blob): string | null {
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') return URL.createObjectURL(blob)
  } catch {
    /* 宿主不支持（或已被禁用）——导出仍可用 Blob，不算失败 */
  }
  return null
}

function revoke(url: string | null): void {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    /* ignore */
  }
}

export function createEvidenceStore(opts: EvidenceStoreOptions): EvidenceStore {
  const entries = new Map<string, EvidenceEntry>()
  const imageToObservation = new Map<ImageId, string>()
  let seq = 0
  let bytes = 0
  let urls = 0

  const entriesOfRun = (runId: RunId): string[] => {
    const out: string[] = []
    for (const [id, e] of entries) if (e.observation.runId === runId) out.push(id)
    return out
  }

  const drop = (observationId: string): boolean => {
    const e = entries.get(observationId)
    if (!e) return false
    if (e.rgb.url) {
      revoke(e.rgb.url)
      urls--
    }
    if (e.marked?.url) {
      revoke(e.marked.url)
      urls--
    }
    imageToObservation.delete(e.rgb.imageId)
    if (e.marked) imageToObservation.delete(e.marked.imageId)
    bytes -= e.bytes
    entries.delete(observationId)
    return true
  }

  return {
    add(frame: CaptureFrame, meta: CaptureMeta): Observation {
      const incoming = frame.rgbPng.size + (frame.markedPng?.size ?? 0)
      if (entries.size + 1 > opts.maxEntries) {
        throw new CoAgentError('budget_exceeded', `证据条目已达上限 ${opts.maxEntries}，拒绝继续登记（不静默淘汰旧证据）`, {
          details: { entries: entries.size, cap: opts.maxEntries },
        })
      }
      if (bytes + incoming > opts.maxBytes) {
        throw new CoAgentError('budget_exceeded', `证据图片内存将超过上限 ${Math.round(opts.maxBytes / 1024 / 1024)} MB（当前 ${Math.round(bytes / 1024 / 1024)} MB）`, {
          details: { bytes, incoming, cap: opts.maxBytes },
        })
      }

      const id = `obs-${meta.runId}-${++seq}`
      const observation: Observation = {
        schemaVersion: 1,
        id,
        runId: meta.runId,
        ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
        ...(meta.regionId !== undefined ? { regionId: meta.regionId } : {}),
        phase: meta.phase,
        sceneRevision: frame.sceneRevision,
        partitionVersion: meta.partitionVersion,
        camera: frame.camera,
        width: frame.width,
        height: frame.height,
        rgbImageId: `img-${id}`,
        ...(frame.markedPng ? { markedImageId: `img-${id}-marked` } : {}),
        labels: frame.labels.map(l => ({ ...l })),
        observedObjectFingerprints: { ...frame.observedObjectFingerprints },
        capturedAt: new Date().toISOString(),
      }

      const rgb: EvidenceImage = {
        imageId: observation.rgbImageId,
        blob: frame.rgbPng,
        url: makeUrl(frame.rgbPng),
        width: frame.width,
        height: frame.height,
        bytes: frame.rgbPng.size,
        kind: 'rgb',
      }
      const marked: EvidenceImage | null =
        frame.markedPng && observation.markedImageId
          ? {
              imageId: observation.markedImageId,
              blob: frame.markedPng,
              url: makeUrl(frame.markedPng),
              width: frame.width,
              height: frame.height,
              bytes: frame.markedPng.size,
              kind: 'marked',
            }
          : null
      if (rgb.url) urls++
      if (marked?.url) urls++

      entries.set(id, { observation, rgb, marked, bytes: incoming, createdAt: Date.now() })
      imageToObservation.set(rgb.imageId, id)
      if (marked) imageToObservation.set(marked.imageId, id)
      bytes += incoming
      return observation
    },

    entry: id => entries.get(id),
    observation: id => entries.get(id)?.observation,

    urlFor(imageId: ImageId): string | null {
      const owner = imageToObservation.get(imageId)
      if (!owner) return null
      const e = entries.get(owner)
      if (!e) return null
      return e.rgb.imageId === imageId ? e.rgb.url : (e.marked?.url ?? null)
    },

    async dataUrlFor(imageId: ImageId): Promise<string | null> {
      const owner = imageToObservation.get(imageId)
      if (!owner) return null
      const e = entries.get(owner)
      if (!e) return null
      const img = e.rgb.imageId === imageId ? e.rgb : e.marked?.imageId === imageId ? e.marked : null
      if (!img) return null
      return blobToDataUrl(img.blob)
    },

    release: id => drop(id),

    releaseRun(runId: RunId): number {
      const ids = entriesOfRun(runId)
      for (const id of ids) drop(id)
      return ids.length
    },

    reset(): void {
      for (const id of [...entries.keys()]) drop(id)
      seq = 0
    },

    stats(): EvidenceStoreStats {
      const runs = new Set([...entries.values()].map(e => e.observation.runId))
      return {
        entries: entries.size,
        bytes,
        bytesCap: opts.maxBytes,
        entriesCap: opts.maxEntries,
        urls,
        runs: runs.size,
      }
    },
  }
}

/** 便捷：观测里"可见"的对象 id（judge 只该对真正看见的对象下结论） */
export function visibleObjectIds(observation: Observation): ObjectId[] {
  return observation.labels.filter(l => l.visibility === 'visible').map(l => l.objectId)
}
