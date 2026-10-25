import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

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

function serveDataDirs(): Plugin {
  const serve = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    const match = url.match(/^\/(assets|scenes)\/(.+)$/)
    if (!match) return false
    const dirRoot = resolve(layoutRoot, match[1])
    const filePath = resolve(dirRoot, ...match[2].split('/'))
    if (!filePath.startsWith(dirRoot + sep)) return false // 防目录穿越
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return false
    res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
    // 资产（尤其转换生成的 glb）会频繁被同名覆盖，禁用一切缓存——
    // 否则 Chromium 内存缓存回放旧字节，查看器永远显示旧模型
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(filePath).pipe(res)
    return true
  }
  const install = (middlewares: Connect.Server) => {
    middlewares.use((req, res, next) => {
      if (handleSaveScene(req, res)) return
      if (handleLogs(req, res)) return
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
