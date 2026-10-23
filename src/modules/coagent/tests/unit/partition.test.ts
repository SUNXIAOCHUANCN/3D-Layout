/**
 * partition（W06）单测：uv→世界坐标、提案校验、归属（歧义/未归属）、重叠、快照组装。
 *
 * 这些都是"不能靠模型自觉"的部分——模型只给归一化图像坐标，剩下必须由程序算与校验。
 */

import { describe, expect, it } from 'vitest'
import type { AssetDTO, CameraSnapshot } from '../../contracts'
import {
  assignByAnchor,
  birdseyeCamera,
  buildPartition,
  detectOverlaps,
  parsePartitionProposal,
  pointInPolygon,
  polygonsOverlap,
  proposalToDrafts,
  uvToWorldXZ,
  type PartitionProposal,
} from '../../services/partition'

const asset = (id: string, x: number, z: number): AssetDTO => ({
  id,
  ref: 'models/box',
  name: id,
  transform: { position: [x, 0, z], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
  visible: true,
  catalog: null,
  fingerprint: `fp-${id}`,
})

/** 场景 20×20 米，俯视正交，up=(0,0,-1) */
function sceneCamera(): CameraSnapshot {
  return birdseyeCamera([asset('a', -9, -9), asset('b', 9, 9)], 1)
}

describe('uv → 世界坐标', () => {
  it('中心点落在相机 target；左上/右下对应 -Z / +Z 边界', () => {
    const cam = sceneCamera()
    const [cx, , cz] = cam.position
    const center = uvToWorldXZ(cam, [0.5, 0.5])
    expect(center[0]).toBeCloseTo(cx, 6)
    expect(center[1]).toBeCloseTo(cz, 6)

    const topLeft = uvToWorldXZ(cam, [0, 0])
    const bottomRight = uvToWorldXZ(cam, [1, 1])
    expect(topLeft[0]).toBeLessThan(center[0])
    expect(topLeft[1]).toBeLessThan(center[1]) // 画面上方 = 世界 -Z
    expect(bottomRight[0]).toBeGreaterThan(center[0])
    expect(bottomRight[1]).toBeGreaterThan(center[1])
  })

  it('u/v 单调：u 增大 x 增大，v 增大 z 增大', () => {
    const cam = sceneCamera()
    const a = uvToWorldXZ(cam, [0.2, 0.5])
    const b = uvToWorldXZ(cam, [0.8, 0.5])
    expect(b[0]).toBeGreaterThan(a[0])
    const c = uvToWorldXZ(cam, [0.5, 0.2])
    const d = uvToWorldXZ(cam, [0.5, 0.8])
    expect(d[1]).toBeGreaterThan(c[1])
  })

  it('非正交相机直接拒绝（分区只认俯视正交）', () => {
    expect(() => uvToWorldXZ({ ...sceneCamera(), projection: 'perspective' } as CameraSnapshot, [0.5, 0.5])).toThrowError(
      expect.objectContaining({ code: 'invalid_plan' }),
    )
  })
})

describe('提案解析与几何校验', () => {
  const goodProposal: PartitionProposal = {
    regions: [
      { name: '北区', polygonUV: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.48], [0.05, 0.48]] },
      { name: '南区', polygonUV: [[0.05, 0.52], [0.95, 0.52], [0.95, 0.95], [0.05, 0.95]] },
    ],
    notes: 'two bands',
  }

  it('解析带 ```json 围栏的回复', () => {
    const p = parsePartitionProposal('好的：\n```json\n' + JSON.stringify(goodProposal) + '\n```')
    expect(p.regions.length).toBe(2)
    expect(p.regions[0].name).toBe('北区')
  })

  it('乱 JSON / 区域不足 / 点非法 都报 invalid_plan', () => {
    expect(() => parsePartitionProposal('模型只回了一段话')).toThrowError(expect.objectContaining({ code: 'invalid_plan' }))
    expect(() => parsePartitionProposal('{"regions":[{"name":"A","polygonUV":[[0,0],[1,0],[1,1]]}]}')).toThrowError(
      expect.objectContaining({ code: 'invalid_plan' }),
    )
    expect(() =>
      parsePartitionProposal('{"regions":[{"name":"A","polygonUV":[[0,0],[1,0],[1,1]]},{"name":"B","polygonUV":[[0,0],[1,"x"],[1,1]]}]}'),
    ).toThrowError(expect.objectContaining({ code: 'invalid_plan' }))
  })

  it('自交多边形被跳过并给出原因', () => {
    const bowtie: PartitionProposal = {
      regions: [
        { name: '领结', polygonUV: [[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]] },
        { name: '南区', polygonUV: [[0.05, 0.52], [0.95, 0.52], [0.95, 0.95], [0.05, 0.95]] },
      ],
    }
    const { drafts, issues } = proposalToDrafts(bowtie, sceneCamera())
    expect(drafts.length).toBe(1)
    expect(issues.join()).toContain('自交')
  })

  it('面积过小的多边形被跳过', () => {
    const tiny: PartitionProposal = {
      regions: [
        { name: '针尖', polygonUV: [[0.5, 0.5], [0.5001, 0.5], [0.5001, 0.5001]] },
        { name: '南区', polygonUV: [[0.05, 0.52], [0.95, 0.52], [0.95, 0.95], [0.05, 0.95]] },
      ],
    }
    const { drafts, issues } = proposalToDrafts(tiny, sceneCamera())
    expect(drafts.length).toBe(1)
    expect(issues.join()).toContain('面积过小')
  })
})

