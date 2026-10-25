/** Real Chrome/WebGL snapshots before/after migration. Runs against a local Vite server. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const i = value.indexOf('=')
  return i < 0 ? [value.replace(/^--/, ''), true] : [value.slice(2, i), value.slice(i + 1)]
}))
const baseUrl = args.url ?? 'http://127.0.0.1:5184/'
const output = resolve(args.output ?? join(root, 'artifacts/model-migration/browser-after.json'))
mkdirSync(dirname(output), { recursive: true })
const chromePath = args.chrome ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync)
if (!chromePath) throw new Error('Chrome/Edge not found')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const port = 9460 + Math.floor(Math.random() * 400)
const profile = join(dirname(output), `.browser-${Date.now()}`)
const child = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore', windowsHide: true })
let ws, testDirectory
const result = { scenes: [], errors: [], interaction: null }
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
  await send('Page.navigate', { url: `${baseUrl}?scene=demo-forest` })
  await sleep(1500)
  await evaluate(`(async () => { window.__migrationProbe = await import('/scripts/migrationBrowserProbe.ts'); return true })()`)
  const scenes = JSON.parse(readFileSync(join(root, 'scenes/index.json'), 'utf8'))
  for (const scene of scenes) {
    const snapshot = await evaluate(`__migrationProbe.collectScene(${JSON.stringify(scene.id)})`)
    result.scenes.push(snapshot)
    console.log(`Rendered ${scene.id}: ${snapshot.assets.length} instances`)
    if (scene.id === 'scene-models') {
      const data = await evaluate('__migrationProbe.screenshot()')
      writeFileSync(output.replace(/\.json$/, '-scene-models.png'), Buffer.from(data.split(',')[1], 'base64'))
    }
  }
  if (args.compare) {
    const before = JSON.parse(readFileSync(resolve(args.compare), 'utf8'))
    const proof = JSON.parse(readFileSync(join(root, 'artifacts/model-migration/report.json'), 'utf8'))
    const differences = []
    let maxError = 0, checked = 0
    for (const scene of result.scenes) {
      const oldScene = before.scenes.find(s => s.sceneId === scene.sceneId)
      const validation = proof.scenes.find(s => s.scene === scene.sceneId)
      if (!oldScene || oldScene.assets.length !== scene.assets.length) throw new Error(`Scene count changed: ${scene.sceneId}`)
      for (const asset of scene.assets) {
        const old = oldScene.assets.find(a => a.id === asset.id)
        if (!old) throw new Error(`Instance disappeared: ${asset.id}`)
        const instanceProof = validation.instances.find(i => i.id === asset.id)
        const tolerance = instanceProof.world_tolerance_m ?? 1e-5
        const error = Math.max(...asset.min.map((x, i) => Math.abs(x - old.min[i])), ...asset.max.map((x, i) => Math.abs(x - old.max[i])))
        maxError = Math.max(maxError, error); checked++
        if (error > tolerance || old.resolved !== asset.resolved) differences.push({ scene: scene.sceneId, id: asset.id, error, tolerance, oldResolved: old.resolved, resolved: asset.resolved })
      }
    }
    result.comparison = { checkedInstances: checked, maxWorldBoundsErrorM: maxError, differences }
    if (differences.length) throw new Error(`Browser geometry comparison failed for ${differences.length} instances`)
  }
  if (args.interaction) {
    const proof = JSON.parse(readFileSync(join(root, 'artifacts/model-migration/report.json'), 'utf8'))
    const avocado = proof.models.find(m => m.legacy_id === 'avocado')
    testDirectory = join(root, 'scenes', 'migration-browser-check')
    if (existsSync(testDirectory)) throw new Error('Temporary test scene already exists')
    mkdirSync(testDirectory)
    writeFileSync(join(testDirectory, 'scene.json'), JSON.stringify({ meta: { id: 'migration-browser-check', name: 'Migration check', version: 1, unit: 'm', up: '+Y' }, environment: {}, assets: [], cameras: [] }))
    const ref = await evaluate(`__migrationProbe.refForAsset(${JSON.stringify(avocado.target_asset_id)})`)
    result.interaction = await evaluate(`__migrationProbe.exerciseEditor('migration-browser-check', ${JSON.stringify(ref)})`)
  }
  if (result.errors.length) throw new Error('Browser reported uncaught exceptions')
} catch (error) {
  result.failure = String(error.stack ?? error)
  process.exitCode = 1
} finally {
  if (testDirectory) {
    const file = join(testDirectory, 'scene.json')
    if (existsSync(file)) unlinkSync(file)
    rmdirSync(testDirectory)
  }
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ output, scenes: result.scenes.length, comparison: result.comparison, interaction: result.interaction, errors: result.errors, failure: result.failure }, null, 2))
  ws?.close()
  child.kill()
}
