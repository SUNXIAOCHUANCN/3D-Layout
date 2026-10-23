/**
 * W06 / T14 真实模型验收驱动（2026-10-22）。
 *
 * 与 w03/w04/w08 的区别：那三个用 `--headless=new` 全自动；本脚本要**真实厂商凭据**，
 * 而按设计密钥只存浏览器 localStorage、不进聊天也不进仓库。所以这里用
 * **可见的 Chrome + 独立 profile**：脚本把 baseURL/协议/模型名预置好，只把 API Key
 * 留给用户在设置弹窗里手填，填完脚本再接管跑完 T14 全流程。
 *
 * 用法（在 src/ 下，需先 `pnpm dev -- --port 5173`）：
 *   node modules/coagent/tests/browser/w06-t14.mjs setup       # 起窗口 + 预置设置 + 打开设置弹窗
 *   node modules/coagent/tests/browser/w06-t14.mjs status      # 确认模型已配置（脱敏，不读 key）
 *   node modules/coagent/tests/browser/w06-t14.mjs preprocess  # T14 第 3 步：鸟瞰 VLM 分区
 *   node modules/coagent/tests/browser/w06-t14.mjs run         # T14 第 5 步：真实 planner→executor→judge
 *   node modules/coagent/tests/browser/w06-t14.mjs shot --name=x
 *   node modules/coagent/tests/browser/w06-t14.mjs close       # 关窗口
 *
 * 说明：
 * - 走的是**真实** workflow（`createWorkflow()`），不调 `__coagentDev.arm()`（那会换成假 workflow）；
 * - 只经 `runtime.*` 公开面驱动，不碰内部 store；
 * - 事件的 payload 由 recorder 脱敏（apiKey/authorization/token 等键替换为 [已过滤]）；
 * - 本脚本**从不读取** localStorage 里的 apiKey，也不把它写进任何输出。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../../..')
const LAYOUT = resolve(SRC, '..')
const ARTIFACTS = join(HERE, 'artifacts')
const PROFILE = join(ARTIFACTS, '.t14-profile')
const APP_URL = 'http://localhost:5173/?scene=scene-02'

const args = new Map(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? 'true']
  }),
)
/** 独立端口：默认 9333 被 w03/w04/w08 浏览器套件占用，别互相串场 */
const PORT = Number(args.get('port') ?? 9334)
const CMD = process.argv[2] ?? 'status'
const REQUEST = args.get('text') ?? '把北区的两个货架挪得整齐一点，别撞在一起'

const CHROME =
  args.get('chrome') ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].find(p => existsSync(p))
if (!CHROME) {
  console.error('找不到 Chrome/Edge，可用 --chrome=<path> 指定')
  process.exit(2)
}

// 预置项（不动 apiKey，保留用户已填的）
const PRESET = {
  provider: 'deepseek',
  protocol: 'openai-chat',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  sendImages: true,
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- 最小 CDP 客户端（Node 22 自带 WebSocket） ----------

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
  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, timeoutMs)
    })
  }
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })
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

