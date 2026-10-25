/**
 * runLog —— 一轮运行的落盘日志（诊断用，不参与业务决策）。
 *
 * 为什么需要它：CoAgent 的失败现在只留一句 `rolled_back`（错误码 + stage），
 * 看不到"模型收到了什么、回了什么、工具为什么失败、判定为什么不过"。
 * 本模块把 **每一次模型请求/回包、每一次工具调用、每一个图节点、每一次校验**
 * 按时间序记成一份 markdown，写到 `logs/coAgent/` 下——一轮运行 = 一个文件。
 *
 * 落盘通路（与旧 Agent 的 log.write 同款思路）：
 *   POST /api/coagent-log {filename, content} → <repo>/logs/coAgent/<filename>
 * 端点由 vite.config.ts 提供（dev/preview 都有）。端点不可用（生产静态托管）时
 * 降级为：控制台一次性告警 + 把内容挂到 window.__coagentLastLog 供手工复制。
 *
 * 三条约束（照抄 recorder 的口径）：
 * 1. 日志只被写入、不被业务读取（禁止日志反向驱动流程）；
 * 2. 不记录任何凭据：模型配置只存脱敏摘要，消息里的 dataURL 只记字节数；
 * 3. 写日志失败绝不影响运行：所有网络/序列化异常都在本文件内吞掉。
 *
 * 单例语义：runtime 保证同时最多一个活跃 run（runController 的互斥），
 * 分区预处理也在 isActivePhase 检查之后才开始，因此模块级 active 句柄是安全的；
 * 没有活跃句柄时所有 log* 调用都是 no-op（单测/宿主其它路径无副作用）。
 */

import type {
  CoAgentConfig,
  ModelMessage,
  ModelReply,
  ModelRequest,
  ModelToolCall,
  PartitionSnapshot,
  ToolResult,
} from '../contracts'

export type RunLogKind = 'run' | 'preprocess'
export type RunLogLevel = 'info' | 'warn' | 'error'

export interface RunLogMeta {
  kind: RunLogKind
  runId: string
  /** 用户输入原文（写入日志头部；不含凭据） */
  request: string
  /** 脱敏后的模型配置摘要（provider/protocol/model@host，绝不含 key） */
  model?: string
  partition?: PartitionSnapshot | null
  config?: CoAgentConfig
  note?: string
}

/** 单条正文上限 / 整个文件上限：避免一次运行写出几百 MB */
const MAX_FIELD = 6_000
const MAX_BODY = 20_000
const MAX_TOTAL_CHARS = 4_000_000
/** 增量写盘防抖（同一轮里几十个节点不会打出几十个请求） */
const FLUSH_DEBOUNCE_MS = 600

const LEVEL_TAG: Record<RunLogLevel, string> = { info: '·', warn: '!', error: '✗' }

export interface RunLogHandle {
  readonly meta: RunLogMeta
  readonly filename: string
  entry(level: RunLogLevel, stage: string, title: string, body?: string, data?: unknown): void
  modelRequest(request: ModelRequest): void
  modelReply(request: ModelRequest, reply: ModelReply, elapsedMs: number, queueMs?: number): void
  modelError(request: ModelRequest, error: unknown, elapsedMs: number, queueMs?: number): void
  toolCall(call: ModelToolCall, result: ToolResult<unknown>, elapsedMs: number): void
  /** 结束并强制写盘（调用方 await） */
  finish(outcome: string, detail?: RunLogFinishDetail): Promise<void>
  markdown(): string
}

export interface RunLogFinishDetail {
  /** 附加章节（如 recorder 事件表），按顺序渲染在时间线之后 */
  sections?: Array<{ title: string; body: string }>
  /** 结构化结果明细（JSON 代码块） */
  data?: unknown
}

interface LogEntry {
  seq: number
  at: number
  elapsedMs: number
  level: RunLogLevel
  stage: string
  title: string
  body?: string
  data?: unknown
}

// ---------- 文本工具 ----------

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字符）`
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function describeImages(images: readonly { dataUrl: string }[] | undefined): string {
  if (!images || images.length === 0) return ''
  return images.map((im, i) => `#${i + 1}≈${Math.round(im.dataUrl.length / 1024)}KB`).join('，')
}

