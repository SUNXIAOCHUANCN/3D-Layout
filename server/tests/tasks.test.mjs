import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRepository } from '../workspaces.mjs'
import { TaskService } from '../tasks.mjs'

const settings = { baseURL: 'http://model.invalid', apiKey: 'secret-for-test', model: 'test', protocol: 'openai-chat' }
const tools = [{ name: 'asset.adjust_transform', access: 'write', description: 'move', schema: {} }]
function setup(t, requestModel) {
  const root = mkdtempSync(join(tmpdir(), 'layout-tasks-'))
  mkdirSync(join(root, 'scenes/room'), { recursive: true })
  writeFileSync(join(root, 'scenes/room/scene.json'), JSON.stringify({ meta: { id: 'room', name: 'room', version: 1, unit: 'm', up: '+Y' }, environment: {}, cameras: [], assets: [{ id: 'chair', ref: 'models/chair', transform: { position: [0,0,0], rotation: [0,0,0] } }] }))
  const repo = new WorkspaceRepository(root), services = []
  const create = options => { const service = new TaskService(repo, requestModel, options);services.push(service);return service }
  t.after(() => { for (const service of services) service.close();repo.close();rmSync(root, { recursive: true, force: true }) })
  return { repo, create }
}
async function until(fn) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) { const value = fn();if (value) return value;await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('task timeout')
}
function start(service, mode = 'auto') {
  return service.create({ sceneId: 'room', channel: 'agent', text: 'move chair', system: 'edit', tools, settings, permissionMode: mode })
}
function startOriginal(service, text = 'move chair', mode = 'confirm', extraTools = []) {
  return service.create({ sceneId: 'room', channel: 'agent', workflow: 'original', text, system: 'original baseline', tools: [...tools, ...extraTools], settings: { ...settings, sendImages: true }, permissionMode: mode })
}
const model = async ({ turns }) => turns.some(turn => turn.role === 'toolResults')
  ? { text: 'done', toolCalls: [] }
  : { text: 'moving', toolCalls: [{ id: 'model-call', name: 'asset_adjust_transform', args: { assetId: 'chair', translate: [1,0,0] } }] }

test('原版基线逐批裁决：接受继续、拒绝只回滚本批，后续指令保留完整上下文', async t => {
  let requests = 0, captured
  const { repo, create } = setup(t, async options => {
    requests++;captured = structuredClone(options.turns)
    return requests <= 2 ? { text: 'adjust', toolCalls: [{ id: `call-${requests}`, name: 'asset_adjust_transform', args: {} }] }
      : { text: 'done', toolCalls: [] }
  })
  const service = create(), task = startOriginal(service)
  async function result(position) {
    await until(() => service.get(task.id).status === 'awaiting_browser')
    const view = service.attach(task.id, 'page', settings.apiKey), draft = structuredClone(view.draft)
    draft.assets[0].transform.position[0] = position
    service.result(task.id, { owner: 'page', epoch: view.epoch, callId: view.calls.find(c => !c.result).id, result: { ok: true, data: {} }, document: draft })
    await until(() => service.get(task.id).status === 'awaiting_user')
  }
  await result(1)
  assert.equal(requests,1)
  assert.equal(repo.get('room').revision,0)
  service.verdict(task.id, { verdict: 'accepted', reviewVersion: 0 })
  await result(9)
  assert.equal(repo.get('room').revision,1)
  service.verdict(task.id, { verdict: 'rejected', reviewVersion: 1, reason: '保留上批，只撤回这次' })
  await until(() => service.get(task.id).status === 'completed')
  assert.equal(service.get(task.id).draft.assets[0].transform.position[0],1)
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0],1)
  assert.ok(captured.some(turn => turn.text?.includes('用户接受了本批提案')))
  assert.ok(captured.some(turn => turn.text?.includes('保留上批，只撤回这次')))
  const next = startOriginal(service,'再调整那把椅子')
  await until(() => service.get(next.id).status === 'completed')
  assert.ok(captured.some(turn => turn.role === 'toolResults'))
  assert.equal(captured.at(-1).text,'再调整那把椅子')
})

