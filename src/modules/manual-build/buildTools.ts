import { create } from 'zustand'
import { assetHierarchy } from '../../core/assetHierarchy'
import { edit, type AssetChange } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Vec3 } from '../../core/types'

export type ViewDirection = 'perspective' | 'top' | 'front' | 'right'
export const useBuildTools = create<{
  interaction: 'select' | 'box' | 'brush'
  viewDirection: ViewDirection
  surfaceSnap: boolean
  preview: { doc: object; changes: AssetChange[]; label: string } | null
}>(() => ({ interaction: 'select', viewDirection: 'perspective', surfaceSnap: false, preview: null }))

export function toggleAssetSelection(id: string, additive = false) {
  const state = useSceneStore.getState()
  if (!additive) state.select(id)
  else state.selectMany(state.selectedAssetIds.includes(id) ? state.selectedAssetIds.filter(item => item !== id) : [...state.selectedAssetIds, id])
}

export function selectedRoots(assets: SceneAsset[], ids: string[]) {
  const tree = assetHierarchy(assets)
  const selected = new Set(ids)
  return ids.flatMap(id => {
    const asset = tree.byId.get(id)
    return asset && !tree.ancestors(asset).some(parent => selected.has(parent.id)) ? [asset] : []
  })
}

export function selectionPivot(assets: SceneAsset[]): Vec3 {
  const pivot: Vec3 = [0, 0, 0]
  for (const asset of assets) for (let axis = 0; axis < 3; axis++) pivot[axis] += asset.transform.position[axis] / assets.length
  return pivot
}

export function cloneAssets(assets: SceneAsset[], offset: Vec3, exteriorParent?: string): SceneAsset[] {
  const ids = new Map(assets.map(asset => [asset.id, `asset-${crypto.randomUUID()}`]))
  return assets.map(asset => ({
    ...asset,
    id: ids.get(asset.id)!,
    locked: undefined,
    parentId: ids.get(asset.parentId ?? '') ?? exteriorParent,
    scatterTerrainId: ids.get(asset.scatterTerrainId ?? '') ?? asset.scatterTerrainId,
    transform: {
      ...asset.transform,
      position: asset.transform.position.map((component, axis) => component + offset[axis]) as Vec3,
    },
  }))
}

export function reparentAssets(ids: string[], parentId?: string): boolean {
  const { document } = useSceneStore.getState()
  if (!document) return false
  const roots = selectedRoots(document.assets, ids)
  const tree = assetHierarchy(document.assets)
  if (roots.some(tree.locked) || parentId && (!tree.byId.get(parentId) || tree.locked(tree.byId.get(parentId)!))) return false
  return edit.applyAssets(roots.map(asset => ({ id: asset.id, after: { ...asset, parentId } })), '调整父级')
}

export function groupSelection() {
  const state = useSceneStore.getState()
  if (!state.document) return
  const { assets } = state.document
  const roots = selectedRoots(assets, state.selectedAssetIds)
  if (roots.some(assetHierarchy(assets).locked)) return
  const id = `group-${crypto.randomUUID()}`
  const group: SceneAsset = {
    id, ref: 'builtin/group', name: '对象组', group: true, transform: { position: selectionPivot(roots), rotation: [0, 0, 0] },
  }
  if (edit.applyAssets([{ id, after: group }, ...roots.map(asset => ({ id: asset.id, after: { ...asset, parentId: id } }))], '创建对象组')) state.select(id)
}

export function previewLayout(changes: AssetChange[], label: string) {
  const doc = useSceneStore.getState().document
  useBuildTools.setState({ preview: doc && changes.length ? { doc, changes, label } : null })
}

export function confirmLayout() {
  const preview = useBuildTools.getState().preview
  useBuildTools.setState({ preview: null })
  if (preview && preview.doc === useSceneStore.getState().document) edit.applyAssets(preview.changes, preview.label)
}
