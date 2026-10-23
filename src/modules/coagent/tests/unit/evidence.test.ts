/**
 * 证据与观测（W04）单测：evidenceStore 的铸号/上限/释放，observations 的
 * ready→捕获→登记口径，以及"桥未挂载 / 取消 / 容量超限"三类显式失败。
 *
 * 真实像素路径在浏览器脚本里验（tests/browser/w04-run.mjs）——GPU 不在 node 里跑。
 */

import { describe, expect, it, vi } from 'vitest'
import type { CaptureRequest, CameraSnapshot, CaptureFrame } from '../../contracts'
import { createEvidenceStore, visibleObjectIds } from '../../runtime/evidenceStore'
import { createObservationService, observedObjectIds } from '../../services/observations'
import { createFakeRender } from '../fakes/FakeRender'

const CAM: CameraSnapshot = {
  schemaVersion: 1,
  id: 'cam-test',
  projection: 'orthographic',
  position: [0, 20, 0],
  target: [0, 0, 0],
  up: [0, 1, 0],
  near: 0.1,
  far: 100,
  aspect: 4 / 3,
  ortho: { left: -6, right: 6, top: 4.5, bottom: -4.5 },
}

function makeRequest(over: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    runId: 'run-1',
    phase: 'baseline',
    camera: CAM,
    width: 320,
    height: 240,
    objectIds: ['tree-1', 'tree-2'],
    marked: true,
    sceneRevision: 11,
    fingerprints: { 'tree-1': 'fp-1', 'tree-2': 'fp-2' },
    ...over,
  }
}

function makeFrame(over: Partial<CaptureFrame> = {}): CaptureFrame {
  return {
    camera: CAM,
    width: 320,
    height: 240,
    rgbPng: new Blob([new Uint8Array(1000)], { type: 'image/png' }),
    markedPng: new Blob([new Uint8Array(800)], { type: 'image/png' }),
    labels: [
      { label: 'A', objectId: 'tree-1', visibility: 'visible' },
      { label: 'B', objectId: 'tree-2', visibility: 'uncertain' },
    ],
    observedObjectFingerprints: { 'tree-1': 'fp-1', 'tree-2': 'fp-2' },
    sceneRevision: 11,
    ...over,
  }
}

describe('evidenceStore 铸号与图片登记', () => {
  it('observationId 按登记顺序单调铸造，imageId 可回溯，统计与 URL 计数一致', () => {
    const store = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 10 })
    const o1 = store.add(makeFrame(), { runId: 'run-1', phase: 'baseline', partitionVersion: 1 })
    const o2 = store.add(makeFrame(), { runId: 'run-1', phase: 'after', partitionVersion: 1 })

    expect(o1.id).toBe('obs-run-1-1')
    expect(o2.id).toBe('obs-run-1-2')
    expect(o1.rgbImageId).toBe('img-obs-run-1-1')
    expect(o1.markedImageId).toBe('img-obs-run-1-1-marked')
    expect(o1.partitionVersion).toBe(1)
    expect(o1.sceneRevision).toBe(11)
    expect(o1.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const st = store.stats()
    expect(st.entries).toBe(2)
    expect(st.runs).toBe(1)
    expect(st.bytes).toBe(2 * 1800)
    expect(st.urls).toBe(4) // 每条 rgb + marked
    expect(store.urlFor(o1.rgbImageId)).toMatch(/^blob:/)
    expect(store.urlFor(o1.markedImageId as string)).toMatch(/^blob:/)
    expect(store.urlFor('img-nope')).toBeNull()
    expect(store.observation(o1.id)?.id).toBe(o1.id)
    expect(store.entry(o2.id)?.marked?.bytes).toBe(800)
  })

  it('dataUrlFor 返回可送模型的 PNG dataURL；不存在的 imageId 返回 null', async () => {
    const store = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 10 })
    const o = store.add(makeFrame(), { runId: 'run-1', phase: 'baseline', partitionVersion: 1 })

    const url = await store.dataUrlFor(o.rgbImageId)
    expect(url).toMatch(/^data:image\/png;base64,/)
    expect((url ?? '').length).toBeGreaterThan(20)
    expect(await store.dataUrlFor(o.markedImageId as string)).toMatch(/^data:image\/png;base64,/)
    expect(await store.dataUrlFor('img-nope')).toBeNull()
  })

  it('release 撤销 URL 并回收字节；releaseRun 只清本 run', () => {
    const store = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 10 })
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const a = store.add(makeFrame(), { runId: 'run-a', phase: 'baseline', partitionVersion: 1 })
    store.add(makeFrame(), { runId: 'run-a', phase: 'after', partitionVersion: 1 })
    store.add(makeFrame(), { runId: 'run-b', phase: 'baseline', partitionVersion: 1 })

    expect(store.release(a.id)).toBe(true)
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(store.stats().entries).toBe(2)

    expect(store.releaseRun('run-a')).toBe(1)
    expect(store.stats().entries).toBe(1)
    expect(store.stats().runs).toBe(1)
    expect(store.stats().urls).toBe(2)

    store.reset()
    expect(store.stats()).toMatchObject({ entries: 0, bytes: 0, urls: 0 })
    revoke.mockRestore()
  })

  it('条目上限与字节上限都显式 budget_exceeded（不静默淘汰旧证据）', () => {
    const byEntries = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 1 })
    byEntries.add(makeFrame(), { runId: 'r', phase: 'baseline', partitionVersion: 1 })
    expect(() => byEntries.add(makeFrame(), { runId: 'r', phase: 'after', partitionVersion: 1 })).toThrowError(
      expect.objectContaining({ code: 'budget_exceeded' }),
    )
    expect(byEntries.stats().entries).toBe(1)

    const byBytes = createEvidenceStore({ maxBytes: 1000, maxEntries: 10 })
    expect(() => byBytes.add(makeFrame(), { runId: 'r', phase: 'baseline', partitionVersion: 1 })).toThrowError(
      expect.objectContaining({ code: 'budget_exceeded' }),
    )
  })

  it('labels 的 visible/uncertain 可直接过滤（judge 只对看见的对象下结论）', () => {
    const store = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 10 })
    const obs = store.add(makeFrame(), { runId: 'r', phase: 'baseline', partitionVersion: 1 })
    expect(visibleObjectIds(obs)).toEqual(['tree-1'])
    expect(observedObjectIds(obs)).toEqual(['tree-1'])
  })
})

