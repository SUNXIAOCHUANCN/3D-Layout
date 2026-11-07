import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas, useFrame } from '@react-three/fiber'
import { Mesh, MeshStandardMaterial } from 'three'
import { TerrainModel } from '../TerrainModel'
import { configureSurface, paintSurface } from '../surface'
const terrain = { width: 20, depth: 20, samplesX: 2, samplesZ: 2, heights: [0, 0, 0, 0], seed: 0,
  surface: configureSurface([{ id: 'custom', materialId: 'earth', tileSize: 2 }, { id: 'sand', presetId: 'sand', tileSize: 2 }], 'custom', 64,
    [{ id: 'earth', maps: Object.fromEntries(['color', 'normal', 'roughness', 'ao', 'height'].map(k => [k, `/assets/materials/terrain-example/${k}.png`])) }], { mode: 'height', heightContrast: 6, noiseStrength: 0.4, seed: 42 }) }
terrain.surface = paintSurface(terrain, [{ layerId: 'sand', mask: p => Math.max(0, Math.min(1, p[0] / 10 + 0.5)) }]).surface
let settled = 0
function Inspect() {
  useFrame(({ scene, gl }) => {
    const materials: MeshStandardMaterial[] = []
    scene.traverse(o => { if (o instanceof Mesh && o.material instanceof MeshStandardMaterial) materials.push(o.material) })
    if (materials.some(m => m.userData.surfaceReady) && settled++ > 5) {
      const errors = materials.flatMap(m => m.userData.surfaceErrors ?? [])
      ;(window as unknown as { terrainProbe: unknown }).terrainProbe = { component: true, textureErrors: errors, programs: gl.info.programs?.map(p => ({ runnable: (p as unknown as { diagnostics?: { runnable: boolean } }).diagnostics?.runnable ?? true })), triangles: gl.info.render.triangles }
    }
  })
  return null
}
createRoot(document.getElementById('root')!).render(<StrictMode><Canvas camera={{ position: [18, 22, 24], fov: 45, near: 0.1, far: 100 }}>
  <color attach="background" args={['#c3d7e3']} /><ambientLight intensity={1.5} /><directionalLight position={[-15, 30, 20]} intensity={3} />
  <TerrainModel terrain={terrain} /><Inspect />
</Canvas></StrictMode>)
