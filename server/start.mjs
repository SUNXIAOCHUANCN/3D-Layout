import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, sep, extname } from 'node:path'
import { createWorkspaceApi } from './http.mjs'

const root = process.env.LAYOUT_ROOT ?? fileURLToPath(new URL('..', import.meta.url))
const api = createWorkspaceApi(root)
// 浏览器端 OpenCode Go 需要 /api/llm/request 转发；开发模式由 Vite 中间件提供，独立服务在这里挂同一份。
const relay = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(
  readFileSync(new URL('../src/modules/llm-shared/relayServer.ts', import.meta.url), 'utf8'),
)).toString('base64'))
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.hdr': 'application/octet-stream', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2' }
const server = createServer((req, res) => {
  if (relay.handleLlmRelay(req, res)) return
  api.handler(req, res, () => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (pathname.startsWith('/api/')) { res.writeHead(404).end(); return }
    const data = pathname.match(/^\/(assets|scenes)\/(.*)$/)
    const base = resolve(root, data ? data[1] : 'src/dist')
    const file = resolve(base, data ? data[2] : pathname === '/' ? 'index.html' : pathname.slice(1))
    if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return }
    res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.method === 'HEAD') res.end()
    else createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch { res.writeHead(400).end() }
  })
})
server.listen(Number(process.env.PORT ?? 5173), '127.0.0.1', () => console.log(`3D-Layout http://127.0.0.1:${server.address().port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { api.close(); process.exit(0) }))
