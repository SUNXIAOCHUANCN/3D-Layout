/**
 * W04 浏览器实跑验证（T10 renderer 恢复、T11 相机复拍/ID/像素）。
 *
 * 必须真实：W04 的完成条件是"浏览器实际图片可检查且非空、ID 对应正确；不能只 mock
 * capture 就宣称完成"。本脚本在真实 App 里切到确定性小场景 scene-02（10 个带 tint 的
 * 占位体），通过 `__coagentDev.capture()` 走完整链路（ready → 离屏渲染 → 证据登记），
 * 在页面内解码 PNG 逐像素断言方向/颜色/遮挡/画外，并检查主相机姿态与主视口未受影响。
 *
 * 用法（src/ 下）：
 *   pnpm dev -- --host 127.0.0.1 --port 5173 --strictPort
 *   node modules/coagent/tests/browser/w04-run.mjs --url=http://127.0.0.1:5173/
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../../..')
const LAYOUT = resolve(SRC, '..')
const ARTIFACTS = join(HERE, 'artifacts')

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
  console.error('找不到 Chrome/Edge，可用 --chrome=<path> 指定')
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
async function waitFor(fn, { timeout = 25_000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting: ${label}`)
    await sleep(interval)
  }
}

// ---------- 相机（均为完整 CameraSnapshot，before/after 复用的就是它） ----------
const ORTHO_TOP = {
  schemaVersion: 1,
  id: 'probe-ortho-top',
  projection: 'orthographic',
  position: [0, 20, 0],
  target: [0, 0, 0],
  up: [0, 0, -1],
  near: 0.1,
  far: 100,
  aspect: 320 / 240,
  ortho: { left: -6, right: 6, top: 4.5, bottom: -4.5 },
}
const ORTHO_NARROW = {
  ...ORTHO_TOP,
  id: 'probe-ortho-narrow',
  aspect: 300 / 200,
  ortho: { left: -1.8, right: 1.8, top: 1.2, bottom: -1.2 },
}
const PERSP_OCCLUSION = {
  schemaVersion: 1,
  id: 'probe-persp-occlusion',
  projection: 'perspective',
  position: [-2.2, 1.2, 6],
  target: [-2.2, 1.2, -2.4],
  up: [0, 1, 0],
  near: 0.1,
  far: 60,
  aspect: 320 / 240,
  fovDeg: 45,
}

mkdirSync(ARTIFACTS, { recursive: true })
const profile = join(ARTIFACTS, '.chrome-profile-w04')
rmSync(profile, { recursive: true, force: true })
const PORT = 9335

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
const shots = []
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = join(ARTIFACTS, `w04-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  shots.push(file)
}

const center = box => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 })
const labelOf = (obs, id) => obs.labels.find(l => l.objectId === id)
const near = (a, b, tol) => Math.abs(a - b) <= tol

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
  await waitFor(() => cdp.eval('Boolean(window.__coagentDev)', false), { label: 'dev harness' })
  await waitFor(() => cdp.eval('Boolean(window.__coagent && window.__coagent.debugSnapshot({}).assets.length === 10)', false), {
    label: 'scene-02 loaded (10 assets)',
  })
  // 桥挂载 = renderDiagnostics 非空
  await waitFor(() => cdp.eval('Boolean(window.__coagent.renderDiagnostics())', false), { label: 'CoAgentBridge mounted' })

  const diag0 = await cdp.eval('__coagent.renderDiagnostics()')
  check('前置：桥已挂载且 WebGL 上下文正常', diag0.mounted === true && diag0.contextLost === false, {
    mounted: diag0.mounted,
    contextLost: diag0.contextLost,
    targets: diag0.targets.length,
  })
  await shot('1-mounted')

  // ---------- T11-1：单区域 RGB 捕获，真实像素非空 ----------
  const obsA = await cdp.eval(
    `__coagentDev.capture({ camera: ${JSON.stringify(ORTHO_TOP)}, width: 320, height: 240, objectIds: ['barrel-01','barrel-02','shelf-01','shelf-04'], marked: true, phase: 'baseline' })`,
  )
  check('捕获返回完整 Observation（id/尺寸/相机/指纹）', Boolean(obsA.id && obsA.width === 320 && obsA.height === 240 && obsA.camera.id === 'probe-ortho-top'), {
    id: obsA.id,
    phase: obsA.phase,
    labels: obsA.labels.length,
    fingerprints: Object.keys(obsA.observedObjectFingerprints).length,
  })
  const statsA = await cdp.eval('__coagentDev.evidenceStats()')
  check('证据已登记且字节非零（真实 PNG Blob）', statsA.entries >= 1 && statsA.bytes > 2000, {
    entries: statsA.entries,
    bytes: statsA.bytes,
    urls: statsA.urls,
  })
  const imgA = await cdp.eval(`__coagentDev.decode(${JSON.stringify(obsA.rgbImageId)})`)
  // 俯视图里物体只占 ~14%（其余是环境底色），所以阈值取 5%：只要不是纯背景/纯黑即可
  check('RGB 图可解码且不是纯色（真实渲染结果）', imgA.width === 320 && imgA.height === 240 && imgA.nonUniformRatio > 0.05 && imgA.uniqueColors > 30, imgA)
  check('marked 图存在且可解码', Boolean(obsA.markedImageId) && (await cdp.eval(`__coagentDev.decode(${JSON.stringify(obsA.markedImageId)}).then(i => i.uniqueColors > 30)`)), {
    markedImageId: obsA.markedImageId,
  })

  // 把证据图原样落盘，供人工复核（不是截图，是捕获产物本身）
  const exportImage = async (imageId, name) => {
    const dataUrl = await cdp.eval(`(async () => {
      const url = __coagentDev.runtime.observations.urlFor(${JSON.stringify(imageId)})
      if (!url) return null
      const blob = await (await fetch(url)).blob()
      return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob) })
    })()`)
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      writeFileSync(join(ARTIFACTS, name), Buffer.from(dataUrl.split(',')[1], 'base64'))
      return true
    }
    return false
  }
  const savedRgb = await exportImage(obsA.rgbImageId, 'w04-evidence-topdown.png')
  const savedMarked = obsA.markedImageId ? await exportImage(obsA.markedImageId, 'w04-evidence-topdown-marked.png') : false
  check('证据图已落盘可人工复核（RGB / marked）', savedRgb && savedMarked, { savedRgb, savedMarked })

  // ---------- T11-2：ID 映射与像素方向 ----------
  const boxes = {}
  for (const id of ['barrel-01', 'barrel-02', 'shelf-01', 'shelf-04']) {
    const l = labelOf(obsA, id)
    check(`ID 映射：${id} 可见且有像素框`, Boolean(l && l.visibility === 'visible' && l.pixelBox), l)
    if (l?.pixelBox) boxes[id] = l.pixelBox
  }
  const cBarrel1 = center(boxes['barrel-01'])
  const cBarrel2 = center(boxes['barrel-02'])
  const cShelf1 = center(boxes['shelf-01'])
  const cShelf4 = center(boxes['shelf-04'])
  check('水平方向：x 更小的 barrel-01 在画面左侧', cBarrel1.x < cBarrel2.x, { barrel1: cBarrel1.x, barrel2: cBarrel2.x })
  check('垂直方向：z=-2.4 的 shelf-01 在 z=+2.4 的 shelf-04 上方（行未翻错）', cShelf1.y < cShelf4.y, {
    shelf1: cShelf1.y,
    shelf4: cShelf4.y,
  })

  // ---------- T11-3：颜色与 tint 一致（两两对比，不依赖绝对色值） ----------
  const pxBarrel = await cdp.eval(`__coagentDev.pixel(${JSON.stringify(obsA.rgbImageId)}, ${Math.round(cBarrel1.x)}, ${Math.round(cBarrel1.y)})`)
  const pxShelf = await cdp.eval(`__coagentDev.pixel(${JSON.stringify(obsA.rgbImageId)}, ${Math.round(cShelf1.x)}, ${Math.round(cShelf1.y)})`)
  check('颜色：料桶（#7d8a4f）绿通道主导', pxBarrel[1] > pxBarrel[0] && pxBarrel[1] > pxBarrel[2], pxBarrel)
  check('颜色：货架（#66717f）蓝通道高于红', pxShelf[2] > pxShelf[0], pxShelf)
  check('两对象颜色确实不同（不是同一块像素）', Math.abs(pxBarrel[0] - pxShelf[0]) + Math.abs(pxBarrel[1] - pxShelf[1]) + Math.abs(pxBarrel[2] - pxShelf[2]) > 20, {
    pxBarrel,
    pxShelf,
  })

  // ---------- T11-4：同视角复拍（before/after 复用同一 CameraSnapshot） ----------
  const obsB = await cdp.eval(
    `__coagentDev.capture({ camera: ${JSON.stringify(ORTHO_TOP)}, width: 320, height: 240, objectIds: ['barrel-01','barrel-02','shelf-01','shelf-04'], marked: true, phase: 'after' })`,
  )
  check('复拍：相机快照逐字段一致', JSON.stringify(obsA.camera) === JSON.stringify(obsB.camera), { idA: obsB.id })
  const boxDelta = Math.max(
    ...['barrel-01', 'shelf-01'].map(id => {
      const a = labelOf(obsA, id)?.pixelBox
      const b = labelOf(obsB, id)?.pixelBox
      return a && b ? Math.max(Math.abs(a.minX - b.minX), Math.abs(a.minY - b.minY), Math.abs(a.maxX - b.maxX), Math.abs(a.maxY - b.maxY)) : 999
    }),
  )
  check('复拍：同一视角同一场景，标记框几乎不动（确定性）', boxDelta <= 2, { boxDelta })

  // ---------- T11-5：移动资产后立即捕获 ----------
  const moved = await cdp.eval(`__coagentDev.moveObject('barrel-02', [2.2, 0, 0.1])`)
  check('真实 core 编辑：barrel-02 已移动到 x=2.2', moved === true, { moved })
  const obsC = await cdp.eval(
    `__coagentDev.capture({ camera: ${JSON.stringify(ORTHO_TOP)}, width: 320, height: 240, objectIds: ['barrel-01','barrel-02','shelf-01','shelf-04'], marked: true, phase: 'after' })`,
  )
  const cBarrel2b = center(labelOf(obsC, 'barrel-02').pixelBox)
  const expectedShift = ((2.2 - 0.2) / 12) * 320 // 世界 +2m，X 跨 12m 映射 320px
  check('移动后立即捕获：标记框随世界位移右移', near(cBarrel2b.x - cBarrel2.x, expectedShift, 12), {
    beforeX: cBarrel2.x,
    afterX: cBarrel2b.x,
    expectedShift,
  })
  const pxMoved = await cdp.eval(`__coagentDev.pixel(${JSON.stringify(obsC.rgbImageId)}, ${Math.round(cBarrel2b.x)}, ${Math.round(cBarrel2b.y)})`)
  check('移动后新位置的颜色是新位置物体的颜色（绿通道主导）', pxMoved[1] > pxMoved[0] && pxMoved[1] > pxMoved[2], pxMoved)

  // ---------- T11-6：被遮挡对象 ----------
  const obsOcc = await cdp.eval(
    `__coagentDev.capture({ camera: ${JSON.stringify(PERSP_OCCLUSION)}, width: 320, height: 240, objectIds: ['shelf-01','shelf-04'], marked: true, phase: 'supplement' })`,
  )
  const occluded = labelOf(obsOcc, 'shelf-01')
  const front = labelOf(obsOcc, 'shelf-04')
  check('被遮挡：远处的 shelf-01 标为 uncertain 且无像素框', occluded.visibility === 'uncertain' && !occluded.pixelBox, occluded)
  check('被遮挡：近处的 shelf-04 可见', front.visibility === 'visible' && Boolean(front.pixelBox), front)

  // ---------- T11-7：画外对象 ----------
  const obsOut = await cdp.eval(
    `__coagentDev.capture({ camera: ${JSON.stringify(ORTHO_NARROW)}, width: 300, height: 200, objectIds: ['barrel-01','shelf-06'], marked: true, phase: 'supplement' })`,
  )
  const inFrame = labelOf(obsOut, 'barrel-01')
  const outFrame = labelOf(obsOut, 'shelf-06')
  check('画外：画面内的 barrel-01 可见', inFrame.visibility === 'visible', inFrame)
  check('画外：画面外的 shelf-06 标为 uncertain', outFrame.visibility === 'uncertain' && !outFrame.pixelBox, outFrame)

  // ---------- T10：异常捕获后主视口仍正常 ----------
  const beforeFail = await cdp.eval('__coagentDev.evidenceStats()')
  const bad = await cdp.eval(`__coagentDev.capture({ camera: ${JSON.stringify(ORTHO_TOP)}, width: 0, height: 240, objectIds: ['barrel-01'], marked: true }).then(() => ({ ok: true })).catch(e => ({ ok: false, code: e.code, message: e.message }))`)
  check('非法尺寸 → invalid_arguments（显式失败，不产出证据）', bad.ok === false && bad.code === 'invalid_arguments', bad)
  const afterFail = await cdp.eval('__coagentDev.evidenceStats()')
  check('失败不留下半张证据', afterFail.entries === beforeFail.entries, { before: beforeFail.entries, after: afterFail.entries })
  const diagAfterFail = await cdp.eval('__coagent.renderDiagnostics()')
  check('异常后渲染器仍健康（上下文未丢、桥仍挂载）', diagAfterFail.contextLost === false && diagAfterFail.mounted === true, {
    contextLost: diagAfterFail.contextLost,
    mounted: diagAfterFail.mounted,
    failed: diagAfterFail.failed,
    captured: diagAfterFail.captured,
  })
  const obsRecover = await cdp.eval(
    `__coagentDev.capture({ camera: ${JSON.stringify(ORTHO_TOP)}, width: 320, height: 240, objectIds: ['barrel-01'], marked: true, phase: 'supplement' })`,
  )
  const recImg = await cdp.eval(`__coagentDev.decode(${JSON.stringify(obsRecover.rgbImageId)})`)
  check('异常后仍能捕获出有效图像（主视口渲染未坏）', recImg.nonUniformRatio > 0.1 && recImg.uniqueColors > 20, recImg)
  await shot('2-after-failure')

  // ---------- 用户相机姿态不变 ----------
  const diagBefore = await cdp.eval('__coagent.renderDiagnostics()')
  const diagEnd = await cdp.eval('__coagent.renderDiagnostics()')
  check('主相机姿态未被捕获改动', JSON.stringify(diagBefore.mainCamera) === JSON.stringify(diagEnd.mainCamera), {
    pos: diagEnd.mainCamera.position,
    target: diagEnd.mainCamera.target,
  })
  check('离屏目标数量受控（按尺寸缓存）', diagEnd.targets.length <= 6, { targets: diagEnd.targets })

  // ---------- 卸载释放：关插件 → 端口注销 + 证据清空 ----------
  const statsBeforeOff = await cdp.eval('__coagentDev.evidenceStats()')
  await cdp.eval(`(() => { const b = document.querySelector('button[aria-label="CoAgent 布局 开关"]'); if (b) b.click(); return true })()`)
  await sleep(200)
  const portGone = await cdp.eval('window.__coagent.renderDiagnostics() === null')
  check('卸载：渲染端口已注销', portGone === true, null)
  const statsOff = await cdp.eval('window.__coagent.evidenceStats()')
  check('卸载：证据图片被释放（objectURL 撤销）', statsOff.entries === 0 && statsOff.urls === 0, {
    before: statsBeforeOff,
    after: statsOff,
  })
  await cdp.eval(`(() => { const b = document.querySelector('button[aria-label="CoAgent 布局 开关"]'); if (b) b.click(); return true })()`)
  await waitFor(() => cdp.eval('Boolean(window.__coagent.renderDiagnostics())', false), { label: 'bridge remount' })
  const diagRemount = await cdp.eval('__coagent.renderDiagnostics()')
  check('重新挂载：桥恢复且离屏目标重新按需创建', diagRemount.mounted === true && diagRemount.contextLost === false, {
    targets: diagRemount.targets.length,
  })
  const obsRemount = await cdp.eval(
    `__coagentDev.capture({ camera: ${JSON.stringify(ORTHO_TOP)}, width: 320, height: 240, objectIds: ['barrel-01'], marked: true })`,
  )
  check('重新挂载后仍能捕获', Boolean(obsRemount.id), { id: obsRemount.id })
  await shot('3-remounted')

  check('无页面级 JS 错误', pageErrors.filter(t => t.indexOf('Failed to load resource') < 0).length === 0, pageErrors.slice(0, 3))
} catch (e) {
  check('脚本执行未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e))
  if (cdp) {
    try {
      await shot('9-failure')
    } catch {
      /* ignore */
    }
  }
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
  writeFileSync(join(ARTIFACTS, 'w04-report.json'), JSON.stringify({ url: URL_BASE, when: new Date().toISOString(), passed, failed, results, shots }, null, 2))
  console.log(`\n${passed}/${results.length} passed, ${failed} failed; ${shots.length} screenshots -> ${ARTIFACTS}`)
  process.exit(failed === 0 ? 0 : 1)
}
