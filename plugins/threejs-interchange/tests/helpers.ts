/** 测试助手：合成 GLB、候选包构造、沙箱工程（绝不写真实工程目录） */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, type Zippable } from 'fflate'
import { inspectGlb } from '../application/glb-inspect.js'
import { textBytes } from '../application/digest.js'
import type { LayoutImport } from '../application/contracts.js'

/** 宿主工程根（从本文件位置推导：tests/ → 插件 → 工程根） */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_ROOT = resolve(PLUGIN_DIR, '..', '..')

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 最小合法 GLB：单 accessor 的 POSITION min/max（检查器只读 JSON 层） */
export function buildGlb(bounds: { min: [number, number, number]; max: [number, number, number] }, opts?: {
  extensionsUsed?: string[]
  externalBuffer?: boolean
  skins?: boolean
}): Uint8Array {
  const byteLength = 96
  const gltf: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: bounds.min, max: bounds.max }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength }],
    buffers: [{ byteLength, ...(opts?.externalBuffer ? { uri: 'external.bin' } : {}) }],
  }
  if (opts?.extensionsUsed) gltf.extensionsUsed = opts.extensionsUsed
  if (opts?.skins) gltf.skins = [{ inverseBindMatrices: 0 }]
  const json = new TextEncoder().encode(JSON.stringify(gltf))
  const jsonPad = (4 - (json.length % 4)) % 4 // GLB 规范：chunk 4 字节对齐
  const bin = new Uint8Array(byteLength)
  const total = 12 + 8 + json.length + jsonPad + 8 + byteLength
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, json.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(json, 20)
  if (jsonPad) out[20 + json.length] = 0x20
  const binOff = 20 + json.length + jsonPad
  dv.setUint32(binOff, byteLength, true)
  dv.setUint32(binOff + 4, 0x004e4942, true)
  out.set(bin, binOff + 8)
  return out
}

export interface BundleOptions {
  sceneId?: string
  coords?: { metersPerUnit: number; up: '+Y' | '+Z' }
  glbBounds?: { min: [number, number, number]; max: [number, number, number] }
  instances?: number
  conflict?: 'reject' | 'suffix-hash'
}

/** 构造一份"像转换器输出"的候选包 zip：声明 + scene.json + 模型三件套。
 *  meta/integrity 的边界取自纯数据检查器重算（e2e 的重点在事务而非转换）。 */
export function buildCandidateBundle(opts: BundleOptions = {}): Uint8Array {
  const sceneId = opts.sceneId ?? 'demo-forest'
  const coords = opts.coords ?? { metersPerUnit: 1, up: '+Y' as const }
  const glbBounds = opts.glbBounds ?? { min: [-0.5, 0, -0.4] as [number, number, number], max: [0.5, 1.2, 0.4] as [number, number, number] }
  const dir = `${sceneId}-pine`

  const glb = buildGlb(glbBounds)
  const inspection = inspectGlb(glb, coords)
  const bc = inspection.boundsCanonical!
  const dims = {
    w: bc.max[0] - bc.min[0],
    h: bc.max[1] - bc.min[1],
    d: bc.max[2] - bc.min[2],
  }

  const declaration: LayoutImport = {
    schemaVersion: 1,
    profile: 'layout-static-v1',
    scene: { id: sceneId, name: '测试场景' },
    coordinates: { ...coords, handedness: 'right' },
    models: [{ key: 'pine', name: '松树', category: 'vegetation', file: 'models/pine.glb' }],
    instances: Array.from({ length: opts.instances ?? 2 }, (_, i) => ({
      id: `pine-${i + 1}`,
      modelKey: 'pine',
      transform: { position: [i, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })),
    options: { conflict: opts.conflict ?? 'reject' },
  }

  const sceneJson = {
    meta: { id: sceneId, name: '测试场景', version: 1, unit: 'm', up: '+Y' },
    environment: {},
    assets: declaration.instances.map(inst => ({
      id: inst.id,
      ref: `models/${dir}`,
      transform: { position: inst.transform.position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    })),
    cameras: [],
  }

  const meta = {
    id: dir,
    name: '松树',
    category: 'vegetation',
    dimensions: dims,
    source: { type: 'glb', file: 'model.glb' },
    normalized: { unitScale: 1, origin: 'base-center', up: '+Y' },
  }

  const integrity = {
    format: '3d-layout-import-integrity',
    schemaVersion: 1,
    converter: 'threejs-interchange',
    converterVersion: '0.1.0',
    normalizationVersion: 'layout-static-v1',
    source: { file: 'models/pine.glb', sha256: sha256(glb), bytes: glb.byteLength, coordinates: { ...coords, handedness: 'right' } },
    canonical: { file: 'model.glb', sha256: sha256(glb), bytes: glb.byteLength },
    definitionHash: sha256(textBytes('test')),
    localBounds: { min: bc.min, max: bc.max },
    sourceToCanonical: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    createdAt: new Date().toISOString(),
  }

  const files: Record<string, Uint8Array> = {
    'import/layout-import.json': textBytes(JSON.stringify(declaration, null, 2) + '\n'),
    [`scenes/${sceneId}/scene.json`]: textBytes(JSON.stringify(sceneJson, null, 2) + '\n'),
    [`scenes/${sceneId}/import-report.json`]: textBytes(JSON.stringify({ format: '3d-layout-import-report', schemaVersion: 1, sceneId, issues: [] }, null, 2) + '\n'),
    [`assets/models/${dir}/meta.json`]: textBytes(JSON.stringify(meta, null, 2) + '\n'),
    [`assets/models/${dir}/model.glb`]: glb,
    [`assets/models/${dir}/import-integrity.json`]: textBytes(JSON.stringify(integrity, null, 2) + '\n'),
  }
  return zipSync(files as Zippable, { level: 6 })
}

/** 沙箱工程：最小宿主结构 + 真实 gen-manifest 脚本副本（从宿主工程复制） */
export function makeSandbox(base: string, opts?: { withoutGenManifest?: boolean }): string {
  mkdirSync(join(base, 'scenes'), { recursive: true })
  mkdirSync(join(base, 'assets', 'models'), { recursive: true })
  writeFileSync(join(base, 'scenes', 'index.json'), '[]\n')
  writeFileSync(join(base, 'assets', 'models', 'manifest.json'), JSON.stringify({ generatedAt: '', models: {} }, null, 2) + '\n')
  if (!opts?.withoutGenManifest) {
    // 从插件位置定位宿主脚本（沙箱可能在任意临时目录）
    const hostScript = join(HOST_ROOT, 'src', 'scripts', 'gen-manifest.mjs')
    if (!existsSync(hostScript)) {
      throw new Error(`宿主索引脚本不存在：${hostScript}（沙箱测试要求真实工程在位）`)
    }
    mkdirSync(join(base, 'src', 'scripts'), { recursive: true })
    copyFileSync(hostScript, join(base, 'src', 'scripts', 'gen-manifest.mjs'))
  }
  return base
}

export function hasHostGenManifest(base: string): boolean {
  return existsSync(join(base, 'src', 'scripts', 'gen-manifest.mjs'))
}
