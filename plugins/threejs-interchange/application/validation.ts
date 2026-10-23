/**
 * 输入校验：layout-import.json schema、候选包路径安全、资源限额。
 * 纯数据，浏览器与服务端共用；服务端在 prepare/commit 两道关口独立复核。
 */

import type { LayoutImport, ImportCoordinates, ConflictPolicy } from './contracts.js'
import { IMPORT_SCHEMA_VERSION, CONFLICT_POLICIES } from './contracts.js'
import { InterchangeError, type Issue, errorIssue } from './errors.js'
import { isValidSceneId, isValidModelKey, isValidInstanceId } from './naming.js'

export const LIMITS = {
  maxModels: 500,
  maxInstances: 2000,
  maxTotalBytes: 1024 * 1024 * 1024, // 解压后总字节 1GiB
  maxFileBytes: 256 * 1024 * 1024,
  maxFileCount: 2000,
  maxVertices: 8_000_000, // 单模型顶点上限
  maxPathLen: 200,
}

// ---------- layout-import.json schema ----------

export function validateLayoutImport(data: unknown): { ok: true; value: LayoutImport } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = []
  const d = data as Record<string, unknown> | null
  if (!isObj(d)) return { ok: false, issues: [errorIssue('INVALID_DECLARATION', '声明必须是 JSON 对象')] }

  if (d.schemaVersion !== IMPORT_SCHEMA_VERSION) {
    issues.push(errorIssue('INVALID_DECLARATION', `schemaVersion 必须为 ${IMPORT_SCHEMA_VERSION}（收到 ${JSON.stringify(d.schemaVersion)}）`))
  }
  if (d.profile !== 'layout-static-v1') {
    issues.push(errorIssue('INVALID_DECLARATION', "profile 必须为 'layout-static-v1'"))
  }

  const scene = d.scene
  if (!isObj(scene)) {
    issues.push(errorIssue('INVALID_DECLARATION', '缺少 scene 声明'))
  } else {
    if (typeof scene.id !== 'string' || !isValidSceneId(scene.id)) {
      issues.push(errorIssue('INVALID_DECLARATION', `scene.id 非法：须匹配小写字母/数字/短横线（收到 ${JSON.stringify(scene.id)}）`, { path: 'scene.id' }))
    }
    if (typeof scene.name !== 'string' || scene.name.length === 0 || scene.name.length > 100) {
      issues.push(errorIssue('INVALID_DECLARATION', 'scene.name 必须为 1-100 字符字符串', { path: 'scene.name' }))
    }
  }

  const coords = d.coordinates
  if (!isObj(coords)) {
    issues.push(errorIssue('INVALID_DECLARATION', '缺少 coordinates 声明（单位/向上轴不可猜测）'))
  } else if (!validateCoordinates(coords)) {
    issues.push(errorIssue('INVALID_DECLARATION', 'coordinates 非法：metersPerUnit 须为正有限数，up 须 \'+Y\'|+\'+Z\'，handedness 须 \'right\'', { path: 'coordinates' }))
  }

  const models = d.models
  if (!Array.isArray(models) || models.length === 0) {
    issues.push(errorIssue('INVALID_DECLARATION', 'models 必须为非空数组'))
  } else {
    if (models.length > LIMITS.maxModels) issues.push(errorIssue('LIMIT_EXCEEDED', `模型数量超过上限 ${LIMITS.maxModels}`))
    const keys = new Set<string>()
    const files = new Set<string>()
    models.forEach((m, i) => {
      const at = `models[${i}]`
      if (!isObj(m)) { issues.push(errorIssue('INVALID_DECLARATION', `${at} 必须为对象`)); return }
      if (typeof m.key !== 'string' || !isValidModelKey(m.key)) {
        issues.push(errorIssue('INVALID_DECLARATION', `${at}.key 非法（小写字母/数字/短横线，≤64 字符）`, { path: `${at}.key` }))
      } else if (keys.has(m.key)) {
        issues.push(errorIssue('INVALID_DECLARATION', `modelKey 重复：${m.key}`, { path: at }))
      } else keys.add(m.key)
      if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 100) {
        issues.push(errorIssue('INVALID_DECLARATION', `${at}.name 必须为 1-100 字符字符串`, { path: `${at}.name` }))
      }
      if (typeof m.file !== 'string' || !isSafeRelPath(m.file)) {
        issues.push(errorIssue('PATH_UNSAFE', `${at}.file 必须为包内安全相对路径`, { path: `${at}.file` }))
      } else if (files.has(m.file)) {
        issues.push(errorIssue('INVALID_DECLARATION', `多个模型声明了同一源文件 ${m.file}；几何不同必须拆分文件`, { path: at }))
      } else files.add(m.file)
    })
  }

  const instances = d.instances
  if (!Array.isArray(instances) || instances.length === 0) {
    issues.push(errorIssue('MISSING_ASSET_DECLARATION', 'instances 必须为非空数组；未声明资产边界不导入'))
  } else {
    if (instances.length > LIMITS.maxInstances) issues.push(errorIssue('LIMIT_EXCEEDED', `实例数量超过上限 ${LIMITS.maxInstances}`))
    const ids = new Set<string>()
    const modelKeys = new Set<string>((Array.isArray(models) ? models : []).map(m => (isObj(m) && typeof m.key === 'string' ? m.key : '')))
    instances.forEach((inst, i) => {
      const at = `instances[${i}]`
      if (!isObj(inst)) { issues.push(errorIssue('INVALID_DECLARATION', `${at} 必须为对象`)); return }
      if (typeof inst.id !== 'string' || !isValidInstanceId(inst.id)) {
        issues.push(errorIssue('INVALID_DECLARATION', `${at}.id 非法（字母/数字/下划线/短横线）`, { path: `${at}.id` }))
      } else if (ids.has(inst.id)) {
        issues.push(errorIssue('INVALID_DECLARATION', `实例 id 重复：${inst.id}`, { path: at }))
      } else ids.add(inst.id)
      if (typeof inst.modelKey !== 'string' || !modelKeys.has(inst.modelKey)) {
        issues.push(errorIssue('INVALID_DECLARATION', `${at}.modelKey 未在 models 中声明：${JSON.stringify(inst.modelKey)}`, { path: `${at}.modelKey` }))
      }
      if (!validateInstanceTransform(inst.transform)) {
        issues.push(errorIssue('INVALID_DECLARATION', `${at}.transform 非法：position 必填且为 3 个有限数字；rotation/scale 可选（scale 须为正有限数）`, { path: `${at}.transform` }))
      }
    })
  }

  if (d.camera !== undefined && !validateCamera(d.camera)) {
    issues.push(errorIssue('INVALID_DECLARATION', 'camera 非法：position 必填 3 有限数字，target 可选，fov 须为 (0,180) 有限数', { path: 'camera' }))
  }
  if (d.environment !== undefined && !isObj(d.environment)) {
    issues.push(errorIssue('INVALID_DECLARATION', 'environment 必须为对象', { path: 'environment' }))
  }
  if (d.options !== undefined) {
    if (!isObj(d.options) || (d.options.conflict !== undefined && !CONFLICT_POLICIES.includes(d.options.conflict as ConflictPolicy))) {
      issues.push(errorIssue('INVALID_DECLARATION', `options.conflict 只能为 ${CONFLICT_POLICIES.join(' | ')}`, { path: 'options' }))
    }
  }

  return issues.length === 0 ? { ok: true, value: data as LayoutImport } : { ok: false, issues }
}

