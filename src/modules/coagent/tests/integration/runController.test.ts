/**
 * runController 集成测试（W03，FakeEditor + 已知 transform 假 workflow）：
 * 单事务单提交、失败/取消回滚、迟到写拒绝、重复 start、宿主忙碌、
 * 场景切换失效、保存一次、requestDisable。
 */

import { describe, expect, it } from 'vitest'
import { createRuntime } from '../../runtime/createRuntime'
import { createFakeEditor } from '../fakes/FakeEditor'
import { createKnownTransformWorkflow, type KnownTransformWorkflow } from '../fakes/fakeWorkflow'
import { TWO_REGION_ASSETS, TWO_REGION_CATALOG, makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const T = (position: [number, number, number]) => ({ position, rotationDeg: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] })

function makeSetup(spec: Parameters<typeof createKnownTransformWorkflow>[0], overrides: { hostBusy?: () => boolean } = {}) {
  const editor = createFakeEditor({ sceneId: 'scene-fixture', assets: TWO_REGION_ASSETS, catalog: TWO_REGION_CATALOG })
  let workflow: KnownTransformWorkflow | null = null
  const runtime = createRuntime({
    editor: { read: editor, write: editor },
    workflowFactory: () => (workflow ??= createKnownTransformWorkflow(spec)),
    isHostBusy: overrides.hostBusy ?? (() => false),
    partitionProvider: () => makeTwoRegionPartition(),
  })
  return { editor, runtime, workflow: () => workflow! }
}

const NORMAL_STEPS = [
  { regionId: 'region-north', objectId: 'tree-1', transform: T([-6, 0, -6]) },
  { regionId: 'region-north', objectId: 'tree-2', transform: T([6, 0, -2]) },
  { regionId: 'region-south', objectId: 'house-1', transform: T([-5, 0, 6]) },
  { regionId: 'region-south', addRef: 'models/rock', transform: T([5, 0, 6]) },
]

describe('runController 正常路径', () => {
  it('两区域 4 次写入：completed、只 commit 一次、保存一次、新增对象入写集合', async () => {
    const { editor, runtime } = makeSetup({ steps: NORMAL_STEPS })
    const result = await runtime.start('整理两个区域')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('completed')

    const st = editor.state()
    expect(st.committedRuns).toBe(1)
    expect(st.rolledBackRuns).toBe(0)
    expect(st.savedVersions).toEqual([1])
    expect(st.assetCount).toBe(TWO_REGION_ASSETS.length + 1)

    // 变换生效 + 新增对象存在
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-6, 0, -6])
    const added = editor.snapshot({}).assets.find(a => a.ref === 'models/rock' && a.id !== 'rock-1')
    expect(added).toBeTruthy()

    const events = runtime.recorder.events().map(e => e.type)
    expect(events).toContain('run.started')
    expect(events).toContain('run.committed')
    expect(events).not.toContain('run.rolled_back')
  })

  it('分区缺失 → invalid_plan', async () => {
    const editor = createFakeEditor()
    const runtime = createRuntime({ editor: { read: editor, write: editor }, partitionProvider: () => null })
    const r = await runtime.start('无分区请求')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_plan')
  })

  it('宿主忙碌（旧 Agent 任务中）→ run_busy', async () => {
    const { runtime } = makeSetup({ steps: NORMAL_STEPS }, { hostBusy: () => true })
    const r = await runtime.start('宿主忙')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('run_busy')
  })
})

