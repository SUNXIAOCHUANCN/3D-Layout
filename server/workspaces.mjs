import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const check = (condition, message) => { if (!condition) throw new ApiError(400, message) }
const idPattern = /^[A-Za-z0-9_-]{1,100}$/
export function sceneId(id) { check(idPattern.test(id), '非法场景 ID'); return id }
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
function asset(value) {
  check(value && typeof value.id === 'string' && value.id.length > 0 && typeof value.ref === 'string', '非法资产')
  const t = value.transform
  check(t && vector(t.position) && vector(t.rotation) && (t.scale === undefined || vector(t.scale) && t.scale.every(n => n !== 0)), '非法资产变换')
}

/** Validate the document and both history stacks before they share a commit. */
export function validateWorkspace(state, id) {
  const d = state?.document
  check(d?.meta?.id === id && d.meta.unit === 'm' && d.meta.up === '+Y', '场景元数据不匹配')
  check(typeof d.meta.name === 'string' && Number.isSafeInteger(d.meta.version) && d.meta.version >= 0, '非法场景版本')
  check(d.environment && Array.isArray(d.cameras) && Array.isArray(d.assets), '非法场景文档')
  for (const camera of d.cameras) check(camera && typeof camera.id === 'string' && vector(camera.position) && (camera.target === undefined || vector(camera.target)), '非法相机')
  check(d.assets.length <= 20000, '场景资产过多')
  d.assets.forEach(asset)
  check(new Set(d.assets.map(a => a.id)).size === d.assets.length, '资产 ID 重复')
  check(Array.isArray(state.journal) && Array.isArray(state.redoStack), '缺少历史状态')
  check(Number.isSafeInteger(state.txCounter) && state.txCounter >= 0, '非法事务计数')
  const ids = new Set()
  let operations = 0
  for (const unit of [...state.journal, ...state.redoStack]) {
    check(unit && typeof unit === 'object', '非法历史事务')
    check(Number.isSafeInteger(unit.txId) && unit.txId > 0 && unit.txId <= state.txCounter && !ids.has(unit.txId), '历史事务 ID 无效或重复')
    ids.add(unit.txId)
    check(typeof unit.label === 'string' && ['human', 'agent'].includes(unit.source) && Array.isArray(unit.entries) && unit.entries.length > 0, '非法历史事务')
    operations += unit.entries.length
    check(operations <= 100000, '历史操作过多，请导出归档后新建场景')
    for (const e of unit.entries) {
      check(e && typeof e === 'object', '非法历史操作')
      check(['set_transform', 'add_asset', 'remove_asset'].includes(e.cmd) && e.txId === unit.txId && Number.isFinite(e.time), '非法历史操作')
      check(['human', 'agent'].includes(e.source) && typeof e.label === 'string', '非法操作来源')
      check(e.cmd === 'add_asset' ? e.before === null && e.after !== null : e.cmd === 'remove_asset' ? e.before !== null && e.after === null : e.before !== null && e.after !== null, '历史操作前后状态不匹配')
      for (const side of [e.before, e.after]) if (side !== null) { asset(side); check(side.id === e.assetId, '历史资产 ID 不匹配') }
    }
  }
  const verify = (units, from, to) => {
    const assets = new Map(d.assets.map(a => [a.id, a]))
    for (const unit of units) for (const e of from === 'after' ? [...unit.entries].reverse() : unit.entries) {
      check(isDeepStrictEqual(assets.get(e.assetId) ?? null, e[from]), '场景与历史不一致')
      if (e[to] === null) assets.delete(e.assetId)
      else assets.set(e.assetId, e[to])
    }
  }
  verify([...state.journal].reverse(), 'after', 'before')
  verify([...state.redoStack].reverse(), 'before', 'after')
  return state
}

