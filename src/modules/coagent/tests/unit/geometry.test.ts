/**
 * W08.3 几何单测：纯 Three 数学，不需要 WebGL。
 *
 * 覆盖 SPEC §6.5 的顺序：AABB 宽阶段 → 三角形相交 → 完全包含 → 接触容差/地面接触，
 * 以及缺对象、蒙皮/实例化、三角形超预算、开口网格等 unknown 分支。
 */

import { describe, expect, it } from 'vitest'
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, InstancedMesh, Mesh, MeshBasicMaterial, Scene } from 'three'
import type { GeometryRequest } from '../../contracts'
import { checkSceneGeometry, type GeometryOptions } from '../../rendering/geometry'

const material = new MeshBasicMaterial()

function box(id: string, size: [number, number, number], position: [number, number, number], rotationY = 0): Mesh {
  const m = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material)
  m.userData.assetId = id
  m.position.set(position[0], position[1], position[2])
  m.rotation.y = (rotationY * Math.PI) / 180
  m.updateMatrixWorld(true)
  return m
}

function sceneOf(...objects: Mesh[]): Scene {
  const scene = new Scene()
  for (const o of objects) scene.add(o)
  scene.updateMatrixWorld(true)
  return scene
}

const request = (objectIds: string[], statics: string[] = [], over: Partial<GeometryRequest> = {}): GeometryRequest => ({
  objectIds,
  staticObjectIds: statics,
  contactToleranceM: 0.01,
  allowGroundContact: false,
  ...over,
})

function triangle(id: string, points: number[]): Mesh {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(points, 3))
  const m = new Mesh(g, material)
  m.userData.assetId = id
  m.updateMatrixWorld(true)
  return m
}

describe('W08.3 宽阶段与三角形相交', () => {
  it('AABB 分离 → clear，级别 aabb', () => {
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]), box('b', [1, 1, 1], [5, 0.5, 0]))
    const result = checkSceneGeometry(scene, request(['a'], ['b']))
    expect(result.status).toBe('clear')
    expect(result.highestLevel).toBe('aabb')
    expect(result.pairs[0].level).toBe('aabb')
  })

  it('重叠立方体 → collision，级别 mesh', () => {
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]), box('b', [1, 1, 1], [0.5, 0.5, 0]))
    const result = checkSceneGeometry(scene, request(['a'], ['b']))
    expect(result.status).toBe('collision')
    expect(result.pairs[0].level).toBe('mesh')
  })

  it('旋转/缩放后的世界矩阵参与检测', () => {
    const scene = sceneOf(box('a', [2, 2, 2], [0, 1, 0]), box('b', [2, 2, 2], [1.2, 1, 0], 45))
    const result = checkSceneGeometry(scene, request(['a'], ['b']))
    expect(result.status).toBe('collision')
  })
})

describe('W08.3 完全包含', () => {
  it('小立方体完全在大立方体内部 → collision + mesh+containment', () => {
    const scene = sceneOf(box('outer', [4, 4, 4], [0, 2, 0]), box('inner', [1, 1, 1], [0, 2, 0]))
    const result = checkSceneGeometry(scene, request(['inner'], ['outer']))
    expect(result.status).toBe('collision')
    expect(result.pairs[0].level).toBe('mesh+containment')
    expect(result.pairs[0].note).toContain('完全位于')
  })

  it('开口网格无法证明包含 → unknown（不能宣称 clear）', () => {
    // A 的大三角形覆盖左下；B 的小三角形在右上，落在大三角形 AABB 内但不在三角形内
    const large = triangle('large', [0, 0, 0, 1, 0, 0, 0, 1, 0])
    const small = triangle('small', [0.8, 0.8, 0, 1, 0.8, 0, 0.8, 1, 0])
    const scene = sceneOf(large, small)
    const result = checkSceneGeometry(scene, request(['small'], ['large']))
    expect(result.status).toBe('unknown')
    expect(result.pairs[0].level).toBe('aabb')
  })
})

describe('W08.3 接触与地面接触', () => {
  it('间距在容差内 → collision（接触），带距离 note', () => {
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]), box('b', [1, 1, 1], [1.005, 0.5, 0]))
    const result = checkSceneGeometry(scene, request(['a'], ['b'], { contactToleranceM: 0.01 }))
    expect(result.status).toBe('collision')
    expect(result.pairs[0].note).toContain('接触')
  })

  it('allowGroundContact=true 且两者都落在地面 → clear（地面支撑接触放行）', () => {
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]), box('b', [1, 1, 1], [1.005, 0.5, 0]))
    const result = checkSceneGeometry(
      scene,
      request(['a'], ['b'], { contactToleranceM: 0.01, allowGroundContact: true }),
    )
    expect(result.status).toBe('clear')
    expect(result.pairs[0].note).toContain('地面支撑接触')
  })
})

describe('W08.3 unknown 分支', () => {
  it('对象不存在 → unknown', () => {
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]))
    const result = checkSceneGeometry(scene, request(['a'], ['nope']))
    expect(result.status).toBe('unknown')
    expect(result.pairs[0].note).toContain('找不到对象')
  })

  it('实例化网格 → unknown', () => {
    const inst = new InstancedMesh(new BoxGeometry(1, 1, 1), material, 1)
    inst.userData.assetId = 'inst'
    inst.updateMatrixWorld(true)
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]))
    scene.add(inst)
    const result = checkSceneGeometry(scene, request(['a'], ['inst']))
    expect(result.status).toBe('unknown')
    expect(result.pairs[0].note).toContain('实例化')
  })

  it('三角形超预算 → unknown', () => {
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]), box('b', [1, 1, 1], [0.2, 0.5, 0]))
    const result = checkSceneGeometry(scene, request(['a'], ['b']), { maxTrianglesPerObject: 4 } satisfies GeometryOptions)
    expect(result.status).toBe('unknown')
    expect(result.pairs[0].note).toContain('预算')
  })

  it('少于两个对象 → unknown（没有可验证的对象对）', () => {
    const scene = sceneOf(box('a', [1, 1, 1], [0, 0.5, 0]))
    const result = checkSceneGeometry(scene, request(['a']))
    expect(result.status).toBe('unknown')
    expect(result.pairs).toEqual([])
  })
})
