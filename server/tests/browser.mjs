import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createMockServer } from 'node:http'

const source = fileURLToPath(new URL('../../src', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'layout-browser-'))
const profile = join(root, 'profile')
const edge = process.env.LAYOUT_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
assert.ok(existsSync(edge), '请设置 LAYOUT_BROWSER 为 Chrome/Edge 可执行文件路径')
mkdirSync(join(root, 'scenes', 'room'), { recursive: true })
const original = { id: 'chair', ref: 'models/chair', transform: { position: [0,0,0], rotation: [0,0,0] } }
writeFileSync(join(root, 'scenes/room/scene.json'), JSON.stringify({ meta: { id: 'room', name: '房间', version: 1, unit: 'm', up: '+Y' }, assets: [original], environment: {}, cameras: [] }))
mkdirSync(join(root, 'scenes', 'garden'))
writeFileSync(join(root, 'scenes/garden/scene.json'), JSON.stringify({ meta: { id: 'garden', name: '花园', version: 1, unit: 'm', up: '+Y' }, assets: [], environment: {}, cameras: [] }))
process.env.LAYOUT_ROOT = root
process.env.LAYOUT_MODEL_TIMEOUT_MS = '5000'
const { createServer } = await import('../../src/node_modules/vite/dist/node/index.js')
const vite = await createServer({ root: source, configFile: resolve(source, 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, open: false } })
let browser, ws
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(50) }
  throw new Error('浏览器等待超时')
}
let seq = 0
const calls = new Map()
function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { calls.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 60000)
    calls.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
async function initialize() {
  await until(() => evaluate('document.readyState === "complete"').catch(() => false))
  await evaluate(`(async()=>{
    window.store = (await import('/core/store.ts')).useSceneStore;
    window.edit = (await import('/core/edit.ts')).edit;
    window.persistence = await import('/core/persistence.ts');
    if(!window.compatibilityFetch){
      const nativeFetch=window.fetch;window.compatibilityFetch=true;
      window.fetch=(url,options)=>{
        if(String(url)==='/api/tasks'&&options?.method==='POST'&&!window.originalBaseline){
          const input=JSON.parse(options.body);input.workflow='proposal';options={...options,body:JSON.stringify(input)};
        }
        return nativeFetch(url,options);
      };
    }
    await store.getState().loadScene('room');
    if(store.getState().sceneError) throw Error(store.getState().sceneError);
  })()`)
}
async function reload() { await send('Page.reload', { ignoreCache: true }); await sleep(200); await initialize() }
const position = () => evaluate('store.getState().document.assets[0].transform.position[0]')

async function testSceneLights(baseUrl) {
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets/model-catalog.json'), JSON.stringify({ models: {
    'models/chair': { id: 'chair', name: '椅子', dimensions: { w: 1, d: 1, h: 1 }, source: { type: 'primitive', shape: 'box' } },
  } }))
  mkdirSync(join(root, 'scenes/lighting-room'))
  const sceneFile = join(root, 'scenes/lighting-room/scene.json')
  writeFileSync(sceneFile, JSON.stringify({
    meta: { id: 'lighting-room', name: '灯光测试', version: 1, unit: 'm', up: '+Y' },
    assets: [original], environment: {}, cameras: [],
  }))
  await send('Page.navigate', { url: baseUrl + '/?scene=lighting-room&editor=1' })
  await until(async () => {
    const status = await evaluate(`({
      error: document.querySelector('.crash-report, .topbar .error')?.textContent,
      ready: Boolean(window.__engine?.findAssetObject('chair') && document.querySelector('.editor-panel')),
    })`).catch(() => null)
    if (status?.error) throw new Error(status.error)
    return status?.ready
  }, 45000).catch(async error => {
    const state = await evaluate(`({
      url: location.href,
      title: document.title,
      canvas: document.querySelector('canvas')?.outerHTML,
      viewport: document.querySelector('.viewport')?.getBoundingClientRect().toJSON(),
      overlay: document.querySelector('.viewport')?.textContent,
    })`)
    throw new Error(`${error.message} ${JSON.stringify(state)}`)
  })
  const click = label => evaluate(`[...document.querySelectorAll('.editor-panel button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const inputNumber = async (selector, value) => {
    await evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      field.focus();
      field.select();
    })()`)
    await send('Input.insertText', { text: String(value) })
    await evaluate('document.activeElement.blur()')
  }
  const workspace = () => evaluate("fetch('/api/workspaces/lighting-room').then(response => response.json()).then(result => result.workspace)")
  const saved = () => until(() => evaluate("document.querySelector('.topbar [role=status]')?.textContent.trim() === '已保存'"))

  assert.equal((await workspace()).document.lights, undefined)
  await click('新建点光源')
  await until(() => evaluate("Boolean(document.querySelector('.light-list [aria-pressed=true]'))"))
  const pointId = await evaluate("document.querySelector('.light-list [aria-pressed=true]').title")
  await until(() => evaluate(`__engine.findLightObject('${pointId}')?.children.some(child => child.isPointLight)`))
  await inputNumber('[aria-label="位置(m)"] input', -2)
  await until(() => evaluate(`__engine.findLightObject('${pointId}').position.x === -2`))
  const originalLighting = await evaluate('__engine.captureScreenshot()')
  await inputNumber('.light-field input[type=number][step="1"]', 90)
  await until(() => evaluate(`__engine.findLightObject('${pointId}').children.find(child => child.isPointLight).intensity === 90`))
  assert.notEqual(await evaluate('__engine.captureScreenshot()'), originalLighting)
  await click('新建聚光灯')
  await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"旋转(°)\"]'))"))
  const spotId = await evaluate("document.querySelector('.light-list [aria-pressed=true]').title")
  await until(() => evaluate(`__engine.focusLight('${spotId}')`))
  // Clear selection, then click the marker at the center of the focused viewport.
  await evaluate("(async()=> (await import('/core/store.ts')).useSceneStore.getState().select(null))()")
  const markerPosition = await evaluate(`(() => {
    const object = __engine.findLightObject('${spotId}');
    const marker = object.children.find(child => child.userData.editorHelper).children[0];
    const { camera, raycaster } = marker.__r3f.root.getState();
    const rect = document.querySelector('canvas').getBoundingClientRect();
    const projected = marker.getWorldPosition(marker.position.clone()).project(camera);
    return {
      x: rect.x + (projected.x + 1) * rect.width / 2,
      y: rect.y + (1 - projected.y) * rect.height / 2,
      raycastLayer: raycaster.layers.test(marker.layers),
      cameraLayer: camera.layers.test(marker.layers),
    };
  })()`)
  assert.equal(markerPosition.raycastLayer, true)
  assert.equal(markerPosition.cameraLayer, true)
  const { x, y } = markerPosition
  const center = { x, y }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...center })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...center })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...center })
  await until(() => evaluate(`document.querySelector('.light-list [aria-pressed=true]')?.title === '${spotId}'`))
  await until(() => evaluate(`(() => {
    const object = __engine.findLightObject('${spotId}');
    return object.parent.children.some(child => child.object === object && child.mode === 'translate');
  })()`))
  await evaluate(`(() => {
    const object = __engine.findLightObject('${spotId}');
    const controls = object.parent.children.find(child => child.object === object && child.mode === 'translate');
    controls.dispatchEvent({type:'mouseDown'});
    object.position.x = 1;
    controls.dispatchEvent({type:'objectChange'});
    object.position.x = 2;
    controls.dispatchEvent({type:'objectChange'});
    controls.dispatchEvent({type:'mouseUp'});
  })()`)
  await inputNumber('[aria-label="旋转(°)"] input', 0)
  await inputNumber('.light-field input[step="1"][max="90"]', 40)
  await until(() => evaluate(`__engine.findLightObject('${spotId}').rotation.x === 0`))
  assert.deepEqual(await evaluate(`(() => {
    const light = __engine.findLightObject('${spotId}').children.find(child => child.isSpotLight);
    return [light.getWorldPosition(light.position.clone()).toArray(), light.target.getWorldPosition(light.position.clone()).toArray()];
  })()`), [[2, 3, 0], [2, 3, -1]])
  assert.equal(await evaluate("__edit.setTransform('chair',{position:[3,0,0],rotation:[0,0,0]})"), true)
  await click('复制')
  await until(() => evaluate("document.querySelectorAll('.light-list button').length === 3"))
  await click('删除')
  await saved()
  const committed = await workspace()
  assert.equal(committed.document.lights.length, 2)
  assert.deepEqual(committed.document.lights[0].position, [-2, 3, 0])
  assert.equal(committed.document.lights[0].intensity, 90)
  assert.deepEqual(committed.document.lights[1].position, [2, 3, 0])
  assert.equal(committed.document.lights[1].angle, 40)
  assert.equal(committed.journal.find(unit => unit.label === `拖拽 ${spotId}`).entries.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(sceneFile, 'utf8')).lights, committed.document.lights)

  await send('Page.reload', { ignoreCache: true })
  await until(() => evaluate(`Boolean(window.__engine?.findLightObject('${spotId}'))`).catch(() => false))
  await evaluate("for (let i = 0; i < 4; i++) __edit.undo()")
  await saved()
  const undone = await workspace()
  assert.equal(undone.document.assets[0].transform.position[0], 0)
  assert.equal(undone.document.lights[1].angle, 30)
  assert.equal(undone.redoStack.length, 4)
  await evaluate("while (__edit.canRedo) { if (!__edit.redo()) break }")
  await saved()
  assert.deepEqual((await workspace()).document, committed.document)
  console.log('PASS: light creation, viewport selection, transform, properties, copy, deletion, persistence and mixed undo/redo')
}

