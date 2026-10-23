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
        throw new CoAgentError('bridge_unavailable', '渲染桥未就绪（CoAgentBridge 未挂载）')
      }
      await port.ready(request.objectIds, signal, request.expectedTransforms)
      if (signal.aborted) throw new CoAgentError('cancelled', '观测在取图前被取消')
      const frame = await port.capture(request, signal)
      return deps.store.add(frame, {
        runId: request.runId,
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
        ...(request.regionId !== undefined ? { regionId: request.regionId } : {}),
        phase: request.phase,
        partitionVersion,
      })
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
