/**
 * geometry（W08.3，SPEC §6.5）——真实世界几何碰撞检测，不依赖 WebGL。
 *
 * 算法顺序（与 SPEC 一致）：
 *   1. 世界 AABB 宽阶段：分离就 clear，不进入三角形；
 *   2. 三角形窄阶段：SAT 三角形相交；
 *   3. 完全包含：AABB 包含 + 闭合网格顶点在对方内部；没有闭合性证据就 unknown；
 *   4. 接触容差：最近三角形距离 ≤ tolerance 视为接触（地面支撑接触可由
 *      allowGroundContact 放行）；
 *   5. 不支持/超预算一律 unknown，绝不把"没算"说成 clear。
 *
 * 重要边界：
 * - 只读共享 geometry，只写自己的世界三角形缓存（不修改资产几何，§6.5）；
 * - 顶点预算：大模型或超多三角形会返回 unknown 而不是卡死页面；
 * - 蒙皮/实例化/缺少 position 的网格返回 unknown；
 * - 不含退化三角形；退化到没有三角形也算 unknown。
 *
 * 本文件属于 rendering 边界，可以 import three；不 import core/react。
 */

import { InstancedMesh, Mesh, SkinnedMesh, type Object3D, type Scene } from 'three'
import type { GeometryCheckLevel, GeometryPairResult, GeometryRequest, GeometryResult, ObjectId } from '../contracts'

type Vec3 = [number, number, number]

type Aabb = {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/** 9 个数字：A(3) B(3) C(3)，世界坐标 */
type Tri = {
  v: [number, number, number, number, number, number, number, number, number]
  box: Aabb
}

type Prepared =
  | { kind: 'ok'; id: ObjectId; aabb: Aabb; tris: Tri[]; closed: boolean }
  | { kind: 'missing'; id: ObjectId; note: string }
  | { kind: 'unsupported'; id: ObjectId; note: string }
  /** 不可见/无几何：不参与碰撞，但不冒充"检查过" */
  | { kind: 'empty'; id: ObjectId; note: string }

export interface GeometryOptions {
  /** 单个对象最多参与检测的三角形数；超过返回 unknown（默认 20000） */
  maxTrianglesPerObject?: number
  /** 一次检测最多做多少次三角形对测试；超过返回 unknown（默认 500000） */
  maxTrianglePairTests?: number
  /** 包含检测最多采样多少个内层顶点（默认 2000） */
  maxContainmentVertices?: number
  /** 单侧（targets 或 statics）最多参与检测的对象数；超过返回覆盖不足（默认 64） */
  maxObjectsPerCheck?: number
  /** 最多生成的配对数量；超过返回覆盖不足（默认 4096） */
  maxPairsPerCheck?: number
}

const DEFAULTS: Required<GeometryOptions> = {
  maxTrianglesPerObject: 20_000,
  maxTrianglePairTests: 500_000,
  maxContainmentVertices: 2_000,
  maxObjectsPerCheck: 64,
  maxPairsPerCheck: 4_096,
}

const EPS = 1e-7
const AREA_EPS = 1e-12
const CLOSED_EDGE_LIMIT = 20_000

// ---------------------------------------------------------------------------
// 向量/包围盒工具
// ---------------------------------------------------------------------------

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}

function normalize(a: Vec3): Vec3 {
  const l = length(a)
  return l <= EPS ? [0, 0, 0] : scale(a, 1 / l)
}

function emptyAabb(): Aabb {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
}

function expandAabb(box: Aabb, x: number, y: number, z: number): void {
  if (x < box.minX) box.minX = x
  if (y < box.minY) box.minY = y
  if (z < box.minZ) box.minZ = z
  if (x > box.maxX) box.maxX = x
  if (y > box.maxY) box.maxY = y
  if (z > box.maxZ) box.maxZ = z
}

function aabbOfTri(v: Tri['v']): Aabb {
  const box = emptyAabb()
  for (let i = 0; i < 9; i += 3) expandAabb(box, v[i], v[i + 1], v[i + 2])
  return box
}