async function testManualBuild(baseUrl) {
  mkdirSync(join(root, 'assets'), { recursive: true })
  const model = (id, name, w, h, d) => ({ id, name, dimensions: { w, h, d }, source: { type: 'primitive', shape: 'box' } })
  const models = {
    'models/tent': model('tent', '帐篷', 2, 1.8, 2),
    'models/tree': model('tree', '树', 3.6, 5, 1.2),
    'models/chair': model('chair', '椅子', 0.7, 0.9, 0.7),
    'models/campfire': model('campfire', '篝火', 1, 0.5, 1),
  }
  if (process.argv.includes('--build-real-assets')) {
    const layout = resolve(source, '..')
    const catalog = JSON.parse(readFileSync(join(layout, 'assets/model-catalog.json'), 'utf8')).models
    for (const [ref, assetRef] of Object.entries({
      'models/tent': 'models/tent1', 'models/tree': 'models/demo-forest-pine-tree',
      'models/chair': 'models/wooden-chair', 'models/campfire': 'models/campfire',
    })) {
      const asset = catalog[assetRef]
      for (const url of [asset.source.url, asset.thumbnail].filter(Boolean)) {
        const destination = join(root, url)
        mkdirSync(resolve(destination, '..'), { recursive: true })
        copyFileSync(join(layout, url), destination)
      }
      models[ref] = { ...asset, name: models[ref].name }
    }
  }
  writeFileSync(join(root, 'assets/model-catalog.json'), JSON.stringify({ models }))
  await send('Page.navigate', { url: baseUrl + '/?scene=garden&build=1' })
  const click = (label, selector = 'button') => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const state = async () => evaluate("import('/core/store.ts').then(m => m.useSceneStore.getState().document)")
  await until(() => evaluate("Boolean(__engine.readViewport() && document.querySelector('.manual-build-panel'))").catch(() => false), 45000)
  await evaluate("document.querySelector('.topbar button[title=新建空场景]').click()")
  await send('Input.insertText', { text: '录制营地验收' })
  await until(() => evaluate("Boolean(document.querySelector('.modal input'))"))
  await click('创建', '.modal button')
  const sceneId = await until(async () => {
    const current = await state()
    return current?.meta?.name === '录制营地验收' && await evaluate("Boolean(__engine.readViewport())") && current.meta.id
  })
  const visibilitySwitch = 'document.querySelector(\'.build-recordings input[role="switch"]\')'
  assert.equal(await evaluate(visibilitySwitch + '.checked'), false)
  await evaluate(visibilitySwitch + '.click()')
  await click('开始录制')
  await click('创建地形')
  await click('确认创建')
  assert.equal((await state()).assets[0].terrain.surface.layers[0].presetId, 'grass')

  const placeButton = name => evaluate(`[...document.querySelectorAll('.build-model')].find(card => card.querySelector('strong').textContent === ${JSON.stringify(name)}).querySelector('button').click()`)
  const groundPoint = position => evaluate(`(async () => {
    const three = await import('/node_modules/.vite/deps/three.js')
    const pose = __engine.readViewport()
    const q = new three.Quaternion().fromArray(pose.quaternion).invert()
    const ndc = new three.Vector3(...${JSON.stringify(position)}).sub(new three.Vector3(...pose.position))
      .applyQuaternion(q).applyMatrix4(new three.Matrix4().fromArray(pose.projectionMatrix))
    const rect = document.querySelector('.viewport canvas').getBoundingClientRect()
    return { x: rect.left + (1 + ndc.x) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 }
  })()`)
  const clickViewport = async position => {
    const point = await groundPoint(position)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const pressKey = async key => {
    const code = key === 'Escape' ? key : 'Key' + key.toUpperCase()
    const windowsVirtualKeyCode = key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  await placeButton('帐篷')
  await clickViewport([-1, 0, -1.5])
  const tent = (await state()).assets.find(asset => asset.ref === 'models/tent')
  assert.deepEqual(tent?.transform.position, [-1, -(models['models/tent'].bounds?.min[1] ?? 0) || 0, -1.5])
  await placeButton('篝火')
  await pressKey('Escape')
  await clickViewport([2.5, 0, -2])
  assert.equal((await state()).assets.some(asset => asset.ref === 'models/campfire'), false)
  await placeButton('篝火')
  await clickViewport([2.5, 0, -2])
  await evaluate("document.querySelector('.build-checkbox input').click()")
  await placeButton('椅子')
  const beforeTurn = (await state()).assets.length
  const pivot = await groundPoint([2.5, 0, -1])
  const turnEnd = { x: pivot.x + 50, y: pivot.y }
  const cameraBeforeTurn = await evaluate('JSON.stringify(__engine.readViewport())')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pivot })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, ...pivot })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'right', buttons: 2, ...turnEnd })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, ...turnEnd })
  await until(() => evaluate("document.querySelector('.build-placement strong')?.textContent.endsWith('30°')"))
  assert.equal(await evaluate('JSON.stringify(__engine.readViewport())'), cameraBeforeTurn)
  assert.equal((await state()).assets.length, beforeTurn)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...turnEnd })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...turnEnd })
  const firstChair = (await state()).assets.find(asset => asset.ref === 'models/chair')
  assert.deepEqual(firstChair?.transform.position, [2.5, 0, -1])
  await clickViewport([3.5, 0, -1])
  assert.equal((await state()).assets.filter(asset => asset.ref === 'models/chair').length, 2)
  await pressKey('e')
  await until(() => evaluate("document.querySelector('.build-transform-toolbar button[aria-keyshortcuts=E]')?.getAttribute('aria-pressed') === 'true' && !document.querySelector('.build-placement')"))
  await evaluate("document.querySelector('.build-transform-toolbar button[aria-keyshortcuts=R]').click()")
  await until(() => evaluate(`(() => {
    const active = (Array.from(document.querySelectorAll('.build-objects button[aria-pressed=true]')).find(button => button.title.startsWith('asset-')))?.title
    const target = active && __engine.findAssetObject(active);
    return Boolean(target && target.parent.children.some(child => child.object === target && child.mode === 'scale'));
  })()`))
  await click('↩ 撤销')
  assert.equal((await state()).assets.filter(asset => asset.ref === 'models/chair').length, 1)
  assert.equal((await state()).assets.find(asset => asset.ref === 'models/chair').transform.rotation[1], 30)
  await evaluate("document.querySelector('.build-checkbox input').click()")
  await placeButton('树')
  await clickViewport([1, 0, 1.5])
  const tree = (await state()).assets.find(asset => asset.ref === 'models/tree')
  assert.ok(tree)
  await evaluate(`document.querySelector('.build-objects button[title="${tree.id}"]').click()`)
  await click('删除', '.manual-build-panel button')
  assert.equal((await state()).assets.some(asset => asset.id === tree.id), false)
  await click('新建点光源')
  await click('检查器')
  await evaluate(`(() => {
    const field = document.querySelector('.build-side-content input[type=color]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '#ffaa55')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  assert.equal((await state()).lights[0].color, '#ffaa55')
  assert.equal(await evaluate(`__engine.focusAsset('${tent.id}')`), true)
  await until(async () => {
    const endpoint = `${baseUrl}/api/recordings/${sceneId}`
    const [active] = await (await fetch(endpoint)).json()
    if (!active) return false
    const capture = await (await fetch(`${endpoint}/${active.sessionId}`)).json()
    return capture.samples.some(sample => sample.reason === 'camera')
  })
  const chair = (await state()).assets.find(asset => asset.ref === 'models/chair')
  await evaluate(`__edit.setTransform('${chair.id}', {position: [500, 0, 500], rotation: [0, 15, 0]})`)
  await click('↩ 撤销')
  await click('保存场景')
  await until(() => evaluate("document.querySelector('.manual-build-panel > .save-status')?.textContent === '场景已保存'"))
  await click('录制会话')
  await evaluate("document.querySelector('[aria-label=录制]').click()")

  const session = await until(async () => {
    const list = await (await fetch(`${baseUrl}/api/recordings/${sceneId}`)).json()
    const newest = list[0]
    if (newest?.analysisStatus === 'failed') throw new Error(await evaluate("document.querySelector('.build-recordings .error')?.textContent"))
    return newest?.analysisStatus === 'ready' && newest
  }, 60000)
  assert.equal(session.captureStatus, 'saved')
  const recordingPath = `${baseUrl}/api/recordings/${sceneId}/${session.sessionId}`
  const recording = await (await fetch(recordingPath)).json()
  assert.equal(recording.initial.document.assets.length, 0)
  assert.ok(recording.edits.some(event => event.action === 'undo'))
  assert.ok(recording.samples.some(sample => sample.reason === 'camera'))
  assert.ok(recording.visibility.some(row => row.objectId === chair.id && row.status === 'out_of_view' && row.visibilityRatio === null))
  const deletion = recording.edits.find(event => event.action === 'remove_asset' && event.changes[0].objectId === tree.id)
  const before = recording.samples.find(sample => sample.seq === deletion.seq - 1)
  const after = recording.samples.find(sample => sample.seq === deletion.seq + 1)
  assert.deepEqual(before.position, after.position)
  assert.equal(after.sceneRevision, before.sceneRevision + 1)
  const tentVisibility = sample => recording.visibility.find(row => row.objectId === tent.id && row.sampleId === sample.sampleId)
  const occluded = tentVisibility(before)
  const exposed = tentVisibility(after)
  assert.ok(exposed.visibilityRatio > occluded.visibilityRatio, JSON.stringify({ occluded, exposed }))
  assert.ok(exposed.screenOccupancy > occluded.screenOccupancy)
  assert.ok(recording.visibility.some(row => row.status === 'not_applicable'))
  for (const file of ['session.json', 'initial-scene.json', 'edit-events.jsonl', 'viewport-samples.jsonl', 'object-visibility.jsonl']) {
    assert.ok(existsSync(join(root, '.data', 'recordings', sceneId, session.sessionId, file)))
  }
  await until(() => evaluate("Boolean([...document.querySelectorAll('.build-session button')].find(button => button.textContent === '回放'))"))
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(root, 'exports') })
  await click('导出 ZIP')
  const exported = join(root, 'exports', `${sceneId}-${session.sessionId}.zip`)
  await until(() => existsSync(exported))
  const { unzipSync, strFromU8 } = await import('../../src/node_modules/three/examples/jsm/libs/fflate.module.js')
  const archive = unzipSync(readFileSync(exported))
  assert.equal(JSON.parse(strFromU8(archive['session.json'])).sessionId, session.sessionId)
  assert.equal(strFromU8(archive['object-visibility.jsonl']).trim().split('\n').length, recording.visibility.length)
  await click('回放')
  await until(() => evaluate("Boolean(document.querySelector('.build-replay canvas'))"))
  await evaluate("[...document.querySelectorAll('.build-event-list button')].find(button => button.textContent.includes('删除 树')).click()")
  await until(() => evaluate("document.querySelectorAll('.build-replay canvas').length === 2 && document.querySelector('.build-visibility').textContent.includes('→')"))
  await click('关闭', '.build-replay button')
  await click('开始录制')
  await evaluate(visibilitySwitch + '.click()')
  await evaluate("document.querySelector('.topbar select').focus()")
  await evaluate(`(() => {
    const select = document.querySelector('.topbar select')
    select.value = 'garden'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await until(async () => (await state())?.meta.id === 'garden')
  const deferred = await until(async () => {
    const list = await (await fetch(`${baseUrl}/api/recordings/${sceneId}`)).json()
    return list.length === 2 && list.every(item => item.captureStatus === 'saved') && list.find(item => item.sessionId !== session.sessionId)
  })
  assert.equal(deferred.analysisStatus, 'pending')
  const deferredPath = `${baseUrl}/api/recordings/${sceneId}/${deferred.sessionId}`
  const raw = await (await fetch(deferredPath)).json()
  assert.ok(raw.samples.some(sample => sample.reason === 'end'))
  assert.deepEqual(raw.visibility, [])
  assert.equal(existsSync(join(root, '.data', 'recordings', sceneId, deferred.sessionId, 'object-visibility.jsonl')), false)
  assert.deepEqual(await (await fetch(recordingPath)).json(), recording)
  await send('Page.navigate', { url: baseUrl + '/?scene=' + sceneId + '&build=1' })
  await until(async () => (await state().catch(() => null))?.meta.id === sceneId)
  const reopened = await state()
  assert.deepEqual(reopened.assets.map(asset => asset.ref).sort(), ['models/campfire', 'models/chair', 'models/procedural-terrain', 'models/tent'])
  assert.equal(reopened.lights[0].color, '#ffaa55')
  await click('录制会话')
  await until(() => evaluate("[...document.querySelectorAll('.build-session button')].some(button => button.textContent === '计算可见性')"))
  await click('计算可见性')
  await until(async () => {
    const data = await (await fetch(deferredPath)).json()
    return data.session.analysisStatus === 'ready' && data.visibility.length > 0
  }, 45000)
  console.log('PASS: manual construction, undo, scene persistence, recording lifecycle, synchronized playback and occlusion')
  if (!process.argv.includes('--full-build')) return

  const choose = (selector, value) => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)})
    input.value = ${JSON.stringify(value)}
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const treeObject = (id, additive = false) => evaluate(`document.querySelector('.build-objects button[title="${id}"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${additive} }))`)
  const cardButton = (name, label) => evaluate(`[...document.querySelectorAll('.build-model')]
    .find(card => card.querySelector('strong').textContent === ${JSON.stringify(name)})
    .querySelectorAll('button').values().find(button => button.textContent === ${JSON.stringify(label)}).click()`)
  await until(() => evaluate("Boolean(__engine.readViewport() && document.querySelector('.manual-build-panel'))"))
  await evaluate(visibilitySwitch + '.click()')
  await click('开始录制')
  await click('创建基础形体')
  await click('添加形体')
  const box = (await state()).assets.find(asset => asset.shape?.kind === 'box')
  assert.ok(box)
  await cardButton('篝火', '替换所选灰盒')
  assert.equal((await state()).assets.find(asset => asset.id === box.id).ref, 'models/campfire')
  await click('↩ 撤销')
  assert.equal((await state()).assets.find(asset => asset.id === box.id).shape.kind, 'box')
  await treeObject(box.id)
  await treeObject(chair.id, true)
  await click('分组所选')
  const group = (await state()).assets.find(asset => asset.group)
  assert.ok(group)
  assert.equal((await state()).assets.find(asset => asset.id === box.id).parentId, group.id)
  assert.deepEqual((await state()).assets.find(asset => asset.id === box.id).transform, box.transform)
  const groupX = group.transform.position[0]
  assert.equal(await evaluate(`__edit.setTransform('${group.id}', {position:[${groupX + 1.5},0,${group.transform.position[2]}], rotation:[0,0,0]})`), true)
  assert.ok(Math.abs((await state()).assets.find(asset => asset.id === box.id).transform.position[0] - 1.5) < 1e-7)
  await click('↩ 撤销')
  assert.ok(Math.abs((await state()).assets.find(asset => asset.id === box.id).transform.position[0]) < 1e-7)
  await click('↪ 重做')
  await evaluate("document.querySelector('.build-objects [aria-label=\"临时隐藏：对象组\"]').click()")
  await until(() => evaluate(`__engine.findAssetObject('${box.id}')?.visible === false`))
  assert.notEqual((await state()).assets.find(asset => asset.id === box.id).visible, false)
  await evaluate("document.querySelector('.build-objects [aria-label=\"临时隐藏：对象组\"]').click()")

  await click('批量布局')
  await choose('.build-layout-tools select:not([aria-label])', 'array')
  const beforeArray = (await state()).assets.length
  await click('预览布局')
  assert.equal((await state()).assets.length, beforeArray)
  await click('应用布局')
  assert.equal((await state()).assets.length, beforeArray + 9)
  await click('↩ 撤销')
  await click('素材组合')
  await evaluate("document.querySelector('[aria-label=素材组合名称]').focus()")
  await send('Input.insertText', { text: '休息区' })
  await click('保存所选为组合')
  await until(() => evaluate("Boolean(document.querySelector('.build-combinations button[type=submit]')?.disabled && document.querySelector('.build-combinations strong')?.textContent === '休息区')"))
  await click('放置组合')
  await clickViewport([-5, 0, 0])
  assert.equal((await state()).assets.filter(asset => asset.group).length, 2)

  const ground = (await state()).assets.find(asset => asset.terrain)
  await treeObject(ground.id)
  await click('检查器')
  await choose('select[aria-label=搭建视角]', 'top')
  await until(() => evaluate("__engine.readViewport()?.projection === 'orthographic'"))
  const brushNumber = label => `[...document.querySelectorAll('.build-brush label')]
    .find(label => label.textContent.trim() === ${JSON.stringify(label)}).querySelector('input')`
  const typeBrushNumber = async (label, value) => {
    await evaluate(`(() => {
      const field = ${brushNumber(label)}
      field.focus()
      field.select()
    })()`)
    for (const text of value) await send('Input.insertText', { text })
    assert.equal(await evaluate(`${brushNumber(label)}.value`), value)
  }
  await click('地形笔刷')
  await typeBrushNumber('幅度 (m)', '1.25')
  await clickViewport([-4, 0, -3])
  await until(async () => (await state()).assets.find(asset => asset.id === ground.id).terrain.heights.some(value => value > 1))
  await click('材质笔刷')
  await click('添加图层', '.manual-build-panel button')
  assert.equal((await state()).assets.find(asset => asset.id === ground.id).terrain.surface.layers.length, 2)
  await clickViewport([-4, 0, -3])
  await until(async () => (await state()).assets.find(asset => asset.id === ground.id).terrain.surface.weightMap.data.some((value, i) => i % 4 === 1 && value > 0))
  await click('植被笔刷')
  await click('选择散布模型')
  await cardButton('树', '用于散布')
  assert.equal(await evaluate("document.querySelector('select[aria-label=笔刷类型]')?.value"), 'scatter')
  await typeBrushNumber('密度 (个/m²)', '0.05')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const density = () => evaluate("import('/modules/manual-build/terrainBrush.tsx').then(m => m.useBrush.getState().density)")
  assert.equal(await density(), 0.05)
  await typeBrushNumber('密度 (个/m²)', '11')
  await evaluate('document.activeElement.blur()')
  assert.equal(await density(), 0.05)
  assert.equal(await evaluate(`${brushNumber('密度 (个/m²)')}.value`), '0.05')
  await typeBrushNumber('密度 (个/m²)', '0.5')
  await clickViewport([4, 0, 3])
  await until(async () => (await state()).assets.some(asset => asset.scatterTerrainId === ground.id))
  await choose('select[aria-label=笔刷类型]', 'erase')
  await clickViewport([4, 0, 3])
  await until(async () => !(await state()).assets.some(asset => asset.scatterTerrainId === ground.id))
  await click('结束笔刷')
  await choose('select[aria-label=搭建视角]', 'perspective')
  await until(() => evaluate("__engine.readViewport()?.projection === 'perspective'"))

  await click('导入 GLB')
  const { root: domRoot } = await send('DOM.getDocument')
  const { nodeId } = await send('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '.build-import input[type=file]' })
  const modelPath = resolve(source, '../assets/models/demo-forest-pine-tree/model/AF-1792510894520861100.glb')
  await send('DOM.setFileInputFiles', { nodeId, files: [modelPath] })
  await evaluate("document.querySelector('.build-import input[min=\"0.00001\"]').focus(); document.activeElement.select()")
  await send('Input.insertText', { text: '0.01' })
  await click('校验并预览')
  await until(() => evaluate("Boolean(document.querySelector('.build-import-preview canvas') && !document.querySelector('.build-import-preview button')?.disabled)"))
  await click('确认入库')
  const imported = await until(async () => {
    const list = await (await fetch(baseUrl + '/api/build-models')).json()
    return Object.entries(list)[0]
  })
  assert.equal((await fetch(baseUrl + imported[1].source.url)).status, 200)
  await choose('select[aria-label=素材类别]', '手工导入')
  await cardButton(imported[1].name, '放置')
  await clickViewport([4, 0, -3])
  await until(async () => (await state()).assets.some(asset => asset.ref === imported[0]))
  await click('保存场景')
  await evaluate("document.querySelector('[aria-label=录制]').click()")
  const fullSession = await until(async () => {
    const [newest] = await (await fetch(`${baseUrl}/api/recordings/${sceneId}`)).json()
    if (newest?.analysisStatus === 'failed') throw new Error(await evaluate("document.querySelector('.build-recordings .error')?.textContent"))
    return newest?.sessionId !== session.sessionId && newest?.analysisStatus === 'ready' && newest
  }, 120000)
  const full = await (await fetch(`${baseUrl}/api/recordings/${sceneId}/${fullSession.sessionId}`)).json()
  assert.ok(full.edits.some(event => event.changes.some(change => change.terrainDelta?.heights?.changes.length)))
  assert.ok(full.edits.some(event => event.changes.some(change => change.terrainDelta?.weights?.changes.length)))
  assert.ok(full.edits.some(event => event.changes.some(change => change.objectType === 'group' && change.worldPositionBefore?.[0] !== change.worldPositionAfter?.[0]) &&
    event.changes.some(change => change.objectId === box.id && change.worldPositionBefore?.[0] !== change.worldPositionAfter?.[0])))
  assert.ok(full.samples.some(sample => sample.projection === 'orthographic'))
  await send('Page.navigate', { url: baseUrl + '/?scene=' + sceneId + '&build=1' })
  await until(async () => (await state().catch(() => null))?.meta.id === sceneId)
  assert.equal((await state()).assets.find(asset => asset.id === box.id).parentId, group.id)
  assert.ok((await state()).assets.some(asset => asset.ref === imported[0]))
  assert.ok((await state()).assets.find(asset => asset.id === ground.id).terrain.heights.some(value => value > 0.1))
  console.log('PASS: full build hierarchy, grouped transforms, array preview, combinations, terrain brushes, GLB import and recording')
}

