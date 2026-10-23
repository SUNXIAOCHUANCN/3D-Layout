import { TransformControls } from '@react-three/drei'
import { useMemo, useRef } from 'react'
import type { Object3D } from 'three'
import { edit, type TxHandle } from '../../core/edit'
import { engine } from '../../core/engine'
import { bus } from '../../core/events'
import { useSceneStore } from '../../core/store'
import { SNAP, effectiveSnap, useEditorStore } from './editorStore'

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
  const selectedId = useSceneStore(s => s.selectedAssetId)
  const assets = useSceneStore(s => s.document?.assets)
  const mode = useEditorStore(s => s.mode)
  const space = useEditorStore(s => s.space)
  const snap = useEditorStore(s => s.snap)
  const ctrlHeld = useEditorStore(s => s.ctrlHeld)
  const tx = useRef<TxHandle | null>(null)

  const obj = useMemo(
    () => (selectedId ? engine.findAssetObject(selectedId) : undefined),
    // assets 变化（增删/撤销）会重建对象，需要重新查找
    [selectedId, assets],
  )

  if (!obj || !selectedId) return null

  const snapOn = effectiveSnap({ snap, ctrlHeld })
  const snapProps = {
    translationSnap: snapOn ? SNAP.translate : null,
    rotationSnap: snapOn ? degToRad(SNAP.rotateDeg) : null,
    scaleSnap: snapOn ? SNAP.scale : null,
  }

  const handlers = {
    onMouseDown: () => {
      tx.current = edit.begin(`拖拽 ${selectedId}`, 'human')
      bus.emit('transform:drag-start', { assetId: selectedId })
    },
    onMouseUp: () => {
      tx.current?.commit()
      tx.current = null
      bus.emit('transform:drag-end', { assetId: selectedId })
    },
    onObjectChange: () => {
      edit.setTransform(
        selectedId,
        {
          position: [obj!.position.x, obj!.position.y, obj!.position.z],
          rotation: [
            radToDeg(obj!.rotation.x),
            radToDeg(obj!.rotation.y),
            radToDeg(obj!.rotation.z),
          ],
          scale: [obj!.scale.x, obj!.scale.y, obj!.scale.z],
        },
        { source: 'human', tx: tx.current ?? undefined },
      )
    },
  }

  // 复合模式：移动 + 旋转两套 gizmo 同显（旋转缩小错开），拖哪个走哪个的事务
  if (mode === 'unified') {
    return (
      <>
        <TransformControls ref={tagGizmoHelper} object={obj} mode="translate" size={1} space={space} {...snapProps} {...handlers} />
        <TransformControls ref={tagGizmoHelper} object={obj} mode="rotate" size={0.55} space={space} {...snapProps} {...handlers} />
      </>
    )
  }

  return <TransformControls ref={tagGizmoHelper} object={obj} mode={mode} size={1} space={space} {...snapProps} {...handlers} />
}
