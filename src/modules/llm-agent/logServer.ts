import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const LIMIT = 24 * 1024 * 1024

export function handleLlmAgentLog(req: IncomingMessage, res: ServerResponse, root: string): boolean {
  if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/api/llm-agent-log') return false
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > LIMIT) { tooLarge = true; return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    try {
      if (tooLarge) throw new Error('日志请求超出大小限制')
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      if (typeof body.id !== 'string' || !ID.test(body.id)) throw new Error('运行 ID 不合法')
      const dir = resolve(root, 'src', 'modules', 'llm-agent', 'logs', body.id)
      if (body.action === 'start') {
        if (existsSync(dir)) throw new Error('运行 ID 已存在')
        mkdirSync(dir, { recursive: true })
        writeFileSync(resolve(dir, 'run.json'), JSON.stringify({ id: body.id, request: body.request, meta: body.meta, startedAt: new Date().toISOString(), status: 'running' }, null, 2))
        writeFileSync(resolve(dir, 'scene-before.json'), JSON.stringify(body.scene, null, 2))
        writeFileSync(resolve(dir, 'events.jsonl'), '')
      } else if (body.action === 'event') {
        if (!existsSync(dir) || !body.event || typeof body.event !== 'object') throw new Error('运行或事件不存在')
        appendFileSync(resolve(dir, 'events.jsonl'), JSON.stringify(body.event) + '\n')
      } else if (body.action === 'screenshot') {
        if (!existsSync(dir)) throw new Error('运行不存在')
        if (typeof body.callId !== 'string' || !/^c[0-9]+$/.test(body.callId)) throw new Error('调用 ID 不合法')
        if (typeof body.dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.dataUrl)) throw new Error('截图格式不合法')
        const image = Buffer.from(body.dataUrl.slice('data:image/png;base64,'.length), 'base64')
        if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('截图不是 PNG')
        const screenshotDir = resolve(dir, 'screenshots')
        mkdirSync(screenshotDir, { recursive: true })
        writeFileSync(resolve(screenshotDir, `${body.callId}.png`), image, { flag: 'wx' })
      } else if (body.action === 'finish') {
        if (!existsSync(dir)) throw new Error('运行不存在')
        writeFileSync(resolve(dir, 'scene-after.json'), JSON.stringify(body.scene, null, 2))
        writeFileSync(resolve(dir, 'finish.json'), JSON.stringify({ outcome: body.outcome, logIncomplete: body.logIncomplete, finishedAt: new Date().toISOString() }, null, 2))
      } else throw new Error('未知日志操作')
      res.end(JSON.stringify({ ok: true }))
    } catch (e) {
      res.statusCode = 400
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    }
  })
  return true
}
