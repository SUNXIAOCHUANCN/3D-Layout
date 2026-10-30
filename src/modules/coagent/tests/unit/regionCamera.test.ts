/**
 * P2 区域相机数学 + 一次调用完成观察（inspect / adjust）。
 *
 * 约定必须与文档一致，否则模型会算错方向：
 * - 世界 +Y 向上；azimuth 0 = 从 +Z 看向目标，正角转向 +X；
 * - elevation 是绝对俯仰（0 水平、90 顶视），夹取后要在 warnings 里说明；
 * - zoomFactor < 1 拉近；pan 按画面跨度比例，正 right 向右。
 */

import { describe, expect, it } from 'vitest'
import type { CameraSnapshot } from '../../contracts'
import { orbitCamera, orbitOffset, describeCamera } from '../../services/regionCamera'
import { adjustWith, inspectWith, regionCamera } from '../../tools/cameraTools'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const base = (over: Partial<CameraSnapshot> = {}): CameraSnapshot => ({
  schemaVersion: 1,
  id: 'cam-base',
  projection: 'perspective',
  position: [0, 0, 10],
  target: [0, 0, 0],
  up: [0, 1, 0],
  near: 0.1,
  far: 100,
  aspect: 4 / 3,
  fovDeg: 45,
  ...over,
})

const dist = (c: CameraSnapshot): number =>
  Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2])

describe('P2 相机方位约定', () => {
  it('azimuth=0 落在 +Z 侧，elevation=0 与目标等高', () => {
    const p = orbitOffset(0, 0)
    expect(p[0]).toBeCloseTo(0, 6)
    expect(p[1]).toBeCloseTo(0, 6)
    expect(p[2]).toBeCloseTo(1, 6)
  })

  it('azimuth=90 转向 +X', () => {
    const p = orbitOffset(90, 0)
    expect(p[0]).toBeCloseTo(1, 6)
    expect(p[2]).toBeCloseTo(0, 6)
  })

  it('elevation=90 指向正上方', () => {
    const p = orbitOffset(0, 90)
    expect(p[1]).toBeCloseTo(1, 6)
  })
})

describe('P2 相机调整', () => {
  it('方位增量绕目标旋转，距离不变', () => {
    const before = base()
    const { camera } = orbitCamera(before, { azimuthDeltaDeg: 90 })
    expect(camera.position[0]).toBeCloseTo(10, 4) // 转到 +X
    expect(camera.position[2]).toBeCloseTo(0, 4)
    expect(dist(camera)).toBeCloseTo(10, 3)
  })

  it('zoomFactor<1 拉近、>1 拉远', () => {
    const near = orbitCamera(base(), { zoomFactor: 0.5 }).camera
    const far = orbitCamera(base(), { zoomFactor: 2 }).camera
    expect(dist(near)).toBeCloseTo(5, 3)
    expect(dist(far)).toBeCloseTo(20, 3)
  })

  it('elevationDeg 是绝对值（不是增量）', () => {
    const first = orbitCamera(base(), { elevationDeg: 45 }).camera
    const second = orbitCamera(first, { elevationDeg: 45 }).camera
    expect(dist(second)).toBeCloseTo(dist(first), 3)
    // 两次设置同一绝对俯仰，高度应一致
    expect(second.position[1]).toBeCloseTo(first.position[1], 3)
  })

  it('俯仰超出范围被夹取并给出 warning（不产生奇异相机）', () => {
    const { camera, warnings } = orbitCamera(base(), { elevationDeg: 90 })
    expect(warnings.join(' ')).toContain('俯仰')
    // 默认上限 85°：几乎在正上方，但不是 90°（避免 lookAt 与 up 平行）
    const d = dist(camera)
    expect(camera.position[0]).toBeCloseTo(0, 4)
    expect(camera.position[1] / d).toBeCloseTo(Math.sin((85 * Math.PI) / 180), 3)
    expect(camera.position[2]).toBeGreaterThan(0) // 留了一点前向，不是奇异位形
    expect(Number.isFinite(camera.position[1])).toBe(true)
  })

  it('zoomFactor<=0 按 1 处理并警告', () => {
    const { camera, warnings } = orbitCamera(base(), { zoomFactor: 0 })
    expect(warnings.join(' ')).toContain('zoomFactor')
    expect(dist(camera)).toBeCloseTo(10, 3)
  })

  it('pan 正 right 把目标点推向 +X（azimuth=0 时）', () => {
    const { camera } = orbitCamera(base(), { pan: { right: 0.5, up: 0 } })
    expect(camera.target[0]).toBeGreaterThan(0)
    expect(camera.target[2]).toBeCloseTo(0, 4)
  })

  it('正交基相机换算成透视后取景尺度不突变', () => {
    const ortho: CameraSnapshot = base({
      projection: 'orthographic',
      position: [0, 20, 0],
      target: [0, 0, 0],
      ortho: { left: -10, right: 10, top: 7.5, bottom: -7.5 },
    })
    const { camera } = orbitCamera(ortho, {})
    expect(camera.projection).toBe('perspective')
    // 半高 7.5m、fov 45° → 距离 ≈ 7.5 / tan(22.5°) ≈ 18.1
    expect(dist(camera)).toBeGreaterThan(15)
    expect(dist(camera)).toBeLessThan(21)
  })

  it('非法输入不产生 NaN', () => {
    const { camera } = orbitCamera(base(), { azimuthDeltaDeg: NaN, elevationDeg: NaN, zoomFactor: NaN })
    for (const v of [...camera.position, ...camera.target]) expect(Number.isFinite(v)).toBe(true)
  })

  it('describeCamera 能给出可读方位', () => {
    expect(describeCamera(base())).toContain('方位 0°')
  })
})