async function waitFor(fn, { timeout = 30_000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting: ${label}`)
    await sleep(interval)
  }
}

/** 连到已开的窗口（setup 之后的所有命令都走这里，不再另起浏览器） */
async function connect() {
  let target = null
  await waitFor(
    async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        target =
          list.find(t => t.type === 'page' && /localhost:5173|127\.0\.0\.1:5173/.test(t.url)) ??
          list.find(t => t.type === 'page')
        return target
      } catch {
        return null
      }
    },
    { timeout: 5_000, label: 'CDP /json/list（窗口没开就跑 setup）' },
  )
  const page = await Cdp.connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  return page
}

const hasRuntime = `Boolean(window.__coagentDev && window.__coagentDev.runtime)`

async function waitApp(page, timeout = 60_000) {
  await waitFor(() => page.eval(hasRuntime), { timeout, label: '__coagentDev（DEV 构建才挂）' })
  // 渲染桥（Canvas 里的 R3F 组件）比 runtime 晚挂：R3F 要先完成一次尺寸测量，
  // canvas 才会从默认 300x150 变成容器尺寸，children 里的桥组件才真正挂上。
  await waitFor(() => page.eval(`Boolean(window.__coagentDev.runtime.renderDiagnostics())`), {
    timeout,
    label: '渲染桥挂载',
  })
  // 尺寸到位后再等一帧，确保矩阵/相机已就绪
  await sleep(400)
}

/** 页面截图（headful 直接抓 surface）；--out=<绝对路径> 可指定输出位置 */
async function shot(page, name) {
  mkdirSync(ARTIFACTS, { recursive: true })
  await sleep(250)
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const out = args.get('out')
  const file = out
    ? out.endsWith('.png')
      ? out
      : join(out, `w06-t14-${name}.png`)
    : join(ARTIFACTS, `w06-t14-${name}.png`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/** 读页面里的结果容器（fire-and-forget + 轮询，避免长 CDP 调用超时） */
async function awaitT14(page, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const st = await page.eval(`window.__t14 ?? null`)
    if (st && st.done) return st
    if (Date.now() - t0 > timeoutMs) {
      const phase = await page.eval(`window.__coagentDev.runtime.phase()`)
      return { done: false, timedOut: true, phase, events: st?.events ?? [] }
    }
    await sleep(1000)
    void label
  }
}

const summarizeEvents = evs =>
  evs.map(e => ({
    seq: e.eventSeq,
    type: e.type,
    runId: e.runId,
    regionId: e.regionId,
    taskId: e.taskId,
    payload: e.payload,
  }))

// ---------- 命令 ----------

async function cmdSetup() {
  mkdirSync(ARTIFACTS, { recursive: true })
  // 独立 profile：不碰你日常 Chrome 的设置与登录态
  rmSync(PROFILE, { recursive: true, force: true })

  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-features=Translate',
      '--window-size=1600,1000',
      '--window-position=80,40',
      APP_URL,
    ],
    { stdio: 'ignore', detached: true },
  )
  child.unref()

  const page = await connect()
  await waitApp(page, 90_000)

  // 预置设置（保留已有 apiKey，绝不覆盖）
  const preset = JSON.stringify(PRESET)
  await page.eval(`(() => {
    const K = 'agent-llm-settings-v1'
    const cur = (() => { try { return JSON.parse(localStorage.getItem(K) || '{}') || {} } catch { return {} } })()
    localStorage.setItem(K, JSON.stringify({ ...cur, ...${preset} }))
    return true
  })()`)

  // 重载让 store 从 localStorage 初始化
  await page.send('Page.reload')
  await waitApp(page, 90_000)
  await sleep(1500)

  const scene = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    const snap = rt.debugSnapshot({ includeCatalog: false })
    return { assets: snap.assets.length, model: rt.modelStatus() }
  })()`)

  // 打开设置弹窗并把焦点放到 API Key 输入框
  const opened = await page.eval(`(() => {
    const sections = Array.from(document.querySelectorAll('.plugin-section'))
    const sec = sections.find(s => {
      const n = s.querySelector('.plugin-name')
      return n && n.textContent && n.textContent.indexOf('AI 编辑') >= 0
    })
    const btn =
      (sec && sec.querySelector('button[title="API 设置"]')) ||
      document.querySelector('button[title="API 设置"]') ||
      document.querySelector('.agent-setup-btn')
    if (!btn) return 'no-button'
    btn.click()
    return 'clicked'
  })()`)
  if (opened !== 'clicked') {
    console.log(`\n[手动一步] 没自动找到设置按钮（${opened}）——请在左栏「AI 编辑」里点「⚙ 设置」。`)
  } else {
    await waitFor(() => page.eval(`Boolean(document.querySelector('.llm-modal'))`), {
      timeout: 8_000,
      label: '设置弹窗',
    }).catch(() => null)
    await page.eval(`(() => {
      const el = document.querySelector('.llm-modal input[type="password"]')
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }) }
      return true
    })()`)
  }

  console.log('\n================ 等你一步 ================')
  console.log(`窗口已打开：${APP_URL}`)
  console.log(`场景资产数：${scene.assets}（scene-02 应为 10 个左右）`)
  console.log(`模型状态：${scene.model.configured ? '已配置' : '未配置'} — ${scene.model.summary}`)
  console.log('\n设置弹窗已打开（Base URL / 协议 / 模型名 = deepseek-flash 已预置）：')
  console.log('  1. 把 DeepSeek 的 API Key 粘进「API Key」输入框（已聚焦）；')
  console.log('  2. 点「测试连接」看是否 ✓（可选，但能提前暴露 CORS/鉴权问题）；')
  console.log('  3. 点「保存」。')
  console.log('\n完成后回我一句，我接着跑 status → preprocess → run。')
  console.log('（Key 只在你这个窗口的 localStorage 里；脚本从不读它，也不会进任何输出。）')
  console.log('==========================================')
}

