import { edit as coreEdit, type EditMeta, type TxHandle } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Transform } from '../../core/types'
import { ownerAt } from './geometry'
import type { Partition } from './types'
export type { TxHandle } from '../../core/edit'

interface Scope { sceneId: string; regionId?: string; signal: AbortSignal; partition: Partition; changed: () => void }
const scopes = new WeakMap<TxHandle, Scope>()
let id = -1
export function createScope(scope: Scope): TxHandle {
  const handle: TxHandle = { id: id--, commit() {}, rollback() {} }
  scopes.set(handle, scope)
  return handle
}
function scope(meta?: EditMeta): Scope {
  const s = meta?.tx && scopes.get(meta.tx)
  if (!s) throw new Error('缺少区域编辑权限')
  s.signal.throwIfAborted()
  if (useSceneStore.getState().sceneId !== s.sceneId) throw new Error('场景已切换，停止旧场景编辑')
  return s
}
function existing(s: Scope, assetId: string) {
  if (s.regionId && s.partition.owners[assetId] !== s.regionId) throw new Error(`越权：对象 ${assetId} 不属于当前分区`)
}
function destination(s: Scope, position: Transform['position']) {
  if (s.regionId && ownerAt(s.partition.regions, position) !== s.regionId) throw new Error('越权：目标位置位于当前分区之外或共享边界上')
}
export const edit = {
  addAsset(asset: SceneAsset, meta?: EditMeta) {
    const s = scope(meta); destination(s, asset.transform.position)
    const ok = coreEdit.addAsset(asset, { source: 'agent' })
    if (ok) { s.partition.owners[asset.id] = ownerAt(s.partition.regions, asset.transform.position); s.changed() }
    return ok
  },
  setTransform(assetId: string, transform: Transform, meta?: EditMeta) {
    const s = scope(meta); existing(s, assetId); destination(s, transform.position)
    const ok = coreEdit.setTransform(assetId, transform, { source: 'agent' })
    if (ok) { if (!s.regionId) s.partition.owners[assetId] = ownerAt(s.partition.regions, transform.position); s.changed() }
    return ok
  },
  removeAsset(assetId: string, meta?: EditMeta) {
    const s = scope(meta); existing(s, assetId)
    const ok = coreEdit.removeAsset(assetId, { source: 'agent' })
    if (ok) { delete s.partition.owners[assetId]; s.changed() }
    return ok
  },
  updateAsset(assetId: string, patch: Parameters<typeof coreEdit.updateAsset>[1], meta?: EditMeta) {
    const s = scope(meta); existing(s, assetId)
    const ok = coreEdit.updateAsset(assetId, patch, { source: 'agent' })
    if (ok) s.changed()
    return ok
  },
}
