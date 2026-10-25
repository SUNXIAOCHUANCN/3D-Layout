/**
 * 入库事务（架构文档 §7.2）：received → validating → staged → committing → committed。
 *
 * 单写入者部署约束：插件安装锁只约束本插件；安装期间不得并行导入、
 * 运行 gen-manifest 或手动修改目标目录。恢复日志记录新增路径与索引备份，
 * 失败/中断时按日志回滚；gen-manifest 使用宿主现有脚本（不修改），
 * 索引核验采用"包含性"（新条目已出现且内容一致），因 manifest.json 含
 * generatedAt 时间戳，不做整文件字节对比。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { textBytes } from '../application/digest.js'
import { InterchangeError } from '../application/errors.js'
import type { NativeModelMeta, NativeSceneDocument } from '../application/contracts.js'

function sha256HexSync(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export const INDEX_FILES = {
  manifest: 'assets/model-catalog.json',
  scenes: 'scenes/index.json',
}

// ---------- 路径安全 ----------

export function resolveWithin(root: string, rel: string): string {
  const abs = resolve(root, rel)
  const rootAbs = resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new InterchangeError('PATH_UNSAFE', `目标路径越出工程根：${rel}`)
  }
  return abs
}

// ---------- 安装锁 ----------

export interface InstallLock {
  release(): void
}

export function acquireInstallLock(dataDir: string): InstallLock {
  mkdirSync(dataDir, { recursive: true })
  const lockPath = join(dataDir, 'install.lock')
  if (existsSync(lockPath)) {
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; startedAt: string }
      let alive = true
      try {
        process.kill(info.pid, 0)
      } catch {
        alive = false
      }
      if (alive) {
        throw new InterchangeError('INSTALL_LOCKED', `已有导入任务在安装中（PID ${info.pid}，自 ${info.startedAt}）；单写入者约束下请等待其完成`)
      }
      // 持锁进程已死，清理陈旧锁
      rmSync(lockPath)
    } catch (e) {
      if (e instanceof InterchangeError) throw e
      rmSync(lockPath)
    }
  }
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' })
  } catch {
    throw new InterchangeError('INSTALL_LOCKED', '安装锁创建失败（并发安装）；单写入者约束下请重试')
  }
  return {
    release() {
      try { rmSync(lockPath) } catch { /* 已被清理 */ }
    },
  }
}

// ---------- gen-manifest ----------

export function runGenManifest(root: string): { ok: true; output: string } | { ok: false; message: string } {
  const script = join(root, 'src', 'scripts', 'gen-manifest.mjs')
  if (!existsSync(script)) {
    return { ok: false, message: `宿主索引脚本不存在：${script}（提交要求工程包含 src/scripts/gen-manifest.mjs）` }
  }
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) {
    return { ok: false, message: `gen-manifest 失败（exit ${r.status}）：${(r.stderr || r.stdout || '').slice(0, 500)}` }
  }
  return { ok: true, output: r.stdout ?? '' }
}

// ---------- 包含性索引核验 ----------

export interface VerifyIndexInput {
  root: string
  newModelRefs: string[]
  expectedMetas: Map<string, NativeModelMeta> // ref -> meta
  sceneId: string
}

export function verifyIndexesInclusive(input: VerifyIndexInput): void {
  const { root, newModelRefs, expectedMetas, sceneId } = input
  const manifestPath = resolveWithin(root, INDEX_FILES.manifest)
  if (!existsSync(manifestPath)) throw new InterchangeError('GEN_MANIFEST_FAILED', 'gen-manifest 后 manifest.json 仍不存在')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { models: Record<string, unknown> }
  for (const ref of newModelRefs) {
    const got = manifest.models[ref]
    if (got === undefined) {
      throw new InterchangeError('GEN_MANIFEST_FAILED', `索引核验失败：manifest 缺少新模型 ${ref}`)
    }
    const want = expectedMetas.get(ref)
    if (want && JSON.stringify(got) !== JSON.stringify(want)) {
      throw new InterchangeError('GEN_MANIFEST_FAILED', `索引核验失败：manifest 中 ${ref} 与暂存 meta 不一致`)
    }
  }
  const indexPath = resolveWithin(root, INDEX_FILES.scenes)
  if (!existsSync(indexPath)) throw new InterchangeError('GEN_MANIFEST_FAILED', 'gen-manifest 后 scenes/index.json 仍不存在')
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Array<{ id: string }>
  if (!index.some(e => e.id === sceneId)) {
    throw new InterchangeError('GEN_MANIFEST_FAILED', `索引核验失败：场景索引缺少 ${sceneId}`)
  }
}

// ---------- 提交事务 ----------

export interface CommitPayloadFile {
  /** 相对工程根的路径 */
  rel: string
  sha256: string
  bytes: number
}

export interface CommitInput {
  root: string
  jobDir: string
  sceneId: string
  files: CommitPayloadFile[]
  newModelRefs: string[]
  expectedMetas: Map<string, NativeModelMeta>
  payloadDir: string
}

export interface CommitResult {
  sceneId: string
  added: string[]
  reused: string[]
}