async function cmdStatus() {
  const page = await connect()
  await waitApp(page)
  const info = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    const rd = rt.renderDiagnostics()
    return {
      model: rt.modelStatus(),
      phase: rt.phase(),
      locked: rt.locked(),
      assets: rt.debugSnapshot({ includeCatalog: false }).assets.length,
      partition: rt.partition(),
      renderPort: rd ? { mounted: true, hasMainCamera: Boolean(rd.mainCamera) } : { mounted: false },
      evidence: rt.evidenceStats(),
      events: rt.recorder.events().length,
    }
  })()`)
  console.log(JSON.stringify(info, null, 2))
}

async function cmdPreprocess() {
  const page = await connect()
  await waitApp(page)
  const cfg = await page.eval(`window.__coagentDev.runtime.modelStatus()`)
  if (!cfg.configured) {
    console.error(`模型未配置（${cfg.summary}）——先在窗口里填 Key 并保存。`)
    process.exit(3)
  }

  console.log(`模型：${cfg.summary}`)
  console.log('开始鸟瞰 VLM 分区（真实请求，可能要 30–120 s）…\n')
  const t0 = Date.now()
  await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    rt.recorder.reset()
    window.__lastCapture = null
    // 只读探针：截获 evidenceStore 铸出的 observation（拿鸟瞰图给报告用）
    if (!rt.observations.__t14Patched) {
      const orig = rt.observations.capture.bind(rt.observations)
      rt.observations.capture = async (...a) => {
        const o = await orig(...a)
        window.__lastCapture = o
        return o
      }
      rt.observations.__t14Patched = true
    }
    window.__t14 = { done: false, err: null, result: null, events: [] }
    rt.recorder.subscribe(e => { if (window.__t14.events.length < 400) window.__t14.events.push(e) })
    rt.preprocess()
      .then(r => {
        window.__t14.result = {
          partitionVersion: r.partition.partitionVersion,
          regions: r.partition.regions.map(g => ({ id: g.id, name: g.name, objects: g.objectIds.length })),
          readonly: r.partition.globalReadonlyObjectIds.length,
          report: {
            cameraId: r.report.cameraId,
            issues: r.report.issues ?? [],
            ambiguous: r.report.ambiguous ?? [],
            unassigned: r.report.unassigned ?? [],
          },
        }
        window.__t14.done = true
      })
      .catch(e => { window.__t14.err = String((e && e.message) || e); window.__t14.done = true })
    return true
  })()`)

  const st = await awaitT14(page, 180_000, 'preprocess')
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const png = await shot(page, 'partition')

  // 把 VLM 实际看到的鸟瞰图存下来
  const cap = await page.eval(`(() => {
    const o = window.__lastCapture
    if (!o) return null
    return { imageId: o.rgbImageId, url: window.__coagentDev.runtime.observations.urlFor(o.rgbImageId) }
  })()`)
  if (cap?.url) {
    const b64 = await page.eval(`(async () => {
      const blob = await (await fetch(${JSON.stringify(cap.url)})).blob()
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
      return btoa(s)
    })()`)
    const file = join(ARTIFACTS, 'w06-t14-birdseye.png')
    writeFileSync(file, Buffer.from(b64, 'base64'))
    console.log(`鸟瞰图（VLM 实际输入）：${file}`)
  }

  console.log(`用时 ${secs}s，事件 ${st.events.length} 条，截图 ${png}\n`)
  if (st.err) {
    console.log(`❌ FAIL  preprocess: ${st.err}`)
  } else if (st.result) {
    const r = st.result
    console.log(`✅ 分区 v${r.partitionVersion}：${r.regions.map(g => `${g.name}(${g.objects})`).join(' / ')}`)
    console.log(`   只读 ${r.readonly} 个；issues ${r.report.issues.length}；歧义 ${r.report.ambiguous.length}；未归属 ${r.report.unassigned.length}`)
    if (r.report.issues.length) console.log(`   issues: ${JSON.stringify(r.report.issues, null, 2)}`)
  } else {
    console.log(`⏱ 超时未返回，当前相位 ${st.phase}`)
  }
  console.log('\n事件序列：')
  for (const e of summarizeEvents(st.events)) {
    console.log(`  #${e.seq} ${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`)
  }
}

