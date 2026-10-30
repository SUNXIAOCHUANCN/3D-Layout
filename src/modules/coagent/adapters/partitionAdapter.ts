/**
 * 分区文件 IO（P4）。
 *
 * 读：走静态资源 `/scenes/<id>/coagent/partition.json`（vite 的 serveDataDirs 已支持任意深度子路径）。
 * 写：走 `POST /api/scene/<id>/coagent`（dev/preview 由 vite middleware 提供；纯静态托管时降级为下载，
 *     与既有 saveScene / saveLog 同款策略）。
 *
 * 路径写死，客户端不得自定义任意文件名；所有失败都返回结构化结果，不用异常兜底。
 */

import { PARTITION_FILE_NAME, parsePartitionFile, type PartitionFile } from '../services/partitionPersistence'

export type PartitionReadResult =
  | { status: 'ok'; file: PartitionFile }
  /** 本来就没有文件——这是正常状态，不是错误 */
  | { status: 'absent' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'error'; message: string }

export type PartitionSaveResult =
  /** 已写入磁盘 */
  | { ok: true; mode: 'server' }
  /** 服务端不可用，已降级为浏览器下载（不等于服务器落盘） */
  | { ok: true; mode: 'download' }
  | { ok: false; message: string }

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  statusText?: string
  text(): Promise<string>
}>

export function partitionUrl(sceneId: string): string {
  return `/scenes/${encodeURIComponent(sceneId)}/coagent/${PARTITION_FILE_NAME}`
}

export function partitionWriteUrl(sceneId: string): string {
  return `/api/scene/${encodeURIComponent(sceneId)}/coagent`
}

export async function readPartitionFile(
  sceneId: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<PartitionReadResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!fetchImpl) return { status: 'error', message: '当前环境没有 fetch' }
  try {
    const res = await fetchImpl(partitionUrl(sceneId), { ...(opts.signal ? { signal: opts.signal } : {}) })
    if (res.status === 404) return { status: 'absent' }
    if (!res.ok) return { status: 'error', message: `读取分区文件失败：HTTP ${res.status} ${res.statusText ?? ''}`.trim() }
    const text = await res.text()
    // 兜底：某些静态托管的 SPA fallback 会对缺失文件返回 200 + index.html。
    // 那不是"文件损坏"，而是"没有文件"——不能把它报成 invalid。
    if (text.trimStart().startsWith('<')) return { status: 'absent' }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { status: 'invalid', issues: ['区域文件不是合法 JSON（文件损坏，已保留原文件）'] }
    }
    const parsed = parsePartitionFile(raw)
    if (!parsed.ok) return { status: 'invalid', issues: parsed.issues }
    if (parsed.file.sceneId !== sceneId) {
      return { status: 'invalid', issues: [`分区文件属于场景 ${parsed.file.sceneId}，与当前场景 ${sceneId} 不一致`] }
    }
    return { status: 'ok', file: parsed.file }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { status: 'error', message: '读取已取消' }
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

export async function savePartitionFile(
  sceneId: string,
  file: PartitionFile,
  opts: { fetchImpl?: FetchLike; download?: (filename: string, content: string) => void } = {},
): Promise<PartitionSaveResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (fetchImpl) {
    try {
      const res = await fetchImpl(partitionWriteUrl(sceneId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(file),
      })
      if (res.ok) return { ok: true, mode: 'server' }
      if (res.status !== 404 && res.status !== 405) {
        return { ok: false, message: `保存分区失败：HTTP ${res.status} ${res.statusText ?? ''}`.trim() }
      }
    } catch {
      /* 落到下载降级 */
    }
  }
  const download = opts.download ?? defaultDownload
  if (!download) return { ok: false, message: '服务端不可写，且当前环境不支持下载导出' }
  try {
    download(`${sceneId}.coagent-partition.json`, JSON.stringify(file, null, 2))
    return { ok: true, mode: 'download' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

function defaultDownload(filename: string, content: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
