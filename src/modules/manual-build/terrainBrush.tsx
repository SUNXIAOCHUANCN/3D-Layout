import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { Box3, BufferAttribute, BufferGeometry, LineBasicMaterial, LineLoop, Points, PointsMaterial, Raycaster, Vector2, Vector3, type Object3D } from 'three'
import { create } from 'zustand'
import { assetHierarchy } from '../../core/assetHierarchy'
import { edit, type AssetChange } from '../../core/edit'
import { engine } from '../../core/engine'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Vec3 } from '../../core/types'
import { brushMask, heightAt, paintSurface, slopeAt, type Point, type Terrain } from '../terrain/surface'
import { distanceToPath, refineTerrain, sculptTerrain } from '../terrain/sculpt'
import { useBuildTools } from './buildTools'
import { NumberField } from './NumberField'
import { cancelPlacement, finishBuildTool } from './placement'
import { addTerrainLayer, PRESET_NAMES } from './terrain'

const modes = {
  raise: '抬高', lower: '压低', flatten: '压平', smooth: '平滑',
  paint: '绘制地表', unpaint: '擦除地表', scatter: '散布模型', erase: '擦除散布',
} as const
type Mode = keyof typeof modes
type BrushGroup = 'terrain' | 'vegetation' | 'material'
const brushGroups = {
  terrain: { label: '地形笔刷', modes: ['raise', 'lower', 'flatten', 'smooth'] },
  vegetation: { label: '植被笔刷', modes: ['scatter', 'erase'] },
  material: { label: '材质笔刷', modes: ['paint', 'unpaint'] },
} as const

function brushGroup(mode: Mode): BrushGroup {
  if (mode === 'paint' || mode === 'unpaint') return 'material'
  if (mode === 'scatter' || mode === 'erase') return 'vegetation'
  return 'terrain'
}
interface BrushSettings {
  mode: Mode
  radius: number
  strength: number
  height: number
  layer: string
  ref: string
  density: number
  spacing: number
  minSlope: number
  maxSlope: number
  randomYaw: boolean
}
export const useBrush = create<BrushSettings>(() => ({
  mode: 'raise', radius: 2, strength: 0.65, height: 0, layer: '', ref: '',
  density: 0.5, spacing: 0.7, minSlope: 0, maxSlope: 45, randomYaw: true,
}))
const useBrushError = create<{ message: string }>(() => ({ message: '' }))
type Ground = SceneAsset & { terrain: Terrain }
const NO_ASSETS: SceneAsset[] = []

function editableGrounds(assets: SceneAsset[], hiddenIds: string[]) {
  const tree = assetHierarchy(assets)
  const hidden = new Set(hiddenIds)
  return assets.filter((asset): asset is Ground => Boolean(asset.terrain) && !tree.locked(asset) && tree.visible(asset, hidden))
}

function targetLayer(terrain: Terrain, layerId: string) {
  const surface = terrain.surface
  return surface?.layers.find(layer => layer.id === layerId && layer.id !== surface.baseLayerId)
    ?? surface?.layers.find(layer => layer.id !== surface.baseLayerId)
}

export function activateBrush(group: BrushGroup, modelRef?: string) {
  const current = useBrush.getState()
  const mode = modelRef ? 'scatter' : brushGroup(current.mode) === group ? current.mode : brushGroups[group].modes[0]
  cancelPlacement()
  setBrushMode(mode)
  if (modelRef) useBrush.setState({ ref: modelRef })
  useBrushError.setState({ message: '' })
  useBuildTools.setState({ interaction: 'brush', preview: null })
  if (group === 'material') {
    const { document, editorHiddenIds, selectedAssetId, select } = useSceneStore.getState()
    const grounds = editableGrounds(document?.assets ?? [], editorHiddenIds)
    if (grounds.length === 1 && grounds[0].id !== selectedAssetId) select(grounds[0].id)
  }
}

function setBrushMode(mode: Mode) {
  useBrush.setState(state => ({
    mode, strength: mode === 'raise' || mode === 'lower' ? state.strength : Math.min(state.strength, 1),
  }))
}

function seeded(seed: number) {
  let state = seed >>> 0
  return () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 2 ** 32)
}