test('原版基线保持最近截图直到新截图替换，普通只读工具不会删除它', async t => {
  let requests = 0
  const { create } = setup(t, async options => {
    requests++
    const images = options.turns.flatMap(turn => turn.results?.flatMap(result => result.images ?? []) ?? [])
    if (requests === 2 || requests === 3) assert.deepEqual(images,[{dataUrl:'image-one'}])
    if (requests === 4) { assert.deepEqual(images,[{dataUrl:'image-two'}]);return { text:'done',toolCalls:[] } }
    return { text:'', toolCalls:[{id:`read-${requests}`,name:requests === 2?'model_search':'viewport_screenshot',args:{}}] }
  })
  const service = create(), task = startOriginal(service,'inspect','auto',[
    { name:'viewport.screenshot',access:'read',schema:{} },{name:'model.search',access:'read',schema:{}}])
  for (let index=0;index<3;index++) {
    await until(() => service.get(task.id).status === 'awaiting_browser')
    const view=service.attach(task.id,'page',settings.apiKey)
    service.result(task.id,{owner:'page',epoch:view.epoch,callId:view.calls.find(c=>!c.result).id,document:view.draft,
      result:{ok:true,data:index===1?{models:[]}:{image:index===0?'image-one':'image-two'}}})
  }
  await until(()=>service.get(task.id).status==='completed')
  assert.equal(requests,4)
})

test('刷新重连保留工具结果与草稿；结果重试不会重复移动或重复提交', async t => {
  let requests = 0
  const { repo, create } = setup(t, async options => { requests++;return model(options) })
  const service = create();const task = start(service)
  await until(() => service.get(task.id).status === 'awaiting_browser')
  let view = service.attach(task.id, 'old-page', settings.apiKey)
  assert.throws(() => service.attach(task.id, 'new-page', settings.apiKey), error => error.status === 409)
  const persisted = service.get(task.id);persisted.leaseUntil = 0;service.save(persisted)
  view = service.attach(task.id, 'new-page', settings.apiKey)
  const document = structuredClone(view.draft);document.assets[0].transform.position = [1,0,0]
  const input = { owner: 'new-page', epoch: view.epoch, callId: view.batch[0].id, document, result: { ok: true, data: { moved: true } } }
  service.result(task.id, input)
  service.result(task.id, input)
  await until(() => service.get(task.id).status === 'completed')
  assert.equal(requests, 2)
  assert.equal(repo.get('room').revision, 1)
  assert.deepEqual(repo.get('room').workspace.document.assets[0].transform.position, [1,0,0])
  assert.equal(repo.get('room').workspace.journal.length, 1)
  const state = service.get(task.id)
  assert.equal(state.calls.filter(call => call.result).length, 1)
  assert.equal(state.modelRequests.length, 2)
  assert.ok(state.modelRequests.every(request => request.status === 'completed' && request.durationMs >= 0))
  assert.ok(!JSON.stringify(repo.db.prepare('SELECT state FROM ai_tasks').all()).includes(settings.apiKey))
})

test('长工具续租允许原页面恢复，其他页面接管后拒绝旧 epoch 和旧回执', async t => {
  const { repo, create } = setup(t, model)
  const service = create(), task = start(service, 'confirm')
  await until(() => service.get(task.id).status === 'awaiting_browser')
  const first = service.attach(task.id, 'first-page', settings.apiKey)
  let state = service.get(task.id);state.leaseUntil = 0;service.save(state)
  const renewed = service.renewLease(task.id, 'first-page', first.epoch)
  assert.equal(renewed.epoch, first.epoch)
  assert.ok(renewed.leaseUntil > Date.now())
  assert.throws(() => service.attach(task.id, 'second-page', settings.apiKey), error => error.status === 409)
  state = service.get(task.id);state.leaseUntil = 0;service.save(state)
  const second = service.attach(task.id, 'second-page', settings.apiKey)
  assert.ok(second.epoch > first.epoch)
  assert.throws(() => service.renewLease(task.id, 'first-page', first.epoch), error => error.status === 409)
  const document = structuredClone(second.draft);document.assets[0].transform.position[0] = 3
  const input = { callId: second.batch[0].id, document, result: { ok: true, data: {} } }
  assert.throws(() => service.result(task.id, { ...input, owner: 'first-page', epoch: first.epoch }), error => error.status === 409)
  service.result(task.id, { ...input, owner: 'second-page', epoch: second.epoch })
  await until(() => service.get(task.id).status === 'awaiting_user')
  service.verdict(task.id, { verdict: 'accepted' })
  assert.equal(repo.get('room').revision, 1)
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0], 3)
})

