import { bus } from './events'
import { useSceneStore } from './store'
import type { SceneDocument } from './types'

/**
 * 场景持久化。保存是 IO 动作而非场景变换：不进 edit、不进历史；
 * 版本号只在落盘的文件里自增（内存文档不动，重复保存幂等）。
 */
export async function saveScene(): Promise<{ mode: 'server' | 'download'; version: number }> {
  const s = useSceneStore.getState()
  const sceneId = s.sceneId
  const doc = s.document
  if (!sceneId || !doc) throw new Error('没有可保存的场景')

  const next: SceneDocument = {
    ...doc,
    meta: { ...doc.meta, version: doc.meta.version + 1 },
  }

  let mode: 'server' | 'download' = 'server'
  try {
    const res = await fetch(`/api/scene/${sceneId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    // 无保存服务（生产静态托管等）：降级为下载 scene.json
    mode = 'download'
    const blob = new Blob([JSON.stringify(next, null, 2)], { type: 'application/json' })
    const a = window.document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${sceneId}.scene.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  bus.emit('scene:saved', { sceneId, version: next.meta.version, mode })
  return { mode, version: next.meta.version }
}

// ---------- 场景的新建与删除（IO 动作，不进 edit、不进历史） ----------

/**
 * 新建一个空场景：服务端建目录、写 scene.json、登记 scenes/index.json。
 *
 * 与 saveScene 同属 IO 动作而非场景变更：不进编辑历史、不触发 scene:changed。
 * 成功后调用方自行 dispatch('load_scene') 切过去。
 */
export async function createScene(name: string): Promise<{ id: string }> {
  const res = await fetch('/api/scene', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
  }
  const data = (await res.json()) as { id?: string }
  if (!data.id) throw new Error('服务端未返回新场景 id')
  bus.emit('scene:index-changed', {})
  return { id: data.id }
}

/** 删除一个场景（连同其 threejs/ 与 coagent/ 附属文件）：服务端删目录、摘除索引 */
export async function deleteScene(sceneId: string): Promise<void> {
  const res = await fetch(`/api/scene/${encodeURIComponent(sceneId)}`, { method: 'DELETE' })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`)
  }
  bus.emit('scene:index-changed', {})
}

// ---------- 调用记录（logs/ 目录，Agent 的 log.write 专用 IO） ----------

/** 日志文件名规约：log + 14 位紧凑时间戳 + '-' + 名称 + .md（对齐 logs/ 现有示例） */
export const LOG_FILE_RE = /^log\d{14}-.+\.md$/

/** 日志名称消毒：去文件系统非法字符与控制符，收窄空白，限长 40 */
export function sanitizeLogName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\r\n\t\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/** 本地紧凑时间戳 YYYYMMDDHHMMSS（与示例 log20261013225252 一致） */
export function logTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

export function buildLogFilename(name: string): string {
  return `log${logTimestamp()}-${name}.md`
}

/**
 * 写调用记录文件到 logs/（服务器模式）；无保存服务（静态托管）时降级为下载 md。
 * filename 必须符合命名规约——这是唯一能从浏览器落到 logs/ 的路径。
 */
export async function saveLog(filename: string, content: string): Promise<{ mode: 'server' | 'download'; file: string }> {
  if (!LOG_FILE_RE.test(filename)) {
    throw new Error(`日志文件名不合规：${filename}（须形如 log20261013225252-名称.md）`)
  }
  let mode: 'server' | 'download' = 'server'
  try {
    const res = await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    mode = 'download'
    const blob = new Blob([content], { type: 'text/markdown; charset=utf-8' })
    const a = window.document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return { mode, file: `logs/${filename}` }
}

/** 列出 logs/ 根目录已有的调用记录（不含 Artificial 等子目录）；服务不可用时优雅降级 */
export async function listLogs(): Promise<{ available: boolean; files: string[] }> {
  try {
    const res = await fetch('/api/log/list')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { files?: unknown }
    return { available: true, files: Array.isArray(j.files) ? j.files.filter(f => typeof f === 'string') : [] }
  } catch {
    return { available: false, files: [] }
  }
}
