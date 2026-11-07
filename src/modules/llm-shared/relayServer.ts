import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

const MAX_BODY = 24 * 1024 * 1024
/** 等待上游响应头的最长时间。模型排队、长上下文推理都可能要几分钟才开始回包。 */
const FIRST_BYTE_MS = 600_000
/** 已经开始回包后，两段数据之间允许的最长静默时间。 */
const IDLE_MS = 120_000
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 上游地址白名单：https 任意主机（可带端口，如自建网关）；http 仅限本机回环
 * （Ollama/LM Studio 等只提供明文本地接口的模型服务）。禁用凭据内嵌、query 和 hash，
 * 避免把转发服务变成任意 URL 代理。
 */
export function allowedUpstreamUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol === 'https:') return url
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? url : null
  } catch { return null }
}

const MAX_FORWARD_HEADERS = 40
const MAX_FORWARD_VALUE_CHARS = 8 * 1024
/** 不转发给上游的头：逐跳头、能伪造来源的头和我们自己的标记头。 */
const DROPPED_HEADERS = /^(?:connection|keep-alive|content-length|transfer-encoding|te|trailer|upgrade|expect|host|origin|referer|cookie|cookie2|accept-encoding|sec-[\w-]+|proxy-[\w-]+|x-layout-[\w-]+)$/i
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i

/** 解析浏览器打包的上游请求头（base64 JSON），过滤后作为发往上游的头。 */
function forwardedHeaders(raw: string): Record<string, string> | null {
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const entries: [string, string][] = []
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.length > 0 && HEADER_NAME.test(name) && !DROPPED_HEADERS.test(name)) {
      entries.push([name, value])
    }
  }
  if (entries.length === 0 || entries.length > MAX_FORWARD_HEADERS ||
    entries.some(([, value]) => value.length > MAX_FORWARD_VALUE_CHARS)) return null
  const headers = Object.fromEntries(entries)
  headers['Content-Type'] ??= 'application/json'
  headers['User-Agent'] ??= '3d-layout/0.1.0'
  headers['Accept'] ??= '*/*'
  return headers
}

/** 上游错误体里可能回显密钥：Bearer 与 x-api-key 两种形态都要抹掉（空值跳过，防 split('')）。 */
function secretVariants(headers: Record<string, string>): string[] {
  return [headers.Authorization, headers['x-api-key']].flatMap(value => {
    if (!value?.trim()) return []
    return value.startsWith('Bearer ') ? [value, value.slice(7)] : [value]
  }).filter(secret => secret.trim())
}

export interface UpstreamReply {
  status: number
  contentType?: string
  /** 上游压缩方式（本模块自己解压，不把 Content-Encoding 转给浏览器）。 */
  encoding?: string
  body: Readable
}

/**
 * 上游传输。默认用 node:https 而不是 fetch：内置 fetch（undici）对响应头有 300 秒的硬超时，
 * 会把这里的首字节等待上限压到 5 分钟；https 请求没有这个默认值，交给本模块的定时器控制。
 */
export type UpstreamTransport = (
  target: URL, headers: Record<string, string>, body: Buffer, signal: AbortSignal,
) => Promise<UpstreamReply>

export const httpsTransport: UpstreamTransport = (target, headers, body, signal) => new Promise((resolve, reject) => {
  const request = httpsRequest(target, {
    method: 'POST',
    headers: { ...headers, 'Content-Length': String(body.length) },
  }, reply => {
    // 响应流在交给 pipeline 之前也可能先报错；先装一个监听，避免变成未处理的 'error'。
    reply.on('error', () => { /* pipeline 会把同样的错误转成失败 */ })
    resolve({
      status: reply.statusCode ?? 502,
      contentType: reply.headers['content-type'],
      encoding: reply.headers['content-encoding'],
      body: reply,
    })
  })
  const abort = () => request.destroy(new Error('请求已取消'))
  if (signal.aborted) { reject(new Error('请求已取消')); return }
  signal.addEventListener('abort', abort, { once: true })
  request.once('close', () => signal.removeEventListener('abort', abort))
  request.once('error', reject)
  request.end(body)
})