let modelRequests = 0
let stallNextFinal = false
let rejectNextFinal = false
const requestedModels = []
const mockModel = createMockServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString())
  modelRequests++
  requestedModels.push(input.model)
  const hasTools = input.messages.some(message => message.role === 'tool')
  const retry = input.messages.at(-1)?.role === 'user' && String(input.messages.at(-1).content).includes('离门太近')
  const accepted = input.messages.at(-1)?.role === 'user' && String(input.messages.at(-1).content).includes('[系统] 用户接受了本批提案')
  const final = hasTools && (input.messages.at(-1)?.role !== 'user' || accepted)
  const stall = final && stallNextFinal
  if (stall) stallNextFinal = false
  await sleep(stall ? 6500 : 1500)
  if (res.destroyed) return
  res.setHeader('Content-Type', 'text/event-stream')
  if (final && rejectNextFinal) {
    rejectNextFinal = false
    res.end('data: {"error":{"code":"data_inspection_failed","message":"mock provider rejection"}}\n\n')
    return
  }
  const delta = final ? { content: '椅子已移动，请确认。' } : { content: '开始移动椅子', tool_calls: [{ index: 0, id: 'move-once', type: 'function', function: { name: 'asset_adjust_transform', arguments: JSON.stringify({ assetId: 'chair', translate: retry ? [-2,0,0] : [1,0,0] }) } }] }
  res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
  res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: final ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
})
try {
  await new Promise(resolve => mockModel.listen(0, '127.0.0.1', resolve))
  await vite.listen()
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/tests/workspace.html`
  const testLights = process.argv.includes('--lights-only')
  const testBuild = process.argv.includes('--build-only')
  const graphics = testLights || testBuild ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900'] : ['--disable-gpu']
  browser = spawn(edge, ['--headless=new', ...graphics, '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  await until(() => existsSync(portFile))
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(targets.find(t => t.type === 'page' && t.url === 'about:blank').webSocketDebuggerUrl)
  await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true}) })
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if ((testLights || testBuild) && message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      console.error(details.exception?.description ?? details.text)
    }
    if ((testLights || testBuild) && message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      console.error(message.params.args.map(arg => arg.value ?? arg.description).join(' '))
    }
    const call = calls.get(message.id)
    if (!call) return
    calls.delete(message.id);clearTimeout(call.timer)
    message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result)
  })
  await send('Page.enable')
  if (testLights || testBuild) {
    await send('Runtime.enable')
    await send('Page.bringToFront')
    if (testLights) await testSceneLights(new URL(url).origin)
    if (testBuild) await testManualBuild(new URL(url).origin)
  } else {
  await send('Page.navigate', { url })
  await until(() => evaluate('document.readyState === "complete"').catch(() => false))
  // Simulate a pre-upgrade installation with a durable, not-yet-sent v1 job.
  await evaluate(`(async()=>{
    sessionStorage.setItem('layout-client-id','migration-client');
    await new Promise((resolve,reject)=>{
      const request=indexedDB.open('3d-layout-workspaces',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('pending',{keyPath:'requestId'});
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const database=request.result,tx=database.transaction('pending','readwrite');
        const document={meta:{id:'room',name:'房间',version:1,unit:'m',up:'+Y'},assets:[${JSON.stringify(original)}],environment:{},cameras:[]};
        const job={requestId:'legacy-v1',clientId:'migration-client',sceneId:'room',baseRevision:0,workspace:{document,journal:[],redoStack:[],txCounter:0},label:'legacy save'};
        tx.objectStore('pending').put(job);
        tx.objectStore('pending').put({...job,requestId:'other-tab',clientId:'another-client'});
        tx.oncomplete=()=>{database.close();resolve()};tx.onerror=()=>reject(tx.error);
      };
    });
  })()`)
  await initialize()
  await evaluate('persistence.flushWorkspace()')
  const migratedQueue = await evaluate(`new Promise((resolve,reject)=>{
    const request=indexedDB.open('3d-layout-workspaces');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const database=request.result,tx=database.transaction('pending');
      const result=tx.objectStore('pending').getAllKeys();
      tx.oncomplete=()=>{const state={version:database.version,keys:result.result};database.close();resolve(state)};
    };
  })`)
  assert.equal(migratedQueue.version,2)
  assert.deepEqual(migratedQueue.keys,['other-tab'])
  console.log('PASS: v1 pending queue upgrades without loss and isolates other clients')
  if (!process.argv.includes('--lease-only')) {
  await evaluate(`(async()=>{
    const reactModule=await import('/node_modules/.vite/deps/react.js');
    const React=reactModule.default??reactModule;
    const domModule=await import('/node_modules/.vite/deps/react-dom_client.js');
    const {createRoot}=domModule.default??domModule;
    const {useEditorModule}=await import('/modules/editor/useEditorModule.ts');
    window.selectionBus=(await import('/core/events.ts')).bus;
    const container=document.createElement('div');document.body.appendChild(container);
    window.selectionProbe=createRoot(container);
    function Probe(){useEditorModule(false,true);return null}
    selectionProbe.render(React.createElement(Probe));
    await new Promise(resolve=>setTimeout(resolve,100));
    selectionBus.emit('asset:clicked',{assetId:'chair'});
  })()`)
  assert.equal(await evaluate('store.getState().selectedAssetId'),'chair')
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}))`)
  assert.equal(await evaluate('store.getState().document.assets.length'),1)
  await evaluate(`selectionBus.emit('viewport:empty-click',{})`)
  assert.equal(await evaluate('store.getState().selectedAssetId'),null)
  await evaluate('selectionProbe.unmount()')
  console.log('PASS: selection stays enabled while manual editing and shortcuts are locked')
  const conversationChecks = await evaluate(`(async()=>{
    const counts=[];
    for(const path of ['/modules/agent/agentStore.ts','/modules/llm-agent/agentStore.ts']) {
      const state=(await import(path)).useAgentStore.getState();const previous=state.chat;
      state.replaceChat([{role:'user',text:'最初的装修指令'},...Array.from({length:250},()=>({role:'note',text:'工具调用'})),{role:'user',text:'保留通道，请继续调整'}]);
      const current=(await import(path)).useAgentStore.getState().chat;
      counts.push({length:current.length,first:current[0].text,last:current.at(-1).text});
      state.replaceChat(previous);
    }
    return counts;
  })()`)
  for (const conversation of conversationChecks) {
    assert.equal(conversation.length,252)
    assert.equal(conversation.first,'最初的装修指令')
    assert.equal(conversation.last,'保留通道，请继续调整')
  }
  console.log('PASS: long durable conversations keep original instructions and feedback in both AI panels')
  const catalogueChecks = await evaluate(`(async()=>{
    const previous=store.getState().manifest;
    const models={};
    for(let i=0;i<1146;i++){
      const ref=i===0?'models/chair':'models/item-'+i;
      models[ref]={id:ref,name:i===0?'Chair':i<=30?'Luxury chandelier '+i:'Ordinary object '+i,
        category:i<=30?'lighting':'other',dimensions:{w:1,h:2,d:1},source:{type:'primitive',shape:'box'}};
    }
    store.setState({manifest:{models,generatedAt:''}});
    const capabilities=(await import('/core/agentCapabilities.ts')).useAgentCapabilities;
    const originalCapabilities={...capabilities.getState()};capabilities.setState({modelSearch:true});
    try {
      const registry=(await import('/modules/agent/tools.ts')).AGENT_TOOLS;
      const experimental=(await import('/modules/llm-agent/tools.ts')).AGENT_TOOLS;
      const state=registry.find(t=>t.name==='scene.get_state');
      const compact=state.exec({}, {tx:null});
      const explicit=state.exec({includeManifest:true},{tx:null});
      const search=registry.find(t=>t.name==='model.search');
      const first=search.exec({query:'豪华',limit:12},{tx:null});
      const second=search.exec({query:'豪华',limit:12,offset:12},{tx:null});
      let invalid=false;try{search.exec({query:'lamp',limit:1000},{tx:null})}catch{invalid=true}
      return {manifest:compact.manifest,total:compact.modelLibrary.total,refs:Object.keys(explicit.manifest),
        count:first.models.length,next:first.nextOffset,totalMatches:first.total,
        overlap:first.models.some(a=>second.models.some(b=>b.ref===a.ref)),
        missing:search.exec({query:'no-such-model-12345'},{tx:null}).total,invalid,
        experimental:experimental.find(t=>t.name==='scene.get_state').exec({}, {tx:null}).manifest,
        chars:JSON.stringify(compact).length};
    } finally {store.setState({manifest:previous});capabilities.setState(originalCapabilities)}
  })()`)
  assert.equal(catalogueChecks.manifest,null)
  assert.equal(catalogueChecks.experimental,null)
  assert.equal(catalogueChecks.total,1146)
  assert.deepEqual(catalogueChecks.refs,['models/chair'])
  assert.equal(catalogueChecks.count,12)
  assert.equal(catalogueChecks.next,12)
  assert.equal(catalogueChecks.totalMatches,30)
  assert.equal(catalogueChecks.overlap,false)
  assert.equal(catalogueChecks.missing,0)
  assert.equal(catalogueChecks.invalid,true)
  assert.ok(catalogueChecks.chars<3000)
  console.log('PASS: 1146-model catalogue is excluded from snapshots; bilingual search is bounded and paginated')
  const reviewChecks = await evaluate(`(async()=>{
    const {assetChanges,assetBox}=await import('/core/aiReview.ts');
    const before=structuredClone(store.getState().document);
    before.assets.push({...structuredClone(before.assets[0]),id:'deleted'});
    const after=structuredClone(before);
    after.assets=after.assets.filter(a=>a.id!=='deleted');
    after.assets[0].transform.position=[2,0,0];
    after.assets.push({...structuredClone(after.assets[0]),id:'new'});
    const changes=assetChanges(before,after);
    const equivalent=structuredClone(before);equivalent.assets[0].transform.scale=[1,1,1];equivalent.assets[0].visible=true;
    const transformed={...before.assets[0],transform:{position:[10,0,0],rotation:[0,90,0],scale:[-2,1,1]}};
    const box=assetBox(transformed,{models:{'models/chair':{bounds:{min:[0,0,0],max:[1,2,3]}}}});
    return {kinds:changes.map(c=>c.kind),fields:changes.find(c=>c.id==='chair').fields,
      equivalent:assetChanges(before,equivalent).length,min:box.min.toArray(),max:box.max.toArray()};
  })()`)
  assert.deepEqual(reviewChecks.kinds,['removed','modified','added'])
  assert.deepEqual(reviewChecks.fields,['位置'])
  assert.equal(reviewChecks.equivalent,0)
  reviewChecks.min.forEach((n,i)=>assert.ok(Math.abs(n-[10,0,0][i])<1e-6))
  reviewChecks.max.forEach((n,i)=>assert.ok(Math.abs(n-[13,2,2][i])<1e-6))
  console.log('PASS: review detects net changes and transforms offset bounds with rotation and negative scale')
  const overlapChecks = await evaluate(`(async()=>{
    const {checkSceneOverlaps}=await import('/core/sceneOverlaps.ts');
    const model={id:'box',name:'方块',dimensions:{w:1,h:1,d:1},source:{type:'primitive',shape:'box'}};
    const manifest={generatedAt:'',models:{box:model}};
    const asset=(id,x,extra={})=>({id,ref:'box',transform:{position:[x,0,0],rotation:[0,0,0]},...extra});
    const document={...store.getState().document,assets:[asset('a',0),asset('b',0.5),asset('touching',1.5),asset('hidden',0,{visible:false}),asset('unknown',0,{ref:'missing'})]};
    const result=checkSceneOverlaps(document,manifest,{});
    const ignored=checkSceneOverlaps(document,manifest,{ignoreAssetIds:['b']});
    const scoped=checkSceneOverlaps(document,manifest,{assetIds:['touching']});
    const dense={...document,assets:[asset('a',0),asset('b',0),asset('c',0)]};
    const page=checkSceneOverlaps(dense,manifest,{limit:1});
    const second=checkSceneOverlaps(dense,manifest,{limit:1,offset:1});
    return {pairs:result.overlaps.map(p=>[p.a.id,p.b.id]),size:result.overlaps[0].overlap.size,
      exact:result.exactCollision,skipped:result.skippedAssets,ignored:ignored.overlaps.length,scoped:scoped.overlaps.length,
      next:page.nextOffset,first:page.overlaps[0].b.id,second:second.overlaps[0].b.id};
  })()`)
  assert.deepEqual(overlapChecks.pairs,[['a','b']])
  assert.deepEqual(overlapChecks.size,[0.5,1,1])
  assert.equal(overlapChecks.exact,false)
  assert.deepEqual(overlapChecks.skipped,['unknown'])
  assert.equal(overlapChecks.ignored,0)
  assert.equal(overlapChecks.scoped,0)
  assert.equal(overlapChecks.next,1)
  assert.notEqual(overlapChecks.first,overlapChecks.second)
  console.log('PASS: overlap broad phase reports bounds, excludes touching/hidden objects, supports scope and pagination')
  await evaluate(`(async()=>{const tx=edit.begin('拖动椅子');for(let i=1;i<=100;i++)edit.setTransform('chair',{position:[i/10,0,0],rotation:[0,0,0]},{tx});tx.commit();await persistence.flushWorkspace()})()`)
  assert.equal(await evaluate('edit.historyUnits().length'),1)
  assert.equal(await evaluate('edit.history().length'),1)
  await reload();assert.equal(await position(),10)
  assert.equal(await evaluate('edit.historyUnits().length'),1)
  await evaluate('(async()=>{edit.undo();await persistence.flushWorkspace()})()')
  await reload();assert.equal(await position(),0);assert.equal(await evaluate('edit.canRedo'),true)
  await evaluate('(async()=>{edit.redo();await persistence.flushWorkspace()})()')
  await reload();assert.equal(await position(),10)
  await evaluate(`(async()=>{await store.getState().loadScene('garden');await store.getState().loadScene('room')})()`)
  assert.equal(await position(),10);assert.equal(await evaluate('edit.historyUnits().length'),1)
  console.log('PASS: drag compaction, refresh, undo/redo across refresh')

  await evaluate(`(async()=>{
    const nativeFetch=window.fetch;window.fetch=(url,options)=>options?.method==='POST'?Promise.reject(Error('offline')):nativeFetch(url,options);
    for(let i=20;i<=22;i++) edit.setTransform('chair',{position:[i,0,0],rotation:[0,0,0]});
    try{await persistence.flushWorkspace()}catch{}
  })()`)
  assert.equal(await evaluate('persistence.usePersistence.getState().status'),'offline')
  await reload();await evaluate('persistence.flushWorkspace()');assert.equal(await position(),22)
  console.log('PASS: IndexedDB pending edits survive refresh and retry')

  await evaluate(`(async()=>{
    const nativeFetch=window.fetch;window.fetch=async(url,options)=>{const result=await nativeFetch(url,options);if(options?.method==='POST')throw Error('lost response');return result};
    edit.setTransform('chair',{position:[30,0,0],rotation:[0,0,0]});try{await persistence.flushWorkspace()}catch{}
  })()`)
  await reload();await evaluate('persistence.flushWorkspace()');assert.equal(await position(),30)
  console.log('PASS: lost response retries idempotently')

  await evaluate(`(async()=>{
    const current=await(await fetch('/api/workspaces/room')).json();
    current.workspace.document.meta.name='另一个标签页';
    await fetch('/api/workspaces/room',{method:'POST',headers:{'Content-Type':'application/json','X-Layout-Client':'1'},body:JSON.stringify({requestId:crypto.randomUUID(),baseRevision:current.revision,workspace:current.workspace})});
    edit.setTransform('chair',{position:[40,0,0],rotation:[0,0,0]});try{await persistence.flushWorkspace()}catch{}
  })()`)
  assert.equal(await evaluate('persistence.usePersistence.getState().status'),'conflict')
  await evaluate('persistence.discardPending()');await reload();assert.equal(await position(),30)
  console.log('PASS: stale tab cannot overwrite server; explicit discard recovers')

  const setupAgent = async () => evaluate(`(async()=>{
    window.agentStore=(await import('/modules/agent/agentStore.ts')).useAgentStore;
    window.agentSession=(await import('/modules/agent/session.ts')).agentSession;
    const settings=(await import('/modules/agent/llmSettings.ts')).useLlmSettingsStore;
    settings.setState({activeId:'test',profiles:[{id:'test',name:'test',provider:'custom',protocol:'openai-chat',baseURL:'http://127.0.0.1:${mockModel.address().port}',apiKey:'test-key',model:'test',sendImages:false}]});
    agentStore.getState().setPermissionMode('confirm');agentSession.start();
  })()`)
  await setupAgent()
  await evaluate(`agentSession.sendChat('将椅子移动一米')`)
  await until(async () => (await evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>!!t?.id)`)))
  await reload();await setupAgent()
  await evaluate(`{
    const nativeFetch=window.fetch;
    window.fetch=async(url, options)=>{
      const result=await nativeFetch(url,options);
      if(String(url).includes('/api/tasks/') && String(url).endsWith('/result')) throw Error('tool ACK lost');
      return result;
    };
  }`)
  await until(() => evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t?.calls.some(c=>c.result))`))
  await reload();await setupAgent()
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(await position(),31)
  assert.ok(await evaluate(`agentStore.getState().task.detail.includes('第 2 轮模型请求')`))
  assert.ok(await evaluate(`agentStore.getState().chat.some(m=>m.role==='note' && m.text.includes('轮模型请求'))`))
  assert.ok(await evaluate(`agentStore.getState().chat.some(m=>m.text.includes('将椅子移动一米'))`))
  await evaluate(`(async()=>{
    window.review=(await import('/core/aiReview.ts')).useAiReview;
    const reactModule=await import('/node_modules/.vite/deps/react.js');
    const React=reactModule.default??reactModule;
    const domModule=await import('/node_modules/.vite/deps/react-dom_client.js');
    const {createRoot}=domModule.default??domModule;
    const {AiReviewPanel}=await import('/components/AiReviewPanel.tsx');
    const {AiReviewOverlay}=await import('/components/AiReviewOverlay.tsx');
    const {Canvas,useThree}=await import('/node_modules/.vite/deps/@react-three_fiber.js');
    function Probe(){window.reviewScene=useThree(s=>s.scene);return null}
    const container=document.createElement('div');container.style.cssText='width:400px;height:480px';document.body.appendChild(container);
    window.reviewRoot=createRoot(container);
    reviewRoot.render(React.createElement(React.Fragment,null,
      React.createElement(AiReviewPanel,{channel:'agent'}),
      React.createElement('div',{style:{height:240}},React.createElement(Canvas,null,React.createElement(Probe),React.createElement(AiReviewOverlay)))));
    const {engine}=await import('/core/engine.ts');window.originalFocus=engine.focusBounds;
    engine.focusBounds=box=>{window.reviewFocus=box.getCenter(new (box.min.constructor)()).toArray();return true};
  })()`)
  await until(() => evaluate(`document.querySelectorAll('.ai-review-item').length===1 && !!window.reviewScene`))
  assert.ok(await evaluate(`document.querySelector('.ai-review-item').textContent.includes('(30, 0, 0) → (31, 0, 0)')`))
  await evaluate(`document.querySelector('.ai-review-item').click()`)
  assert.equal(await evaluate('store.getState().selectedAssetId'),'chair')
  assert.equal(await evaluate('reviewFocus[0]'),31)
  await until(() => evaluate(`{let count=0;reviewScene.traverse(o=>{if(o.isMesh)count++});count===2}`))
  await evaluate(`document.querySelectorAll('.ai-review-options input')[1].click()`)
  await until(() => evaluate(`{let count=0;reviewScene.traverse(o=>{if(o.isMesh)count++});count===1}`))
  await evaluate(`(async()=>{reviewRoot.unmount();(await import('/core/engine.ts')).engine.focusBounds=originalFocus})()`)
  console.log('PASS: review panel shows before/after positions, locates objects and toggles viewport ranges')
  // Hold an old-scene response until after switching; it must not repopulate the panel.
  await evaluate(`{
    const nativeFetch=window.fetch;
    window.fetch=async(url,options)=>{
      const response=await nativeFetch(url,options);
      if(String(url).startsWith('/api/tasks?sceneId=room')) {
        window.fetch=nativeFetch;
        await new Promise(resolve=>window.releaseOldScene=resolve);
      }
      return response;
    };
  }`)
  await until(() => evaluate(`typeof window.releaseOldScene==='function'`))
  await evaluate(`store.getState().loadScene('garden')`)
  assert.equal(await evaluate('agentStore.getState().chat.length'),0)
  assert.equal(await evaluate('review.getState().before'),null)
  await evaluate('releaseOldScene()')
  await sleep(1200)
  assert.equal(await evaluate('agentStore.getState().chat.length'),0)
  assert.equal(await evaluate('agentStore.getState().llmBusy'),false)
  assert.equal(await evaluate('store.getState().document.meta.id'),'garden')
  await evaluate(`store.getState().loadScene('room')`)
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(await position(),31)
  assert.equal(await evaluate('review.getState().before.assets[0].transform.position[0]'),30)
  assert.ok(await evaluate(`agentStore.getState().chat.some(m=>m.text.includes('将椅子移动一米'))`))
  console.log('PASS: scene switch clears chat, ignores stale responses and restores the original proposal')
  await reload();await setupAgent()
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(await position(),31)
  await evaluate(`agentSession.reject('离门太近，请移到另一侧')`)
  await until(() => evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t?.reviewVersion===1)`))
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user' && store.getState().document.assets[0].transform.position[0]===28`))
  assert.ok(await evaluate(`agentStore.getState().chat.some(m=>m.text.includes('离门太近'))`))
  assert.equal(await evaluate(`agentStore.getState().chat.filter(m=>m.role==='user' && m.text==='离门太近，请移到另一侧').length`),1)
  await reload();await setupAgent()
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(await position(),28)
  assert.equal(await evaluate(`agentStore.getState().chat.filter(m=>m.role==='user' && m.text==='离门太近，请移到另一侧').length`),1)
  assert.ok(await evaluate(`agentStore.getState().chat.some(m=>m.role==='user' && m.text==='将椅子移动一米')`))
  await evaluate(`agentSession.accept()`)
  await until(() => evaluate(`!agentStore.getState().llmBusy && store.getState().document.assets[0].transform.position[0]===28`))
  await evaluate(`agentSession.stop()`)
  await reload();assert.equal(await position(),28)
  assert.equal(modelRequests,4)
  console.log('PASS: AI refresh, lost tool ACK, reject with feedback, revised proposal, refresh and final acceptance')
  stallNextFinal = true
  await setupAgent()
  await evaluate(`agentSession.sendChat('再移动椅子一米')`)
  await until(() => evaluate(`agentStore.getState().task?.retryable===true`))
  assert.equal(await position(),29)
  await reload();await setupAgent()
  await until(() => evaluate(`agentStore.getState().task?.retryable===true`))
  assert.equal(await position(),29)
  await evaluate(`(async()=>{
    const reactModule=await import('/node_modules/.vite/deps/react.js');const React=reactModule.default??reactModule;
    const dom=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=dom.default??dom;
    const {AgentPanel}=await import('/modules/agent/AgentPanel.tsx');
    const container=document.createElement('div');document.body.appendChild(container);window.retryPanel=createRoot(container);
    retryPanel.render(React.createElement(AgentPanel));
  })()`)
  await until(() => evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='重试本轮')`))
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试本轮').click()`)
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(await position(),29)
  assert.equal(await evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t.calls.length)`),1)
  assert.ok(await evaluate(`document.querySelector('.agent-task').textContent.includes('尚未保存')`))
  await evaluate(`agentSession.revise('修正穿模，保留其他物体')`)
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user' && store.getState().document.assets[0].transform.position[0]===30`))
  assert.equal(await evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t.calls.length)`),2)
  await evaluate(`agentSession.accept()`)
  await until(() => evaluate(`!agentStore.getState().llmBusy`))
  await evaluate(`retryPanel.unmount();agentSession.stop()`)
  await reload();assert.equal(await position(),30)
  assert.equal(modelRequests,9)
  console.log('PASS: timeout preserves preview across refresh; retry button skips completed tools; local revision retains draft')
  rejectNextFinal = true
  await setupAgent()
  await evaluate(`agentSession.sendChat('再微调椅子一米')`)
  await until(() => evaluate(`agentStore.getState().task?.retryable===true`))
  assert.equal(await position(),31)
  assert.ok(await evaluate(`agentStore.getState().task.label.includes('模型服务拒绝或出错')`))
  const pausedRequests = modelRequests
  await sleep(1200)
  assert.equal(modelRequests,pausedRequests)
  await reload();await setupAgent()
  await until(() => evaluate(`agentStore.getState().task?.retryable===true`))
  assert.equal(await position(),31)
  await evaluate(`(async()=>{
    const settings=(await import('/modules/agent/llmSettings.ts')).useLlmSettingsStore;
    const profile=settings.getState().profiles[0];settings.setState({profiles:[profile,{...profile,id:'replacement',name:'替代模型',model:'replacement-model'}]});
    const reactModule=await import('/node_modules/.vite/deps/react.js');const React=reactModule.default??reactModule;
    const dom=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=dom.default??dom;
    const {AgentPanel}=await import('/modules/agent/AgentPanel.tsx');
    const container=document.createElement('div');document.body.appendChild(container);window.recoveryPanel=createRoot(container);
    recoveryPanel.render(React.createElement(AgentPanel));
  })()`)
  await until(() => evaluate(`!!document.querySelector('.agent-profile-select')`))
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='更换模型设置')`))
  await evaluate(`{
    const select=document.querySelector('.agent-profile-select');select.value='replacement';select.dispatchEvent(new Event('change',{bubbles:true}));
    Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试本轮').click();
  }`)
  await until(() => evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(requestedModels.at(-1),'replacement-model')
  assert.equal(await position(),31)
  assert.equal(await evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t.calls.length)`),1)
  await evaluate(`agentSession.accept()`)
  await until(() => evaluate(`!agentStore.getState().llmBusy`))
  await evaluate(`recoveryPanel.unmount();agentSession.stop()`)
  await reload();assert.equal(await position(),31)
  console.log('PASS: provider rejection preserves draft across refresh; no automatic retry; selected replacement model continues without tool replay')
  await setupAgent()
  await until(() => evaluate(`agentStore.getState().chat.length>0 && !agentStore.getState().llmBusy`))
  await evaluate(`{
    const nativeFetch=window.fetch;window.clearNativeFetch=nativeFetch;
    window.fetch=(url,options)=>String(url).endsWith('/clear')?Promise.resolve(new Response('',{status:404})):nativeFetch(url,options);
    agentSession.clearChat();
  }`)
  await until(() => evaluate(`agentStore.getState().chat.some(m=>m.text.includes('后端接口不存在'))`))
  assert.ok(await evaluate(`agentStore.getState().chat.some(m=>m.role==='user')`))
  assert.ok(!(await evaluate(`agentStore.getState().chat.some(m=>m.text.includes('Unexpected end'))`)))
  await evaluate(`window.fetch=clearNativeFetch`)
  await evaluate(`agentSession.clearChat()`)
  await until(() => evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t===null && agentStore.getState().chat.length===0)`))
  await reload();await setupAgent();await sleep(1000)
  assert.equal(await evaluate(`agentStore.getState().chat.length`),0)
  assert.equal(await position(),31)
  await evaluate(`agentSession.stop()`)
  console.log('PASS: clearing conversation survives refresh and keeps the saved scene unchanged')
  await reload();await setupAgent()
  await evaluate(`window.originalBaseline=true;agentSession.sendChat('移动椅子一米')`)
  await until(()=>evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(await position(),32)
  assert.equal(await evaluate(`fetch('/api/workspaces/room').then(r=>r.json()).then(w=>w.workspace.document.assets[0].transform.position[0])`),31)
  assert.equal(await evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t.workflow)`),'original')
  await evaluate(`agentSession.accept()`)
  await until(()=>evaluate(`!agentStore.getState().llmBusy && !store.getState().loading`))
  await until(()=>evaluate(`agentStore.getState().chat.length>0`))
  assert.equal(await position(),32)
  await evaluate(`agentSession.sendChat('再移动那把椅子一米')`)
  await until(()=>evaluate(`agentStore.getState().phase==='awaiting_user'`))
  assert.equal(await position(),33)
  await evaluate(`agentSession.reject('离门太近，只撤回本批')`)
  await until(()=>evaluate(`agentStore.getState().phase==='awaiting_user' && store.getState().document.assets[0].transform.position[0]===30`))
  assert.equal(await evaluate(`fetch('/api/workspaces/room').then(r=>r.json()).then(w=>w.workspace.document.assets[0].transform.position[0])`),32)
  await evaluate(`agentSession.accept()`)
  await until(()=>evaluate(`!agentStore.getState().llmBusy`))
  await evaluate(`agentSession.stop()`)
  await reload();assert.equal(await position(),30)
  console.log('PASS: original baseline waits after each write batch, accepts then continues, rejects only the current batch and preserves accepted edits')
  }
  const slowBase = await position()
  await evaluate(`(async()=>{
    window.originalBaseline=true;
    window.agentStore=(await import('/modules/agent/agentStore.ts')).useAgentStore;
    const {ServerAgentTransport}=await import('/core/serverAgentTransport.ts');
    window.leaseToolRuns=0;window.leaseHeartbeats=0;window.leaseResultPosts=0;
    const nativeFetch=window.fetch;
    window.fetch=(url,options)=>{
      if(String(url).endsWith('/lease'))leaseHeartbeats++;
      if(String(url).endsWith('/result')){
        leaseResultPosts++;
        if(leaseResultPosts===1)return Promise.resolve(new Response(JSON.stringify({error:'工具租约已失效，请重新连接'}),{status:409,headers:{'Content-Type':'application/json'}}));
      }
      return nativeFetch(url,options);
    };
    agentStore.getState().setPermissionMode('auto');
    window.slowTransport=new ServerAgentTransport({channel:'agent',view:()=>agentStore.getState(),
      settings:()=>({provider:'custom',protocol:'openai-chat',baseURL:'http://127.0.0.1:${mockModel.address().port}',apiKey:'test-key',model:'test',sendImages:false}),
      system:'edit',tools:[{name:'asset.adjust_transform',access:'write',description:'move',argsDoc:'{}',schema:{type:'object'}}],
      runTool:async(name,args,tx)=>{
        leaseToolRuns++;
        await new Promise(resolve=>setTimeout(resolve,9500));
        const asset=store.getState().document.assets[0];
        edit.setTransform(asset.id,{...asset.transform,position:[asset.transform.position[0]+1,0,0]},{tx});
        return {ok:true,data:{moved:true}};
      }});
    slowTransport.start({onStatus:()=>{},onInbound:()=>{}});
    await slowTransport.sendUserMessage('缓慢移动椅子一次');
  })()`)
  await until(()=>evaluate(`leaseToolRuns===1 && !agentStore.getState().llmBusy && !store.getState().loading && store.getState().document.assets[0].transform.position[0]===${slowBase + 1}`))
  assert.equal(await evaluate('leaseToolRuns'),1)
  assert.equal(await evaluate('leaseResultPosts'),2)
  assert.ok(await evaluate('leaseHeartbeats>=4'))
  assert.equal(await evaluate(`fetch('/api/tasks?sceneId=room&channel=agent').then(r=>r.json()).then(t=>t.calls.filter(c=>c.result).length)`),1)
  await evaluate('slowTransport.stop()')
  console.log('PASS: tool lasting beyond 8 seconds renews independently; rejected ACK retries the receipt once without rerunning the tool')
  }
} finally {
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve))
    if (ws?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    const closed = await Promise.race([exited.then(() => true), sleep(3000).then(() => false)])
    if (!closed) { browser.kill(); await exited }
  }
  ws?.close()
  await vite.close()
  await new Promise(resolve => mockModel.close(resolve))
  // Chromium subprocesses may briefly retain profile files on Windows.
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  catch { console.warn(`临时浏览器目录仍被占用，可稍后清理：${root}`) }
}
