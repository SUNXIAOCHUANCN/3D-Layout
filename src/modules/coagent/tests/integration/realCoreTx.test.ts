/**
 * 真实 core 事务测试（W03，SPEC 完成条件："真实 core 上事务和互斥通过"）。
 *
 * 直接在 vitest node 环境驱动真实 core（store/edit/events——均无渲染依赖），
 * 经 editorAdapter + runController 走完整门面路径：
 * 两区域多次写入只新增一个 undo 单元；undo/redo 正确；执行中失败回滚；
 * core boolean 失败映射；场景切换作废；redo 栈不随回滚恢复的宿主限制记录在案。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { edit } from '../../../../core/edit'
import { bus } from '../../../../core/events'
import { useSceneStore } from '../../../../core/store'
import type { SceneDocument, SceneAsset } from '../../../../core/types'
import type { PartitionSnapshot, ToolResult } from '../../contracts'
import { createEditorAdapter } from '../../adapters/editorAdapter'
import { createRuntime } from '../../runtime/createRuntime'
import { createKnownTransformWorkflow } from '../fakes/fakeWorkflow'

const T = (position: [number, number, number]): SceneAsset['transform'] => ({
  position,
  rotation: [0, 0, 0],
})

function seedScene(): void {
  const doc: SceneDocument = {
    meta: { id: 'scene-w03', name: 'W03 真实 core 测试', version: 1, unit: 'm', up: '+Y' },
    environment: {},
    assets: [
      { id: 'tree-1', ref: 'models/oak-tree', name: '北树一', transform: { ...T([-3, 0, -4]), rotation: [0, 30, 0] } },
      { id: 'tree-2', ref: 'models/oak-tree', transform: T([2, 0, -5]) },
      { id: 'house-1', ref: 'models/cottage', transform: { ...T([-2, 0, 4]), rotation: [0, 15, 0] } },
      { id: 'rock-1', ref: 'models/rock', transform: T([4, 0, 3]) },
      { id: 'road-1', ref: 'models/road-stretch', transform: T([0, 0, 0]) },
    ],
    cameras: [],
  }
  useSceneStore.setState({
    sceneId: 'scene-w03',
    document: doc,
    selectedAssetId: null,
    sceneError: null,
    manifest: {
      generatedAt: 'test',
      models: {
        'models/oak-tree': { id: 'oak-tree', name: '橡树', dimensions: { w: 3, h: 5, d: 3 }, source: { type: 'primitive', shape: 'box' } },
        'models/cottage': { id: 'cottage', name: '村舍', dimensions: { w: 6, h: 4, d: 5 }, source: { type: 'primitive', shape: 'box' } },
        'models/rock': { id: 'rock', name: '岩石', dimensions: { w: 1.5, h: 1, d: 1.5 }, source: { type: 'primitive', shape: 'box' } },
        'models/road-stretch': { id: 'road', name: '道路', dimensions: { w: 2, h: 0.1, d: 18 }, source: { type: 'primitive', shape: 'box' } },
      },
    },
  })
}

const PARTITION: PartitionSnapshot = {
  partitionVersion: 1,
  regions: [
    {
      schemaVersion: 1,
      id: 'region-north',
      name: '北林地',
      polygonXZ: [
        [-8, -8],
        [8, -8],
        [8, -0.5],
        [-8, -0.5],
      ],
      objectIds: ['tree-1', 'tree-2'],
      cameraId: 'cam-north',
      partitionVersion: 1,
    },
    {
      schemaVersion: 1,
      id: 'region-south',
      name: '南村庄',
      polygonXZ: [
        [-8, 0.5],
        [8, 0.5],
        [8, 8],
        [-8, 8],
      ],
      objectIds: ['house-1', 'rock-1'],
      cameraId: 'cam-south',
      partitionVersion: 1,
    },
  ],
  globalReadonlyObjectIds: ['road-1'],
}

const DTO = (position: [number, number, number]) => ({
  position,
  rotationDeg: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
})

const NORMAL_STEPS = [
  { regionId: 'region-north', objectId: 'tree-1', transform: DTO([-6, 0, -6]) },
  { regionId: 'region-north', objectId: 'tree-2', transform: DTO([6, 0, -2]) },
  { regionId: 'region-south', objectId: 'house-1', transform: DTO([-5, 0, 6]) },
  { regionId: 'region-south', addRef: 'models/rock', transform: DTO([5, 0, 6]) },
]

const assetOf = (id: string): SceneAsset | undefined =>
  useSceneStore.getState().document?.assets.find(a => a.id === id)

let adapter = createEditorAdapter()

beforeEach(() => {
  // core 的 journal/redo/openTx 是模块级状态：scene:changed 事件会清空（core 内置行为）
  bus.emit('scene:changed', { sceneId: 'scene-w03' })
  seedScene()
  adapter.dispose()
  adapter = createEditorAdapter()
})

describe('真实 core：一轮多写单事务（T08 雏形）', () => {
  it('两区域 4 次写入 → 恰好新增 1 个 undo 单元（source=agent，ops=4），undo/redo 正确', async () => {
    const runtime = createRuntime({
      editor: { read: adapter, write: adapter },
      workflowFactory: () => createKnownTransformWorkflow({ steps: NORMAL_STEPS }),
      partitionProvider: () => PARTITION,
    })
    const unitsBefore = edit.historyUnits().length
    const result = await runtime.start('真实 core 单事务验证')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('completed')

    const units = edit.historyUnits()
    expect(units.length - unitsBefore).toBe(1)
    const unit = units[units.length - 1]
    expect(unit.source).toBe('agent')
    expect(unit.ops).toBe(4)

    // 写入生效
    expect(assetOf('tree-1')?.transform.position).toEqual([-6, 0, -6])
    const added = useSceneStore.getState().document!.assets.find(a => a.ref === 'models/rock' && a.id !== 'rock-1')
    expect(added).toBeTruthy()

    // node 环境无 window：saveScene 降级下载路径抛错 → 事件 save.failed，结果仍是 completed（§3.2）
    expect(runtime.recorder.events().map(e => e.type)).toContain('save.failed')

    // undo 恢复初始资产集合与 transform
    expect(edit.undo()).toBe(true)
    expect(assetOf('tree-1')?.transform.position).toEqual([-3, 0, -4])
    expect(assetOf('tree-2')?.transform.position).toEqual([2, 0, -5])
    expect(assetOf('house-1')?.transform.position).toEqual([-2, 0, 4])
    expect(useSceneStore.getState().document!.assets.find(a => a.id === added!.id)).toBeUndefined()

    // redo 重现成功结果
    expect(edit.redo()).toBe(true)
    expect(assetOf('tree-1')?.transform.position).toEqual([-6, 0, -6])
    expect(useSceneStore.getState().document!.assets.find(a => a.id === added!.id)).toBeTruthy()
  })

  it('执行中失败 → 回滚：历史不新增单元，资产完整恢复', async () => {
    const runtime = createRuntime({
      editor: { read: adapter, write: adapter },
      workflowFactory: () => createKnownTransformWorkflow({ steps: NORMAL_STEPS, failAtStep: 2 }),
      partitionProvider: () => PARTITION,
    })
    const unitsBefore = edit.historyUnits().length
    const result = await runtime.start('中途失败')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('rolled_back')

    expect(edit.historyUnits().length).toBe(unitsBefore) // 回滚不入账
    expect(assetOf('tree-1')?.transform.position).toEqual([-3, 0, -4])
    expect(assetOf('tree-2')?.transform.position).toEqual([2, 0, -5])
    expect(useSceneStore.getState().document!.assets.length).toBe(5)
  })

  it('执行中取消 → 回滚恢复（真实 core rollback 语义）', async () => {
    const runtime = createRuntime({
      editor: { read: adapter, write: adapter },
      workflowFactory: () =>
        createKnownTransformWorkflow({
          steps: [
            { regionId: 'region-north', objectId: 'tree-1', transform: DTO([-6, 0, -6]) },
            { regionId: 'region-south', objectId: 'house-1', transform: DTO([-5, 0, 6]), delayMs: 120 },
          ],
        }),
      partitionProvider: () => PARTITION,
    })
    const pending = runtime.start('将被取消')
    await new Promise(r => setTimeout(r, 30))
    await runtime.cancel()
    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('cancelled')
    expect(assetOf('tree-1')?.transform.position).toEqual([-3, 0, -4])
    expect(edit.historyUnits().length).toBe(0)
  })

  it('宿主限制记录：先人工编辑产生可 redo 项，CoAgent 回滚后 redo 栈已被 record() 清空', async () => {
    // 人工改动一次（产生 journal 单元）
    edit.setTransform('tree-1', { ...T([-3.5, 0, -4]), rotation: [0, 30, 0] }, { source: 'human' })
    edit.undo()
    expect(edit.canRedo).toBe(true) // 人工撤销后有 redo 项

    const runtime = createRuntime({
      editor: { read: adapter, write: adapter },
      workflowFactory: () => createKnownTransformWorkflow({ steps: NORMAL_STEPS, failAtStep: 1 }),
      partitionProvider: () => PARTITION,
    })
    await runtime.start('回滚')
    // 已知宿主限制（W00 §1.2 / SPEC §1.4）：CoAgent 的写入（record）清空 redo 栈，
    // 回滚不恢复 redo —— 断言该行为成立并留痕
    expect(edit.canRedo).toBe(false)
  })
})

describe('真实 core：editorAdapter 直接驱动', () => {
  function armedCtx(token: ReturnType<typeof adapter.beginRun>, writable: Set<string>) {
    return { runId: 'run-direct', taskId: null, toolCallId: 'call-x', token, writableObjectIds: writable }
  }

  it('指纹过期 → stale_object；core boolean 失败映射 asset_not_found/write_failed', () => {
    const token = adapter.beginRun('直接驱动')
    const writable = new Set(['tree-1', 'tree-2'])

    const stale = adapter.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: DTO([9, 9, 9]), expectedFingerprint: 'fp-wrong' },
      armedCtx(token, writable),
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('stale_object')

    const missing = adapter.applyAuthorized(
      { kind: 'remove', objectId: 'ghost', expectedFingerprint: 'x' },
      armedCtx(token, new Set(['ghost'])),
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('asset_not_found')

    const okWrite = adapter.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: DTO([-4, 0, -4]), expectedFingerprint: adapter.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint },
      armedCtx(token, writable),
    )
    expect(okWrite.ok).toBe(true)
    adapter.rollbackRun(token)
    expect(assetOf('tree-1')?.transform.position).toEqual([-3, 0, -4])
  })

  it('场景切换作废武装事务：后续写入 write_failed，不会静默开新事务', () => {
    const token = adapter.beginRun('切场景前')
    bus.emit('scene:changed', { sceneId: 'scene-w03' })
    const r = adapter.applyAuthorized(
      { kind: 'transform', objectId: 'tree-1', transform: DTO([9, 0, 9]), expectedFingerprint: adapter.snapshot({ objectIds: ['tree-1'] }).assets[0].fingerprint },
      armedCtx(token, new Set(['tree-1'])),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('write_failed')
    expect(assetOf('tree-1')?.transform.position).toEqual([-3, 0, -4]) // 未被写入
    expect(edit.historyUnits().length).toBe(0) // 没有静默产生新事务的入账
  })

  it('sceneRevision 随写入单调增长，订阅者收到变更对象集合', () => {
    const seen: Array<Array<string> | null> = []
    const unsub = adapter.subscribe(c => seen.push(c.changedObjectIds ? [...c.changedObjectIds] : null))
    const r0 = adapter.snapshot({}).sceneRevision
    const token = adapter.beginRun('revision 检查')
    adapter.applyAuthorized(
      { kind: 'transform', objectId: 'tree-2', transform: DTO([3, 0, -5]), expectedFingerprint: adapter.snapshot({ objectIds: ['tree-2'] }).assets[0].fingerprint },
      armedCtx(token, new Set(['tree-2'])),
    )
    const r1 = adapter.snapshot({}).sceneRevision
    expect(r1).toBeGreaterThan(r0)
    expect(seen.some(ids => ids !== null && ids.includes('tree-2'))).toBe(true)
    adapter.rollbackRun(token)
    unsub()
  })
})

// 静默 TS：ToolResult 类型在本文件用于将来扩展（保持 import 完整性）
export type { ToolResult as _ToolResult }
