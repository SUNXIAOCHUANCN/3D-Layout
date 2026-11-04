import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WorkspaceRepository } from '../workspaces.mjs'
import { createWorkspaceApi } from '../http.mjs'

const repositories = new Map()
function repository(root) {
  const repo = new WorkspaceRepository(root)
  repositories.get(root).push(repo)
  return repo
}

const original = { id: 'chair', ref: 'models/chair', transform: { position: [0,0,0], rotation: [0,0,0] } }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'layout-db-'))
  mkdirSync(join(root, 'scenes', 'room'), { recursive: true })
  const document = { meta: { id: 'room', name: '房间', version: 1, unit: 'm', up: '+Y' }, assets: [original], environment: {}, cameras: [] }
  writeFileSync(join(root, 'scenes', 'room', 'scene.json'), JSON.stringify(document))
  repositories.set(root, [])
  t.after(() => {
    for (const repo of repositories.get(root)) repo.close()
    rmSync(root, { recursive: true, force: true })
    repositories.delete(root)
  })
  return root
}
function move(state) {
  const next = structuredClone(state)
  const before = next.document.assets[0]
  const after = { ...before, transform: { ...before.transform, position: [3,0,0] } }
  next.document.assets[0] = after
  next.txCounter++
  next.journal.push({ txId: next.txCounter, label: '移动椅子', source: 'human', entries: [{ cmd: 'set_transform', assetId: 'chair', before, after, source: 'human', txId: next.txCounter, label: '移动', time: Date.now() }] })
  return next
}

test('场景、历史、撤销重做状态在服务重启后一起恢复；文件导出同步', t => {
  const root = fixture(t)
  let repo = repository(root)
  const state = move(repo.get('room').workspace)
  assert.equal(repo.commit('room', { requestId: 'move-1', baseRevision: 0, workspace: state }).revision, 1)
  repo.close(); repo = repository(root)
  assert.deepEqual(repo.get('room').workspace, state)
  const undo = structuredClone(state)
  const unit = undo.journal.pop(); undo.redoStack.push(unit); undo.document.assets = [original]
  repo.commit('room', { requestId: 'undo-1', baseRevision: 1, workspace: undo })
  repo.close(); repo = repository(root)
  assert.deepEqual(repo.get('room').workspace.redoStack, [unit])
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'scenes/room/scene.json'), 'utf8')).assets, [original])
  repo.commit('room', { requestId: 'redo-1', baseRevision: 2, workspace: state })
  assert.deepEqual(repo.get('room').workspace.document, state.document)
  assert.equal(repo.db.prepare('SELECT count(*) AS n FROM resource_refs').get().n, 3)
  repo.close()
})

test('镜像实例可持久化，列表不校验其他场景的几何变换', t => {
  const root = fixture(t)
  const document = JSON.parse(readFileSync(join(root, 'scenes/room/scene.json'), 'utf8'))
  document.assets[0].transform.scale = [-1, 1, 1]
  writeFileSync(join(root, 'scenes/room/scene.json'), JSON.stringify(document))
  const repo = repository(root)
  assert.deepEqual(repo.list(), [{ id: 'room', name: '房间' }])
  const workspace = repo.get('room').workspace
  assert.deepEqual(workspace.document.assets[0].transform.scale, [-1, 1, 1])
  repo.commit('room', { requestId: 'mirror', baseRevision: 0, workspace })
  assert.equal(repo.get('room').revision, 1)
})

test('幂等重试不重复入库，多标签页冲突与 requestId 复用都拒绝', t => {
  const repo = repository(fixture(t));t.after(() => repo.close())
  const request = { requestId: 'one', baseRevision: 0, workspace: move(repo.get('room').workspace) }
  repo.commit('room', request)
  assert.equal(repo.commit('room', request).revision, 1)
  assert.throws(() => repo.commit('room', { ...request, requestId: 'two' }), e => e.status === 409)
  assert.throws(() => repo.commit('room', { ...request, baseRevision: 1 }), e => e.status === 409)
  assert.equal(repo.history('room').length, 1)
})

test('历史损坏、非法变换及路径拒绝，数据库不产生半条提交', t => {
  const repo = repository(fixture(t));t.after(() => repo.close())
  const state = move(repo.get('room').workspace)
  const bad = structuredClone(state);bad.journal[0].entries[0].after = { ...bad.journal[0].entries[0].after, transform: { position: [99,0,0], rotation: [0,0,0] } }
  assert.throws(() => repo.commit('room', { requestId: 'bad', baseRevision: 0, workspace: bad }), /不一致/)
  const invalid = structuredClone(state);invalid.document.assets[0].transform.scale = [0,1,1]
  assert.throws(() => repo.commit('room', { requestId: 'bad2', baseRevision: 0, workspace: invalid }), /变换/)
  assert.throws(() => repo.get('../room'), /非法场景/)
  assert.equal(repo.get('room').revision, 0)
  assert.equal(repo.history('room').length, 0)
})

test('恢复旧版本生成新版本；旧历史和资源引用仍保留', t => {
  const repo = repository(fixture(t));t.after(() => repo.close())
  const first = move(repo.get('room').workspace)
  repo.commit('room', { requestId: 'one', baseRevision: 0, workspace: first })
  const second = structuredClone(first);second.document.meta.name = '第二版'
  repo.commit('room', { requestId: 'two', baseRevision: 1, workspace: second })
  repo.restore('room', { requestId: 'restore', baseRevision: 2, revision: 1 })
  assert.equal(repo.get('room').revision, 3)
  assert.equal(repo.get('room').workspace.document.meta.name, '房间')
  assert.deepEqual(repo.get('room').workspace.journal, [])
  assert.deepEqual(repo.history('room', 3, 1).map(x => x.revision), [2])
})

