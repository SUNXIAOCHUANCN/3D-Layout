/**
 * 插件 UI：选输入 → 浏览器转换 → 预览 → 上传暂存 → 提交 → 打开宿主链接。
 * 全流程不触碰宿主页面（架构文档 §2/§7.3）。
 */

import { zipSync } from 'fflate'
import './style.css'
import type { ConvertOutput } from '../adapters/three/convert.js'
import type { JobRecord } from '../server/jobs.js'

// ---------- 基础设施 ----------

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`缺少元素 ${sel}`)
  return el as T
}

let token = ''

async function api<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
  const headers = new Headers(init?.headers)
  if (token) headers.set('x-interchange-token', token)
  const res = await fetch(path, { ...init, headers })
  const ct = res.headers.get('content-type') ?? ''
  if (init?.raw || !ct.includes('application/json')) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.blob()) as unknown as T
  }
  const body = JSON.parse(await res.text()) as T & { ok: boolean; error?: { message: string; code: string } }
  if (!body.ok) throw new Error(`[${body.error?.code}] ${body.error?.message}`)
  return body
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

function issuesHtml(issues: Array<{ code: string; severity: string; message: string }>): string {
  if (issues.length === 0) return ''
  const cls = (s: string) => (s === 'error' ? 'issue-error' : s === 'warning' ? 'issue-warn' : 'issue-info')
  return `<ul class="issues">${issues.map(i =>
    `<li class="${cls(i.severity)}"><b>[${esc(i.code)}]</b> ${esc(i.message)}</li>`).join('')}</ul>`
}

// ---------- 启动 ----------

async function boot(): Promise<void> {
  try {
    const t = await api<{ token: string }>('/api/interchange/token')
    token = t.token
    const st = await api<{ version: string; root: string; scenes: number; models: number }>('/api/interchange/status')
    $('#service-status').textContent = `已连接 · v${st.version} · 工程根 ${st.root} · ${st.scenes} 场景 / ${st.models} 模型`
  } catch (e) {
    $('#service-status').textContent = `连接失败：${e instanceof Error ? e.message : String(e)}`
  }
}

// ---------- Tab 切换 ----------

const pages = ['import', 'export', 'jobs'] as const
for (const p of pages) {
  $(`#tab-${p}`).addEventListener('click', () => {
    for (const q of pages) {
      $(`#page-${q}`).classList.toggle('hidden', q !== p)
      $(`#tab-${q}`).classList.toggle('active', q === p)
    }
    if (p === 'export') void refreshExport()
    if (p === 'jobs') void refreshJobs()
  })
}

// ---------- 导入流程 ----------

let converted: ConvertOutput | null = null
let currentJobId: string | null = null

$('#btn-convert').addEventListener('click', () => void doConvert())

async function doConvert(): Promise<void> {
  const input = $('#file-input') as HTMLInputElement
  if (!input.files || input.files.length === 0) {
    alert('请先选择文件')
    return
  }
  setBusy('#btn-convert', true, '转换中…')
  try {
    const { convertImport } = await import('../adapters/three/convert.js')
    const { validateLayoutImport } = await import('../application/validation.js')

    // 收集输入：zip 或散文件
    const files = new Map<string, Uint8Array>()
    let declarationBytes: Uint8Array | null = null
    for (const f of Array.from(input.files)) {
      const bytes = new Uint8Array(await f.arrayBuffer())
      if (f.name.toLowerCase().endsWith('.zip')) {
        const { unzipSync } = await import('fflate')
        for (const [name, data] of Object.entries(unzipSync(bytes))) {
          if (name.endsWith('/')) continue
          const norm = name.replace(/\\/g, '/')
          if (files.has(norm)) throw new Error(`zip 内重复条目：${norm}`)
          files.set(norm, data)
        }
      } else {
        files.set(f.name, bytes)
      }
    }
    for (const [name, bytes] of files) {
      if (name === 'layout-import.json' || name.endsWith('/layout-import.json')) declarationBytes = bytes
    }
    if (!declarationBytes) {
      throw new Error('未找到 layout-import.json；一期需要显式声明（资产边界/单位/命名）')
    }
    const parsed = JSON.parse(new TextDecoder().decode(declarationBytes))
    const check = validateLayoutImport(parsed)
    if (!check.ok) {
      throw new Error(`声明校验失败：\n` + check.issues.map(i => `[${i.code}] ${i.message}`).join('\n'))
    }

    // 相对路径解析：声明中的模型文件路径（如 models/foo.glb）需要在输入集合中找到。
    // 兼容用户直接多选文件（文件名只有 basename）：建 basename → 完整路径 索引。
    const decl = check.value
    const resolved = new Map(files)
    for (const m of decl.models) {
      if (!resolved.has(m.file)) {
        const base = m.file.split('/').pop()!
        const hit = Array.from(files.keys()).find(k => k.split('/').pop() === base)
        if (hit) resolved.set(m.file, files.get(hit)!)
      }
    }
    if (decl.environment?.hdri && !resolved.has(decl.environment.hdri)) {
      const base = decl.environment.hdri.split('/').pop()!
      const hit = Array.from(files.keys()).find(k => k.split('/').pop() === base)
      if (hit) resolved.set(decl.environment.hdri, files.get(hit)!)
    }

    converted = await convertImport({ declaration: decl, declarationBytes, files: resolved })
    renderConvertResult(converted)
  } catch (e) {
    converted = null
    $('#convert-result').classList.remove('hidden')
    $('#convert-summary').innerHTML = ''
    $('#convert-issues').innerHTML = issuesHtml([{ code: 'CONVERT_FAILED', severity: 'error', message: e instanceof Error ? e.message : String(e) }])
    $('#btn-prepare').classList.add('hidden')
  } finally {
    setBusy('#btn-convert', false)
  }
}

