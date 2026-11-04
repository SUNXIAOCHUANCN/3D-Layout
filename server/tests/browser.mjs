import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
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
async function until(fn) {
  const deadline = Date.now() + 20000
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
  browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  await until(() => existsSync(portFile))
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve,reject) => { ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true}) })
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);const call = calls.get(message.id)
    if (!call) return
    calls.delete(message.id);clearTimeout(call.timer)
    message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result)
  })
  await send('Page.enable');await send('Page.navigate', { url });await initialize()
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
