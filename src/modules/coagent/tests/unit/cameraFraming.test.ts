/**
 * P2 取景几何：`focusCamera` 算出的相机能否把目标**完整框进画面**。
 *
 * 判定器"看不清新增房屋"的直接原因就是取景——目标被裁掉一半，模型再怎么判也判不准。
 * 这条不需要浏览器：相机与包围盒都是纯数学，用视锥包含性就能证伪。
 */

import { describe, expect, it } from 'vitest'
import type { CameraSnapshot, Vec3 } from '../../contracts'
import { focusCamera } from '../../tools/cameraTools'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { TWO_REGION_ASSETS, makeTwoRegionPartition } from '../fixtures/twoRegionScene'
import { modelWorldBounds } from '../../../../shared/modelBounds'

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** 8 个角是否都落在视锥内（含近平面之前） */
function frustumContains(camera: CameraSnapshot, box: { min: Vec3; max: Vec3 }): { inside: boolean; worst: number } {
  const forward = norm(sub(camera.target, camera.position))
  const right = norm(cross(forward, camera.up))
  const up = cross(right, forward)
  const fov = ((camera.fovDeg ?? 50) * Math.PI) / 180
  const tanHalf = Math.tan(fov / 2)
  const aspect = camera.aspect || 4 / 3

  let worst = 0
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const v = sub([x, y, z], camera.position)
        const depth = dot(v, forward)
        if (depth <= camera.near) worst = Math.max(worst, 99)
        const halfH = depth * tanHalf
        const halfW = halfH * aspect
        // 归一化到 [-1,1]，>1 表示出画
        const nx = halfW > 0 ? Math.abs(dot(v, right)) / halfW : 99
        const ny = halfH > 0 ? Math.abs(dot(v, up)) / halfH : 99
        worst = Math.max(worst, nx, ny)
      }
    }
  }
  return { inside: worst <= 1, worst }
}

describe('P2 取景：聚焦目标不被裁掉', () => {
  const partition = makeTwoRegionPartition()

  it('focusCamera 把目标包围盒完整框进画面（tight 与 context 都成立）', () => {
    const ctx = createFakeWorkflowContext({ partition })
    for (const id of ['tree-1', 'house-1']) {
      const asset = ctx.editorRead.snapshot({ objectIds: [id] }).assets[0]
      expect(asset?.catalog, `${id} 缺少 catalog，无法算包围盒`).toBeTruthy()
      const box = modelWorldBounds(asset.catalog!, asset.transform)

      for (const framing of ['tight', 'context'] as const) {
        // 用 inspectWith 的实际取景倍数（不是随手挑的常数）
        const camera = focusCamera(ctx, [id], framing === 'tight' ? 2.1 : 2.9)
        const res = frustumContains(camera, box)
        expect(res.inside, `${id}/${framing} 有角点出画（归一化最差 ${res.worst.toFixed(2)}）`).toBe(true)
        // 也不能退到看不见：目标至少要占画面的一小部分
        expect(res.worst).toBeLessThan(0.95)
      }
    }
  })

  it('tight 比 context 更近（聚焦更紧）', () => {
    const ctx = createFakeWorkflowContext({ partition })
    const distOf = (camera: CameraSnapshot): number => Math.hypot(...sub(camera.position, camera.target))
    const tight = distOf(focusCamera(ctx, ['tree-1'], 1.5))
    const context = distOf(focusCamera(ctx, ['tree-1'], 2.4))
    expect(tight).toBeLessThan(context)
  })

  it('多对象聚焦取并集包围盒，两个目标都在画面内', () => {
    const ctx = createFakeWorkflowContext({ partition })
    const ids = ['tree-1', 'tree-2']
    const camera = focusCamera(ctx, ids, 2.0)
    for (const id of ids) {
      const asset = ctx.editorRead.snapshot({ objectIds: [id] }).assets[0]
      const box = modelWorldBounds(asset.catalog!, asset.transform)
      expect(frustumContains(camera, box).inside, `${id} 出画`).toBe(true)
    }
  })

  it('对象不存在 → asset_not_found（不编造相机）', () => {
    const ctx = createFakeWorkflowContext({ partition })
    expect(() => focusCamera(ctx, ['ghost'], 2)).toThrowError(/聚焦对象不存在|asset_not_found/)
  })
})

void TWO_REGION_ASSETS
