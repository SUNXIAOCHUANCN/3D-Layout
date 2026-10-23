/**
 * 工具注册表单测（W05）：角色过滤、作用域、基线要求、预算、未知工具。
 *
 * 这些规则是"模型不能越权"的实际执行点——提示词只是辅助，真正的门在这层。
 */

import { describe, expect, it } from 'vitest'
import type { AgentRole } from '../../contracts'
import { createToolRegistry } from '../../tools/registry'
import { createFakeWorkflowContext } from '../fakes/fakeContext'

const site = (over: Partial<{ role: AgentRole; regionId: string | null; taskId: string | null; toolCallId: string }> = {}) => ({
  runId: 'run-1',
  taskId: 'task-1',
  regionId: 'region-north',
  role: 'executor' as AgentRole,
  toolCallId: 'call-1',
  ...over,
})

function setup(maxCallsPerTask = 10) {
  const ctx = createFakeWorkflowContext()
  const registry = createToolRegistry(ctx, { maxCallsPerTask })
  const fp = (id: string) => ctx.editorRead.snapshot({ objectIds: [id] }).assets[0].fingerprint
  return { ctx, registry, fp }
}

describe('工具注册表：角色与工具可见性', () => {
  it('judge 的工具清单里没有写工具；executor 有', () => {
    const { registry } = setup()
    const judgeTools = registry.specs('judge').map(t => t.name)
    const execTools = registry.specs('executor').map(t => t.name)
    expect(judgeTools).not.toContain('edit.transform')
    expect(judgeTools).not.toContain('edit.add')
    expect(judgeTools).toContain('camera.capture')
    expect(execTools).toContain('edit.transform')
  })

  it('judge 直接调写工具 → out_of_scope（不是靠提示词约束）', async () => {
    const { registry } = setup()
    const r = await registry.call('edit.transform', { objectId: 'tree-1', transform: {}, expectedFingerprint: 'x' }, site({ role: 'judge' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('out_of_scope')
  })

  it('未知工具 → invalid_arguments', async () => {
    const { registry } = setup()
    const r = await registry.call('scene.nuke', {}, site())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_arguments')
  })
})

describe('工具注册表：作用域与基线', () => {
  it('写邻区对象 → out_of_scope', async () => {
    const { registry, fp } = setup()
    const r = await registry.call(
      'edit.transform',
      { objectId: 'house-1', transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] }, expectedFingerprint: fp('house-1') },
      site(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('out_of_scope')
  })

  it('写 global_readonly 对象 → out_of_scope', async () => {
    const { registry, fp } = setup()
    const r = await registry.call(
      'edit.transform',
      { objectId: 'road-1', transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] }, expectedFingerprint: fp('road-1') },
      site(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('out_of_scope')
  })

  it('没有基线指纹/证据 → invalid_arguments（写入必须基于一次观察）', async () => {
    const { registry } = setup()
    const r = await registry.call('edit.transform', { objectId: 'tree-1', transform: { position: [1, 0, 1], rotationDeg: [0, 0, 0], scale: [1, 1, 1] } }, site())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_arguments')
  })

  it('指纹过期 → stale_object 原样透出', async () => {
    const { registry } = setup()
    const r = await registry.call(
      'edit.transform',
      // W08.1：位置必须在北区内，否则会先被写前区域检查拒绝（out_of_scope），测不到 stale_object
      { objectId: 'tree-1', transform: { position: [1, 0, -3], rotationDeg: [0, 0, 0], scale: [1, 1, 1] }, expectedFingerprint: 'stale-fp' },
      site(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('stale_object')
  })

  it('basisObservationId 指向不存在的证据 → invalid_arguments', async () => {
    const { registry } = setup()
    const r = await registry.call(
      'edit.transform',
      { objectId: 'tree-1', transform: { position: [1, 0, 1], rotationDeg: [0, 0, 0], scale: [1, 1, 1] }, basisObservationId: 'obs-nope' },
      site(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('invalid_arguments')
  })

  it('W08.1 写前区域检查：add 落点越界 → out_of_scope，区内 → 允许', async () => {
    const { registry } = setup()
    const outside = await registry.call(
      'edit.add',
      { ref: 'models/rock', transform: { position: [20, 0, 20], rotationDeg: [0, 0, 0], scale: [1, 1, 1] } },
      site({ regionId: 'region-south' }),
    )
    expect(outside.ok).toBe(false)
    if (!outside.ok) expect(outside.error.code).toBe('out_of_scope')

    const inside = await registry.call(
      'edit.add',
      { ref: 'models/rock', transform: { position: [5, 0, 6], rotationDeg: [0, 0, 0], scale: [1, 1, 1] } },
      site({ regionId: 'region-south', toolCallId: 'call-add-inside' }),
    )
    expect(inside.ok).toBe(true)
  })

  it('W08.1 写前区域检查：transform 的占地范围越界 → out_of_scope（不能只看中心点）', async () => {
    const { registry, fp } = setup()
    const r = await registry.call(
      'edit.transform',
      { objectId: 'house-1', transform: { position: [-5, 0, 6], rotationDeg: [0, 15, 0], scale: [1, 1, 1] }, expectedFingerprint: fp('house-1') },
      site({ regionId: 'region-south' }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('out_of_scope')
  })

  it('fill.add 缺 ref → invalid_arguments；非法 transform → invalid_arguments', async () => {
    const { registry } = setup()
    const noRef = await registry.call('edit.add', { transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] } }, site())
    expect(noRef.ok).toBe(false)
    if (!noRef.ok) expect(noRef.error.code).toBe('invalid_arguments')

    const badTransform = await registry.call(
      'edit.add',
      { ref: 'models/rock', transform: { position: [0, 0, Number.NaN], rotationDeg: [0, 0, 0], scale: [1, 1, 1] } },
      site(),
    )
    expect(badTransform.ok).toBe(false)
    if (!badTransform.ok) expect(badTransform.error.code).toBe('invalid_arguments')
  })
})

describe('工具注册表：预算与渲染', () => {
  it('超过每任务工具预算 → budget_exceeded', async () => {
    const { registry } = setup(1)
    const first = await registry.call('scene.list_region', {}, site())
    expect(first.ok).toBe(true)
    const second = await registry.call('scene.list_region', {}, site())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('budget_exceeded')
    // 换任务重新计数
    const other = await registry.call('scene.list_region', {}, site({ taskId: 'task-2', toolCallId: 'call-2' }))
    expect(other.ok).toBe(true)
  })

  it('camera.capture 走 context.capture，返回的 observation 进证据集合', async () => {
    const { ctx, registry } = setup()
    const r = await registry.call('camera.capture', { phase: 'task_before', marked: true }, site())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const obs = r.data as { id: string; phase: string; labels: unknown[] }
    expect(obs.phase).toBe('task_before')
    expect(obs.labels.length).toBe(2)
    expect(ctx.observations.get(obs.id)).toBeTruthy()
  })

  it('scene.get_objects 一次最多 20 个；不存在的对象 → asset_not_found', async () => {
    const { registry } = setup()
    const tooMany = await registry.call('scene.get_objects', { objectIds: Array.from({ length: 21 }, (_, i) => `o-${i}`) }, site())
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.error.code).toBe('invalid_arguments')

    const missing = await registry.call('scene.get_objects', { objectIds: ['nope'] }, site())
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('asset_not_found')
  })
})

/**
 * 2026-10-22 跑「再添一个料箱」示例时暴露的缺陷（回归锁）：
 * 1. library.search 用**整串**匹配，"box crate 料箱" 这种多关键词查询必然返回空
 *    → 模型再换 3~4 个关键词反复试 → 6 轮预算耗尽 → budget_exceeded；
 * 2. limit 越界（模型要 12）直接报错，白白多花一轮。
 */
describe('工具注册表：library.search 的多关键词与 limit 越界（回归锁）', () => {
  it('多关键词查询按"任一命中"匹配（不再整串匹配返回空）', async () => {
    const { registry } = setup()
    // 整串 "cottage 村舍" 匹配不到任何条目；拆词后 "cottage" 能命中 models/cottage
    const r = await registry.call('library.search', { query: 'cottage 村舍' }, site({ role: 'main', regionId: null, taskId: null }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { entries: Array<{ ref: string }> }
    expect(data.entries.length).toBeGreaterThan(0)
    expect(data.entries.some(e => e.ref === 'models/cottage')).toBe(true)
  })

  it('单个关键词仍正常匹配', async () => {
    const { registry } = setup()
    const r = await registry.call('library.search', { query: 'cottage' }, site({ role: 'main', regionId: null, taskId: null }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { entries: Array<{ ref: string }> }
    expect(data.entries.length).toBeGreaterThan(0)
  })

  it('按名字（中文）也能命中', async () => {
    const { registry } = setup()
    const r = await registry.call('library.search', { query: '村舍' }, site({ role: 'main', regionId: null, taskId: null }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { entries: Array<{ ref: string }> }
    expect(data.entries.some(e => e.ref === 'models/cottage')).toBe(true)
  })

  it('limit 超过上限 → 夹到 10，不报错（不浪费一轮）', async () => {
    const { registry } = setup()
    const r = await registry.call('library.search', { query: 'cottage', limit: 12 }, site({ role: 'main', regionId: null, taskId: null }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const data = r.data as { entries: unknown[] }
    expect(data.entries.length).toBeLessThanOrEqual(10)
  })

  it('limit 小于 1 → 夹到 1，不报错', async () => {
    const { registry } = setup()
    const r = await registry.call('library.search', { query: 'cottage', limit: 0 }, site({ role: 'main', regionId: null, taskId: null }))
    expect(r.ok).toBe(true)
  })
})

/**
 * 2026-10-22 T14 真机实测暴露的两个缺陷（回归锁）：
 * 1. planner（main 角色，regionId=null）调 camera.capture 必然 out_of_scope ——
 *    旧实现无条件 regionOf()，即使模型自带了 camera 快照也照样被拒；
 * 2. 模型重发同一条 edit.transform 时，幂等键（含 toolCallId）命不中，
 *    而首次写入已改掉指纹 → stale_object → 模型看到失败就再发 → 死循环超预算。
 */
describe('工具注册表：T14 真机暴露的缺陷（回归锁）', () => {
  it('planner 无 region 上下文时，自带 camera 快照就能拍图（不再无条件 out_of_scope）', async () => {
    const { ctx, registry } = setup()
    const camera = {
      schemaVersion: 1 as const,
      id: 'cam-planner',
      position: [0, 10, 0] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      up: [0, 1, 0] as [number, number, number],
      projection: 'orthographic' as const,
      ortho: { left: -5, right: 5, top: 5, bottom: -5 },
      near: 0.1,
      far: 100,
      aspect: 1,
    }
    const r = await registry.call(
      'camera.capture',
      { phase: 'baseline', camera, objectIds: ['tree-1'] },
      site({ role: 'main', regionId: null, taskId: null }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const obs = r.data as { id: string; regionId?: string }
    expect(ctx.observations.get(obs.id)).toBeTruthy()
  })

  it('planner 无 region 上下文又没给 camera → 明确报错要相机快照（不是含糊的 out_of_scope）', async () => {
    const { registry } = setup()
    const r = await registry.call('camera.capture', { phase: 'baseline' }, site({ role: 'main', regionId: null, taskId: null }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('out_of_scope')
      expect(r.error.message).toContain('camera')
    }
  })

  it('重发同一条 edit.transform（目标已达成）→ 返回成功并标记 alreadySatisfied，不再是 stale_object', async () => {
    const { registry, fp } = setup()
    const target = { position: [-6, 0, -6] as [number, number, number], rotationDeg: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }
    // 固定用**基线**指纹：模型重发时带的还是写之前那个指纹
    const baselineFp = fp('tree-1')
    const first = await registry.call(
      'edit.transform',
      { objectId: 'tree-1', transform: target, expectedFingerprint: baselineFp },
      site({ toolCallId: 'call-1' }),
    )
    expect(first.ok).toBe(true)

    // 模型用**新的 toolCallId** 重发同一条命令（幂等键命不中，指纹已过期）
    const again = await registry.call(
      'edit.transform',
      { objectId: 'tree-1', transform: target, expectedFingerprint: baselineFp },
      site({ toolCallId: 'call-2' }),
    )
    expect(again.ok).toBe(true)
    if (!again.ok) return
    const data = again.data as { alreadySatisfied?: boolean; message?: string }
    expect(data.alreadySatisfied).toBe(true)
    // 回执要明确告诉模型"不用再改"，否则它会继续重发
    expect(String(data.message)).toContain('无需再次修改')
  })

  it('重发但目标**不同** → 仍然是 stale_object（不能把真冲突吞成成功）', async () => {
    const { registry, fp } = setup()
    const baselineFp = fp('tree-1')
    const first = await registry.call(
      'edit.transform',
      { objectId: 'tree-1', transform: { position: [-6, 0, -6], rotationDeg: [0, 0, 0], scale: [1, 1, 1] }, expectedFingerprint: baselineFp },
      site({ toolCallId: 'call-1' }),
    )
    expect(first.ok).toBe(true)
    const conflicting = await registry.call(
      'edit.transform',
      { objectId: 'tree-1', transform: { position: [-5, 0, -5], rotationDeg: [0, 0, 0], scale: [1, 1, 1] }, expectedFingerprint: baselineFp },
      site({ toolCallId: 'call-2' }),
    )
    expect(conflicting.ok).toBe(false)
    if (!conflicting.ok) expect(conflicting.error.code).toBe('stale_object')
  })
})
