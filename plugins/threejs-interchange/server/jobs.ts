/**
 * 导入任务存储与 prepare：上传候选包（zip）→ 解压校验 → 冲突检测 → 暂存。
 * 服务端独立复核 schema、摘要、引用与 GLB 边界，不信任上传 meta。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import {
  type ImportIntegrity, type LayoutImport, type NativeModelMeta,
  type NativeSceneDocument, type ImportReport,
} from '../application/contracts.js'
import { InterchangeError, errorIssue, type Issue } from '../application/errors.js'
import { stableStringify } from '../application/json.js'
import { textBytes } from '../application/digest.js'
import {
  LIMITS, normalizeZipEntryPath, validateCandidateEntries, validateLayoutImport,
} from '../application/validation.js'
import { inspectGlb } from '../application/glb-inspect.js'
import { isValidSceneId, hashSuffix } from '../application/naming.js'
import { rewriteSceneDoc } from '../adapters/layout/native-write.js'
import { dirExists, resolveWithin, writeState } from './install.js'

export type JobState = 'staged' | 'committing' | 'committed' | 'failed' | 'cancelled'

export interface JobFile {
  rel: string
  sha256: string
  bytes: number
}

export interface JobRecord {
  id: string
  state: JobState
  createdAt: string
  updatedAt: string
  requestedSceneId: string
  sceneId: string
  policy: 'reject' | 'suffix-hash'
  files: JobFile[]
  newModelRefs: string[]
  metas: Record<string, NativeModelMeta> // ref -> meta（提交时核验索引用）
  report: ImportReport | null
  issues: Issue[]
  renames: Array<{ from: string; to: string }>
  error?: string
}

export class JobStore {
  constructor(readonly root: string, readonly dataDir: string) {
    mkdirSync(join(dataDir, 'jobs'), { recursive: true })
  }

  private jobDir(id: string): string {
    if (!/^[a-z0-9-]{6,80}$/.test(id)) throw new InterchangeError('BAD_REQUEST', `非法 jobId：${id}`)
    return join(this.dataDir, 'jobs', id)
  }

  get(id: string): JobRecord {
    const dir = this.jobDir(id)
    const statePath = join(dir, 'state.json')
    if (!existsSync(statePath)) throw new InterchangeError('JOB_NOT_FOUND', `任务不存在：${id}`)
    return JSON.parse(readFileSync(statePath, 'utf8')) as JobRecord
  }

  save(job: JobRecord): void {
    job.updatedAt = new Date().toISOString()
    writeState(this.jobDir(job.id), job as unknown as Record<string, unknown>)
  }

  list(): JobRecord[] {
    const jobsDir = join(this.dataDir, 'jobs')
    if (!existsSync(jobsDir)) return []
    return readdirSync(jobsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        try { return this.get(e.name) } catch { return null }
      })
      .filter((j): j is JobRecord => j !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  cancel(id: string): void {
    const job = this.get(id)
    if (job.state === 'committing') {
      throw new InterchangeError('BAD_REQUEST', '提交进行中不能取消；请等待完成或服务恢复')
    }
    rmSync(this.jobDir(id), { recursive: true, force: true })
  }

  /** prepare：解压 → 逐层校验 → 冲突 → 暂存（暂存目录在 assets/models 与 scenes 扫描范围之外） */
  prepare(zipBytes: Uint8Array, policy: 'reject' | 'suffix-hash'): JobRecord {
    if (zipBytes.byteLength > LIMITS.maxTotalBytes) {
      throw new InterchangeError('LIMIT_EXCEEDED', `上传包 ${zipBytes.byteLength} 字节超过上限`)
    }
    let raw: Record<string, Uint8Array>
    try {
      raw = unzipSync(zipBytes)
    } catch (e) {
      throw new InterchangeError('INVALID_DECLARATION', `zip 解压失败：${e instanceof Error ? e.message : String(e)}`)
    }

    // 归一化条目路径并过滤目录项
    const entries = new Map<string, Uint8Array>()
    for (const [rawName, bytes] of Object.entries(raw)) {
      if (rawName.endsWith('/') || rawName.endsWith('\\')) continue // zip 目录条目
      const p = normalizeZipEntryPath(rawName)
      if (p === null) {
        throw new InterchangeError('PATH_UNSAFE', `归档条目路径不安全：${JSON.stringify(rawName)}`)
      }
      if (p === '') continue
      if (entries.has(p)) throw new InterchangeError('DUPLICATE_ENTRY', `归档内重复条目：${p}`)
      entries.set(p, bytes)
    }

    const entryIssues = validateCandidateEntries(Array.from(entries, ([path, b]) => ({ path, bytes: b.byteLength })))
    const blocking = entryIssues.filter(i => i.severity === 'error')
    if (blocking.length > 0) {
      throw new InterchangeError(blocking[0].code, `候选包校验失败：${blocking[0].message}（共 ${blocking.length} 个阻断问题）`)
    }

    // 场景文档与声明
    const sceneJsonPath = Array.from(entries.keys()).find(p => /^scenes\/[^/]+\/scene\.json$/.test(p))
    if (!sceneJsonPath) throw new InterchangeError('INVALID_DECLARATION', '候选包缺少 scenes/<id>/scene.json')
    const sceneIdFromPath = sceneJsonPath.split('/')[1]
    if (!isValidSceneId(sceneIdFromPath)) throw new InterchangeError('INVALID_DECLARATION', `场景目录 ID 非法：${sceneIdFromPath}`)

    const declPath = 'import/layout-import.json'
    const declBytes = entries.get(declPath)
    if (!declBytes) throw new InterchangeError('INVALID_DECLARATION', `候选包缺少 ${declPath}（声明是必需要求；未声明资产边界不导入）`)
    let declaration: LayoutImport
    try {
      declaration = JSON.parse(new TextDecoder().decode(declBytes)) as LayoutImport
    } catch (e) {
      throw new InterchangeError('INVALID_DECLARATION', `声明 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
    }
    const declCheck = validateLayoutImport(declaration)
    if (!declCheck.ok) {
      throw new InterchangeError('INVALID_DECLARATION', `声明校验失败：${declCheck.issues[0].message}（共 ${declCheck.issues.length} 条）`)
    }
    if (declaration.scene.id !== sceneIdFromPath) {
      throw new InterchangeError('INVALID_DECLARATION', `声明 scene.id (${declaration.scene.id}) 与目录名 (${sceneIdFromPath}) 不一致`)
    }

    const sceneDoc = parseJson<NativeSceneDocument>(entries.get(sceneJsonPath), 'scene.json')
    const issues: Issue[] = []

    // 引用闭包：场景每个 ref 都要有模型目录；每个模型目录都要被引用
    const refSet = new Set(sceneDoc.assets.map(a => a.ref))
    const modelDirs = new Set<string>()
    for (const p of entries.keys()) {
      const m = /^assets\/models\/([^/]+)\/meta\.json$/.exec(p)
      if (m) modelDirs.add(m[1])
    }
    for (const ref of refSet) {
      const dir = /^models\/([^/]+)$/.exec(ref)?.[1]
      if (!dir || !modelDirs.has(dir)) {
        throw new InterchangeError('MISSING_RESOURCE', `场景引用的模型不在包内：${ref}`)
      }
    }
    for (const dir of modelDirs) {
      if (!refSet.has(`models/${dir}`)) {
        throw new InterchangeError('UNUSED_MODEL', `包内模型未被场景引用：models/${dir}（一期要求闭包紧凑）`)
      }
    }

    // HDRI 依赖
    if (sceneDoc.environment?.hdri !== undefined) {
      const p = sceneDoc.environment.hdri
      if (!entries.has(p)) throw new InterchangeError('MISSING_RESOURCE', `环境贴图不在包内：${p}`, { path: p })
    }

    // 逐模型独立复核
    const metas = new Map<string, NativeModelMeta>()
    const modelCanonicalSha = new Map<string, string>()
    for (const dir of modelDirs) {
      const ref = `models/${dir}`
      const meta = parseJson<NativeModelMeta>(entries.get(`assets/models/${dir}/meta.json`), `${dir}/meta.json`)
      const glb = entries.get(`assets/models/${dir}/model.glb`)
      const integrity = parseJson<ImportIntegrity>(entries.get(`assets/models/${dir}/import-integrity.json`), `${dir}/import-integrity.json`)
      if (!glb) throw new InterchangeError('MISSING_RESOURCE', `模型缺少 model.glb：${ref}`)

      // 字节摘要必须与 integrity 声明一致
      const actualSha = awaitHex(glb)
      if (actualSha !== integrity.canonical.sha256) {
        throw new InterchangeError('HASH_MISMATCH', `GLB 摘要与 integrity 声明不一致：${ref}`)
      }

      // 纯数据 GLB 复核：压缩/外链/蒙皮/边界。
      // 候选包里的 model.glb 是转换器产出的规范模型（米制/+Y/底面中心），
      // 复核按文件自身空间取边界，与 integrity.localBounds 直接比对 —— 不再做 N 变换。
      const inspection = inspectGlb(glb, { metersPerUnit: 1, up: '+Y' })
      for (const ext of inspection.extensionsUsed) {
        if (['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression'].includes(ext)) {
          throw new InterchangeError('COMPRESSED_INPUT', `服务端复核：${ref} 含压缩扩展 ${ext}`, { path: ref })
        }
      }
      if (inspection.externalRefs.length > 0) {
        throw new InterchangeError('EXTERNAL_RESOURCE_REF', `服务端复核：${ref} 引用外部资源`, { path: ref })
      }
      if (inspection.stats.skins > 0 || inspection.stats.morphTargets > 0) {
        throw new InterchangeError('UNSUPPORTED_SKIN', `服务端复核：${ref} 含蒙皮或 morph`, { path: ref })
      }
      if (!inspection.boundsCanonical) {
        throw new InterchangeError('INVALID_DECLARATION', `服务端复核：${ref} 无有效几何`)
      }

      // 边界复核：integrity.localBounds 与纯数据重算值比对（相对容差 1e-3）
      const tolerance = (extent: number) => Math.max(1e-4, extent * 1e-3)
      const b = inspection.boundsCanonical
      const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
      for (let i = 0; i < 3; i++) {
        if (Math.abs(b.min[i] - integrity.localBounds.min[i]) > tolerance(ext[i]) ||
            Math.abs(b.max[i] - integrity.localBounds.max[i]) > tolerance(ext[i])) {
          throw new InterchangeError('DIMENSIONS_MISMATCH',
            `服务端复核：${ref} 边界与 integrity.localBounds 不一致（重算 min=[${b.min.map(v => v.toFixed(4))}] max=[${b.max.map(v => v.toFixed(4))}]，声明 min=[${integrity.localBounds.min.map(v => v.toFixed(4))}] max=[${integrity.localBounds.max.map(v => v.toFixed(4))}]）`)
        }
      }
      // meta.dimensions 与实际边界尺寸比对
      const dw = ext[0], dh = ext[1], dd = ext[2]
      const dimTol = (v: number) => Math.max(1e-4, v * 1e-3)
      if (Math.abs(meta.dimensions.w - dw) > dimTol(dw) ||
          Math.abs(meta.dimensions.h - dh) > dimTol(dh) ||
          Math.abs(meta.dimensions.d - dd) > dimTol(dd)) {
        throw new InterchangeError('DIMENSIONS_MISMATCH', `服务端复核：${ref} meta.dimensions 与实际几何不一致`)
      }
      if (meta.id !== dir) {
        throw new InterchangeError('INVALID_DECLARATION', `meta.id (${meta.id}) 与目录名 (${dir}) 不一致`)
      }
      metas.set(ref, meta)
      modelCanonicalSha.set(ref, actualSha)
    }

    // 冲突检测（对工程当前磁盘状态）
    const existingSceneIds = diskSceneIds(this.root)
    const existingModelRefs = diskModelRefs(this.root)
    const conflicts: string[] = []
    if (existingSceneIds.has(sceneIdFromPath)) conflicts.push(`scene:${sceneIdFromPath}`)
    for (const ref of metas.keys()) {
      if (existingModelRefs.has(ref)) conflicts.push(`model:${ref}`)
    }

    let sceneId = sceneIdFromPath
    const renames: Array<{ from: string; to: string }> = []
    const stagedEntries = entries
    const stagedSceneDoc = sceneDoc
    const finalIssues = issues

    if (conflicts.length > 0) {
      if (policy === 'reject') {
        throw new InterchangeError('ID_CONFLICT', `目标 ID 冲突：${conflicts.join('；')}（默认拒绝；如需追加摘要后缀请使用 suffix-hash 策略）`)
      }
      // suffix-hash：场景与全部模型目录统一追加摘要前缀，改写引用
      const conflictSource = stableStringify({ sceneId: sceneIdFromPath, refs: Array.from(metas.keys()).sort() }) +
        Array.from(modelCanonicalSha.entries()).sort().map(([k, v]) => k + v).join('')
      const suffix = hashSuffix(awaitHex(textBytes(conflictSource)))
      const newSceneId = `${sceneIdFromPath}-${suffix}`
      if (!isValidSceneId(newSceneId)) {
        throw new InterchangeError('INVALID_DECLARATION', `追加后缀后的场景 ID 超长：${newSceneId}`)
      }
      const dirRenames = new Map<string, string>()
      for (const dir of modelDirs) dirRenames.set(dir, `${dir}-${suffix}`)
      const rewritten = rewriteSceneDoc(stagedSceneDoc, newSceneId, dirRenames)
      stagedEntries.set(sceneJsonPath, textBytes(prettyJson(rewritten)))
      stagedEntries.set(declPath, rewriteDeclarationSceneId(stagedEntries.get(declPath)!, newSceneId))
      // 场景目录整体改写到新 ID（scene.json/view.json/report 等）
      const oldPrefix = `scenes/${sceneIdFromPath}/`
      const newPrefix = `scenes/${newSceneId}/`
      for (const p of Array.from(stagedEntries.keys())) {
        if (p.startsWith(oldPrefix)) {
          stagedEntries.set(newPrefix + p.slice(oldPrefix.length), stagedEntries.get(p)!)
          stagedEntries.delete(p)
        }
      }
      for (const [oldDir, newDir] of dirRenames) {
        for (const fileName of ['meta.json', 'model.glb', 'import-integrity.json']) {
          const from = `assets/models/${oldDir}/${fileName}`
          const to = `assets/models/${newDir}/${fileName}`
          if (stagedEntries.has(from)) {
            let bytes = stagedEntries.get(from)!
            if (fileName === 'meta.json') {
              // 目录 ID 改写必须同步 meta.id（gen-manifest 直接读文件内容）
              const meta = parseJson<NativeModelMeta>(bytes, `${oldDir}/meta.json`)
              meta.id = newDir
              bytes = textBytes(prettyJson(meta))
            }
            stagedEntries.set(to, bytes)
            stagedEntries.delete(from)
          }
        }
        renames.push({ from: `models/${oldDir}`, to: `models/${newDir}` })
      }
      const reportPath = `${newPrefix}import-report.json`
      if (stagedEntries.has(reportPath)) {
        const report = parseJson<ImportReport>(stagedEntries.get(reportPath), 'import-report.json')
        report.sceneId = newSceneId
        for (const m of report.models ?? []) {
          m.dir = dirRenames.get(m.dir) ?? m.dir
        }
        report.issues.push({ code: 'ID_CONFLICT_RENAMED', severity: 'info', message: `检测到 ID 冲突，按 suffix-hash 策略改写为 ${newSceneId}` })
        stagedEntries.set(reportPath, textBytes(prettyJson(report)))
      }
      sceneId = newSceneId
      finalIssues.push(errorIssue('ID_CONFLICT_RENAMED', `ID 冲突已按 suffix-hash 改写：${sceneIdFromPath} → ${newSceneId}`))
    }

    // 暂存（import/ 命名空间只用于校验，不属于安装目标，绝不发布到工程）
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    const jobDir = join(this.dataDir, 'jobs', id)
    const payloadDir = join(jobDir, 'payload')
    const files: JobFile[] = []
    for (const [p, bytes] of stagedEntries) {
      if (p.startsWith('import/')) continue
      const target = resolveWithin(payloadDir, p)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, bytes)
      files.push({ rel: p, sha256: awaitHex(bytes), bytes: bytes.byteLength })
    }

    const newModelRefs = Array.from(metas.keys()).map(r =>
      renames.find(rn => rn.from === r)?.to ?? r,
    )
    const finalMetas: Record<string, NativeModelMeta> = {}
    for (const [ref, meta] of metas) {
      const newRef = renames.find(rn => rn.from === ref)?.to ?? ref
      finalMetas[newRef] = meta.id !== undefined ? { ...meta, id: (renames.find(rn => rn.from === ref)?.to ?? ref).replace(/^models\//, '') } : meta
    }

    const job: JobRecord = {
      id,
      state: 'staged',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      requestedSceneId: sceneIdFromPath,
      sceneId,
      policy,
      files,
      newModelRefs,
      metas: finalMetas,
      report: parseJsonOrNull(stagedEntries.get(`scenes/${sceneId}/import-report.json`)),
      issues: finalIssues,
      renames,
    }
    this.save(job)
    return job
  }
}

// ---------- 磁盘状态（冲突检测真值 = 目录本身，不依赖可能过期的索引） ----------

export function diskSceneIds(root: string): Set<string> {
  const out = new Set<string>()
  const dir = join(root, 'scenes')
  if (!dirExists(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(dir, e.name, 'scene.json'))) out.add(e.name)
  }
  return out
}

export function diskModelRefs(root: string): Set<string> {
  const out = new Set<string>()
  const dir = join(root, 'assets', 'models')
  if (!dirExists(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && (existsSync(join(dir, e.name, 'meta.json')) || existsSync(join(dir, e.name, 'layout_manifest.json')))) out.add(`models/${e.name}`)
  }
  const builtins = join(root, 'assets', 'builtin-models.json')
  if (existsSync(builtins)) {
    const catalog = JSON.parse(readFileSync(builtins, 'utf8')) as { models: Record<string, unknown> }
    for (const ref of Object.keys(catalog.models)) out.add(ref)
  }
  return out
}

// ---------- helpers ----------

function parseJson<T>(bytes: Uint8Array | undefined, label: string): T {
  if (!bytes) throw new InterchangeError('MISSING_RESOURCE', `缺少文件：${label}`)
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch (e) {
    throw new InterchangeError('INVALID_DECLARATION', `${label} JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function parseJsonOrNull<T>(bytes: Uint8Array | undefined): T | null {
  if (!bytes) return null
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T } catch { return null }
}

/** Node 环境 SHA-256（同步，供服务端复核） */
import { createHash } from 'node:crypto'
function awaitHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function rewriteDeclarationSceneId(original: Uint8Array, newSceneId: string): Uint8Array {
  const decl = JSON.parse(new TextDecoder().decode(original)) as LayoutImport
  decl.scene = { ...decl.scene, id: newSceneId }
  return textBytes(prettyJson(decl))
}