function scatter(terrain: Ground, object: Object3D, points: Point[], options: BrushSettings, seed: number, existing: SceneAsset[]) {
  const next: { position: Vec3; yaw: number }[] = []
  const occupied = existing.filter(other => other.scatterTerrainId === terrain.id).map(other =>
    object.worldToLocal(new Vector3(...other.transform.position)))
  const random = seeded(seed)
  const radius = options.radius
  const stride = Math.max(0.1, radius)
  const rate = Math.min(64, Math.PI * radius * radius * options.density)
  const centers: Point[] = [points[0]]
  let remainder = 0
  for (let i = 1; i < points.length && centers.length < 256; i++) {
    const a = points[i - 1], b = points[i]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    for (let step = stride - remainder; step <= length && centers.length < 256; step += stride) {
      centers.push([a[0] + (b[0] - a[0]) * step / length, a[1] + (b[1] - a[1]) * step / length])
    }
    remainder = (remainder + length) % stride
  }
  for (const center of centers) {
    const attempts = Math.min(128, Math.ceil(rate * 4))
    let placed = 0
    const count = Math.floor(rate) + Number(random() < rate % 1)
    for (let i = 0; i < attempts && placed < count && next.length < 256; i++) {
      const theta = random() * Math.PI * 2
      const distance = radius * Math.sqrt(random())
      const x = center[0] + Math.cos(theta) * distance, z = center[1] + Math.sin(theta) * distance
      const t = terrain.terrain
      if (Math.abs(x) > t.width / 2 || Math.abs(z) > t.depth / 2 || occupied.some(p => Math.hypot(p.x - x, p.z - z) < options.spacing)) continue
      const slope = slopeAt(t, x, z)
      if (slope < options.minSlope || slope > options.maxSlope) continue
      const p = new Vector3(x, heightAt(t, x, z), z)
      occupied.push(p.clone())
      next.push({ position: object.localToWorld(p).toArray(), yaw: options.randomYaw ? 360 * random() : 0 })
      placed++
    }
    if (next.length >= 256) break
  }
  return next
}

export function reattachSelection() {
  const state = useSceneStore.getState()
  const assets = state.document?.assets
  if (!assets) return
  const tree = assetHierarchy(assets)
  const grounds = assets.filter(asset => asset.terrain && tree.visible(asset, new Set(state.editorHiddenIds)))
    .map(asset => engine.findAssetObject(asset.id)).filter((object): object is Object3D => Boolean(object))
  const top = grounds.reduce((maximum, object) => Math.max(maximum, new Box3().setFromObject(object).max.y), -Infinity)
  if (!Number.isFinite(top)) return
  const ray = new Raycaster(), down = new Vector3(0, -1, 0)
  const changes: AssetChange[] = []
  for (const id of state.selectedAssetIds) {
    const asset = tree.byId.get(id)
    if (!asset || asset.group || asset.terrain || tree.locked(asset)) continue
    const object = engine.findAssetObject(id)
    if (!object) continue
    const bounds = new Box3().setFromObject(object)
    if (bounds.isEmpty()) continue
    const [x, y, z] = asset.transform.position
    ray.set(new Vector3(x, top + 1, z), down)
    const surface = ray.intersectObjects(grounds, true)[0]
    if (surface) changes.push({ id, after: { ...asset, transform: { ...asset.transform, position: [x, y + surface.point.y - bounds.min.y, z] } } })
  }
  edit.applyAssets(changes, '将所选物体重新贴地')
}

