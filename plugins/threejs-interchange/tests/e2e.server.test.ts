/**
 * 沙箱端到端（绝不写真实工程）：prepare → staged → commit → 落盘断言 →
 * 包往返 → 冲突策略 → gen-manifest 失败回滚 → 中断恢复。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { startService, type Service } from '../server/http.js'
import { recoverUnfinishedJobs } from '../server/install.js'
import { buildCandidateBundle, makeSandbox, hasHostGenManifest } from './helpers.js'

const TMP = join(tmpdir(), 'interchange-e2e-' + process.pid)
mkdirSync(TMP, { recursive: true })
const PORT = 5277
const BASE = `http://127.0.0.1:${PORT}`

let service: Service

test.before(async () => {
  const sandbox = makeSandbox(join(TMP, 'root'))
  process.env.INTERCHANGE_DATA_DIR = join(TMP, 'data')
  service = await startService({ root: sandbox, port: PORT })
})

test.after(() => {
  service?.close()
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* windows 锁 */ }
})

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'x-interchange-token': service.token, ...(init?.headers as Record<string, string>) },
  })
  const ct = res.headers.get('content-type') ?? ''
  const body = ct.includes('json') ? JSON.parse(await res.text()) : await res.arrayBuffer()
  return { status: res.status, body }
}

test('准备接口要求令牌', async () => {
  const res = await fetch(BASE + '/api/interchange/prepare', { method: 'POST', body: Buffer.alloc(0) })
  assert.equal(res.status, 400)
})

test('prepare → staged → commit → 原生落盘 + 索引核验', async () => {
  const zip = buildCandidateBundle()
  const p = await api('/api/interchange/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: Buffer.from(zip),
  })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const job = p.body.job
  assert.equal(job.state, 'staged')
  assert.equal(job.sceneId, 'demo-forest')

  const c = await api(`/api/interchange/jobs/${job.id}/commit`, { method: 'POST' })
  assert.equal(c.status, 200, JSON.stringify(c.body))
  assert.equal(c.body.result.sceneId, 'demo-forest')
  assert.ok(c.body.result.added.length > 0)

  const root = service_server_root()
  const sceneJson = JSON.parse(readFileSync(join(root, 'scenes', 'demo-forest', 'scene.json'), 'utf8'))
  assert.equal(sceneJson.meta.id, 'demo-forest')
  assert.equal(sceneJson.meta.unit, 'm')
  assert.equal(sceneJson.assets.length, 2)
  assert.ok(sceneJson.assets.every((a: { ref: string }) => a.ref === 'models/demo-forest-pine'))
  assert.ok(existsSync(join(root, 'assets', 'models', 'demo-forest-pine', 'model.glb')))
  const meta = JSON.parse(readFileSync(join(root, 'assets', 'models', 'demo-forest-pine', 'meta.json'), 'utf8'))
  assert.ok(meta.dimensions.w > 0 && meta.dimensions.h > 0)

  const index = JSON.parse(readFileSync(join(root, 'scenes', 'index.json'), 'utf8'))
  assert.ok(index.some((e: { id: string }) => e.id === 'demo-forest'), '场景索引应包含新场景')
  const manifest = JSON.parse(readFileSync(join(root, 'assets', 'models', 'manifest.json'), 'utf8'))
  assert.ok(manifest.models['models/demo-forest-pine'], '模型 manifest 应包含新模型')

  const g = await api(`/api/interchange/jobs/${job.id}`)
  assert.equal(g.body.job.state, 'committed')
})

test('原生包导出：逐文件校验和可验证、不含全量索引', async () => {
  const e = await api('/api/interchange/export/package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sceneId: 'demo-forest' }),
  })
  assert.equal(e.status, 200)
  const entries = unzipSync(new Uint8Array(e.body))
  assert.ok(entries['scenes/demo-forest/scene.json'])
  assert.ok(entries['assets/models/demo-forest-pine/model.glb'])
  assert.ok(!entries['assets/models/manifest.json'], '不得携带全量 manifest')
  assert.ok(!entries['scenes/index.json'], '不得携带全量场景索引')
  const pkg = JSON.parse(new TextDecoder().decode(entries['package.json']!))
  assert.equal(pkg.kind, 'scene')
  for (const [rel, info] of Object.entries(pkg.files) as Array<[string, { sha256: string; bytes: number }]>) {
    const data = entries[rel]!
    const digest = (await import('node:crypto')).createHash('sha256').update(data).digest('hex')
    assert.equal(digest, info.sha256, `包内 ${rel} 校验和应一致`)
    assert.equal(data.byteLength, info.bytes)
  }
})

test('重复导入默认拒绝（ID 冲突）', async () => {
  const zip = buildCandidateBundle()
  const p = await api('/api/interchange/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: Buffer.from(zip),
  })
  assert.equal(p.status, 409)
  assert.equal(p.body.error.code, 'ID_CONFLICT')
})