test('模型超时会中断请求且保留计时；迟到的结果不产生编辑', async t => {
  let finish, requestSignal
  const { repo, create } = setup(t, ({ signal, onEvent }) => {
    requestSignal = signal
    onEvent({ type: 'text', delta: '正在分析' })
    return new Promise(resolve => { finish = resolve })
  })
  const service = create({ modelTimeoutMs: 30 });const task = start(service)
  await until(() => service.get(task.id).status === 'paused')
  const state = service.get(task.id)
  assert.ok(state.error.includes('超过'))
  assert.equal(requestSignal.aborted, true)
  assert.equal(state.modelRequests[0].status, 'timed_out')
  assert.ok(state.modelRequests[0].firstTextAt)
  assert.ok(state.modelRequests[0].durationMs >= 30)
  finish({ text: '迟到的回复', toolCalls: [{ id: 'late', name: 'asset_adjust_transform', args: {} }] })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(service.get(task.id).calls.length, 0)
  assert.equal(repo.get('room').revision, 0)
})

test('局部意见保留提案和物体 ID；接受时只提交最终改动并由程序确认状态', async t => {
  const { repo, create } = setup(t, async options => {
    assert.ok(options.system.includes('未接受前不得声称已保存'))
    if (options.turns.at(-1)?.role === 'user' && options.turns.at(-1).text.includes('未回滚')) {
      return { text: '只调整原椅子', toolCalls: [{ id: 'adjust-existing', name: 'asset_adjust_transform', args: { assetId: 'chair', translate: [1,0,0] } }] }
    }
    return model(options)
  })
  const service = create(), task = start(service, 'confirm')
  async function execute(x, addDecoration = false) {
    await until(() => service.get(task.id).status === 'awaiting_browser')
    const view = service.attach(task.id, 'page', settings.apiKey)
    const draft = structuredClone(view.draft);draft.assets[0].transform.position[0] = x
    if (addDecoration) draft.assets.push({ ...structuredClone(draft.assets[0]), id: 'satisfied-decoration' })
    service.result(task.id, { owner: 'page', epoch: view.epoch, callId: view.calls.find(c => !c.result).id, document: draft, result: { ok: true, data: {} } })
    await until(() => service.get(task.id).status === 'awaiting_user')
  }
  await execute(1, true)
  const originalCall = service.get(task.id).calls[0].id
  service.verdict(task.id, { verdict: 'revised', reason: '只修正椅子位置，保留装饰', reviewVersion: 0 })
  assert.deepEqual(service.get(task.id).draft.assets.map(a => a.id), ['chair', 'satisfied-decoration'])
  assert.equal(service.get(task.id).draft.assets[0].transform.position[0], 1)
  assert.equal(repo.get('room').revision, 0)
  assert.throws(() => service.verdict(task.id, { verdict: 'revised', reviewVersion: 0 }))
  await execute(2)
  const state = service.get(task.id)
  assert.equal(state.calls[0].id, originalCall)
  assert.ok(state.chat.some(m => m.role === 'note' && m.text.includes('等待你接受')))
  assert.ok(!state.chat.some(m => m.text === '编辑已接受并保存'))
  service.verdict(task.id, { verdict: 'accepted', reviewVersion: 1 })
  assert.equal(repo.get('room').revision, 1)
  assert.equal(repo.get('room').workspace.document.assets.length, 2)
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0], 2)
  assert.ok(service.get(task.id).chat.some(m => m.text === '编辑已接受并保存'))
})

