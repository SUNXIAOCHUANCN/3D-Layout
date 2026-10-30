/**
 * P4 分区配套文件：契约、指纹、校验、恢复核对、IO 降级。
 *
 * 断言的都是"用户能观察到的行为"：重开能恢复、文件坏了不覆盖、删掉的对象不复活、
 * 服务端不可写时降级为下载而不是静默失败。
 */

import { describe, expect, it } from 'vitest'
import {
  PARTITION_FILE_SCHEMA_VERSION,
  buildPartitionFile,
  parsePartitionFile,
  planPartitionSave,
  reconcilePartitionFile,
  sceneContentFingerprint,
  type PartitionFile,
} from '../../services/partitionPersistence'
import { readPartitionFile, savePartitionFile, type FetchLike } from '../../adapters/partitionAdapter'
import { TWO_REGION_ASSETS, makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const T = (position: [number, number, number]) => ({
  position,
  rotationDeg: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
})

const assets = TWO_REGION_ASSETS

function fileOf(over: Partial<Parameters<typeof buildPartitionFile>[0]> = {}): PartitionFile {
  return buildPartitionFile({
    sceneId: 'scene-fixture',
    partition: makeTwoRegionPartition(),
    assets,
    savedAt: '2026-10-27T00:00:00.000Z',
    ...over,
  })
}

describe('P4 导出格式', () => {
  it('导出 → 解析 → 区域与归属保持不变', () => {
    const file = fileOf()
    expect(file.schemaVersion).toBe(PARTITION_FILE_SCHEMA_VERSION)
    expect(file.sceneId).toBe('scene-fixture')
    expect(file.regions.length).toBe(2)

    const parsed = parsePartitionFile(JSON.parse(JSON.stringify(file)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.regions.map(r => r.id)).toEqual(file.regions.map(r => r.id))
    expect(parsed.file.assignments.length).toBe(file.assignments.length)
  })

  it('不保存 objectCount：数量在恢复时按当前场景算', () => {
    const file = fileOf() as unknown as Record<string, unknown>
    expect(JSON.stringify(file)).not.toContain('objectCount')
  })

  it('只读对象进 readonlyAssignments，不重复出现在 assignments 里', () => {
    const file = fileOf()
    const readonly = new Set(file.readonlyAssignments.map(a => a.objectId))
    expect(readonly.size).toBeGreaterThan(0)
    expect(file.assignments.some(a => readonly.has(a.objectId))).toBe(false)
  })
})

describe('P4 内容指纹', () => {
  it('与资产顺序无关', () => {
    const a = sceneContentFingerprint(assets)
    const b = sceneContentFingerprint([...assets].reverse())
    expect(a).toBe(b)
  })

  it('位置变化会改变指纹', () => {
    const base = sceneContentFingerprint(assets)
    const moved = assets.map(x => (x.id === assets[0].id ? { ...x, transform: { ...x.transform, position: [9, 0, 9] as [number, number, number] } } : x))
    expect(sceneContentFingerprint(moved)).not.toBe(base)
  })

  it('缺省 scale 与显式 [1,1,1] 等价（core 的 scale 是可选的）', () => {
    const withScale = [{ id: 'a', ref: 'r', transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] } }]
    const without = [{ id: 'a', ref: 'r', transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0] } }]
    expect(sceneContentFingerprint(withScale)).toBe(sceneContentFingerprint(without))
  })
})

