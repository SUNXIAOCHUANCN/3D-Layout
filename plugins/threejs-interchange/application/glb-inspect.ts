/**
 * 纯数据 GLB 检查器：不依赖 three.js/DOM，浏览器与 Node 服务端共用。
 * 服务端用它独立复核浏览器上传的规范 GLB（边界、压缩、外链、蒙皮/morph），
 * 不信任上传方 meta 声明（架构文档 §5.4/§7.1）。
 *
 * 边界来源：glTF 规范要求 POSITION accessor 必须带 min/max；节点变换
 * （matrix 列主序或 TRS）在此手写合成，避免引 three。
 */

import type { Vec3 } from './contracts.js'
import { InterchangeError } from './errors.js'
import { LIMITS } from './validation.js'

const GLB_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a // 'JSON'
const CHUNK_BIN = 0x004e4942 // 'BIN\0'

/** 服务端拒绝的压缩扩展（一期默认输出不压缩 GLB；压缩输入仅在本地解码器配置后接收） */
export const COMPRESSED_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'KHR_texture_basisu',
  'EXT_meshopt_compression',
])

export interface Bounds {
  min: Vec3
  max: Vec3
}

export interface GlbInspection {
  gltf: GltfJson
  boundsSource: Bounds | null
  /** 规范空间（米制/+Y/底面中心）边界，供与 integrity.localBounds 复核 */
  boundsCanonical: Bounds | null
  extensionsUsed: string[]
  extensionsRequired: string[]
  externalRefs: string[]
  stats: {
    meshes: number
    primitives: number
    vertices: number
    images: number
    skins: number
    animations: number
    morphTargets: number
  }
}

interface GltfJson {
  asset?: { version?: string }
  scene?: number
  scenes?: Array<{ nodes?: number[] }>
  nodes?: Array<{
    mesh?: number
    children?: number[]
    matrix?: number[]
    translation?: number[]
    rotation?: number[]
    scale?: number[]
  }>
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }>; weights?: number[] }>
  accessors?: Array<{ componentType?: number; count?: number; min?: number[]; max?: number[]; type?: string }>
  buffers?: Array<{ uri?: string; byteLength?: number }>
  images?: Array<{ uri?: string; bufferView?: number; mimeType?: string }>
  skins?: unknown[]
  animations?: unknown[]
  extensionsUsed?: string[]
  extensionsRequired?: string[]
}

// ---------- 列主序 mat4（仅合成与点变换，无需求逆） ----------

type Mat4 = Float64Array // 16, column-major

function mat4Identity(): Mat4 {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

function quatToMat4(q: number[]): Mat4 {
  const [x, y, z, w] = q
  const m = mat4Identity()
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  m[0] = 1 - (yy + zz); m[1] = xy + wz; m[2] = xz - wy
  m[4] = xy - wz; m[5] = 1 - (xx + zz); m[6] = yz + wx
  m[8] = xz + wy; m[9] = yz - wx; m[10] = 1 - (xx + yy)
  return m
}

function composeTrs(t: number[] | undefined, r: number[] | undefined, s: number[] | undefined): Mat4 {
  const m = mat4Identity()
  if (r && r.length === 4) {
    const rot = quatToMat4(r)
    m.set(rot)
  }
  if (s && s.length === 3) {
    for (let i = 0; i < 3; i++) m[i * 4 + i] *= s[i]
  }
  if (t && t.length === 3) {
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]
  }
  return m
}

type GltfNode = NonNullable<GltfJson['nodes']>[number]

function nodeLocalMatrix(n: GltfNode): Mat4 {
  if (n.matrix && n.matrix.length === 16) {
    const m = new Float64Array(16)
    m.set(n.matrix)
    return m
  }
  return composeTrs(n.translation, n.rotation, n.scale)
}

function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ]
}

// ---------- 坐标规范化（纯数据版，与浏览器转换共享同一数学定义） ----------

export interface CoordsSimple {
  metersPerUnit: number
  up: '+Y' | '+Z'
}

/** 轴/单位相似变换 A：源空间 → 目标空间（'+Z' up 时 (x,y,z)→(x,z,-y)·s，+Z→+Y） */
export function axisUnitTransform(coords: CoordsSimple): Mat4 {
  const s = coords.metersPerUnit
  const m = mat4Identity()
  if (coords.up === '+Z') {
    // Rx(-90°)：col1(Y)→-Z、col2(Z)→+Y（列主序）
    m[5] = 0; m[6] = -1; m[9] = 1; m[10] = 0
  }
  for (let i = 0; i < 12; i++) m[i] *= s
  return m
}

function transformBounds(b: Bounds, m: Mat4): Bounds {
  const corners: Vec3[] = []
  for (const x of [b.min[0], b.max[0]]) {
    for (const y of [b.min[1], b.max[1]]) {
      for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z])
    }
  }
  return unionBounds(corners.map(p => transformPoint(m, p)))
}

export function unionBounds(points: Vec3[]): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i])
      max[i] = Math.max(max[i], p[i])
    }
  }
  return { min, max }
}