test('超时重启后重试仅重发推理；保留已完成工具、草稿和意见，重复重试幂等', async t => {
  let requests = 0, late
  const { repo, create } = setup(t, async options => {
    requests++
    if (requests === 2) return new Promise(resolve => { late = resolve })
    return model(options)
  })
  const first = create({ modelTimeoutMs: 40 }), task = start(first, 'confirm')
  await until(() => first.get(task.id).status === 'awaiting_browser')
  const view = first.attach(task.id, 'page', settings.apiKey), draft = structuredClone(view.draft)
  draft.assets[0].transform.position[0] = 5
  const result = { owner: 'page', epoch: view.epoch, callId: view.batch[0].id, document: draft, result: { ok: true, data: {} } }
  first.result(task.id, result)
  await until(() => first.get(task.id).status === 'paused')
  assert.equal(first.public(first.get(task.id)).retryable, true)
  first.close()
  const second = create({ modelTimeoutMs: 1000 })
  assert.equal(second.attach(task.id, 'reconnected', settings.apiKey).status, 'paused')
  assert.equal(requests, 2)
  const input = { apiKey: settings.apiKey, requestId: 'retry-one' }
  second.retry(task.id, input);second.retry(task.id, input)
  await until(() => second.get(task.id).status === 'awaiting_user')
  assert.equal(requests, 3)
  assert.equal(second.get(task.id).calls.length, 1)
  assert.equal(second.get(task.id).draft.assets[0].transform.position[0], 5)
  assert.equal(second.get(task.id).chat.filter(m => m.text.startsWith('✓')).length, 1)
  late({ text: '迟到结果', toolCalls: [{ id: 'late', name: 'asset_adjust_transform', args: {} }] })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(second.get(task.id).calls.length, 1)
  second.verdict(task.id, { verdict: 'accepted' })
  assert.equal(repo.get('room').revision, 1)
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0], 5)
})

test('新任务保留聊天，但模型输入不继承历史工具目录和旧截图', async t => {
  let received
  const { create } = setup(t, async options => { received = options.turns;return { text: 'done', toolCalls: [] } })
  const service = create()
  const old = start(service)
  await until(() => service.get(old.id).status === 'completed')
  const saved = service.get(old.id)
  saved.turns.push({ role: 'toolResults', results: [{ callId: 'old-state', ok: true, content: {
    assets: [{ id: 'chair', ref: 'models/chair' }],
    manifest: { 'models/chair': { name: 'chair' }, 'models/unrelated': { name: 'unrelated' } },
  }, images: [{ dataUrl: 'data:image/png;base64,old-screenshot' }] }] })
  service.save(saved)
  const next = start(service)
  await until(() => service.get(next.id).status === 'completed')
  assert.equal(received.length, 1)
  assert.equal(received[0].role, 'user')
  assert.ok(JSON.stringify(received).length < 3000)
  assert.ok(!JSON.stringify(received).includes('old-screenshot'))
  assert.ok(service.get(old.id).turns.find(turn => turn.role === 'toolResults').results[0].images)
  assert.ok(service.get(next.id).chat.some(message => message.text.startsWith('新任务 ·')))
  assert.ok(service.get(next.id).chat.some(message => message.text.startsWith('本轮未产生场景修改')))
})

test('首轮超时的旧任务重试时重建精简输入，保留界面对话', async t => {
  let requests = 0, chars
  const { create } = setup(t, async options => {
    requests++;chars = JSON.stringify(options.turns).length
    if (requests === 1) return new Promise(() => {})
    options.onEvent({ type: 'activity', stage: 'connected' })
    options.onEvent({ type: 'activity', stage: 'reasoning' })
    return { text: '准备重新读取场景', toolCalls: [] }
  })
  const service = create({ modelTimeoutMs: 20 }), task = start(service, 'confirm')
  await until(() => service.get(task.id).status === 'paused')
  const saved = service.get(task.id)
  saved.turns.unshift({ role: 'toolResults', results: [{ callId: 'old', ok: true, content: 'x'.repeat(90000) }] })
  service.save(saved)
  service.retry(task.id, { requestId: 'compact-first-round', apiKey: settings.apiKey })
  await until(() => service.get(task.id).status === 'completed')
  assert.ok(chars < 3000)
  assert.ok(service.get(task.id).modelRequests[1].connectedAt)
  assert.equal(service.get(task.id).modelRequests[1].activity, 'reasoning')
  assert.ok(service.get(task.id).chat.some(message => message.role === 'user' && message.text === 'move chair'))
})

