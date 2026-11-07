// Tri-biome birdseye regression. No model calls, task submissions, or scene writes.
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const url = process.argv[2] ?? 'http://127.0.0.1:5217/?scene=tri-biome'
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

  await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url })
  await wait(`!!document.querySelector('canvas')`)
  await wait(`(async () => { const {engine}=await import('/core/engine.ts'); return !!engine.findAssetObject('water')?.children.length; })()`)
  const result = await evaluate(`(async()=>{
    const {engine}=await import('/core/engine.ts'); const {useSceneStore}=await import('/core/store.ts'); const {overhead}=await import('/modules/partition-agent/geometry.ts');
    const {Vector4,Color}=await import('/node_modules/.vite/deps/three.js'); const {_roots}=await import('/node_modules/.vite/deps/@react-three_fiber.js');
    const {gl}= [..._roots.values()][0].store.getState();
    const spec=overhead(useSceneStore.getState().document).camera;
    const materials=[];engine.findAssetObject('water').traverse(o=>{if(o.isMesh)materials.push({mesh:o,material:o.material,roughness:o.material.roughness})});
    const snapshot=()=>JSON.stringify({target:gl.getRenderTarget()?.uuid??null,viewport:gl.getViewport(new Vector4()).toArray(),scissor:gl.getScissor(new Vector4()).toArray(),scissorTest:gl.getScissorTest(),autoClear:gl.autoClear,xr:gl.xr.enabled,tone:gl.toneMapping,exposure:gl.toneMappingExposure,color:gl.outputColorSpace,clear:gl.getClearColor(new Color()).toArray(),alpha:gl.getClearAlpha()});
    const before=snapshot();const normal=engine.captureFromCamera(spec,1200,900);const fixed=engine.captureFromCamera(spec,1200,900,{minRoughness:.65});const after=snapshot();
    const materialsRestored=materials.every(x=>x.mesh.material===x.material && x.material.roughness===x.roughness);
    const measure=async source=>{const img=new Image();img.src=source;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const {data}=ctx.getImageData(200,30,800,210);let variation=0,white=0;for(let y=0;y<210;y++)for(let x=0;x<800;x++){const i=(y*800+x)*4;if(data[i]>240&&data[i+1]>240&&data[i+2]>240)white++;if(x)for(let c=0;c<3;c++)variation+=Math.abs(data[i+c]-data[i-4+c]);}return {variation:variation/(210*799*3),whiteFraction:white/(800*210)};};
    return {normal:await measure(normal),fixed:await measure(fixed),materialsRestored,stateRestored:before===after,image:fixed};
  })()`)
  if (!result.materialsRestored || !result.stateRestored || result.fixed.variation >= result.normal.variation * .25 || result.fixed.whiteFraction > .01) throw new Error(JSON.stringify({ ...result, image: undefined }))
  if (output) writeFileSync(output, Buffer.from(result.image.split(',')[1], 'base64'))
  console.log(JSON.stringify({ ok: true, ...result, image: undefined, screenshot: output ?? null }))
} finally { ws?.close(); chrome.kill() }
