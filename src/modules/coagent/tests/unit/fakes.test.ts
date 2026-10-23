/**
 * W01 fakes 语义测试：
 * FakeEditor 事务/授权/幂等/过期（对齐真实 core 限制）、FakeModel 取消、FakeRender 故障注入。
 */

import { describe, expect, it } from 'vitest'
import type { AuthorizedCallContext, TransformDTO } from '../../contracts'
import { CoAgentError } from '../../contracts'
import { createFakeEditor } from '../fakes/FakeEditor'
import { createFakeModel } from '../fakes/FakeModel'
import { createFakeRender } from '../fakes/FakeRender'
import { TWO_REGION_ASSETS, TWO_REGION_CATALOG } from '../fixtures/twoRegionScene'

function makeEditor() {
  return createFakeEditor({
    sceneId: 'scene-fixture',
    assets: TWO_REGION_ASSETS,
    catalog: TWO_REGION_CATALOG,
  })
}

function ctxOf(
  token: AuthorizedCallContext['token'],
  overrides: Partial<AuthorizedCallContext> = {},
): AuthorizedCallContext {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    toolCallId: 'call-1',
    token,
    writableObjectIds: new Set(['tree-1', 'tree-2']),
    ...overrides,
  }
}

const MOVE_1M_X: TransformDTO = { position: [-2, 0, -4], rotationDeg: [0, 30, 0], scale: [1, 1, 1] }

describe('FakeEditor 授权与作用域', () => {
  it('未 begin 直接写 → write_failed（无活跃授权事务）', () => {
    const ed = makeEditor()
    const ghost = { __coagentWriteToken: true } as const
    const r = ed.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: MOVE_1M_X, expectedFingerprint: 'x' },
      ctxOf(ghost),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('write_failed')
  })

  it('越权对象（不在 writableObjectIds）→ out_of_scope', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    const fp = ed.snapshot({ objectIds: ['house-1'] }).assets[0].fingerprint
    const r = ed.applyAuthorized(
      { kind: 'transform', objectId: 'house-1', transform: MOVE_1M_X, expectedFingerprint: fp },
      ctxOf(token),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('out_of_scope')
  })

  it('不存在的对象 → asset_not_found；ref 未入库 → asset_not_found', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    const missing = ed.applyAuthorized(
      { kind: 'remove', objectId: 'ghost', expectedFingerprint: 'x' },
      ctxOf(token, { writableObjectIds: new Set(['ghost']) }),
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('asset_not_found')

    const badRef = ed.applyAuthorized(
      { kind: 'add', ref: 'models/no-such', transform: MOVE_1M_X },
      ctxOf(token),
    )
    expect(badRef.ok).toBe(false)
    if (!badRef.ok) expect(badRef.error.code).toBe('asset_not_found')
  })
})

describe('FakeEditor 指纹与幂等（T04 雏形）', () => {
  it('expectedFingerprint 过期 → stale_object，不应用修改', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    const r = ed.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: MOVE_1M_X, expectedFingerprint: 'fp-stale' },
      ctxOf(token),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('stale_object')
    expect(ed.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
  })

  it('同幂等键同参数 → 返回原 receipt 且不重复执行（add 不重复新增）', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    const before = ed.state().assetCount
    const cmd = { kind: 'add', ref: 'models/rock', transform: MOVE_1M_X } as const
    const first = ed.applyAuthorized(cmd, ctxOf(token))
    expect(first.ok).toBe(true)
    const second = ed.applyAuthorized(cmd, ctxOf(token))
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(second.data.idempotentHit).toBe(true)
      expect(second.data.objectId).toBe(first.data.objectId)
      expect(ed.state().assetCount).toBe(before + 1) // 只加了一个
    }
  })

  it('同幂等键不同参数 → invalid_arguments', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    ed.applyAuthorized({ kind: 'add', ref: 'models/rock', transform: MOVE_1M_X }, ctxOf(token))
    const r = ed.applyAuthorized(
      { kind: 'add', ref: 'models/oak-tree', transform: MOVE_1M_X },
      ctxOf(token),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_arguments')
  })

  it('不同 toolCallId 的相似操作不去重', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    ed.applyAuthorized({ kind: 'add', ref: 'models/rock', transform: MOVE_1M_X }, ctxOf(token))
    const r = ed.applyAuthorized(
      { kind: 'add', ref: 'models/rock', transform: MOVE_1M_X },
      ctxOf(token, { toolCallId: 'call-2' }),
    )
    expect(r.ok).toBe(true)
    expect(ed.state().assetCount).toBe(TWO_REGION_ASSETS.length + 2)
  })
})

