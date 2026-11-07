import { emptySession, type SceneSession } from './types'
import { flushWorkspace } from '../../core/persistence'
import { useSceneStore } from '../../core/store'
import type { SceneDocument } from '../../core/types'
import { boundHistoricalResults } from './history'

const key = (id: string) => `partition-agent:${id}`
const PREFIX = 'partition-agent:'
/** 浏览器缓存的字符预算。磁盘 session.json 才是权威副本，镜像只需支撑快速恢复。 */
const CACHE_BUDGET = 800_000
/** 预览图超过此长度就不写入浏览器缓存；重启后仍由磁盘恢复。 */
const PREVIEW_LIMIT = 250_000
const IMAGE_NOTE = '此截图未写入浏览器缓存，需要时请重新截图。'

export interface CacheResult {
  ok: boolean
  reason?: string
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function isQuota(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota|exceeded/i.test(message(error))
}

interface MirrorOptions {
  turns: boolean
  preview: boolean
  boundary: boolean
}

/**
 * 浏览器镜像：剔除截图与过大的预览图。
 * 会话在内存与磁盘里保留完整内容，只有这份副本会被压缩到 localStorage 能承载的大小。
 */
function mirror(session: SceneSession, options: MirrorOptions): SceneSession {
  let turns: SceneSession['turns'] = []
  if (options.turns) {
    turns = session.turns.map(turn => {
      if (turn.role === 'user') return turn.images?.length
        ? { ...turn, images: undefined, text: `${turn.text}（${IMAGE_NOTE}）` }
        : { ...turn }
      if (turn.role !== 'toolResults') return { ...turn }
      return {
        ...turn,
        results: turn.results.map(result => result.images?.length
          ? {
            ...result,
            images: undefined,
            content: result.content && typeof result.content === 'object'
              ? { ...(result.content as Record<string, unknown>), note: IMAGE_NOTE }
              : { note: IMAGE_NOTE },
          }
          : { ...result }),
      }
    })
    // 大型工具结果（整场景快照等）同样只留摘要，与运行时历史的收缩口径一致。
    boundHistoricalResults(turns)
  }
  const partition = session.partition
    ? {
      ...session.partition,
      preview: options.preview && (session.partition.preview?.length ?? 0) <= PREVIEW_LIMIT ? session.partition.preview : undefined,
      rawPreview: undefined,
      ...(options.boundary ? {} : { boundaryMap: undefined, rawBoundaryMap: undefined }),
    }
    : null
  return { ...session, partition, turns }
}

/** 从最旧的一轮开始丢弃工具对话，直到镜像落回预算内（丢到空也不勉强）。 */
function fit(session: SceneSession): SceneSession {
  if (session.turns.length === 0) return session
  const sizes = session.turns.map(turn => JSON.stringify(turn).length)
  const base = JSON.stringify({ ...session, turns: [] }).length
  const allowance = Math.max(0, CACHE_BUDGET - base)
  let total = sizes.reduce((sum, size) => sum + size, 0)
  let head = 0
  while (head < session.turns.length && total > allowance) {
    total -= sizes[head]
    const removed = session.turns[head++]
    // 工具调用与其结果成对丢弃，避免恢复出无主的 toolResults。
    if (removed.role === 'assistant' && removed.toolCalls.length && session.turns[head]?.role === 'toolResults') total -= sizes[head++]
  }
  return head === 0 ? session : { ...session, turns: session.turns.slice(head) }
}

/** 配额已满时先腾地方：清掉本场景旧镜像与其他场景的遗留镜像（磁盘各自留有副本）。 */
function release(sceneId: string): void {
  try {
    const own = key(sceneId)
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name?.startsWith(PREFIX) && name !== own) stale.push(name)
    }
    localStorage.removeItem(own)
    for (const name of stale) localStorage.removeItem(name)
  } catch {
    /* 清理失败不阻断随后的写入尝试 */
  }
}

