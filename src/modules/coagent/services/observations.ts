/**
 * observations（W04，SPEC §3.2/§3.8）——把"渲染端口"与"证据登记"接成一次观测。
 *
 * 一次 capture 的完整口径：
 *   ready(objectIds)  → 确认文档里的对象真的进了渲染层（否则拍到的是旧画面）
 *   port.capture      → 独立相机 RGB +（可选）同帧 ID 标记
 *   store.add         → 铸 observationId、登记图片、受内存上限约束
 *
 * 错误口径：桥未就绪→bridge_unavailable；对象未同步→renderer_not_ready（port 抛）；
 * 取消→cancelled；容量→budget_exceeded。全部是 CoAgentError，上层不必认形状。
 */

import type { CaptureRequest, ImageId, ObjectId, Observation, ObservationId, RenderPort, RunId } from '../contracts'
import { CoAgentError } from '../contracts'
import type { EvidenceStore, EvidenceStoreStats } from '../runtime/evidenceStore'
import { logError, logStage } from '../runtime/runLog'

export type ObservationService = {
  capture(request: CaptureRequest, signal: AbortSignal, partitionVersion: number): Promise<Observation>
  get(id: ObservationId): Observation | undefined
  urlFor(imageId: ImageId): string | null
  releaseRun(runId: RunId): number
  stats(): EvidenceStoreStats
}

export function createObservationService(deps: { getPort: () => RenderPort | null; store: EvidenceStore }): ObservationService {
  return {
    async capture(request: CaptureRequest, signal: AbortSignal, partitionVersion: number): Promise<Observation> {
      if (signal.aborted) throw new CoAgentError('cancelled', '观测开始前已取消')
      const port = deps.getPort()
      if (!port) {
        logError('capture', '渲染桥未就绪：CoAgentBridge 未挂载', `phase=${request.phase}，对象 ${request.objectIds.length} 个`)
        throw new CoAgentError('bridge_unavailable', '渲染桥未就绪（CoAgentBridge 未挂载）')
      }
      const startedAt = Date.now()
      const where = `${request.phase}${request.regionId ? `/${request.regionId}` : ''}${request.taskId ? `/${request.taskId}` : ''}`
      try {
        await port.ready(request.objectIds, signal, request.expectedTransforms)
        const readyMs = Date.now() - startedAt
        if (signal.aborted) throw new CoAgentError('cancelled', '观测在取图前被取消')
        const frame = await port.capture(request, signal)
        const observation = deps.store.add(frame, {
          runId: request.runId,
          ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
          ...(request.regionId !== undefined ? { regionId: request.regionId } : {}),
          phase: request.phase,
          partitionVersion,
        })
        logStage(
          'capture',
          `截图完成 ${where}：${observation.id}（${frame.width}×${frame.height}）`,
          [
            `场景就绪等待 ${readyMs}ms；总耗时 ${Date.now() - startedAt}ms`,
            `请求对象 ${request.objectIds.length} 个，可见 ${observation.labels.filter(l => l.visibility === 'visible').length} 个`,
            `rgb=${observation.rgbImageId}${observation.markedImageId ? `，marked=${observation.markedImageId}` : ''}`,
          ].join('\n'),
        )
        return observation
      } catch (e) {
        const err = CoAgentError.from(e)
        if (err.code !== 'cancelled') {
          logError(
            'capture',
            `截图失败 ${where}：${err.code} ${err.message}`,
            `耗时 ${Date.now() - startedAt}ms；请求对象 ${request.objectIds.length} 个`,
            err.details,
          )
        }
        throw e
      }
    },

    get: id => deps.store.observation(id),
    urlFor: imageId => deps.store.urlFor(imageId),
    releaseRun: runId => deps.store.releaseRun(runId),
    stats: () => deps.store.stats(),
  }
}

/** 观测里"真正看见"的对象（judge 下结论前应过滤） */
export function observedObjectIds(observation: Observation): ObjectId[] {
  return observation.labels.filter(l => l.visibility === 'visible').map(l => l.objectId)
}