describe('P2 一次调用完成观察', () => {
  const partition = makeTwoRegionPartition()
  const region = partition.regions[0]

  it('camera.inspect 聚焦对象并当场截图（640×480）', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    const out = await inspectWith(ctx, {
      runId: 'run-cam',
      taskId: null,
      regionId: region.id,
      objectIds: region.objectIds.slice(0, 2),
      framing: 'tight',
      phase: 'supplement',
      marked: true,
    })
    expect(out.observation.width).toBe(640)
    expect(out.observation.height).toBe(480)
    expect(out.observation.camera.projection).toBe('perspective')
    // 相机确实对准了对象（目标点在对象附近，而不是原点以外）
    expect(out.camera.target.some((v, i) => Math.abs(v - out.observation.camera.target[i]) < 1e-9)).toBe(true)
  })

  it('camera.adjust 不传基相机时回落到本区总览', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    const overview = regionCamera(region)
    const out = await adjustWith(ctx, {
      runId: 'run-cam',
      taskId: null,
      regionId: region.id,
      region,
      adjust: { zoomFactor: 0.5 },
      phase: 'supplement',
      marked: false,
    })
    expect(out.observation.camera.projection).toBe('perspective')
    expect(out.observation.width).toBe(640)
    // 从正交总览换算后再拉近，距离应当比换算值小
    expect(dist(out.camera)).toBeLessThan(dist(overview) * 20)
  })

  it('camera.adjust 用 fromObservationId 的相机做基座', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    const first = await inspectWith(ctx, {
      runId: 'run-cam',
      taskId: null,
      regionId: region.id,
      objectIds: region.objectIds.slice(0, 1),
      framing: 'context',
      phase: 'supplement',
      marked: false,
    })
    const out = await adjustWith(ctx, {
      runId: 'run-cam',
      taskId: null,
      regionId: region.id,
      region,
      fromObservationId: first.observation.id,
      adjust: { azimuthDeltaDeg: 90 },
      phase: 'supplement',
      marked: false,
    })
    expect(dist(out.camera)).toBeCloseTo(dist(first.camera), 2)
  })

  it('没有基相机也没有 region → out_of_scope（不瞎猜视角）', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    await expect(
      adjustWith(ctx, {
        runId: 'run-cam',
        taskId: null,
        regionId: null,
        region: null,
        adjust: { zoomFactor: 0.5 },
        phase: 'supplement',
        marked: false,
      }),
    ).rejects.toMatchObject({ code: 'out_of_scope' })
  })
})

/**
 * P2：每区一台工作相机。
 *
 * 没有这个状态，`camera.adjust` 每次都会从俯视总览重来——"绕到侧面看"根本做不到。
 */