async function cmdRun() {
  const page = await connect()
  await waitApp(page)
  const cfg = await page.eval(`window.__coagentDev.runtime.modelStatus()`)
  if (!cfg.configured) {
    console.error(`模型未配置（${cfg.summary}）——先在窗口里填 Key 并保存。`)
    process.exit(3)
  }
  const part = await page.eval(`Boolean(window.__coagentDev.runtime.partition())`)
  if (!part) {
    console.error('还没有分区——先跑 preprocess。')
    process.exit(3)
  }

  console.log(`模型：${cfg.summary}`)
  console.log(`指令：${REQUEST}`)
  console.log('开始真实 run（planner → executor → judge → finalCheck）…\n')
  const t0 = Date.now()
  await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    rt.recorder.reset()
    window.__t14 = { done: false, err: null, result: null, events: [] }
    rt.recorder.subscribe(e => { if (window.__t14.events.length < 500) window.__t14.events.push(e) })
    rt.start(${JSON.stringify(REQUEST)})
      .then(r => { window.__t14.result = r; window.__t14.done = true })
      .catch(e => { window.__t14.err = String((e && e.message) || e); window.__t14.done = true })
    return true
  })()`)

  const st = await awaitT14(page, 20 * 60_000, 'run')
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const phase = await page.eval(`window.__coagentDev.runtime.phase()`)
  const png = await shot(page, 'run')

  console.log(`用时 ${secs}s，终态 ${phase}，事件 ${st.events.length} 条，截图 ${png}\n`)
  if (st.timedOut) console.log(`⏱ 超时（仍在 ${st.phase}）`)
  if (st.err) console.log(`❌ 抛出：${st.err}`)
  if (st.result) console.log(`结果：\n${JSON.stringify(st.result, null, 2)}\n`)

  console.log('事件序列：')
  for (const e of summarizeEvents(st.events)) {
    console.log(`  #${e.seq} ${e.type}${e.taskId ? ` [${e.taskId}]` : ''} ${JSON.stringify(e.payload).slice(0, 400)}`)
  }
}

async function cmdShot() {
  const page = await connect()
  await waitApp(page)
  const png = await shot(page, args.get('name') ?? 'manual')
  console.log(png)
}

/** 把左栏滚到 CoAgent 面板再截图（面板默认折叠在视口外） */
async function cmdPanel() {
  const page = await connect()
  await waitApp(page)
  const found = await page.eval(`(() => {
    const sec = Array.from(document.querySelectorAll('.plugin-section')).find(s => {
      const n = s.querySelector('.plugin-name')
      return n && n.textContent && n.textContent.indexOf('CoAgent') >= 0
    })
    if (!sec) return false
    sec.scrollIntoView({ block: 'start' })
    return true
  })()`)
  if (!found) console.error('没找到 CoAgent 面板区块')
  const png = await shot(page, args.get('name') ?? 'panel')
  console.log(png)
  // 把澄清块的原文也抓出来（截图之外，方便看模型到底问了什么）
  const text = await page.eval(`(() => {
    const sec = Array.from(document.querySelectorAll('.plugin-section')).find(s => {
      const n = s.querySelector('.plugin-name')
      return n && n.textContent && n.textContent.indexOf('CoAgent') >= 0
    })
    if (!sec) return null
    const t = sec.innerText || ''
    return t.slice(0, 2000)
  })()`)
  if (text) console.log('\n--- 面板文本 ---\n' + text)
}

/**
 * 走**真实 UI 路径**发起一轮：填指令 → 点「开始」。
 * 比直接调 runtime.start 更接近用户操作，能一并验证面板接线（按钮可用性/进度订阅）。
 */