function renderMessage(m: ModelMessage): string {
  if (m.role === 'system') return `[system]\n${clip(m.text, MAX_FIELD)}`
  if (m.role === 'user') {
    const imgs = m.images && m.images.length > 0 ? `\n[附图 ${m.images.length} 张：${describeImages(m.images)}]` : ''
    return `[user]${imgs}\n${clip(m.text, MAX_FIELD)}`
  }
  if (m.role === 'assistant') {
    const calls =
      m.toolCalls.length > 0
        ? `\n[工具调用]\n${m.toolCalls.map(c => `- ${c.name} ${clip(textOf(c.args), 800)}`).join('\n')}`
        : ''
    return `[assistant]\n${clip(m.text, MAX_FIELD)}${calls}`
  }
  const imgs = m.images && m.images.length > 0 ? `\n[附图 ${m.images.length} 张：${describeImages(m.images)}]` : ''
  return `[toolResult ${m.callId} ok=${String(m.ok)}]${imgs}\n${clip(textOf(m.content), MAX_FIELD)}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function wallClock(t: number): string {
  const d = new Date(t)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  )
}

function fileStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`
}

/** 文件名：只含 [A-Za-z0-9._-]，落盘端点按同一规则校验 */
export function runLogFilename(meta: RunLogMeta): string {
  if (meta.kind === 'preprocess') return `coagent-preprocess-${fileStamp()}.md`
  const safeRunId = meta.runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'run'
  return `coagent-${fileStamp()}-${safeRunId}.md`
}

function partitionSummary(p: PartitionSnapshot | null | undefined): string {
  if (!p) return '（无：本轮没有可用分区）'
  const regions = p.regions
    .map(r => `- ${r.id}（${r.name}）：${r.objectIds.length} 个对象，多边形 ${r.polygonXZ.length} 点`)
    .join('\n')
  return [`- partitionVersion：${p.partitionVersion}`, regions, `- 跨区只读对象：${p.globalReadonlyObjectIds.length} 个`].join('\n')
}

// ---------- 落盘 ----------

let lastPostError: string | null = null

async function postLog(filename: string, content: string): Promise<void> {
  // node/单测环境没有落盘端点（也没有 window）：静默跳过，不污染测试输出
  if (typeof window === 'undefined') return
  try {
    const res = await fetch('/api/coagent-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    lastPostError = null
    if (typeof window !== 'undefined') {
      // 便于在控制台直接 `__coagentLastLog.filename` 找到刚写的那份
      ;(window as unknown as { __coagentLastLog?: { filename: string; content: string } }).__coagentLastLog = {
        filename,
        content,
      }
    }
  } catch (e) {
    // 端点不可用（静态托管/单测）：只提示一次，并把内容留在 window 上供手工复制
    const message = e instanceof Error ? e.message : String(e)
    if (lastPostError !== message) {
      lastPostError = message
      // eslint-disable-next-line no-console
      console.warn(`[coagent-log] 无法写入 logs/coAgent/${filename}：${message}`)
    }
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __coagentLastLog?: { filename: string; content: string } }).__coagentLastLog = {
        filename,
        content,
      }
    }
  }
}

// ---------- 句柄实现 ----------