function renderConvertResult(out: ConvertOutput): void {
  $('#convert-result').classList.remove('hidden')
  const blocking = out.issues.filter(i => i.severity === 'error')
  const { plan } = out
  $('#convert-summary').innerHTML = `
    <table>
      <tr><th>场景</th><td>${esc(plan.sceneId)}（${plan.instanceCount} 实例）</td></tr>
      ${plan.models.map(m => `
        <tr><th>模型 ${esc(m.key)}</th><td>
          → <code>${esc(m.dir)}</code><br/>
          尺寸 ${m.dimensions.w.toFixed(3)} × ${m.dimensions.h.toFixed(3)} × ${m.dimensions.d.toFixed(3)} m ·
          规范 GLB ${(m.canonicalBytes / 1024).toFixed(1)} KiB · sha256 ${m.canonicalSha256.slice(0, 12)}…
          ${m.warnings.length ? `<div class="issue-warn">${esc(m.warnings.map(w => `[${w.code}] ${w.message}`).join('; '))}</div>` : ''}
        </td></tr>`).join('')}
      <tr><th>文件集</th><td>${plan.files.length} 个文件（见下方报告）</td></tr>
    </table>`
  $('#convert-issues').innerHTML = issuesHtml(out.issues)
  $('#btn-prepare').classList.toggle('hidden', blocking.length > 0)
}

$('#btn-prepare').addEventListener('click', () => void doPrepare())

async function doPrepare(): Promise<void> {
  if (!converted) return
  setBusy('#btn-prepare', true, '上传并复核中…')
  try {
    const files: Record<string, Uint8Array> = {}
    for (const [p, b] of converted.candidateFiles) files[p] = b
    const zip = zipSync(files, { level: 6 })
    const policy = ($('#conflict-policy') as HTMLSelectElement).value as 'reject' | 'suffix-hash'
    const res = await api<{ job: JobRecord }>('/api/interchange/prepare?conflict=' + policy, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: zip,
    })
    currentJobId = res.job.id
    showJob(res.job)
  } catch (e) {
    showJobError(e)
  } finally {
    setBusy('#btn-prepare', false)
  }
}

function showJob(job: JobRecord): void {
  $('#job-view').classList.remove('hidden')
  currentJobId = job.id
  const conflicts = (job.issues ?? []).filter(i => i.severity === 'error')
  $('#job-info').innerHTML = `
    <table>
      <tr><th>任务</th><td><code>${esc(job.id)}</code></td></tr>
      <tr><th>状态</th><td><b class="state-${esc(job.state)}">${esc(job.state)}</b></td></tr>
      <tr><th>目标场景</th><td>${esc(job.requestedSceneId)}${job.sceneId !== job.requestedSceneId ? ` → 改写为 <b>${esc(job.sceneId)}</b>` : ''}</td></tr>
      <tr><th>文件数</th><td>${job.files.length}</td></tr>
    </table>
    ${job.renames.length ? `<p>引用改写：${esc(job.renames.map(r => `${r.from} → ${r.to}`).join('；'))}</p>` : ''}
    ${issuesHtml(job.issues ?? [])}
    ${job.error ? `<p class="issue-error">${esc(job.error)}</p>` : ''}`
  const actions = $('#job-actions')
  actions.innerHTML = ''
  if (job.state === 'staged' && conflicts.length === 0) {
    const commit = document.createElement('button')
    commit.className = 'primary'
    commit.textContent = '6. 提交入库'
    commit.addEventListener('click', () => void doCommit())
    actions.appendChild(commit)
  }
  if (job.state === 'committed') {
    const hostBase = ($('#host-base') as HTMLInputElement).value.replace(/\/$/, '')
    const open = document.createElement('a')
    open.className = 'primary button-link'
    open.href = `${hostBase}/?scene=${encodeURIComponent(job.sceneId)}`
    open.target = '_blank'
    open.rel = 'noopener'
    open.textContent = `7. 在宿主中打开场景 ${job.sceneId}（新标签页）`
    actions.appendChild(open)
  }
}