/** 规范化 N = T_bottom · A：底面中心平移 + 轴/单位变换（架构文档 §5.2 公式中的 N） */
export function canonicalTransform(coords: CoordsSimple, sourceBounds: Bounds): { n: Mat4; bottomCenterInTarget: Vec3 } {
  const a = axisUnitTransform(coords)
  const inTarget = transformBounds(sourceBounds, a)
  const bc: Vec3 = [
    (inTarget.min[0] + inTarget.max[0]) / 2,
    inTarget.min[1],
    (inTarget.min[2] + inTarget.max[2]) / 2,
  ]
  const n = mat4Identity()
  n.set(a)
  n[12] -= bc[0]; n[13] -= bc[1]; n[14] -= bc[2]
  return { n, bottomCenterInTarget: bc }
}

// ---------- GLB 解析 ----------

export function inspectGlb(bytes: Uint8Array, coords: CoordsSimple): GlbInspection {
  if (bytes.byteLength < 20) throw new InterchangeError('INVALID_DECLARATION', 'GLB 文件过小，不是合法 GLB 容器')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = dv.getUint32(0, true)
  if (magic !== GLB_MAGIC) throw new InterchangeError('INVALID_DECLARATION', '缺少 glTF 魔数；一期只接收 GLB（自包含二进制）')
  const version = dv.getUint32(4, true)
  if (version !== 2) throw new InterchangeError('INVALID_DECLARATION', `不支持的 glTF 版本 ${version}（仅 glTF 2.0）`)
  const totalLen = dv.getUint32(8, true)
  if (totalLen > bytes.byteLength) throw new InterchangeError('INVALID_DECLARATION', 'GLB 声明长度超过实际字节')

  let json: GltfJson | null = null
  let off = 12
  while (off + 8 <= bytes.byteLength) {
    const chunkLen = dv.getUint32(off, true)
    const chunkType = dv.getUint32(off + 4, true)
    const body = off + 8
    if (body + chunkLen > bytes.byteLength) throw new InterchangeError('INVALID_DECLARATION', 'GLB chunk 越界')
    if (chunkType === CHUNK_JSON && json === null) {
      const text = new TextDecoder().decode(bytes.subarray(body, body + chunkLen))
      json = JSON.parse(text) as GltfJson
    }
    // GLB 规范：chunk 按 4 字节对齐
    off = body + Math.ceil(chunkLen / 4) * 4
  }
  if (!json) throw new InterchangeError('INVALID_DECLARATION', 'GLB 缺少 JSON chunk')

  const externalRefs: string[] = []
  for (const b of json.buffers ?? []) {
    if (b.uri !== undefined && !b.uri.startsWith('data:')) externalRefs.push(b.uri)
  }
  for (const img of json.images ?? []) {
    if (img.uri !== undefined && !img.uri.startsWith('data:')) externalRefs.push(img.uri)
  }

  const extensionsUsed = json.extensionsUsed ?? []
  const extensionsRequired = json.extensionsRequired ?? []
  const skins = json.skins?.length ?? 0
  const animations = json.animations?.length ?? 0
  let morphTargets = 0
  let meshes = 0
  let primitives = 0
  let vertices = 0
  for (const mesh of json.meshes ?? []) {
    meshes++
    if (mesh.weights?.length) morphTargets += mesh.weights.length
    for (const prim of mesh.primitives ?? []) {
      primitives++
      const posAcc = prim.attributes?.POSITION
      if (posAcc !== undefined) {
        const acc = json.accessors?.[posAcc]
        if (acc) vertices += acc.count ?? 0
      }
      if (prim['targets' as keyof typeof prim]) morphTargets++
    }
  }
  if (vertices > LIMITS.maxVertices) {
    throw new InterchangeError('LIMIT_EXCEEDED', `模型顶点数 ${vertices} 超过上限 ${LIMITS.maxVertices}`)
  }

  // 源空间边界：场景节点世界矩阵 × POSITION accessor min/max
  const points: Vec3[] = []
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? json.scenes?.[0]?.nodes ?? []
  const visited = new Set<number>()
  const walk = (nodeIdx: number, parent: Mat4): void => {
    if (visited.has(nodeIdx)) return // 防御环引用
    visited.add(nodeIdx)
    const node = json.nodes?.[nodeIdx]
    if (!node) return
    const world = mat4Mul(parent, nodeLocalMatrix(node))
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh]
      for (const prim of mesh?.primitives ?? []) {
        const pos = prim.attributes?.POSITION
        if (pos === undefined) continue
        const acc = json.accessors?.[pos]
        if (!acc?.min || !acc?.max) continue
        for (const x of [acc.min[0], acc.max[0]]) {
          for (const y of [acc.min[1], acc.max[1]]) {
            for (const z of [acc.min[2], acc.max[2]]) points.push(transformPoint(world, [x, y, z]))
          }
        }
      }
    }
    for (const c of node.children ?? []) walk(c, world)
  }
  for (const r of roots) walk(r, mat4Identity())

  const boundsSource = points.length > 0 ? unionBounds(points) : null
  let boundsCanonical: Bounds | null = null
  if (boundsSource) {
    const { n } = canonicalTransform(coords, boundsSource)
    boundsCanonical = transformBounds(boundsSource, n)
  }

  return {
    gltf: json,
    boundsSource,
    boundsCanonical,
    extensionsUsed,
    extensionsRequired,
    externalRefs,
    stats: { meshes, primitives, vertices, images: json.images?.length ?? 0, skins, animations, morphTargets },
  }
}
