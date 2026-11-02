/** 纯数据 GLB 检查器单测：GLB 容器解析、规范化边界、压缩/外链检测 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectGlb, axisUnitTransform, canonicalTransform, COMPRESSED_EXTENSIONS, assertStaticExtensions } from '../application/glb-inspect.js'
import { buildGlb } from './helpers.js'

test('必需 UV 变换扩展可用，压缩及未知必需扩展仍拒绝', () => {
  const check = (used: string[], required: string[]) => assertStaticExtensions(
    { extensionsUsed: used, extensionsRequired: required }, 'model', 'model.glb',
  )
  assert.doesNotThrow(() => check(['KHR_texture_transform'], ['KHR_texture_transform']))
  assert.throws(() => check([], ['KHR_draco_mesh_compression']), /压缩扩展/)
  assert.throws(() => check(['EXT_unknown'], ['EXT_unknown']), /尚未支持/)
  assert.throws(() => check([], ['EXT_unknown']), /尚未支持/)
})

test('GLB 解析 + 厘米/Z-up 规范化边界', () => {
  // 源：厘米坐标，Z-up —— 高度 120 放在源 Z 轴上（无歧义数据）
  const glb = buildGlb({ min: [-50, -40, 0], max: [50, 40, 120] })
  const insp = inspectGlb(glb, { metersPerUnit: 0.01, up: '+Z' })
  assert.ok(insp.boundsCanonical)
  const bc = insp.boundsCanonical!
  // 目标：x ∈ [-0.5,0.5]（x 不变）；y 来自源 z ∈ [0,1.2]；z 来自源 y ∈ [-0.4,0.4]
  assert.ok(Math.abs(bc.min[0] - -0.5) < 1e-9 && Math.abs(bc.max[0] - 0.5) < 1e-9)
  assert.ok(Math.abs(bc.min[1] - 0) < 1e-9, `底面应在 y=0，得到 ${bc.min[1]}`)
  assert.ok(Math.abs(bc.max[1] - 1.2) < 1e-9, `高度应为 1.2m，得到 ${bc.max[1]}`)
  assert.ok(Math.abs(bc.min[2] - -0.4) < 1e-9 && Math.abs(bc.max[2] - 0.4) < 1e-9)
  assert.equal(insp.stats.vertices, 8)
})

test('米制 +Y 单位变换为恒等（除底面平移）', () => {
  const glb = buildGlb({ min: [-0.5, 0, -0.4], max: [0.5, 1.2, 0.4] })
  const insp = inspectGlb(glb, { metersPerUnit: 1, up: '+Y' })
  const bc = insp.boundsCanonical!
  assert.ok(Math.abs(bc.max[1] - 1.2) < 1e-9)
  assert.ok(Math.abs(bc.min[1]) < 1e-9)
})

test('压缩扩展与外部引用检测', () => {
  assert.ok(COMPRESSED_EXTENSIONS.has('KHR_draco_mesh_compression'))
  const compressed = inspectGlb(buildGlb({ min: [0, 0, 0], max: [1, 1, 1] }, { extensionsUsed: ['KHR_draco_mesh_compression'] }), { metersPerUnit: 1, up: '+Y' })
  assert.ok(compressed.extensionsUsed.includes('KHR_draco_mesh_compression'))
  const external = inspectGlb(buildGlb({ min: [0, 0, 0], max: [1, 1, 1] }, { externalBuffer: true }), { metersPerUnit: 1, up: '+Y' })
  assert.deepEqual(external.externalRefs, ['external.bin'])
  const skinned = inspectGlb(buildGlb({ min: [0, 0, 0], max: [1, 1, 1] }, { skins: true }), { metersPerUnit: 1, up: '+Y' })
  assert.equal(skinned.stats.skins, 1)
})

test('轴变换与规范化矩阵（纯数据实现）', () => {
  const a = axisUnitTransform({ metersPerUnit: 0.01, up: '+Z' })
  const pt = (m: Float64Array, p: [number, number, number]): [number, number, number] => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ]
  const out = pt(a, [100, 200, 300])
  assert.ok(Math.abs(out[0] - 1) < 1e-12)
  assert.ok(Math.abs(out[1] - 3) < 1e-12)
  assert.ok(Math.abs(out[2] - -2) < 1e-12)

  const { n } = canonicalTransform({ metersPerUnit: 1, up: '+Y' }, { min: [-1, 0, -1], max: [1, 2, 1] })
  const bottom = pt(n, [0, 0, 0])
  assert.ok(Math.abs(bottom[1] - 0) < 1e-12, '底面中心应映射到 y=0')
  // x/z 中心已在 0，N 不再平移；仅当包围盒偏心时才平移
  const corner = pt(n, [1, 2, 1])
  assert.ok(Math.abs(corner[0] - 1) < 1e-12 && Math.abs(corner[1] - 2) < 1e-12)
  // 偏心包围盒：底面中心平移生效
  const { n: n2 } = canonicalTransform({ metersPerUnit: 1, up: '+Y' }, { min: [1, 5, 1], max: [3, 7, 3] })
  const shifted = pt(n2, [1, 5, 1])
  assert.ok(Math.abs(shifted[0] - -1) < 1e-12 && Math.abs(shifted[1]) < 1e-12 && Math.abs(shifted[2] - -1) < 1e-12)
})
