/**
 * 两区域确定性测试场景（W01 fixture，W03/W05 复用）。
 *
 * 布局（俯视，米，+Y 上）：
 *   北区 z∈[-8,-0.5]：tree-1、tree-2
 *   南区 z∈[0.5,8]：house-1、rock-1
 *   中线 z∈[-0.5,0.5]：road-1（跨区共享，globalReadonly，首版禁改）
 * 所有工厂函数返回全新深拷贝，测试间互不污染。
 */

import type {
  CameraSnapshot,
  ModelCatalogEntry,
  PartitionSnapshot,
  Plan,
  Region,
  TransformDTO,
} from '../../contracts'

export const TWO_REGION_CATALOG: ModelCatalogEntry[] = [
  { ref: 'models/oak-tree', name: '橡树', dimensions: { w: 3, h: 5, d: 3 }, category: 'vegetation' },
  { ref: 'models/cottage', name: '村舍', dimensions: { w: 6, h: 4, d: 5 }, category: 'building' },
  { ref: 'models/rock', name: '岩石', dimensions: { w: 1.5, h: 1, d: 1.5 }, category: 'props' },
  { ref: 'models/road-stretch', name: '道路段', dimensions: { w: 2, h: 0.1, d: 18 }, category: 'infra' },
]

export interface FixtureAsset {
  id: string
  ref: string
  name?: string
  transform: TransformDTO
}

const T = (position: [number, number, number], rotationDeg: [number, number, number] = [0, 0, 0]): TransformDTO => ({
  position,
  rotationDeg,
  scale: [1, 1, 1],
})

export const TWO_REGION_ASSETS: FixtureAsset[] = [
  { id: 'tree-1', ref: 'models/oak-tree', name: '北树一', transform: T([-3, 0, -4], [0, 30, 0]) },
  { id: 'tree-2', ref: 'models/oak-tree', name: '北树二', transform: T([2, 0, -5]) },
  { id: 'house-1', ref: 'models/cottage', name: '村舍一', transform: T([-2, 0, 4], [0, 15, 0]) },
  { id: 'rock-1', ref: 'models/rock', name: '南岩一', transform: T([4, 0, 3]) },
  { id: 'road-1', ref: 'models/road-stretch', name: '中枢道路', transform: T([0, 0, 0]) },
]

/** 北区：z∈[-8,-0.5] 的矩形带 */
export const REGION_NORTH: Region = {
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
}

/** 南区：z∈[0.5,8] 的矩形带，与北区不重叠 */
export const REGION_SOUTH: Region = {
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
}

function overheadCamera(id: string, position: [number, number, number], target: [number, number, number]): CameraSnapshot {
  return {
    schemaVersion: 1,
    id,
    projection: 'perspective',
    position,
    target,
    up: [0, 1, 0],
    near: 0.1,
    far: 300,
    aspect: 16 / 9,
    fovDeg: 50,
  }
}

export const CAMERA_NORTH = overheadCamera('cam-north', [0, 14, -10], [0, 0, -4])
export const CAMERA_SOUTH = overheadCamera('cam-south', [0, 14, 10], [0, 0, 4])

export function makeTwoRegionPartition(): PartitionSnapshot {
  return {
    partitionVersion: 1,
    regions: [structuredClone(REGION_NORTH), structuredClone(REGION_SOUTH)],
    globalReadonlyObjectIds: ['road-1'],
  }
}

/** 一份可通过校验的两区计划：北树拉开间距 + 南区加一块石头（无跨区依赖） */
export function makeTwoRegionPlan(): Plan {
  return {
    schemaVersion: 1,
    kind: 'tasks',
    assumptions: ['"更稀疏"按北两树地面间距 ≥5 米的保守假设执行'],
    tasks: [
      {
        schemaVersion: 1,
        id: 'task-north-spread',
        regionId: 'region-north',
        objective: '把北区两棵橡树的地面间距拉大到至少 5 米，且都留在北区内',
        targetObjectIds: ['tree-1', 'tree-2'],
        allowedOperations: ['transform'],
        criteria: [
          {
            id: 'crit-north-distance',
            kind: 'metric',
            metric: 'region.min_pair_distance_xz',
            operator: 'gte',
            value: 5,
            unit: 'm',
          },
          { id: 'crit-north-inside', kind: 'visual', description: '两棵树完整位于北林地内，无出界' },
        ],
        constraints: [{ kind: 'stay_in_region' }, { kind: 'preserve_objects', objectIds: ['tree-1', 'tree-2'] }],
        dependsOn: [],
      },
      {
        schemaVersion: 1,
        id: 'task-south-add-rock',
        regionId: 'region-south',
        objective: '在南区空地新增一块岩石，不与村舍/已有岩石碰撞',
        targetObjectIds: [],
        allowedOperations: ['add'],
        criteria: [
          { id: 'crit-south-count', kind: 'metric', metric: 'region.object_count', operator: 'eq', value: 3, unit: 'count' },
        ],
        constraints: [{ kind: 'stay_in_region' }, { kind: 'no_collision' }, { kind: 'preserve_count' }],
        dependsOn: [],
      },
    ],
  }
}
