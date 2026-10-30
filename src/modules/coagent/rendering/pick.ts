/**
 * pick（P2）——用**观测自己的相机**做射线拾取，把截图像素坐标变成真实对象 id。
 *
 * 为什么单独一份：`core/engine.ts::pickNormalized` 写死了主视口相机，
 * 而 Agent 看的是离屏截图。renderer 层的相机由 `cameraFromSnapshot` 现造，
 * 与截图完全一致——拾取必须复用同一台相机，否则"点到的"和"看到的"不是一回事。
 *
 * 边界：本文件只 import three 与 contracts，**不 import core**（rendering 层约束），
 * 所以 findAssetId / 辅助件判定在本地重新实现了一份。
 */

import { Raycaster, Vector2, type Camera, type Object3D, type Scene } from 'three'
import type { ObjectId, PickRequest, PickResult } from '../contracts'
import { cameraFromSnapshot } from './capture'

export type PickHooks = {
  /** 编辑辅助件（选中描边壳等）不参与拾取 */
  isHelper?: (o: Object3D) => boolean
}

const defaultIsHelper = (o: Object3D): boolean => o.userData?.editorHelper === true

/** 自身或任一祖先不可见 → 视为不可见（命中不可见对象没有意义） */
function visibleChain(o: Object3D | null): boolean {
  let cur: Object3D | null = o
  while (cur) {
    if (!cur.visible) return false
    cur = cur.parent
  }
  return true
}

/** 沿父链找 assetId（对象可能挂在资产根的子节点上） */
function findAssetId(o: Object3D | null): ObjectId | null {
  let cur: Object3D | null = o
  while (cur) {
    const id = cur.userData?.assetId
    if (typeof id === 'string' && id.length > 0) return id
    cur = cur.parent
  }
  return null
}

/**
 * 在给定场景里按归一化坐标拾取。
 *
 * - 图像坐标左上原点 → NDC：x = 2u-1，y = 1-2v（与 three 的 y 轴向上一致）；
 * - 命中按距离排序，跳过辅助件、不可见对象、没有 assetId 的对象；
 * - **不跳过只读对象**：点选只负责识别，写权限由上层判定（不能"穿过"前方只读物体选中后方可写物体）。
 */
export function pickFromSnapshot(scene: Scene, request: PickRequest, hooks: PickHooks = {}): PickResult {
  const camera: Camera = cameraFromSnapshot(request.camera, request.width, request.height)
  camera.updateMatrixWorld(true)
  scene.updateMatrixWorld(true)

  const isHelper = hooks.isHelper ?? defaultIsHelper
  const raycaster = new Raycaster()
  const ndc = new Vector2(request.u * 2 - 1, 1 - request.v * 2)
  raycaster.setFromCamera(ndc, camera as never)
  raycaster.camera = camera

  const hits = raycaster.intersectObjects(scene.children, true)
  for (const hit of hits) {
    if (isHelper(hit.object)) continue
    if (!visibleChain(hit.object)) continue
    const objectId = findAssetId(hit.object)
    if (!objectId) continue
    return {
      hit: {
        objectId,
        point: [hit.point.x, hit.point.y, hit.point.z],
        distance: hit.distance,
      },
    }
  }
  return { hit: null }
}
