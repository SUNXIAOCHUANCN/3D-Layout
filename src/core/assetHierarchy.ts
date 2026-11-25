import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { SceneAsset, Transform } from './types'

type HierarchyNode = Pick<SceneAsset, 'id' | 'parentId' | 'visible' | 'locked'>

export function assetHierarchy<T extends HierarchyNode>(assets: readonly T[]) {
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  const children = new Map<string | undefined, T[]>()
  for (const asset of assets) {
    const parent = byId.get(asset.parentId ?? '')?.id
    const siblings = children.get(parent) ?? []
    siblings.push(asset)
    children.set(parent, siblings)
  }
  const ancestors = (asset: T): T[] => {
    const result: T[] = []
    const seen = new Set([asset.id])
    let next = byId.get(asset.parentId ?? '')
    while (next && !seen.has(next.id)) {
      seen.add(next.id)
      result.push(next)
      next = byId.get(next.parentId ?? '')
    }
    return result
  }
  const descendants = (id: string): T[] => {
    const result: T[] = []
    const pending = [...(children.get(id) ?? [])]
    const seen = new Set([id])
    for (const asset of pending) {
      if (seen.has(asset.id)) continue
      seen.add(asset.id)
      result.push(asset)
      pending.push(...(children.get(asset.id) ?? []))
    }
    return result
  }
  const visible = (asset: T, hidden?: ReadonlySet<string>) =>
    [asset, ...ancestors(asset)].every(node => node.visible !== false && !hidden?.has(node.id))
  const locked = (asset: T) => [asset, ...ancestors(asset)].some(node => node.locked)
  return { byId, children, ancestors, descendants, visible, locked }
}

const DEG = Math.PI / 180
export const orientation = (rotation: Transform['rotation']) =>
  new Quaternion().setFromEuler(new Euler(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG))
const matrix = (t: Transform) => new Matrix4().compose(
  new Vector3(...t.position), orientation(t.rotation), new Vector3(...(t.scale ?? [1, 1, 1])),
)

/** Apply a group/pivot's world-space change to an independent world transform. */
export function followTransform(child: Transform, before: Transform, after: Transform): Transform {
  const delta = matrix(after).multiply(matrix(before).invert())
  const position = new Vector3(...child.position).applyMatrix4(delta).toArray()
  const rotation = orientation(after.rotation).multiply(orientation(before.rotation).invert()).multiply(orientation(child.rotation))
  const angles = new Euler().setFromQuaternion(rotation)
  const oldScale = before.scale ?? [1, 1, 1]
  const newScale = after.scale ?? [1, 1, 1]
  const scale = (child.scale ?? [1, 1, 1]).map((v, axis) => v * newScale[axis] / oldScale[axis]) as Transform['scale']
  return {
    position,
    rotation: before.rotation.every((v, i) => v === after.rotation[i]) ? child.rotation : [angles.x / DEG, angles.y / DEG, angles.z / DEG],
    scale: oldScale.every((v, i) => v === newScale[i]) ? child.scale : scale,
  }
}

export function validHierarchy(assets: readonly SceneAsset[]): boolean {
  const tree = assetHierarchy(assets)
  return assets.every(asset => !asset.parentId || Boolean(tree.byId.get(asset.parentId)?.group)
    && asset.parentId !== asset.id && !tree.ancestors(asset).some(parent => parent.parentId === asset.id))
}
