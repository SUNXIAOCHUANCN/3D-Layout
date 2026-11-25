import { OrthographicCamera } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { Suspense, useEffect, useLayoutEffect, useRef } from 'react'
import { Box3, OrthographicCamera as ThreeOrtho, Vector3 } from 'three'
import { AssetInstance } from '../../components/AssetInstance'
import { assetHierarchy } from '../../core/assetHierarchy'
import { engine } from '../../core/engine'
import { useSceneStore } from '../../core/store'
import { useBuildTools } from './buildTools'

export function BuildOrthoView() {
  const direction = useBuildTools(state => state.viewDirection)
  const controls = useThree(state => state.controls) as unknown as { target: Vector3; update: () => void } | null
  const reference = useRef<ThreeOrtho>(null)
  const applied = useRef<string>('')
  useLayoutEffect(() => {
    const camera = reference.current
    if (!camera || direction === 'perspective' || !controls) {
      applied.current = ''
      return
    }
    const bounds = new Box3()
    for (const asset of useSceneStore.getState().document?.assets ?? []) {
      const object = engine.findAssetObject(asset.id)
      if (object?.visible) bounds.union(new Box3().setFromObject(object))
    }
    const center = bounds.getCenter(new Vector3())
    const size = Math.max(8, bounds.getSize(new Vector3()).length() * 0.7)
    const offset = { top: [0, 1, 0], front: [0, 0, 1], right: [1, 0, 0] }[direction]
    camera.up.set(0, direction === 'top' ? 0 : 1, direction === 'top' ? -1 : 0)
    camera.position.copy(center).addScaledVector(new Vector3(...offset), size * 2)
    camera.lookAt(center)
    camera.zoom = Math.max(0.001, Math.min(camera.right, camera.top) / size)
    camera.updateProjectionMatrix()
    if (applied.current !== direction) {
      controls.target.copy(center)
      applied.current = direction
    }
    controls.update()
  }, [direction, controls])
  return direction === 'perspective' ? null : <OrthographicCamera key={direction} ref={reference} makeDefault near={0.01} far={1e6}
    up={direction === 'top' ? [0, 0, -1] : [0, 1, 0]} />
}

export function LayoutPreview() {
  const preview = useBuildTools(state => state.preview)
  const doc = useSceneStore(state => state.document)
  if (!preview || preview.doc !== doc) return null
  return <group userData={{ editorHelper: true }}>
    {preview.changes.map(({ id, after }) => after && <Suspense key={id} fallback={null}>
      <AssetInstance asset={after} ghost interactive={false} />
    </Suspense>)}
  </group>
}

export function BoxSelectLayer() {
  const { gl, camera } = useThree()
  useEffect(() => {
    const canvas = gl.domElement
    let start: { x: number; y: number; additive: boolean; id: number } | null = null
    let rect: HTMLDivElement | null = null
    const cleanup = () => { rect?.remove(); rect = null; start = null }
    const begin = (event: PointerEvent) => {
      if (event.button !== 0 || useBuildTools.getState().interaction !== 'box') return
      start = { x: event.clientX, y: event.clientY, additive: event.shiftKey || event.ctrlKey, id: event.pointerId }
      canvas.setPointerCapture(event.pointerId)
      rect = document.createElement('div')
      rect.className = 'build-selection-rect'
      document.body.append(rect)
    }
    const move = (event: PointerEvent) => {
      if (!start || !rect) return
      const left = Math.min(start.x, event.clientX), top = Math.min(start.y, event.clientY)
      Object.assign(rect.style, { left: `${left}px`, top: `${top}px`, width: `${Math.abs(start.x - event.clientX)}px`, height: `${Math.abs(start.y - event.clientY)}px` })
    }
    const finish = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return
      const documentRect = canvas.getBoundingClientRect()
      const left = Math.min(start.x, event.clientX), right = Math.max(start.x, event.clientX)
      const top = Math.min(start.y, event.clientY), bottom = Math.max(start.y, event.clientY)
      if (start.id === event.pointerId && canvas.hasPointerCapture(start.id)) canvas.releasePointerCapture(start.id)
      const { document, selectMany, editorHiddenIds, selectedAssetIds } = useSceneStore.getState()
      if (document && right - left > 3 && bottom - top > 3) {
        const tree = assetHierarchy(document.assets)
        const hidden = new Set(editorHiddenIds)
        camera.updateMatrixWorld(true)
        const ids = document.assets.filter(asset => {
          if (asset.group || !tree.visible(asset, hidden)) return false
          const root = engine.findAssetObject(asset.id)
          if (!root) return false
          const point = new Box3().setFromObject(root).getCenter(new Vector3()).project(camera)
          const x = documentRect.left + (point.x + 1) * documentRect.width / 2
          const y = documentRect.top + (1 - point.y) * documentRect.height / 2
          return Math.abs(point.z) <= 1 && x >= left && x <= right && y >= top && y <= bottom
        }).map(asset => asset.id)
        selectMany(start.additive ? [...selectedAssetIds, ...ids] : ids)
      }
      cleanup()
    }
    canvas.addEventListener('pointerdown', begin)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', cleanup)
    return () => {
      canvas.removeEventListener('pointerdown', begin)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', finish)
      canvas.removeEventListener('pointercancel', cleanup)
      cleanup()
    }
  }, [gl, camera])
  return null
}