test('空回复不再作为完成；保留草稿暂停，允许重试且不写入空的助手轮次', async t => {
  let requests = 0
  const { repo, create } = setup(t, async () => ++requests === 1
    ? { text: '', toolCalls: [] } : { text: '当前没有执行修改', toolCalls: [] })
  const service = create(), task = start(service, 'confirm')
  await until(() => service.get(task.id).status === 'paused')
  const state = service.get(task.id)
  assert.equal(state.pauseReason, 'empty_response')
  assert.equal(service.public(state).retryable, true)
  assert.equal(state.turns.filter(turn => turn.role === 'assistant').length, 0)
  assert.equal(state.modelRequests[0].status, 'failed')
  assert.equal(repo.get('room').revision, 0)
  service.retry(task.id, { requestId: 'retry-empty', apiKey: settings.apiKey })
  await until(() => service.get(task.id).status === 'completed')
  assert.equal(requests, 2)
  assert.equal(repo.get('room').revision, 0)
})

test('旧版失败超时任务可识别；有其他任务或正式版本变化时拒绝重试', async t => {
  const { repo, create } = setup(t, () => new Promise(() => {}))
  const service = create({ modelTimeoutMs: 25 }), task = start(service, 'confirm')
  await until(() => service.get(task.id).status === 'paused')
  const legacy = service.get(task.id);legacy.status = 'failed';service.save(legacy)
  assert.equal(service.public(service.get(task.id)).retryable, true)
  const competing = start(service, 'confirm')
  const input = { requestId: 'restore-legacy', apiKey: settings.apiKey }
  assert.throws(() => service.retry(task.id, input), error => error.status === 409 && error.message.includes('其他未完成任务'))
  service.cancel(competing.id)
  const state = repo.get('room')
  repo.commit('room', { requestId: 'manual-change', baseRevision: state.revision, workspace: state.workspace })
  assert.throws(() => service.retry(task.id, input), error => error.status === 409 && error.message.includes('正式场景已变更'))
  service.cancel(task.id)
  assert.equal(service.get(task.id).status, 'cancelled')
})

test('服务拒绝保留草稿并等待手动重试；切换模型后只继续推理，密钥不落盘', async t => {
  let requests = 0, selected, failedSignal
  const { repo, create } = setup(t, async options => {
    requests++
    if (requests === 2) {
      failedSignal = options.signal
      throw Object.assign(new Error('模型服务返回流式错误：data_inspection_failed'), { code: 'MODEL_SERVICE_ERROR', providerCode: 'data_inspection_failed' })
    }
    if (requests === 3) selected = options.settings
    return model(options)
  })
  const service = create(), task = start(service, 'confirm')
  await until(() => service.get(task.id).status === 'awaiting_browser')
  const view = service.attach(task.id, 'page', settings.apiKey), draft = structuredClone(view.draft)
  draft.assets[0].transform.position[0] = 8
  service.result(task.id, { owner: 'page', epoch: view.epoch, callId: view.batch[0].id, document: draft, result: { ok: true, data: {} } })
  await until(() => service.get(task.id).status === 'paused')
  assert.equal(service.public(service.get(task.id)).pauseReason, 'service_error')
  assert.equal(failedSignal.aborted, true)
  assert.equal(service.get(task.id).draft.assets[0].transform.position[0], 8)
  assert.equal(repo.get('room').revision, 0)
  service.attach(task.id, 'page', settings.apiKey)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(requests, 2, '轮询或重连不自动重试')
  service.close()
  const restored = create()
  assert.equal(restored.attach(task.id, 'new-page', settings.apiKey).status, 'paused')
  assert.equal(requests, 2)
  const input = { requestId: 'switch-model', settings: { ...settings, model: 'replacement-model', baseURL: 'http://replacement.invalid', protocol: 'anthropic', apiKey: 'replacement-secret', sendImages: false } }
  restored.retry(task.id, input);restored.retry(task.id, input)
  await until(() => restored.get(task.id).status === 'awaiting_user')
  assert.equal(requests, 3)
  assert.equal(selected.model, 'replacement-model')
  assert.equal(selected.protocol, 'anthropic')
  assert.equal(selected.baseURL, 'http://replacement.invalid')
  assert.equal(selected.apiKey, 'replacement-secret')
  assert.equal(restored.get(task.id).calls.length, 1)
  assert.equal(restored.get(task.id).draft.assets[0].transform.position[0], 8)
  assert.ok(!JSON.stringify(repo.db.prepare('SELECT state FROM ai_tasks').all()).includes('replacement-secret'))
  restored.verdict(task.id, { verdict: 'accepted' })
  assert.equal(repo.get('room').revision, 1)
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0], 8)
})

