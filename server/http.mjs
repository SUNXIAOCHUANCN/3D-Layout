import { ApiError, WorkspaceRepository } from './workspaces.mjs'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskService } from './tasks.mjs'
import { createRecordings } from './recordings.mjs'
import { createBuildLibrary } from './build-library.mjs'

const MAX_BODY = 32 * 1024 * 1024
const LOG_NAME = /^log\d{14}-[^<>:"/\\|?*\u0000-\u001f]+\.md$/
function requireWrite(req) {
  if (req.method !== 'POST') throw new ApiError(405, '不支持的方法')
  if (req.headers['x-layout-client'] !== '1') throw new ApiError(403, '缺少客户端标识')
  if (req.headers.origin) {
    let origin
    try { origin = new URL(req.headers.origin).host } catch { throw new ApiError(403, '非法来源') }
    if (origin !== req.headers.host) throw new ApiError(403, '拒绝跨来源写入')
  }
}
async function bytes(req, limit = MAX_BODY) {
  let size = 0
  const chunks = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      req.resume()
      throw new ApiError(413, `请求超过 ${limit / 1024 / 1024} MiB`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function body(req) {
  const data = await bytes(req)
  try { return JSON.parse(data.toString('utf8')) }
  catch { throw new ApiError(400, '请求不是有效 JSON') }
}

function createScene(root, repository, input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80) throw new ApiError(400, '场景名称须为 1–80 字')
  const scenes = join(root, 'scenes')
  mkdirSync(scenes, { recursive: true })
  const used = new Set(repository.list().map(scene => scene.id))
  let id
  for (let n = 1; n < 10000; n++) {
    const candidate = `scene-${String(n).padStart(2, '0')}`
    if (used.has(candidate) || existsSync(join(scenes, candidate))) continue
    try {
      mkdirSync(join(scenes, candidate))
      id = candidate
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  if (!id) throw new ApiError(409, '场景编号已耗尽')
  const directory = join(scenes, id)
  mkdirSync(join(directory, 'threejs'), { recursive: true })
  const write = (path, value) => {
    writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n')
    renameSync(path + '.tmp', path)
  }
  write(join(directory, 'threejs', 'view.json'), { cameraId: 'main', grid: { enabled: true } })
  write(join(directory, 'scene.json'), {
    meta: { id, name, version: 1, unit: 'm', up: '+Y' },
    environment: { background: '#1c2128', sunIntensity: 1.6, ground: { size: [16, 16], receiveShadow: true } },
    assets: [],
    cameras: [{ id: 'main', position: [5.5, 4.2, 6.8], target: [0, 0.8, 0], fov: 50 }],
  })
  const indexPath = join(scenes, 'index.json')
  let entries = []
  try { entries = JSON.parse(readFileSync(indexPath, 'utf8')) } catch { /* generated index is optional */ }
  const index = Array.isArray(entries) ? entries.filter(entry => typeof entry?.id === 'string' && entry.id !== id) : []
  index.push({ id, name })
  write(indexPath, index.sort((a, b) => a.id.localeCompare(b.id)))
  return { ok: true, id, name }
}

/** Same middleware for Vite dev/preview and the standalone server. */
export function createWorkspaceApi(root) {
  const repository = new WorkspaceRepository(root)
  const tasks = new TaskService(repository)
  const recordings = createRecordings(root)
  const library = createBuildLibrary(root)
  const handler = (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    const match = url.pathname.match(/^\/api\/workspaces\/([^/]+)(?:\/(history|restore))?$/)
    const logRoute = ['/api/log', '/api/log/list', '/api/coagent-log'].includes(url.pathname)
    const taskRoute = url.pathname.match(/^\/api\/tasks(?:\/([\w-]+)(?:\/(attach|result|verdict|cancel|retry|clear|lease))?)?$/)
    const recordingRoute = url.pathname.match(/^\/api\/recordings\/([a-zA-Z0-9_-]{1,100})(?:\/([a-f0-9-]{36})(?:\/(start|batch|finish|visibility))?)?$/)
    const createSceneRoute = url.pathname === '/api/scene' && req.method === 'POST'
    const buildRoute = ['/api/build-models', '/api/build-models/inspect', '/api/build-combinations'].includes(url.pathname)
    if (!match && !logRoute && !taskRoute && !recordingRoute && !createSceneRoute && !buildRoute && !['/api/health', '/api/scenes'].includes(url.pathname)) return next()
    const send = (status, data) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(data))
    }
    void (async () => {
      if (buildRoute) {
        if (req.method === 'GET' && url.pathname === '/api/build-models') return send(200, library.models())
        if (req.method === 'GET' && url.pathname === '/api/build-combinations') return send(200, library.combinations())
        requireWrite(req)
        if (url.pathname === '/api/build-combinations') return send(200, library.saveCombination(await body(req)))
        if (req.headers['content-type'] !== 'application/octet-stream') throw new ApiError(400, '请选择 GLB 文件')
        return send(200, await library.model(await bytes(req, 64 * 1024 * 1024), url.searchParams, url.pathname === '/api/build-models'))
      }
      if (createSceneRoute) {
        requireWrite(req)
        return send(200, createScene(root, repository, await body(req)))
      }
      if (recordingRoute) {
        const [, sceneId, id, operation] = recordingRoute
        if (req.method === 'GET' && !operation) return send(200, id ? recordings.get(sceneId, id) : recordings.list(sceneId))
        requireWrite(req)
        if (!id || !operation) throw new ApiError(405, '不支持的录制操作')
        return send(200, recordings.write(sceneId, id, operation, await body(req)))
      }
      if (taskRoute) {
        const [, id, action] = taskRoute
        if (req.method === 'GET') return send(200, id ? tasks.public(tasks.get(id)) : tasks.public(tasks.latest(url.searchParams.get('sceneId'), url.searchParams.get('channel'))))
        requireWrite(req)
        const input = await body(req)
        if (!id) return send(200, tasks.create(input))
        if (action === 'attach') return send(200, tasks.attach(id, input.owner, input.apiKey))
        if (action === 'lease') return send(200, tasks.renewLease(id, input.owner, input.epoch))
        if (action === 'result') return send(200, tasks.result(id, input))
        if (action === 'verdict') return send(200, tasks.verdict(id, input))
        if (action === 'cancel') return send(200, tasks.cancel(id))
        if (action === 'retry') return send(200, tasks.retry(id, input))
        if (action === 'clear') return send(200, tasks.clearConversation(id))
        throw new ApiError(405, '不支持的任务操作')
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return send(200, { ok: true, schemaVersion: 1 })
      if (req.method === 'GET' && url.pathname === '/api/scenes') return send(200, repository.list())
      if (logRoute) {
        const directory = join(root, 'logs', url.pathname === '/api/coagent-log' ? 'coAgent' : '')
        mkdirSync(directory, { recursive: true })
        if (req.method === 'GET' && url.pathname === '/api/log/list') {
          const files = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && LOG_NAME.test(entry.name)).map(entry => entry.name).sort()
          return send(200, { ok: true, files })
        }
        requireWrite(req)
        if (url.pathname === '/api/log/list') throw new ApiError(405, '不支持的方法')
        const input = await body(req)
        const pattern = url.pathname === '/api/coagent-log' ? /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/ : LOG_NAME
        if (!input || typeof input.filename !== 'string' || input.filename.length > 200 || !pattern.test(input.filename) || typeof input.content !== 'string') throw new ApiError(400, '日志名称或内容不合法')
        writeFileSync(join(directory, input.filename), input.content.endsWith('\n') ? input.content : input.content + '\n')
        return send(200, { ok: true, file: input.filename })
      }
      if (!match) throw new ApiError(405, '不支持的方法')
      const [, id, action] = match
      if (req.method === 'GET' && !action) return send(200, repository.get(id))
      if (req.method === 'GET' && action === 'history') {
        const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)
        const limit = Number(url.searchParams.get('limit') ?? 50)
        if (!Number.isSafeInteger(before) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, '非法分页参数')
        return send(200, { items: repository.history(id, before, limit) })
      }
      if (req.method !== 'POST' || action === 'history') throw new ApiError(405, '不支持的方法')
      requireWrite(req)
      const input = await body(req)
      send(200, action === 'restore' ? repository.restore(id, input) : repository.commit(id, input))
    })().catch(error => {
      if (!error.status) console.error('[workspace]', error)
      send(error.status ?? 500, { error: error.status ? error.message : '服务内部错误，请查看日志' })
    })
  }
  return { handler, close: () => { tasks.close();repository.close() }, repository }
}
