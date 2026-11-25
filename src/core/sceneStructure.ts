import type { SceneAsset, SceneLight } from './types'

/** Tree rows deliberately exclude transforms, geometry and material data. */
export type AssetTreeRow = Pick<SceneAsset, 'id' | 'ref' | 'name' | 'parentId' | 'group' | 'visible' | 'locked'> & { hasTerrain: boolean }

export function createAssetTreeSelector() {
  let source: readonly SceneAsset[] | undefined
  let rows: AssetTreeRow[] = []
  return (assets: readonly SceneAsset[] | undefined): AssetTreeRow[] => {
    if (assets === source) return rows
    const previous = new Map(rows.map(row => [row.id, row]))
    const next = (assets ?? []).map(asset => {
      const old = previous.get(asset.id)
      if (old && old.ref === asset.ref && old.name === asset.name && old.parentId === asset.parentId
        && old.group === asset.group && old.visible === asset.visible && old.locked === asset.locked
        && old.hasTerrain === Boolean(asset.terrain)) return old
      const { id, ref, name, parentId, group, visible, locked } = asset
      return { id, ref, name, parentId, group, visible, locked, hasTerrain: Boolean(asset.terrain) }
    })
    source = assets
    if (next.length !== rows.length || next.some((row, i) => row !== rows[i])) rows = next
    return rows
  }
}

export function createLightTreeSelector() {
  let source: readonly SceneLight[] | undefined
  let rows: Pick<SceneLight, 'id' | 'type' | 'name' | 'enabled'>[] = []
  return (lights: readonly SceneLight[] | undefined) => {
    if (source === lights) return rows
    const previous = new Map(rows.map(row => [row.id, row]))
    const next = (lights ?? []).map(light => {
      const old = previous.get(light.id)
      if (old && old.type === light.type && old.name === light.name && old.enabled === light.enabled) return old
      const { id, type, name, enabled } = light
      return { id, type, name, enabled }
    })
    source = lights
    if (next.length !== rows.length || next.some((row, i) => row !== rows[i])) rows = next
    return rows
  }
}
