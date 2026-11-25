import { useFrame, useThree } from '@react-three/fiber'
import { Suspense, useEffect, useRef } from 'react'
import { Box3, Plane, Raycaster, Vector2, Vector3, type Group, type Intersection } from 'three'
import { create } from 'zustand'
import { AssetInstance } from '../../components/AssetInstance'
import { edit } from '../../core/edit'
import { assetHierarchy } from '../../core/assetHierarchy'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Vec3 } from '../../core/types'
import { effectiveSnap, SNAP, supportsGizmoMode, useEditorStore, type GizmoMode } from './editorStore'
import { sampleViewport } from './recording'
import { cloneCombination, useCombinations } from './buildLibrary'
import { useBuildTools } from './buildTools'

export const MODEL_DRAG_TYPE = 'application/x-layout-model'
export const usePlacement = create<{ ref: string | null; rotation: number; continuous: boolean }>(() => ({
  ref: null, rotation: 0, continuous: false,
}))
export const cancelPlacement = () => usePlacement.setState({ ref: null, rotation: 0 })
export const startPlacement = (ref: string) => {
  useBuildTools.setState({ interaction: 'select', preview: null })
  usePlacement.setState({ ref, rotation: 0 })
}
export function rotatePlacement(amount: number) {
  setPlacementRotation(usePlacement.getState().rotation + amount)
}

function setPlacementRotation(angle: number) {
  const rotation = ((Math.round(angle * 10) / 10) % 360 + 360) % 360
  if (usePlacement.getState().rotation !== rotation) usePlacement.setState({ rotation })
}

export function finishBuildTool() {
  cancelPlacement()
  useBuildTools.setState({ interaction: 'select', preview: null })
}

export function activateGizmoMode(mode: GizmoMode) {
  const { document, selectedLightId } = useSceneStore.getState()
  const light = document?.lights?.find(item => item.id === selectedLightId)
  if (!supportsGizmoMode(mode, light?.type)) return
  finishBuildTool()
  useEditorStore.getState().setMode(mode)
}

export function ViewportRecorder() {
  const { width, height } = useThree(state => state.size)
  useEffect(() => { sampleViewport(performance.now(), true) }, [width, height])
  useFrame(() => sampleViewport(performance.now()))
  return null
}

