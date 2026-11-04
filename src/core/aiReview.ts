import { create } from 'zustand'
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { ModelManifest, SceneAsset, SceneDocument } from './types'

export interface AssetChange {
  id: string
  kind: 'added' | 'removed' | 'modified'
  before?: SceneAsset
  after?: SceneAsset
  fields: string[]
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Compare final values, rather than tool calls: undone intermediate edits disappear. */
export function assetChanges(before: SceneDocument, after: SceneDocument): AssetChange[] {
  const old = new Map(before.assets.map(a => [a.id, a]))
  const next = new Map(after.assets.map(a => [a.id, a]))
  const changes: AssetChange[] = []
  for (const asset of before.assets) {
    if (!next.has(asset.id)) changes.push({ id: asset.id, kind: 'removed', before: asset, fields: [] })
  }
  for (const asset of after.assets) {
    const previous = old.get(asset.id)
    if (!previous) { changes.push({ id: asset.id, kind: 'added', after: asset, fields: [] }); continue }
    const fields = [
      ['位置', previous.transform.position, asset.transform.position],
      ['旋转', previous.transform.rotation, asset.transform.rotation],
      ['缩放', previous.transform.scale ?? [1,1,1], asset.transform.scale ?? [1,1,1]],
      ['模型', previous.ref, asset.ref], ['名称', previous.name, asset.name],
      ['可见性', previous.visible !== false, asset.visible !== false],
      ['颜色', previous.tint, asset.tint], ['材质', previous.materialOverride, asset.materialOverride],
      ['地形', previous.terrain, asset.terrain],
    ].filter(([, a, b]) => !equal(a, b)).map(([label]) => label as string)
    if (fields.length) changes.push({ id: asset.id, kind: 'modified', before: previous, after: asset, fields })
  }
  return changes
}

/** Metadata bounds include non-centred imported models; transform all eight corners. */
export function assetBox(asset: SceneAsset, manifest: ModelManifest | null): Box3 {
  const meta = manifest?.models[asset.ref]
  const terrain = asset.terrain
  let box: Box3
  if (terrain) {
    let min = 0, max = 0
    for (const height of terrain.heights) { min = Math.min(min, height); max = Math.max(max, height) }
    box = new Box3(new Vector3(-terrain.width / 2, min, -terrain.depth / 2), new Vector3(terrain.width / 2, max, terrain.depth / 2))
  } else if (meta?.bounds) {
    box = new Box3(new Vector3(...meta.bounds.min), new Vector3(...meta.bounds.max))
  } else {
    const { w = 0.5, h = 1, d = 0.5 } = meta?.dimensions ?? {}
    box = new Box3(new Vector3(-w / 2, 0, -d / 2), new Vector3(w / 2, h, d / 2))
  }
  const r = asset.transform.rotation.map(v => v * Math.PI / 180)
  return box.applyMatrix4(new Matrix4().compose(
    new Vector3(...asset.transform.position),
    new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2])),
    new Vector3(...(asset.transform.scale ?? [1,1,1])),
  ))
}

export const changeColors = { added: '#56d88a', removed: '#ff737b', modified: '#69b7ff' }
export const useAiReview = create<{
  sceneId: string | null
  channel: string
  before: SceneDocument | null
  showBefore: boolean
  highlighted: boolean
  focusedId: string | null
}>(() => ({ sceneId: null, channel: '', before: null, showBefore: true, highlighted: true, focusedId: null }))

export function clearAiReview(channel: string): void {
  if (useAiReview.getState().channel === channel) useAiReview.setState({ sceneId: null, before: null, focusedId: null })
}
