/**
 * W10-P2 浏览器实测：真实 scene-02 + 真实 CoAgentBridge 的截图点选与相机取景。
 *
 * 单测（tests/unit/pick.test.ts）证明射线数学；本脚本证明在**真实资产树 + WebGL 管线 +
 * 真实观测相机**上，"点到的"和"看到的"是同一个对象 —— 也就是 `scene.pick` 的前提成立。
 *
 * 用法（src/ 下）：
 *   pnpm dev -- --host 127.0.0.1 --port 5173 --strictPort
 *   node modules/coagent/tests/browser/w10-observe.mjs --url=http://localhost:5173/
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

// 端口的独占性见 IMPLEMENTATION-STATUS §16：w03/w04/w08 用 9333，T14 用 9334，w08 用 9336
const PORT = 9337
const profile = join(ARTIFACTS, '.w10-profile')
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

const W = 640
const H = 480

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
  await waitFor(() => cdp.eval('Boolean(window.__coagentDev) && typeof window.__coagentDev.pick === "function"', false), {
    label: 'dev harness pick',
  })
  await waitFor(
    () => cdp.eval('Boolean(window.__coagent && window.__coagent.debugSnapshot({}).assets.length === 10)', false),
    { label: 'scene-02 loaded (10 assets)' },
  )
  await waitFor(() => cdp.eval('Boolean(window.__coagent.renderDiagnostics())', false), { label: 'CoAgentBridge mounted' })

  // ---- 用真实场景包围盒构造相机（与 regionCamera / focusCamera 同一思路） ----
  const assets = await cdp.eval('__coagent.debugSnapshot({}).assets.map(a => ({id:a.id, p:a.transform.position}))')
  const xs = assets.map(a => a.p[0])
  const zs = assets.map(a => a.p[2])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const halfW = Math.max((maxX - minX) / 2, 1) * 1.1
  const halfH = Math.max((maxZ - minZ) / 2, 1) * 1.1
  const span = Math.max(maxX - minX, maxZ - minZ, 2)

  const ortho = {
    schemaVersion: 1,
    id: 'cam-w10-ortho',
    projection: 'orthographic',
    position: [cx, 60, cz],
    target: [cx, 0, cz],
    up: [0, 0, -1],
    near: 0.1,
    far: 300,
    aspect: 4 / 3,
    ortho: { left: -halfH * (4 / 3), right: halfH * (4 / 3), top: halfH, bottom: -halfH },
  }
  const persp = {
    schemaVersion: 1,
    id: 'cam-w10-persp',
    projection: 'perspective',
    position: [cx + span * 0.9, span * 0.8, cz + span * 0.9],
    target: [cx, 0, cz],
    up: [0, 1, 0],
    near: 0.1,
    far: span * 8 + 100,
    aspect: 4 / 3,
    fovDeg: 45,
  }

  const capture = input => cdp.eval(`__coagentDev.capture(${JSON.stringify(input)})`)
  const pick = input => cdp.eval(`__coagentDev.pick(${JSON.stringify(input)})`)

  /** 取某标签的像素框中心（归一化）；没有框就返回 null */
  const centerOf = (obs, objectId) => {
    const label = (obs.labels ?? []).find(l => l.objectId === objectId)
    if (!label || !label.pixelBox) return null
    const b = label.pixelBox
    return { u: (b.minX + b.maxX) / 2 / W, v: (b.minY + b.maxY) / 2 / H, box: b }
  }

  const focusId = 'barrel-01'
  const mainBefore = await cdp.eval('__coagent.renderDiagnostics().mainCamera')

  // ---- 1) 正交俯视：标签框中心应点回同一个对象 ----
  const orthoObs = await capture({ camera: ortho, width: W, height: H, objectIds: [focusId], marked: true })
  const orthoCenter = centerOf(orthoObs, focusId)
  check('正交俯视：目标在图内且有像素框', Boolean(orthoCenter), orthoCenter?.box ?? null)

  const orthoHit = await pick({ camera: orthoObs.camera, width: W, height: H, u: orthoCenter.u, v: orthoCenter.v })
  check('正交俯视：框中心点选 → 命中同一个对象', orthoHit?.hit?.objectId === focusId, orthoHit?.hit ?? null)

  // ---- 2) 空白像素：不能吸附 ----
  // 真实场景里"角落"未必空（第一版就点到了 shelf-01）。改为：把所有对象都标注一遍，
  // 从标注框反推一个确实不属于任何可见对象的像素，再去点它。
  const allObs = await capture({ camera: ortho, width: W, height: H, objectIds: assets.map(a => a.id), marked: true })
  const boxes = (allObs.labels ?? []).filter(l => l.pixelBox).map(l => l.pixelBox)
  const covered = (x, y) => boxes.some(b => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY)
  let empty = null
  for (let y = 4; y < H - 4 && !empty; y += 8) {
    for (let x = 4; x < W - 4 && !empty; x += 8) {
      if (!covered(x, y)) empty = { u: x / W, v: y / H, px: [x, y] }
    }
  }
  check('能在真实画面里找到不属于任何对象的空白像素', Boolean(empty), empty)
  const emptyHit = empty ? await pick({ camera: allObs.camera, width: W, height: H, u: empty.u, v: empty.v }) : { hit: 'skipped' }
  check('空白像素：点选返回空命中（不吸附最近物体）', emptyHit?.hit === null, emptyHit)

  // ---- 3) 透视视角：同样命中同一个对象（正交/透视一致） ----
  const perspObs = await capture({ camera: persp, width: W, height: H, objectIds: [focusId], marked: true })
  const perspCenter = centerOf(perspObs, focusId)
  check('透视视角：目标在图内且有像素框', Boolean(perspCenter), perspCenter?.box ?? null)

  const perspHit = await pick({ camera: perspObs.camera, width: W, height: H, u: perspCenter.u, v: perspCenter.v })
  check('透视视角：框中心点选 → 命中同一个对象', perspHit?.hit?.objectId === focusId, perspHit?.hit ?? null)

  // ---- 4) 移动对象后：旧图坐标不再命中它，新图坐标命中它 ----
  const moved = await cdp.eval(`__coagentDev.moveObject('${focusId}', [${cx + span * 0.6}, 0, ${cz + span * 0.6}])`)
  check('真实 core 编辑：目标已移动到新位置', moved === true, { moved })

  const staleHit = await pick({ camera: perspObs.camera, width: W, height: H, u: perspCenter.u, v: perspCenter.v })
  check('移动后：同一张图的旧坐标不再命中它（说明每次按当前场景拾取）', staleHit?.hit?.objectId !== focusId, staleHit?.hit ?? null)

  const movedObs = await capture({ camera: persp, width: W, height: H, objectIds: [focusId], marked: true })
  const movedCenter = centerOf(movedObs, focusId)
  check('移动后：重拍仍能框到目标', Boolean(movedCenter), movedCenter?.box ?? null)
  const movedHit = await pick({ camera: movedObs.camera, width: W, height: H, u: movedCenter.u, v: movedCenter.v })
  check('移动后：新图框中心点选 → 命中同一个对象', movedHit?.hit?.objectId === focusId, movedHit?.hit ?? null)

  // ---- 5) 拾取不改变用户主视口 ----
  const mainAfter = await cdp.eval('__coagent.renderDiagnostics().mainCamera')
  check(
    '拾取不改变用户主视口相机',
    JSON.stringify(mainBefore) === JSON.stringify(mainAfter),
    { before: mainBefore?.position, after: mainAfter?.position },
  )

  // ---- 6) 命中结果带真实指纹（编辑器事实，不是猜的） ----
  const assetNow = await cdp.eval(`__coagent.debugSnapshot({objectIds:['${focusId}']}).assets[0]`)
  check(
    '拾取返回的对象与编辑器快照一致（ref/transform 存在）',
    Boolean(movedHit?.hit?.objectId) && Boolean(assetNow?.ref),
    { ref: assetNow?.ref, position: assetNow?.transform?.position },
  )

  // ---- 7) 拉近确实让目标变大（camera.adjust 的 zoomFactor 语义，端到端） ----
  // 单测只能断言"距离减半"，这里验证"画面上真的变大"——这正是判定看不清的直接原因。
  const pos = (await cdp.eval(`__coagent.debugSnapshot({objectIds:['${focusId}']}).assets[0].transform.position`)) ?? [cx, 0, cz]
  const dirLen = Math.hypot(0.6, 0.5, 0.6)
  const dir = [0.6 / dirLen, 0.5 / dirLen, 0.6 / dirLen]
  const camAt = (distance, id) => ({
    schemaVersion: 1,
    id,
    projection: 'perspective',
    position: [pos[0] + dir[0] * distance, pos[1] + dir[1] * distance, pos[2] + dir[2] * distance],
    target: pos,
    up: [0, 1, 0],
    near: 0.05,
    far: distance * 6 + 50,
    aspect: 4 / 3,
    fovDeg: 45,
  })
  const farObs = await capture({ camera: camAt(span, 'cam-w10-far'), width: W, height: H, objectIds: [focusId], marked: true })
  const nearObs = await capture({ camera: camAt(span / 2, 'cam-w10-near'), width: W, height: H, objectIds: [focusId], marked: true })
  const areaOf = obs => {
    const b = (obs.labels ?? []).find(l => l.objectId === focusId)?.pixelBox
    return b ? Math.max(1, b.maxX - b.minX) * Math.max(1, b.maxY - b.minY) : 0
  }
  const farArea = areaOf(farObs)
  const nearArea = areaOf(nearObs)
  check(
    '距离减半 → 目标在画面上的面积大约翻两番（拉近有效）',
    farArea > 0 && nearArea / farArea > 2.5 && nearArea / farArea < 6.5,
    { farArea, nearArea, ratio: farArea > 0 ? Number((nearArea / farArea).toFixed(2)) : null },
  )

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
    join(ARTIFACTS, 'w10-report.json'),
    JSON.stringify({ url: URL_BASE, when: new Date().toISOString(), passed, failed, results }, null, 2),
  )
  console.log(`\n${passed}/${results.length} passed, ${failed} failed -> ${join(ARTIFACTS, 'w10-report.json')}`)
  process.exit(failed === 0 ? 0 : 1)
}