async function cmdRunUi() {
  const page = await connect()
  await waitApp(page)
  if (args.get('sniff') === 'true') await installSniffer(page)
  const cfg = await page.eval(`window.__coagentDev.runtime.modelStatus()`)
  if (!cfg.configured) {
    console.error(`模型未配置（${cfg.summary}）`)
    process.exit(3)
  }
  const part = await page.eval(`Boolean(window.__coagentDev.runtime.partition())`)
  if (!part) {
    console.error('还没有分区——先跑 preprocess。')
    process.exit(3)
  }

  // 1) 先装观察钩子（点击后 run 立刻开始，钩子必须先就位）
  await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    rt.recorder.reset()
    window.__t14 = { done: false, err: null, result: null, events: [] }
    return true
  })()`)

  // 2) 填指令（React 受控组件：走原生 setter + input 事件）
  const typed = await page.eval(`(() => {
    const sec = Array.from(document.querySelectorAll('.plugin-section')).find(s => {
      const n = s.querySelector('.plugin-name')
      return n && n.textContent && n.textContent.indexOf('CoAgent') >= 0
    })
    if (!sec) return { ok: false, why: 'no-section' }
    const ta = sec.querySelector('textarea')
    if (!ta) return { ok: false, why: 'no-textarea' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(REQUEST)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.focus()
    const btn = Array.from(sec.querySelectorAll('button')).find(b => b.textContent.trim() === '开始' && !b.disabled)
    return { ok: Boolean(btn), why: btn ? 'ready' : 'start-disabled', value: ta.value }
  })()`)
  if (!typed.ok) {
    console.error(`没能在 UI 上发起：${typed.why}`)
    process.exit(4)
  }
  console.log(`指令已填入（${typed.value.length} 字），点「开始」…`)

  const t0 = Date.now()
  const clicked = await page.eval(`(() => {
    const sec = Array.from(document.querySelectorAll('.plugin-section')).find(s => {
      const n = s.querySelector('.plugin-name')
      return n && n.textContent && n.textContent.indexOf('CoAgent') >= 0
    })
    const btn = Array.from(sec.querySelectorAll('button')).find(b => b.textContent.trim() === '开始' && !b.disabled)
    if (!btn) return false
    btn.click()
    return true
  })()`)
  if (!clicked) {
    console.error('「开始」按钮点了没找到/仍禁用')
    process.exit(4)
  }

  const SETTLED = ['completed', 'rolled_back', 'failed', 'error_locked', 'awaiting_clarification']
  let last = null
  let phase = null
  for (;;) {
    phase = await page.eval(`window.__coagentDev.runtime.phase()`)
    if (phase !== last) {
      console.log(`  · 相位：${phase}  (+${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      last = phase
    }
    if (SETTLED.includes(phase)) break
    if (Date.now() - t0 > 20 * 60_000) {
      console.log('⏱ 超过 20 分钟上限，停止观察')
      break
    }
    await sleep(1000)
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const events = await page.eval(`window.__coagentDev.runtime.recorder.sanitizedEvents()`)
  const png = await shot(page, 'run')

  console.log(`\n用时 ${secs}s，终态 ${phase}，事件 ${events.length} 条，截图 ${png}\n`)
  console.log('事件序列：')
  for (const e of summarizeEvents(events)) {
    console.log(`  #${e.seq} ${e.type}${e.taskId ? ` [${e.taskId}]` : ''} ${JSON.stringify(e.payload).slice(0, 600)}`)
  }
  const outcome = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    return { phase: rt.phase(), locked: rt.locked(), evidence: rt.evidenceStats() }
  })()`)
  console.log(`\n${JSON.stringify(outcome, null, 2)}`)
  return events
}

/** 强制整页重载（改完模块后必须做，否则跑的是 HMR 里的旧闭包） */
async function cmdReload() {
  const page = await connect()
  // 重载前注入错误收集器：页面级异常要在加载期就抓，否则 connect 之后已经错过
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__errs = []
      window.addEventListener('error', e => window.__errs.push('error: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0)))
      window.addEventListener('unhandledrejection', e => window.__errs.push('unhandledrejection: ' + String((e.reason && e.reason.message) || e.reason)))
      const ce = console.error
      console.error = (...a) => { window.__errs.push('console.error: ' + a.map(x => (x && x.stack) || String(x)).join(' ')); ce(...a) }
      const cw = console.warn
      console.warn = (...a) => { window.__errs.push('console.warn: ' + a.map(String).join(' ')); cw(...a) }
    `,
  })
  await page.send('Page.reload', { ignoreCache: true })
  await waitApp(page, 90_000).catch(() => undefined)
  // 渲染桥是 Canvas 里的 R3F 组件，挂在 __coagentDev 之后才 ready
  await waitFor(() => page.eval(`Boolean(window.__coagentDev && window.__coagentDev.runtime.renderDiagnostics())`), {
    timeout: 30_000,
    label: '渲染桥挂载',
  }).catch(() => undefined)
  await sleep(800)
  const info = await page.eval(`(() => {
    const rt = window.__coagentDev ? window.__coagentDev.runtime : null
    return {
      phase: rt ? rt.phase() : null,
      assets: rt ? rt.debugSnapshot({ includeCatalog: false }).assets.length : null,
      partition: rt ? (rt.partition()?.partitionVersion ?? null) : null,
      renderPort: rt ? rt.renderDiagnostics() : null,
      errs: (window.__errs || []).slice(0, 12),
    }
  })()`)
  console.log(JSON.stringify(info, null, 2))
}

