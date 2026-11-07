/** Verify layered terrain material in real Chrome/Edge WebGL; capture diagnostics and screenshot. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const i = value.indexOf('=')
  return i < 0 ? [value.replace(/^--/, ''), true] : [value.slice(2, i), value.slice(i + 1)]
}))
const baseUrl = args.url ?? 'http://127.0.0.1:5189/'
const output = resolve(args.output ?? join(root, 'artifacts/terrain-surface/browser.json'))
mkdirSync(dirname(output), { recursive: true })
const chromePath = args.chrome ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
if (!chromePath) throw new Error('Chrome/Edge not found')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const port = 9460 + Math.floor(Math.random() * 400)
const profile = join(dirname(output), `.browser-${Date.now()}`)
const child = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore', windowsHide: true })
let ws
const result = { errors: [] }
try {
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break } catch { /* start-up */ }
    if (tries > 100) throw new Error('Chrome startup timeout')
    await sleep(100)
  }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id)
      pending.delete(message.id); clearTimeout(timer)
      message.error ? reject(new Error(message.error.message)) : resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') result.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  })
  function send(method, params = {}) {
    const requestId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)) }, 150_000)
      timer.unref()
      pending.set(requestId, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: requestId, method, params }))
    })
  }
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Log.enable')
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data)
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') result.errors.push(m.params.entry.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') result.errors.push(m.params.args.map(a => a.value).join(' '))
  })
  await send('Page.navigate', { url: `${baseUrl}modules/terrain/tests/${args.component ? 'componentProbe' : 'probe'}.html${args.custom ? '?custom=1' : ''}` })
  let probe
  for (let i = 0; i < 100; i++) {
    probe = await evaluate('window.terrainProbe')
    if (probe && (!args.custom || probe.blendPixelDifference !== undefined)) break
    await sleep(100)
  }
  result.probe = probe
  const capture = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(output.replace(/\.json$/, '.png'), Buffer.from(capture.data, 'base64'))
  writeFileSync(output, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (!probe || result.errors.length || probe.textureErrors?.length || (args.custom && !(probe.blendPixelDifference > 0)) || probe.programs.some(p => !p.runnable)) process.exitCode = 1
} finally {
  ws?.close(); child.kill()
}
