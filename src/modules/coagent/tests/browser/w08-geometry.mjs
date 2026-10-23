/**
 * W08.3 浏览器实测：真实 scene-02 + 真实 CoAgentBridge.geometry。
 *
 * 单测（tests/unit/geometry.test.ts）证明数学；本脚本证明"真实资产树 + 世界矩阵 +
 * bridge 端口"能给出 clear/collision/unknown，而不是只在 Fake 上通过。
 *
 * 用法（src/ 下）：
 *   pnpm dev -- --host 127.0.0.1 --port 5173 --strictPort
 *   node modules/coagent/tests/browser/w08-geometry.mjs --url=http://127.0.0.1:5173/
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../../..')
const LAYOUT = resolve(SRC, '..')
const ARTIFACTS = join(HERE, 'artifacts')
mkdirSync(ARTIFACTS, { recursive: true })

const args = new Map(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)
const URL_BASE = args.get('url') ?? 'http://127.0.0.1:5173/'
const CHROME =
  args.get('chrome') ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p))
if (!CHROME) {
  console.error('找不到 Chrome/Edge；可用 --chrome=<path> 指定')
  process.exit(2)
}

const SCENE_FILE = join(LAYOUT, 'scenes', 'scene-02', 'scene.json')
const sceneBackup = existsSync(SCENE_FILE) ? readFileSync(SCENE_FILE) : null

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail })
  const tail = detail === undefined || detail === null ? '' : `  <- ${JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${tail}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? rej(new Error(`${m.error.message} (${m.error.code})`)) : res(m.result)
      }
    })
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(`CDP timeout: ${method}`))
        }
      }, 60_000)
    })
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, { timeout = 30_000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting: ${label}`)
    await sleep(interval)
  }
}

const PORT = 9336
const profile = join(ARTIFACTS, '.w08-profile')
rmSync(profile, { recursive: true, force: true })

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--window-size=1600,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let cdp = null
try {
  await waitFor(
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
        return r.ok ? await r.json() : null
      } catch {
        return null
      }
    },
    { timeout: 20_000, label: 'DevTools port' },
  )
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.bringToFront')

  const pageErrors = []
  cdp.ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') pageErrors.push(m.params.entry.text.slice(0, 200))
  })

  const url = `${URL_BASE}${URL_BASE.includes('?') ? '&' : '?'}scene=scene-02`
  await cdp.send('Page.navigate', { url })
  await waitFor(() => cdp.eval('Boolean(window.__coagentDev) && typeof window.__coagentDev.geometry === "function"', false), {
    label: 'dev harness geometry',
  })
  await waitFor(() => cdp.eval('Boolean(window.__coagent && window.__coagent.debugSnapshot({}).assets.length === 10)', false), {
    label: 'scene-02 loaded (10 assets)',
  })
  await waitFor(() => cdp.eval('Boolean(window.__coagent.renderDiagnostics())', false), { label: 'CoAgentBridge mounted' })

  const geometry = req => cdp.eval(`__coagentDev.geometry(${JSON.stringify(req)})`)

  // 1) 真实资产：两个货架相距 4.8m → AABB clear
  const clear = await geometry({
    objectIds: ['shelf-01'],
    staticObjectIds: ['shelf-04'],
    contactToleranceM: 0.01,
    allowGroundContact: false,
  })
  check('真实场景：shelf-01 vs shelf-04 → clear/aabb', clear.status === 'clear' && clear.pairs[0]?.level === 'aabb', clear)

  // 2) 把两个料桶摆到重叠位置 → 三角形 collision
  const movedHit1 = await cdp.eval(`__coagentDev.moveObject('barrel-01', [-0.3, 0, 0])`)
  const movedHit2 = await cdp.eval(`__coagentDev.moveObject('barrel-02', [0.2, 0, 0.1])`)
  check('真实 core 编辑：两桶已摆到重叠位置', movedHit1 === true && movedHit2 === true, { movedHit1, movedHit2 })
  const hit = await geometry({
    objectIds: ['barrel-01'],
    staticObjectIds: ['barrel-02'],
    contactToleranceM: 0.01,
    allowGroundContact: false,
  })
  check('真实场景：barrel-01 vs barrel-02 重叠 → collision/mesh', hit.status === 'collision' && hit.pairs[0]?.level === 'mesh', hit)

  // 3) 把两桶摆到间距 5mm：地面接触允许 → clear；不允许 → collision（接触）
  const moved1 = await cdp.eval(`__coagentDev.moveObject('barrel-01', [-0.555, 0, 0])`)
  const moved2 = await cdp.eval(`__coagentDev.moveObject('barrel-02', [0, 0, 0])`)
  check('真实 core 编辑：两桶已摆到间距 5mm', moved1 === true && moved2 === true, { moved1, moved2 })

  const groundAllowed = await geometry({
    objectIds: ['barrel-01', 'barrel-02'],
    staticObjectIds: [],
    contactToleranceM: 0.01,
    allowGroundContact: true,
  })
  check(
    '真实场景：5mm 地面接触 + allowGroundContact → clear',
    groundAllowed.status === 'clear' && String(groundAllowed.pairs[0]?.note ?? '').includes('地面支撑'),
    groundAllowed,
  )

  const groundDenied = await geometry({
    objectIds: ['barrel-01', 'barrel-02'],
    staticObjectIds: [],
    contactToleranceM: 0.01,
    allowGroundContact: false,
  })
  check('真实场景：5mm 接触 + 不允许地面 → collision', groundDenied.status === 'collision', groundDenied)

  // 4) 不存在的对象 → unknown，不能冒充 clear
  const unknown = await geometry({
    objectIds: ['shelf-01'],
    staticObjectIds: ['ghost-asset'],
    contactToleranceM: 0.01,
    allowGroundContact: false,
  })
  check('真实场景：不存在的对象 → unknown', unknown.status === 'unknown', unknown)

  // 5) 主相机/上下文未受影响
  const diag = await cdp.eval('__coagent.renderDiagnostics()')
  check('几何检测不影响渲染桥/上下文', diag.mounted === true && diag.contextLost === false, {
    mounted: diag.mounted,
    contextLost: diag.contextLost,
  })

  check('无页面级 JS 错误', pageErrors.filter(t => !t.includes('Failed to load resource')).length === 0, pageErrors.slice(0, 3))
} catch (e) {
  check('脚本执行未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e))
} finally {
  if (cdp) cdp.close()
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
  if (sceneBackup) {
    writeFileSync(SCENE_FILE, sceneBackup)
    console.log('scene-02 restored:', readFileSync(SCENE_FILE).length === sceneBackup.length ? 'OK' : 'CHECK')
  }
  const passed = results.filter(r => r.ok).length
  const failed = results.length - passed
  writeFileSync(
    join(ARTIFACTS, 'w08-report.json'),
    JSON.stringify({ url: URL_BASE, when: new Date().toISOString(), passed, failed, results }, null, 2),
  )
  console.log(`\n${passed}/${results.length} passed, ${failed} failed -> ${join(ARTIFACTS, 'w08-report.json')}`)
  process.exit(failed === 0 ? 0 : 1)
}
