import { useSceneStore } from '../../core/store'
import { useAgentStore } from './agentStore'

type LogStatus = 'idle' | 'recording' | 'saved' | 'error'
let active: { id: string; seq: number; chain: Promise<void>; pending: Promise<unknown>[]; error: string | null } | null = null
let status: LogStatus = 'idle'
let secret = ''

function clean(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:image\//.test(value)) return `[image data URL, ${value.length} characters]`
    const redacted = secret ? value.split(secret).join('[REDACTED]') : value
    return redacted.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
  }
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k, /^(api.?key|authorization|x-api-key)$/i.test(k) ? '[REDACTED]' : clean(v),
    ]))
  }
  return value
}

async function post(body: unknown): Promise<void> {
  const res = await fetch('/api/llm-agent-log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`日志服务返回 HTTP ${res.status}`)
}

export const runLog = {
  get status(): LogStatus { return status },
  async start(request: string, meta: unknown, apiKey: string): Promise<void> {
    secret = apiKey
    const id = crypto.randomUUID()
    // 建立日志失败时不开始实验，避免产生无法追踪的运行。
    await post({ action: 'start', id, request: clean(request), meta: clean(meta), scene: clean(useSceneStore.getState().document) })
    active = { id, seq: 0, chain: Promise.resolve(), pending: [], error: null }
    status = 'recording'
    useAgentStore.getState().pushLog('info', `运行记录：src/modules/llm-agent/logs/${id}`)
  },
  event(type: string, payload: unknown): void {
    const run = active
    if (!run) return
    const event = { seq: ++run.seq, time: new Date().toISOString(), type, payload: clean(payload) }
    run.chain = run.chain.then(() => post({ action: 'event', id: run.id, event })).catch(e => {
      if (!run.error) {
        run.error = e instanceof Error ? e.message : String(e)
        status = 'error'
        useAgentStore.getState().pushLog('error', `运行日志写入失败：${run.error}`)
        useAgentStore.getState().pushChat('note', `运行日志写入失败：${run.error}`)
      }
    })
  },
  screenshot(callId: string, dataUrl: string): void {
    const run = active
    if (!run) return
    run.chain = run.chain.then(() => post({ action: 'screenshot', id: run.id, callId, dataUrl })).catch(e => {
      if (!run.error) {
        run.error = e instanceof Error ? e.message : String(e)
        status = 'error'
        useAgentStore.getState().pushLog('error', `截图日志写入失败：${run.error}`)
        useAgentStore.getState().pushChat('note', `截图日志写入失败：${run.error}`)
      }
    })
  },
  track(promise: Promise<unknown>): void { active?.pending.push(promise) },
  async finish(outcome: string): Promise<void> {
    const run = active
    if (!run) return
    await Promise.allSettled(run.pending)
    await run.chain
    try {
      await post({ action: 'finish', id: run.id, outcome, logIncomplete: !!run.error, scene: clean(useSceneStore.getState().document) })
      if (!run.error) status = 'saved'
      useAgentStore.getState().pushChat('note', run.error ? '运行结束，但日志不完整' : `运行记录已保存：${run.id}`)
    } catch (e) {
      status = 'error'
      useAgentStore.getState().pushChat('note', `运行日志结束写入失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (active === run) { active = null; secret = '' }
    }
  },
}
