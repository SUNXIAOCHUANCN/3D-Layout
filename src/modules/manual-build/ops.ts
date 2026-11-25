import { edit } from '../../core/edit'
import { engine } from '../../core/engine'
import { useSceneStore } from '../../core/store'
import type { SceneLight, Vec3 } from '../../core/types'
import { Box3 } from 'three'
import { assetHierarchy } from '../../core/assetHierarchy'
import { cloneAssets, selectedRoots } from './buildTools'

function selectedGeometry() {
  const { document, selectedAssetIds } = useSceneStore.getState()
  const assets = document?.assets ?? []
  const tree = assetHierarchy(assets)
  const roots = selectedRoots(assets, selectedAssetIds)
  const items = roots.flatMap(asset => [asset, ...tree.descendants(asset.id)])
  return { roots, items, locked: items.some(tree.locked) }
}

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
  else if (selectedAssetId) {
    const bounds = new Box3()
    for (const asset of selectedGeometry().items) {
      const object = engine.findAssetObject(asset.id)
      if (object) bounds.union(new Box3().setFromObject(object))
    }
    if (bounds.isEmpty()) engine.focusAsset(selectedAssetId)
    else engine.focusBounds(bounds)
  }
}

export function removeSelected(): void {
  const { selectedAssetId, selectedLightId } = useSceneStore.getState()
  if (selectedLightId) edit.removeLight(selectedLightId)
  else if (selectedAssetId) {
    const { items, locked } = selectedGeometry()
    if (!locked) edit.applyAssets(items.map(asset => ({ id: asset.id, after: null })), `删除 ${items.length === 1 ? items[0].name ?? selectedAssetId : `${items.length} 个对象`}`)
  }
}

/** 复制选中资产：新 id + 位置偏移，并选中新副本（Unity Ctrl+D 行为） */
export function duplicateSelected(): boolean {
  const s = useSceneStore.getState()
  const doc = s.document
  const selection = selectedGeometry()
  if (!s.selectedLightId) {
    if (!selection.items.length || selection.locked) return false
    const commonParent = selection.roots.every(root => root.parentId === selection.roots[0].parentId) ? selection.roots[0].parentId : undefined
    const assets = cloneAssets(selection.items, [0.6, 0, 0], commonParent)
    if (!edit.applyAssets(assets.map(asset => ({ id: asset.id, after: asset })), '复制所选对象')) return false
    const originalRoots = new Set(selection.roots.map(root => root.id))
    s.selectMany(assets.filter((_, index) => originalRoots.has(selection.items[index].id)).map(asset => asset.id))
    return true
  }
  const src = doc?.lights?.find(light => light.id === s.selectedLightId)
  if (!doc || !src) return false

  let id = `${src.id}-copy`
  let n = 1
  while (doc.assets.some(a => a.id === id) || doc.lights?.some(light => light.id === id)) {
    id = `${src.id}-copy-${++n}`
  }

  const offset = (p: Vec3): Vec3 => [p[0] + 0.6, p[1], p[2]]
  const copy = { ...src, id, name: `${src.name ?? LIGHT_NAMES[src.type]} 副本`, position: offset(src.position) }
  if (!edit.addLight(copy)) return false
  s.selectLight(id)
  return true
}
