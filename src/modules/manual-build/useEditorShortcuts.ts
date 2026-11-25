import { useEffect } from 'react'
import { edit } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import { duplicateSelected, focusSelected, removeSelected } from './ops'
import { useEditorStore } from './editorStore'
import { activateGizmoMode, usePlacement } from './placement'
import type { GizmoMode } from './editorStore'

const GIZMO_SHORTCUTS: Record<string, GizmoMode> = { KeyW: 'translate', KeyE: 'rotate', KeyR: 'scale', KeyT: 'unified' }

/**
 * 编辑器快捷键（类 Unity）：W/E/R/T 切模式、X 切坐标系、F 聚焦、
 * Delete 删除、Ctrl+D 复制、Ctrl+Z / Ctrl+Shift+Z(或 Ctrl+Y) 撤销重做；
 * 按住 Ctrl 临时反转吸附。输入框聚焦时全部失效。
 */
export function useEditorShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    const isTyping = (t: EventTarget | null): boolean =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement

    const onDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') useEditorStore.getState().setCtrl(true)
      if (isTyping(e.target)) return
      if (document.querySelector('[aria-label="搭建回放"][aria-modal="true"]')) return

      const es = useEditorStore.getState()
      const ss = useSceneStore.getState()
      const sel = ss.selectedLightId ?? ss.selectedAssetId
      const mod = e.ctrlKey || e.metaKey
      const gizmoMode = GIZMO_SHORTCUTS[e.code]
      if (gizmoMode && !mod) {
        activateGizmoMode(gizmoMode)
        return
      }
      if (usePlacement.getState().ref && !mod && e.code !== 'KeyF') return

      switch (e.code) {
        case 'KeyX':
          if (!mod) es.toggleSpace()
          break
        case 'KeyF':
          if (sel && !mod) focusSelected()
          break
        case 'Delete':
        case 'Backspace':
          if (sel) removeSelected()
          break
        case 'KeyD':
          if (mod && sel) {
            e.preventDefault()
            duplicateSelected()
          }
          break
        case 'KeyZ':
          if (mod) {
            e.preventDefault()
            if (e.shiftKey) edit.redo()
            else edit.undo()
          }
          break
        case 'KeyY':
          if (mod) {
            e.preventDefault()
            edit.redo()
          }
          break
      }
    }

    const onUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') useEditorStore.getState().setCtrl(false)
    }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      useEditorStore.getState().setCtrl(false)
    }
  }, [enabled])
}