describe('FakeEditor 事务语义（对齐真实 core 限制）', () => {
  it('begin → 多次写 → rollback 恢复资产集合与 transform', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    const fp = ed.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint
    const move = ed.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: MOVE_1M_X, expectedFingerprint: fp },
      ctxOf(token, { toolCallId: 'call-move' }),
    )
    const add = ed.applyAuthorized(
      { kind: 'add', ref: 'models/rock', transform: MOVE_1M_X },
      ctxOf(token, { toolCallId: 'call-add' }),
    )
    expect(move.ok).toBe(true)
    expect(add.ok).toBe(true)
    expect(ed.state().assetCount).toBe(TWO_REGION_ASSETS.length + 1)

    expect(ed.rollbackRun(token)).toBe(true)
    expect(ed.state().assetCount).toBe(TWO_REGION_ASSETS.length) // 新增的没了
    expect(ed.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4]) // 变换还原
    expect(ed.state().rolledBackRuns).toBe(1)
  })

  it('commit 后 rollback 同 token 无效（终态不可再动）', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    const fp = ed.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint
    ed.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: MOVE_1M_X, expectedFingerprint: fp },
      ctxOf(token),
    )
    ed.commitRun(token)
    expect(ed.rollbackRun(token)).toBe(false)
    expect(ed.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-2, 0, -4]) // 修改保留
  })

  it('被顶替的事务（真实 core 限制）：其修改保留在文档且不可回滚', () => {
    const ed = makeEditor()
    const token1 = ed.beginRun('run-1 第一段')
    const fp = ed.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint
    ed.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: MOVE_1M_X, expectedFingerprint: fp },
      ctxOf(token1),
    )
    const token2 = ed.beginRun('run-1 第二段（顶替）')
    expect(ed.state().orphanedTxLabels).toEqual(['run-1 第一段'])
    expect(ed.rollbackRun(token1)).toBe(false) // 旧令牌失效
    expect(ed.rollbackRun(token2)).toBe(true)
    // 关键断言：第一段的修改没有被第二段的 rollback 恢复（core 真实行为）
    expect(ed.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-2, 0, -4])
  })

  it('场景切换清空 open tx 并替换文档', () => {
    const ed = makeEditor()
    const token = ed.beginRun('run-1')
    ed.simulateSceneSwitch('scene-other', [{ id: 'solo', ref: 'models/rock', transform: MOVE_1M_X }])
    expect(ed.rollbackRun(token)).toBe(false) // open tx 已被清
    expect(ed.state().sceneId).toBe('scene-other')
    expect(ed.state().assetCount).toBe(1)
  })

  it('订阅者在写入时收到变更通知，退订后不再收到', () => {
    const ed = makeEditor()
    const seen: Array<string | null> = []
    const unsub = ed.subscribe(c => seen.push(c.changedObjectIds ? c.changedObjectIds[0] : null))
    const token = ed.beginRun('run-1')
    const fp = ed.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint
    ed.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: MOVE_1M_X, expectedFingerprint: fp },
      ctxOf(token),
    )
    unsub()
    ed.applyAuthorized({ kind: 'add', ref: 'models/rock', transform: MOVE_1M_X }, ctxOf(token, { toolCallId: 'c2' }))
    expect(seen).toEqual(['tree-1'])
  })

  it('save 走"现有保存通路"语义：版本自增、留档最终资产', async () => {
    const ed = makeEditor()
    const r = await ed.save()
    expect(r.mode).toBe('server')
    expect(r.version).toBe(1)
    expect(ed.lastSavedAssets?.length).toBe(TWO_REGION_ASSETS.length)
    await ed.save()
    expect(ed.state().savedVersions).toEqual([1, 2])
  })
})

