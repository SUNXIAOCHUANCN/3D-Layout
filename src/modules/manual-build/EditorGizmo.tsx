import { TransformControls } from '@react-three/drei'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Object3D } from 'three'
import { assetHierarchy, followTransform } from '../../core/assetHierarchy'
import { edit, type TxHandle } from '../../core/edit'
import { engine } from '../../core/engine'
import { bus } from '../../core/events'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Transform } from '../../core/types'
import { selectedRoots, selectionPivot } from './buildTools'
import { SNAP, effectiveSnap, supportsGizmoMode, useEditorStore } from './editorStore'

const degToRad = (d: number) => (d * Math.PI) / 180
const radToDeg = (r: number) => (r * 180) / Math.PI

/**
 * 给 gizmo 视觉件打 userData.editorHelper 标记：engine.captureScreenshot
 * 无 UI 截图时临时隐藏。r186 的 TransformControls 用 getHelper() 取视觉根；
 * 旧实现（three-stdlib）直接暴露 .gizmo——两处都兜住。
 */
const tagGizmoHelper = (c: unknown) => {
  const ctl = c as { getHelper?: () => Object3D; gizmo?: Object3D } | null
  const helper = ctl?.getHelper?.() ?? ctl?.gizmo ?? null
  if (helper && helper !== ctl) helper.userData.editorHelper = true
}

/**
 * 编辑器 gizmo 层（装配点①：SceneCanvas 的 children）。
 * 拖拽实时写回 SceneDocument（数据驱动渲染），整个拖拽是一个事务（一条可撤销记录）。
 */
export function EditorGizmo() {
  const selectedId = useSceneStore(s => s.selectedLightId ?? s.selectedAssetId)
  const light = useSceneStore(s => s.document?.lights?.find(light => light.id === s.selectedLightId))
  const assets = useSceneStore(s => s.document?.assets)
  const ids = useSceneStore(s => s.selectedAssetIds)
  const hidden = useSceneStore(s => s.editorHiddenIds)
  const requestedMode = useEditorStore(s => s.mode)
  const mode = supportsGizmoMode(requestedMode, light?.type) ? requestedMode : 'translate'
  const space = useEditorStore(s => s.space)
  const snap = useEditorStore(s => s.snap)
  const ctrlHeld = useEditorStore(s => s.ctrlHeld)
  const tx = useRef<TxHandle | null>(null)
  const pivot = useMemo(() => new Object3D(), [])
  const initial = useRef<{ transform: Transform; objects: SceneAsset[] } | null>(null)
  const [obj, setObject] = useState<Object3D | null>(null)
  const isLight = Boolean(light)
  const multi = ids.length > 1
  const tree = useMemo(() => assetHierarchy(assets ?? []), [assets])
  const roots = selectedRoots(assets ?? [], ids)
  const locked = roots.some(asset => tree.locked(asset) || !tree.visible(asset, new Set(hidden)) || tree.descendants(asset.id).some(tree.locked))
  const scaleTogether = multi || Boolean(roots[0]?.group)

  useLayoutEffect(() => {
    // 新建或复制后，等同一帧的场景对象挂载，再查找变换轴的目标。
    if (multi && assets) {
      if (!tx.current) {
        const selection = selectedRoots(assets, ids)
        pivot.position.set(...selectionPivot(selection))
        pivot.rotation.set(...(space === 'local' ? selection.at(-1)?.transform.rotation ?? [0, 0, 0] : [0, 0, 0]).map(degToRad) as [number, number, number])
        pivot.scale.setScalar(1)
        pivot.updateMatrixWorld()
      }
      setObject(pivot)
    } else setObject(selectedId ? (isLight ? engine.findLightObject(selectedId) : engine.findAssetObject(selectedId)) : null)
  }, [selectedId, isLight, assets, ids, multi, pivot, space])

  useLayoutEffect(() => () => {
    tx.current?.rollback()
    tx.current = null
    initial.current = null
  }, [selectedId, mode, ids, locked])

  if (locked || !obj || !selectedId || (!multi && obj.name !== selectedId)) return null

  const transformOf = (object: Object3D): Transform => ({
    position: object.position.toArray(),
    rotation: [radToDeg(object.rotation.x), radToDeg(object.rotation.y), radToDeg(object.rotation.z)],
    scale: object.scale.toArray(),
  })

  const snapOn = effectiveSnap({ snap, ctrlHeld })
  const snapProps = {
    translationSnap: snapOn ? SNAP.translate : null,
    rotationSnap: snapOn ? degToRad(SNAP.rotateDeg) : null,
    scaleSnap: snapOn ? SNAP.scale : null,
  }

  const handlers = {
    onMouseDown: () => {
      if (tx.current || !edit.canBegin) return
      tx.current = edit.begin(`拖拽 ${selectedId}`, 'human')
      initial.current = { transform: transformOf(obj), objects: roots }
      if (!light) bus.emit('transform:drag-start', { assetId: selectedId })
    },
    onMouseUp: () => {
      tx.current?.commit()
      tx.current = null
      initial.current = null
      if (!light) bus.emit('transform:drag-end', { assetId: selectedId })
    },
    onObjectChange: () => {
      if (!tx.current) return
      const next = transformOf(obj)
      const original = initial.current
      if (mode === 'scale' && scaleTogether && original) {
        const previous = original.transform.scale ?? [1, 1, 1]
        const factors = next.scale!.map((value, i) => value / previous[i])
        const factor = factors.reduce((a, b) => Math.abs(a - 1) >= Math.abs(b - 1) ? a : b, 1)
        next.scale = previous.map(value => value * Math.max(0.01, factor)) as Transform['scale']
      }
      const meta = { tx: tx.current }
      if (light) edit.updateLight(selectedId, { position: next.position, rotation: next.rotation }, meta)
      else if (multi && original) edit.transformAssets(original.objects.map(asset => ({ id: asset.id, transform: followTransform(asset.transform, original.transform, next) })), '多选变换', meta)
      else edit.transformAssets([{ id: selectedId, transform: next }], '变换', meta)
    },
  }

  // 复合模式：移动 + 旋转两套 gizmo 同显（旋转缩小错开），拖哪个走哪个的事务
  const attach = multi ? <primitive object={pivot} /> : null
  if (mode === 'unified') {
    return (
      <>
        {attach}
        <TransformControls ref={tagGizmoHelper} object={obj} mode="translate" size={1} space={space} {...snapProps} {...handlers} />
        {light?.type !== 'point' && <TransformControls ref={tagGizmoHelper} object={obj} mode="rotate" size={0.55} space={space} {...snapProps} {...handlers} />}
      </>
    )
  }

  return <>{attach}<TransformControls ref={tagGizmoHelper} object={obj} mode={mode} size={1} space={space} {...snapProps} {...handlers} /></>
}
