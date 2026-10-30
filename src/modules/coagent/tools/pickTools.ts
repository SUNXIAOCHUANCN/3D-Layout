/**
 * pickTools（P2）——`scene.pick`：按截图坐标识别对象，再交给结构化编辑工具。
 *
 * 三条硬约束（文档 05 §7）：
 * 1. 用观测自己的相机与画幅拾取，不用主视口；
 * 2. 截图必须仍然对应当前场景（否则返回 stale_observation 并提示复拍）；
 * 3. 点选**只识别、不授权**——跨区/只读对象可以返回详情，但写权限仍由写路径判定。
 */

import type { ObjectId, PickResult, TransformDTO, WorkflowContext } from '../contracts'
import { CoAgentError } from '../contracts'

export type PickHitDetail = NonNullable<PickResult['hit']> & {
  ref: string | null
  name: string | null
  transform: TransformDTO | null
  fingerprint: string | null
  /** 全局只读/跨区共享对象：能看见，但改不了 */
  readonly: boolean
}

export type PickToolResult = {
  observationId: string
  sceneRevision: number
  hit: PickHitDetail | null
}

function finite01(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CoAgentError('invalid_arguments', `${name} 必须是有限数`)
  }
  if (value < 0 || value > 1) {
    throw new CoAgentError('invalid_arguments', `${name} 必须在 [0,1] 区间内（归一化图像坐标，左上原点）`)
  }
  return value
}

export async function pickAt(
  context: WorkflowContext,
  args: { observationId: string; u: unknown; v: unknown },
): Promise<PickToolResult> {
  const u = finite01(args.u, 'u')
  const v = finite01(args.v, 'v')

  const observation = context.getObservation(args.observationId)
  if (!observation) {
    throw new CoAgentError('invalid_arguments', `observationId 不存在：${args.observationId}`, {
      details: { observationId: args.observationId },
    })
  }

  const render = context.render
  if (!render.pick) {
    // 明确报不可用，而不是返回"空命中"伪装成"点到空白"
    throw new CoAgentError('bridge_unavailable', '当前渲染端口不支持拾取（scene.pick 不可用）')
  }

  const sceneRevision = context.editorRead.snapshot({}).sceneRevision
  if (observation.sceneRevision !== sceneRevision) {
    throw new CoAgentError(
      'stale_observation',
      `截图已过期（截图时的场景版本 ${observation.sceneRevision}，当前 ${sceneRevision}）：请重新 camera.capture 后再点选`,
      { details: { observationId: observation.id, staleRevision: observation.sceneRevision, sceneRevision } },
    )
  }

  const picked = await render.pick(
    { camera: observation.camera, width: observation.width, height: observation.height, u, v },
    context.signal,
  )
  if (!picked.hit) return { observationId: observation.id, sceneRevision, hit: null }

  const asset = context.editorRead.snapshot({ objectIds: [picked.hit.objectId] }).assets[0]
  const readonly = context.partition.globalReadonlyObjectIds.includes(picked.hit.objectId)
  return {
    observationId: observation.id,
    sceneRevision,
    hit: {
      objectId: picked.hit.objectId,
      point: picked.hit.point,
      distance: picked.hit.distance,
      ref: asset?.ref ?? null,
      name: asset?.name ?? null,
      transform: asset?.transform ?? null,
      fingerprint: asset?.fingerprint ?? null,
      readonly,
    },
  }
}

/** 供 UI/日志：把一次点选压成一行 */
export function describePick(result: PickToolResult): string {
  if (!result.hit) return `点选空白（${result.observationId}）`
  return `点选命中 ${result.hit.objectId}${result.hit.readonly ? '（只读）' : ''}，距离 ${result.hit.distance.toFixed(2)}m`
}

export type PickObjectId = ObjectId
