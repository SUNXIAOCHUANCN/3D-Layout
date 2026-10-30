/**
 * P2 `scene.pick` 工具：错误语义与返回结构。
 *
 * 关键断言（都是"不骗人"的边界）：
 * - 截图过期 → stale_observation 并提示复拍，不用旧图去点；
 * - 渲染端口不支持拾取 → bridge_unavailable，**不是**"空命中"；
 * - 坐标越界 → invalid_arguments；
 * - 命中只读对象仍返回详情，但标 readonly（点选不授权写入）。
 */

import { describe, expect, it } from 'vitest'
import { createFakeRender } from '../fakes/FakeRender'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { pickAt } from '../../tools/pickTools'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const T = (position: [number, number, number]) => ({
  position,
  rotationDeg: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
})

async function ctxWith(opts: { pickResult?: Parameters<typeof createFakeRender>[0] extends never ? never : unknown; readonlyId?: string } = {}) {
  const partition = makeTwoRegionPartition()
  const render = createFakeRender({
    ...(opts.pickResult ? { pickResult: opts.pickResult as never } : {}),
  })
  const ctx = createFakeWorkflowContext({ render, partition })
  const observation = await ctx.capture({
    runId: 'run-pick',
    phase: 'supplement',
    camera: {
      schemaVersion: 1,
      id: 'cam-pick',
      projection: 'orthographic',
      position: [0, 20, 0],
      target: [0, 0, 0],
      up: [0, 0, -1],
      near: 0.1,
      far: 100,
      aspect: 4 / 3,
      ortho: { left: -10, right: 10, top: 7.5, bottom: -7.5 },
    },
    width: 640,
    height: 480,
    objectIds: ['tree-1'],
    marked: false,
    sceneRevision: ctx.fakeEditor.snapshot({ objectIds: [] }).sceneRevision,
    fingerprints: {},
  })
  return { ctx, observation }
}

describe('P2 scene.pick 参数与过期检查', () => {
  it('observationId 不存在 → invalid_arguments', async () => {
    const { ctx } = await ctxWith()
    await expect(pickAt(ctx, { observationId: 'obs-ghost', u: 0.5, v: 0.5 })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
  })

  it('坐标越界 → invalid_arguments（不猜、不夹取）', async () => {
    const { ctx, observation } = await ctxWith()
    await expect(pickAt(ctx, { observationId: observation.id, u: 1.2, v: 0.5 })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
    await expect(pickAt(ctx, { observationId: observation.id, u: 0.5, v: -0.1 })).rejects.toMatchObject({
      code: 'invalid_arguments',
    })
  })

  it('场景在截图之后改过 → stale_observation 并提示复拍', async () => {
    const { ctx, observation } = await ctxWith({ pickResult: { hit: null } })
    // 触发一次场景级变更（revision 前进）
    ctx.fakeEditor.simulateSceneSwitch('scene-fixture', [
      { id: 'tree-1', ref: 'models/oak-tree', transform: T([-3, 0, -4]) },
    ])
    await expect(pickAt(ctx, { observationId: observation.id, u: 0.5, v: 0.5 })).rejects.toMatchObject({
      code: 'stale_observation',
    })
  })

  it('渲染端口不支持拾取 → bridge_unavailable（不是空命中）', async () => {
    const { ctx, observation } = await ctxWith() // 未编程 pickResult
    await expect(pickAt(ctx, { observationId: observation.id, u: 0.5, v: 0.5 })).rejects.toMatchObject({
      code: 'bridge_unavailable',
    })
  })
})

describe('P2 scene.pick 返回结构', () => {
  it('空白区 → hit=null（正常结果，不吸附）', async () => {
    const { ctx, observation } = await ctxWith({ pickResult: { hit: null } })
    const res = await pickAt(ctx, { observationId: observation.id, u: 0.5, v: 0.5 })
    expect(res.hit).toBeNull()
    expect(res.observationId).toBe(observation.id)
    expect(res.sceneRevision).toBe(observation.sceneRevision)
  })

  it('命中 → 带 id/命中点/ref/指纹；只读对象标 readonly', async () => {
    const partition = makeTwoRegionPartition()
    const readonlyId = partition.globalReadonlyObjectIds[0] ?? 'road-1'
    const render = createFakeRender({
      pickResult: { hit: { objectId: readonlyId, point: [0, 0, 0], distance: 3.25 } },
    })
    const ctx = createFakeWorkflowContext({ render, partition })
    const observation = await ctx.capture({
      runId: 'run-pick',
      phase: 'supplement',
      camera: {
        schemaVersion: 1,
        id: 'cam-pick',
        projection: 'orthographic',
        position: [0, 20, 0],
        target: [0, 0, 0],
        up: [0, 0, -1],
        near: 0.1,
        far: 100,
        aspect: 4 / 3,
        ortho: { left: -10, right: 10, top: 7.5, bottom: -7.5 },
      },
      width: 640,
      height: 480,
      objectIds: [readonlyId],
      marked: false,
      sceneRevision: ctx.fakeEditor.snapshot({ objectIds: [] }).sceneRevision,
      fingerprints: {},
    })

    const res = await pickAt(ctx, { observationId: observation.id, u: 0.5, v: 0.5 })
    expect(res.hit?.objectId).toBe(readonlyId)
    expect(res.hit?.distance).toBeCloseTo(3.25, 5)
    expect(res.hit?.readonly).toBe(true)
    expect(typeof res.hit?.fingerprint).toBe('string')
  })
})