function showJobError(e: unknown): void {
  $('#job-view').classList.remove('hidden')
  $('#job-info').innerHTML = issuesHtml([{ code: 'PREPARE_FAILED', severity: 'error', message: e instanceof Error ? e.message : String(e) }])
  $('#job-actions').innerHTML = ''
}

async function doCommit(): Promise<void> {
  if (!currentJobId) return
  try {
    await api<{ job?: JobRecord }>(`/api/interchange/jobs/${currentJobId}/commit`, { method: 'POST' })
    const res = await api<{ job: JobRecord }>(`/api/interchange/jobs/${currentJobId}`)
    showJob(res.job)
  } catch (e) {
    try {
      const res = await api<{ job: JobRecord }>(`/api/interchange/jobs/${currentJobId}`)
      showJob(res.job)
    } catch {
      showJobError(e)
    }
  }
}

async function pollJob(id: string): Promise<void> {
  const res = await api<{ job: JobRecord }>(`/api/interchange/jobs/${id}`)
  showJob(res.job)
}

// ---------- 导出 ----------

let selectedScene: string | null = null
let selectedModel: string | null = null

async function refreshExport(): Promise<void> {
  const scenes = await api<{ scenes: Array<{ id: string; name: string }> }>('/api/interchange/scenes')
  const models = await api<{ models: string[] }>('/api/interchange/models')
  $('#scene-list').innerHTML = scenes.scenes.map(s =>
    `<label><input type="radio" name="scene" value="${esc(s.id)}" /> ${esc(s.id)} — ${esc(s.name)}</label>`).join('') || '<p class="muted">（无场景）</p>'
  $('#model-list').innerHTML = models.models.map(r =>
    `<label><input type="radio" name="model" value="${esc(r)}" /> ${esc(r)}</label>`).join('') || '<p class="muted">（无模型）</p>'
  $('#scene-list').addEventListener('change', () => {
    selectedScene = ($('#scene-list input:checked') as HTMLInputElement | null)?.value ?? null
    ;($('#btn-export-scene') as HTMLButtonElement).disabled = !selectedScene
  })
  $('#model-list').addEventListener('change', () => {
    selectedModel = ($('#model-list input:checked') as HTMLInputElement | null)?.value ?? null
    ;($('#btn-export-model') as HTMLButtonElement).disabled = !selectedModel
  })
}

$('#btn-export-scene').addEventListener('click', () => void doExportScene())
$('#btn-export-model').addEventListener('click', () => void doExportModel())

async function doExportScene(): Promise<void> {
  if (!selectedScene) return
  const blob = await api<Blob>('/api/interchange/export/package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sceneId: selectedScene }),
    raw: true,
  })
  await downloadBlob(blob, `${selectedScene}.layout.zip`)
}

async function doExportModel(): Promise<void> {
  if (!selectedModel) return
  const blob = await api<Blob>('/api/interchange/export/model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: selectedModel }),
    raw: true,
  })
  await downloadBlob(blob, `${selectedModel.replace(/^models\//, '')}.model.zip`)
}

async function refreshJobs(): Promise<void> {
  const res = await api<{ jobs: JobRecord[] }>('/api/interchange/jobs')
  $('#jobs-list').innerHTML = res.jobs.map(j =>
    `<div class="job-row"><code>${esc(j.id)}</code> — <b class="state-${esc(j.state)}">${esc(j.state)}</b> — ${esc(j.sceneId)} — ${esc(j.createdAt)}</div>`).join('')
    || '<p class="muted">（暂无任务）</p>'
}

// ---------- 工具 ----------

function setBusy(sel: string, busy: boolean, text?: string): void {
  const btn = $(sel) as HTMLButtonElement
  btn.disabled = busy
  if (busy) {
    btn.dataset.origText = btn.textContent ?? ''
    if (text) btn.textContent = text
  } else if (btn.dataset.origText) {
    btn.textContent = btn.dataset.origText
  }
}

// pollJob 暴露给需要轮询的场景（提交后如需刷新）
void pollJob
void boot()