function validateCoordinates(c: Record<string, unknown>): boolean {
  return (
    typeof c.metersPerUnit === 'number' && Number.isFinite(c.metersPerUnit) && (c.metersPerUnit as number) > 0 &&
    (c.up === '+Y' || c.up === '+Z') &&
    c.handedness === 'right'
  )
}

function validateInstanceTransform(t: unknown): boolean {
  if (!isObj(t)) return false
  if (!isVec3(t.position)) return false
  if (t.rotation !== undefined && !isVec3(t.rotation)) return false
  if (t.scale !== undefined && !isVec3(t.scale)) return false
  if (t.scale !== undefined && (t.scale as number[]).some(s => !(Number.isFinite(s) && s > 0))) return false
  return true
}

function validateCamera(c: unknown): boolean {
  if (!isObj(c)) return false
  if (!isVec3(c.position)) return false
  if (c.target !== undefined && !isVec3(c.target)) return false
  if (c.fov !== undefined && !(typeof c.fov === 'number' && Number.isFinite(c.fov) && c.fov > 0 && c.fov < 180)) return false
  if (c.id !== undefined && typeof c.id !== 'string') return false
  return true
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------- 路径安全 ----------

/** 声明中允许引用的包内相对路径：posix 相对路径，禁绝对/盘符/.. /反斜杠 */
export function isSafeRelPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > LIMITS.maxPathLen) return false
  if (p.includes('\\')) return false
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  if (p.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) return false
  if (/[\u0000-\u001f]/.test(p)) return false
  return true
}

