import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const IMAGE = 'python:3.12-alpine'
const MAX_BODY = 256 * 1024
const MAX_OUTPUT = 2 * 1024 * 1024
let running = false

// User code and inputs travel on stdin, never in the host shell or Docker arguments.
const WRAPPER = String.raw`import contextlib, io, json, sys, traceback
payload = json.load(sys.stdin)
out, err = io.StringIO(), io.StringIO()
scope = {'inputs': payload.get('inputs'), '__name__': '__main__'}
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        exec(compile(payload['code'], '<agent>', 'exec'), scope)
    response = {'ok': True, 'result': scope.get('result'), 'stdout': out.getvalue(), 'stderr': err.getvalue()}
except BaseException:
    response = {'ok': False, 'error': traceback.format_exc(), 'stdout': out.getvalue(), 'stderr': err.getvalue()}
try:
    print(json.dumps(response, ensure_ascii=False, allow_nan=False))
except (TypeError, ValueError):
    print(json.dumps({'ok': False, 'error': 'result must be JSON serializable and finite', 'stdout': out.getvalue(), 'stderr': err.getvalue()}))`

function respond(res: ServerResponse, status: number, data: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function capability(res: ServerResponse): void {
  const child = spawn('docker', ['image', 'inspect', IMAGE], { windowsHide: true, stdio: 'ignore' })
  let done = false
  const finish = (available: boolean) => {
    if (done) return
    done = true
    clearTimeout(timer)
    respond(res, 200, { available, image: IMAGE, reason: available ? null : 'Docker 或本地 Python 容器镜像不可用' })
  }
  const timer = setTimeout(() => { child.kill(); finish(false) }, 5000)
  child.on('error', () => finish(false))
  child.on('close', code => finish(code === 0))
}

export function handleLlmAgentPython(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0]
  if (!path.startsWith('/api/llm-agent-python/')) return false
  const address = req.socket.remoteAddress ?? ''
  const origin = req.headers.origin
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || (origin && (() => {
    try { return new URL(origin).host !== req.headers.host } catch { return true }
  })())) {
    respond(res, 403, { ok: false, error: 'Python 接口仅允许本机同源访问' })
    return true
  }
  if (req.method === 'GET' && path === '/api/llm-agent-python/capabilities') { capability(res); return true }
  if (req.method !== 'POST' || path !== '/api/llm-agent-python/execute') return false
  let size = 0
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk) })
  req.on('end', () => {
    let body: { code?: unknown; inputs?: unknown; timeoutSeconds?: unknown }
    try {
      if (size > MAX_BODY) throw new Error('请求超出大小限制')
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      if (typeof body.code !== 'string' || !body.code.trim() || body.code.length > 100_000) throw new Error('代码必须是 1–100000 字符')
      if (body.timeoutSeconds !== undefined && (typeof body.timeoutSeconds !== 'number' || !Number.isFinite(body.timeoutSeconds) || body.timeoutSeconds < 1 || body.timeoutSeconds > 60)) throw new Error('timeoutSeconds 必须在 1–60 秒之间')
    } catch (e) { respond(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); return }
    if (running) { respond(res, 409, { ok: false, error: '已有 Python 作业运行中' }); return }
    running = true
    const name = `llm-agent-${randomUUID()}`
    const args = ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1', '--user=65534:65534', '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m', '--workdir=/tmp', '-i', IMAGE, 'python', '-I', '-c', WRAPPER]
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false, outputSize = 0
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    const removeContainer = () => {
      const cleanup = spawn('docker', ['rm', '-f', name], { windowsHide: true, stdio: 'ignore' })
      cleanup.on('error', () => {})
      cleanup.unref()
    }
    const stop = (message: string, status: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeContainer()
      child.kill()
      respond(res, status, { ok: false, error: message })
    }
    const timer = setTimeout(() => stop('Python 执行超时', 408), Number(body.timeoutSeconds ?? 30) * 1000)
    res.on('close', () => { if (!res.writableEnded) stop('执行已取消', 499) })
    child.on('error', () => stop('Docker 不可用；未在宿主机执行 Python', 503))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ code: body.code, inputs: body.inputs ?? null }))
    const collect = (dst: Buffer[], chunk: Buffer) => {
      outputSize += chunk.length
      if (outputSize > MAX_OUTPUT) { stop('Python 输出超过 2 MiB 限制', 413); return }
      dst.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk))
    child.on('close', code => {
      running = false
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) { respond(res, 503, { ok: false, error: `容器无法运行（退出码 ${code}）：${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}` }); return }
      try {
        const result = JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, unknown>
        respond(res, result.ok === true ? 200 : 422, result)
      } catch { respond(res, 502, { ok: false, error: 'Python 返回格式不合法' }) }
    })
  })
  return true
}
