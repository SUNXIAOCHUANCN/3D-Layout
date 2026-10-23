/** 规范化数学单测：W_target·(N·p) === C·(W_src·p) 不变量、剪切/镜像拒绝 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import {
  axisUnitMatrix, normalizationMatrix, convertInstanceTrs, convertPoint, recomposeError,
  type InstanceTrs,
} from '../adapters/three/normalize-math.js'
import type { Coords } from '../adapters/three/normalize-math.js'

function trsMatrix(t: { position: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] }): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...t.position),
    new Quaternion().setFromEuler(new Euler(
      (t.rotation?.[0] ?? 0) * Math.PI / 180,
      (t.rotation?.[1] ?? 0) * Math.PI / 180,
      (t.rotation?.[2] ?? 0) * Math.PI / 180,
      'XYZ',
    )),
    new Vector3(...(t.scale ?? [1, 1, 1])),
  )
}

function sampleTransformError(coords: Coords, trs: InstanceTrs, bounds: Box3, probes: Vector3[]): number {
  const { n } = normalizationMatrix(coords, bounds)
  const result = convertInstanceTrs(coords, trs, n)
  assert.equal(result.ok, true, `应可转换为 TRS：${JSON.stringify(result)}`)
  if (!result.ok) return NaN
  const c = axisUnitMatrix(coords)
  const wSrc = trsMatrix(trs)
  const wTarget = trsMatrix({ position: result.value.position, rotation: result.value.rotation, scale: result.value.scale })
  let maxErr = 0
  for (const p of probes) {
    const viaCanonical = p.clone().applyMatrix4(n).applyMatrix4(wTarget)
    const viaSource = p.clone().applyMatrix4(wSrc).applyMatrix4(c)
    maxErr = Math.max(maxErr, viaCanonical.distanceTo(viaSource))
  }
  return maxErr
}

const unitBox = new Box3(new Vector3(-0.5, -0.25, -0.4), new Vector3(0.5, 1.2, 0.4))
const probes = [
  new Vector3(-0.5, -0.25, -0.4), new Vector3(0.5, 1.2, 0.4),
  new Vector3(0, 0, 0), new Vector3(0.3, 0.7, -0.2),
]

test('米制 +Y 恒等坐标：底面中心补偿使位置下移到实例原点', () => {
  const coords: Coords = { metersPerUnit: 1, up: '+Y' }
  const trs: InstanceTrs = { position: [5, 0.25, 3] }
  const { n, bottomCenter } = normalizationMatrix(coords, unitBox)
  // 底面中心应为 (0, -0.25, 0)
  assert.ok(Math.abs(bottomCenter.y - (-0.25)) < 1e-9)
  // N 作用于源包围盒八隅后，底面必须落在 y=0（T(-bc)·A 顺序；此前 A·T(-bc) 顺序错误未被发现）
  const canonical = unitBox.clone().applyMatrix4(n)
  assert.ok(Math.abs(canonical.min.y) < 1e-9, `规范化后底面应在 y=0，得到 ${canonical.min.y}`)
  assert.ok(Math.abs((canonical.min.x + canonical.max.x) / 2) < 1e-9, '规范化后包围盒应在 x 居中')
  const result = convertInstanceTrs(coords, trs, n)
  assert.equal(result.ok, true)
  if (result.ok) {
    // W_target·(N·p) === C·(W_src·p)
    const err = sampleTransformError(coords, trs, unitBox, probes)
    assert.ok(err < 1e-9, `角点世界位置误差 ${err}`)
  }
})

test('厘米 + Z-up 输入：旋转与均匀缩放的实例世界位置保持', () => {
  const coords: Coords = { metersPerUnit: 0.01, up: '+Z' }
  const trs: InstanceTrs = { position: [800, 0, -350], rotation: [0, 0, 90], scale: [2, 2, 2] }
  const err = sampleTransformError(coords, trs, unitBox, probes)
  assert.ok(err < 1e-7, `厘米/Z-up 角点误差 ${err}`)
})

test('厘米 + Z-up：相机点坐标同步换算', () => {
  const coords: Coords = { metersPerUnit: 0.01, up: '+Z' }
  // 源 (100, 200, 300) cm → 1m 换算：x=1, y=3(源 z), z=-2(源 y)
  const out = convertPoint(coords, [100, 200, 300])
  assert.ok(Math.abs(out[0] - 1) < 1e-12 && Math.abs(out[1] - 3) < 1e-12 && Math.abs(out[2] - -2) < 1e-12)
})

test('非均匀缩放 + 旋转：+Y/+Z 轴映射为置换，共轭后仍是合法 TRS', () => {
  // 轴映射 A 是置换+均匀缩放时，W_target = A·(T·R·S)·A⁻¹ 严格可分解为 TRS：
  // P·S·Pᵀ 仍是对角阵。剪切检测只对未来非置换的轴映射等防御路径生效。
  const coords: Coords = { metersPerUnit: 0.01, up: '+Z' }
  const trs: InstanceTrs = { position: [0, 0, 0], rotation: [30, 45, 15], scale: [1.5, 0.8, 1] }
  const err = sampleTransformError(coords, trs, unitBox, probes)
  assert.ok(err < 1e-7, `非均匀缩放实例角点误差 ${err}`)
})

test('剪切矩阵被重构误差检测器识别（防御路径的数学基础）', () => {
  // 真剪切矩阵：col1 含 x 分量，任何 (R,S) 分解都无法精确重构
  const shear = new Matrix4().set(
    1, 1, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  )
  const pos = new Vector3(); const quat = new Quaternion(); const scl = new Vector3()
  shear.decompose(pos, quat, scl)
  const recomposed = new Matrix4().compose(pos, quat, scl)
  const err = recomposeError(shear, recomposed)
  assert.ok(err > 1e-3, `剪切矩阵重构误差应显著：${err}`)
})

test('负缩放 → 拒绝（镜像一期不支持）', () => {
  const coords: Coords = { metersPerUnit: 1, up: '+Y' }
  const { n } = normalizationMatrix(coords, unitBox)
  const result = convertInstanceTrs(coords, { position: [0, 0, 0], scale: [-1, 1, 1] }, n)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'SINGULAR_TRANSFORM')
})

test('轴变换矩阵 +Z→+Y 方向正确', () => {
  const m = axisUnitMatrix({ metersPerUnit: 1, up: '+Z' })
  const z = new Vector3(0, 0, 1).applyMatrix4(m)
  const y = new Vector3(0, 1, 0).applyMatrix4(m)
  assert.ok(Math.abs(z.y - 1) < 1e-12 && Math.abs(z.x + z.z) < 1e-12, '+Z 应映射到 +Y')
  assert.ok(Math.abs(y.z - -1) < 1e-12, '+Y 应映射到 -Z（右手系保持）')
})
