/** Loaded only by the local migration check through Vite; never part of the app entry. */
import { Box3 } from 'three'
import { engine } from '../core/engine'
import { useSceneStore } from '../core/store'
import { edit } from '../core/edit'
import { saveScene } from '../core/io'
import type { SceneAsset } from '../core/types'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function collectScene(sceneId: string) {
  await useSceneStore.getState().boot(sceneId)
  if (useSceneStore.getState().sceneError) throw new Error(useSceneStore.getState().sceneError!)
  const started = performance.now()
  for (;;) {
    const assets = useSceneStore.getState().document?.assets ?? []
    const ready = assets.every(asset => {
      const object = engine.findAssetObject(asset.id)
      let meshes = 0
      object?.traverse(child => { if ('isMesh' in child && child.isMesh) meshes++ })
      return meshes > 0
    })
    if (ready) break
    if (performance.now() - started > 110_000) throw new Error(`Model render timeout: ${sceneId}`)
    await delay(100)
  }
  await frame(); await frame()
  const state = useSceneStore.getState()
  return {
    sceneId, error: state.sceneError,
    assets: (state.document?.assets ?? []).map(asset => {
      const object = engine.findAssetObject(asset.id)!
      object.updateWorldMatrix(true, true)
      const box = new Box3().setFromObject(object, true)
      return { id: asset.id, ref: asset.ref, resolved: Boolean(state.manifest?.models[asset.ref]),
               min: box.min.toArray(), max: box.max.toArray() }
    }),
  }
}

export function screenshot() { return engine.captureScreenshot() }

export function refForAsset(assetId: string) {
  const found = Object.entries(useSceneStore.getState().manifest?.models ?? {}).find(([, model]) => model.id === assetId)
  if (!found) throw new Error(`Asset ID not in catalog: ${assetId}`)
  return found[0]
}

export async function exerciseEditor(sceneId: string, ref: string) {
  await collectScene(sceneId)
  const model = useSceneStore.getState().manifest!.models[ref]
  if (!model || model.source.type !== 'glb' || !model.source.unitScale) throw new Error('Standardized GLB missing')
  const asset: SceneAsset = { id: 'migration-added', ref,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }
  if (!edit.addAsset(asset)) throw new Error('Add failed')
  await delay(200); await frame(); await frame()
  const object = engine.findAssetObject(asset.id)
  if (!object) throw new Error('Added asset did not render')
  const box = new Box3().setFromObject(object, true)
  const dimensions = box.max.clone().sub(box.min)
  const sizeError = Math.max(Math.abs(dimensions.x - model.dimensions.w), Math.abs(dimensions.y - model.dimensions.h), Math.abs(dimensions.z - model.dimensions.d))
  if (sizeError > .002) throw new Error(`scale=1 dimensions mismatch: ${sizeError}`)
  useSceneStore.getState().select(asset.id)
  engine.focusAsset(asset.id)
  await frame(); await frame()
  const hit = engine.pickNormalized(.5, .5)
  if (hit?.assetId !== asset.id) throw new Error(`Center pick failed: ${JSON.stringify(hit)}`)
  const moved = { position: [2, .5, 3] as [number, number, number], rotation: [15, 30, 5] as [number, number, number], scale: [1.2, 1.1, .9] as [number, number, number] }
  if (!edit.setTransform(asset.id, moved)) throw new Error('Transform failed')
  if (!edit.addAsset({ ...asset, id: 'migration-clone', transform: { ...moved, position: [6, .5, 3] } })) throw new Error('Clone failed')
  await delay(100)
  if (!engine.findAssetObject('migration-clone')) throw new Error('Clone did not render')
  await saveScene()
  await useSceneStore.getState().loadScene(sceneId)
  const reopened = useSceneStore.getState().document!
  if (JSON.stringify(reopened.assets.find(a => a.id === asset.id)?.transform) !== JSON.stringify(moved)
      || !reopened.assets.some(a => a.id === 'migration-clone')) throw new Error('Save/reopen mismatch')
  return { addedAtScaleOne: true, standardSizeErrorM: sizeError, picked: hit.assetId,
           transformed: true, cloned: true, savedAndReopened: true }
}