export class WorkspaceRepository {
  constructor(root, filename = join(root, '.data', 'layout.sqlite')) {
    this.root = resolve(root)
    mkdirSync(join(root, '.data'), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    if (version > 1) { this.db.close(); throw new Error('数据库版本高于当前服务版本') }
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE scenes(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, workspace TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE revisions(scene_id TEXT NOT NULL REFERENCES scenes(id), revision INTEGER NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, label TEXT NOT NULL, workspace TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scene_id,revision), UNIQUE(scene_id,request_id));
      CREATE TABLE resource_refs(scene_id TEXT NOT NULL, revision INTEGER NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(scene_id,revision,ref), FOREIGN KEY(scene_id,revision) REFERENCES revisions(scene_id,revision));
      PRAGMA user_version=1; COMMIT;`)
  }
  close() { if (this.db.isOpen) this.db.close() }
  list() {
    const ids = new Set(this.db.prepare('SELECT id FROM scenes').all().map(row => row.id))
    for (const entry of readdirSync(join(this.root, 'scenes'), { withFileTypes: true })) {
      if (entry.isDirectory() && idPattern.test(entry.name)) ids.add(entry.name)
    }
    return [...ids].sort().flatMap(id => {
      try {
        const row = this.db.prepare("SELECT json_extract(workspace, '$.document.meta.name') AS name FROM scenes WHERE id=?").get(id)
        const name = row?.name ?? JSON.parse(readFileSync(join(this.root, 'scenes', id, 'scene.json'), 'utf8')).meta?.name
        return typeof name === 'string' ? [{ id, name }] : []
      } catch { return [] }
    })
  }
  get(id) {
    sceneId(id)
    let row = this.db.prepare('SELECT * FROM scenes WHERE id=?').get(id)
    if (!row) {
      let document
      try { document = JSON.parse(readFileSync(join(this.root, 'scenes', id, 'scene.json'), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') throw new ApiError(404, '场景不存在'); throw error }
      const workspace = validateWorkspace({ document, journal: [], redoStack: [], txCounter: 0 }, id)
      this.db.prepare('INSERT OR IGNORE INTO scenes VALUES(?,0,?,1,?)').run(id, JSON.stringify(workspace), new Date().toISOString())
      row = this.db.prepare('SELECT * FROM scenes WHERE id=?').get(id)
    }
    const projectionError = this.project(id)
    return { revision: row.revision, workspace: JSON.parse(row.workspace), projectionError }
  }
  commit(id, input) {
    sceneId(id)
    check(input && typeof input.requestId === 'string' && /^[\w-]{1,100}$/.test(input.requestId), '缺少有效 requestId')
    check(Number.isSafeInteger(input.baseRevision) && input.baseRevision >= 0, '缺少有效 baseRevision')
    validateWorkspace(input.workspace, id)
    const encoded = JSON.stringify(input.workspace)
    const digest = createHash('sha256').update(JSON.stringify([input.baseRevision, input.workspace])).digest('hex')
    this.get(id)
    this.db.exec('BEGIN IMMEDIATE')
    let revision
    try {
      const old = this.db.prepare('SELECT revision,digest FROM revisions WHERE scene_id=? AND request_id=?').get(id, input.requestId)
      if (old) {
        if (old.digest !== digest) throw new ApiError(409, 'requestId 已用于其他内容')
        revision = old.revision
      } else {
        const current = this.db.prepare('SELECT revision FROM scenes WHERE id=?').get(id)
        if (current.revision !== input.baseRevision) throw new ApiError(409, '场景已被其他页面修改；请先导出本地副本，再重新加载')
        revision = current.revision + 1
        const now = new Date().toISOString()
        this.db.prepare('UPDATE scenes SET revision=?, workspace=?, projected=0, updated_at=? WHERE id=?').run(revision, encoded, now, id)
        this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?)').run(id, revision, input.requestId, digest, String(input.label ?? '编辑').slice(0,200), encoded, now)
        const refs = new Set(input.workspace.document.assets.map(a => a.ref))
        if (input.workspace.document.environment.hdri) refs.add(input.workspace.document.environment.hdri)
        for (const u of [...input.workspace.journal, ...input.workspace.redoStack]) for (const e of u.entries) {
          if (e.before) refs.add(e.before.ref)
          if (e.after) refs.add(e.after.ref)
        }
        const insert = this.db.prepare('INSERT INTO resource_refs VALUES(?,?,?)')
        for (const ref of refs) insert.run(id, revision, ref)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return { revision, projectionError: this.project(id) }
  }
  project(id) {
    const row = this.db.prepare('SELECT workspace,projected FROM scenes WHERE id=?').get(id)
    if (!row || row.projected) return null
    try {
      const target = join(this.root, 'scenes', id, 'scene.json')
      const temp = target + '.pending'
      writeFileSync(temp, JSON.stringify(JSON.parse(row.workspace).document, null, 2) + '\n')
      renameSync(temp, target)
      this.db.prepare('UPDATE scenes SET projected=1 WHERE id=?').run(id)
      return null
    } catch (error) { return `数据库已保存，文件导出待重试：${error.message}` }
  }
  history(id, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    this.get(id)
    return this.db.prepare('SELECT revision,label,created_at FROM revisions WHERE scene_id=? AND revision<? ORDER BY revision DESC LIMIT ?').all(id, before, limit)
  }
  restore(id, input) {
    check(Number.isSafeInteger(input?.revision), '缺少恢复版本')
    const row = this.db.prepare('SELECT workspace FROM revisions WHERE scene_id=? AND revision=?').get(sceneId(id), input.revision)
    if (!row) throw new ApiError(404, '版本不存在')
    const workspace = JSON.parse(row.workspace)
    workspace.journal = []; workspace.redoStack = []
    return this.commit(id, { ...input, workspace, label: `恢复版本 ${input.revision}` })
  }
}
