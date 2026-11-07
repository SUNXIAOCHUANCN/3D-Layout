import { Matrix4, Euler, Quaternion, Vector3, Raycaster } from 'three'
import { GENERATION_TOOLS } from './generationTools'
import { edit } from './scopedEdit'
import { engine } from '../../core/engine'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Vec3 } from '../../core/types'
import { modelWorldBounds } from '../../shared/modelBounds'
import type { AgentToolDef, AgentToolContext } from './tools'
import type { AgentToolName } from './protocol'

type Args = Record<string, unknown>
const string = { type: 'string' }
const number = { type: 'number' }
const vector = { type: 'array', items: number, minItems: 3, maxItems: 3 }
const ids = { type: 'array', items: string, minItems: 1, maxItems: 128 }
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }

function record(value: unknown): Args {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要参数对象')
  return value as Args
}

function finite(value: unknown, min = -1e6, max = 1e6): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('数值超出范围')
  return value
}

function vec(value: unknown, min?: number): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('需要三维坐标')
  return value.map(n => finite(n, min)) as Vec3
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw new Error('每批需要 1–128 项')
  return value
}

function state() {
  const s = useSceneStore.getState()
  if (!s.document) throw new Error('未加载场景')
  return { ...s, document: s.document }
}

function getAsset(id: unknown) {
  const asset = state().document.assets.find(a => a.id === id)
  if (!asset) throw new Error('找不到指定对象')
  return asset
}

function targets(value: unknown) {
  const assets = list(value).map(getAsset)
  if (new Set(assets.map(a => a.id)).size !== assets.length) throw new Error('对象 ID 重复')
  return assets
}

function transaction(ctx: AgentToolContext) {
  if (!ctx.tx) throw new Error('需要场景编辑事务')
  return { tx: ctx.tx, source: 'agent' as const }
}

function applied(ok: boolean) {
  if (!ok) throw new Error('编辑未能应用')
}

function define(name: AgentToolName, access: 'read' | 'write', description: string, properties: Args, required: string[], exec: AgentToolDef['exec']): AgentToolDef {
  return { name, access, summary: description, description, argsDoc: '', schema: { type: 'object', properties, required, additionalProperties: false }, exec }
}

function transform(args: Args, base?: SceneAsset['transform']): SceneAsset['transform'] {
  return {
    position: args.position === undefined && base ? base.position : vec(args.position),
    rotation: args.rotation === undefined ? base?.rotation ?? [0, 0, 0] : vec(args.rotation),
    scale: args.scale === undefined ? base?.scale : vec(args.scale),
  }
}

function bounds(asset: SceneAsset) {
  const model = state().manifest?.models[asset.ref]
  if (!model) throw new Error('对象没有标准模型包围盒')
  return modelWorldBounds(model, asset.transform)
}