describe('P4 文件校验（坏文件不启用、不覆盖）', () => {
  const base = () => JSON.parse(JSON.stringify(fileOf())) as Record<string, unknown>

  it('未知 schemaVersion 被拒', () => {
    const raw = { ...base(), schemaVersion: 99 }
    const parsed = parsePartitionFile(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('schemaVersion')
  })

  it('缺少 regions 被拒', () => {
    const parsed = parsePartitionFile({ ...base(), regions: [] })
    expect(parsed.ok).toBe(false)
  })

  it('归属指向不存在的区域被拒', () => {
    const raw = base()
    const assignments = raw.assignments as Array<Record<string, unknown>>
    assignments[0] = { ...assignments[0], regionId: 'region-ghost' }
    const parsed = parsePartitionFile(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('region-ghost')
  })

  it('自交多边形被拒（复用既有几何校验）', () => {
    const raw = base()
    const regions = raw.regions as Array<Record<string, unknown>>
    regions[0] = { ...regions[0], polygonXZ: [[0, 0], [1, 1], [1, 0], [0, 1]] }
    const parsed = parsePartitionFile(raw)
    expect(parsed.ok).toBe(false)
  })

  it('非法 source 被拒', () => {
    const raw = base()
    const assignments = raw.assignments as Array<Record<string, unknown>>
    assignments[0] = { ...assignments[0], source: 'magic' }
    const parsed = parsePartitionFile(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('source')
  })

  it('不是对象/不是 JSON 形状 → 明确拒绝', () => {
    expect(parsePartitionFile(null).ok).toBe(false)
    expect(parsePartitionFile([1, 2, 3]).ok).toBe(false)
  })
})

describe('P4 恢复核对', () => {
  it('对象被删除 → 从分区移除，不制造幽灵对象', () => {
    const file = fileOf()
    const live = assets.filter(a => a.id !== 'tree-1')
    const { partition, report } = reconcilePartitionFile(file, live)

    expect(report.droppedObjectIds).toContain('tree-1')
    const allIds = partition.regions.flatMap(r => r.objectIds)
    expect(allIds).not.toContain('tree-1')
    expect(partition.globalReadonlyObjectIds).not.toContain('tree-1')
  })

  it('同 ID 但 ref 变了 → 进 unresolved 且不可写', () => {
    const file = fileOf()
    const mutated = assets.map(a => (a.id === 'tree-1' ? { ...a, ref: 'models/cottage' } : a))
    const { partition, report } = reconcilePartitionFile(file, mutated)

    expect(report.identityChangedObjectIds).toContain('tree-1')
    expect(report.unresolvedObjectIds).toContain('tree-1')
    expect(partition.regions.flatMap(r => r.objectIds)).not.toContain('tree-1')
    // 不可写：被放进 globalReadonly（可见但禁止改）
    expect(partition.globalReadonlyObjectIds).toContain('tree-1')
  })

  it('场景新增但文件没记录的对象不自动归属', () => {
    const file = fileOf()
    const extra = [...assets, { id: 'new-tree', ref: 'models/oak-tree', transform: T([0, 0, 3]) }]
    const { report } = reconcilePartitionFile(file, extra)
    expect(report.unassignedObjectIds).toContain('new-tree')
  })

  it('内容指纹不一致时明确标记（不假装 exact）', () => {
    const file = fileOf()
    const moved = assets.map(a => (a.id === 'tree-2' ? { ...a, transform: T([1, 0, 1]) } : a))
    const { report } = reconcilePartitionFile(file, moved)
    expect(report.fingerprintMatch).toBe(false)
  })

  it('未改动场景 → 指纹一致且恢复出的分区与原始等价', () => {
    const original = makeTwoRegionPartition()
    const file = fileOf({ partition: original })
    const { partition, report } = reconcilePartitionFile(file, assets)

    expect(report.fingerprintMatch).toBe(true)
    expect(partition.partitionVersion).toBe(original.partitionVersion)
    for (const region of original.regions) {
      const restored = partition.regions.find(r => r.id === region.id)
      expect(restored?.objectIds.sort()).toEqual([...region.objectIds].sort())
      expect(restored?.polygonXZ).toEqual(region.polygonXZ)
    }
  })
})

describe('P4 保存链决策（与场景保存同一份快照）', () => {
  const base = {
    enabled: true,
    partition: makeTwoRegionPartition(),
    source: 'generated' as const,
    snapshot: { sceneId: 'scene-fixture', assets },
    saved: { mode: 'server' },
  }

  it('正常情况 → 写文件，且指纹绑定的是**传入的那份快照**', () => {
    const plan = planPartitionSave(base)
    expect(plan.action).toBe('write')
    if (plan.action !== 'write') return
    expect(plan.file.sceneId).toBe('scene-fixture')
    // 关键：指纹来自传入快照，而不是"调用时的当前场景"
    expect(plan.file.sceneFingerprint).toBe(sceneContentFingerprint(assets))

    // 换一份内容不同的快照 → 指纹随之改变（证明绑定生效）
    const moved = assets.map(a => (a.id === assets[0].id ? { ...a, transform: { ...a.transform, position: [9, 0, 9] as [number, number, number] } } : a))
    const plan2 = planPartitionSave({ ...base, snapshot: { sceneId: 'scene-fixture', assets: moved } })
    expect(plan2.action).toBe('write')
    if (plan2.action !== 'write') return
    expect(plan2.file.sceneFingerprint).not.toBe(plan.file.sceneFingerprint)
  })

  it('未开启持久化 → 跳过', () => {
    expect(planPartitionSave({ ...base, enabled: false })).toMatchObject({ action: 'skip' })
  })

  it('没有分区 → 跳过', () => {
    expect(planPartitionSave({ ...base, partition: null })).toMatchObject({ action: 'skip' })
  })

  it('调试注入的分区 → 跳过（不污染真实场景目录）', () => {
    const plan = planPartitionSave({ ...base, source: 'injected' })
    expect(plan.action).toBe('skip')
    if (plan.action === 'skip') expect(plan.reason).toContain('调试注入')
  })

  it('场景没保存成功 → 跳过，并说明原因（否则指纹描述一个没落盘的场景）', () => {
    const plan = planPartitionSave({ ...base, saved: null, saveError: '磁盘只读' })
    expect(plan.action).toBe('skip')
    if (plan.action === 'skip') {
      expect(plan.reason).toContain('场景未保存')
      expect(plan.reason).toContain('磁盘只读')
    }
  })

  it('快照缺 sceneId → 跳过', () => {
    expect(planPartitionSave({ ...base, snapshot: { sceneId: null, assets } })).toMatchObject({ action: 'skip' })
  })
})

describe('P4 IO 与降级', () => {
  const okFetch = (body: unknown, status = 200): FetchLike => async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    text: async () => JSON.stringify(body),
  })

  it('404 → absent（没有文件是正常状态）', async () => {
    const res = await readPartitionFile('scene-fixture', { fetchImpl: okFetch({}, 404) })
    expect(res.status).toBe('absent')
  })

  it('合法文件 → ok', async () => {
    const res = await readPartitionFile('scene-fixture', { fetchImpl: okFetch(fileOf()) })
    expect(res.status).toBe('ok')
  })

  it('坏 JSON → invalid，且不抛异常', async () => {
    const bad: FetchLike = async () => ({ ok: true, status: 200, text: async () => '{not json' })
    const res = await readPartitionFile('scene-fixture', { fetchImpl: bad })
    expect(res.status).toBe('invalid')
  })

  /**
   * 实测发现：静态托管的 SPA fallback 对缺失文件返回 200 + index.html。
   * 那是"没有文件"，不是"文件损坏"——不能报 invalid，否则用户会看到"分区文件损坏"。
   */
  it('SPA fallback 返回 HTML → 视为 absent，而不是 invalid', async () => {
    const html: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => '<!doctype html>\n<html lang="zh-CN"><head></head></html>',
    })
    const res = await readPartitionFile('scene-fixture', { fetchImpl: html })
    expect(res.status).toBe('absent')
  })

  it('sceneId 与当前场景不一致 → invalid', async () => {
    const res = await readPartitionFile('scene-other', { fetchImpl: okFetch(fileOf()) })
    expect(res.status).toBe('invalid')
    if (res.status === 'invalid') expect(res.issues.join(' ')).toContain('scene-fixture')
  })

  it('网络异常 → error（不等于"从未生成"）', async () => {
    const failing: FetchLike = async () => {
      throw new Error('boom')
    }
    const res = await readPartitionFile('scene-fixture', { fetchImpl: failing })
    expect(res.status).toBe('error')
  })

  it('保存成功 → server 模式', async () => {
    const res = await savePartitionFile('scene-fixture', fileOf(), { fetchImpl: okFetch({ ok: true }) })
    expect(res).toEqual({ ok: true, mode: 'server' })
  })

  it('服务端不可写 → 降级为下载，并明确 mode=download', async () => {
    const downloads: Array<{ name: string; content: string }> = []
    const res = await savePartitionFile('scene-fixture', fileOf(), {
      fetchImpl: okFetch({}, 404),
      download: (name, content) => downloads.push({ name, content }),
    })
    expect(res).toEqual({ ok: true, mode: 'download' })
    expect(downloads).toHaveLength(1)
    expect(downloads[0].name).toContain('partition')
  })

  it('服务端 400 → 失败，不假装成功', async () => {
    const res = await savePartitionFile('scene-fixture', fileOf(), { fetchImpl: okFetch({ ok: false }, 400) })
    expect(res.ok).toBe(false)
  })
})
