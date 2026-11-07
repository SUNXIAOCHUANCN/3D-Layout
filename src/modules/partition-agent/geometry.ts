import { Box3, Vector3 } from 'three'
import type { CaptureCamera } from '../../core/engine'
import type { SceneDocument } from '../../core/types'
import { modelWorldBounds } from '../../shared/modelBounds'
import { useSceneStore } from '../../core/store'
import { validatePolygonXZ } from '../coagent/schemas'
import { GLOBAL, type Point, type Region } from './types'

export function contains(polygon: Point[], [x, z]: Point): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[j], [bx, bz] = polygon[i]
    const cross = (x - ax) * (bz - az) - (z - az) * (bx - ax)
    if (Math.abs(cross) < 1e-8 && x >= Math.min(ax, bx) - 1e-8 && x <= Math.max(ax, bx) + 1e-8 && z >= Math.min(az, bz) - 1e-8 && z <= Math.max(az, bz) + 1e-8) return true
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside
  }
  return inside
}
export function ownerAt(regions: Region[], position: [number, number, number]): string {
  const matches = regions.filter(r => contains(r.polygon, [position[0], position[2]]))
  return matches.length === 1 ? matches[0].id : GLOBAL
}
export function overhead(doc: SceneDocument): { camera: CaptureCamera; bounds: [number, number, number, number] } {
  const box = new Box3()
  for (const a of doc.assets) {
    const model = useSceneStore.getState().manifest?.models[a.ref]
    if (model) { const b = modelWorldBounds(model, a.transform); box.expandByPoint(new Vector3(...b.min)); box.expandByPoint(new Vector3(...b.max)) }
    else if (a.terrain) {
      // Include rotated/scaled terrain corners and its full height envelope.
      const terrainModel = {
        dimensions: { w: a.terrain.width, d: a.terrain.depth, h: 1 },
        bounds: { min: [-a.terrain.width / 2, Math.min(0, ...a.terrain.heights), -a.terrain.depth / 2] as [number, number, number], max: [a.terrain.width / 2, Math.max(1, ...a.terrain.heights), a.terrain.depth / 2] as [number, number, number] },
      }
      const b = modelWorldBounds(terrainModel, a.transform)
      box.expandByPoint(new Vector3(...b.min)); box.expandByPoint(new Vector3(...b.max))
    } else box.expandByPoint(new Vector3(...a.transform.position))
  }
  if (box.isEmpty()) { const size = doc.environment.ground?.size ?? [20, 20]; box.set(new Vector3(-size[0] / 2, 0, -size[1] / 2), new Vector3(size[0] / 2, 1, size[1] / 2)) }
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2
  const halfZ = Math.max((box.max.z - box.min.z) / 2 + 2, ((box.max.x - box.min.x) / 2 + 2) / (4 / 3))
  const halfX = halfZ * 4 / 3, y = box.max.y + halfZ * 2 + 10
  return { bounds: [cx - halfX, cz - halfZ, cx + halfX, cz + halfZ], camera: { projection: 'orthographic', position: [cx, y, cz], target: [cx, box.min.y, cz], up: [0, 0, -1], viewHeight: halfZ * 2, near: .1, far: y - box.min.y + 1000 } }
}
export interface BoundaryMap {
  schema_version: number
  source: { artifact_id: string; width: number; height: number }
  canvas: { width: number; height: number }
  vertices: { id: string; x: number; y: number }[]
  boundaries: { id: string; start: string; end: string; points: Point[] }[]
  regions: { id: string; name: string; design?: string; boundary_ids: string[] }[]
}
export function convertBoundaries(map: BoundaryMap, bounds: [number, number, number, number]): Region[] {
  if (map.schema_version !== 1 || !(map.canvas.width > 0) || !(map.canvas.height > 0) || !map.regions.length) throw new Error('分区数据格式无效')
  const vertices = new Map(map.vertices.map(v => [v.id, v]))
  const edges = new Map(map.boundaries.map(b => [b.id, b]))
  const regions = map.regions.map(region => {
    const remaining = region.boundary_ids.map(id => { const edge = edges.get(id); if (!edge) throw new Error('分区引用缺失边界'); return edge })
    if (!remaining.length) throw new Error('区域没有边界')
    const first = remaining[0].start
    let current = first
    const points: Point[] = []
    while (remaining.length) {
      const i = remaining.findIndex(e => e.start === current || e.end === current)
      if (i < 0) throw new Error('分区边界不连通')
      const edge = remaining.splice(i, 1)[0], reverse = edge.start !== current
      const a = vertices.get(edge.start), b = vertices.get(edge.end)
      if (!a || !b) throw new Error('分区缺失顶点')
      let line: Point[] = [[a.x, a.y], ...edge.points, [b.x, b.y]]
      if (reverse) line = line.reverse()
      points.push(...line.slice(0, -1)); current = reverse ? edge.start : edge.end
    }
    if (current !== first) throw new Error('分区边界没有闭合')
    const polygon: Point[] = points.map(([x, y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > map.canvas.width || y < 0 || y > map.canvas.height) throw new Error('分区坐标超出截图')
      return [bounds[0] + x / map.canvas.width * (bounds[2] - bounds[0]), bounds[1] + y / map.canvas.height * (bounds[3] - bounds[1])]
    })
    if (!validatePolygonXZ(polygon, region.id).ok) throw new Error(`区域 ${region.name} 多边形无效`)
    return { id: region.id, name: region.name, design: region.design ?? '', polygon }
  })
  if (new Set(regions.map(r => r.id)).size !== regions.length || regions.some(r => r.id === GLOBAL)) throw new Error('分区 ID 重复或使用保留值')
  return regions
}
