/**
 * P2 拾取单测：真实 three 场景 + 观测相机，不需要 WebGL。
 *
 * 断言的是"点到的"和"看到的"是同一件事：
 * - 用观测相机（而非主视口）做射线；
 * - 正交与透视都要命中同一个对象；
 * - 辅助件、不可见对象不参与；
 * - 空命中是正常结果，不吸附。
 */

import { describe, expect, it } from 'vitest'
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene } from 'three'
import type { CameraSnapshot } from '../../contracts'
import { pickFromSnapshot } from '../../rendering/pick'

const material = new MeshBasicMaterial()

function box(id: string, size: [number, number, number], position: [number, number, number]): Mesh {
  const m = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material)
  m.userData.assetId = id
  m.position.set(...position)
  m.updateMatrixWorld(true)
  return m
}

function sceneOf(...objects: Mesh[]): Scene {
  const scene = new Scene()
  for (const o of objects) scene.add(o)
  scene.updateMatrixWorld(true)
  return scene
}

const ORTHO: CameraSnapshot = {
  schemaVersion: 1,
  id: 'cam-ortho-test',
  projection: 'orthographic',
  position: [0, 20, 0],
  target: [0, 0, 0],
  up: [0, 0, -1],
  near: 0.1,
  far: 100,
  aspect: 4 / 3,
  ortho: { left: -10, right: 10, top: 7.5, bottom: -7.5 },
}

const PERSP: CameraSnapshot = {
  schemaVersion: 1,
  id: 'cam-persp-test',
  projection: 'perspective',
  position: [0, 20, 0],
  target: [0, 0, 0],
  up: [0, 0, -1],
  near: 0.1,
  far: 100,
  aspect: 4 / 3,
  fovDeg: 50,
}

const req = (u: number, v: number, camera: CameraSnapshot = ORTHO, width = 640, height = 480) => ({
  camera,
  width,
  height,
  u,
  v,
})

describe('P2 拾取：正交相机（区域俯视图）', () => {
  it('画面中心的物体被命中，返回 id 与命中点', () => {
    const scene = sceneOf(box('target', [2, 2, 2], [0, 0, 0]))
    const res = pickFromSnapshot(scene, req(0.5, 0.5))
    expect(res.hit?.objectId).toBe('target')
    // 命中点在盒顶面（y=1）附近
    expect(res.hit!.point[1]).toBeCloseTo(1, 3)
  })

  it('u 向右：x=+5 的物体在 u≈0.75 命中，u≈0.25 不命中', () => {
    const scene = sceneOf(box('right', [2, 2, 2], [5, 0, 0]))
    // ortho 半宽 10 → x=+5 对应 u = 0.5 + 5/20
    expect(pickFromSnapshot(scene, req(0.75, 0.5)).hit?.objectId).toBe('right')
    expect(pickFromSnapshot(scene, req(0.25, 0.5)).hit).toBeNull()
  })

  it('v 向下：z 轴的符号与 up=(0,0,-1) 一致', () => {
    // up=(0,0,-1) 时，屏幕下方对应 +z
    const scene = sceneOf(box('south', [2, 2, 2], [0, 0, 5]))
    expect(pickFromSnapshot(scene, req(0.5, 0.5 + 5 / 15)).hit?.objectId).toBe('south')
  })

  it('多个物体时返回最近的（前方遮挡优先，不穿过）', () => {
    const near = box('near', [2, 2, 2], [0, 1, 0])
    const far = box('far', [2, 2, 2], [0, -3, 0])
    const scene = sceneOf(near, far)
    const res = pickFromSnapshot(scene, req(0.5, 0.5))
    expect(res.hit?.objectId).toBe('near')
  })
})

describe('P2 拾取：透视相机（自由观察）', () => {
  it('正上方俯视时画面中心命中同一对象', () => {
    const scene = sceneOf(box('target', [2, 2, 2], [0, 0, 0]))
    expect(pickFromSnapshot(scene, req(0.5, 0.5, PERSP)).hit?.objectId).toBe('target')
  })

  it('正交与透视在同一画幅比例下命中同一个对象', () => {
    const scene = sceneOf(box('target', [4, 2, 4], [0, 0, 0]))
    const a = pickFromSnapshot(scene, req(0.5, 0.5, ORTHO))
    const b = pickFromSnapshot(scene, req(0.5, 0.5, PERSP))
    expect(a.hit?.objectId).toBe(b.hit?.objectId)
  })
})

describe('P2 拾取：排除与空命中', () => {
  it('编辑辅助件不参与拾取', () => {
    const helper = box('helper-shell', [4, 4, 4], [0, 0, 0])
    helper.userData.editorHelper = true
    const real = box('real', [2, 2, 2], [0, 0, 0])
    const scene = sceneOf(helper, real)
    expect(pickFromSnapshot(scene, req(0.5, 0.5)).hit?.objectId).toBe('real')
  })

  it('不可见对象不参与拾取', () => {
    const hidden = box('hidden', [4, 4, 4], [0, 0, 0])
    hidden.visible = false
    const real = box('real', [2, 2, 2], [0, 0, 0])
    const scene = sceneOf(hidden, real)
    expect(pickFromSnapshot(scene, req(0.5, 0.5)).hit?.objectId).toBe('real')
  })

  it('没有 assetId 的对象（地面/网格）不产生命中', () => {
    const ground = new Mesh(new BoxGeometry(40, 0.1, 40), material)
    ground.position.set(0, -5, 0)
    const scene = sceneOf(ground as Mesh)
    expect(pickFromSnapshot(scene, req(0.5, 0.5)).hit).toBeNull()
  })

  it('空白处 → hit=null（不吸附最近物体）', () => {
    const scene = sceneOf(box('target', [1, 1, 1], [0, 0, 0]))
    expect(pickFromSnapshot(scene, req(0.05, 0.05)).hit).toBeNull()
  })

  it('沿父链找到 assetId（对象挂在资产根的子节点上）', () => {
    const root = new Mesh(new BoxGeometry(1, 1, 1), material)
    root.userData.assetId = 'parent-asset'
    const child = new Mesh(new BoxGeometry(2, 2, 2), material)
    child.position.set(0, 0, 0)
    root.add(child)
    const scene = sceneOf(root)
    expect(pickFromSnapshot(scene, req(0.5, 0.5)).hit?.objectId).toBe('parent-asset')
  })
})