export function PlacementLayer() {
  const { gl, camera, scene } = useThree()
  const preview = useRef<Group>(null)
  const renderPreview = useRef<() => void>(undefined)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const ref = usePlacement(state => state.ref)
  const model = useSceneStore(state => ref ? state.manifest?.models[ref] : undefined)
  const combination = useCombinations(state => state.entries.find(item => `combo:${item.id}` === ref))

  useEffect(() => {
    const canvas = gl.domElement
    const raycaster = new Raycaster()
    const intersects = (hit: Intersection) => {
      let object = hit.object as typeof hit.object | null
      while (object) {
        if (!object.visible || object.userData.editorHelper) return false
        object = object.parent
      }
      return true
    }
    const grid = new Plane(new Vector3(0, 1, 0), 0)
    const down = new Vector3(0, -1, 0)
    let pressed: { x: number; y: number } | null = null
    let turning: { pointerId: number; startX: number; angle: number } | null = null
    let heldPosition: Vec3 | null = null
    const landing = (x: number, y: number, modelRef: string): Vec3 | null => {
      const { document, manifest, loading, editorHiddenIds } = useSceneStore.getState()
      if (!document || loading) return null
      const rect = canvas.getBoundingClientRect()
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom || !rect.width || !rect.height) return null
      camera.updateMatrixWorld()
      raycaster.setFromCamera(new Vector2((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2), camera)
      const tree = assetHierarchy(document.assets)
      const hidden = new Set(editorHiddenIds)
      const snapToObjects = useBuildTools.getState().surfaceSnap
      const surfacesIds = new Set(document.assets.filter(asset => (asset.terrain || snapToObjects && !asset.group) && tree.visible(asset, hidden)).map(asset => asset.id))
      const surfaces = scene.children.filter(object => surfacesIds.has(object.userData.assetId))
      scene.updateMatrixWorld()
      const picked = raycaster.intersectObjects(surfaces, true).find(intersects)
      const terrainExists = document.assets.some(asset => asset.terrain && surfacesIds.has(asset.id))
      const point = picked?.point ?? (!terrainExists ? raycaster.ray.intersectPlane(grid, new Vector3()) : null)
      if (!point) return null
      if (effectiveSnap(useEditorStore.getState())) {
        const step = SNAP.translate
        const sx = Math.round(point.x / step) * step
        const sz = Math.round(point.z / step) * step
        if (picked) {
          const top = surfaces.reduce((max, surface) => Math.max(max, new Box3().setFromObject(surface).max.y), point.y)
          raycaster.set(new Vector3(sx, top + 1, sz), down)
          const snapped = raycaster.intersectObjects(surfaces, true).find(intersects)?.point
          if (!snapped) return null
          point.copy(snapped)
        } else {
          point.x = sx
          point.z = sz
        }
      }
      return [point.x, point.y - (manifest?.models[modelRef]?.bounds?.min[1] ?? 0), point.z]
    }
    const commit = (x: number, y: number, pinned?: Vec3) => {
      const state = usePlacement.getState()
      if (!state.ref) return
      const model = useSceneStore.getState().manifest?.models[state.ref]
      const position = pinned ?? landing(x, y, state.ref)
      if (!position) return
      const combo = useCombinations.getState().entries.find(item => `combo:${item.id}` === state.ref)
      if (combo) {
        const assets = cloneCombination(combo, position, state.rotation)
        if (edit.applyAssets(assets.map(asset => ({ id: asset.id, after: asset })), `放置组合 ${combo.name}`)) {
          useSceneStore.getState().selectMany(assets.filter(asset => !asset.parentId).map(asset => asset.id))
          useEditorStore.getState().setMode('translate')
          if (!state.continuous) cancelPlacement()
        }
        return
      }
      if (!model) return
      const asset: SceneAsset = {
        id: `asset-${crypto.randomUUID()}`, ref: state.ref, name: model.name,
        transform: { position, rotation: [0, state.rotation, 0] },
      }
      if (edit.addAsset(asset)) {
        useSceneStore.getState().select(asset.id)
        useEditorStore.getState().setMode('translate')
        if (!state.continuous) cancelPlacement()
      }
    }
    const update = () => {
      const group = preview.current
      const { ref, rotation } = usePlacement.getState()
      if (!group || !ref) return
      const mouse = pointer.current
      const position = heldPosition ?? (mouse && landing(mouse.x, mouse.y, ref))
      group.visible = Boolean(position)
      if (!position) return
      group.position.set(...position)
      group.rotation.y = rotation * Math.PI / 180
    }
    const move = (event: MouseEvent) => {
      if (turning) {
        const editor = useEditorStore.getState()
        const angle = turning.angle + (event.clientX - turning.startX) * 0.6
        setPlacementRotation(effectiveSnap(editor) ? Math.round(angle / SNAP.rotateDeg) * SNAP.rotateDeg : angle)
        return
      }
      if (event.clientX !== pointer.current?.x || event.clientY !== pointer.current?.y) heldPosition = null
      pointer.current = { x: event.clientX, y: event.clientY }
    }
    const leave = () => {
      if (turning) return
      heldPosition = null
      pointer.current = null
      update()
    }
    const press = (event: PointerEvent) => {
      const { ref, rotation } = usePlacement.getState()
      if (!ref) return
      if (event.button === 0 && !turning) pressed = { x: event.clientX, y: event.clientY }
      if (event.button !== 2) return
      event.preventDefault()
      event.stopImmediatePropagation()
      pressed = null
      const position = heldPosition ?? landing(event.clientX, event.clientY, ref)
      if (!position) return
      heldPosition = position
      turning = { pointerId: event.pointerId, startX: event.clientX, angle: rotation }
      canvas.setPointerCapture(event.pointerId)
    }
    const releaseTurn = () => {
      const id = turning?.pointerId
      turning = null
      if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id)
    }
    const endTurn = (event: PointerEvent) => {
      if (turning?.pointerId !== event.pointerId) return
      pointer.current = { x: event.clientX, y: event.clientY }
      if (event.type === 'pointercancel') heldPosition = null
      releaseTurn()
    }
    const contextMenu = (event: MouseEvent) => {
      if (usePlacement.getState().ref) event.preventDefault()
    }
    const click = (event: MouseEvent) => {
      if (!usePlacement.getState().ref || event.button !== 0) return
      event.stopImmediatePropagation()
      const start = pressed
      pressed = null
      if (!turning && start && Math.hypot(start.x - event.clientX, start.y - event.clientY) < 5) {
        commit(event.clientX, event.clientY, heldPosition ?? undefined)
        heldPosition = null
      }
    }
    const drag = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(MODEL_DRAG_TYPE)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      move(event)
    }
    const drop = (event: DragEvent) => {
      const ref = event.dataTransfer?.getData(MODEL_DRAG_TYPE)
      if (!ref || !useSceneStore.getState().manifest?.models[ref]) return
      event.preventDefault()
      if (usePlacement.getState().ref !== ref) startPlacement(ref)
      commit(event.clientX, event.clientY)
    }
    const key = (event: KeyboardEvent) => {
      if (event.code === 'Escape' && useBuildTools.getState().interaction === 'box') useBuildTools.setState({ interaction: 'select' })
      if (event.code === 'Escape' && useBuildTools.getState().preview) useBuildTools.setState({ preview: null })
      if (!usePlacement.getState().ref) return
      if (event.code === 'Escape') cancelPlacement()
      if ((event.code === 'BracketLeft' || event.code === 'BracketRight')
          && !(event.target instanceof HTMLElement && event.target.matches('input,textarea,select'))) {
        event.preventDefault()
        rotatePlacement(event.code === 'BracketLeft' ? -15 : 15)
      }
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('pointerdown', press, true)
    canvas.addEventListener('pointerup', endTurn)
    canvas.addEventListener('pointercancel', endTurn)
    canvas.addEventListener('lostpointercapture', endTurn)
    canvas.addEventListener('contextmenu', contextMenu)
    canvas.addEventListener('click', click, true)
    canvas.addEventListener('dragover', drag)
    canvas.addEventListener('dragleave', leave)
    canvas.addEventListener('drop', drop)
    window.addEventListener('keydown', key)
    const off = usePlacement.subscribe((next, previous) => {
      if (next.ref !== previous.ref) {
        releaseTurn()
        heldPosition = null
        pressed = null
      }
      update()
    })
    renderPreview.current = update
    return () => {
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('pointerdown', press, true)
      canvas.removeEventListener('pointerup', endTurn)
      canvas.removeEventListener('pointercancel', endTurn)
      canvas.removeEventListener('lostpointercapture', endTurn)
      canvas.removeEventListener('contextmenu', contextMenu)
      canvas.removeEventListener('click', click, true)
      canvas.removeEventListener('dragover', drag)
      canvas.removeEventListener('dragleave', leave)
      canvas.removeEventListener('drop', drop)
      window.removeEventListener('keydown', key)
      off()
      releaseTurn()
      renderPreview.current = undefined
      cancelPlacement()
    }
  }, [gl, camera, scene])

  useFrame(() => renderPreview.current?.())
  if (!ref || (!model && !combination)) return null
  return (
    <group ref={preview} visible={false} userData={{ editorHelper: true }}>
      <Suspense fallback={null}>
        {combination ? combination.assets.map(asset => <AssetInstance key={asset.id} asset={asset} ghost interactive={false} />)
          : <AssetInstance asset={{ id: 'placement-preview', ref, transform: { position: [0, 0, 0], rotation: [0, 0, 0] } }} ghost interactive={false} />}
      </Suspense>
    </group>
  )
}