export const SCENE_TOOLS: AgentToolDef[] = [
  define('asset.scatter', 'write', '按有种子的抖动网格在世界 XZ 区域填充模型。每批最多 128 个。可提供 terrainId 自动按地形中心点贴地。明确区域与数量后调用。', {
    refs: { type: 'array', items: string, minItems: 1, maxItems: 20 },
    min: { type: 'array', items: number, minItems: 2, maxItems: 2 },
    max: { type: 'array', items: number, minItems: 2, maxItems: 2 },
    count: { type: 'integer', minimum: 1, maximum: 128 },
    seed: { type: 'integer' }, terrainId: string, height: number, scale: number,
  }, ['refs', 'min', 'max', 'count'], (args, ctx) => {
    transaction(ctx)
    const { manifest } = state()
    const refs = list(args.refs)
    if (refs.length > 20 || refs.some(ref => typeof ref !== 'string' || !manifest?.models[ref])) throw new Error('refs 必须来自模型目录')
    const pair = (value: unknown) => {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('范围需要 [x,z]')
      return value.map(n => finite(n))
    }
    const min = pair(args.min), max = pair(args.max)
    if (max.some((n, i) => n <= min[i])) throw new Error('区域尺寸必须为正')
    const count = finite(args.count, 1, 128)
    let seed = finite(args.seed ?? 1, -2147483648, 2147483647)
    if (!Number.isInteger(count) || !Number.isInteger(seed)) throw new Error('count 和 seed 必须是整数')
    const scale = finite(args.scale ?? 1, 0.001, 100)
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }
    const columns = Math.max(1, Math.ceil(Math.sqrt(count * (max[0] - min[0]) / (max[1] - min[1]))))
    const rows = Math.ceil(count / columns)
    const points = Array.from({ length: count }, (_, i) => [
      min[0] + (i % columns + 0.2 + random() * 0.6) / columns * (max[0] - min[0]),
      min[1] + (Math.floor(i / columns) + 0.2 + random() * 0.6) / rows * (max[1] - min[1]),
    ])
    let heights = points.map(() => finite(args.height ?? 0))
    if (args.terrainId !== undefined) {
      const sample = GENERATION_TOOLS.find(t => t.name === 'terrain.sample')!
      heights = []
      for (let i = 0; i < points.length; i += 100) {
        const data = sample.exec({ assetId: args.terrainId, points: points.slice(i, i + 100) }, { tx: null }) as { heights: (number | null)[] }
        if (data.heights.some(h => h === null)) throw new Error('填充范围超出指定地形')
        heights.push(...data.heights as number[])
      }
    }
    const items = points.map(([x, z], i) => ({
      ref: refs[i % refs.length], position: [x, heights[i], z],
      rotation: [0, random() * 360, 0], scale: [scale, scale, scale],
    }))
    return SCENE_TOOLS.find(t => t.name === 'asset.batch')!.exec({ operation: 'add', items }, ctx)
  }),
  define('asset.batch', 'write', '批量添加、设置变换或删除对象。每次同一操作，修改可只传需要变化的字段。添加支持用 origin 和 step 生成等距排列。', {
    operation: { type: 'string', enum: ['add', 'transform', 'remove'] },
    items: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', properties: {
      assetId: string, ref: string, name: string, position: vector, rotation: vector, scale: vector,
    }, additionalProperties: false } },
    origin: vector, step: vector,
  }, ['operation', 'items'], (args, ctx) => {
    const meta = transaction(ctx)
    const { document, manifest } = state()
    const items = list(args.items).map(record)
    if (args.operation === 'add') {
      const origin = args.origin === undefined ? undefined : vec(args.origin)
      const step = args.step === undefined ? undefined : vec(args.step)
      if (!!origin !== !!step) throw new Error('origin 和 step 必须同时提供')
      const assets = items.map((item, i): SceneAsset => {
        if (typeof item.ref !== 'string' || !manifest?.models[item.ref]) throw new Error('模型引用不在目录中')
        if (item.name !== undefined && typeof item.name !== 'string') throw new Error('名称必须是文本')
        const position = item.position ?? origin?.map((value, axis) => value + i * step![axis])
        return { id: 'asset-' + crypto.randomUUID(), ref: item.ref, name: item.name as string | undefined, transform: transform({ ...item, position }) }
      })
      assets.forEach(asset => applied(edit.addAsset(asset, meta)))
      return { assetIds: assets.map(asset => asset.id) }
    }
    if (args.operation !== 'transform' && args.operation !== 'remove') throw new Error('未知批量操作')
    const assets = targets(items.map(item => item.assetId))
    const next = args.operation === 'transform' ? items.map((item, i) => transform(item, assets[i].transform)) : null
    if (document !== useSceneStore.getState().document) throw new Error('场景已变化')
    assets.forEach((asset, i) => applied(next ? edit.setTransform(asset.id, next[i], meta) : edit.removeAsset(asset.id, meta)))
    return { assetIds: assets.map(asset => asset.id) }
  }),
  define('asset.snap', 'write', '网格吸附、包围盒对齐或向指定承载对象贴地。贴地用中心和四角向下取样，报告漏采和可能悬空的落差。', {
    assetId: string, targetId: string, mode: { type: 'string', enum: ['grid', 'align', 'ground'] },
    grid: number, axis: { type: 'string', enum: ['x', 'y', 'z'] },
    edge: { type: 'string', enum: ['min', 'center', 'max'] }, offset: number,
  }, ['assetId', 'mode'], (args, ctx) => {
    const meta = transaction(ctx)
    const asset = getAsset(args.assetId)
    const position = [...asset.transform.position] as Vec3
    let support: { samples: number; hits: number; gap: number } | undefined
    if (args.mode === 'grid') {
      const grid = finite(args.grid ?? 1, 0.001)
      position[0] = Math.round(position[0] / grid) * grid
      position[2] = Math.round(position[2] / grid) * grid
    } else {
      const target = getAsset(args.targetId)
      if (target.id === asset.id) throw new Error('目标不能是自身')
      const box = bounds(asset)
      const offset = finite(args.offset ?? 0)
      if (args.mode === 'align') {
        const axis = ['x', 'y', 'z'].indexOf(String(args.axis))
        const edge = args.edge ?? 'center'
        if (axis < 0 || !['min', 'center', 'max'].includes(String(edge))) throw new Error('对齐需要有效轴和边')
        const coord = (b: typeof box) => edge === 'min' ? b.min[axis] : edge === 'max' ? b.max[axis] : (b.min[axis] + b.max[axis]) / 2
        position[axis] += coord(bounds(target)) - coord(box) + offset
      } else if (args.mode === 'ground') {
        const object = engine.findAssetObject(target.id)
        if (!object || target.visible === false) throw new Error('承载对象未就绪或不可见')
        object.updateWorldMatrix(true, true)
        const [x, , z] = box.min
        const [u, , v] = box.max
        const points = [[x, z], [x, v], [u, z], [u, v], [(x + u) / 2, (z + v) / 2]]
        const heights = points.flatMap(([px, pz]) => {
          const ray = new Raycaster(new Vector3(px, 1e8, pz), new Vector3(0, -1, 0))
          const hit = ray.intersectObject(object, true).find(({ object: mesh }) => {
            for (let node: typeof mesh | null = mesh; node; node = node.parent) {
              if (!node.visible || node.userData.editorHelper) return false
            }
            return true
          })
          return hit ? [hit.point.y] : []
        })
        if (!heights.length) throw new Error('所有采样点均未命中承载对象')
        position[1] += Math.max(...heights) - box.min[1] + offset
        support = { samples: points.length, hits: heights.length, gap: Math.max(...heights) - Math.min(...heights) }
      } else throw new Error('未知吸附模式')
    }
    applied(edit.setTransform(asset.id, { ...asset.transform, position }, meta))
    return { assetId: asset.id, position, support }
  }),
  define('terrain.sculpt', 'write', '局部编辑现有高度场。center 或 path 与 radius 默认使用地形局部米坐标。space=world 使用世界 XZ 米坐标和世界高度，仅支持绕 Y 旋转的正缩放地形。plateau 为完全压平的半径比例（0–1，默认 0），其余边缘平滑衰减。raise 可为负值，flatten 指定局部高度，smooth 指定 0–1 强度。', {
    assetId: string, mode: { type: 'string', enum: ['raise', 'flatten', 'smooth'] },
    center: { type: 'array', items: number, minItems: 2, maxItems: 2 },
    path: { type: 'array', minItems: 2, maxItems: 64, items: { type: 'array', items: number, minItems: 2, maxItems: 2 } },
    radius: number, value: number,
    space: { type: 'string', enum: ['local', 'world'] },
    plateau: { type: 'number', minimum: 0, maximum: 1 },
  }, ['assetId', 'mode', 'radius', 'value'], (args, ctx) => {
    const meta = transaction(ctx)
    const asset = getAsset(args.assetId)
    const t = asset.terrain
    if (!t) throw new Error('需要高度场地形')
    const points = args.path === undefined ? [args.center] : list(args.path)
    if (args.path !== undefined && (points.length < 2 || points.length > 64)) throw new Error('路径需要 2–64 个点')
    const world = args.space === 'world'
    if (args.space !== undefined && args.space !== 'local' && !world) throw new Error('space 必须为 local 或 world')
    const [rx, ry, rz] = asset.transform.rotation
    const [sx, sy, sz] = asset.transform.scale ?? [1, 1, 1]
    if (world && (rx !== 0 || rz !== 0 || Math.min(sx, sy, sz) <= 0)) throw new Error('世界坐标编辑需要地形 X/Z 旋转为零且正缩放')
    const matrix = new Matrix4().compose(
      new Vector3(...asset.transform.position),
      new Quaternion().setFromEuler(new Euler(rx * Math.PI / 180, ry * Math.PI / 180, rz * Math.PI / 180)),
      new Vector3(sx, sy, sz),
    )
    const coordinates = points.map(point => {
      if (!Array.isArray(point) || point.length !== 2) throw new Error('需要局部坐标 [x,z]')
      return point.map(n => finite(n))
    })
    const distanceToBrush = (x: number, z: number) => {
      const [cx, cz] = coordinates[0]
      let distance = Math.hypot(x - cx, z - cz)
      for (let i = 1; i < coordinates.length; i++) {
        const [ax, az] = coordinates[i - 1]
        const [bx, bz] = coordinates[i]
        const dx = bx - ax, dz = bz - az
        const lengthSquared = dx * dx + dz * dz
        const fraction = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared)) : 0
        distance = Math.min(distance, Math.hypot(x - ax - fraction * dx, z - az - fraction * dz))
      }
      return distance
    }
    const radius = finite(args.radius, 0.001)
    const mode = args.mode
    if (mode !== 'raise' && mode !== 'flatten' && mode !== 'smooth') throw new Error('未知雕刻操作')
    let value = mode === 'smooth' ? finite(args.value, 0, 1) : finite(args.value, -10000, 10000)
    if (world && mode !== 'smooth') value = mode === 'raise' ? value / sy : (value - asset.transform.position[1]) / sy
    const plateau = finite(args.plateau ?? 0, 0, 1)
    let changed = 0
    const heights = t.heights.map((height, i) => {
      const x = i % t.samplesX
      const z = Math.floor(i / t.samplesX)
      const point = new Vector3((x / (t.samplesX - 1) - 0.5) * t.width, 0, (z / (t.samplesZ - 1) - 0.5) * t.depth)
      if (world) point.applyMatrix4(matrix)
      const distance = distanceToBrush(point.x, point.z)
      if (distance >= radius) return height
      const f = distance <= radius * plateau ? 1 : 1 - (distance / radius - plateau) / (1 - plateau)
      const weight = f * f * (3 - 2 * f)
      let target = mode === 'raise' ? height + value : value
      if (mode === 'smooth') {
        const neighbors = [height]
        if (x > 0) neighbors.push(t.heights[i - 1])
        if (x + 1 < t.samplesX) neighbors.push(t.heights[i + 1])
        if (z > 0) neighbors.push(t.heights[i - t.samplesX])
        if (z + 1 < t.samplesZ) neighbors.push(t.heights[i + t.samplesX])
        target = height + value * (neighbors.reduce((sum, n) => sum + n, 0) / neighbors.length - height)
      }
      const next = finite(height + (target - height) * weight, -10000, 10000)
      if (next !== height) changed++
      return next
    })
    if (changed) applied(edit.updateAsset(asset.id, { terrain: { ...t, heights } }, meta))
    return { assetId: asset.id, changedSamples: changed, effective: changed > 0,
      warning: changed ? undefined : '本次未改变任何采样点。检查坐标系、笔刷范围或目标值，避免重复同一调用。',
      localBounds: { min: [-t.width / 2, -t.depth / 2], max: [t.width / 2, t.depth / 2] } }
  }),
  define('material.get_many', 'read', '批量读取实例覆盖。null 表示沿用原始材质。', { assetIds: ids }, ['assetIds'], args =>
    targets(args.assetIds).map(a => ({ assetId: a.id, override: a.materialOverride ?? null }))),
  define('material.batch', 'write', '批量应用或清除 PBR 覆盖。只更新提供的参数；首次覆盖默认白色、粗糙度 0.65、金属度 0。', {
    assetIds: ids, reset: { type: 'boolean' }, color, roughness: number, metalness: number,
  }, ['assetIds'], (args, ctx) => {
    const meta = transaction(ctx)
    const assets = targets(args.assetIds)
    if (assets.some(a => a.terrain?.surface)) throw new Error('分层地形请使用 terrain.surface 工具')
    if (args.color !== undefined && (typeof args.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(args.color))) throw new Error('颜色需为 #RRGGBB')
    if (args.reset !== true && args.color === undefined && args.roughness === undefined && args.metalness === undefined) throw new Error('请提供材质参数或 reset')
    const values = assets.map(a => args.reset === true ? undefined : {
      color: (args.color as string | undefined) ?? a.materialOverride?.color ?? '#ffffff',
      roughness: args.roughness === undefined ? a.materialOverride?.roughness ?? 0.65 : finite(args.roughness, 0, 1),
      metalness: args.metalness === undefined ? a.materialOverride?.metalness ?? 0 : finite(args.metalness, 0, 1),
    })
    assets.forEach((a, i) => applied(edit.updateAsset(a.id, { materialOverride: values[i] }, meta)))
    return { assetIds: assets.map(a => a.id) }
  }),
]