test('磁盘导出失败不丢失已提交数据，下一次读取自动修复', t => {
  const root = fixture(t);const repo = repository(root);t.after(() => repo.close())
  const state = move(repo.get('room').workspace)
  mkdirSync(join(root, 'scenes/room/scene.json.pending'))
  const result = repo.commit('room', { requestId: 'one', baseRevision: 0, workspace: state })
  assert.match(result.projectionError, /数据库已保存/)
  assert.equal(repo.get('room').revision, 1)
  rmSync(join(root, 'scenes/room/scene.json.pending'), { recursive: true })
  assert.equal(repo.get('room').projectionError, null)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'scenes/room/scene.json'), 'utf8')), state.document)
})

test('HTTP 协议：恢复、保存、分页、跨来源写入和无效请求', async t => {
  const root = fixture(t);const api = createWorkspaceApi(root)
  repositories.get(root).push(api.repository)
  const server = createServer((req,res) => api.handler(req,res,() => res.writeHead(404).end()))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve));api.close() })
  const url = `http://127.0.0.1:${server.address().port}/api/workspaces/room`
  const initial = await (await fetch(url)).json()
  assert.deepEqual(await (await fetch(url.replace('/workspaces/room', '/scenes'))).json(), [{ id: 'room', name: '房间' }])
  const input = { requestId: 'http-one', baseRevision: 0, workspace: move(initial.workspace) }
  const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) })
  assert.equal((await post({})).status, 403)
  assert.equal((await post({ 'X-Layout-Client': '1', Origin: 'https://example.com' })).status, 403)
  assert.equal((await post({ 'X-Layout-Client': '1' })).status, 200)
  assert.equal((await (await fetch(url)).json()).workspace.journal.length, 1)
  assert.equal((await fetch(url + '/history?limit=0')).status, 400)
  assert.equal((await fetch(url, { method: 'POST', headers: { 'X-Layout-Client': '1' }, body: '{' })).status, 400)
  const logUrl = url.replace('/workspaces/room', '/log')
  const log = filename => fetch(logUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Layout-Client': '1' }, body: JSON.stringify({ filename, content: '# 测试' }) })
  assert.equal((await log('../escape.md')).status, 400)
  assert.equal((await log('log20261101000000-test.md')).status, 200)
  assert.deepEqual((await (await fetch(logUrl + '/list')).json()).files, ['log20261101000000-test.md'])
  assert.equal(readFileSync(join(root, 'logs/log20261101000000-test.md'), 'utf8'), '# 测试\n')
})

test('数据库提交中途失败时，当前状态、版本和资源引用一起回滚', t => {
  const repo = repository(fixture(t))
  const state = move(repo.get('room').workspace)
  repo.db.exec("CREATE TRIGGER reject_refs BEFORE INSERT ON resource_refs BEGIN SELECT RAISE(ABORT,'test rollback'); END;")
  assert.throws(() => repo.commit('room', { requestId: 'failure', baseRevision: 0, workspace: state }), /test rollback/)
  assert.equal(repo.get('room').revision, 0)
  assert.equal(repo.history('room').length, 0)
})

test('在线备份命令生成可独立打开且完整的数据库', t => {
  const root = fixture(t);const repo = repository(root)
  repo.commit('room', { requestId: 'backup', baseRevision: 0, workspace: move(repo.get('room').workspace) })
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../backup.mjs', import.meta.url))], { env: { ...process.env, LAYOUT_ROOT: root }, encoding: 'utf8' })
  const filename = output.split('\n')[0].replace('数据库备份：', '').trim()
  const copy = new DatabaseSync(filename, { readOnly: true })
  try {
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    assert.equal(copy.prepare('SELECT revision FROM scenes WHERE id=?').get('room').revision, 1)
    assert.equal(copy.prepare('SELECT count(*) AS n FROM revisions').get().n, 1)
  } finally { copy.close() }
})

test('独立服务提供构建页面、场景 API 与数据文件', async t => {
  const root = fixture(t)
  mkdirSync(join(root, 'src/dist'), { recursive: true })
  writeFileSync(join(root, 'src/dist/index.html'), '<!doctype html><title>layout smoke</title>')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../start.mjs', import.meta.url))], {
    env: { ...process.env, LAYOUT_ROOT: root, PORT: '0' }, windowsHide: true, stdio: ['ignore','pipe','pipe'],
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    const url = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('独立服务启动超时')), 10000)
      child.once('error', error => { clearTimeout(timer);reject(error) })
      child.stdout.on('data', data => {
        const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)
        if (match) { clearTimeout(timer);resolve(match[0]) }
      })
    })
    assert.match(await (await fetch(url)).text(), /layout smoke/)
    assert.equal((await (await fetch(url + '/api/health')).json()).schemaVersion, 1)
    assert.deepEqual(await (await fetch(url + '/api/scenes')).json(), [{ id: 'room', name: '房间' }])
    assert.equal((await fetch(url + '/scenes/room/scene.json')).status, 200)
    assert.equal((await fetch(url + '/.data/layout.sqlite')).status, 404)
  } finally { if (child.exitCode === null) child.kill();await exited }
})
