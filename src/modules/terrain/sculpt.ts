import { heightAt, type Point, type Terrain } from './surface'

export function refineTerrain(terrain: Terrain, radius: number): Terrain {
  const samplesX = Math.max(terrain.samplesX, Math.min(257, Math.ceil(terrain.width * 2 / radius) + 1))
  const samplesZ = Math.max(terrain.samplesZ, Math.min(257, Math.ceil(terrain.depth * 2 / radius) + 1))
  if (samplesX === terrain.samplesX && samplesZ === terrain.samplesZ) return terrain
  const heights = Array.from({ length: samplesX * samplesZ }, (_, i) => heightAt(terrain,
    (i % samplesX / (samplesX - 1) - 0.5) * terrain.width,
    (Math.floor(i / samplesX) / (samplesZ - 1) - 0.5) * terrain.depth,
  ))
  return { ...terrain, samplesX, samplesZ, heights }
}

export function distanceToPath(points: readonly Point[]) {
  return (x: number, z: number) => {
    let distance = Math.hypot(x - points[0][0], z - points[0][1])
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1], [bx, bz] = points[i]
      const dx = bx - ax, dz = bz - az
      const fraction = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
      distance = Math.min(distance, Math.hypot(x - ax - fraction * dx, z - az - fraction * dz))
    }
    return distance
  }
}

export function sculptTerrain(terrain: Terrain, brush: {
  points: Point[]; radius: number; plateau: number; value: number; mode: 'raise' | 'flatten' | 'smooth'
  project?: (x: number, z: number) => Point
}) {
  const distanceAt = distanceToPath(brush.points)
  let changed = 0
  const heights = terrain.heights.map((height, i) => {
    const x = i % terrain.samplesX, z = Math.floor(i / terrain.samplesX)
    const localX = (x / (terrain.samplesX - 1) - 0.5) * terrain.width
    const localZ = (z / (terrain.samplesZ - 1) - 0.5) * terrain.depth
    const distance = distanceAt(...(brush.project?.(localX, localZ) ?? [localX, localZ] as Point))
    if (distance >= brush.radius) return height
    const f = distance <= brush.radius * brush.plateau ? 1 : (1 - distance / brush.radius) / (1 - brush.plateau)
    const weight = f * f * (3 - 2 * f)
    let target = brush.mode === 'raise' ? height + brush.value : brush.value
    if (brush.mode === 'smooth') {
      const neighbors = [height]
      if (x > 0) neighbors.push(terrain.heights[i - 1])
      if (x + 1 < terrain.samplesX) neighbors.push(terrain.heights[i + 1])
      if (z > 0) neighbors.push(terrain.heights[i - terrain.samplesX])
      if (z + 1 < terrain.samplesZ) neighbors.push(terrain.heights[i + terrain.samplesX])
      target = height + brush.value * (neighbors.reduce((sum, n) => sum + n, 0) / neighbors.length - height)
    }
    const next = height + (target - height) * weight
    if (!Number.isFinite(next) || Math.abs(next) > 10000) throw new Error('地形高度须在 −10000 至 10000 米之间')
    if (next !== height) changed++
    return next
  })
  return { heights, changed }
}
