import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin, Connect } from 'vite'
import { processBoundaries } from './processServer'
import { DrawingValidationError } from './processingErrors'
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 55 * 1024 * 1024) throw new Error('请求内容超过大小限制'); chunks.push(b) }
  return Buffer.concat(chunks)
}
export function partitionAgentPlugin(root: string): Plugin {
  const install = (middlewares: Connect.Server) => middlewares.use((req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/partition-agent/')) return next()
    void handle(req, res, url, root).catch(error => {
      if (res.headersSent) return res.end()
      res.statusCode = error instanceof DrawingValidationError ? 422 : 502; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  return { name: 'partition-agent', configureServer: server => { install(server.middlewares) }, configurePreviewServer: server => { install(server.middlewares) } }
}
async function handle(req: IncomingMessage, res: ServerResponse, url: URL, root: string) {
  if (url.pathname === '/api/partition-agent/process' && req.method === 'POST') {
    const ac = new AbortController()
    res.on('close', () => { if (!res.writableEnded) ac.abort() })
    const input = JSON.parse((await body(req)).toString('utf8'))
    const data = await processBoundaries(root, input, ac.signal)
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); return
  }
  const match = url.pathname.match(/^\/api\/partition-agent\/scenes\/([a-zA-Z0-9_-]+)$/)
  if (match) {
    const sceneId = match[1], dir = resolve(root, 'scenes', sceneId, 'partition-agent'), path = resolve(dir, 'session.json')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (!existsSync(resolve(root, 'scenes', sceneId, 'scene.json'))) { res.statusCode = 404; res.end('{}'); return }
    if (req.method === 'GET') { if (!existsSync(path)) { res.statusCode = 404; res.end('{}') } else res.end(readFileSync(path)); return }
    if (req.method === 'PUT') {
      const raw = await body(req), parsed = JSON.parse(raw.toString('utf8'))
      if (parsed.schemaVersion !== 1 || parsed.sceneId !== sceneId || !Array.isArray(parsed.turns) || !Array.isArray(parsed.chat)) throw new Error('会话格式或场景标识无效')
      mkdirSync(dir, { recursive: true }); const temp = path + '.tmp'; writeFileSync(temp, JSON.stringify(parsed, null, 2)); renameSync(temp, path)
      res.end('{"ok":true}'); return
    }
    res.statusCode = 405; res.end('{}'); return
  }
  res.statusCode = 404; res.end()
}