export interface CandidateEntryInfo {
  path: string
  bytes: number
}

/**
 * 候选包条目校验：只允许 scenes/、assets/、import/ 三个顶层命名空间；
 * 拒绝重复条目与大小写碰撞（跨平台安全）。
 */
export function validateCandidateEntries(entries: CandidateEntryInfo[]): Issue[] {
  const issues: Issue[] = []
  let total = 0
  const seen = new Map<string, string>() // lower -> 原路径

  if (entries.length > LIMITS.maxFileCount) {
    issues.push(errorIssue('LIMIT_EXCEEDED', `文件数 ${entries.length} 超过上限 ${LIMITS.maxFileCount}`))
  }
  for (const e of entries) {
    if (!isSafeRelPath(e.path)) {
      issues.push(errorIssue('PATH_UNSAFE', `路径不安全：${JSON.stringify(e.path)}`, { path: e.path }))
      continue
    }
    if (!/^(scenes|assets|import)\//.test(e.path)) {
      issues.push(errorIssue('PATH_UNSAFE', `只允许 scenes/、assets/、import/ 顶层目录：${e.path}`, { path: e.path }))
      continue
    }
    if (e.bytes > LIMITS.maxFileBytes) {
      issues.push(errorIssue('LIMIT_EXCEEDED', `单文件超过上限：${e.path}（${e.bytes} 字节）`, { path: e.path }))
    }
    total += e.bytes
    const lower = e.path.toLowerCase()
    const prev = seen.get(lower)
    if (prev !== undefined) {
      if (prev === e.path) {
        issues.push(errorIssue('DUPLICATE_ENTRY', `归档内重复条目：${e.path}`, { path: e.path }))
      } else {
        issues.push(errorIssue('CASE_COLLISION', `大小写碰撞：${prev} 与 ${e.path}`, { path: e.path }))
      }
    } else {
      seen.set(lower, e.path)
    }
  }
  if (total > LIMITS.maxTotalBytes) {
    issues.push(errorIssue('LIMIT_EXCEEDED', `解压后总字节 ${total} 超过上限 ${LIMITS.maxTotalBytes}`))
  }
  return issues
}

// ---------- zip 安全 ----------

/** fflate unzip 结果（原始文件名可能带 \ 或绝对段）统一为安全 posix 相对路径；非法返回 null */
export function normalizeZipEntryPath(rawName: string): string | null {
  if (rawName.endsWith('/') || rawName.endsWith('\\')) return null // 目录条目由调用方过滤
  let name = rawName.replace(/\\/g, '/')
  while (name.startsWith('/')) name = name.slice(1)
  if (/^[a-zA-Z]:/.test(name)) return null
  const segs = name.split('/')
  const out: string[] = []
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null
    if (/[\u0000-\u001f]/.test(seg)) return null
    out.push(seg)
  }
  const joined = out.join('/')
  return joined.length > 0 && joined.length <= LIMITS.maxPathLen ? joined : null
}

export function assertCondition(cond: boolean, code: string, message: string, extra?: Partial<Issue>): void {
  if (!cond) throw new InterchangeError(code, message, extra)
}