/** 页面自检：Canvas / 插件区块 / 渲染桥 / 末尾文本（排查"桥没挂"用） */
async function cmdDiag() {
  const page = await connect()
  await waitApp(page, 20_000).catch(() => undefined)
  const info = await page.eval(`(() => {
    const rt = window.__coagentDev ? window.__coagentDev.runtime : null
    return {
      hasDev: Boolean(window.__coagentDev),
      canvas: document.querySelectorAll('canvas').length,
      pluginNames: Array.from(document.querySelectorAll('.plugin-name')).map(n => n.textContent),
      hasCoAgentSection: Array.from(document.querySelectorAll('.plugin-name')).some(n => (n.textContent || '').includes('CoAgent')),
      renderPort: rt ? rt.renderDiagnostics() : null,
      phase: rt ? rt.phase() : null,
      runtimeDiag: rt ? rt.diagnostics() : null,
      sameRuntime: window.__coagent === (window.__coagentDev ? window.__coagentDev.runtime : null),
      canvasInfo: Array.from(document.querySelectorAll('canvas')).map(c => ({
        w: c.width,
        h: c.height,
        css: Math.round(c.getBoundingClientRect().width) + 'x' + Math.round(c.getBoundingClientRect().height),
        hasWebGL: Boolean(c.getContext('webgl2') || c.getContext('webgl')),
        style: (c.getAttribute('style') || '').slice(0, 200),
        parent: (() => {
          const p = c.parentElement
          if (!p) return null
          const r = p.getBoundingClientRect()
          return {
            tag: p.tagName,
            cls: p.className,
            style: (p.getAttribute('style') || '').slice(0, 120),
            box: Math.round(r.width) + 'x' + Math.round(r.height),
            parentCls: p.parentElement ? p.parentElement.className : null,
          }
        })(),
      })),
      viewportBox: (() => {
        const v = document.querySelector('.viewport')
        if (!v) return null
        const r = v.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      })(),
      winKeys: Object.keys(window).filter(k => /three|engine|__/i.test(k)).slice(0, 20),
      tail: document.body.innerText.slice(-300).replace(/\\n+/g, ' | '),
    }
  })()`)
  console.log(JSON.stringify(info, null, 2))
}

/** 探针：包住 registerRenderPort + 开关一次插件，看桥到底调不调（排查"桥没挂"） */
async function cmdProbe() {
  const page = await connect()
  await waitApp(page, 20_000).catch(() => undefined)
  const probe = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    window.__calls = []
    if (!rt.__probed) {
      const orig = rt.registerRenderPort.bind(rt)
      rt.registerRenderPort = (p) => { window.__calls.push('register:' + (p ? 'port' : 'null')); return orig(p) }
      rt.__probed = true
    }
    return { installed: true, current: rt.renderDiagnostics() ? 'mounted' : 'null' }
  })()`)
  console.log('探针安装：', JSON.stringify(probe))

  // 关掉再打开 CoAgent 插件（会卸载/重挂桥）
  const toggled = await page.eval(`(() => {
    const btn = document.querySelector('button.switch[aria-label="CoAgent 布局 开关"]')
    if (!btn) return 'no-switch'
    btn.click()
    return 'off'
  })()`)
  console.log('关闭插件：', toggled)
  await sleep(1500)
  await page.eval(`(() => {
    const btn = document.querySelector('button.switch[aria-label="CoAgent 布局 开关"]')
    if (btn) btn.click()
    return true
  })()`)
  console.log('重新打开插件…')
  await sleep(2500)

  const info = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    return {
      calls: window.__calls,
      renderPort: rt.renderDiagnostics() ? 'mounted' : 'null',
      phase: rt.phase(),
      devRuntimeIsGlobal: window.__coagentDev.runtime === window.__coagent,
    }
  })()`)
  console.log(JSON.stringify(info, null, 2))
}

/**
 * 用**已有** profile 重开窗口（不删 profile → 用户手填的 Key 仍在 localStorage）。
 * 与 setup 的区别：setup 会 rm 整个 profile（等于抹掉 Key），所以只在换场景时用 setup。
 */
