/**
 * CLI 安装器：静态托管/离线场景下，把 prepare 阶段下载的候选包 zip
 * 直接事务化安装进工程（与本地服务同一套事务代码，架构文档 §7.1）。
 *
 * 用法：pnpm cli:install -- --zip candidate.zip [--root <工程根>] [--conflict suffix-hash]
 */

import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JobStore } from '../server/jobs.js'
import { acquireInstallLock, commitJob } from '../server/install.js'
import { mkdirSync } from 'node:fs'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(arg('root') ?? resolve(pluginDir, '..', '..'))
const zipPath = arg('zip')
if (!zipPath) {
  console.error('用法：pnpm cli:install -- --zip <candidate.zip> [--root <工程根>] [--conflict reject|suffix-hash]')
  process.exit(1)
}

const dataDir = process.env.INTERCHANGE_DATA_DIR ?? join(pluginDir, '.data')
const store = new JobStore(root, dataDir)
const policy = arg('conflict') === 'suffix-hash' ? 'suffix-hash' : 'reject'

const job = store.prepare(new Uint8Array(readFileSync(zipPath)), policy)
console.log(`[interchange] 暂存完成：job=${job.id} scene=${job.sceneId} files=${job.files.length}`)
if (job.renames.length > 0) {
  console.log(`[interchange] 冲突改写：${job.renames.map(r => `${r.from}→${r.to}`).join('；')}`)
}

const lock = acquireInstallLock(dataDir)
try {
  store.save({ ...job, state: 'committing' })
  const result = commitJob({
    root,
    jobDir: join(dataDir, 'jobs', job.id),
    sceneId: job.sceneId,
    files: job.files,
    newModelRefs: job.newModelRefs,
    expectedMetas: new Map(Object.entries(job.metas)),
    payloadDir: join(dataDir, 'jobs', job.id, 'payload'),
  })
  mkdirSync(join(dataDir, 'jobs', job.id), { recursive: true })
  const { writeState } = await import('../server/install.js')
  const committed = store.get(job.id)
  writeState(join(dataDir, 'jobs', job.id), { ...committed, state: 'committed', result })
  console.log(`[interchange] 入库完成：场景 ${result.sceneId}（新增 ${result.added.length} 个文件，复用 ${result.reused.length} 个）`)
  console.log(`[interchange] 打开：${(arg('host') ?? 'http://localhost:5173').replace(/\/$/, '')}/?scene=${result.sceneId}`)
} catch (e) {
  const failed = store.get(job.id)
  const { writeState } = await import('../server/install.js')
  writeState(join(dataDir, 'jobs', job.id), { ...failed, state: 'failed', error: e instanceof Error ? e.message : String(e) })
  console.error(`[interchange] 入库失败：${e instanceof Error ? e.message : String(e)}`)
  console.error('[interchange] 已按恢复日志回滚；工程保持原状')
  process.exit(1)
} finally {
  lock.release()
}