function createRunLog(meta: RunLogMeta): RunLogHandle {
  const startedAt = Date.now()
  const filename = runLogFilename(meta)
  const entries: LogEntry[] = []
  let seq = 0
  let chars = 0
  let truncated = false
  let outcome: string | null = null
  let sections: Array<{ title: string; body: string }> = []
  let outcomeDetail: unknown
  let finishedAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 写盘串行链：避免并发 POST 让旧快照覆盖新快照；finish 时 await 它拿到最终落盘 */
  let chain: Promise<void> = Promise.resolve()

  const enqueueWrite = (): Promise<void> => {
    chain = chain.then(() => postLog(filename, markdown()))
    return chain
  }

  const markdown = (): string => {
    const end = finishedAt ?? Date.now()
    const lines: string[] = []
    lines.push(`# CoAgent 运行日志（${meta.kind === 'preprocess' ? '分区预处理' : '布局运行'}）`, '')
    lines.push(`- 文件：logs/coAgent/${filename}`)
    lines.push(`- runId：${meta.runId}`)
    lines.push(`- 开始：${wallClock(startedAt)}`)
    lines.push(`- ${finishedAt ? '结束' : '已运行'}：${wallClock(end)}（${seconds(end - startedAt)}）`)
    lines.push(`- 用户请求：${meta.request.trim() || '（空）'}`)
    if (meta.model) lines.push(`- 模型：${meta.model}`)
    if (meta.note) lines.push(`- 备注：${meta.note}`)
    lines.push(`- 结果：${outcome ?? '（尚未结束）'}`)
    if (truncated) lines.push(`- ⚠ 日志已按上限截断（${MAX_TOTAL_CHARS} 字符）`)
    lines.push('')
    lines.push('## 分区快照', '', partitionSummary(meta.partition), '')
    if (meta.config) {
      lines.push('## 运行配置', '', '```json', JSON.stringify(meta.config, null, 2), '```', '')
    }
    lines.push('## 时间线', '')
    for (const e of entries) {
      lines.push(
        `### ${e.seq}. [${LEVEL_TAG[e.level]} +${seconds(e.elapsedMs)}] ${e.stage} — ${e.title}`,
        '',
        `> 墙钟 ${wallClock(e.at)}`,
        '',
      )
      if (e.body && e.body.trim().length > 0) {
        lines.push('```text', e.body, '```', '')
      }
      if (e.data !== undefined) {
        const json = textOf(e.data)
        lines.push('```json', clip(json, MAX_BODY), '```', '')
      }
    }
    if (outcomeDetail !== undefined) {
      lines.push('## 结果明细', '', '```json', clip(textOf(outcomeDetail), MAX_BODY), '```', '')
    }
    for (const section of sections) {
      lines.push(`## ${section.title}`, '', section.body, '')
    }
    return lines.join('\n')
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void enqueueWrite()
    }, FLUSH_DEBOUNCE_MS)
    // 浏览器里 setTimeout 返回 number；node 里返回 Timeout，unref 只为不拖住进程
    const t = timer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  const handle: RunLogHandle = {
    meta,
    filename,

    entry(level, stage, title, body, data) {
      if (chars >= MAX_TOTAL_CHARS) {
        truncated = true
        return
      }
      const item: LogEntry = {
        seq: ++seq,
        at: Date.now(),
        elapsedMs: Date.now() - startedAt,
        level,
        stage,
        title,
        ...(body !== undefined && body.length > 0 ? { body: clip(body, MAX_BODY) } : {}),
        ...(data !== undefined ? { data } : {}),
      }
      entries.push(item)
      chars += (item.body?.length ?? 0) + (item.data !== undefined ? Math.min(MAX_BODY, textOf(item.data).length) : 0)
      schedule()
    },

    modelRequest(request: ModelRequest) {
      const tools = request.tools.map(t => t.name)
      const images = request.messages.reduce(
        (n, m) => n + (m.role === 'user' || m.role === 'toolResult' ? (m.images?.length ?? 0) : 0),
        0,
      )
      handle.entry(
        'info',
        'llm.request',
        `${request.purpose} → 模型（消息 ${request.messages.length} 条，工具 ${tools.length} 个，附图 ${images} 张）`,
        [
          `purpose：${request.purpose}`,
          `timeoutMs：${request.timeoutMs}`,
          `工具清单：${tools.length > 0 ? tools.join(', ') : '（无）'}`,
          '',
          '--- system ---',
          clip(request.system, MAX_FIELD),
          '',
          '--- messages ---',
          request.messages.map((m, i) => `#${i} ${renderMessage(m)}`).join('\n\n'),
        ].join('\n'),
      )
    },

    modelReply(request: ModelRequest, reply: ModelReply, elapsedMs: number, queueMs?: number) {
      handle.entry(
        'info',
        'llm.reply',
        `${request.purpose} ← 模型（${seconds(elapsedMs)}${queueMs !== undefined ? `，排队 ${seconds(queueMs)}` : ''}，stop=${reply.stopReason}）`,
        [
          `stopReason：${reply.stopReason}`,
          `toolCalls：${reply.toolCalls.length} 个${reply.toolCalls.length > 0 ? ` → ${reply.toolCalls.map(c => c.name).join(', ')}` : ''}`,
          '',
          '--- 回包文本 ---',
          clip(reply.text, 12_000),
          ...(reply.toolCalls.length > 0
            ? [
                '',
                '--- 工具调用参数 ---',
                reply.toolCalls.map(c => `- ${c.name}（${c.id}） ${clip(textOf(c.args), 1_500)}`).join('\n'),
              ]
            : []),
        ].join('\n'),
        reply.usage !== undefined ? { usage: reply.usage } : undefined,
      )
    },

    modelError(request: ModelRequest, error: unknown, elapsedMs: number, queueMs?: number) {
      const err = error as { name?: string; message?: string; code?: string; details?: unknown }
      handle.entry(
        'error',
        'llm.error',
        `${request.purpose} ✗ 模型调用失败（${seconds(elapsedMs)}${queueMs !== undefined ? `，排队 ${seconds(queueMs)}` : ''}）`,
        [
          `错误：${err?.name ?? 'Error'}: ${err?.message ?? String(error)}`,
          ...(err?.code ? [`错误码：${err.code}`] : []),
          '',
          '--- system（截断）---',
          clip(request.system, 1_500),
          '',
          '--- 最后一条消息 ---',
          request.messages.length > 0 ? renderMessage(request.messages[request.messages.length - 1]) : '（空）',
        ].join('\n'),
        err?.details !== undefined ? err.details : undefined,
      )
    },

    toolCall(call: ModelToolCall, result: ToolResult<unknown>, elapsedMs: number) {
      const ok = result.ok
      handle.entry(
        ok ? 'info' : 'warn',
        'tool.call',
        `${call.name} ${ok ? '✓' : '✗'}（${seconds(elapsedMs)}）`,
        [
          `参数：${clip(textOf(call.args), 3_000)}`,
          '',
          ok ? `结果：${clip(textOf(result.data), 4_000)}` : `错误：${result.error.code} ${result.error.message}`,
          ...(!ok && result.error.details !== undefined ? ['', `错误细节：${clip(textOf(result.error.details), 2_000)}`] : []),
        ].join('\n'),
      )
    },

    async finish(result: string, detail?: RunLogFinishDetail) {
      finishedAt = Date.now()
      outcome = result
      if (detail && typeof detail === 'object') {
        if (Array.isArray(detail.sections)) {
          sections = detail.sections
            .filter(s => s && typeof s.title === 'string' && typeof s.body === 'string')
            .map(s => ({ title: s.title, body: clip(s.body, MAX_BODY) }))
        }
        if (detail.data !== undefined) outcomeDetail = detail.data
      } else if (detail !== undefined) {
        outcomeDetail = detail
      }
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      // 串行链保证"最后一次写盘"用的是收尾后的内容
      await enqueueWrite()
    },

    markdown,
  }

  return handle
}