async function cmdReopen() {
  mkdirSync(ARTIFACTS, { recursive: true })
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1600,1000',
      '--window-position=80,40',
      APP_URL,
    ],
    { stdio: 'ignore', detached: true },
  )
  child.unref()
  const page = await connect()
  await waitApp(page, 90_000)
  const info = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    return { model: rt.modelStatus(), assets: rt.debugSnapshot({ includeCatalog: false }).assets.length }
  })()`)
  console.log(`窗口已重开（profile 未清，Key 仍在）：${JSON.stringify(info)}`)
}

/** 澄清回路：读 pendingClarify → 点一个选项 → 看是否重新规划并落定 */
async function cmdClarify() {
  const page = await connect()
  await waitApp(page)
  if (args.get('sniff') === 'true') await installSniffer(page)
  const st = await page.eval(`(() => {
    const sec = Array.from(document.querySelectorAll('.plugin-section')).find(s => {
      const n = s.querySelector('.plugin-name')
      return n && n.textContent && n.textContent.indexOf('CoAgent') >= 0
    })
    const labels = sec ? Array.from(sec.querySelectorAll('.agent-task-label')).map(n => n.textContent) : []
    const question = sec
      ? (() => {
          const el = Array.from(sec.querySelectorAll('.agent-chat-note')).find(n => n.textContent && n.textContent.length > 4)
          return el ? el.textContent : null
        })()
      : null
    const buttons = sec
      ? Array.from(sec.querySelectorAll('button')).map(b => b.textContent.trim()).filter(t => t && t.length < 40)
      : []
    return { labels, question, buttons }
  })()`)
  console.log('面板区块：', JSON.stringify(st, null, 2))

  // 点第一个澄清选项（选项按钮文案在「需要澄清」区块里）
  const picked = await page.eval(`(() => {
    const sec = Array.from(document.querySelectorAll('.plugin-section')).find(s => {
      const n = s.querySelector('.plugin-name')
      return n && n.textContent && n.textContent.indexOf('CoAgent') >= 0
    })
    if (!sec) return { ok: false, why: 'no-section' }
    const block = Array.from(sec.querySelectorAll('.agent-section')).find(s => {
      const l = s.querySelector('.agent-task-label')
      return l && l.textContent && l.textContent.indexOf('澄清') >= 0
    })
    if (!block) return { ok: false, why: 'no-clarify-block' }
    const opt = block.querySelector('button.agent-mini-btn')
    if (!opt) return { ok: false, why: 'no-option' }
    const text = opt.textContent.trim()
    opt.click()
    return { ok: true, picked: text }
  })()`)
  if (!picked.ok) {
    console.error(`没找到澄清选项：${picked.why}`)
    process.exit(4)
  }
  console.log(`点了澄清选项：${picked.picked}\n`)

  const SETTLED = ['completed', 'rolled_back', 'failed', 'error_locked']
  const t0 = Date.now()
  let last = null
  let phase = null
  for (;;) {
    phase = await page.eval(`window.__coagentDev.runtime.phase()`)
    if (phase !== last) {
      console.log(`  · 相位：${phase}  (+${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      last = phase
    }
    if (SETTLED.includes(phase)) break
    if (Date.now() - t0 > 20 * 60_000) {
      console.log('⏱ 超过 20 分钟上限')
      break
    }
    await sleep(1000)
  }
  const events = await page.eval(`window.__coagentDev.runtime.recorder.sanitizedEvents()`)
  const png = await shot(page, 'clarify')
  console.log(`\n终态 ${phase}，事件 ${events.length} 条，截图 ${png}\n`)
  for (const e of summarizeEvents(events)) {
    console.log(`  #${e.seq} ${e.type}${e.taskId ? ` [${e.taskId}]` : ''} ${JSON.stringify(e.payload).slice(0, 400)}`)
  }
}

/**
 * 在页面里拦截对模型端点的 fetch：记录每轮请求体（含完整对话历史）
 * 与响应里的工具调用，用来排查"模型为什么不停调工具"。
 */
async function installSniffer(page) {
  await page.eval(`(() => {
    if (window.__sniffInstalled) return true
    window.__sniffInstalled = true
    window.__sniff = []
    const orig = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (!/deepseek|\\/chat\\/completions|\\/v1\\/messages|\\/responses/i.test(String(url))) {
        return orig(input, init)
      }
      let body = null
      try { body = init && init.body ? JSON.parse(init.body) : null } catch { body = null }
      const rec = { url: String(url), messages: [], tools: [], reply: null }
      if (body) {
        rec.tools = (body.tools || []).map(t => t.function ? t.function.name : t.name)
        for (const m of body.messages || []) {
          if (m.role === 'assistant' && m.tool_calls) {
            rec.messages.push({ role: 'assistant', tool_calls: (m.tool_calls || []).map(c => ({ name: c.function && c.function.name, args: c.function && c.function.arguments })) })
          } else if (m.role === 'tool') {
            rec.messages.push({ role: 'tool', content: String(m.content).slice(0, 300) })
          } else if (m.role === 'system' || m.role === 'user') {
            const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            rec.messages.push({ role: m.role, content: c.slice(0, 400) })
          }
        }
      }
      const res = await orig(input, init)
      const clone = res.clone()
      clone.text().then(t => {
        rec.reply = t.slice(0, 4000)
        rec.status = res.status
        window.__sniff.push(rec)
      }).catch(() => { window.__sniff.push(rec) })
      return res
    }
    return true
  })()`)
}

