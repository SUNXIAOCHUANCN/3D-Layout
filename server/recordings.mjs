import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError } from './workspaces.mjs'

const LEASE_MS = 20_000
const EDITS = 'edit-events.jsonl'
const VIEWPORT = 'viewport-samples.jsonl'
const VISIBILITY = 'object-visibility.jsonl'
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const readRows = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

function replaceFile(path, contents) {
  const temp = path + '.tmp'
  writeFileSync(temp, contents)
  renameSync(temp, path)
}

export function createRecordings(root) {
  const active = new Map()
  const base = join(root, '.data', 'recordings')
  const metaPath = directory => join(directory, 'session.json')
  const writeMeta = (directory, session) => replaceFile(metaPath(directory), JSON.stringify(session, null, 2) + '\n')

  function status(directory) {
    const session = readJson(metaPath(directory))
    if (session.captureStatus === 'recording' && (active.get(directory)?.until ?? 0) < Date.now()) {
      // Retain recorded batches when a tab disappears or the host restarts.
      session.captureStatus = 'interrupted'
      session.durationMs = Math.max(0, ...[EDITS, VIEWPORT].map(file => readRows(join(directory, file)).at(-1)?.tMs ?? 0))
    }
    return session
  }

  function append(directory, lease, name, rows) {
    const path = join(directory, name)
    if (!rows.length) return
    const previous = lease[name] ?? readRows(path).at(-1)?.seq ?? 0
    const next = rows.filter(row => row.seq > previous)
    appendFileSync(path, jsonl(next))
    lease[name] = next.at(-1)?.seq ?? previous
  }

  return {
    list(sceneId) {
      const dir = join(base, sceneId)
      return (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
        .filter(entry => entry.isDirectory() && existsSync(metaPath(join(dir, entry.name))))
        .map(entry => status(join(dir, entry.name)))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    },
    get(sceneId, id) {
      const directory = join(base, sceneId, id)
      if (!existsSync(metaPath(directory))) throw new ApiError(404, '找不到录制会话')
      const resultPath = join(directory, VISIBILITY)
      return {
        session: status(directory),
        initial: readJson(join(directory, 'initial-scene.json')),
        edits: readRows(join(directory, EDITS)),
        samples: readRows(join(directory, VIEWPORT)),
        visibility: existsSync(resultPath) ? readRows(resultPath) : [],
      }
    },
    write(sceneId, id, operation, input) {
      const directory = join(base, sceneId, id)
      if (operation === 'start') {
        if (existsSync(metaPath(directory))) return { ok: true }
        const session = input?.session
        if (session?.sceneId !== sceneId || session?.sessionId !== id || session.schemaVersion !== 1
            || typeof session.startedAt !== 'string' || input.initial?.document?.meta?.id !== sceneId) {
          throw new ApiError(400, '录制会话或初始场景无效')
        }
        mkdirSync(directory, { recursive: true })
        replaceFile(join(directory, 'initial-scene.json'), JSON.stringify(input.initial) + '\n')
        replaceFile(join(directory, EDITS), '')
        replaceFile(join(directory, VIEWPORT), '')
        writeMeta(directory, { ...session, captureStatus: 'recording', analysisStatus: 'pending' })
        active.set(directory, { until: Date.now() + LEASE_MS, [EDITS]: 0, [VIEWPORT]: 0 })
        return { ok: true }
      }
      if (!existsSync(metaPath(directory))) throw new ApiError(404, '找不到录制会话')
      const session = readJson(metaPath(directory))
      if (operation === 'visibility') {
        if (session.captureStatus === 'recording' && status(directory).captureStatus === 'recording') {
          throw new ApiError(409, '请先结束录制')
        }
        if (input?.uploadId !== undefined) {
          const { uploadId, offset, lines, status: uploadStatus } = input
          if (typeof uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(uploadId)) throw new ApiError(400, '可见性上传 ID 无效')
          const target = join(directory, VISIBILITY)
          const staged = join(directory, `visibility-${uploadId}.tmp`)
          if (session.visibilityUploadId === uploadId) return { ok: true }
          if (uploadStatus === 'failed') {
            rmSync(staged, { force: true })
            if (session.analysisStatus !== 'ready') writeMeta(directory, { ...status(directory), analysisStatus: 'failed' })
            return { ok: true }
          }
          if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, '可见性上传偏移无效')
          const size = existsSync(staged) ? statSync(staged).size : 0
          if (uploadStatus === 'ready') {
            if (size !== offset) throw new ApiError(409, '可见性结果尚未上传完整')
            if (size === 0) writeFileSync(staged, '')
            renameSync(staged, target)
            writeMeta(directory, { ...status(directory), analysisStatus: 'ready', visibilityUploadId: uploadId })
            return { ok: true }
          }
          if (uploadStatus !== 'chunk' || typeof lines !== 'string' || !lines.endsWith('\n')) {
            throw new ApiError(400, '可见性分批数据无效')
          }
          const length = Buffer.byteLength(lines)
          if (length > 1024 * 1024) throw new ApiError(413, '单批可见性结果超过 1 MiB')
          const end = offset + length
          // Retrying a batch after losing its acknowledgement leaves the file unchanged.
          if (size === end) return { ok: true }
          if (size !== offset) throw new ApiError(409, '可见性分批顺序不匹配')
          try {
            if (!lines.slice(0, -1).split('\n').every(line => {
              const row = JSON.parse(line)
              return typeof row?.sampleId === 'string' && typeof row?.objectId === 'string'
            })) throw new Error('missing row identity')
          } catch { throw new ApiError(400, '可见性结果行无效') }
          try { appendFileSync(staged, lines) }
          catch (error) {
            if (existsSync(staged)) truncateSync(staged, size)
            throw error
          }
          return { ok: true }
        }
        if (!['ready', 'failed'].includes(input?.status) || !Array.isArray(input.visibility)) {
          throw new ApiError(400, '可见性结果无效')
        }
        if (input.status === 'ready') replaceFile(join(directory, VISIBILITY), jsonl(input.visibility))
        if (input.status === 'ready' || session.analysisStatus !== 'ready') {
          writeMeta(directory, { ...status(directory), analysisStatus: input.status })
        }
        return { ok: true }
      }
      if (operation !== 'batch' && operation !== 'finish') throw new ApiError(405, '不支持的录制操作')
      if (session.captureStatus === 'saved' && operation === 'finish') return { ok: true }
      if (session.captureStatus !== 'recording') throw new ApiError(409, '录制已结束')
      for (const rows of [input?.edits, input?.samples]) {
        if (!Array.isArray(rows) || rows.some((row, index) => !Number.isSafeInteger(row?.seq)
            || row.seq <= (rows[index - 1]?.seq ?? 0) || !Number.isFinite(row.tMs))) {
          throw new ApiError(400, '录制批次的序号或时间无效')
        }
      }
      if (operation === 'finish' && (!Number.isFinite(input.durationMs) || typeof input.endedAt !== 'string')) {
        throw new ApiError(400, '缺少录制结束时间')
      }
      const lease = active.get(directory) ?? {}
      append(directory, lease, EDITS, input.edits)
      append(directory, lease, VIEWPORT, input.samples)
      if (input.resources && Array.isArray(input.resourcePaths)) {
        session.resources = input.resources
        session.resourcePaths = input.resourcePaths
      }
      if (operation === 'finish') {
        writeMeta(directory, {
          ...session,
          captureStatus: 'saved', endedAt: input.endedAt, durationMs: input.durationMs,
        })
        active.delete(directory)
      } else {
        if (input.resources && Array.isArray(input.resourcePaths)) writeMeta(directory, session)
        lease.until = Date.now() + LEASE_MS
        active.set(directory, lease)
      }
      return { ok: true }
    },
  }
}
