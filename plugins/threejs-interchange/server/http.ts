/**
 * 插件本地服务 HTTP 层：只绑定回环地址，校验 Origin 与会话令牌。
 * 独立于宿主 Vite（架构文档 §7.1）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InterchangeError } from '../application/errors.js'
import { CONVERTER_VERSION } from '../application/contracts.js'
import { diskModelRefs, diskSceneIds, JobStore } from './jobs.js'
import { acquireInstallLock, commitJob, recoverUnfinishedJobs, resolveWithin, writeState } from './install.js'
import { buildModelPackage, buildScenePackage } from './exports.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export interface ServerOptions {
  root: string
  port: number
  /** UI 构建产物目录；缺省用插件内 ui-dist */
  uiDist?: string
}

export interface Service {
  server: Server
  port: number
  token: string
  dataDir: string
  close(): void
}

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))

export function startService(opts: ServerOptions): Promise<Service> {
  return createService(opts)
}

async function createService(opts: ServerOptions): Promise<Service> {
  const { root, port } = opts
  const uiDist = opts.uiDist ?? join(pluginDir, 'ui-dist')
  // 数据目录默认在插件内（assets/models 与 scenes 扫描范围之外）；测试可用环境变量隔离
  const dataDir = process.env.INTERCHANGE_DATA_DIR ?? join(pluginDir, '.data')

  // 启动恢复：先处理未完成提交，再允许新安装（架构文档 §7.2）
  const recovered = recoverUnfinishedJobs(dataDir, root)
  for (const line of recovered) console.log(`[interchange] 恢复：${line}`)

  // token 持久化，重启后 UI 会话保持有效
  mkdirSync(dataDir, { recursive: true })
  const tokenPath = join(dataDir, 'token')
  let token: string
  if (existsSync(tokenPath)) {
    token = readFileSync(tokenPath, 'utf8').trim()
  } else {
    token = randomBytes(24).toString('hex')
    writeFileSync(tokenPath, token)
  }

  const jobs = new JobStore(root, dataDir)
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])

  const server = createServer((req, res) => {
    handle(req, res).catch(err => {
      const issue = err instanceof InterchangeError ? err.issue : { code: 'INTERNAL', severity: 'error' as const, message: String(err) }
      if (!res.headersSent) {
        res.writeHead(statusFor(issue.code), { 'content-type': 'application/json; charset=utf-8' })
      }
      res.end(JSON.stringify({ ok: false, error: issue }))
      console.error(`[interchange] ${issue.code}: ${issue.message}`)
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const method = req.method ?? 'GET'

    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        throw new InterchangeError('BAD_REQUEST', `Origin 不被允许：${origin}`)
      }
      // 无 Origin（SDK/curl）的写请求必须携带令牌证明本地身份
      if (method !== 'GET' && origin === undefined) requireToken(req)
    }

    if (url.pathname === '/api/interchange/token' && method === 'GET') {
      return json(res, { ok: true, token })
    }
    if (url.pathname === '/api/interchange/status' && method === 'GET') {
      return json(res, {
        ok: true,
        name: 'threejs-interchange',
        version: CONVERTER_VERSION,
        root,
        scenes: diskSceneIds(root).size,
        models: diskModelRefs(root).size,
      })
    }

    if (url.pathname.startsWith('/api/interchange/')) {
      requireToken(req)
      if (url.pathname === '/api/interchange/prepare' && method === 'POST') {
        const policy = url.searchParams.get('conflict') === 'suffix-hash' ? 'suffix-hash' : 'reject'
        const body = await readBody(req, 1024 * 1024 * 1024)
        const job = jobs.prepare(new Uint8Array(body), policy)
        return json(res, { ok: true, job })
      }
      const jobMatch = /^\/api\/interchange\/jobs\/([a-z0-9-]+)$/.exec(url.pathname)
      if (jobMatch && method === 'GET') {
        return json(res, { ok: true, job: jobs.get(jobMatch[1]) })
      }
      if (jobMatch && method === 'DELETE') {
        jobs.cancel(jobMatch[1])
        return json(res, { ok: true })
      }
      if (url.pathname === '/api/interchange/jobs' && method === 'GET') {
        return json(res, { ok: true, jobs: jobs.list() })
      }
      const commitMatch = /^\/api\/interchange\/jobs\/([a-z0-9-]+)\/commit$/.exec(url.pathname)
      if (commitMatch && method === 'POST') {
        const job = jobs.get(commitMatch[1])
        if (job.state !== 'staged') {
          throw new InterchangeError('BAD_REQUEST', `任务状态为 ${job.state}，只有 staged 可提交`)
        }
        const lock = acquireInstallLock(dataDir)
        try {
          // 锁内重读任务，防止预检后状态变化（架构文档 §7.2 步骤 2）
          const fresh = jobs.get(job.id)
          if (fresh.state !== 'staged') throw new InterchangeError('BAD_REQUEST', `任务状态已变为 ${fresh.state}`)
          jobs.save({ ...fresh, state: 'committing' })
          const result = commitJob({
            root,
            jobDir: join(dataDir, 'jobs', job.id),
            sceneId: job.sceneId,
            files: job.files,
            newModelRefs: job.newModelRefs,
            expectedMetas: new Map(Object.entries(job.metas)),
            payloadDir: join(dataDir, 'jobs', job.id, 'payload'),
          })
          const committed = jobs.get(job.id)
          writeState(join(dataDir, 'jobs', job.id), { ...committed, state: 'committed', result })
          // 清理暂存 payload（保留状态与报告，断线后仍可查询同一 jobId）
          rmSync(join(dataDir, 'jobs', job.id, 'payload'), { recursive: true, force: true })
          lock.release()
          return json(res, { ok: true, result })
        } catch (e) {
          lock.release()
          const failed = jobs.get(job.id)
          if (failed.state === 'committing' || failed.state === 'staged') {
            writeState(join(dataDir, 'jobs', job.id), { ...failed, state: 'failed', error: e instanceof Error ? e.message : String(e) })
          }
          throw e
        }
      }
      if (url.pathname === '/api/interchange/scenes' && method === 'GET') {
        const indexPath = resolveWithin(root, 'scenes/index.json')
        const entries = existsSync(indexPath)
          ? JSON.parse(readFileSync(indexPath, 'utf8')) as Array<{ id: string; name: string }>
          : []
        return json(res, { ok: true, scenes: entries })
      }
      if (url.pathname === '/api/interchange/models' && method === 'GET') {
        return json(res, { ok: true, models: Array.from(diskModelRefs(root)).sort() })
      }
      if (url.pathname === '/api/interchange/export/package' && method === 'POST') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as { sceneId?: string }
        const zip = buildScenePackage(root, String(body.sceneId ?? ''))
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${body.sceneId}.layout.zip"`,
        })
        res.end(Buffer.from(zip))
        return
      }
      if (url.pathname === '/api/interchange/export/model' && method === 'POST') {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}') as { ref?: string }
        const zip = buildModelPackage(root, String(body.ref ?? ''))
        res.writeHead(200, { 'content-type': 'application/zip' })
        res.end(Buffer.from(zip))
        return
      }
      throw new InterchangeError('BAD_REQUEST', `未知接口：${method} ${url.pathname}`)
    }

    if (method === 'GET') {
      return serveStatic(url.pathname, res)
    }
    throw new InterchangeError('BAD_REQUEST', `不支持：${method} ${url.pathname}`)
  }

  function requireToken(req: IncomingMessage): void {
    if ((req.headers['x-interchange-token'] ?? '') !== token) {
      throw new InterchangeError('BAD_REQUEST', '缺少有效令牌（X-Interchange-Token）')
    }
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    let rel = decodeURIComponent(pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const abs = normalize(join(uiDist, rel))
    if (!abs.startsWith(normalize(uiDist))) {
      res.writeHead(403).end()
      return
    }
    try {
      if (statSync(abs).isFile()) {
        res.writeHead(200, { 'content-type': MIME[extname(abs)] ?? 'application/octet-stream' })
        res.end(readFileSync(abs))
        return
      }
    } catch { /* fallthrough */ }
    const indexAbs = join(uiDist, 'index.html')
    if (existsSync(indexAbs)) {
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(readFileSync(indexAbs))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('UI 未构建：请在 plugins/threejs-interchange 下运行 pnpm build')
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  console.log(`[interchange] 插件服务已启动 http://127.0.0.1:${port}（工程根：${root}）`)
  return { server, port, token, dataDir, close: () => server.close() }
}

function statusFor(code: string): number {
  if (code === 'JOB_NOT_FOUND') return 404
  if (code === 'INSTALL_LOCKED' || code === 'ID_CONFLICT') return 409
  if (code === 'BAD_REQUEST') return 400
  return 422
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > limit) {
        reject(new InterchangeError('LIMIT_EXCEEDED', `请求体超过上限 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
