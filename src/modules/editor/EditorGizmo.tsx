import { TransformControls } from '@react-three/drei'
import { useLayoutEffect, useRef, useState } from 'react'
import type { Object3D } from 'three'
import { edit, type TxHandle } from '../../core/edit'
import { engine } from '../../core/engine'
import { bus } from '../../core/events'
import { useSceneStore } from '../../core/store'
import type { Transform } from '../../core/types'
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
  const requestedMode = useEditorStore(s => s.mode)
  const mode = supportsGizmoMode(requestedMode, light?.type) ? requestedMode : 'translate'
  const space = useEditorStore(s => s.space)
  const snap = useEditorStore(s => s.snap)
  const ctrlHeld = useEditorStore(s => s.ctrlHeld)
  const tx = useRef<TxHandle | null>(null)
  const [obj, setObject] = useState<Object3D | null>(null)
  const isLight = Boolean(light)

  useLayoutEffect(() => {
    // 新建或复制后，等同一帧的场景对象挂载，再查找变换轴的目标。
    setObject(selectedId ? (isLight ? engine.findLightObject(selectedId) : engine.findAssetObject(selectedId)) : null)
  }, [selectedId, isLight, assets])

  useLayoutEffect(() => () => {
    tx.current?.rollback()
    tx.current = null
  }, [selectedId, mode])

  if (!obj || !selectedId || obj.name !== selectedId) return null

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
      if (!light) bus.emit('transform:drag-start', { assetId: selectedId })
    },
    onMouseUp: () => {
      tx.current?.commit()
      tx.current = null
      if (!light) bus.emit('transform:drag-end', { assetId: selectedId })
    },
    onObjectChange: () => {
      if (!tx.current) return
      const position: Transform['position'] = [obj.position.x, obj.position.y, obj.position.z]
      const rotation: Transform['rotation'] = [radToDeg(obj.rotation.x), radToDeg(obj.rotation.y), radToDeg(obj.rotation.z)]
      const meta = { tx: tx.current }
      if (light) edit.updateLight(selectedId, { position, rotation }, meta)
      else edit.setTransform(selectedId, { position, rotation, scale: [obj.scale.x, obj.scale.y, obj.scale.z] }, meta)
    },
  }

  // 复合模式：移动 + 旋转两套 gizmo 同显（旋转缩小错开），拖哪个走哪个的事务
  if (mode === 'unified') {
    return (
      <>
        <TransformControls ref={tagGizmoHelper} object={obj} mode="translate" size={1} space={space} {...snapProps} {...handlers} />
        {light?.type !== 'point' && <TransformControls ref={tagGizmoHelper} object={obj} mode="rotate" size={0.55} space={space} {...snapProps} {...handlers} />}
      </>
    )
  }

  return <TransformControls ref={tagGizmoHelper} object={obj} mode={mode} size={1} space={space} {...snapProps} {...handlers} />
}
