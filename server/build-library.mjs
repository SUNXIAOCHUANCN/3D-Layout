import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { ApiError, validateWorkspace } from './workspaces.mjs'

const parserHome = new URL('../plugins/threejs-interchange/application/', import.meta.url)
let parser
function loadParser() {
  parser ??= (async () => {
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        const fromParser = context.parentURL?.startsWith(parserHome.href)
        return next(fromParser && /^\.\/[\w-]+\.js$/.test(specifier) ? specifier.replace(/\.js$/, '.ts') : specifier, context)
      },
    })
    try { return await import(new URL('glb-inspect.ts', parserHome)) }
    finally { hooks.deregister() }
  })()
  return parser
}

function readEntries(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => {
      const path = join(directory, entry.name, 'meta.json')
      return existsSync(path) ? [JSON.parse(readFileSync(path, 'utf8'))] : []
    })
}

function writeEntry(directory, id, meta, bytes) {
  const target = join(directory, id)
  if (existsSync(target)) return JSON.parse(readFileSync(join(target, 'meta.json'), 'utf8'))
  const temp = join(directory, '.' + randomUUID())
  mkdirSync(temp, { recursive: true })
  try {
    if (bytes) writeFileSync(join(temp, 'model.glb'), bytes)
    writeFileSync(join(temp, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    renameSync(temp, target)
    return meta
  } catch (error) {
    if (existsSync(join(target, 'meta.json'))) return JSON.parse(readFileSync(join(target, 'meta.json'), 'utf8'))
    throw error
  } finally {
    rmSync(join(temp, 'meta.json'), { force: true })
    if (bytes) rmSync(join(temp, 'model.glb'), { force: true })
    if (existsSync(temp)) rmdirSync(temp)
  }
}

const nameOf = raw => {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 120) throw new ApiError(400, '名称须为 1–120 字')
  return name
}

export function createBuildLibrary(root) {
  const models = join(root, 'assets', 'imported-models')
  const combinations = join(root, '.data', 'build-combinations')
  return {
    models: () => Object.fromEntries(readEntries(models).map(model => [`models/${model.id}`, model])),
    combinations: () => readEntries(combinations),
    saveCombination(input) {
      const name = nameOf(input?.name)
      const assets = input?.assets
      if (!Array.isArray(assets) || !assets.length || assets.length > 256) throw new ApiError(400, '组合须包含 1–256 个对象')
      const id = randomUUID()
      validateWorkspace({ document: {
        meta: { id, name, version: 1, unit: 'm', up: '+Y' }, environment: {}, cameras: [], assets,
      }, journal: [], redoStack: [], txCounter: 0 }, id)
      return writeEntry(combinations, id, { id, name, assets })
    },
    async model(bytes, query, save) {
      const name = nameOf(query.get('name'))
      const yaw = Number(query.get('yaw') ?? 0)
      const offsetY = Number(query.get('offsetY') ?? 0)
      const unitScale = Number(query.get('unitScale') ?? 1)
      if (![yaw, offsetY, unitScale].every(Number.isFinite) || Math.abs(yaw) > 360 || Math.abs(offsetY) > 10000
        || unitScale < 0.00001 || unitScale > 10000) throw new ApiError(400, '模型单位、朝向或落地原点参数无效')
      const { inspectGlb, assertStaticExtensions, measuredStaticBounds } = await loadParser()
      let bounds
      try {
        const inspected = inspectGlb(bytes, { up: '+Y', metersPerUnit: 1 })
        assertStaticExtensions(inspected, name, name + '.glb')
        if (inspected.externalRefs.length || inspected.stats.skins || inspected.stats.animations || inspected.stats.morphTargets) {
          throw new Error('只支持自带资源、无动画/蒙皮/变形目标的静态 GLB')
        }
        bounds = measuredStaticBounds(bytes, inspected, yaw)
        if (!bounds || !inspected.stats.vertices) throw new Error('模型没有可用的网格和尺寸')
      } catch (cause) { throw new ApiError(400, cause instanceof Error ? cause.message : String(cause)) }
      const width = unitScale * (bounds.max[0] - bounds.min[0])
      const depth = unitScale * (bounds.max[2] - bounds.min[2])
      const height = unitScale * (bounds.max[1] - bounds.min[1])
      if (![width, height, depth, ...bounds.min, ...bounds.max].every(n => Number.isFinite(n) && Math.abs(n) <= 1e6)) {
        throw new ApiError(400, '模型边界超出可用范围')
      }
      const id = 'imported-' + createHash('sha256').update(bytes).update(JSON.stringify([name, yaw, offsetY, unitScale])).digest('hex').slice(0, 24)
      const model = {
        id, name, category: '手工导入', assetVersion: 1,
        dimensions: { w: width, h: height, d: depth },
        bounds: { min: [-width / 2, offsetY, -depth / 2], max: [width / 2, height + offsetY, depth / 2] },
        source: {
          type: 'glb', file: 'model.glb', url: `/assets/imported-models/${id}/model.glb`,
          rotationY: yaw, unitScale, offset: [
            -unitScale * (bounds.min[0] + bounds.max[0]) / 2, offsetY - unitScale * bounds.min[1],
            -unitScale * (bounds.min[2] + bounds.max[2]) / 2,
          ],
        },
      }
      return save ? writeEntry(models, id, model, bytes) : model
    },
  }
}