/** AABB 间的最大分离距离（0 = 相交/接触） */
function aabbGap(a: Aabb, b: Aabb): number {
  return Math.max(
    0,
    a.minX - b.maxX,
    b.minX - a.maxX,
    a.minY - b.maxY,
    b.minY - a.maxY,
    a.minZ - b.maxZ,
    b.minZ - a.maxZ,
  )
}

function aabbContains(outer: Aabb, inner: Aabb, tol: number): boolean {
  return (
    inner.minX >= outer.minX - tol &&
    inner.maxX <= outer.maxX + tol &&
    inner.minY >= outer.minY - tol &&
    inner.maxY <= outer.maxY + tol &&
    inner.minZ >= outer.minZ - tol &&
    inner.maxZ <= outer.maxZ + tol
  )
}

function triAabbOverlap(a: Tri, b: Tri, tol: number): boolean {
  return aabbGap(a.box, b.box) <= tol
}

// ---------------------------------------------------------------------------
// 准备对象：世界三角形、AABB、闭合性
// ---------------------------------------------------------------------------

interface PrepareCacheEntry {
  key: string
  prepared: Prepared
}

const prepareCache = new WeakMap<Object3D, PrepareCacheEntry>()

function objectCacheKey(root: Object3D, maxTriangles: number): string {
  const parts: string[] = [String(maxTriangles)]
  const walk = (o: Object3D): void => {
    if (!o.visible || o.userData?.editorHelper) return
    const m = o as Mesh
    if ((m as unknown as { isMesh?: boolean }).isMesh) {
      const g = m.geometry
      parts.push(
        `${m.uuid}:${g.uuid}:${String((g.attributes.position as { version?: number } | undefined)?.version ?? 0)}:${m.matrixWorld.elements.join(',')}`,
      )
    }
    for (const c of o.children) walk(c)
  }
  walk(root)
  return parts.join('|')
}

function collectRoots(scene: Scene, ids: ObjectId[]): Map<ObjectId, Object3D> {
  const wanted = new Set(ids)
  const found = new Map<ObjectId, Object3D>()
  // 不能用 scene.traverse：editorHelper（选中描边壳）是资产根的子节点，
  // 它的克隆可能带同一个 assetId；必须整棵 helper 子树跳过，否则会拿到空壳。
  const walk = (o: Object3D): void => {
    if (o.userData?.editorHelper) return
    const id = o.userData?.assetId
    if (typeof id === 'string' && wanted.has(id) && !found.has(id)) found.set(id, o)
    for (const c of o.children) walk(c)
  }
  walk(scene)
  return found
}