describe('observations 服务口径', () => {
  it('先 ready(objectIds) 再捕获再登记：版本/指纹/分区版本都进 Observation', async () => {
    const render = createFakeRender()
    const store = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 10 })
    const svc = createObservationService({ getPort: () => render, store })

    const obs = await svc.capture(makeRequest(), new AbortController().signal, 3)

    expect(render.readyRequests).toEqual([['tree-1', 'tree-2']])
    expect(render.captureRequests.length).toBe(1)
    expect(render.captureRequests[0].sceneRevision).toBe(11)
    expect(obs.id).toMatch(/^obs-run-1-\d+$/)
    expect(obs.partitionVersion).toBe(3)
    expect(obs.sceneRevision).toBe(11)
    expect(obs.observedObjectFingerprints).toEqual({ 'tree-1': 'fp-1', 'tree-2': 'fp-2' })
    expect(obs.labels.map(l => l.objectId)).toEqual(['tree-1', 'tree-2'])
    expect(store.stats().entries).toBe(1)
    expect(svc.get(obs.id)).toBe(obs)
  })

  it('桥未挂载 → bridge_unavailable；已取消 → cancelled；不产生证据', async () => {
    const store = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 10 })
    const noPort = createObservationService({ getPort: () => null, store })
    await expect(noPort.capture(makeRequest(), new AbortController().signal, 1)).rejects.toMatchObject({
      code: 'bridge_unavailable',
    })

    const render = createFakeRender()
    const svc = createObservationService({ getPort: () => render, store })
    const aborted = new AbortController()
    aborted.abort()
    await expect(svc.capture(makeRequest(), aborted.signal, 1)).rejects.toMatchObject({ code: 'cancelled' })
    expect(render.captureRequests.length).toBe(0)
    expect(store.stats().entries).toBe(0)
  })

  it('容量超限在登记阶段失败，错误可读且保留已登记证据', async () => {
    const render = createFakeRender()
    const store = createEvidenceStore({ maxBytes: 10_000_000, maxEntries: 1 })
    const svc = createObservationService({ getPort: () => render, store })
    await svc.capture(makeRequest(), new AbortController().signal, 1)
    await expect(svc.capture(makeRequest(), new AbortController().signal, 1)).rejects.toMatchObject({
      code: 'budget_exceeded',
    })
    expect(store.stats().entries).toBe(1)
    // 释放后可继续登记
    svc.releaseRun('run-1')
    await expect(svc.capture(makeRequest(), new AbortController().signal, 1)).resolves.toBeTruthy()
  })
})
