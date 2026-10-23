/**
 * 相机工具（W05）：区域默认相机 / 聚焦相机 / 捕获。
 *
 * - 区域相机 = 覆盖分区多边形的**俯视正交**相机（up=(0,0,-1)）：同一 region 的
 *   baseline / task_before / after 都用它，before-after 天然同视角可比。
 * - 聚焦相机 = 朝对象包围盒中心的透视相机，用于需要看细节的复核；它只**产出快照**，
 *   真正拍摄仍走 camera.capture（快照就是复拍的唯一依据）。
 * - 捕获一律走 `context.capture`（W04 的 ready→渲染→证据登记），工具不碰 WebGL。
 */

import type { CameraSnapshot, ObjectId, Observation, ObservationPhase, TransformDTO, WorkflowContext } from '../contracts'
import { CoAgentError } from '../contracts'
import { validateCameraSnapshot } from '../schemas'

/** 区域默认俯视正交相机：覆盖 polygon 包围盒并留 10% 余量 */
export function regionCamera(region: { id: string; polygonXZ: Array<[number, number]> }, aspect = 4 / 3): CameraSnapshot {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const [x, z] of region.polygonXZ) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const needW = Math.max((maxX - minX) / 2, 1) * 1.1
  const needD = Math.max((maxZ - minZ) / 2, 1) * 1.1
  // 宽高比必须与输出图一致，同时两个方向都不能裁掉（否则边上的对象会"消失"）
  let halfW = needW
  let halfH = needD
  if (needW / needD > aspect) halfH = needW / aspect
  else halfW = needD * aspect
  const height = Math.max(halfW, halfH) * 2 + 10
  return {
    schemaVersion: 1,
    id: `cam-${region.id}`,
    projection: 'orthographic',
    position: [cx, height, cz],
    target: [cx, 0, cz],
    up: [0, 0, -1],
    near: 0.1,
    far: height * 3 + 100,
    aspect,
    ortho: { left: -halfW, right: halfW, top: halfH, bottom: -halfH },
  }
}

/** 由若干对象的世界包围盒推一台聚焦透视相机（保持俯视略斜的稳定视角） */
export function focusCamera(context: WorkflowContext, objectIds: ObjectId[], distanceMul = 2.4): CameraSnapshot {
  const snap = context.editorRead.snapshot({ objectIds })
  if (snap.assets.length === 0) throw new CoAgentError('asset_not_found', '聚焦对象不存在')
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const a of snap.assets) {
    const [x, y, z] = a.transform.position
    const dims = a.catalog?.dimensions
    const halfX = dims ? (dims.w * Math.abs(a.transform.scale[0])) / 2 : 1
    const halfY = dims ? (dims.h * Math.abs(a.transform.scale[1])) / 2 : 1
    const halfZ = dims ? (dims.d * Math.abs(a.transform.scale[2])) / 2 : 1
    minX = Math.min(minX, x - halfX)
    maxX = Math.max(maxX, x + halfX)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y + halfY * 2)
    minZ = Math.min(minZ, z - halfZ)
    maxZ = Math.max(maxZ, z + halfZ)
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const cz = (minZ + maxZ) / 2
  const radius = Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2, 0.8)
  const dist = radius * distanceMul + 2
  return {
    schemaVersion: 1,
    id: `cam-focus-${objectIds.slice(0, 2).join('-')}`,
    projection: 'perspective',
    position: [cx + dist * 0.6, cy + dist * 0.8, cz + dist * 0.6],
    target: [cx, cy, cz],
    up: [0, 1, 0],
    near: 0.1,
    far: dist * 6 + 50,
    aspect: 4 / 3,
    fovDeg: 45,
  }
}

export async function captureWith(
  context: WorkflowContext,
  args: {
    runId: string
    camera: CameraSnapshot
    phase: ObservationPhase
    objectIds: ObjectId[]
    marked: boolean
    taskId: string | null
    regionId: string | null
  },
): Promise<Observation> {
  const check = validateCameraSnapshot(args.camera)
  if (!check.ok) throw new CoAgentError('invalid_arguments', `相机快照非法：${check.issues.map(i => `${i.path} ${i.message}`).join('; ')}`)
  const observation = await context.capture({
    runId: args.runId,
    ...(args.taskId !== null ? { taskId: args.taskId } : {}),
    ...(args.regionId !== null ? { regionId: args.regionId } : {}),
    phase: args.phase,
    camera: args.camera,
    width: 320,
    height: 240,
    objectIds: args.objectIds,
    marked: args.marked,
    // runtime 会用自己的冻结口径覆盖这两项；fake 直驱时用空值即可
    sceneRevision: 0,
    fingerprints: {},
  })
  return observation
}

/** 便捷：按 transform 里的位置判断某对象是否仍在分区多边形内（最终检查用） */
export function pointInPolygonXZ(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]
    const [xj, zj] = polygon[j]
    const intersects = zi > point[1] !== zj > point[1] && point[0] < ((xj - xi) * (point[1] - zi)) / (zj - zi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

export function positionOf(a: { transform: TransformDTO }): [number, number] {
  return [a.transform.position[0], a.transform.position[2]]
}