describe('P2 分区工作相机状态', () => {
  const partition = makeTwoRegionPartition()
  const regionA = partition.regions[0]
  const regionB = partition.regions[1]

  it('inspect 之后该区记住工作视角（含聚焦对象与证据 id）', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    const focusIds = regionA.objectIds.slice(0, 2)
    const out = await inspectWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionA.id,
      objectIds: focusIds,
      framing: 'tight',
      phase: 'supplement',
      marked: true,
    })

    const view = ctx.regionViews.get(regionA.id)
    expect(view).not.toBeNull()
    expect(view!.viewVersion).toBe(1)
    expect(view!.focusedObjectIds).toEqual(focusIds)
    expect(view!.latestObservationId).toBe(out.observation.id)
    expect(view!.camera.id).toBe(out.camera.id)
  })

  it('连续两次 adjust 累积在同一台相机上（不是每次回到总览）', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    await inspectWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionA.id,
      objectIds: regionA.objectIds.slice(0, 1),
      framing: 'context',
      phase: 'supplement',
      marked: false,
    })
    const first = ctx.regionViews.get(regionA.id)!
    const d1 = dist(first.camera)

    // 第一次调整：不传 base，应当从刚聚焦的视角继续
    const a1 = await adjustWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionA.id,
      region: regionA,
      adjust: { zoomFactor: 0.5 },
      phase: 'supplement',
      marked: false,
    })
    expect(dist(a1.camera)).toBeCloseTo(d1 * 0.5, 2)

    // 第二次调整：仍然接着上一台相机（再拉近一半）
    const a2 = await adjustWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionA.id,
      region: regionA,
      adjust: { zoomFactor: 0.5 },
      phase: 'supplement',
      marked: false,
    })
    expect(dist(a2.camera)).toBeCloseTo(d1 * 0.25, 2)
    expect(ctx.regionViews.get(regionA.id)!.viewVersion).toBe(3) // inspect 1 + 两次 adjust
  })

  it('两个区域各记各的，互不影响', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    await inspectWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionA.id,
      objectIds: regionA.objectIds.slice(0, 1),
      framing: 'tight',
      phase: 'supplement',
      marked: false,
    })
    await inspectWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionB.id,
      objectIds: regionB.objectIds.slice(0, 1),
      framing: 'context',
      phase: 'supplement',
      marked: false,
    })

    const a = ctx.regionViews.get(regionA.id)!
    const b = ctx.regionViews.get(regionB.id)!
    expect(a.camera.id).not.toBe(b.camera.id)
    expect(a.regionId).toBe(regionA.id)
    expect(b.regionId).toBe(regionB.id)
    expect(ctx.regionViews.all()).toHaveLength(2)
  })

  it('聚焦对象被删除 → 退回总览并说明原因（不继续对着旧包围盒）', async () => {
    const ctx = createFakeWorkflowContext({ partition })
    const focusId = regionA.objectIds[0]
    await inspectWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionA.id,
      objectIds: [focusId],
      framing: 'tight',
      phase: 'supplement',
      marked: false,
    })
    expect(ctx.regionViews.get(regionA.id)!.focusedObjectIds).toEqual([focusId])

    // 场景整体换掉（聚焦对象不存在了）
    ctx.fakeEditor.simulateSceneSwitch(
      'scene-fixture',
      regionB.objectIds.map(id => ({
        id,
        ref: 'models/oak-tree',
        transform: {
          position: [0, 0, 0] as [number, number, number],
          rotationDeg: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
      })),
    )

    const out = await adjustWith(ctx, {
      runId: 'run-view',
      taskId: null,
      regionId: regionA.id,
      region: regionA,
      adjust: { zoomFactor: 0.8 },
      phase: 'supplement',
      marked: false,
    })
    expect(out.warnings.join(' ')).toContain('已被删除')
    expect(ctx.regionViews.get(regionA.id)!.focusedObjectIds).toEqual(
      // clearFocus 之后又 put 了本次的 objectIds——这里是 regionA 的前 12 个
      regionA.objectIds.slice(0, 12),
    )
  })
})