describe('runController 失败/取消/回滚', () => {
  it('执行中失败（第 3 步注入）→ rolled_back，资产集合与 transform 完整恢复', async () => {
    const { editor, runtime } = makeSetup({ steps: NORMAL_STEPS, failAtStep: 2 })
    const result = await runtime.start('会在中途失败')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('rolled_back')

    const st = editor.state()
    expect(st.rolledBackRuns).toBe(1)
    expect(st.committedRuns).toBe(0)
    expect(st.assetCount).toBe(TWO_REGION_ASSETS.length)
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
    expect(editor.state().savedVersions).toEqual([])
    expect(runtime.recorder.events().map(e => e.type)).toContain('run.rolled_back')
  })

  it('执行中取消 → 取消并回滚；迟到写入被拒且不落盘', async () => {
    const lateWrite = { objectId: 'tree-1', transform: T([99, 0, 99]) }
    const { editor, runtime, workflow } = makeSetup({
      steps: [
        { regionId: 'region-north', objectId: 'tree-1', transform: T([-6, 0, -6]) },
        { regionId: 'region-north', objectId: 'tree-2', transform: T([6, 0, -2]), delayMs: 150 },
        { regionId: 'region-south', objectId: 'house-1', transform: T([-5, 0, 6]) },
      ],
      lateWriteAfterAbort: lateWrite,
    })
    const pending = runtime.start('会被取消')
    await new Promise(r => setTimeout(r, 60)) // 第一步已写入、第二步延时中
    await runtime.cancel()
    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('cancelled')

    // 全部恢复
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
    expect(editor.state().rolledBackRuns).toBe(1)
    expect(editor.state().committedRuns).toBe(0)

    // 迟到写入：signal 检查拒绝（cancelled），未产生任何修改
    const lw = workflow().lateWriteResults
    expect(lw.length).toBe(1)
    expect(lw[0].ok).toBe(false)
    if (!lw[0].ok) expect(lw[0].code).toBe('cancelled')
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
  })

  it('重复 start：活跃期间第二次 → run_busy', async () => {
    const { runtime } = makeSetup({
      steps: [
        { regionId: 'region-north', objectId: 'tree-1', transform: T([-6, 0, -6]) },
        { regionId: 'region-south', objectId: 'house-1', transform: T([-5, 0, 6]), delayMs: 120 },
      ],
    })
    const first = runtime.start('第一次')
    await new Promise(r => setTimeout(r, 20))
    const second = await runtime.start('第二次')
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('run_busy')
    const r1 = await first
    expect(r1.ok && r1.data.kind).toBe('completed')
  })

  it('运行中场景切换：武装事务作废，后续写入 write_failed，整轮走向 rolled_back/失败', async () => {
    const { editor, runtime } = makeSetup({
      steps: [
        { regionId: 'region-north', objectId: 'tree-1', transform: T([-6, 0, -6]) },
        { regionId: 'region-south', objectId: 'house-1', transform: T([-5, 0, 6]), delayMs: 80 },
      ],
    })
    const pending = runtime.start('切场景干扰')
    await new Promise(r => setTimeout(r, 20))
    editor.simulateSceneSwitch('scene-other', [{ id: 'solo', ref: 'models/rock', transform: T([0, 0, 0]) }])
    const result = await pending
    expect(result.ok).toBe(true)
    // 切场景后：house-1 已不存在 → 写入失败（write_failed）或对象缺失 → 非提交路径
    if (result.ok) expect(result.data.kind).not.toBe('completed')
    expect(editor.state().committedRuns).toBe(0)
  })

  it('requestDisable：取消活跃 run 并进入 disabled，后续 start 拒绝', async () => {
    const { runtime } = makeSetup({
      steps: [
        { regionId: 'region-north', objectId: 'tree-1', transform: T([-6, 0, -6]) },
        { regionId: 'region-south', objectId: 'house-1', transform: T([-5, 0, 6]), delayMs: 200 },
      ],
    })
    const pending = runtime.start('将被禁用')
    await new Promise(r => setTimeout(r, 30))
    await runtime.requestDisable()
    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.kind).toBe('cancelled')
    expect(runtime.phase()).toBe('disabled')
    const again = await runtime.start('禁用后')
    expect(again.ok).toBe(false)
  })

  it('越权对象（road-1 为 globalReadonly）→ 步骤失败并整轮回滚', async () => {
    const { editor, runtime } = makeSetup({
      steps: [
        { regionId: 'region-north', objectId: 'tree-1', transform: T([-6, 0, -6]) },
        { regionId: 'region-south', objectId: 'road-1', transform: T([0, 1, 0]) },
      ],
    })
    const result = await runtime.start('尝试改共享道路')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.kind).toBe('rolled_back')
    expect(editor.snapshot({ objectIds: ['tree-1'] }).assets[0].transform.position).toEqual([-3, 0, -4])
  })
})
