type V3 = [number, number, number]

/** Meter-based AABB transformed with the same signed scale and XYZ Euler order as Three. */
export function modelWorldBounds(
  model: { dimensions: { w: number; h: number; d: number }; bounds?: { min: V3; max: V3 } },
  transform: { position: V3; rotation?: V3; rotationDeg?: V3; scale?: V3 },
): { min: V3; max: V3 } {
  const { w, h, d } = model.dimensions
  const bounds = model.bounds ?? { min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] }
  const scale = transform.scale ?? [1, 1, 1]
  const [rx, ry, rz] = (transform.rotationDeg ?? transform.rotation ?? [0, 0, 0]).map(v => v * Math.PI / 180)
  const [cx, cy, cz] = [Math.cos(rx), Math.cos(ry), Math.cos(rz)]
  const [sx, sy, sz] = [Math.sin(rx), Math.sin(ry), Math.sin(rz)]
  const min: V3 = [Infinity, Infinity, Infinity]
  const max: V3 = [-Infinity, -Infinity, -Infinity]
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const [a, b, c] = [x * scale[0], y * scale[1], z * scale[2]]
        // Intrinsic XYZ = Rx @ Ry @ Rz; apply Rz, then Ry, then Rx.
        const [x1, y1] = [cz * a - sz * b, sz * a + cz * b]
        const [x2, z2] = [cy * x1 + sy * c, -sy * x1 + cy * c]
        const point = [x2, cx * y1 - sx * z2, sx * y1 + cx * z2]
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], point[i] + transform.position[i])
          max[i] = Math.max(max[i], point[i] + transform.position[i])
        }
      }
    }
  }
  return { min, max }
}