// ---------- 模块级活跃句柄 ----------

let active: RunLogHandle | null = null

export function beginRunLog(meta: RunLogMeta): RunLogHandle {
  // 上一轮未收尾就开新一轮（异常路径）：先落一份再接管，避免丢日志
  if (active) void active.finish(active.meta.kind === 'run' ? '未正常结束（被下一次运行接管）' : '未正常结束')
  const handle = createRunLog(meta)
  active = handle
  return handle
}

export function activeRunLog(): RunLogHandle | null {
  return active
}

/** 结束当前句柄并写盘（幂等；没有活跃句柄时是 no-op） */
export async function finishRunLog(result: string, detail?: RunLogFinishDetail): Promise<void> {
  const handle = active
  if (!handle) return
  active = null
  await handle.finish(result, detail)
}

/** 放弃当前句柄（相位被禁用等）：仍会写一份收尾日志 */
export function abandonRunLog(reason: string): void {
  const handle = active
  if (!handle) return
  active = null
  void handle.finish(reason)
}

/** 便捷：写一条时间线（无活跃句柄时 no-op） */
export function logStage(stage: string, title: string, body?: string, data?: unknown): void {
  active?.entry('info', stage, title, body, data)
}

export function logWarn(stage: string, title: string, body?: string, data?: unknown): void {
  active?.entry('warn', stage, title, body, data)
}

export function logError(stage: string, title: string, body?: string, data?: unknown): void {
  active?.entry('error', stage, title, body, data)
}

/** recorder 事件表：运行结束时附在日志末尾（与时间线互补，便于按 eventSeq 对账） */
export function eventsTable(
  events: ReadonlyArray<{ eventSeq: number; time: string; type: string; runId: string; payload: Record<string, unknown> }>,
): string {
  if (events.length === 0) return '（本轮没有 recorder 事件）'
  const rows = events.map(
    e => `| ${e.eventSeq} | ${e.time} | ${e.type} | ${clip(textOf(e.payload), 400).replace(/\|/g, '\\|')} |`,
  )
  return ['| seq | time | type | payload |', '| --- | --- | --- | --- |', ...rows].join('\n')
}
