import { edit } from '../../core/edit'
import { engine } from '../../core/engine'
import { useSceneStore } from '../../core/store'
import type { SceneLight, Vec3 } from '../../core/types'

export const LIGHT_NAMES = { point: '点光源', spot: '聚光灯' } as const

export function addLight(type: SceneLight['type']): void {
  const properties = {
    id: `light-${crypto.randomUUID()}`,
    name: LIGHT_NAMES[type],
    position: [0, 3, 0] as Vec3,
    color: '#ffffff',
    intensity: type === 'point' ? 30 : 60,
    distance: 12,
  }
  const light: SceneLight = type === 'point'
    ? { ...properties, type }
    : { ...properties, type, rotation: [-90, 0, 0], angle: 30 }
  if (edit.addLight(light)) useSceneStore.getState().selectLight(light.id)
}

export function focusSelected(): void {
  const { selectedAssetId, selectedLightId } = useSceneStore.getState()
  if (selectedLightId) engine.focusLight(selectedLightId)
  else if (selectedAssetId) engine.focusAsset(selectedAssetId)
}

export function removeSelected(): void {
  const { selectedAssetId, selectedLightId } = useSceneStore.getState()
  if (selectedLightId) edit.removeLight(selectedLightId)
  else if (selectedAssetId) edit.removeAsset(selectedAssetId)
}

/** 复制选中资产：新 id + 位置偏移，并选中新副本（Unity Ctrl+D 行为） */
export function duplicateSelected(): boolean {
  const s = useSceneStore.getState()
  const doc = s.document
  const src = doc?.lights?.find(light => light.id === s.selectedLightId)
    ?? doc?.assets.find(asset => asset.id === s.selectedAssetId)
  if (!doc || !src) return false

  let id = `${src.id}-copy`
  let n = 1
  while (doc.assets.some(a => a.id === id) || doc.lights?.some(light => light.id === id)) {
    id = `${src.id}-copy-${++n}`
  }

  const offset = (p: Vec3): Vec3 => [p[0] + 0.6, p[1], p[2]]
  if ('type' in src) {
    const copy = { ...src, id, name: `${src.name ?? LIGHT_NAMES[src.type]} 副本`, position: offset(src.position) }
    if (!edit.addLight(copy)) return false
    s.selectLight(id)
    return true
  }
  const copy = {
    ...src,
    id,
    name: src.name ? `${src.name} 副本` : undefined,
    transform: { ...src.transform, position: offset(src.transform.position) },
  }
  if (!edit.addAsset(copy, { source: 'human' })) return false
  s.select(id)
  return true
}
