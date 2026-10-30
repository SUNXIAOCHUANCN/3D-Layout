/**
 * regionCamera（P2）——区域工作相机的纯计算。
 *
 * 产品行为采用"方案 B"：先聚焦目标，再连续环绕/俯仰/缩放/平移。
 * 模型不需要自己算世界坐标相机位置，只给**相对参数**。
 *
 * 约定（集中在这里，测试依此验证）：
 * - 世界 +Y 向上；
 * - `azimuthDeg = 0` 表示从 +Z 方向看向目标，正角转向 +X；
 * - `elevationDeg` 是**绝对**俯仰：0 = 水平，90 = 正上方；
 * - `zoomFactor < 1` 拉近（distance 变小），>1 拉远；
 * - `pan` 按**当前画面跨度**的比例给：正 right 向右，正 up 向上。
 *
 * 非法参数一律夹取并在 warnings 里报实际值，绝不产出 NaN 相机。
 */

import type { CameraSnapshot, Vec3 } from '../contracts'

const DEG = Math.PI / 180
const RAD = 180 / Math.PI
const DEFAULT_FOV = 45

export type CameraAdjust = {
  /** 相对当前方位的增量（度） */
  azimuthDeltaDeg?: number
  /** 绝对俯仰（度）；省略则保持当前 */
  elevationDeg?: number
  /** <1 拉近，>1 拉远 */
  zoomFactor?: number
  /** 按画面跨度的比例平移目标点 */
  pan?: { right: number; up: number }
}

export type AdjustOutcome = {
  camera: CameraSnapshot
  /** 参数被夹取/修正时说明实际采用值 */
  warnings: string[]
}

export type OrbitLimits = {
  minElevationDeg?: number
  maxElevationDeg?: number
  minDistance?: number
  maxDistance?: number
  fovDeg?: number
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
const norm = (a: Vec3): Vec3 => {
  const l = len(a)
  return l <= 1e-9 ? [0, 0, 1] : scale(a, 1 / l)
}
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const finite = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** 方位角/俯仰角 → 单位偏移（文档公式：offset = d·[cos(e)sin(a), sin(e), cos(e)cos(a)]） */
export function orbitOffset(azimuthDeg: number, elevationDeg: number): Vec3 {
  const a = azimuthDeg * DEG
  const e = elevationDeg * DEG
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)]
}

/**
 * 把任意基相机（正交或透视）拆成"目标点 + 距离 + 方位 + 俯仰"。
 * 正交基相机按等效视高换算距离，保证切换后取景尺度不突变。
 */
function decompose(base: CameraSnapshot, fovDeg: number): { target: Vec3; distance: number; azimuthDeg: number; elevationDeg: number } {
  const target = [finite(base.target[0], 0), finite(base.target[1], 0), finite(base.target[2], 0)] as Vec3
  const offset = sub([base.position[0], base.position[1], base.position[2]], target)
  let distance = len(offset)
  if (base.projection === 'orthographic' && base.ortho) {
    const halfHeight = Math.abs(base.ortho.top - base.ortho.bottom) / 2
    distance = halfHeight / Math.tan((fovDeg * DEG) / 2)
  }
  if (!(distance > 1e-6)) distance = 10
  const dir = norm(offset)
  const elevationDeg = Math.asin(clamp(dir[1], -1, 1)) * RAD
  const azimuthDeg = Math.atan2(dir[0], dir[2]) * RAD
  return { target, distance, azimuthDeg, elevationDeg }
}

export function orbitCamera(base: CameraSnapshot, adjust: CameraAdjust, limits: OrbitLimits = {}): AdjustOutcome {
  const warnings: string[] = []
  const fovDeg = limits.fovDeg ?? base.fovDeg ?? DEFAULT_FOV
  const minElev = limits.minElevationDeg ?? -5
  const maxElev = limits.maxElevationDeg ?? 85
  const { target: baseTarget, distance: baseDistance, azimuthDeg: baseAzimuth, elevationDeg: baseElevation } = decompose(
    base,
    fovDeg,
  )

  // ---- 方位 ----
  const azimuthRaw = baseAzimuth + finite(adjust.azimuthDeltaDeg, 0)
  const azimuthDeg = ((azimuthRaw % 360) + 360) % 360

  // ---- 俯仰（绝对；夹取避免 lookAt 与 up 平行产生奇异） ----
  const elevWanted = adjust.elevationDeg === undefined ? baseElevation : finite(adjust.elevationDeg, baseElevation)
  const elevationDeg = clamp(elevWanted, minElev, maxElev)
  if (Math.abs(elevationDeg - elevWanted) > 1e-6) {
    warnings.push(`俯仰 ${elevWanted.toFixed(1)}° 超出允许范围，已夹到 ${elevationDeg.toFixed(1)}°`)
  }

  // ---- 距离 ----
  const zoom = adjust.zoomFactor === undefined ? 1 : finite(adjust.zoomFactor, 1)
  const minDist = limits.minDistance ?? 0.5
  const maxDist = limits.maxDistance ?? Math.max(baseDistance * 20, 200)
  const zoomed = baseDistance * (zoom > 0 ? zoom : 1)
  if (zoom <= 0) warnings.push(`zoomFactor 必须 > 0（收到 ${zoom}），按 1 处理`)
  const distance = clamp(zoomed, minDist, maxDist)
  if (Math.abs(distance - zoomed) > 1e-6) {
    warnings.push(`距离 ${zoomed.toFixed(2)}m 超出 [${minDist}, ${maxDist}]，已夹到 ${distance.toFixed(2)}m`)
  }

  // ---- 平移（按目标处的画面跨度比例） ----
  let target = baseTarget
  if (adjust.pan) {
    const rightRatio = finite(adjust.pan.right, 0)
    const upRatio = finite(adjust.pan.up, 0)
    if (rightRatio !== 0 || upRatio !== 0) {
      const halfHeight = distance * Math.tan((fovDeg * DEG) / 2)
      const halfWidth = halfHeight * (base.aspect || 4 / 3)
      const forward = scale(orbitOffset(azimuthDeg, elevationDeg), -1) // 目标 → 相机方向的相反
      const right = norm(cross(forward, [0, 1, 0]))
      const up = norm(cross(right, forward))
      target = add(target, add(scale(right, rightRatio * halfWidth * 2), scale(up, upRatio * halfHeight * 2)))
    }
  }

  const offset = scale(orbitOffset(azimuthDeg, elevationDeg), distance)
  const position = add(target, offset)
  const camera: CameraSnapshot = {
    schemaVersion: 1,
    id: `${base.id}-adj`,
    projection: 'perspective',
    position: [round(position[0]), round(position[1]), round(position[2])],
    target: [round(target[0]), round(target[1]), round(target[2])],
    up: [0, 1, 0],
    near: Math.max(0.05, distance / 500),
    far: distance * 6 + 100,
    aspect: base.aspect || 4 / 3,
    fovDeg,
  }

  for (const v of [...camera.position, ...camera.target]) {
    if (!Number.isFinite(v)) warnings.push('相机参数出现非有限值，已拒绝生成')
  }
  return { camera, warnings }
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6

/** 供日志/提示：一句话描述当前视角 */
export function describeCamera(camera: CameraSnapshot): string {
  const { distance, azimuthDeg, elevationDeg } = decompose(camera, camera.fovDeg ?? DEFAULT_FOV)
  return `方位 ${azimuthDeg.toFixed(0)}°，俯仰 ${elevationDeg.toFixed(0)}°，距离 ${distance.toFixed(1)}m（${camera.projection}）`
}