test('旧版 failed 的服务审查错误显示恢复入口，并可明确停止', async t => {
  const { create } = setup(t, async () => ({ text: 'done', toolCalls: [] }))
  const service = create(), task = start(service, 'confirm')
  await until(() => service.get(task.id).status === 'completed')
  const saved = service.get(task.id)
  saved.status = 'failed';saved.pauseReason = 'timeout';saved.error = '模型服务返回流式错误：data_inspection_failed';service.save(saved)
  assert.equal(service.public(service.get(task.id)).retryable, true)
  assert.equal(service.public(service.get(task.id)).pauseReason, 'service_error')
  service.cancel(task.id)
  assert.equal(service.public(service.get(task.id)).retryable, false)
})

test('清除对话按场景通道生效，刷新不恢复旧记录，不改变场景或下一任务上下文', async t => {
  const { repo, create } = setup(t, async () => ({ text: 'done', toolCalls: [] }))
  const service = create(), first = start(service)
  await until(() => service.get(first.id).status === 'completed')
  const historical = service.get(first.id)
  historical.status = 'failed';historical.error = '模型服务返回流式错误：data_inspection_failed';service.save(historical)
  const latest = start(service)
  await until(() => service.get(latest.id).status === 'completed')
  const other = service.create({ sceneId: 'room', channel: 'llm-agent', text: 'other channel', system: 'edit', tools, settings })
  await until(() => service.get(other.id).status === 'completed')
  service.clearConversation(latest.id)
  assert.equal(service.latest('room','agent'),null)
  assert.equal(create().latest('room','agent'),null)
  assert.equal(service.latest('room','llm-agent').id,other.id)
  assert.equal(repo.get('room').revision,0)
  assert.ok(service.get(first.id).chat.length > 0, '内部任务回执保留')
  const next = start(service)
  await until(() => service.get(next.id).status === 'completed')
  assert.equal(service.get(next.id).chat.filter(m => m.role === 'user').length,1)
})

test('活动任务不能直接清除对话，明确停止后允许清除', async t => {
  const { create } = setup(t, model)
  const service = create(), task = start(service, 'confirm')
  assert.throws(() => service.clearConversation(task.id), error => error.status === 409)
  service.cancel(task.id)
  service.clearConversation(task.id)
  assert.equal(service.latest('room','agent'),null)
})

test('提案跨调度器重启恢复；未接受前不改主场景，接受后只提交一次', async t => {
  const { repo, create } = setup(t, model)
  const first = create();const task = start(first, 'confirm')
  await until(() => first.get(task.id).status === 'awaiting_browser')
  first.close()
  const second = create()
  assert.equal(second.get(task.id).status, 'awaiting_credentials')
  const view = second.attach(task.id, 'reconnected', settings.apiKey)
  const document = structuredClone(view.draft);document.assets[0].transform.position = [2,0,0]
  second.result(task.id, { owner: 'reconnected', epoch: view.epoch, callId: view.batch[0].id, document, result: { ok: true, data: {} } })
  await until(() => second.get(task.id).status === 'awaiting_user')
  assert.equal(repo.get('room').revision, 0)
  second.close()
  const third = create()
  assert.equal(third.attach(task.id, 'after-confirm-restart', settings.apiKey).status, 'awaiting_user')
  third.verdict(task.id, { verdict: 'accepted' })
  third.verdict(task.id, { verdict: 'accepted' })
  assert.equal(repo.get('room').revision, 1)
  assert.equal(third.get(task.id).status, 'completed')
})

