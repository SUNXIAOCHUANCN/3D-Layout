/**
 * 原生交换包 / 单模型包导出（架构文档 §8.1/§8.3）。
 * 规范模型字节原样复制（不重编码），逐文件 SHA-256 清单，
 * 不携带接收工程的全量 manifest 或 scenes/index。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync, type Zippable } from 'fflate'
import type { NativeSceneDocument, PackageManifest } from '../application/contracts.js'
import { InterchangeError } from '../application/errors.js'
import { sha256HexSync } from './sync-digest.js'
import { resolveWithin } from './install.js'

function fileEntry(abs: string): Uint8Array {
  if (!existsSync(abs)) throw new InterchangeError('MISSING_RESOURCE', `打包时文件缺失：${abs}`)
  return new Uint8Array(readFileSync(abs))
}

/** Keep workflow bundles intact, including nested model paths and centimeter metadata. */
function putModel(root: string, ref: string, files: Record<string, Uint8Array>): string {
  const match = /^models\/([A-Za-z0-9][A-Za-z0-9-]{0,63})$/.exec(ref)
  if (!match) throw new InterchangeError('INVALID_DECLARATION', `非法模型 ref：${ref}`)
  const dir = match[1]
  const bundleEntry = `assets/models/${dir}/layout_manifest.json`
  if (existsSync(resolveWithin(root, bundleEntry))) {
    const visit = (relative: string): void => {
      for (const entry of readdirSync(resolveWithin(root, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`
        if (entry.isSymbolicLink()) throw new InterchangeError('PATH_UNSAFE', `资产包包含符号链接：${child}`)
        if (entry.isDirectory()) visit(child)
        else if (entry.isFile()) files[child] = fileEntry(resolveWithin(root, child))
      }
    }
    visit(`assets/models/${dir}`)
    return bundleEntry
  }
  const builtinPath = resolveWithin(root, 'assets/builtin-models.json')
  if (existsSync(builtinPath)) {
    const builtins = JSON.parse(readFileSync(builtinPath, 'utf8')) as { models: Record<string, unknown> }
    if (builtins.models[ref]) {
      const existing = files['assets/builtin-models.json']
      const subset = existing ? JSON.parse(new TextDecoder().decode(existing)) as { models: Record<string, unknown> } : { models: {} }
      subset.models[ref] = builtins.models[ref]
      files['assets/builtin-models.json'] = new TextEncoder().encode(JSON.stringify(subset, null, 2) + '\n')
      return 'assets/builtin-models.json'
    }
  }
  const metaRel = `assets/models/${dir}/meta.json`
  files[metaRel] = fileEntry(resolveWithin(root, metaRel))
  const meta = JSON.parse(new TextDecoder().decode(files[metaRel])) as { source: { type: string; file?: string } }
  if (meta.source.type === 'glb') {
    const modelRel = `assets/models/${dir}/${meta.source.file ?? 'model.glb'}`
    files[modelRel] = fileEntry(resolveWithin(root, modelRel))
  }
  const integrity = `assets/models/${dir}/import-integrity.json`
  if (existsSync(resolveWithin(root, integrity))) files[integrity] = fileEntry(resolveWithin(root, integrity))
  return metaRel
}

export function buildScenePackage(root: string, sceneId: string): Uint8Array {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sceneId)) {
    throw new InterchangeError('BAD_REQUEST', `非法场景 ID：${sceneId}`)
  }
  const sceneDir = `scenes/${sceneId}`
  const sceneJsonAbs = resolveWithin(root, `${sceneDir}/scene.json`)
  if (!existsSync(sceneJsonAbs)) {
    throw new InterchangeError('MISSING_RESOURCE', `场景不存在：${sceneId}`)
  }
  const doc = JSON.parse(readFileSync(sceneJsonAbs, 'utf8')) as NativeSceneDocument

  const files: Record<string, Uint8Array> = {}
  const put = (rel: string): void => {
    files[rel] = fileEntry(resolveWithin(root, rel))
  }
  put(`${sceneDir}/scene.json`)
  for (const optional of [`${sceneDir}/threejs/view.json`, `${sceneDir}/import-report.json`]) {
    if (existsSync(resolveWithin(root, optional))) put(optional)
  }

  // 模型依赖闭包（含隐藏资产——场景资产列表即全部实例）
  const refs = Array.from(new Set(doc.assets.map(a => a.ref)))
  for (const ref of refs) {
    putModel(root, ref, files)
  }

  // 环境依赖
  if (doc.environment?.hdri) {
    const p = doc.environment.hdri
    if (!/^(assets)\//.test(p)) throw new InterchangeError('INVALID_DECLARATION', `environment.hdri 必须位于 assets/ 下：${p}`)
    put(p)
  }

  const manifest: PackageManifest = {
    format: '3d-layout-package',
    schemaVersion: 1,
    kind: 'scene',
    entry: `${sceneDir}/scene.json`,
    sceneId,
    createdAt: new Date().toISOString(),
    files: {},
  }
  for (const [rel, bytes] of Object.entries(files)) {
    manifest.files[rel] = { sha256: sha256HexSync(bytes), bytes: bytes.byteLength }
  }
  files['package.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n')
  return zipSync(files as Zippable, { level: 6 })
}

export function buildModelPackage(root: string, ref: string): Uint8Array {
  const m = /^models\/([A-Za-z0-9][A-Za-z0-9-]{0,63})$/.exec(ref)
  if (!m) throw new InterchangeError('BAD_REQUEST', `非法模型 ref：${ref}`)
  const files: Record<string, Uint8Array> = {}
  const metaRel = putModel(root, ref, files)
  const manifest: PackageManifest = {
    format: '3d-layout-package',
    schemaVersion: 1,
    kind: 'model',
    entry: metaRel,
    modelRef: ref,
    createdAt: new Date().toISOString(),
    files: {},
  }
  for (const [rel, bytes] of Object.entries(files)) {
    manifest.files[rel] = { sha256: sha256HexSync(bytes), bytes: bytes.byteLength }
  }
  files['package.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n')
  return zipSync(files as Zippable, { level: 6 })
}

export { join as joinPath }
