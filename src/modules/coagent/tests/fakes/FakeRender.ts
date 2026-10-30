/**
 * FakeRender —— RenderPort 的确定性假实现（W01）。
 *
 * 不碰 GPU：按编程脚本返回 CaptureFrame/GeometryResult，供 W02~W05 的
 * workflow/agents 在无浏览器环境跑闭环。真实 bridge（CoAgentBridge）由 W04 提供。
 * 可注入失败与延迟，用于故障注入测试。
 */

import type {
  CaptureFrame,
  CaptureRequest,
  GeometryRequest,
  GeometryResult,
  ObjectId,
  PickRequest,
  PickResult,
  RenderPort,
  TransformDTO,
} from '../../contracts'
import { CoAgentError } from '../../contracts'

export interface FakeRenderOptions {
  /** 每次调用的耗时（毫秒），默认 0；用于乱序完成/取消测试 */
  delayMs?: number
  /** 前 N 次 capture 抛 capture_failed，之后恢复成功 */
  captureFailures?: number
  /** 前 N 次 ready 抛 renderer_not_ready，之后恢复成功 */
  readyFailures?: number
  /** geometry 的固定返回；缺省对每对返回 unknown */
  geometryResult?: GeometryResult
  /** P2：拾取的固定返回；缺省报"不支持拾取"（不伪装成空命中） */
  pickResult?: PickResult
}

export interface FakeRender extends RenderPort {
  /** 已收到的 capture 请求（时间序），供断言视角/相位 */
  readonly captureRequests: ReadonlyArray<Readonly<CaptureRequest>>
  /** 已收到的 ready 请求对象集合 */
  readonly readyRequests: ReadonlyArray<ReadonlyArray<ObjectId>>
  /** 可设置的"当前场景版本"：capture 帧会带上（真实 bridge 从 document 派生） */
  setSceneRevision(revision: number): void
  /** 手动触发 renderer 失联（bridge 卸载语义） */
  goOffline(): void
  goOnline(): void
}

const SHORT_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function createFakeRender(opts: FakeRenderOptions = {}): FakeRender {
  const delayMs = opts.delayMs ?? 0
  let captureFailures = opts.captureFailures ?? 0
  let readyFailures = opts.readyFailures ?? 0
  let online = true
  let sceneRevision = 1
  const captureRequests: CaptureRequest[] = []
  const readyRequests: ObjectId[][] = []

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new CoAgentError('cancelled', '等待渲染时被取消'))
        },
        { once: true },
      )
    })

  return {
    async ready(objectIds: ObjectId[], signal: AbortSignal, _expectedTransforms?: Record<ObjectId, TransformDTO>): Promise<void> {
      readyRequests.push([...objectIds])
      if (delayMs > 0) await sleep(delayMs, signal)
      if (!online) throw new CoAgentError('bridge_unavailable', '渲染桥已卸载')
      if (readyFailures > 0) {
        readyFailures--
        throw new CoAgentError('renderer_not_ready', `场景就绪失败（剩余注入失败 ${readyFailures}）`)
      }
    },

    async capture(request: CaptureRequest, signal: AbortSignal): Promise<CaptureFrame> {
      captureRequests.push(request)
      if (delayMs > 0) await sleep(delayMs, signal)
      if (!online) throw new CoAgentError('bridge_unavailable', '渲染桥已卸载')
      if (captureFailures > 0) {
        captureFailures--
        throw new CoAgentError('capture_failed', `像素读回失败（剩余注入失败 ${captureFailures}）`)
      }
      const labels = request.objectIds.map((objectId, i) => ({
        label: SHORT_LABELS[i % SHORT_LABELS.length] + (i >= SHORT_LABELS.length ? String(Math.floor(i / SHORT_LABELS.length)) : ''),
        objectId,
        visibility: 'visible' as const,
      }))
      const frame: CaptureFrame = {
        camera: request.camera,
        width: request.width,
        height: request.height,
        // 真实 bridge 交 PNG Blob；fake 交可校验字节的占位 Blob（非空、类型正确）
        rgbPng: new Blob([`fake-rgb:${request.runId}:${request.phase}`], { type: 'image/png' }),
        ...(request.marked
          ? { markedPng: new Blob([`fake-marked:${request.runId}`], { type: 'image/png' }) }
          : {}),
        labels,
        observedObjectFingerprints: { ...request.fingerprints },
        // 请求自带版本优先；未给（旧测试）时回落到本 fake 的当前版本
        sceneRevision: request.sceneRevision ?? sceneRevision,
      }
      return frame
    },

    async geometry(request: GeometryRequest, signal: AbortSignal): Promise<GeometryResult> {
      if (delayMs > 0) await sleep(delayMs, signal)
      if (!online) throw new CoAgentError('bridge_unavailable', '渲染桥已卸载')
      if (opts.geometryResult) return opts.geometryResult
      // 与真实实现同口径：targets×targets + targets×statics，不含 statics×statics
      const targets = [...new Set(request.objectIds)]
      const targetSet = new Set(targets)
      const statics = [...new Set(request.staticObjectIds ?? [])].filter(id => !targetSet.has(id))
      const pairs: GeometryResult['pairs'] = []
      const push = (a: ObjectId, b: ObjectId): void => {
        pairs.push({ a, b, status: 'unknown', level: 'aabb', note: 'fake：未编程具体结果' })
      }
      for (let i = 0; i < targets.length; i++) {
        for (let j = i + 1; j < targets.length; j++) push(targets[i], targets[j])
      }
      for (const t of targets) {
        for (const s of statics) push(t, s)
      }
      return { status: 'unknown', highestLevel: 'aabb', pairs }
    },

    /**
     * P2：fake 没有真实场景，不能假装"点了但什么都没点到"。
     * 未编程时明确报不可用；给了 pickResult 就按脚本返回。
     */
    async pick(request: PickRequest, signal: AbortSignal): Promise<PickResult> {
      if (delayMs > 0) await sleep(delayMs, signal)
      if (!online) throw new CoAgentError('bridge_unavailable', '渲染桥已卸载')
      if (opts.pickResult) return opts.pickResult
      throw new CoAgentError('bridge_unavailable', `fake 未编程拾取结果（u=${request.u}, v=${request.v}）`)
    },

    get captureRequests(): ReadonlyArray<Readonly<CaptureRequest>> {
      return captureRequests
    },
    get readyRequests(): ReadonlyArray<ReadonlyArray<ObjectId>> {
      return readyRequests
    },

    setSceneRevision(revision: number): void {
      sceneRevision = revision
    },
    goOffline(): void {
      online = false
    },
    goOnline(): void {
      online = true
    },
  }
}