function prepareObject(root: Object3D | undefined, id: ObjectId, maxTriangles: number): Prepared {
  if (!root) return { kind: 'missing', id, note: `场景中找不到对象 ${id}` }

  const key = objectCacheKey(root, maxTriangles)
  const cached = prepareCache.get(root)
  if (cached && cached.key === key) return cached.prepared

  const tris: Tri[] = []
  const aabb = emptyAabb()
  let unsupported: string | null = null

  const walk = (o: Object3D): void => {
    if (unsupported) return
    if (!o.visible || o.userData?.editorHelper) return
    const mesh = o as Mesh
    if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
      if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh || (o as SkinnedMesh).isSkinnedMesh) {
        unsupported = `对象 ${id} 含蒙皮网格，几何检测返回 unknown`
        return
      }
      if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh || (o as InstancedMesh).isInstancedMesh) {
        unsupported = `对象 ${id} 含实例化网格，几何检测返回 unknown`
        return
      }
      const g = mesh.geometry
      const pos = g?.attributes?.position
      if (!g || !pos) {
        unsupported = `对象 ${id} 的网格缺少 position，几何检测返回 unknown`
        return
      }
      const index = g.index
      const count = index ? index.count : pos.count
      if (count < 3) {
        unsupported = `对象 ${id} 的网格没有三角形`
        return
      }
      const triangleCount = Math.floor(count / 3)
      if (tris.length + triangleCount > maxTriangles) {
        unsupported = `对象 ${id} 三角形数超过预算 ${maxTriangles}，几何检测返回 unknown`
        return
      }
      const e = mesh.matrixWorld.elements
      const world = (i: number): Vec3 => {
        const vi = index ? index.getX(i) : i
        const x = pos.getX(vi)
        const y = pos.getY(vi)
        const z = pos.getZ(vi)
        return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]
      }
      for (let t = 0; t < count; t += 3) {
        const a = world(t)
        const b = world(t + 1)
        const c = world(t + 2)
        const area2 = length(cross(sub(b, a), sub(c, a)))
        if (area2 <= AREA_EPS) continue // 退化三角形
        const v: Tri['v'] = [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]]
        tris.push({ v, box: aabbOfTri(v) })
        for (let i = 0; i < 9; i += 3) expandAabb(aabb, v[i], v[i + 1], v[i + 2])
      }
      return
    }
    for (const c of o.children) walk(c)
  }

  walk(root)

  let prepared: Prepared
  if (unsupported) prepared = { kind: 'unsupported', id, note: unsupported }
  else if (tris.length === 0) prepared = { kind: 'empty', id, note: `对象 ${id} 没有可见网格` }
  else {
    prepared = { kind: 'ok', id, aabb, tris, closed: isClosed(tris) }
  }
  prepareCache.set(root, { key, prepared })
  return prepared
}

