import { edit } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import type { Vec3 } from '../../core/types'

/** 复制选中资产：新 id + 位置偏移，并选中新副本（Unity Ctrl+D 行为） */
export function duplicateSelected(): boolean {
  const s = useSceneStore.getState()
  const doc = s.document
  const src = doc?.assets.find(a => a.id === s.selectedAssetId)
  if (!doc || !src) return false

  let id = `${src.id}-copy`
  let n = 1
  while (doc.assets.some(a => a.id === id)) id = `${src.id}-copy-${++n}`

  const offset = (p: Vec3): Vec3 => [p[0] + 0.6, p[1], p[2]]
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
