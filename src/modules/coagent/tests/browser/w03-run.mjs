/**
 * W03 浏览器实跑验证（T08 事务/undo/redo、T09 取消、T13 旧入口互斥、T16 生命周期）。
 *
 * 为什么不是 mock：W03 的完成条件是"真实 core 上事务和互斥通过"。本脚本用 CDP
 * 驱动真实 Chrome 打开真实 App（vite dev），通过面板按钮发起一轮 CoAgent run，
 * 断言真实 core 的 undo 单元、真实 DOM 的互斥锁、以及插件反复启停后的订阅数。
 *
 * 用法（在 src/ 下）：
 *   pnpm dev -- --port 5199 --strictPort
 *   node modules/coagent/tests/browser/w03-run.mjs --url=http://127.0.0.1:5199/
 *
 * 注意：run 提交会经宿主保存通路写回 scenes/<id>/scene.json（真实行为）。
 * 脚本自行备份/还原该文件，跑完场景字节与运行前一致。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const URL_BASE = args.get('url') ?? 'http://127.0.0.1:5199/'
const CHROME =
  args.get('chrome') ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => existsSync(p))
if (!CHROME) {
  console.error('找不到 Chrome/Edge，可用 --chrome=<path> 指定')
  process.exit(2)
}

/**
 * 备份/还原**实际加载的那个场景**。
 *
 * 旧实现写死 scene-01，但本脚本导航时不带 ?scene=，应用会加载默认的
 * alpinewoodlanddemo —— 于是每跑一次就把真实的 alpinewoodlanddemo/scene.json
 * 永久改掉（资产被移动、meta.version 递增）。实测踩到过，这里改正。
 */
const SCENE_ID = 'alpinewoodlanddemo'
const SCENE_FILE = join(LAYOUT, 'scenes', SCENE_ID, 'scene.json')
const sha = buf => createHash('sha256').update(buf).digest('hex')
const sceneBackup = existsSync(SCENE_FILE) ? readFileSync(SCENE_FILE) : null

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail })
  const tail = detail === undefined || detail === null ? '' : `  <- ${JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${tail}`)
}

// ---------- 最小 CDP 客户端（Node 22 自带 WebSocket，无第三方依赖） ----------

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : res(msg.result)
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 30_000)
    })
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
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

/**
 * 旧 Agent 面板与 CoAgent 面板共用 .agent-panel 类，选择器必须收窄到
 * "插件名包含 CoAgent 的那个 section"，否则会点到 AI 编辑的输入框。
 */
const SEC = `(() => {
  const list = Array.from(document.querySelectorAll('.plugin-section'))
  const sec = list.find(s => {
    const n = s.querySelector('.plugin-name')
    return n && n.textContent && n.textContent.indexOf('CoAgent') >= 0
  })
  return sec || null
})()`