export function parseSession(raw: unknown, id: string): SceneSession | null {
  const s = raw as SceneSession | null
  if (!s || s.schemaVersion !== 1 || s.sceneId !== id || typeof s.sessionId !== 'string' || typeof s.workflowId !== 'string' || !Array.isArray(s.turns) || !Array.isArray(s.chat) || !Number.isFinite(s.updatedAt)) return null
  if (s.chat.some(m => !m || !['user', 'assistant', 'note'].includes(m.role) || typeof m.text !== 'string')) return null
  if (s.partition && (!Array.isArray(s.partition.regions) || !s.partition.owners || Array.isArray(s.partition.owners) || s.partition.regions.some(r => !r || typeof r.id !== 'string' || !Array.isArray(r.polygon)))) return null
  return s
}

/**
 * 写入浏览器镜像。超配额时按档降级（先丢预览图，再丢工具对话），
 * 每档重试前清掉旧镜像腾出空间；全部失败也只返回原因，不抛出。
 */
export function cacheSession(session: SceneSession): CacheResult {
  if (typeof localStorage === 'undefined') return { ok: false, reason: '浏览器不支持本地存储' }
  const probes: MirrorOptions[] = [
    { turns: true, preview: true, boundary: true },
    { turns: true, preview: false, boundary: true },
    { turns: false, preview: false, boundary: true },
    { turns: false, preview: false, boundary: false },
  ]
  let reason = '浏览器存储配额不足'
  for (const probe of probes) {
    const raw = JSON.stringify(fit(mirror(session, probe)))
    // 每一档先直接写；超配额就先腾地方（旧镜像 / 其它场景遗留镜像）再试同一档，最后才降级。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        localStorage.setItem(key(session.sceneId), raw)
        return { ok: true }
      } catch (error) {
        if (!isQuota(error)) return { ok: false, reason: message(error) }
        reason = message(error)
        if (attempt === 0) release(session.sceneId)
      }
    }
  }
  return { ok: false, reason }
}

export async function loadSession(id: string): Promise<SceneSession> {
  let cached: SceneSession | null = null
  try { cached = parseSession(JSON.parse(localStorage.getItem(key(id)) ?? 'null'), id) } catch { /* disk remains authoritative fallback */ }
  const res = await fetch(`/api/partition-agent/scenes/${encodeURIComponent(id)}`)
  let disk: SceneSession | null = null
  if (res.ok && res.headers.get('content-type')?.includes('application/json')) disk = parseSession(await res.json(), id)
  else if (res.status !== 404) throw new Error(`读取场景 Agent 会话失败：HTTP ${res.status}`)
  const selected = cached && (!disk || cached.updatedAt > disk.updatedAt) ? cached : disk ?? emptySession(id)
  selected.workflowId = 'builtin-llm-partition-v1'
  // Retain old region data while removing obsolete remote preview references.
  if (selected.partition?.preview?.startsWith('/api/partition-agent/map2area/')) selected.partition.preview = undefined
  // Rewrite the mirror once on load so legacy bloat (multi-MB screenshots) is released even if no new task runs.
  cacheSession(selected)
  return selected
}
export async function saveSession(session: SceneSession): Promise<void> {
  const res = await fetch(`/api/partition-agent/scenes/${encodeURIComponent(session.sceneId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(session) })
  if (!res.ok) throw new Error(`会话写入磁盘失败：HTTP ${res.status}。浏览器缓存仍保留。`)
}
export async function saveSceneSnapshot(sceneId: string, document: SceneDocument): Promise<void> {
  // 场景已由 SQLite 工作区接管（scene.json 只是投影），直接写 /api/scene 会被数据库版本覆盖。
  // 分区编辑本身走 core/edit，落库由工作区提交队列完成，这里只需把当前场景的队列刷完。
  void document
  if (sceneId !== useSceneStore.getState().sceneId) return
  await flushWorkspace()
}
