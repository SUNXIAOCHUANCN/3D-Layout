import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep, extname } from 'node:path'

const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const lengthFactor = { m: 1, cm: 0.01, mm: 0.001 }

function artifactPath(directory, relative) {
  if (typeof relative !== 'string' || relative.includes('\\')) throw new Error('Invalid artifact path')
  const path = resolve(directory, relative)
  if (!path.startsWith(resolve(directory) + sep) || !existsSync(path)) throw new Error(`Missing/unsafe artifact: ${relative}`)
  return path
}

function artifactUrl(directory, relative) {
  artifactPath(directory, relative)
  return `/assets/models/${encodeURIComponent(directory.split(/[\\/]/).pop())}/${relative.split('/').map(encodeURIComponent).join('/')}`
}

/** Adapt workflow bundles to the editor's meter-based catalog without changing the bundles. */
export function buildModelCatalog(modelsDir, builtins = {}) {
  const models = { ...builtins }
  const assetIds = new Set()
  for (const entry of readdirSync(modelsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const dir = join(modelsDir, entry.name)
    const manifestPath = join(dir, 'layout_manifest.json')
    if (!existsSync(manifestPath)) {
      const legacy = join(dir, 'meta.json')
      if (existsSync(legacy)) models[`models/${entry.name}`] = json(legacy)
      continue
    }
    const manifest = json(manifestPath)
    if (manifest.processing_status !== 'ready') continue
    const validation = existsSync(join(dir, 'validation.json')) ? json(join(dir, 'validation.json')) : {}
    if (validation.valid === false || validation.success === false) continue
    const unitScale = lengthFactor[manifest.coordinate_system?.unit]
    if (!unitScale || manifest.coordinate_system.up_axis !== '+Y') throw new Error(`Unsupported coordinates: ${entry.name}`)
    const dimensions = manifest.bounds?.dimensions_cm
    if (!Array.isArray(dimensions) || dimensions.length !== 3 || !dimensions.every(x => Number.isFinite(x) && x >= 0) || !dimensions.some(x => x > 0)) {
      throw new Error(`Invalid dimensions: ${entry.name}`)
    }
    const model = manifest.artifacts.model
    if (extname(model).toLowerCase() !== '.glb') throw new Error(`Editor currently requires GLB: ${entry.name}`)
    const tags = manifest.artifacts.tags ? json(artifactPath(dir, manifest.artifacts.tags)) : {}
    const label = manifest.object_label ?? tags.object_label
    const category = manifest.semantic_category ?? tags.semantic_category
    const retrieval = manifest.retrieval_profile ?? tags.retrieval_profile
    const bounds = manifest.bounds.aabb
    if (!bounds || ![bounds.min, bounds.max].every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) {
      throw new Error(`Invalid bounds: ${entry.name}`)
    }
    const id = manifest.asset_id
    if (typeof id !== 'string' || !id.trim()) throw new Error(`Missing asset ID: ${entry.name}`)
    if (assetIds.has(id)) throw new Error(`Duplicate asset ID: ${id}`)
    assetIds.add(id)
    // asset_id is stable workflow identity; directory/ref is the editor's readable location.
    if (models[`models/${entry.name}`]) throw new Error(`Duplicate model reference: models/${entry.name}`)
    models[`models/${entry.name}`] = {
      id, name: label?.display ?? label?.canonical ?? tags.name ?? id,
      category: category?.path?.join('/') ?? category?.leaf ?? 'uncategorized',
      categoryPath: category?.path ?? [],
      tags: [...new Set([...(tags.extended_tags ?? []), ...(retrieval?.terms ?? [])])],
      description: retrieval?.description ?? '',
      retrievalTerms: retrieval?.terms ?? [],
      dimensions: { w: dimensions[0] / 100, h: dimensions[1] / 100, d: dimensions[2] / 100 },
      bounds: { min: bounds.min.map(v => v * unitScale), max: bounds.max.map(v => v * unitScale) },
      source: { type: 'glb', file: model, url: artifactUrl(dir, model), unitScale },
      normalized: { unitScale, origin: 'base-center', up: '+Y' },
      assetVersion: manifest.asset_version,
      scaleStatus: manifest.scale?.status ?? 'unknown',
      scalePolicy: manifest.scale?.policy ?? null,
      frontStatus: manifest.coordinate_system.front_status ?? 'unverified',
      labelStatus: label?.status ?? 'unknown',
      style: { modeling: tags.modeling_style ?? null, rendering: tags.rendering_style ?? null,
               quality: tags.modeling_quality ?? null, precision: tags.modeling_precision ?? null },
      thumbnail: manifest.artifacts.thumbnail ? artifactUrl(dir, manifest.artifacts.thumbnail) : undefined,
      manifestUrl: `/assets/models/${encodeURIComponent(entry.name)}/layout_manifest.json`,
    }
  }
  return { generatedAt: new Date().toISOString(), models }
}

export function readBuiltinModels(root) {
  const path = join(root, 'assets', 'builtin-models.json')
  return existsSync(path) ? json(path).models : {}
}