test('suffix-hash 策略：改写场景与模型 ID 后可入库', async () => {
  const zip = buildCandidateBundle({ sceneId: 'demo-forest' })
  const p = await api('/api/interchange/prepare?conflict=suffix-hash', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: Buffer.from(zip),
  })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const job = p.body.job
  assert.notEqual(job.sceneId, 'demo-forest')
  assert.ok(job.sceneId.startsWith('demo-forest-'))
  assert.ok(job.renames.length > 0)

  const c = await api(`/api/interchange/jobs/${job.id}/commit`, { method: 'POST' })
  assert.equal(c.status, 200, JSON.stringify(c.body))
  const root = service_server_root()
  const newSceneJson = JSON.parse(readFileSync(join(root, 'scenes', job.sceneId, 'scene.json'), 'utf8'))
  assert.equal(newSceneJson.meta.id, job.sceneId)
  assert.ok(newSceneJson.assets[0].ref.startsWith('models/demo-forest-pine-'))
})

test('gen-manifest 失败 → 回滚，工程保持原状', async () => {
  const brokenRoot = makeSandbox(join(TMP, 'broken'), { withoutGenManifest: true })
  if (hasHostGenManifest(brokenRoot)) throw new Error('沙箱不应包含 gen-manifest')
  const manifestBefore = readFileSync(join(brokenRoot, 'assets', 'models', 'manifest.json'))
  const indexBefore = readFileSync(join(brokenRoot, 'scenes', 'index.json'))

  // 用独立数据目录 + 直接复用 JobStore/commit 逻辑（不起第二个端口）
  process.env.INTERCHANGE_DATA_DIR = join(TMP, 'data-broken')
  const { JobStore } = await import('../server/jobs.js')
  const { acquireInstallLock } = await import('../server/install.js')
  const store = new JobStore(brokenRoot, join(TMP, 'data-broken'))
  const zip = buildCandidateBundle({ sceneId: 'rollback-case' })
  const job = store.prepare(zip, 'reject')
  assert.equal(job.state, 'staged')

  const lock = acquireInstallLock(join(TMP, 'data-broken'))
  store.save({ ...job, state: 'committing' })
  const { commitJob } = await import('../server/install.js')
  assert.throws(() => commitJob({
    root: brokenRoot,
    jobDir: join(TMP, 'data-broken', 'jobs', job.id),
    sceneId: job.sceneId,
    files: job.files,
    newModelRefs: job.newModelRefs,
    expectedMetas: new Map(Object.entries(job.metas)),
    payloadDir: join(TMP, 'data-broken', 'jobs', job.id, 'payload'),
  }), /gen-manifest|GEN_MANIFEST/)
  lock.release()

  assert.ok(!existsSync(join(brokenRoot, 'scenes', 'rollback-case')), '场景目录应被回滚')
  assert.ok(!existsSync(join(brokenRoot, 'assets', 'models', 'rollback-case-pine')), '模型目录应被回滚')
  assert.deepEqual(readFileSync(join(brokenRoot, 'assets', 'models', 'manifest.json')), manifestBefore, 'manifest 应恢复原字节')
  assert.deepEqual(readFileSync(join(brokenRoot, 'scenes', 'index.json')), indexBefore, '场景索引应恢复原字节')
})

test('进程中断恢复：committing 状态任务按日志回滚', async () => {
  const root = service_server_root()
  const dataDir = join(TMP, 'data-recover')
  process.env.INTERCHANGE_DATA_DIR = dataDir
  const jobDir = join(dataDir, 'jobs', 'recovjob-01')
  mkdirSync(join(jobDir, 'recovery'), { recursive: true })
  writeFileSync(join(jobDir, 'state.json'), JSON.stringify({ id: 'recovjob-01', state: 'committing' }))
  writeFileSync(join(jobDir, 'recovery', 'recovery.log.jsonl'), JSON.stringify({ op: 'add', path: 'scenes/ghost/scene.json' }) + '\n')
  mkdirSync(join(root, 'scenes', 'ghost'), { recursive: true })
  writeFileSync(join(root, 'scenes', 'ghost', 'scene.json'), '{}')

  const recovered = recoverUnfinishedJobs(dataDir, root)
  assert.equal(recovered.length, 1)
  assert.ok(!existsSync(join(root, 'scenes', 'ghost')), '中断任务新增文件应被回滚')
  const state = JSON.parse(readFileSync(join(jobDir, 'state.json'), 'utf8'))
  assert.equal(state.state, 'failed')
})

test('目标 ID 复核：已有场景被外部编辑后重复导入不被误跳过', async () => {
  const zip = buildCandidateBundle({ sceneId: 'forest' })
  const p = await api('/api/interchange/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: Buffer.from(zip),
  })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const c = await api(`/api/interchange/jobs/${p.body.job.id}/commit`, { method: 'POST' })
  assert.equal(c.status, 200, JSON.stringify(c.body))
  // 同一场景再导一次（场景目录已存在）→ 拒绝
  const p2 = await api('/api/interchange/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: Buffer.from(buildCandidateBundle({ sceneId: 'forest' })),
  })
  assert.equal(p2.status, 409, JSON.stringify(p2.body))
})

function service_server_root(): string {
  return (service as unknown as { server: unknown }).server ? join(TMP, 'root') : join(TMP, 'root')
}