function decompressor(encoding?: string): Transform | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return null
  }
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(1))}`

export interface RelayOptions {
  transport?: UpstreamTransport
  firstByteMs?: number
  idleMs?: number
}

/** Runs in dev and preview. No keys or request bodies are written to disk/logs. */
export function handleLlmRelay(req: IncomingMessage, res: ServerResponse, options: RelayOptions = {}): boolean {
  if ((req.url ?? '').split('?')[0] !== '/api/llm/request') return false
  const firstByteMs = options.firstByteMs ?? FIRST_BYTE_MS
  const idleMs = options.idleMs ?? IDLE_MS
  const transport = options.transport ?? httpsTransport
  res.setHeader('x-layout-llm-relay', '1')
  res.setHeader('Cache-Control', 'no-store')
  const fail = (status: number, message: string) => {
    if (res.destroyed) return
    if (res.headersSent) { res.destroy(); return }
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: { message } }))
  }
  let host: URL
  try { host = new URL(`http://${req.headers.host}`) } catch { fail(403, '非法请求来源'); return true }
  const remote = req.socket.remoteAddress
  if (!LOOPBACK_HOSTS.has(host.hostname) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') ||
      req.headers.origin !== host.origin || req.headers['sec-fetch-site'] === 'cross-site') {
    fail(403, '模型转发只接受本机同源请求'); return true
  }
  if (req.method !== 'POST') { fail(405, '仅支持 POST'); return true }
  const target = allowedUpstreamUrl(String(req.headers['x-layout-upstream'] ?? ''))
  const headers = forwardedHeaders(String(req.headers['x-layout-upstream-headers'] ?? ''))
  if (!target) { fail(400, '上游地址不被允许：仅支持 https 接口或本机 http 服务，请检查 Base URL'); return true }
  if (!headers) { fail(400, '上游请求头缺失或不合法，请刷新页面后重试'); return true }
  if (![headers.Authorization, headers['x-api-key']].some(value => value?.trim())) {
    fail(400, '缺少 API 密钥（Authorization 或 x-api-key），请在设置中填写'); return true
  }
  if (!String(req.headers['content-type']).startsWith('application/json')) {
    fail(400, '请求不是 JSON 类型'); return true
  }
  const controller = new AbortController()
  // 分阶段计时：等响应头用 firstByteMs，开始回包后每个分片重置 idleMs。
  let streaming = false
  let cancelledByClient = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), ms)
  }
  const disconnect = () => {
    if (res.writableFinished) return
    cancelledByClient = true
    controller.abort()
  }
  req.on('aborted', disconnect)
  res.on('close', disconnect)
  arm(firstByteMs)
  void (async () => {
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk)
        size += buffer.length
        if (size > MAX_BODY) { fail(413, '请求过大，请减少截图数量或尺寸'); return }
        chunks.push(buffer)
      }
      const body = Buffer.concat(chunks)
      try { JSON.parse(body.toString('utf8')) } catch { fail(400, '请求不是合法 JSON'); return }
      const upstream = await transport(target, {
        ...headers,
        // 让上游直接给明文：我们只转发 Content-Type，不转发 Content-Encoding。
        'Accept-Encoding': 'identity',
      }, body, controller.signal)
      // 已经拿到响应：后续（含读取错误体）按"两段数据之间的静默"计时。
      arm(idleMs)
      if (upstream.status >= 300 && upstream.status < 400) {
        upstream.body.destroy()
        fail(502, '上游模型服务返回重定向，请检查接口地址'); return
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        // Bound error bodies and strip an echoed credential before displaying it.
        let detail = ''
        for await (const chunk of upstream.body) {
          detail += Buffer.from(chunk as Buffer).toString('utf8')
          if (detail.length >= 4096) break
        }
        upstream.body.destroy()
        const redacted = secretVariants(headers).reduce((text, secret) => text.split(secret).join('***'), detail)
        fail(upstream.status, redacted.slice(0, 2000)); return
      }
      res.statusCode = upstream.status
      res.setHeader('Content-Type', upstream.contentType ?? 'application/json')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders()
      streaming = true
      arm(idleMs)
      const heartbeat = new Transform({
        transform(chunk, _encoding, callback) {
          arm(idleMs)
          callback(null, chunk)
        },
      })
      const decode = decompressor(upstream.encoding)
      if (decode) await pipeline(upstream.body, decode, heartbeat, res)
      else await pipeline(upstream.body, heartbeat, res)
    } catch {
      if (!controller.signal.aborted) {
        fail(502, '无法连接上游模型服务，请检查本机网络及代理配置'); return
      }
      if (cancelledByClient) fail(504, '请求已取消')
      else if (streaming) fail(504, `上游模型服务已停止输出超过 ${seconds(idleMs)} 秒，本次请求已中止`)
      else fail(504, `等待上游模型服务响应超过 ${seconds(firstByteMs)} 秒，模型可能排队或请求过大`)
    } finally {
      if (timer !== null) clearTimeout(timer)
      controller.abort()
      req.off('aborted', disconnect)
      res.off('close', disconnect)
    }
  })()
  return true
}