export function BrushControls({ openLibrary }: { openLibrary: () => void }) {
  const assets = useSceneStore(state => state.document?.assets ?? NO_ASSETS)
  const hiddenIds = useSceneStore(state => state.editorHiddenIds)
  const selectedAssetId = useSceneStore(state => state.selectedAssetId)
  const interaction = useBuildTools(state => state.interaction)
  const brush = useBrush()
  const error = useBrushError(state => state.message)
  const group = brushGroup(brush.mode)
  const grounds = useMemo(() => editableGrounds(assets, hiddenIds), [assets, hiddenIds])
  const ground = grounds.find(asset => asset.id === selectedAssetId)
  const surface = ground?.terrain.surface
  const scatterMode = brush.mode === 'scatter'
  const model = useSceneStore(state => state.manifest?.models[brush.ref])
  const numeric = (key: 'radius' | 'strength' | 'height' | 'density' | 'spacing' | 'minSlope' | 'maxSlope', label: string, min: number, max: number, step: number) =>
    <label key={key}>{label}<NumberField className="llm-input" min={min} max={max} step={step} value={brush[key]}
      onCommit={value => useBrush.setState({ [key]: value })} /></label>
  return <div className="build-layout-tools">
    <div className="btn-grid g2">
      {(['terrain', 'vegetation', 'material'] as const).map(id => {
        const active = interaction === 'brush' && group === id
        return <button type="button" key={id} className={active ? 'active' : ''} aria-pressed={active}
          onClick={() => active ? finishBuildTool() : activateBrush(id)}>{brushGroups[id].label}</button>
      })}
      <button type="button" onClick={reattachSelection}>所选重新贴地</button>
    </div>
    {interaction === 'brush' && <div className="build-terrain build-brush">
      <label>笔刷<select aria-label="笔刷类型" className="llm-input" value={brush.mode} onChange={event => setBrushMode(event.target.value as Mode)}>
        {brushGroups[group].modes.map(id => <option key={id} value={id}>{modes[id]}</option>)}
      </select></label>
      {numeric('radius', '局部半径 (m)', 0.1, 250, 0.1)}
      {!scatterMode && brush.mode !== 'erase' && numeric('strength', brush.mode === 'raise' || brush.mode === 'lower' ? '幅度 (m)' : '强度', 0.01, brush.mode === 'raise' || brush.mode === 'lower' ? 50 : 1, 0.05)}
      {brush.mode === 'flatten' && numeric('height', '局部高度 (m)', -1000, 1000, 0.1)}
      {group === 'material' && <>
        <label>目标地形<select className="llm-input" value={ground?.id ?? ''} onChange={event => useSceneStore.getState().select(event.target.value || null)}>
          <option value="">选择地形</option>
          {grounds.map(asset => <option key={asset.id} value={asset.id}>{asset.name ?? asset.id}</option>)}
        </select></label>
        <label>目标图层<select className="llm-input" disabled={!ground || !targetLayer(ground.terrain, brush.layer)}
          value={ground ? targetLayer(ground.terrain, brush.layer)?.id ?? '' : ''}
          onChange={event => useBrush.setState({ layer: event.target.value })}>
          <option value="" disabled>请添加可涂抹图层</option>
          {surface?.layers.filter(layer => layer.id !== surface.baseLayerId).map(layer => <option key={layer.id} value={layer.id}>
            {layer.presetId ? PRESET_NAMES[layer.presetId] : surface.materials?.find(material => material.id === layer.materialId)?.name ?? layer.materialId}
          </option>)}
        </select></label>
        {ground && (surface?.layers.length ?? 0) < 4 && <button type="button" className="btn" onClick={() => addTerrainLayer(ground)}>添加图层</button>}
        {!grounds.length && <small className="build-wide">创建可编辑的地形后再涂抹。</small>}
      </>}
      {scatterMode && <>
        <div className="build-actions build-wide">
          <button type="button" className="btn" onClick={openLibrary}>{model ? '更换散布模型' : '选择散布模型'}</button>
          <small>{model?.name ?? '在素材库选择「用于散布」'}</small>
        </div>
        {numeric('density', '密度 (个/m²)', 0.01, 10, 0.1)}
        {numeric('spacing', '最小间距 (m)', 0.1, 100, 0.1)}
        {numeric('minSlope', '最小坡度 (°)', 0, 90, 1)}
        {numeric('maxSlope', '最大坡度 (°)', 0, 90, 1)}
        <label className="build-checkbox"><input type="checkbox" checked={brush.randomYaw} onChange={event => useBrush.setState({ randomYaw: event.target.checked })} />随机朝向</label>
        {brush.minSlope > brush.maxSlope && <small className="error build-wide">最小坡度须小于或等于最大坡度。</small>}
      </>}
      <button type="button" className="btn" onClick={finishBuildTool}>结束笔刷</button>
      {error && <span className="error" role="alert">{error}</span>}
    </div>}
  </div>
}

