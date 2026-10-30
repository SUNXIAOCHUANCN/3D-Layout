import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SceneDocument } from './core/types'
import { handleLlmAgentLog } from './modules/llm-agent/logServer'
import { handleLlmAgentPython } from './modules/llm-agent/pythonServer'

// 3D-Layout 根目录（本配置文件位于 src/ 内，数据目录在上一级）
const layoutRoot = fileURLToPath(new URL('..', import.meta.url))

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.bin': 'application/octet-stream',
}

/**
 * 把上级的 assets/ 与 scenes/ 作为静态数据目录伺服（dev 与 preview 都生效）。
 * 数据与源码分离：这两个目录不进 vite 工程，build 也不打包它们；
 * 部署时把 src/dist + assets + scenes 放到同一台服务器上即可。
 */
/**
 * 保存接口：POST /api/scene/<id>（dev/preview 专用；生产静态托管无此接口，
 * 前端 saveScene 会自动降级为下载 scene.json）。
 */
function handleSaveScene(req: IncomingMessage, res: ServerResponse): boolean {
  const url = decodeURIComponent((req.url ?? '').split('?')[0])
  const match = url.match(/^\/api\/scene\/([a-zA-Z0-9_-]+)$/)
  if (!match || req.method !== 'POST') return false
  const sceneId = match[1]
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    try {
      const doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        meta?: { id?: string }
      }
      const sceneDir = resolve(layoutRoot, 'scenes', sceneId)
      const target = resolve(sceneDir, 'scene.json')
      if (doc?.meta?.id !== sceneId) throw new Error('meta.id 与目标场景不一致')
      if (!target.startsWith(sceneDir + sep)) throw new Error('非法路径')
      if (!existsSync(dirname(target))) throw new Error(`场景 ${sceneId} 不存在`)
      writeFileSync(target, JSON.stringify(doc, null, 2) + '\n')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, saved: target }))
    } catch (e) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
  })
  return true
}

/**
 * 场景新建 / 删除接口（dev/preview 专用；生产静态托管无此接口）：
 * - POST   /api/scene        body {name}      → 建 scenes/<id>/scene.json + 登记索引
 * - DELETE /api/scene/<id>                    → 删整个场景目录 + 从索引摘除
 *
 * 与 handleSaveScene 同款安全约束：id 白名单、resolve 后 startsWith 双保险。
 * 索引 scenes/index.json 由本接口增量维护（gen-manifest.mjs 仍可随时全量重建）。
 */
const SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 空场景文档：结构对齐 scene-01，assets 为空（类型来自 core/types.ts，tsc 校验形状） */
function emptySceneDocument(id: string, name: string): SceneDocument {
  return {
    meta: { id, name, version: 1, unit: 'm', up: '+Y' },
    environment: {
      background: '#1c2128',
      sunIntensity: 1.6,
      ground: { size: [16, 16], receiveShadow: true },
    },
    assets: [],
    cameras: [{ id: 'main', position: [5.5, 4.2, 6.8], target: [0, 0.8, 0], fov: 50 }],
  }
}

/** 读场景索引（不存在时按空列表处理） */
function readSceneIndex(scenesDir: string): Array<{ id: string; name: string }> {
  const indexPath = resolve(scenesDir, 'index.json')
  if (!existsSync(indexPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is { id: string; name: string } =>
        !!e && typeof (e as { id?: unknown }).id === 'string',
    )
  } catch {
    return []
  }
}

/** 写场景索引：按 id 排序，与 gen-manifest.mjs 的 localeCompare 规则保持一致 */
function writeSceneIndex(scenesDir: string, entries: Array<{ id: string; name: string }>): void {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id))
  writeFileSync(resolve(scenesDir, 'index.json'), JSON.stringify(sorted, null, 2) + '\n')
}

/** 挑一个未被占用的 scene-NN 编号 */
function nextSceneId(scenesDir: string): string {
  const used = new Set(readdirSync(scenesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name))
  for (let n = 1; n < 10000; n++) {
    const id = `scene-${String(n).padStart(2, '0')}`
    if (!used.has(id)) return id
  }
  throw new Error('场景编号已耗尽')
}

function handleSceneAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  const url = decodeURIComponent((req.url ?? '').split('?')[0])
  const scenesDir = resolve(layoutRoot, 'scenes')

  // 新建空场景
  if (url === '/api/scene' && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { name?: unknown }
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) throw new Error('场景名称不能为空')
        if (name.length > 80) throw new Error('场景名称过长（上限 80 字符）')

        const id = nextSceneId(scenesDir)
        const sceneDir = resolve(scenesDir, id)
        if (!sceneDir.startsWith(scenesDir + sep)) throw new Error('非法路径')
        if (existsSync(sceneDir)) throw new Error(`场景 ${id} 已存在`)

        mkdirSync(sceneDir, { recursive: true })
        writeFileSync(resolve(sceneDir, 'scene.json'), JSON.stringify(emptySceneDocument(id, name), null, 2) + '\n')
        // 渲染绑定（相机/网格）与 scene-01 同款
        mkdirSync(resolve(sceneDir, 'threejs'), { recursive: true })
        writeFileSync(resolve(sceneDir, 'threejs', 'view.json'), JSON.stringify({ cameraId: 'main', grid: { enabled: true } }, null, 2) + '\n')

        const entries = readSceneIndex(scenesDir).filter(e => e.id !== id)
        entries.push({ id, name })
        writeSceneIndex(scenesDir, entries)

        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, id, name }))
      } catch (e) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      }
    })
    return true
  }

  // 删除场景
  const match = url.match(/^\/api\/scene\/([a-zA-Z0-9_-]+)$/)
  if (match && req.method === 'DELETE') {
    try {
      const sceneId = match[1]
      if (!SCENE_ID_RE.test(sceneId)) throw new Error(`非法场景 id：${sceneId}`)
      const sceneDir = resolve(scenesDir, sceneId)
      if (!sceneDir.startsWith(scenesDir + sep)) throw new Error('非法路径')
      if (!existsSync(sceneDir)) throw new Error(`场景 ${sceneId} 不存在`)
      // 至少保留一个场景
      const remaining = readdirSync(scenesDir, { withFileTypes: true }).filter(d => d.isDirectory()).length
      if (remaining <= 1) throw new Error('至少要保留一个场景')

      rmSync(sceneDir, { recursive: true, force: true })
      writeSceneIndex(scenesDir, readSceneIndex(scenesDir).filter(e => e.id !== sceneId))

      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, deleted: sceneId }))
    } catch (e) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
    return true
  }

  return false
}

/**
 * 调用记录接口（Agent 的 log.write 专用）：
 * - POST /api/log        body {filename, content} → 写 logs/<filename>（新建或覆写）
 * - GET  /api/log/list   → logs/ 根目录下符合规约的文件名列表
 * 文件名必须匹配 log\d{14}-….md（拒绝一切路径分隔符，天然只能落在 logs/ 根、
 * 进不了 Artificial/ 子目录）；resolve 后再校验一次防穿越（与场景保存同款双保险）。
 */
const LOG_FILE_RE = /^log\d{14}-[^/\\]+\.md$/

function handleLogs(req: IncomingMessage, res: ServerResponse): boolean {
  const url = decodeURIComponent((req.url ?? '').split('?')[0])
  const logsDir = resolve(layoutRoot, 'logs')
  if (req.method === 'GET' && url === '/api/log/list') {
    let files: string[] = []
    try {
      files = readdirSync(logsDir, { withFileTypes: true })
        .filter(d => d.isFile() && LOG_FILE_RE.test(d.name))
        .map(d => d.name)
        .sort()
    } catch {
      /* logs 目录不存在则返回空列表 */
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, files }))
    return true
  }
  if (req.method === 'POST' && url === '/api/log') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          filename?: unknown
          content?: unknown
        }
        if (typeof body.filename !== 'string' || !LOG_FILE_RE.test(body.filename)) {
          throw new Error('文件名不合规（须形如 log20261013225252-名称.md，不含路径）')
        }
        if (typeof body.content !== 'string') throw new Error('content 必须是字符串')
        const target = resolve(logsDir, body.filename)
        if (!target.startsWith(logsDir + sep)) throw new Error('非法路径')
        writeFileSync(target, body.content.endsWith('\n') ? body.content : body.content + '\n', 'utf8')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: true, saved: target }))
      } catch (e) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      }
    })
    return true
  }
  return false
}

/**
 * CoAgent 运行日志接口（自动落盘：一轮运行 = logs/coAgent/ 下的一份 md）：
 * - POST /api/coagent-log  body {filename, content} → 写 logs/coAgent/<filename>
 * 文件名只允许字母/数字/._- 且必须以 .md 结尾（天然的"只能落在 coAgent 子目录"），
 * resolve 后再校验一次防穿越（与场景保存/log.write 同款双保险）。
 */
const COAGENT_LOG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

function handleCoAgentLogs(req: IncomingMessage, res: ServerResponse): boolean {
  const url = decodeURIComponent((req.url ?? '').split('?')[0])
  if (req.method !== 'POST' || url !== '/api/coagent-log') return false
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        filename?: unknown
        content?: unknown
      }
      if (typeof body.filename !== 'string' || !COAGENT_LOG_RE.test(body.filename)) {
        throw new Error('文件名不合规（只允许字母/数字/._-，且以 .md 结尾）')
      }
      if (typeof body.content !== 'string') throw new Error('content 必须是字符串')
      const dir = resolve(layoutRoot, 'logs', 'coAgent')
      const target = resolve(dir, body.filename)
      if (!target.startsWith(dir + sep)) throw new Error('非法路径')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(target, body.content.endsWith('\n') ? body.content : body.content + '\n', 'utf8')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, saved: target, bytes: body.content.length }))
    } catch (e) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
  })
  return true
}