export function commitJob(input: CommitInput): CommitResult {
  const { root, jobDir, sceneId, files, newModelRefs, expectedMetas, payloadDir } = input
  const recoveryDir = join(jobDir, 'recovery')
  mkdirSync(recoveryDir, { recursive: true })
  const logPath = join(recoveryDir, 'recovery.log.jsonl')
  const added: string[] = []
  const reused: string[] = []

  const appendLog = (entry: unknown): void => {
    writeFileSync(logPath, JSON.stringify(entry) + '\n', { flag: 'a' })
  }

  // 备份两个索引的当前字节（存在与否都记录）
  const backups: Array<{ rel: string; backup: string | null }> = []
  for (const rel of [INDEX_FILES.manifest, INDEX_FILES.scenes]) {
    const abs = resolveWithin(root, rel)
    if (existsSync(abs)) {
      const backupRel = `recovery/${rel.replace(/[\\/]/g, '__')}.bak`
      writeFileSync(join(jobDir, backupRel), readFileSync(abs))
      backups.push({ rel, backup: backupRel })
    } else {
      backups.push({ rel, backup: null })
    }
  }
  appendLog({ op: 'backupIndexes', backups })

  for (const f of files) {
    const target = resolveWithin(root, f.rel)
    if (existsSync(target)) {
      // 已存在：字节一致视为复用（幂等重提交）；不一致属冲突，预检应已拦截
      const existing = sha256HexSync(readFileSync(target))
      if (existing !== f.sha256) {
        rollbackFromLog({ root, jobDir, added })
        throw new InterchangeError('ID_CONFLICT', `目标已存在且内容不同：${f.rel}`)
      }
      reused.push(f.rel)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    const src = join(payloadDir, f.rel)
    writeFileSync(target, readFileSync(src))
    added.push(f.rel)
    appendLog({ op: 'add', path: f.rel })
  }

  appendLog({ op: 'genManifest' })
  const gm = runGenManifest(root)
  if (!gm.ok) {
    rollbackFromLog({ root, jobDir, added })
    throw new InterchangeError('GEN_MANIFEST_FAILED', gm.message)
  }

  try {
    verifyIndexesInclusive({ root, newModelRefs, expectedMetas, sceneId })
  } catch (e) {
    rollbackFromLog({ root, jobDir, added })
    throw e
  }

  writeFileSync(join(jobDir, 'COMMITTED'), new Date().toISOString())
  return { sceneId, added, reused }
}

// ---------- 回滚与恢复 ----------

export function rollbackFromLog(input: { root: string; jobDir: string; added: string[] }): void {
  const { root, jobDir, added } = input
  // 逆序删除本次新增文件，然后清理空目录
  for (const rel of [...added].reverse()) {
    try {
      const abs = resolveWithin(root, rel)
      if (existsSync(abs)) rmSync(abs)
    } catch { /* 尽力而为 */ }
  }
  // 恢复索引备份
  const recDir = join(jobDir, 'recovery')
  if (existsSync(recDir)) {
    for (const f of readdirSync(recDir)) {
      if (!f.endsWith('.bak')) continue
      const rel = f.replace(/\.bak$/, '').replace(/__/g, '/')
      // 文件名形如 assets__models__manifest.json
      const abs = resolveWithin(root, rel)
      if (existsSync(abs)) rmSync(abs)
      const parent = dirname(abs)
      if (existsSync(parent)) writeFileSync(abs, readFileSync(join(recDir, f)))
    }
  }
  // 清理因此空掉的场景/模型目录（不递归删非空）
  try { pruneEmptyDirs(join(root, 'scenes')) } catch { /* ignore */ }
  try { pruneEmptyDirs(join(root, 'assets', 'models')) } catch { /* ignore */ }
  try { pruneEmptyDirs(join(root, 'assets', 'hdri')) } catch { /* ignore */ }
}

function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) pruneEmptyDirs(p)
  }
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
  } catch { /* ignore */ }
}

/** 服务启动时恢复未完成提交（架构文档 §7.2：先恢复再允许新安装） */
export function recoverUnfinishedJobs(dataDir: string, root: string): string[] {
  const jobsDir = join(dataDir, 'jobs')
  const recovered: string[] = []
  if (!existsSync(jobsDir)) return recovered
  for (const entry of readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const jobDir = join(jobsDir, entry.name)
    const statePath = join(jobDir, 'state.json')
    if (!existsSync(statePath)) continue
    let state: { state?: string } = {}
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch { continue }
    if (state.state !== 'committing') continue
    const committed = existsSync(join(jobDir, 'COMMITTED'))
    if (committed) {
      // 提交已落盘，仅清理暂存 payload
      try { rmSync(join(jobDir, 'payload'), { recursive: true, force: true }) } catch { /* ignore */ }
      writeState(jobDir, { ...state, state: 'committed' })
      recovered.push(`${entry.name}: committed(已补记)`)
      continue
    }
    // 无 COMMITTED 标记 → 按日志回滚（返回到导入前状态，客户端可重试）
    const added = readAddedFromLog(jobDir)
    rollbackFromLog({ root, jobDir, added })
    writeState(jobDir, { ...state, state: 'failed', error: '进程中断，启动恢复时已按日志回滚；可重新提交' })
    recovered.push(`${entry.name}: rolled back`)
  }
  return recovered
}

function readAddedFromLog(jobDir: string): string[] {
  const logPath = join(jobDir, 'recovery', 'recovery.log.jsonl')
  const added: string[] = []
  if (!existsSync(logPath)) return added
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { op?: string; path?: string }
      if (entry.op === 'add' && typeof entry.path === 'string') added.push(entry.path)
    } catch { /* 忽略坏行 */ }
  }
  return added
}

export function writeState(jobDir: string, state: Record<string, unknown>): void {
  const tmp = join(jobDir, 'state.json.tmp')
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, join(jobDir, 'state.json'))
}

export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export const textEncoderBytes = textBytes
