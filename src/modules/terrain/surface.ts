import type { SceneAsset, TerrainSurface, TerrainSurfaceLayer, TerrainMaterialResource, TerrainSurfaceBlend } from '../../core/types'
export type Terrain = NonNullable<SceneAsset['terrain']>
export const PRESETS = {
  grass: { color: '#66834b', roughness: 0.95 },
  sand: { color: '#cfb880', roughness: 0.9 },
  rock: { color: '#777b80', roughness: 0.85 },
  snow: { color: '#eef5fa', roughness: 0.72 },
} as const
export function finite(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`数值须在 ${min}–${max} 之间`)
  return v
}
export function validateMaterial(r: TerrainMaterialResource) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || r.id.length > 128) throw new Error('材质 ID 无效')
  if (r.name !== undefined && (typeof r.name !== 'string' || r.name.length > 256)) throw new Error('材质名称无效')
  if (r.color !== undefined && (typeof r.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(r.color))) throw new Error('color 须为 #RRGGBB')
  if (r.roughness !== undefined) finite(r.roughness, 0, 1)
  if (r.normalStrength !== undefined) finite(r.normalStrength, 0, 4)
  if (r.maps !== undefined) {
    if (!r.maps || typeof r.maps !== 'object' || Array.isArray(r.maps)) throw new Error('maps 须为贴图对象')
    for (const [key, path] of Object.entries(r.maps)) {
      if (!['color', 'normal', 'roughness', 'ao', 'height'].includes(key) || typeof path !== 'string' || !/^\/assets\/[^\\?#%\u0000-\u001f]+\.(png|jpe?g|webp)$/i.test(path) || /\.\.|%|[?#]/.test(path)) throw new Error('贴图须为 /assets/ 下的 PNG/JPEG/WebP 路径，不得含路径跳转')
    }
  }
}
export function validateBlend(b: TerrainSurfaceBlend) {
  if (!b || !['weight', 'height'].includes(b.mode)) throw new Error('混合模式须为 weight 或 height')
  if (b.heightContrast !== undefined) finite(b.heightContrast, 0, 16)
  if (b.noiseStrength !== undefined) finite(b.noiseStrength, 0, 1)
  if (b.noiseScale !== undefined) finite(b.noiseScale, 0.1, 1000)
  if (b.seed !== undefined && (!Number.isInteger(b.seed) || Math.abs(b.seed) > 2147483647)) throw new Error('seed 须为 32 位整数')
}
export function validateSurface(value: unknown): asserts value is TerrainSurface {
  const s = value as TerrainSurface
  if (!s || s.version !== 1 || !Array.isArray(s.layers) || s.layers.length < 1 || s.layers.length > 4) throw new Error('地表版本须为 1，材质层须为 1–4 层')
  const resources = new Set<string>()
  if (s.materials !== undefined) {
    if (!Array.isArray(s.materials) || s.materials.length > 64) throw new Error('材质资源最多 64 个')
    for (const r of s.materials) { validateMaterial(r); if (resources.has(r.id)) throw new Error('材质 ID 重复'); resources.add(r.id) }
  }
  if (s.blend !== undefined) validateBlend(s.blend)
  const ids = new Set<string>()
  for (const l of s.layers) {
    if (!l || typeof l.id !== 'string' || !l.id || ids.has(l.id)) throw new Error('材质层 ID 须唯一且预设须有效')
    if ((l.presetId !== undefined && !Object.hasOwn(PRESETS, l.presetId)) || (l.materialId !== undefined ? !resources.has(l.materialId) : !Object.hasOwn(PRESETS, l.presetId ?? ''))) throw new Error('材质层须引用有效预设或自定义材质')
    if (l.normalStrength !== undefined) finite(l.normalStrength, 0, 4)
    ids.add(l.id); finite(l.tileSize, 0.1, 1000)
    if (l.tint !== undefined && !/^#[0-9a-f]{6}$/i.test(l.tint)) throw new Error('tint 须为 #RRGGBB')
    if (l.roughness !== undefined) finite(l.roughness, 0, 1)
  }
  if (!ids.has(s.baseLayerId)) throw new Error('基础层不存在')
  const m = s.weightMap
  if (!m || m.encoding !== 'rgba8' || !Number.isInteger(m.width) || !Number.isInteger(m.height)) throw new Error('权重图格式无效')
  finite(m.width, 2, 512); finite(m.height, 2, 512)
  if (!Array.isArray(m.data) || m.data.length !== m.width * m.height * 4) throw new Error('权重图长度无效')
  for (let i = 0; i < m.data.length; i += 4) {
    let sum = 0
    for (let c = 0; c < 4; c++) {
      const n = m.data[i + c]
      if (!Number.isInteger(n) || n < 0 || n > 255 || (c >= s.layers.length && n !== 0)) throw new Error('权重通道无效')
      sum += n
    }
    if (sum !== 255) throw new Error('每个权重像素之和须为 255')
  }
}
export function configureSurface(layers: TerrainSurfaceLayer[], baseLayerId: string, resolution = 256, materials?: TerrainMaterialResource[], blend?: TerrainSurfaceBlend): TerrainSurface {
  finite(resolution, 2, 512)
  if (!Number.isInteger(resolution)) throw new Error('resolution 须为整数')
  const data = new Array(resolution * resolution * 4).fill(0)
  const base = layers.findIndex(l => l.id === baseLayerId)
  if (base < 0) throw new Error('基础层不存在')
  for (let i = base; i < data.length; i += 4) data[i] = 255
  const surface: TerrainSurface = { version: 1, materials, blend, layers: layers.map(l => ({ ...l })), baseLayerId, weightMap: { width: resolution, height: resolution, encoding: 'rgba8', data } }
  validateSurface(surface)
  return surface
}
export type Point = [number, number]
export function point(v: unknown): Point {
  if (!Array.isArray(v) || v.length !== 2) throw new Error('坐标须为 [x,z]')
  return [finite(v[0], -1e6, 1e6), finite(v[1], -1e6, 1e6)]
}
function segment(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dz = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz)
}
export type Brush = { layerId: string; shape: 'circle' | 'polygon' | 'path'; center?: Point; points?: Point[]; radius?: number; feather?: number; strength?: number; erase?: boolean }
export function brushMask(b: Brush): (p: Point) => number {
  if (!['circle', 'polygon', 'path'].includes(b.shape)) throw new Error('shape 无效')
  const feather = finite(b.feather ?? 0, 0, 10000)
  const radius = b.shape === 'polygon' ? 0 : finite(b.radius, 0.001, 10000)
  const center = b.shape === 'circle' ? point(b.center) : undefined
  const points = b.shape !== 'circle' ? b.points?.map(point) : undefined
  if (b.shape !== 'circle' && (!points || points.length < (b.shape === 'polygon' ? 3 : 2) || points.length > 256)) throw new Error('路径须 2–256 个点，多边形须 3–256 个点')
  return p => {
    let distance: number
    if (center) distance = Math.hypot(p[0] - center[0], p[1] - center[1]) - radius
    else {
      const pts = points!
      let nearest = Infinity, inside = false
      for (let i = 0; i < pts.length - (b.shape === 'path' ? 1 : 0); i++) {
        const a = pts[i], c = pts[(i + 1) % pts.length]
        nearest = Math.min(nearest, segment(p, a, c))
        if ((a[1] > p[1]) !== (c[1] > p[1]) && p[0] < (c[0] - a[0]) * (p[1] - a[1]) / (c[1] - a[1]) + a[0]) inside = !inside
      }
      distance = b.shape === 'path' ? nearest - radius : inside ? -nearest : nearest
    }
    const t = feather ? Math.max(0, Math.min(1, -distance / feather)) : distance <= 0 ? 1 : 0
    return t * t * (3 - 2 * t)
  }
}
export function heightAt(t: Terrain, x: number, z: number): number {
  const u = Math.max(0, Math.min(t.samplesX - 1, (x / t.width + 0.5) * (t.samplesX - 1)))
  const v = Math.max(0, Math.min(t.samplesZ - 1, (z / t.depth + 0.5) * (t.samplesZ - 1)))
  const ix = Math.min(Math.floor(u), t.samplesX - 2), iz = Math.min(Math.floor(v), t.samplesZ - 2), fx = u - ix, fz = v - iz
  const a = t.heights[iz * t.samplesX + ix], b = t.heights[iz * t.samplesX + ix + 1], c = t.heights[(iz + 1) * t.samplesX + ix], d = t.heights[(iz + 1) * t.samplesX + ix + 1]
  return fx + fz <= 1 ? a + fx * (b - a) + fz * (c - a) : d + (1 - fz) * (b - d) + (1 - fx) * (c - d)
}
export function slopeAt(t: Terrain, x: number, z: number) {
  const dx = t.width / (t.samplesX - 1), dz = t.depth / (t.samplesZ - 1)
  const x0 = Math.max(-t.width / 2, x - dx / 2), x1 = Math.min(t.width / 2, x + dx / 2)
  const z0 = Math.max(-t.depth / 2, z - dz / 2), z1 = Math.min(t.depth / 2, z + dz / 2)
  return Math.atan(Math.hypot((heightAt(t, x1, z) - heightAt(t, x0, z)) / (x1 - x0), (heightAt(t, x, z1) - heightAt(t, x, z0)) / (z1 - z0))) * 180 / Math.PI
}
export type Range = { min?: number; max?: number; transition?: number }
export function rangeMask(r: Range | undefined, min: number, max: number) {
  if (r === undefined) return (_v: number) => 1
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('范围须为对象')
  const lo = r.min === undefined ? min : finite(r.min, min, max), hi = r.max === undefined ? max : finite(r.max, min, max)
  if (lo > hi) throw new Error('min 不得大于 max')
  const transition = finite(r.transition ?? 0, 0, max - min)
  return (v: number) => {
    const d = Math.min(v - lo, hi - v)
    const f = transition ? Math.max(0, Math.min(1, d / transition)) : d >= 0 ? 1 : 0
    return f * f * (3 - 2 * f)
  }
}
export function paintSurface(t: Terrain, operations: { layerId: string; strength?: number; erase?: boolean; mask: (p: Point) => number }[]) {
  if (!t.surface) throw new Error('请先配置地表材质层')
  const s = t.surface, m = s.weightMap
  const ops = operations.map(o => {
    const index = s.layers.findIndex(l => l.id === o.layerId)
    if (index < 0) throw new Error(`材质层 ${o.layerId} 不存在`)
    return { ...o, index, strength: finite(o.strength ?? 1, 0, 1) }
  })
  const data = [...m.data]
  let changedTexels = 0
  for (let z = 0; z < m.height; z++) for (let x = 0; x < m.width; x++) {
    const p: Point = [(x / (m.width - 1) - 0.5) * t.width, (z / (m.height - 1) - 0.5) * t.depth]
    const i = (z * m.width + x) * 4
    for (const o of ops) {
      const alpha = o.mask(p) * o.strength
      if (alpha <= 0) continue
      const target = o.erase ? s.layers.findIndex(l => l.id === s.baseLayerId) : o.index
      if (o.erase && o.index === target) continue
      const removed = alpha * data[i + o.index]
      const values = [0, 1, 2, 3].map(c => o.erase
        ? data[i + c] + (c === target ? removed : c === o.index ? -removed : 0)
        : data[i + c] * (1 - alpha) + (c === target ? 255 * alpha : 0))
      const rounded = values.map(Math.floor)
      let remainder = 255 - rounded.reduce((a, b) => a + b, 0)
      const order = [0, 1, 2, 3].sort((a, b) => (values[b] - rounded[b]) - (values[a] - rounded[a]))
      for (const c of order) if (remainder-- > 0) rounded[c]++
      rounded.forEach((v, c) => { data[i + c] = v })
    }
    if ([0, 1, 2, 3].some(c => data[i + c] !== m.data[i + c])) changedTexels++
  }
  return { surface: { ...s, weightMap: { ...m, data } }, changedTexels }
}
export function surfaceSummary(s: TerrainSurface | undefined) {
  if (!s) return null
  const totals = [0, 0, 0, 0]
  s.weightMap.data.forEach((v, i) => { totals[i % 4] += v })
  return { materials: s.materials ?? [], blend: s.blend ?? { mode: 'weight' }, version: s.version, baseLayerId: s.baseLayerId, resolution: [s.weightMap.width, s.weightMap.height], layers: s.layers.map((l, i) => ({ ...l, meanWeight: totals[i] / (255 * s.weightMap.width * s.weightMap.height) })) }
}
