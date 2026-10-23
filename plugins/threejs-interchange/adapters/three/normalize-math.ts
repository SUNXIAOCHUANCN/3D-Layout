/**
 * 规范化数学（three.js 矩阵运算，无 DOM 依赖，Node 可单测）。
 *
 * 架构文档 §5.2：p_canonical = N × p；W_target = C × W_src × inverse(N)。
 * N = T_bottom · R_up · S_unit（源模型局部 → 规范局部）
 * C = R_up · S_unit（源世界 → 目标世界）
 * 单位缩放为均匀缩放，故 W_target 严格可分解为 TRS，无剪切引入。
 */

import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { Vec3 } from '../../application/contracts.js'

export interface Coords {
  metersPerUnit: number
  up: '+Y' | '+Z'
}

/** 轴/单位相似变换 A（也即 C） */
export function axisUnitMatrix(coords: Coords): Matrix4 {
  const m = new Matrix4()
  if (coords.up === '+Z') {
    // Rx(-90°)：+Z→+Y，右手系保持
    m.makeRotationX(-Math.PI / 2)
  }
  m.scale(new Vector3(coords.metersPerUnit, coords.metersPerUnit, coords.metersPerUnit))
  return m
}

export function sourceBoundsOf(object: { updateWorldMatrix: (a: boolean, b: boolean) => void } & import('three').Object3D): Box3 {
  object.updateWorldMatrix(true, true)
  return new Box3().setFromObject(object, true)
}

/**
 * 规范化矩阵 N：先轴/单位变换，再把实际几何包围盒的底面中心平移到原点。
 * bounds 为源空间包围盒。
 */
export function normalizationMatrix(coords: Coords, bounds: Box3): { n: Matrix4; bottomCenter: Vector3 } {
  const a = axisUnitMatrix(coords)
  const corners: Vector3[] = []
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) corners.push(new Vector3(x, y, z).applyMatrix4(a))
    }
  }
  const inTarget = new Box3().setFromPoints(corners)
  const bottomCenter = new Vector3(
    (inTarget.min.x + inTarget.max.x) / 2,
    inTarget.min.y,
    (inTarget.min.z + inTarget.max.z) / 2,
  )
  // 顺序必须是 T(-bc)·A：bc 在目标空间度量，先做轴/单位变换、再平移底面中心
  const n = new Matrix4().makeTranslation(-bottomCenter.x, -bottomCenter.y, -bottomCenter.z).multiply(a)
  return { n, bottomCenter }
}

export interface InstanceTrs {
  position: Vec3
  rotation?: Vec3
  scale?: Vec3
}

export interface ConvertedTrs {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

/** 重构误差阈值：相对矩阵范数 */
const TRS_EPS = 1e-6

export type ConvertTrsResult =
  | { ok: true; value: ConvertedTrs }
  | { ok: false; code: 'SHEAR_TRANSFORM' | 'MIRRORED_TRANSFORM' | 'SINGULAR_TRANSFORM' | 'INVALID_DECLARATION'; message: string }

/**
 * 实例变换换算：W_target = C · W_src · N⁻¹，分解回 TRS 并重构验证。
 * 只存可精确表达为 TRS 的结果；剪切/镜像/奇异在此拒绝（架构文档 §5.2）。
 */
export function convertInstanceTrs(coords: Coords, src: InstanceTrs, n: Matrix4): ConvertTrsResult {
  const euler = new Euler(
    deg2rad(src.rotation?.[0] ?? 0),
    deg2rad(src.rotation?.[1] ?? 0),
    deg2rad(src.rotation?.[2] ?? 0),
    'XYZ',
  )
  const scale = src.scale ?? [1, 1, 1]
  if (scale.some(s => s <= 0)) {
    return { ok: false, code: 'SINGULAR_TRANSFORM', message: `实例缩放必须为正（收到 [${scale.join(', ')}]）；负缩放/镜像一期拒绝` }
  }
  const wSrc = new Matrix4().compose(
    new Vector3(...src.position),
    new Quaternion().setFromEuler(euler),
    new Vector3(...scale),
  )
  const nInv = n.clone().invert()
  const c = axisUnitMatrix(coords)
  const wTarget = c.clone().multiply(wSrc).multiply(nInv)

  if (!isFiniteMatrix(wTarget)) {
    return { ok: false, code: 'SINGULAR_TRANSFORM', message: '实例变换出现非有限数值' }
  }
  if (wTarget.determinant() < 0) {
    return { ok: false, code: 'MIRRORED_TRANSFORM', message: '实例世界变换含镜像（行列式 < 0）；一期拒绝，请在源端烘焙' }
  }

  const pos = new Vector3()
  const quat = new Quaternion()
  const scl = new Vector3()
  wTarget.decompose(pos, quat, scl)

  const recomposed = new Matrix4().compose(pos, quat, scl)
  const err = recomposeError(wTarget, recomposed)
  if (err > TRS_EPS) {
    return { ok: false, code: 'SHEAR_TRANSFORM', message: `实例世界变换含剪切（重构误差 ${err.toExponential(2)}）；一期拒绝，请在源端烘焙静态模型` }
  }
  if (scl.x <= 0 || scl.y <= 0 || scl.z <= 0 || ![pos.x, pos.y, pos.z, scl.x, scl.y, scl.z].every(Number.isFinite)) {
    return { ok: false, code: 'SINGULAR_TRANSFORM', message: '分解后的 TRS 含非正缩放或非有限数值' }
  }

  const outEuler = new Euler().setFromQuaternion(quat, 'XYZ')
  return {
    ok: true,
    value: {
      position: [pos.x, pos.y, pos.z],
      rotation: [rad2deg(outEuler.x), rad2deg(outEuler.y), rad2deg(outEuler.z)],
      scale: [scl.x, scl.y, scl.z],
    },
  }
}

export function recomposeError(original: Matrix4, recomposed: Matrix4): number {
  let maxNorm = 1e-12
  let maxDiff = 0
  for (let i = 0; i < 16; i++) {
    maxNorm = Math.max(maxNorm, Math.abs(original.elements[i]))
    maxDiff = Math.max(maxDiff, Math.abs(original.elements[i] - recomposed.elements[i]))
  }
  return maxDiff / maxNorm
}

/** 角度尺寸类向量（相机位置/target、地面尺寸）换算：C 直接作用 */
export function convertPoint(coords: Coords, p: Vec3): Vec3 {
  const v = new Vector3(...p).applyMatrix4(axisUnitMatrix(coords))
  return [v.x, v.y, v.z]
}

/** 地面 [x, z] 尺寸：'+Y' 源按 (x,z)，'+Z' 源的地面在 XY 平面映射到目标 (x,z) */
export function convertGroundSize(coords: Coords, size: [number, number]): [number, number] {
  return [size[0] * coords.metersPerUnit, size[1] * coords.metersPerUnit]
}

export function matrixToArrayColMajor(m: Matrix4): number[] {
  return Array.from(m.elements)
}

function isFiniteMatrix(m: Matrix4): boolean {
  return m.elements.every(Number.isFinite)
}

function deg2rad(d: number): number {
  return (d * Math.PI) / 180
}

function rad2deg(r: number): number {
  return (r * 180) / Math.PI
}