/** 打印拦截到的模型往返（只看 executor 那几轮） */
async function cmdSniff() {
  const page = await connect()
  await waitApp(page)
  const sniff = await page.eval(`window.__sniff || []`)
  if (sniff.length === 0) {
    console.log('没有拦截到模型请求（先跑一次 runui/clarify）')
    return
  }
  for (let i = 0; i < sniff.length; i++) {
    const s = sniff[i]
    const toolCalls = s.messages.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || [])
    if (s.status && s.status >= 400) {
      console.log(`\n──── 请求 #${i + 1}  HTTP ${s.status} ────`)
      console.log(`  错误原文：${String(s.reply).slice(0, 900)}`)
      continue
    }
    console.log(`\n──── 请求 #${i + 1}  tools=${s.tools.length}  工具调用=${toolCalls.length} ────`)
    for (const m of s.messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const c of m.tool_calls) console.log(`  → 调用 ${c.name} ${String(c.args).slice(0, 220)}`)
      } else if (m.role === 'tool') {
        console.log(`  ← 返回 ${m.content.slice(0, 220).replace(/\\n/g, ' ')}`)
      }
    }
  }
}

/** 完整分区报告（issues 原文、歧义、未归属、相机 id） */
async function cmdReport() {
  const page = await connect()
  await waitApp(page)
  const rep = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    const r = rt.partitionReport()
    if (!r) return { error: '没有分区报告' }
    return {
      partitionVersion: rt.partition()?.partitionVersion ?? null,
      camera: r.camera,
      issues: r.issues,
      ambiguous: r.ambiguous,
      unassigned: r.unassigned,
      readonlySuggestions: r.readonlySuggestions ?? null,
      regions: (rt.partition()?.regions ?? []).map(g => ({ id: g.id, name: g.name, objects: g.objectIds })),
    }
  })()`)
  console.log(JSON.stringify(rep, null, 2))
}

async function cmdClose() {
  try {
    const page = await connect()
    await page.send('Browser.close').catch(() => null)
  } catch {
    /* 已经关了 */
  }
  console.log('已请求关闭窗口')
}

/** 把证据图存到 artifacts（T14 报告用） */
async function cmdFetchEvidence() {
  const page = await connect()
  await waitApp(page)
  const items = await page.eval(`(() => {
    const rt = window.__coagentDev.runtime
    const ids = new Set()
    for (const e of rt.recorder.events()) {
      const p = e.payload || {}
      for (const k of ['observationId', 'beforeId', 'afterId', 'imageId']) {
        if (typeof p[k] === 'string') ids.add(p[k])
      }
      if (Array.isArray(p.observationIds)) for (const id of p.observationIds) ids.add(id)
    }
    return Array.from(ids).map(id => {
      // 事件里存的是 observationId；urlFor 要的是 imageId，经 observation 转一次
      const obs = rt.observations.get(id)
      return { id, imageId: obs ? obs.rgbImageId : null, url: obs ? rt.observations.urlFor(obs.rgbImageId) : null }
    })
  })()`)
  mkdirSync(ARTIFACTS, { recursive: true })
  for (const it of items) {
    if (!it.url) continue
    const b64 = await page.eval(`(async () => {
      const blob = await (await fetch(${JSON.stringify(it.url)})).blob()
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
      return btoa(s)
    })()`)
    const file = join(ARTIFACTS, `w06-t14-evidence-${it.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`)
    writeFileSync(file, Buffer.from(b64, 'base64'))
    console.log(`saved ${file} (${readFileSync(file).length} bytes)`)
  }
}

const COMMANDS = {
  setup: cmdSetup,
  status: cmdStatus,
  preprocess: cmdPreprocess,
  run: cmdRun,
  shot: cmdShot,
  panel: cmdPanel,
  reload: cmdReload,
  diag: cmdDiag,
  reopen: cmdReopen,
  clarify: cmdClarify,
  sniff: cmdSniff,
  probe: cmdProbe,
  report: cmdReport,
  runui: cmdRunUi,
  evidence: cmdFetchEvidence,
  close: cmdClose,
}

const fn = COMMANDS[CMD]
if (!fn) {
  console.error(`未知命令：${CMD}（可用：${Object.keys(COMMANDS).join(' / ')}）`)
  process.exit(2)
}
await fn()
process.exit(0)
