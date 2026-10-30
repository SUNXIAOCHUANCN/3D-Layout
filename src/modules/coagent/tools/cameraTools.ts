/**
 * 相机工具（W05）：区域默认相机 / 聚焦相机 / 捕获。
 *
 * - 区域相机 = 覆盖分区多边形的**俯视正交**相机（up=(0,0,-1)）：同一 region 的
 *   baseline / task_before / after 都用它，before-after 天然同视角可比。
 * - 聚焦相机 = 朝对象包围盒中心的透视相机，用于需要看细节的复核；它只**产出快照**，
 *   真正拍摄仍走 camera.capture（快照就是复拍的唯一依据）。
 * - 捕获一律走 `context.capture`（W04 的 ready→渲染→证据登记），工具不碰 WebGL。
 */

import type { CameraSnapshot, ObjectId, Observation, ObservationPhase, Region, TransformDTO, WorkflowContext } from '../contracts'
import { CoAgentError } from '../contracts'
import { validateCameraSnapshot } from '../schemas'
import { modelWorldBounds } from '../../../shared/modelBounds'
import { orbitCamera, type CameraAdjust } from '../services/regionCamera'

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
    if (a.catalog) {
      const box = modelWorldBounds(a.catalog, a.transform)
      minX = Math.min(minX, box.min[0]); maxX = Math.max(maxX, box.max[0])
      minY = Math.min(minY, box.min[1]); maxY = Math.max(maxY, box.max[1])
      minZ = Math.min(minZ, box.min[2]); maxZ = Math.max(maxZ, box.max[2])
      continue
    }
    const [x, y, z] = a.transform.position
    const halfX = 1
    const halfY = 1
    const halfZ = 1
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
    /** P2：局部观察可用更高分辨率；缺省沿用 320×240（before/after 必须同尺寸可比） */
    width?: number
    height?: number
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
    width: args.width ?? 320,
    height: args.height ?? 240,
    objectIds: args.objectIds,
    marked: args.marked,
    // runtime 会用自己的冻结口径覆盖这两项；fake 直驱时用空值即可
    sceneRevision: 0,
    fingerprints: {},
  })
  return observation
}

/** 局部观察的默认画幅（文档 05 §5：工作 640×480，局部可到 960×720） */
export const DETAIL_WIDTH = 640
export const DETAIL_HEIGHT = 480

/**
 * P2 `camera.inspect`：聚焦若干对象并**当场截图**。
 *
 * 一次调用完成"调整 + 截图"，避免模型用三个回合做一次观察。
 * 返回相机实际状态与 warnings——参数被夹取时要让模型知道实际用了什么。
 */
export async function inspectWith(
  context: WorkflowContext,
  args: {
    runId: string
    taskId: string | null
    regionId: string | null
    objectIds: ObjectId[]
    framing: 'tight' | 'context'
    phase: ObservationPhase
    marked: boolean
  },
): Promise<{ observation: Observation; camera: CameraSnapshot; warnings: string[] }> {
  /**
   * 取景倍数必须让**整个包围盒**进画面。
   *
   * fov 45° 时完整包含半径 r 的物体需要 ≈ r/tan(22.5°) ≈ 2.41r 的距离；
   * 原来 tight 用 1.5 会把目标裁掉一角（实测 tree-1 的角点算出 1.06，出画 6%），
   * 模型自然"看不清"。这里改成安全值，并用视锥包含性单测锁住。
   */
  const camera = focusCamera(context, args.objectIds, args.framing === 'tight' ? 2.1 : 2.9)
  const observation = await captureWith(context, {
    runId: args.runId,
    camera,
    phase: args.phase,
    objectIds: args.objectIds,
    marked: args.marked,
    taskId: args.taskId,
    regionId: args.regionId,
    width: DETAIL_WIDTH,
    height: DETAIL_HEIGHT,
  })
  // P2：把这次聚焦记成该区的工作视角，后续 camera.adjust 从它继续
  if (args.regionId) {
    context.regionViews.put(args.regionId, {
      camera,
      target: camera.target,
      focusedObjectIds: args.objectIds,
      latestObservationId: observation.id,
    })
  }
  return { observation, camera, warnings: [] }
}

/**
 * P2 `camera.adjust`：在给定基相机上做相对调整并截图。
 *
 * 基相机优先用调用方给的快照，其次用上一张观测的相机，最后回落到本区总览。
 * 归属由 tool call 的 runId/regionId 决定——模型不能传别的区域 id 来动别人的相机。
 */
export async function adjustWith(
  context: WorkflowContext,
  args: {
    runId: string
    taskId: string | null
    regionId: string | null
    region: Region | null
    baseCamera?: CameraSnapshot
    fromObservationId?: string
    adjust: CameraAdjust
    objectIds?: ObjectId[]
    phase: ObservationPhase
    marked: boolean
  },
): Promise<{ observation: Observation; camera: CameraSnapshot; warnings: string[] }> {
  const warnings: string[] = []
  let base: CameraSnapshot | null = args.baseCamera ?? null
  if (!base && args.fromObservationId) {
    const obs = context.getObservation(args.fromObservationId)
    if (!obs) throw new CoAgentError('invalid_arguments', `observationId 不存在：${args.fromObservationId}`)
    base = obs.camera
  }
  // P2：没有显式基相机时，从该区上一次的工作视角继续——这样"环绕/拉近"才是连续的
  if (!base && args.regionId) {
    const view = context.regionViews.get(args.regionId)
    if (view) {
      const live = new Set(context.editorRead.snapshot({}).assets.map(a => a.id))
      const focusAlive = view.focusedObjectIds.length === 0 || view.focusedObjectIds.some(id => live.has(id))
      if (focusAlive) {
        base = view.camera
      } else {
        // 聚焦目标已被删除：不能继续对着旧包围盒声称"已聚焦"
        context.regionViews.clearFocus(args.regionId)
        warnings.push('上一次聚焦的对象已被删除，已退回本区总览')
      }
    }
  }
  if (!base && args.region) base = regionCamera(args.region)
  if (!base) throw new CoAgentError('out_of_scope', '没有可用的基相机：请给 camera 或 fromObservationId，或在分区内调用')

  const orbit = orbitCamera(base, args.adjust, { fovDeg: base.fovDeg ?? 45 })
  const camera = orbit.camera
  warnings.push(...orbit.warnings)
  const objectIds = args.objectIds && args.objectIds.length > 0 ? args.objectIds : (args.region?.objectIds.slice(0, 12) ?? [])
  const observation = await captureWith(context, {
    runId: args.runId,
    camera,
    phase: args.phase,
    objectIds,
    marked: args.marked,
    taskId: args.taskId,
    regionId: args.regionId,
    width: DETAIL_WIDTH,
    height: DETAIL_HEIGHT,
  })
  if (args.regionId) {
    context.regionViews.put(args.regionId, {
      camera,
      target: camera.target,
      focusedObjectIds: objectIds,
      latestObservationId: observation.id,
    })
  }
  return { observation, camera, warnings }
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