describe('FakeModel', () => {
  it('按序消费脚本回复，耗尽后 model_protocol_error', async () => {
    const m = createFakeModel([
      { stopReason: 'end', text: '第一答', toolCalls: [] },
    ])
    const req = { purpose: 'test', system: 's', messages: [], tools: [], timeoutMs: 1000 }
    const r1 = await m.complete(req, new AbortController().signal)
    expect(r1.text).toBe('第一答')
    await expect(m.complete(req, new AbortController().signal)).rejects.toMatchObject({
      code: 'model_protocol_error',
    })
  })

  it('挂起请求被 abort → CoAgentError(cancelled)，计入 abortedCount', async () => {
    const m = createFakeModel()
    m.hangNext()
    const ac = new AbortController()
    const p = m.complete(
      { purpose: 'test', system: 's', messages: [], tools: [], timeoutMs: 1000 },
      ac.signal,
    )
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(CoAgentError)
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(m.abortedCount).toBe(1)
  })

  it('进入前已 abort → 直接 cancelled；请求留档可断言', async () => {
    const m = createFakeModel([{ stopReason: 'end', text: 'ok', toolCalls: [] }])
    const ac = new AbortController()
    ac.abort()
    await expect(
      m.complete({ purpose: 'planner', system: 's', messages: [], tools: [], timeoutMs: 1000 }, ac.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(m.requests.length).toBe(1)
    expect(m.requests[0].purpose).toBe('planner')
  })
})

describe('FakeRender', () => {
  it('capture 返回非空 PNG Blob、labels 与请求对象对应；marked 按需产出', async () => {
    const r = createFakeRender()
    const frame = await r.capture(
      {
        runId: 'run-1',
        phase: 'baseline',
        regionId: 'region-north',
        camera: {
          schemaVersion: 1,
          id: 'cam-north',
          projection: 'perspective',
          position: [0, 14, -10],
          target: [0, 0, -4],
          up: [0, 1, 0],
          near: 0.1,
          far: 300,
          aspect: 16 / 9,
          fovDeg: 50,
        },
        width: 1280,
        height: 720,
        objectIds: ['tree-1', 'tree-2'],
        marked: true,
        sceneRevision: 7,
        fingerprints: { 'tree-1': 'fp-tree-1', 'tree-2': 'fp-tree-2' },
      },
      new AbortController().signal,
    )
    expect(frame.labels.map(l => l.objectId)).toEqual(['tree-1', 'tree-2'])
    expect(frame.markedPng).toBeDefined()
    expect(frame.sceneRevision).toBe(7)
    expect(frame.observedObjectFingerprints).toEqual({ 'tree-1': 'fp-tree-1', 'tree-2': 'fp-tree-2' })
    const bytes = await frame.rgbPng.text()
    expect(bytes).toContain('fake-rgb:run-1:baseline')
    expect(r.captureRequests.length).toBe(1)
  })

  it('故障注入：前 N 次 capture_failed / ready 抛 renderer_not_ready，之后恢复', async () => {
    const r = createFakeRender({ captureFailures: 1, readyFailures: 1 })
    const sig = new AbortController().signal
    const req = {
      runId: 'run-1',
      phase: 'baseline' as const,
      camera: {
        schemaVersion: 1 as const,
        id: 'c',
        projection: 'orthographic' as const,
        position: [0, 20, 0] as [number, number, number],
        target: [0, 0, 0] as [number, number, number],
        up: [0, 1, 0] as [number, number, number],
        near: 0.1,
        far: 100,
        aspect: 1,
        ortho: { left: -10, right: 10, top: 10, bottom: -10 },
      },
      width: 64,
      height: 64,
      objectIds: [],
      marked: false,
      sceneRevision: 3,
      fingerprints: {},
    }
    await expect(r.ready([], sig)).rejects.toMatchObject({ code: 'renderer_not_ready' })
    await r.ready([], sig) // 恢复
    await expect(r.capture(req, sig)).rejects.toMatchObject({ code: 'capture_failed' })
    await expect(r.capture(req, sig)).resolves.toBeTruthy()
  })

  it('goOffline 后一切渲染调用 bridge_unavailable', async () => {
    const r = createFakeRender()
    r.goOffline()
    await expect(r.ready([], new AbortController().signal)).rejects.toMatchObject({ code: 'bridge_unavailable' })
    r.goOnline()
    await expect(r.ready([], new AbortController().signal)).resolves.toBeUndefined()
  })

  it('geometry 未编程时对每对返回 unknown（含算法级别）', async () => {
    const r = createFakeRender()
    const g = await r.geometry(
      { objectIds: ['a', 'b'], staticObjectIds: ['s'], contactToleranceM: 0.01, allowGroundContact: true },
      new AbortController().signal,
    )
    expect(g.status).toBe('unknown')
    expect(g.pairs.length).toBe(3) // C(3,2)
    expect(g.pairs.every(p => p.level === 'aabb')).toBe(true)
  })
})
