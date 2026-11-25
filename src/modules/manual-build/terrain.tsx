import { useState } from 'react'
import { edit } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import type { SceneAsset } from '../../core/types'
import { configureSurface, type Terrain } from '../terrain/surface'
import type { TerrainSurfaceLayer } from '../../core/types'

export const PRESET_NAMES = { grass: '草地', sand: '沙地', rock: '岩石', snow: '雪地' } as const
type Preset = keyof typeof PRESET_NAMES

function surface(preset: Preset) {
  return configureSurface([{ id: 'base', presetId: preset, tileSize: 4 }], 'base', 64)
}

export function addTerrainLayer(asset: SceneAsset & { terrain: Terrain }) {
  const current = asset.terrain.surface ?? surface('grass')
  if (current.layers.length >= 4) return
  const layers: TerrainSurfaceLayer[] = [...current.layers, { id: `layer-${crypto.randomUUID()}`, presetId: 'sand', tileSize: 4 }]
  edit.updateAsset(asset.id, { terrain: { ...asset.terrain, surface: { ...current, layers } } })
}

export function TerrainFields({ asset, disabled }: { asset: SceneAsset & { terrain: Terrain }; disabled?: boolean }) {
  const current = asset.terrain.surface
  const update = (next: NonNullable<Terrain['surface']>) => edit.updateAsset(asset.id, { terrain: { ...asset.terrain, surface: next } })
  const layerChoice = (layer: TerrainSurfaceLayer, value: string): TerrainSurfaceLayer => ({
    ...layer,
    presetId: value.startsWith('material:') ? undefined : value as Preset,
    materialId: value.startsWith('material:') ? value.slice(9) : undefined,
  })
  return <fieldset className="build-terrain-layers" disabled={disabled}>
    <legend>地表图层</legend>
    {!current && <button className="btn" onClick={() => update(surface('grass'))}>配置地表</button>}
    {current?.layers.map((layer, index) => <div className="build-actions" key={layer.id}>
      <select className="llm-input" aria-label={`图层 ${index + 1} 材质`} value={layer.presetId ?? `material:${layer.materialId}`}
        onChange={event => update({ ...current, layers: current.layers.map(item => item.id === layer.id ? layerChoice(item, event.target.value) : item) })}>
        {Object.entries(PRESET_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        {current.materials?.map(item => <option key={item.id} value={`material:${item.id}`}>{item.name ?? item.id}</option>)}
      </select>
      <label className="light-field">平铺 (m)<input type="number" min={0.1} max={1000} step="any" key={layer.tileSize}
        defaultValue={layer.tileSize} onBlur={event => {
          const tileSize = event.currentTarget.valueAsNumber
          if (Number.isFinite(tileSize) && tileSize >= 0.1 && tileSize <= 1000 && tileSize !== layer.tileSize) {
            update({ ...current, layers: current.layers.map(item => item.id === layer.id ? { ...item, tileSize } : item) })
          }
        }} /></label>
      {layer.id === current.baseLayerId && <small>基础层</small>}
      {layer.id !== current.baseLayerId && <button className="btn" type="button" onClick={() => {
        const layers = current.layers.filter(item => item.id !== layer.id)
        const base = layers.findIndex(item => item.id === current.baseLayerId)
        const data = new Array<number>(current.weightMap.data.length).fill(0)
        for (let offset = 0; offset < data.length; offset += 4) {
          const chunk = current.weightMap.data.slice(offset, offset + current.layers.length)
          const [removed] = chunk.splice(index, 1)
          chunk[base] += removed
          chunk.forEach((value, channel) => { data[offset + channel] = value })
        }
        update({ ...current, layers, weightMap: { ...current.weightMap, data } })
      }}>移除图层</button>}
    </div>)}
    {current && current.layers.length < 4 && <button className="btn" onClick={() => addTerrainLayer(asset)}>添加图层</button>}
  </fieldset>
}

async function imageHeights(file: File, resolution: number, maximum: number): Promise<number[]> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = resolution
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bitmap, 0, 0, resolution, resolution)
    const pixels = ctx.getImageData(0, 0, resolution, resolution).data
    return Array.from({ length: resolution * resolution }, (_, i) => {
      const index = i * 4
      return maximum * (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255
    })
  } finally { bitmap.close() }
}

export function CreateTerrain() {
  const [open, setOpen] = useState(false)
  const [width, setWidth] = useState('20')
  const [depth, setDepth] = useState('20')
  const [preset, setPreset] = useState<Preset>('grass')
  const [resolution, setResolution] = useState(65)
  const [maximum, setMaximum] = useState(4)
  const [heightMap, setHeightMap] = useState<File>()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const loading = useSceneStore(state => state.loading || !state.document)
  return <>
    <button className="btn" type="button" disabled={loading} aria-expanded={open} onClick={() => setOpen(!open)}>创建地形</button>
    {open && <form className="build-terrain" onSubmit={async event => {
      event.preventDefault()
      const size = [Number(width), Number(depth)]
      if (!size.every(value => Number.isFinite(value) && value >= 0.5 && value <= 5000)) return
      const { sceneId } = useSceneStore.getState()
      setCreating(true)
      setError('')
      try {
        const heights = heightMap ? await imageHeights(heightMap, resolution, maximum) : new Array<number>(resolution ** 2).fill(0)
        if (sceneId !== useSceneStore.getState().sceneId || useSceneStore.getState().loading) return
        const asset: SceneAsset = {
          id: `terrain-${crypto.randomUUID()}`, ref: 'models/procedural-terrain', name: '地形',
          transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
          terrain: { width: size[0], depth: size[1], samplesX: resolution, samplesZ: resolution, heights, seed: 0, surface: surface(preset) },
        }
        if (edit.addAsset(asset)) {
          useSceneStore.getState().select(asset.id)
          setOpen(false)
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally { setCreating(false) }
    }}>
      <label>宽度 (m)<input className="llm-input" required type="number" min="0.5" max="5000" step="any" value={width} onChange={event => setWidth(event.target.value)} /></label>
      <label>深度 (m)<input className="llm-input" required type="number" min="0.5" max="5000" step="any" value={depth} onChange={event => setDepth(event.target.value)} /></label>
      <label>地表<select className="llm-input" value={preset} onChange={event => setPreset(event.target.value as Preset)}>
        {Object.entries(PRESET_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>采样网格<select className="llm-input" value={resolution} onChange={event => setResolution(Number(event.target.value))}>
        {[33, 65, 129, 257].map(value => <option key={value} value={value}>{value} × {value}</option>)}
      </select></label>
      <label className="build-wide">高度图（可选）<input className="llm-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setHeightMap(event.target.files?.[0])} /></label>
      {heightMap && <label>最大高度 (m)<input className="llm-input" type="number" min={0} max={9999} step="any" value={maximum}
        onChange={event => setMaximum(event.target.valueAsNumber || 0)} /></label>}
      <button className="btn" type="submit" disabled={creating}>确认创建</button>
      {error && <span className="error" role="alert">{error}</span>}
    </form>}
  </>
}