async function waitFor(fn, { timeout = 20_000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting: ${label}`)
    await sleep(interval)
  }
}

// ---------- 启动浏览器与页面 ----------

mkdirSync(ARTIFACTS, { recursive: true })
const profile = join(ARTIFACTS, '.chrome-profile')
rmSync(profile, { recursive: true, force: true })
const PORT = 9333

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

let cdp = null
const shots = []
let shotSeq = 0
const shot = async (page, name) => {
  // headless 的 captureScreenshot 会复用上一帧 surface（多次截图字节相同）。
  // 交替改 1px 视口宽度强制重新分配 surface，确保截到当前状态。
  shotSeq++
  const width = 1584 + (shotSeq % 2)
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 905, deviceScaleFactor: 1, mobile: false })
  await page
    .eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
    .catch(() => undefined)
  await sleep(150)
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = join(ARTIFACTS, `w03-${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  shots.push(file)
}

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
  await cdp.send('Log.enable')
  // 让新标签成为前台：headless 下后台标签不产帧，截图会拿到上一帧缓存
  await cdp.send('Page.bringToFront')

  const pageErrors = []
  cdp.ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      pageErrors.push(msg.params.entry.text.slice(0, 300))
    }
  })

  await cdp.send('Page.navigate', { url: URL_BASE })
  await waitFor(() => cdp.eval('document.readyState === "complete"', { awaitPromise: false }), { label: 'page load' })
  await waitFor(() => cdp.eval('Boolean(window.__coagentDev)', { awaitPromise: false }), { label: 'dev harness' })
  await waitFor(() => cdp.eval(`Boolean((${SEC}) && (${SEC}).querySelector('textarea'))`, { awaitPromise: false }), {
    label: 'coagent panel',
  })
  await waitFor(() => cdp.eval('Boolean(window.__coagent && window.__coagent.debugSnapshot({}).assets.length)', { awaitPromise: false }), {
    label: 'scene assets',
  })

  const sceneInfo = await cdp.eval('({ sceneId: window.__coagent.debugSnapshot({}).sceneId, assets: window.__coagent.debugSnapshot({}).assets.length })')
  check('precondition: real scene loaded + dev harness ready', sceneInfo.assets > 0, sceneInfo)
  await shot(cdp, '1-idle')

  // ---------- 准备：两区演示计划 + 一条人工历史 ----------
  const plan = await cdp.eval('__coagentDev.arm({ delayMs: 300 })')
  check(
    'partition plan: 2 regions, each >=1 object, has globalReadonly, >=2 steps',
    plan.partition.regions.length === 2 && plan.partition.regions.every(r => r.objectIds.length >= 1) && plan.steps.length >= 2,
    {
      regions: plan.partition.regions.map(r => ({ id: r.id, objects: r.objectIds })),
      readonly: plan.partition.globalReadonlyObjectIds,
      steps: plan.steps.length,
    },
  )
  await cdp.eval('__coagentDev.humanTouch()')
  const historyBefore = await cdp.eval('__coagentDev.historyCount()')
  check('precondition: 1 human history unit', historyBefore === 1, { historyBefore })
  // 分区注入后面板必须立刻可用（订阅同步生效；否则会出现"注入了但按钮还是灰的"）
  const partitionSync = await cdp.eval(`(() => {
    const sec = ${SEC}
    const dom = sec ? sec.querySelector('.agent-panel')?.getAttribute('data-partition') : null
    const rt = window.__coagent.partition()
    return { dom, runtime: rt ? String(rt.partitionVersion) : 'none' }
  })()`)
  check('partition injected into runtime and panel synced', partitionSync.dom === partitionSync.runtime && partitionSync.dom !== 'none', partitionSync)
  const assetsBefore = await cdp.eval('__coagentDev.assets()')

  // ---------- 通过面板按钮发起一轮 run（真实 UI 路径） ----------
  await cdp.eval(`(() => {
    const sec = ${SEC}
    const ta = sec.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'W03 browser check: two regions known transform')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(80)
  const clicked = await cdp.eval(`(() => {
    const sec = ${SEC}
    const btn = sec.querySelector('.agent-mini-btn.send')
    const hint = sec ? sec.innerText.split('\\n').filter(l => l.indexOf('不可用') >= 0).join(' | ') : ''
    if (!btn || btn.disabled) return { ok: false, disabled: btn ? btn.disabled : null, hint }
    btn.click()
    return { ok: true }
  })()`)
  check('panel Start button clickable', clicked.ok === true, clicked)

  // 运行中采样互斥状态（T13）：先等到 executing 再采样，避免采样循环跑过整个 run
  await waitFor(() => cdp.eval('window.__coagent.phase() === "executing"', { awaitPromise: false }), {
    label: 'run enters executing',
    timeout: 8000,
  })
  const running = await cdp.eval(`(() => {
    const sec = ${SEC}
    const select = document.querySelector('select')
    const status = sec ? sec.querySelector('.agent-status') : null
    return {
      phase: window.__coagent.phase(),
      sceneSwitchDisabled: select ? select.disabled : null,
      status: status ? status.textContent : '',
      history: __coagentDev.historyCount(),
    }
  })()`)
  check('while running: scene switch locked (select disabled)', running.sceneSwitchDisabled === true, running)
  check('while running: panel shows executing phase', running.status.indexOf('执行中') >= 0, running.status)

  // W06.5：进度投影（百分比 + 阶段/当前动作 + 可折叠执行明细）
  const progressUi = await cdp.eval(`(() => {
    const sec = ${SEC}
    const text = sec ? sec.innerText : ''
    return {
      hasProgress: /进度\\s*\\d+%/.test(text),
      hasStep: text.indexOf('阶段：') >= 0 && text.indexOf('当前：') >= 0,
      details: sec ? sec.querySelectorAll('details').length : 0,
      eventRows: sec ? sec.querySelectorAll('details div').length : 0,
    }
  })()`)
  check('while running: progress shown (percent + step + current)', progressUi.hasProgress && progressUi.hasStep, progressUi)
  check('while running: collapsible event log has entries', progressUi.details >= 1 && progressUi.eventRows >= 1, progressUi)

  // 运行中按 Ctrl+Z：快捷键/历史互斥必须挡住
  await cdp.eval(`(() => {
    const ev = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    return true
  })()`)
  await sleep(150)
  const historyDuringRun = await cdp.eval('__coagentDev.historyCount()')
  check('while running: Ctrl+Z blocked', historyDuringRun === 1, { historyDuringRun, phase: await cdp.eval('window.__coagent.phase()') })
  await shot(cdp, '2-running')

  const demo = await cdp.eval('__coagentDev.awaitPending()')
  check('run settles as completed', Boolean(demo && demo.settled && demo.outcomeKind === 'completed'), demo ? { outcomeKind: demo.outcomeKind, phasesSeen: demo.phasesSeen } : null)
  const finalUi = await cdp.eval(`(() => { const sec = ${SEC}; const t = sec ? sec.innerText : ''; return { p100: /进度\\s*100%/.test(t), text: t.slice(0, 200) } })()`)
  check('完成后面板显示 100% 进度与结果', finalUi.p100, finalUi.p100 ? null : finalUi.text)
  check('one undo unit added for the whole run', Boolean(demo && demo.historyAdded === 1), demo ? { historyAdded: demo.historyAdded, units: demo.units.map(u => ({ label: u.label, source: u.source, ops: u.ops })) } : null)
  const lastUnit = demo ? demo.units[demo.units.length - 1] : null
  check('unit source=agent and ops=steps', Boolean(lastUnit && lastUnit.source === 'agent' && lastUnit.ops === plan.steps.length), lastUnit)
  for (const step of plan.steps) {
    const before = assetsBefore[step.objectId].position
    const after = demo.after[step.objectId].position
    check(`asset ${step.objectId} moved`, after.every((v, i) => Math.abs(v - step.transform.position[i]) < 1e-6), {
      before,
      after,
      expected: step.transform.position,
    })
  }
  check('no error_locked in phase trace', demo.phasesSeen.includes('completed') && !demo.phasesSeen.includes('error_locked'), demo.phasesSeen)
  await shot(cdp, '3-completed')

  // ---------- T08：undo 恢复初始资产 / redo 重现成功结果 ----------
  const journalBeforeUndo = await cdp.eval('({ units: __coagentDev.units().map(u => ({ txId: u.txId, source: u.source, ops: u.ops })), redo: __coagentDev.redoUnits().length })')
  await cdp.eval('__coagentDev.undo()')
  const journalAfterUndo = await cdp.eval('({ units: __coagentDev.units().map(u => ({ txId: u.txId, source: u.source, ops: u.ops })), redo: __coagentDev.redoUnits().length })')
  const afterUndo = await cdp.eval('__coagentDev.assets()')
  const undoMismatch = Object.keys(assetsBefore).filter(id => {
    const a = afterUndo[id] ? afterUndo[id].position : []
    const b = assetsBefore[id].position
    if (a.length !== b.length) return true
    if (!a.every((v, i) => Math.abs(v - b[i]) < 1e-6)) return true
    const ra = afterUndo[id].rotationDeg
    const rb = assetsBefore[id].rotationDeg
    return !(ra && rb && ra.every((v, i) => Math.abs(v - rb[i]) < 1e-6))
  })
  check('undo restores every asset transform', undoMismatch.length === 0, {
    ids: Object.keys(assetsBefore).length,
    mismatches: undoMismatch.slice(0, 5),
    sample: undoMismatch[0] ? { before: assetsBefore[undoMismatch[0]], after: afterUndo[undoMismatch[0]] } : null,
    journalBeforeUndo,
    journalAfterUndo,
  })

  await cdp.eval('__coagentDev.redo()')
  const afterRedo = await cdp.eval('__coagentDev.assets()')
  const redoOk = plan.steps.every(step => {
    const a = afterRedo[step.objectId] ? afterRedo[step.objectId].position : []
    return a.every((v, i) => Math.abs(v - step.transform.position[i]) < 1e-6)
  })
  check('redo replays the committed result', redoOk, null)

  // ---------- T09：取消回滚且不留历史 ----------
  const historyBeforeCancel = await cdp.eval('__coagentDev.historyCount()')
  const assetsBeforeCancel = await cdp.eval('__coagentDev.assets()')
  await cdp.eval('__coagentDev.startSlow(1200)', { awaitPromise: false })
  await waitFor(() => cdp.eval('window.__coagent.phase() === "executing"', { awaitPromise: false }), {
    label: 'cancel case running',
    timeout: 8000,
  })
  await sleep(250)
  await cdp.eval(`(() => { const sec = ${SEC}; const b = sec.querySelector('.agent-mini-btn.stop'); if (b) b.click(); return true })()`)
  const cancelRes = await cdp.eval('__coagentDev.awaitPending()')
  check('cancel settles as cancelled', Boolean(cancelRes && cancelRes.settled && cancelRes.outcomeKind === 'cancelled'), cancelRes ? { outcomeKind: cancelRes.outcomeKind, phasesSeen: cancelRes.phasesSeen } : null)
  const historyAfterCancel = await cdp.eval('__coagentDev.historyCount()')
  check('cancel adds no history unit', historyAfterCancel === historyBeforeCancel, { before: historyBeforeCancel, after: historyAfterCancel })
  const afterCancel = await cdp.eval('__coagentDev.assets()')
  const cancelRestored = Object.keys(assetsBeforeCancel).every(id => {
    const a = afterCancel[id] ? afterCancel[id].position : []
    const b = assetsBeforeCancel[id].position
    return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
  })
  check('cancel restores asset set and transforms', cancelRestored, null)
  await shot(cdp, '4-cancelled')

  // ---------- T16：插件反复启停不增长订阅 ----------
  const toggle = () =>
    cdp.eval(`(() => { const b = document.querySelector('button[aria-label="CoAgent 布局 开关"]'); if (b) b.click(); return Boolean(b) })()`)
  // 基线：hook 1 个 + dev harness 1 个 = 2；关键是"反复启停后不增长"
  const listenersBaseline = await cdp.eval('__coagentDev.phaseListeners()')
  const listeners = []
  for (let i = 0; i < 3; i++) {
    const found = await toggle()
    check(`toggle ${i + 1}: plugin switch found`, found === true, null)
    await sleep(150)
    const offPhase = await cdp.eval('window.__coagent.phase()')
    const harnessGone = !(await cdp.eval('Boolean(window.__coagentDev)', { awaitPromise: false }))
    check(`toggle ${i + 1}: phase disabled + harness uninstalled`, offPhase === 'disabled' && harnessGone, { offPhase, harnessGone })
    await toggle()
    await waitFor(() => cdp.eval('Boolean(window.__coagentDev)', { awaitPromise: false }), { label: 'harness remount' })
    listeners.push(await cdp.eval('__coagentDev.phaseListeners()'))
  }
  check('phase listener count does not grow across toggles', listeners.every(n => n === listenersBaseline), { listenersBaseline, listeners })
  const realErrors = pageErrors.filter(t => t.indexOf('Failed to load resource') < 0)
  check('no page-level JS errors', realErrors.length === 0, realErrors.slice(0, 5))
  check('resource 404 count (informational)', true, { count: pageErrors.length - realErrors.length })
  await shot(cdp, '5-toggled')
} catch (e) {
  check('script completed without exception', false, String(e && e.stack ? e.stack.split('\n')[0] : e))
  if (cdp) {
    try {
      await shot(cdp, '9-failure')
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

  // 还原被真实保存通路改写的场景文件
  if (sceneBackup) {
    writeFileSync(SCENE_FILE, sceneBackup)
    const restored = sha(readFileSync(SCENE_FILE)) === sha(sceneBackup)
    console.log(`scene file restored: ${restored ? 'OK' : 'FAILED'}`)
  }

  const passed = results.filter(r => r.ok).length
  const failed = results.length - passed
  const report = { url: URL_BASE, when: new Date().toISOString(), passed, failed, results, shots }
  writeFileSync(join(ARTIFACTS, 'w03-report.json'), JSON.stringify(report, null, 2))
  console.log(`\n${passed}/${results.length} passed, ${failed} failed; ${shots.length} screenshots -> ${ARTIFACTS}`)
  process.exit(failed === 0 ? 0 : 1)
}
