// Read-only browser smoke test. No model calls, task submissions, or scene writes.
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const url = process.argv[2] ?? 'http://127.0.0.1:5217/?scene=demo-forest'
const output = process.argv[3]
const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
if (!chromePath) throw new Error('Chrome/Edge not found')
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=9347', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'partition-agent-browser-'))}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' })
const pause = ms => new Promise(r => setTimeout(r, ms))
let ws
try {
  let targets
  for (let i = 0; i < 100; i++) {
    try { targets = await (await fetch('http://127.0.0.1:9347/json')).json(); break } catch { await pause(100) }
  }
  const target = targets?.find(t => t.type === 'page')
  if (!target) throw new Error('Browser did not start')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  let id = 0
  const pending = new Map(), errors = [], requests = []
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
    if (!m.id) return
    const p = pending.get(m.id); if (!p) return
    pending.delete(m.id); clearTimeout(p.timer)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id, timer = setTimeout(() => { pending.delete(callId); reject(new Error(`Timeout: ${method}`)) }, 30000)
    pending.set(callId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: callId, method, params }))
  })
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const wait = async expression => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await pause(100) }
    throw new Error(`UI timeout: ${expression}`)
  }
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable'); await send('Page.navigate', { url })
  await wait(`!!document.querySelector('[aria-label="场景分区 Agent 开关"]')`)
  await evaluate(`document.querySelector('[aria-label="场景分区 Agent 开关"]').click()`)
  await wait(`document.querySelector('.pa-status')?.textContent === '场景会话' && !document.querySelector('[aria-label="场景任务"]').disabled`)
  const result = await evaluate(`({ originalDisabled: document.querySelector('[aria-label="LLM Agent 实验 开关"]').getAttribute('aria-checked') === 'false', oldDisabled: document.querySelector('[aria-label="AI 编辑 开关"]').getAttribute('aria-checked') === 'false', panel: !!document.querySelector('.partition-agent-panel'), task: !!document.querySelector('[aria-label="场景任务"]'), overflow: document.querySelector('.partition-agent-panel').scrollWidth > document.querySelector('.partition-agent-panel').clientWidth })`)
  if (!result.originalDisabled || !result.oldDisabled || !result.panel || !result.task || result.overflow) throw new Error(JSON.stringify(result))
  const localProcessing = await evaluate(`fetch('/api/partition-agent/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'health' }) }).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; })`)
  if (!localProcessing.available) throw new Error('Bundled local processing is unavailable')
  const independent = await evaluate(`!document.body.textContent.includes('刷新工作流') && !document.querySelector('[aria-label="Map2Area 分区工作流"]')`)
  if (!independent || requests.some(u => /:8765\b|\/map2area\//i.test(u))) throw new Error('Unexpected Map2Area dependency')
  await evaluate(`[...document.querySelectorAll('.partition-agent-panel button')].find(b => b.textContent === '模型设置').click()`)
  await wait(`!!document.querySelector('.modal-overlay') || !!document.querySelector('[role="dialog"]') || document.body.textContent.includes('接入方式')`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  // Close via the modal's existing explicit close button if Escape is not supported.
  await evaluate(`{ const b = [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '取消'); if (b) b.click(); }`)
  await wait(`!document.querySelector('.modal-mask')`)
  await evaluate(`document.querySelector('.partition-agent-panel').scrollIntoView({ block: 'start' })`)
  if (output) { const shot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(output, Buffer.from(shot.data, 'base64')) }
  if (errors.length) throw new Error(`Browser exceptions: ${errors.join('; ')}`)
  console.log(JSON.stringify({ ok: true, ...result, independent, localProcessing, screenshot: output ?? null }))
} finally { ws?.close(); chrome.kill() }