describe('对象归属与重叠', () => {
  const drafts = (): ReturnType<typeof proposalToDrafts>['drafts'] =>
    proposalToDrafts(
      {
        regions: [
          { name: '北区', polygonUV: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.48], [0.05, 0.48]] },
          { name: '南区', polygonUV: [[0.05, 0.52], [0.95, 0.52], [0.95, 0.95], [0.05, 0.95]] },
        ],
      },
      sceneCamera(),
    ).drafts

  it('每个对象恰好落在一个区 → 正常归属', () => {
    const d = drafts()
    const { assignments, issues } = assignByAnchor(d, [asset('n1', -5, -5), asset('s1', 5, 5)])
    expect(issues).toEqual([])
    expect(assignments[d[0].id]).toEqual(['n1'])
    expect(assignments[d[1].id]).toEqual(['s1'])
  })

  it('多命中 → ambiguous；零命中 → unassigned（都显式列出，不偷偷归属）', () => {
    const overlapping = [
      { id: 'a', name: 'a', polygonXZ: [[-5, -5], [5, -5], [5, 1], [-5, 1]] as Array<[number, number]> },
      { id: 'b', name: 'b', polygonXZ: [[-5, -1], [5, -1], [5, 5], [-5, 5]] as Array<[number, number]> },
    ]
    const { issues } = assignByAnchor(overlapping, [asset('in-both', 0, 0), asset('far', 0, 500)])
    expect(issues.map(i => i.kind).sort()).toEqual(['ambiguous', 'unassigned'])
    expect(issues.find(i => i.kind === 'ambiguous')?.regionIds.sort()).toEqual(['a', 'b'])
  })

  it('重叠检测：相同多边形 → 报重叠；分离多边形 → 不报', () => {
    const p = (z0: number, z1: number): Array<[number, number]> => [[-5, z0], [5, z0], [5, z1], [-5, z1]]
    expect(polygonsOverlap(p(-5, 0), p(-1, 4))).toBe(true)
    expect(polygonsOverlap(p(-5, -1), p(0, 5))).toBe(false)
    const pairs = detectOverlaps([
      { id: 'a', name: 'a', polygonXZ: p(-5, 0) },
      { id: 'b', name: 'b', polygonXZ: p(-1, 4) },
      { id: 'c', name: 'c', polygonXZ: p(10, 15) },
    ])
    expect(pairs).toEqual([{ a: 'a', b: 'b' }])
  })

  it('pointInPolygon 基本正确（含边界外/内）', () => {
    const square: Array<[number, number]> = [[0, 0], [2, 0], [2, 2], [0, 2]]
    expect(pointInPolygon([1, 1], square)).toBe(true)
    expect(pointInPolygon([3, 1], square)).toBe(false)
  })
})

describe('分区快照组装', () => {
  const proposal: PartitionProposal = {
    regions: [
      { name: '北区', polygonUV: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.48], [0.05, 0.48]] },
      { name: '南区', polygonUV: [[0.05, 0.52], [0.95, 0.52], [0.95, 0.95], [0.05, 0.95]] },
    ],
  }

  it('生成合法快照：region 带 polygonXZ/objectIds/cameraId/partitionVersion；报告含未归属', () => {
    const built = buildPartition({
      proposal,
      camera: sceneCamera(),
      assets: [asset('n1', -5, -5), asset('s1', 5, 5), asset('lost', 0, 0)],
      partitionVersion: 3,
    })
    expect(built.partition.partitionVersion).toBe(3)
    expect(built.partition.regions.every(r => r.cameraId === 'cam-birdseye')).toBe(true)
    expect(built.partition.regions.every(r => r.partitionVersion === 3)).toBe(true)
    expect(built.report.unassigned.length).toBe(1)
    expect(built.report.issues.join()).toContain('未落在任何区')
  })

  it('歧义对象可以按策略标为 global_readonly', () => {
    const overlappingProposal: PartitionProposal = {
      regions: [
        { name: '北区', polygonUV: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.55], [0.05, 0.55]] },
        { name: '南区', polygonUV: [[0.05, 0.45], [0.95, 0.45], [0.95, 0.95], [0.05, 0.95]] },
      ],
    }
    const midZ = uvToWorldXZ(sceneCamera(), [0.5, 0.5])[1]
    const built = buildPartition({
      proposal: overlappingProposal,
      camera: sceneCamera(),
      assets: [asset('mid', 0, midZ)],
      partitionVersion: 1,
      ambiguousPolicy: 'readonly',
    })
    expect(built.partition.globalReadonlyObjectIds).toContain('mid')
    expect(built.report.readonlyObjectIds).toContain('mid')
    expect(built.report.issues.join()).toContain('重叠')
  })

  it('有效区域不足 2 个 → invalid_plan（不能把半个分区交给执行）', () => {
    const single: PartitionProposal = { regions: [proposal.regions[0]] }
    expect(() =>
      buildPartition({ proposal: single, camera: sceneCamera(), assets: [asset('n1', -5, -5)], partitionVersion: 1 }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_plan' }))
  })

  it('鸟瞰相机覆盖所有资产：把资产位置映射回 uv 后仍在 [0,1]', () => {
    const cam = sceneCamera()
    const assets = [asset('a', -9, -9), asset('b', 9, 9), asset('c', 0, 3)]
    const o = cam.ortho!
    for (const a of assets) {
      const localX = a.transform.position[0] - cam.position[0]
      const localY = -(a.transform.position[2] - cam.position[2])
      const u = (localX - o.left) / (o.right - o.left)
      const v = 1 - (localY - o.bottom) / (o.top - o.bottom)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