export function TerrainBrushLayer() {
  const { gl, camera, scene } = useThree()
  const update = useRef<() => void>(undefined)
  const ring = useMemo(() => new LineLoop(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(64 * 3), 3)),
    new LineBasicMaterial({ color: '#e8a66f', depthTest: false })), [])
  const markers = useMemo(() => new Points(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(256 * 3), 3)),
    new PointsMaterial({ color: '#e8a66f', size: 6, sizeAttenuation: false, depthTest: false })), [])
  useFrame(() => update.current?.())
  useEffect(() => {
    ring.visible = markers.visible = false
    ring.frustumCulled = markers.frustumCulled = false
    ring.userData.editorHelper = markers.userData.editorHelper = true
    ring.renderOrder = markers.renderOrder = 999
    const canvas = gl.domElement
    const ray = new Raycaster()
    let pointer: { x: number; y: number } | null = null
    let stroke: { ground: Ground; object: Object3D; points: Point[]; settings: BrushSettings; seed: number; document: object; id: number } | null = null
    let seed = 0x38f22a
    const hit = (x: number, y: number) => {
      const state = useSceneStore.getState()
      if (!state.document || state.loading) return null
      const settings = stroke?.settings ?? useBrush.getState()
      const group = brushGroup(settings.mode)
      if (settings.mode === 'scatter' && (!state.manifest?.models[settings.ref] || settings.minSlope > settings.maxSlope)) return null
      const grounds = editableGrounds(state.document.assets, state.editorHiddenIds)
      const candidates = grounds.filter(asset => group !== 'material' || asset.id === state.selectedAssetId && targetLayer(asset.terrain, settings.layer))
        .map(asset => scene.children.find(root => root.userData.assetId === asset.id)).filter((root): root is Object3D => Boolean(root))
      const box = canvas.getBoundingClientRect()
      camera.updateMatrixWorld(true)
      ray.setFromCamera(new Vector2((x - box.left) / box.width * 2 - 1, 1 - (y - box.top) / box.height * 2), camera)
      for (const root of candidates) root.updateWorldMatrix(true, true)
      const intersection = ray.intersectObjects(stroke ? [stroke.object] : candidates, true)[0]
      if (!intersection) return null
      let object = intersection.object
      while (object.parent && object.parent !== scene) object = object.parent
      const ground = grounds.find(asset => asset.id === object.userData.assetId)
      if (!ground?.terrain) return null
      const p = object.worldToLocal(intersection.point)
      return { ground, object, point: [p.x, p.z] as Point, document: state.document }
    }
    const move = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY }
      if (!stroke) return
      const next = hit(event.clientX, event.clientY)
      const last = stroke.points.at(-1)!
      if (next && stroke.points.length < 256 && Math.hypot(last[0] - next.point[0], last[1] - next.point[1]) > stroke.settings.radius * 0.18) stroke.points.push(next.point)
    }
    const begin = (event: PointerEvent) => {
      if (event.button !== 0 || useBuildTools.getState().interaction !== 'brush' || !edit.canBegin) return
      // The canvas receives pointerdown before the browser blurs the field.
      const active = document.activeElement
      if (active instanceof HTMLInputElement && active.matches('.build-brush input[type="number"]')) active.blur()
      move(event)
      const picked = hit(event.clientX, event.clientY)
      if (!picked) return
      useBrushError.setState({ message: '' })
      stroke = { ...picked, points: [picked.point], settings: useBrush.getState(), seed, id: event.pointerId }
      canvas.setPointerCapture(event.pointerId)
    }
    const finish = (event: PointerEvent) => {
      const current = stroke
      if (!current || current.id !== event.pointerId) return
      move(event)
      stroke = null
      const state = useSceneStore.getState()
      if (!state.document || current.document !== state.document || useBuildTools.getState().interaction !== 'brush') return
      const { ground, object, points, settings } = current
      const terrain = ground.terrain
      const { mode, radius, strength } = settings
      const changes: AssetChange[] = []
      if (mode === 'scatter') {
        const model = state.manifest?.models[settings.ref]
        if (!model) return
        for (const candidate of scatter(ground, object, points, settings, seed++, state.document.assets)) {
          const id = `scatter-${crypto.randomUUID()}`
          candidate.position[1] -= model.bounds?.min[1] ?? 0
          changes.push({ id, after: {
            id, ref: settings.ref, name: model.name, scatterTerrainId: ground.id,
            transform: { position: candidate.position, rotation: [0, candidate.yaw, 0] },
          } })
        }
      } else if (mode === 'erase') {
        const distance = distanceToPath(points)
        const tree = assetHierarchy(state.document.assets)
        for (const asset of state.document.assets) {
          if (asset.scatterTerrainId !== ground.id || tree.locked(asset)) continue
          const point = object.worldToLocal(new Vector3(...asset.transform.position))
          if (distance(point.x, point.z) <= radius) changes.push({ id: asset.id, after: null })
        }
      } else if (mode === 'paint' || mode === 'unpaint') {
        const layerId = targetLayer(terrain, settings.layer)?.id
        if (!layerId) return
        const mask = brushMask(points.length === 1
          ? { shape: 'circle', center: points[0], layerId, radius, feather: radius * 0.75 }
          : { shape: 'path', points, layerId, radius, feather: radius * 0.75 })
        const painted = paintSurface(terrain, [{ layerId, mask, strength: Math.min(1, strength), erase: mode === 'unpaint' }])
        if (painted.changedTexels) changes.push({ id: ground.id, after: { ...ground, terrain: { ...terrain, surface: painted.surface } } })
      } else {
        const grid = refineTerrain(terrain, radius)
        const result = sculptTerrain(grid, {
          points, radius, mode: mode === 'lower' ? 'raise' : mode,
          value: mode === 'lower' ? -strength : mode === 'flatten' ? settings.height : mode === 'smooth' ? Math.min(1, strength) : strength,
          plateau: mode === 'flatten' ? 0.35 : 0,
        })
        if (result.changed) changes.push({ id: ground.id, after: { ...ground, terrain: { ...grid, heights: result.heights } } })
      }
      if (edit.applyAssets(changes, `${modes[mode]}笔划`) && mode !== 'scatter' && mode !== 'erase') state.select(ground.id)
    }
    const leave = () => { pointer = null }
    const abort = () => { stroke = null }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useBuildTools.getState().interaction === 'brush') {
        abort()
        useBuildTools.setState({ interaction: 'select' })
      }
    }
    update.current = () => {
      const current = pointer && useBuildTools.getState().interaction === 'brush' ? hit(pointer.x, pointer.y) : null
      ring.visible = Boolean(current)
      markers.visible = false
      if (!current) return
      const { ground, object, point, document } = current
      const options = stroke?.settings ?? useBrush.getState()
      const positions = ring.geometry.getAttribute('position')
      for (let i = 0; i < positions.count; i++) {
        const angle = 2 * Math.PI * i / positions.count
        const x = point[0] + options.radius * Math.cos(angle), z = point[1] + options.radius * Math.sin(angle)
        const p = object.localToWorld(new Vector3(x, heightAt(ground.terrain, x, z) + 0.035, z))
        positions.setXYZ(i, p.x, p.y, p.z)
      }
      positions.needsUpdate = true
      if (options.mode === 'scatter' && options.ref) {
        const preview = scatter(ground, object, stroke?.points ?? [point], options, stroke?.seed ?? seed, document.assets)
        const attributes = markers.geometry.getAttribute('position')
        preview.forEach(({ position }, i) => attributes.setXYZ(i, position[0], position[1] + 0.05, position[2]))
        attributes.needsUpdate = true
        markers.geometry.setDrawRange(0, preview.length)
        markers.visible = true
      }
    }
    canvas.addEventListener('pointerdown', begin)
    canvas.addEventListener('pointermove', move)
    const finishSafely = (event: PointerEvent) => {
      try { finish(event) }
      catch (cause) { useBrushError.setState({ message: cause instanceof Error ? cause.message : String(cause) }) }
    }
    canvas.addEventListener('pointerup', finishSafely)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('pointercancel', abort)
    window.addEventListener('keydown', escape)
    return () => {
      update.current = undefined
      canvas.removeEventListener('pointerdown', begin)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', finishSafely)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointercancel', abort)
      window.removeEventListener('keydown', escape)
    }
  }, [gl, camera, scene, ring, markers])
  useEffect(() => () => {
    ring.geometry.dispose(); ring.material.dispose()
    markers.geometry.dispose(); markers.material.dispose()
  }, [ring, markers])
  return <><primitive object={ring} /><primitive object={markers} /></>
}

