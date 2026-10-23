/**
 * markers（W04）——同帧派生 ID 标记与映射（SPEC §W04-3、§6.5 的 observation 证据口径）。
 *
 * 做法：在**同一台相机、同一帧**里再渲一遍"ID pass"——把请求内的每个对象整体换成
 * 一个纯色 MeshBasicMaterial，颜色是对象序号（r + g<<8），其余对象涂黑。解码时
 * 逐像素还原序号，得到每个对象的像素数与包围盒：
 *
 * - 被遮挡 / 画外 → 像素数为 0，标签标为 `uncertain`（"看不见"，而不是"没请求"）；
 * - 像素太少（< MIN_VISIBLE_PIXELS）→ 也是 `uncertain`，避免被一两个杂点骗过；
 * - 序号从 1 开始，0 保留给背景。
 *
 * 颜色必须**逐字节精确**：ID pass 期间临时关掉色调映射并切到线性输出色彩空间，
 * 否则 ACES/sRGB 会把序号颜色扭成邻号（这正是"标记串号"的常见根因）。
 *
 * 只 import three；不碰 core/React。
 */

import {
  Color,
  DoubleSide,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import type { ObjectId, ObservationLabel } from '../contracts'
import { canvasToPng, paintImage, readTargetPixels, type RgbaImage } from './pixels'

/** 少于这个像素数就算"看得不清"（§W04 被遮挡/画外必须显式，不能糊过去） */
export const MIN_VISIBLE_PIXELS = 24

export interface MarkerBox {
  objectId: ObjectId
  label: string
  pixels: number
  /** 左上原点像素坐标（含端点） */
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface MarkerCapture {
  labels: ObservationLabel[]
  boxes: MarkerBox[]
  /** 用 RGB 图 + 标签贴纸合成"标记图"（不改变 RGB 原图） */
  compose(rgb: RgbaImage): Promise<Blob>
}

const SHORT_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function shortLabel(i: number): string {
  const base = SHORT_LABELS[i % SHORT_LABELS.length]
  return i < SHORT_LABELS.length ? base : `${base}${Math.floor(i / SHORT_LABELS.length) + 1}`
}

function indexColor(index: number): [number, number, number] {
  return [index & 0xff, (index >> 8) & 0xff, 0]
}

interface SavedMaterial {
  mesh: Mesh
  material: Material | Material[]
}

/** 找某对象 id 对应的根节点（userData.assetId 由 SceneContent 标记） */
function collectAssetRoots(scene: Scene, objectIds: ObjectId[]): Map<ObjectId, Object3D> {
  const wanted = new Set(objectIds)
  const found = new Map<ObjectId, Object3D>()
  scene.traverse(o => {
    const id = o.userData?.assetId
    if (typeof id === 'string' && wanted.has(id) && !found.has(id)) found.set(id, o)
  })
  return found
}

export function captureMarkers(args: {
  gl: WebGLRenderer
  scene: Scene
  camera: Camera
  target: WebGLRenderTarget
  width: number
  height: number
  objectIds: ObjectId[]
}): MarkerCapture {
  const { gl, scene, camera, target, width, height, objectIds } = args
  const roots = collectAssetRoots(scene, objectIds)
  const saved: SavedMaterial[] = []
  const temp: MeshBasicMaterial[] = []
  const indexOf = new Map<ObjectId, number>()

  // ---- 1. 换材质（一个对象一种颜色；同对象的多 mesh 共用一个材质） ----
  objectIds.forEach((id, i) => {
    const root = roots.get(id)
    if (!root) return
    const index = i + 1
    indexOf.set(id, index)
    const [r, g, b] = indexColor(index)
    const mat = new MeshBasicMaterial({ toneMapped: false, fog: false, side: DoubleSide, depthTest: true, depthWrite: true })
    // 线性值直接给字节/255，配合 LinearSRGB 输出 = 读回字节精确相等
    mat.color = new Color().setRGB(r / 255, g / 255, b / 255, LinearSRGBColorSpace)
    temp.push(mat)
    root.traverse(o => {
      if ((o as Mesh).isMesh) {
        const mesh = o as Mesh
        saved.push({ mesh, material: mesh.material })
        mesh.material = mat
      }
    })
  })

  // ---- 2. ID pass（状态先存后还，异常也必须还原） ----
  const prevTarget = gl.getRenderTarget()
  const prevClear = gl.getClearColor(new Color()).clone()
  const prevAlpha = gl.getClearAlpha()
  const prevTone = gl.toneMapping
  const prevColorSpace = gl.outputColorSpace
  let pixels: RgbaImage
  try {
    gl.setRenderTarget(target)
    gl.setClearColor(0x000000, 1)
    gl.toneMapping = NoToneMapping
    gl.outputColorSpace = LinearSRGBColorSpace
    gl.clear(true, true, true)
    gl.render(scene, camera)
    pixels = readTargetPixels(gl, target)
  } finally {
    for (const s of saved) s.mesh.material = s.material
    for (const m of temp) m.dispose()
    gl.setRenderTarget(prevTarget)
    gl.setClearColor(prevClear, prevAlpha)
    gl.toneMapping = prevTone
    gl.outputColorSpace = prevColorSpace
  }

  // ---- 3. 解码：像素数 + 包围盒 ----
  const stats = new Map<number, { count: number; minX: number; minY: number; maxX: number; maxY: number }>()
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      const p = (y * pixels.width + x) * 4
      const index = pixels.data[p] | (pixels.data[p + 1] << 8)
      if (index === 0) continue
      const s = stats.get(index)
      if (!s) stats.set(index, { count: 1, minX: x, minY: y, maxX: x, maxY: y })
      else {
        s.count++
        if (x < s.minX) s.minX = x
        if (y < s.minY) s.minY = y
        if (x > s.maxX) s.maxX = x
        if (y > s.maxY) s.maxY = y
      }
    }
  }

  const labels: ObservationLabel[] = []
  const boxes: MarkerBox[] = []
  objectIds.forEach((id, i) => {
    const index = indexOf.get(id)
    const s = index !== undefined ? stats.get(index) : undefined
    const visible = Boolean(s && s.count >= MIN_VISIBLE_PIXELS)
    labels.push({
      label: shortLabel(i),
      objectId: id,
      visibility: visible ? 'visible' : 'uncertain',
      pixels: s?.count ?? 0,
      ...(visible && s ? { pixelBox: { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY } } : {}),
    })
    if (s && s.count > 0) {
      boxes.push({ objectId: id, label: shortLabel(i), pixels: s.count, minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY })
    }
  })

  return {
    labels,
    boxes,
    async compose(rgb: RgbaImage): Promise<Blob> {
      const { ctx, canvas } = paintImage(rgb)
      const fontSize = Math.max(11, Math.round(Math.min(width, height) / 26))
      ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const b of boxes) {
        if (b.pixels < MIN_VISIBLE_PIXELS) continue
        const cx = (b.minX + b.maxX) / 2
        const cy = (b.minY + b.maxY) / 2
        const w = Math.max(fontSize + 8, fontSize * 0.72 * b.label.length + 10)
        const h = fontSize + 6
        ctx.fillStyle = 'rgba(20, 24, 31, 0.78)'
        ctx.beginPath()
        ctx.roundRect(cx - w / 2, cy - h / 2, w, h, 4)
        ctx.fill()
        ctx.strokeStyle = 'rgba(230, 237, 243, 0.55)'
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.fillStyle = '#e6edf3'
        ctx.fillText(b.label, cx, cy + 0.5)
      }
      return canvasToPng(canvas)
    },
  }
}
