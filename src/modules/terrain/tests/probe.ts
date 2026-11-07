import { AmbientLight, Color, DirectionalLight, Mesh, PerspectiveCamera, PlaneGeometry, Scene, WebGLRenderer } from 'three'
import { configureSurface, paintSurface, heightAt } from '../surface'
import { createSurfaceMaterial } from '../material'
const size = 40
const heights: number[] = []
for (let z = 0; z <= 80; z++) for (let x = 0; x <= 80; x++) heights.push(12 * Math.exp(-((x - 48) ** 2 + (z - 40) ** 2) / 260))
const terrain = { width: size, depth: size, samplesX: 81, samplesZ: 81, heights, seed: 0, surface: configureSurface(['grass', 'sand', 'rock', 'snow'].map(id => ({ id, presetId: id as 'grass', tileSize: 2 })), 'grass', 256) }
terrain.surface = paintSurface(terrain, [
  { layerId: 'sand', mask: p => p[0] < -8 ? 1 : Math.max(0, (-p[0] + 4) / 12) },
  { layerId: 'rock', mask: p => Math.max(0, Math.min(1, (heightAt(terrain, ...p) - 3) / 3)) },
  { layerId: 'snow', mask: p => Math.max(0, Math.min(1, (heightAt(terrain, ...p) - 7) / 3)) },
]).surface
const custom = new URLSearchParams(location.search).has('custom')
if (custom) {
  terrain.surface.materials = [{ id: 'custom-earth', color: '#ffffff', roughness: 0.9, normalStrength: 0.7, maps: Object.fromEntries(['color', 'normal', 'roughness', 'ao', 'height'].map(k => [k, `/assets/materials/terrain-example/${k}.png`])) }]
  terrain.surface.layers[0] = { ...terrain.surface.layers[0], materialId: 'custom-earth' }
  terrain.surface.blend = { mode: 'height', heightContrast: 6, noiseStrength: 0.6, noiseScale: 2, seed: 42 }
}
const geometry = new PlaneGeometry(size, size, 80, 80)
geometry.rotateX(-Math.PI / 2)
const positions = geometry.getAttribute('position')
for (let i = 0; i < positions.count; i++) positions.setY(i, heightAt(terrain, positions.getX(i), positions.getZ(i)))
// Terrain UV convention is +Z, unlike PlaneGeometry's original UV.
const uv = geometry.getAttribute('uv')
for (let i = 0; i < uv.count; i++) uv.setXY(i, positions.getX(i) / size + 0.5, positions.getZ(i) / size + 0.5)
geometry.computeVertexNormals()
const scene = new Scene(); scene.background = new Color('#c3d7e3')
scene.add(new AmbientLight('#ffffff', 1.5))
const sun = new DirectionalLight('#fff4df', 3); sun.position.set(-15, 40, 20); scene.add(sun)
const layered = createSurfaceMaterial(terrain.surface, size, size)
scene.add(new Mesh(geometry, layered.material))
const camera = new PerspectiveCamera(42, 1200 / 800, 0.1, 200); camera.position.set(35, 36, 45); camera.lookAt(0, 3, 0)
const renderer = new WebGLRenderer({ antialias: true }); renderer.setSize(1200, 800); document.body.appendChild(renderer.domElement)
await layered.ready
renderer.render(scene, camera)
;(window as unknown as { terrainProbe: unknown }).terrainProbe = { programs: renderer.info.programs?.map(p => ({ runnable: (p as unknown as { diagnostics?: { runnable: boolean } }).diagnostics?.runnable ?? true })), triangles: renderer.info.render.triangles, textureErrors: layered.errors, custom }

if (custom) {
  const before = new Uint8Array(1200 * 800 * 4)
  renderer.getContext().readPixels(0, 0, 1200, 800, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, before)
  const plainSurface = { ...terrain.surface, blend: { mode: 'weight' as const } }
  const plain = createSurfaceMaterial(plainSurface, size, size); await plain.ready
  const mesh = scene.children.find(o => o instanceof Mesh) as Mesh
  mesh.material = plain.material; renderer.render(scene, camera)
  const after = new Uint8Array(before.length)
  renderer.getContext().readPixels(0, 0, 1200, 800, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, after)
  let difference = 0
  for (let i = 0; i < before.length; i++) difference += Math.abs(before[i] - after[i])
  mesh.material = layered.material; renderer.render(scene, camera); plain.dispose()
  Object.assign((window as unknown as { terrainProbe: object }).terrainProbe, { blendPixelDifference: difference })
}