/**
 * 分区配套文件接口（P4）：
 * - POST /api/scene/<id>/coagent  body = PartitionFile → 写 scenes/<id>/coagent/partition.json
 *
 * 与 handleSaveScene 同款三重校验（sceneId 白名单、resolve 后 startsWith、目录必须已存在），
 * 外加体积上限与"临时文件改名"的原子替换：单文件原子，不等于跨文件事务
 * （scene.json 成功而分区失败时要能显示"部分保存"）。
 */
const PARTITION_MAX_BYTES = 5 * 1024 * 1024

function handlePartitionWrite(req: IncomingMessage, res: ServerResponse): boolean {
  const url = decodeURIComponent((req.url ?? '').split('?')[0])
  const match = url.match(/^\/api\/scene\/([a-zA-Z0-9_-]+)\/coagent$/)
  if (!match || req.method !== 'POST') return false
  const sceneId = match[1]
  const chunks: Buffer[] = []
  let size = 0
  let aborted = false
  req.on('data', (c: Buffer) => {
    if (aborted) return
    size += c.length
    if (size > PARTITION_MAX_BYTES) {
      aborted = true
      res.statusCode = 413
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: `分区文件超过 ${PARTITION_MAX_BYTES} 字节上限` }))
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (aborted) return
    try {
      const file = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        schemaVersion?: number
        sceneId?: string
        regions?: unknown
      }
      if (file?.sceneId !== sceneId) throw new Error('分区文件的 sceneId 与目标场景不一致')
      if (file?.schemaVersion !== 1) throw new Error('未知的分区文件版本，服务端不自动迁移')
      if (!Array.isArray(file?.regions) || file.regions.length === 0) throw new Error('分区文件缺少 regions')

      const sceneDir = resolve(layoutRoot, 'scenes', sceneId)
      if (!existsSync(sceneDir)) throw new Error(`场景 ${sceneId} 不存在`)
      const coagentDir = resolve(sceneDir, 'coagent')
      const target = resolve(coagentDir, 'partition.json')
      if (!target.startsWith(sceneDir + sep)) throw new Error('非法路径')
      if (!coagentDir.startsWith(sceneDir + sep)) throw new Error('非法路径')

      mkdirSync(coagentDir, { recursive: true })
      const tmp = resolve(coagentDir, `partition.json.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n')
      renameSync(tmp, target)

      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, saved: target }))
    } catch (e) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
  })
  return true
}

function serveDataDirs(): Plugin {
  const serve = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    const match = url.match(/^\/(assets|scenes)\/(.+)$/)
    if (!match) return false
    const dirRoot = resolve(layoutRoot, match[1])
    const filePath = resolve(dirRoot, ...match[2].split('/'))
    if (!filePath.startsWith(dirRoot + sep)) return false // 防目录穿越
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      // CoAgent 配套文件（scenes/<id>/coagent/*.json）缺失时必须显式 404：
      // 否则会落到 Vite 的 SPA fallback，返回 200 + index.html，
      // 前端就会把"还没有分区文件"误判成"文件损坏"（实测发现）。
      if (match[1] === 'scenes' && /^[^/]+\/coagent\/[^/]+\.json$/.test(match[2])) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: 'partition file not found' }))
        return true
      }
      return false
    }
    res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
    // 资产（尤其转换生成的 glb）会频繁被同名覆盖，禁用一切缓存——
    // 否则 Chromium 内存缓存回放旧字节，查看器永远显示旧模型
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(filePath).pipe(res)
    return true
  }
  const install = (middlewares: Connect.Server) => {
    middlewares.use((req, res, next) => {
      if (handlePartitionWrite(req, res)) return
      // 场景新建/删除（POST /api/scene 与 DELETE /api/scene/<id>）先于保存接口判定
      if (handleSceneAdmin(req, res)) return
      if (handleSaveScene(req, res)) return
      if (handleLogs(req, res)) return
      if (handleLlmAgentLog(req, res, layoutRoot)) return
      if (handleLlmAgentPython(req, res)) return
      if (handleCoAgentLogs(req, res)) return
      if (serve(req, res)) return
      next()
    })
  }
  return {
    name: 'serve-data-dirs',
    configureServer: server => install(server.middlewares),
    configurePreviewServer: server => install(server.middlewares),
  }
}

export default defineConfig({
  plugins: [react(), serveDataDirs()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      // 两个独立入口：主应用 index.html；CoAgent 图可视化页 graph.html（W10）
      // 分开打包 → 图页的 @xyflow/react + dagre 不进主应用 bundle。
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        graph: fileURLToPath(new URL('graph.html', import.meta.url)),
      },
    },
  },
})
