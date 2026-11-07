import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { AgentToolDef } from './tools'
import type { Brush, Range } from '../terrain/surface'
import type { TerrainSurfaceLayer, TerrainMaterialResource, TerrainSurfaceBlend } from '../../core/types'
import { edit } from './scopedEdit'
import { useSceneStore } from '../../core/store'
import { brushMask, configureSurface, finite, heightAt, paintSurface, point, rangeMask, slopeAt, surfaceSummary, validateSurface, validateMaterial, validateBlend } from '../terrain/surface'
const num = { type: 'number' }
const pt = { type: 'array', items: num, minItems: 2, maxItems: 2 }
const range = { type: 'object', properties: { min: num, max: num, transition: { type: 'number', minimum: 0 } }, additionalProperties: false }
const materialSchema = { type: 'object', required: ['id'], properties: {
  id: { type: 'string', minLength: 1, maxLength: 128 }, name: { type: 'string' }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, roughness: { type: 'number', minimum: 0, maximum: 1 }, normalStrength: { type: 'number', minimum: 0, maximum: 4 },
  maps: { type: 'object', properties: Object.fromEntries(['color', 'normal', 'roughness', 'ao', 'height'].map(k => [k, { type: 'string', description: '项目 /assets/ 下 PNG/JPEG/WebP 路径；灰度贴图使用 R 通道，法线使用 OpenGL +Y 格式。' }])), additionalProperties: false },
}, additionalProperties: false }
const blendSchema = { type: 'object', required: ['mode'], properties: { mode: { enum: ['weight', 'height'] }, heightContrast: { type: 'number', minimum: 0, maximum: 16 }, noiseStrength: { type: 'number', minimum: 0, maximum: 1 }, noiseScale: { type: 'number', minimum: 0.1, maximum: 1000 }, seed: { type: 'integer', minimum: -2147483647, maximum: 2147483647 } }, additionalProperties: false }
const layerProperties = { id: { type: 'string' }, presetId: { enum: ['grass', 'sand', 'rock', 'snow'] }, materialId: { type: 'string' }, tileSize: num, tint: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, roughness: { type: 'number', minimum: 0, maximum: 1 }, normalStrength: { type: 'number', minimum: 0, maximum: 4 } }
const brush = { type: 'object', required: ['layerId', 'shape'], properties: { layerId: { type: 'string' }, shape: { enum: ['circle', 'polygon', 'path'] }, center: pt, points: { type: 'array', items: pt, maxItems: 256 }, radius: { type: 'number', exclusiveMinimum: 0 }, feather: { type: 'number', minimum: 0 }, strength: { type: 'number', minimum: 0, maximum: 1 }, erase: { type: 'boolean' }, space: { enum: ['local', 'world'] } }, additionalProperties: false }
function asset(args: Record<string, unknown>) {
  const a = useSceneStore.getState().document?.assets.find(a => a.id === args.assetId)
  if (!a?.terrain) throw new Error('assetId 须指向现有地形')
  return a as typeof a & { terrain: NonNullable<typeof a.terrain> }
}
function list(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 64 || v.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error('操作列表须含 1–64 个对象')
  return v
}
function define(name: AgentToolDef['name'], access: AgentToolDef['access'], description: string, properties: Record<string, unknown>, required: string[], exec: AgentToolDef['exec']): AgentToolDef {
  return { name, access, summary: description, description, argsDoc: JSON.stringify({ assetId: 'string', ...properties }), schema: { type: 'object', properties: { assetId: { type: 'string' }, ...properties }, required: ['assetId', ...required], additionalProperties: false }, exec }
}
export const TERRAIN_SURFACE_TOOLS: AgentToolDef[] = [
  define('terrain.surface.get', 'read', '查询内置预设、自定义材质资源、混合参数、平均绘制权重占比、局部尺寸与高度范围；先查询再选择规则阈值。', {}, [], args => {
    const a = asset(args), t = a.terrain
    return { assetId: a.id, width: t.width, depth: t.depth, heightRange: [Math.min(...t.heights), Math.max(...t.heights)], presets: ['grass', 'sand', 'rock', 'snow'], surface: surfaceSummary(t.surface) }
  }),
  define('terrain.surface.configure', 'write', '配置 1–4 层地表材质并重置权重为基础层；会替换此前绘制。tileSize 为局部米，默认 2；resolution 默认 256。', {
    layers: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['id'], properties: layerProperties, additionalProperties: false } },
    materials: { type: 'array', maxItems: 64, items: materialSchema }, blend: blendSchema,
    baseLayerId: { type: 'string' }, resolution: { type: 'integer', minimum: 2, maximum: 512 },
  }, ['layers', 'baseLayerId'], (args, ctx) => {
    if (!ctx.tx) throw new Error('地表修改需要编辑事务')
    const a = asset(args)
    const layers = list(args.layers).map(l => ({ ...l, tileSize: l.tileSize ?? 2 })) as unknown as TerrainSurfaceLayer[]
    const surface = configureSurface(layers, args.baseLayerId as string, args.resolution === undefined ? 256 : finite(args.resolution, 2, 512), (args.materials ?? a.terrain.surface?.materials) as TerrainMaterialResource[] | undefined, args.blend as TerrainSurfaceBlend | undefined)
    edit.updateAsset(a.id, { terrain: { ...a.terrain, surface } }, { source: 'agent', tx: ctx.tx })
    return surfaceSummary(surface)
  }),
  define('terrain.surface.set_material', 'write', '新增或替换当前地形的自定义材质资源，并分配给指定图层；保持已有绘制。material 是完整资源定义，materialId 引用已有资源，presetId 切回内置预设。贴图须已放入项目 /assets/；仅调整参数时可以省略这三项。', {
    layerId: { type: 'string' }, material: materialSchema, materialId: { type: 'string' }, presetId: layerProperties.presetId,
    tileSize: num, tint: layerProperties.tint, roughness: layerProperties.roughness, normalStrength: layerProperties.normalStrength,
  }, ['layerId'], (args, ctx) => {
    if (!ctx.tx) throw new Error('地表修改需要编辑事务')
    const a = asset(args), s = a.terrain.surface
    if (!s) throw new Error('请先配置地表材质层')
    const index = s.layers.findIndex(l => l.id === args.layerId)
    if (index < 0) throw new Error('layerId 不存在')
    if ([args.material, args.materialId, args.presetId].filter(v => v !== undefined).length > 1) throw new Error('material、materialId、presetId 只可提供一项')
    const resource = args.material as TerrainMaterialResource | undefined
    if (resource !== undefined) validateMaterial(resource)
    const materials = resource ? [...(s.materials ?? []).filter(r => r.id !== resource.id), structuredClone(resource)] : s.materials
    const layer = { ...s.layers[index] }
    if (args.presetId !== undefined) { layer.presetId = args.presetId as TerrainSurfaceLayer['presetId']; delete layer.materialId }
    if (resource || args.materialId !== undefined) layer.materialId = resource?.id ?? args.materialId as string
    for (const key of ['tileSize', 'tint', 'roughness', 'normalStrength'] as const) if (args[key] !== undefined) Object.assign(layer, { [key]: args[key] })
    const surface = { ...s, materials, layers: s.layers.map((l, i) => i === index ? layer : l) }
    validateSurface(surface)
    edit.updateAsset(a.id, { terrain: { ...a.terrain, surface } }, { source: 'agent', tx: ctx.tx })
    return { assetId: a.id, surface: surfaceSummary(surface) }
  }),
  define('terrain.surface.set_blend', 'write', '设置权重或高度混合及可重复的噪声混合，保留原始权重图。高度模式使用材质高度贴图；noiseScale 为局部米。sample 返回绘制权重，不包含渲染时细节混合。', { blend: blendSchema }, ['blend'], (args, ctx) => {
    if (!ctx.tx) throw new Error('地表修改需要编辑事务')
    const a = asset(args), s = a.terrain.surface
    if (!s) throw new Error('请先配置地表材质层')
    validateBlend(args.blend as TerrainSurfaceBlend)
    const surface = { ...s, blend: structuredClone(args.blend as TerrainSurfaceBlend) }
    edit.updateAsset(a.id, { terrain: { ...a.terrain, surface } }, { source: 'agent', tx: ctx.tx })
    return { assetId: a.id, surface: surfaceSummary(surface) }
  }),
  define('terrain.surface.paint', 'write', '批量柔边绘制圆形、多边形或路径；默认局部 [x,z] 米；space=world 时按世界 XZ 投影绘制，支持旋转缩放。radius 为圆或路径半宽，feather 在边界以内渐变；erase 将目标层权重移回基础层。', { operations: { type: 'array', minItems: 1, maxItems: 64, items: brush } }, ['operations'], (args, ctx) => {
    if (!ctx.tx) throw new Error('地表修改需要编辑事务')
    const a = asset(args)
    const ops = list(args.operations).map(raw => {
      const b = raw as unknown as Brush
      if (b.erase !== undefined && typeof b.erase !== 'boolean') throw new Error('erase 须为布尔值')
      const mask = brushMask(b)
      if (raw.space !== undefined && raw.space !== 'local' && raw.space !== 'world') throw new Error('space 须为 local 或 world')
      const matrix = new Matrix4().compose(new Vector3(...a.transform.position), new Quaternion().setFromEuler(new Euler(...a.transform.rotation.map(v => v * Math.PI / 180) as [number, number, number])), new Vector3(...(a.transform.scale ?? [1, 1, 1])))
      const projected = new Vector3()
      return { ...b, mask: raw.space === 'world' ? (p: [number, number]) => {
        projected.set(p[0], heightAt(a.terrain, ...p), p[1]).applyMatrix4(matrix)
        return mask([projected.x, projected.z])
      } : mask }
    })
    const result = paintSurface(a.terrain, ops)
    if (result.changedTexels) edit.updateAsset(a.id, { terrain: { ...a.terrain, surface: result.surface } }, { source: 'agent', tx: ctx.tx })
    return { assetId: a.id, changedTexels: result.changedTexels, surface: surfaceSummary(result.surface) }
  }),
  define('terrain.surface.apply_rules', 'write', '按顺序执行高度/坡度规则，后续规则叠加覆盖。高度为局部米，坡度为度；transition 在条件范围内平滑过渡。可选 region 限定局部区域。', {
    rules: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object', required: ['layerId'], properties: { layerId: { type: 'string' }, height: range, slope: range, strength: { type: 'number', minimum: 0, maximum: 1 }, region: brush }, additionalProperties: false } },
  }, ['rules'], (args, ctx) => {
    if (!ctx.tx) throw new Error('地表修改需要编辑事务')
    const a = asset(args), t = a.terrain
    const ops = list(args.rules).map(r => {
      const h = rangeMask(r.height as Range | undefined, -10000, 10000), slope = rangeMask(r.slope as Range | undefined, 0, 90)
      const region = r.region ? brushMask(r.region as Brush) : () => 1
      return { layerId: r.layerId as string, strength: r.strength === undefined ? 1 : finite(r.strength, 0, 1), mask: (p: [number, number]) => h(heightAt(t, ...p)) * (r.slope ? slope(slopeAt(t, ...p)) : 1) * region(p) }
    })
    const result = paintSurface(t, ops)
    if (result.changedTexels) edit.updateAsset(a.id, { terrain: { ...t, surface: result.surface } }, { source: 'agent', tx: ctx.tx })
    return { assetId: a.id, changedTexels: result.changedTexels, surface: surfaceSummary(result.surface) }
  }),
  define('terrain.surface.sample', 'read', '查询局部 [x,z] 点的材质权重，超出地形返回 null。', { points: { type: 'array', items: pt, minItems: 1, maxItems: 100 } }, ['points'], args => {
    const a = asset(args), t = a.terrain, s = t.surface
    if (!s) throw new Error('地形尚未配置表面')
    if (!Array.isArray(args.points) || !args.points.length || args.points.length > 100) throw new Error('points 须为 1–100 个点')
    const m = s.weightMap
    return { assetId: a.id, samples: args.points.map(v => {
      const [x, z] = point(v)
      if (Math.abs(x) > t.width / 2 || Math.abs(z) > t.depth / 2) return null
      const u = (x / t.width + 0.5) * (m.width - 1), v0 = (z / t.depth + 0.5) * (m.height - 1)
      const ix = Math.min(Math.floor(u), m.width - 2), iz = Math.min(Math.floor(v0), m.height - 2), fx = u - ix, fz = v0 - iz
      const value = (dx: number, dz: number, c: number) => m.data[((iz + dz) * m.width + ix + dx) * 4 + c]
      return s.layers.map((l, c) => ({ layerId: l.id, weight: ((1 - fx) * (1 - fz) * value(0, 0, c) + fx * (1 - fz) * value(1, 0, c) + (1 - fx) * fz * value(0, 1, c) + fx * fz * value(1, 1, c)) / 255 }))
    }) }
  }),
  define('terrain.surface.reset', 'write', '移除分层表面，恢复原有整体材质；或 mode=base 仅清空绘制并保留材质层。', { mode: { enum: ['remove', 'base'] } }, [], (args, ctx) => {
    if (!ctx.tx) throw new Error('地表修改需要编辑事务')
    if (args.mode !== undefined && !['remove', 'base'].includes(args.mode as string)) throw new Error('mode 无效')
    const a = asset(args), s = a.terrain.surface
    if (!s) return { assetId: a.id, changed: false }
    const base = s.layers.findIndex(l => l.id === s.baseLayerId)
    const surface = args.mode === 'base' ? { ...s, weightMap: { ...s.weightMap, data: s.weightMap.data.map((_v, i) => i % 4 === base ? 255 : 0) } } : undefined
    edit.updateAsset(a.id, { terrain: { ...a.terrain, surface } }, { source: 'agent', tx: ctx.tx })
    return { assetId: a.id, surface: surfaceSummary(surface) }
  }),
]