/** 闭合性：每条无向边出现偶数次（2=正常、4=非流形但仍闭合）；超过预算按不闭合处理 */
function isClosed(tris: Tri[]): boolean {
  if (tris.length > CLOSED_EDGE_LIMIT) return false
  const counts = new Map<string, number>()
  const keyOf = (x: number, y: number, z: number): string => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`
  for (const t of tris) {
    const p = [
      [t.v[0], t.v[1], t.v[2]],
      [t.v[3], t.v[4], t.v[5]],
      [t.v[6], t.v[7], t.v[8]],
    ]
    for (let i = 0; i < 3; i++) {
      const a = keyOf(p[i][0], p[i][1], p[i][2])
      const b = keyOf(p[(i + 1) % 3][0], p[(i + 1) % 3][1], p[(i + 1) % 3][2])
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  for (const c of counts.values()) if (c % 2 !== 0) return false
  return true
}

// ---------------------------------------------------------------------------
// 三角形相交（SAT）与共面 2D 兜底
// ---------------------------------------------------------------------------

function triVerts(t: Tri): [Vec3, Vec3, Vec3] {
  return [
    [t.v[0], t.v[1], t.v[2]],
    [t.v[3], t.v[4], t.v[5]],
    [t.v[6], t.v[7], t.v[8]],
  ]
}

function triNormal(t: Tri): Vec3 {
  const [a, b, c] = triVerts(t)
  return normalize(cross(sub(b, a), sub(c, a)))
}

function projectInterval(pts: Vec3[], axis: Vec3): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const p of pts) {
    const d = dot(p, axis)
    if (d < min) min = d
    if (d > max) max = d
  }
  return [min, max]
}

function separatedOnAxis(a: Vec3[], b: Vec3[], axis: Vec3, eps: number): boolean {
  if (length(axis) <= EPS) return false
  const [amin, amax] = projectInterval(a, axis)
  const [bmin, bmax] = projectInterval(b, axis)
  return amax < bmin - eps || bmax < amin - eps
}

function coplanarTriOverlap(a: Tri, b: Tri, n: Vec3): boolean {
  // 选法向最大的分量做投影轴，保留另外两轴
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  const drop = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2
  const p2 = (v: Vec3): [number, number] => (drop === 0 ? [v[1], v[2]] : drop === 1 ? [v[0], v[2]] : [v[0], v[1]])
  const A = triVerts(a).map(p2)
  const B = triVerts(b).map(p2)

  const orient = (o: [number, number], p: [number, number], q: [number, number]): number =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const segIntersect = (p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number]): boolean => {
    const d1 = orient(p3, p4, p1)
    const d2 = orient(p3, p4, p2)
    const d3 = orient(p1, p2, p3)
    const d4 = orient(p1, p2, p4)
    return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  }
  const inTri = (p: [number, number], t: Array<[number, number]>): boolean => {
    const d1 = orient(t[0], t[1], p)
    const d2 = orient(t[1], t[2], p)
    const d3 = orient(t[2], t[0], p)
    return (d1 >= -EPS && d2 >= -EPS && d3 >= -EPS) || (d1 <= EPS && d2 <= EPS && d3 <= EPS)
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (segIntersect(A[i], A[(i + 1) % 3], B[j], B[(j + 1) % 3])) return true
    }
  }
  return inTri(A[0], B) || inTri(B[0], A)
}

/** 三角形相交；共面时退化为 2D 重叠测试 */
export function trianglesIntersect(a: Tri, b: Tri, eps = 1e-6): boolean {
  const A = triVerts(a)
  const B = triVerts(b)
  const na = triNormal(a)
  const nb = triNormal(b)
  if (length(na) <= EPS || length(nb) <= EPS) return false

  if (Math.abs(Math.abs(dot(na, nb)) - 1) <= 1e-6) {
    const dist = Math.abs(dot(sub(B[0], A[0]), na))
    if (dist <= eps) return coplanarTriOverlap(a, b, na)
  }

  // 平面侧测试
  let pos = 0
  let neg = 0
  for (const p of B) {
    const d = dot(sub(p, A[0]), na)
    if (d > eps) pos++
    else if (d < -eps) neg++
  }
  if (pos === 3 || neg === 3) return false

  pos = 0
  neg = 0
  for (const p of A) {
    const d = dot(sub(p, B[0]), nb)
    if (d > eps) pos++
    else if (d < -eps) neg++
  }
  if (pos === 3 || neg === 3) return false

  // 9 条边叉积轴
  for (let i = 0; i < 3; i++) {
    const ea = sub(A[(i + 1) % 3], A[i])
    for (let j = 0; j < 3; j++) {
      const eb = sub(B[(j + 1) % 3], B[j])
      if (separatedOnAxis(A, B, cross(ea, eb), eps)) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// 距离（接触分类）
// ---------------------------------------------------------------------------

function pointTriangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(p, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return length(ap)

  const bp = sub(p, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return length(bp)

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return length(sub(p, add(a, scale(ab, v))))
  }

  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return length(cp)

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return length(sub(p, add(a, scale(ac, w))))
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return length(sub(p, add(b, scale(sub(c, b), w))))
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return length(sub(p, add(a, add(scale(ab, v), scale(ac, w)))))
}

function segmentSegmentDistance(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1)
  const d2 = sub(q2, p2)
  const r = sub(p1, p2)
  const a = dot(d1, d1)
  const e = dot(d2, d2)
  const f = dot(d2, r)
  let s: number
  let t: number
  if (a <= EPS && e <= EPS) return length(r)
  if (a <= EPS) {
    s = 0
    t = Math.max(0, Math.min(1, f / e))
  } else {
    const c = dot(d1, r)
    if (e <= EPS) {
      t = 0
      s = Math.max(0, Math.min(1, -c / a))
    } else {
      const b = dot(d1, d2)
      const denom = a * e - b * b
      s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = Math.max(0, Math.min(1, -c / a))
      } else if (t > 1) {
        t = 1
        s = Math.max(0, Math.min(1, (b - c) / a))
      }
    }
  }
  return length(sub(add(p1, scale(d1, s)), add(p2, scale(d2, t))))
}

/** 两个三角形的最小距离（顶点-面 + 边-边，覆盖三角形所有最近特征） */
export function triangleDistance(a: Tri, b: Tri): number {
  const A = triVerts(a)
  const B = triVerts(b)
  let min = Infinity
  for (const p of A) min = Math.min(min, pointTriangleDistance(p, B[0], B[1], B[2]))
  for (const p of B) min = Math.min(min, pointTriangleDistance(p, A[0], A[1], A[2]))
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      min = Math.min(min, segmentSegmentDistance(A[i], A[(i + 1) % 3], B[j], B[(j + 1) % 3]))
    }
  }
  return min
}

// ---------------------------------------------------------------------------
// 包含检测
// ---------------------------------------------------------------------------

function rayTriangleT(origin: Vec3, dir: Vec3, t: Tri): number | null {
  const [a, b, c] = triVerts(t)
  const e1 = sub(b, a)
  const e2 = sub(c, a)
  const p = cross(dir, e2)
  const det = dot(e1, p)
  if (Math.abs(det) < 1e-9) return null
  const inv = 1 / det
  const tv = sub(origin, a)
  const u = dot(tv, p) * inv
  if (u < 0 || u > 1) return null
  const q = cross(tv, e1)
  const v = dot(dir, q) * inv
  if (v < 0 || u + v > 1) return null
  const tHit = dot(e2, q) * inv
  return tHit > EPS ? tHit : null
}

function pointInMesh(point: Vec3, mesh: Extract<Prepared, { kind: 'ok' }>): 'inside' | 'outside' | 'unknown' {
  // 三条非轴对齐射线：单条射线可能正好穿过共享边/顶点，命中数不可靠。
  // 三条都同号才给结论，否则 unknown（包含检测宁可 unknown，不冒充 clear）。
  const dirs: Vec3[] = [normalize([0.573, 0.617, 0.539]), normalize([0.271, 0.731, 0.626]), normalize([0.811, 0.197, 0.551])]
  const results = dirs.map(dir => {
    let hits = 0
    for (const t of mesh.tris) if (rayTriangleT(point, dir, t) !== null) hits++
    return hits % 2 === 1
  })
  if (results.every(v => v)) return 'inside'
  if (results.every(v => !v)) return 'outside'
  return 'unknown'
}

type Containment = 'none' | 'yes' | 'unknown'

function containmentOf(inner: Extract<Prepared, { kind: 'ok' }>, outer: Extract<Prepared, { kind: 'ok' }>, tol: number, maxVertices: number): Containment {
  if (!aabbContains(outer.aabb, inner.aabb, tol)) return 'none'
  if (!inner.closed || !outer.closed) return 'unknown'
  const vertices = new Map<string, Vec3>()
  for (const t of inner.tris) {
    for (let i = 0; i < 9; i += 3) {
      const key = `${Math.round(t.v[i] * 1e4)},${Math.round(t.v[i + 1] * 1e4)},${Math.round(t.v[i + 2] * 1e4)}`
      if (!vertices.has(key)) vertices.set(key, [t.v[i], t.v[i + 1], t.v[i + 2]])
    }
    if (vertices.size > maxVertices) return 'unknown'
  }
  for (const v of vertices.values()) {
    const inside = pointInMesh(v, outer)
    if (inside === 'outside') return 'none'
    if (inside === 'unknown') return 'unknown'
  }
  return 'yes'
}

// ---------------------------------------------------------------------------
// 单对象对检测
// ---------------------------------------------------------------------------

interface Budget {
  left: number
}

function levelMax(a: GeometryCheckLevel, b: GeometryCheckLevel): GeometryCheckLevel {
  const rank: Record<GeometryCheckLevel, number> = { aabb: 0, mesh: 1, 'mesh+containment': 2 }
  return rank[a] >= rank[b] ? a : b
}

function pairUnknown(a: ObjectId, b: ObjectId, note: string): GeometryPairResult {
  return { a, b, status: 'unknown', level: 'aabb', note }
}

function checkPair(
  a: Prepared,
  b: Prepared,
  request: GeometryRequest,
  tol: number,
  opts: Required<GeometryOptions>,
  budget: Budget,
): GeometryPairResult {
  if (a.kind === 'missing' || b.kind === 'missing') {
    return pairUnknown(a.id, b.id, `${a.kind === 'missing' ? a.note : b.kind === 'missing' ? b.note : ''}`)
  }
  if (a.kind === 'unsupported' || b.kind === 'unsupported') {
    return pairUnknown(a.id, b.id, a.kind === 'unsupported' ? a.note : b.kind === 'unsupported' ? b.note : '')
  }
  if (a.kind === 'empty' || b.kind === 'empty') {
    return { a: a.id, b: b.id, status: 'clear', level: 'aabb', note: '对象不可见/无可见网格，按不参与碰撞处理' }
  }

  // ---- 1. 宽阶段 ----
  const gap = aabbGap(a.aabb, b.aabb)
  if (gap > tol) return { a: a.id, b: b.id, status: 'clear', level: 'aabb', note: `AABB 分离 ${gap.toFixed(3)}m` }

  // ---- 2. 窄阶段：三角形相交 ----
  for (const ta of a.tris) {
    for (const tb of b.tris) {
      if (!triAabbOverlap(ta, tb, tol)) continue
      if (budget.left-- <= 0) return pairUnknown(a.id, b.id, `三角形对测试超过预算 ${opts.maxTrianglePairTests}，几何检测返回 unknown`)
      if (trianglesIntersect(ta, tb)) {
        return { a: a.id, b: b.id, status: 'collision', level: 'mesh', note: '三角形相交' }
      }
    }
  }

  // ---- 3. 完全包含 ----
  if (aabbContains(a.aabb, b.aabb, tol) || aabbContains(b.aabb, a.aabb, tol)) {
    const bInA = containmentOf(b, a, tol, opts.maxContainmentVertices)
    if (bInA === 'yes') return { a: a.id, b: b.id, status: 'collision', level: 'mesh+containment', note: `${b.id} 完全位于 ${a.id} 内部` }
    if (bInA === 'unknown') return pairUnknown(a.id, b.id, '包含检测需要闭合网格，当前网格闭合性未知')
    const aInB = containmentOf(a, b, tol, opts.maxContainmentVertices)
    if (aInB === 'yes') return { a: a.id, b: b.id, status: 'collision', level: 'mesh+containment', note: `${a.id} 完全位于 ${b.id} 内部` }
    if (aInB === 'unknown') return pairUnknown(a.id, b.id, '包含检测需要闭合网格，当前网格闭合性未知')
  }

  // ---- 4. 接触：最近三角形距离 ----
  let minDist = Infinity
  for (const ta of a.tris) {
    for (const tb of b.tris) {
      const boxGap = aabbGap(ta.box, tb.box)
      if (boxGap > tol) continue
      if (budget.left-- <= 0) return pairUnknown(a.id, b.id, `三角形对测试超过预算 ${opts.maxTrianglePairTests}，几何检测返回 unknown`)
      minDist = Math.min(minDist, triangleDistance(ta, tb))
      if (minDist <= tol) break
    }
    if (minDist <= tol) break
  }

  if (minDist <= tol) {
    const ground = Math.abs(a.aabb.minY) <= tol && Math.abs(b.aabb.minY) <= tol
    if (request.allowGroundContact && ground) {
      return { a: a.id, b: b.id, status: 'clear', level: 'mesh', note: `地面支撑接触（≤${tol}m），按配置放行` }
    }
    return { a: a.id, b: b.id, status: 'collision', level: 'mesh', note: `接触距离 ${minDist.toFixed(4)}m ≤ 容差 ${tol}m` }
  }

  return { a: a.id, b: b.id, status: 'clear', level: 'mesh', note: '无三角形相交、无包含、间距大于容差' }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 入口。
 *
 * 配对范围（本轮修订）：只查 targets×targets（去重）与 targets×statics，
 * **不查 statics×statics**——原场景里静态物之间的旧碰撞与本任务无关，
 * 把静态×静态算进来会让"新对象摆对了也过不了"。
 *
 * 覆盖不足一律 unknown，绝不伪报 clear：对象数或配对数被上限截断、
 * 三角形预算耗尽时，结果里都带 coverage 说明谁没被检查。
 */
export function checkSceneGeometry(scene: Scene, request: GeometryRequest, options: GeometryOptions = {}): GeometryResult {
  const opts = { ...DEFAULTS, ...options }
  scene.updateMatrixWorld(true)

  const uniq = (ids: ObjectId[]): ObjectId[] => [...new Set(ids)]
  const targetIds = uniq(request.objectIds)
  const targetSet = new Set(targetIds)
  // 与目标重复的 id 不再当环境，避免自己和自己配对
  const staticIds = uniq(request.staticObjectIds ?? []).filter(id => !targetSet.has(id))

  const skipped: Array<{ objectId: ObjectId; reason: string }> = []
  const cap = Math.max(1, opts.maxObjectsPerCheck)
  const cappedTargets = targetIds.slice(0, cap)
  for (const id of targetIds.slice(cap)) skipped.push({ objectId: id, reason: `超过单次检测目标上限 ${cap}，未参与检测` })
  const cappedStatics = staticIds.slice(0, cap)
  for (const id of staticIds.slice(cap)) skipped.push({ objectId: id, reason: `超过单次检测环境对象上限 ${cap}，未参与检测` })

  // 配对：targets×targets + targets×statics
  const plan: Array<[ObjectId, ObjectId]> = []
  for (let i = 0; i < cappedTargets.length; i++) {
    for (let j = i + 1; j < cappedTargets.length; j++) plan.push([cappedTargets[i], cappedTargets[j]])
  }
  for (const t of cappedTargets) {
    for (const s of cappedStatics) plan.push([t, s])
  }

  const maxPairs = Math.max(1, opts.maxPairsPerCheck)
  const active = plan.slice(0, maxPairs)
  if (plan.length > maxPairs) {
    const kept = new Set<ObjectId>()
    for (const [a, b] of active) {
      kept.add(a)
      kept.add(b)
    }
    for (const id of [...cappedTargets, ...cappedStatics]) {
      if (!kept.has(id)) skipped.push({ objectId: id, reason: `配对数量超过上限 ${maxPairs}，该对象未参与检测` })
    }
  }

  const checkedObjectIds = [...new Set(active.flatMap(([a, b]) => [a, b]))]

  const make = (status: GeometryResult['status'], pairs: GeometryPairResult[], truncated: boolean): GeometryResult => ({
    status,
    highestLevel: highestLevelOf(pairs),
    pairs,
    coverage: { checkedObjectIds, skipped, truncated, pairCount: pairs.length },
  })

  if (active.length === 0) {
    // 没有可验证的对象对：仍然 unknown（不是 clear）
    return make('unknown', [], skipped.length > 0)
  }

  const roots = collectRoots(scene, checkedObjectIds)
  const prepared = new Map<ObjectId, Prepared>()
  for (const id of checkedObjectIds) prepared.set(id, prepareObject(roots.get(id), id, opts.maxTrianglesPerObject))

  const budget: Budget = { left: opts.maxTrianglePairTests }
  const pairs: GeometryPairResult[] = []
  const tol = Math.max(0, request.contactToleranceM)
  for (const [idA, idB] of active) {
    const a = prepared.get(idA)
    const b = prepared.get(idB)
    if (!a || !b) continue
    pairs.push(checkPair(a, b, request, tol, opts, budget))
  }

  const budgetExhausted = budget.left <= 0
  const truncated = skipped.length > 0 || budgetExhausted
  if (pairs.some(p => p.status === 'collision')) return make('collision', pairs, truncated)
  if (pairs.some(p => p.status === 'unknown')) return make('unknown', pairs, truncated)
  // 覆盖不足时不能声称 clear
  return make(truncated ? 'unknown' : 'clear', pairs, truncated)
}

function highestLevelOf(pairs: GeometryPairResult[]): GeometryCheckLevel {
  let highest: GeometryCheckLevel = 'aabb'
  for (const p of pairs) highest = levelMax(highest, p.level)
  return highest
}