test('场景已提交但任务回执保存前中断，重启不重复入账', async t => {
  const { repo, create } = setup(t, model)
  const service = create();const task = start(service, 'confirm')
  await until(() => service.get(task.id).status === 'awaiting_browser')
  const view = service.attach(task.id, 'page', settings.apiKey)
  const document = structuredClone(view.draft);document.assets[0].transform.position = [4,0,0]
  service.result(task.id, { owner: 'page', epoch: view.epoch, callId: view.batch[0].id, document, result: { ok: true, data: {} } })
  await until(() => service.get(task.id).status === 'awaiting_user')
  const commit = repo.commit.bind(repo)
  repo.commit = (...args) => { commit(...args);throw new Error('crash after commit') }
  assert.throws(() => service.verdict(task.id, { verdict: 'accepted' }), /crash/)
  service.close();repo.commit = commit
  const recovered = create()
  assert.equal(recovered.get(task.id).status, 'completed')
  assert.equal(repo.get('room').revision, 1)
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0], 4)
})

test('拒绝保留任务并将原因交给模型，回滚后重新提案，接受只提交最终方案', async t => {
  let feedback
  const { repo, create } = setup(t, async options => {
    const rejected = options.turns.find(turn => turn.role === 'user' && turn.text.includes('离门太近'))
    if (rejected) {
      feedback = rejected.text
      const last = options.turns.at(-1)
      if (last.role === 'user') return { text: '改为向另一侧移动', toolCalls: [{ id: 'revised', name: 'asset_adjust_transform', args: { assetId: 'chair', translate: [-2,0,0] } }] }
    }
    return model(options)
  })
  const service = create();const task = start(service, 'confirm')
  async function complete(position) {
    await until(() => service.get(task.id).status === 'awaiting_browser')
    const view = service.attach(task.id, 'page', settings.apiKey)
    const call = view.calls.find(c => !c.result)
    const document = structuredClone(view.draft);document.assets[0].transform.position = [position,0,0]
    service.result(task.id, { owner: 'page', epoch: view.epoch, callId: call.id, document, result: { ok: true, data: {} } })
    await until(() => service.get(task.id).status === 'awaiting_user')
  }
  await complete(1)
  service.verdict(task.id, { verdict: 'rejected', reason: '离门太近，请移到另一侧', reviewVersion: 0 })
  assert.equal(repo.get('room').revision, 0)
  assert.equal(service.get(task.id).draft.assets[0].transform.position[0], 0)
  await complete(-2)
  assert.ok(feedback.includes('离门太近'))
  const chat = service.public(service.get(task.id)).chat
  assert.ok(chat.some(message => message.role === 'user' && message.text === 'move chair'))
  assert.equal(chat.filter(message => message.role === 'user' && message.text === '离门太近，请移到另一侧').length, 1)
  assert.throws(() => service.verdict(task.id, { verdict: 'accepted', reviewVersion: 0 }), error => error.status === 409)
  service.verdict(task.id, { verdict: 'accepted', reviewVersion: 1 })
  assert.equal(service.get(task.id).status, 'completed')
  assert.equal(repo.get('room').revision, 1)
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0], -2)
  const restored = create().public(service.get(task.id))
  assert.ok(restored.chat.some(message => message.role === 'user' && message.text === '离门太近，请移到另一侧'))
})

test('任务在无浏览器时完成模型请求并等待工具；取消与版本冲突保护', async t => {
  const { repo, create } = setup(t, model)
  const service = create();const task = start(service)
  await until(() => service.get(task.id).status === 'awaiting_browser')
  assert.equal(service.get(task.id).owner, null)
  const view = service.attach(task.id, 'page', settings.apiKey)
  const state = repo.get('room')
  repo.commit('room', { requestId: 'human', baseRevision: state.revision, workspace: state.workspace })
  const draft = structuredClone(view.draft);draft.assets[0].transform.position = [1,0,0]
  service.result(task.id, { owner: 'page', epoch: view.epoch, callId: view.batch[0].id, document: draft, result: { ok: true, data: {} } })
  await until(() => service.get(task.id).status === 'conflict')
  assert.equal(repo.get('room').workspace.document.assets[0].transform.position[0], 0)
  const another = start(service);service.cancel(another.id)
  assert.equal(service.get(another.id).status, 'cancelled')
})
