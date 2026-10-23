import { create } from 'zustand'

/** gizmo 四模式：移动/旋转/缩放/复合（移动+旋转同显，类似 Blender） */
export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'unified'

/** 吸附步长：移动 0.5m、旋转 15°、缩放 0.1；按住 Ctrl 临时反转开关状态 */
export const SNAP = { translate: 0.5, rotateDeg: 15, scale: 0.1 }

interface EditorState {
  mode: GizmoMode
  space: 'local' | 'world'
  snap: boolean
  ctrlHeld: boolean
  setMode: (mode: GizmoMode) => void
  setSpace: (space: 'local' | 'world') => void
  toggleSpace: () => void
  toggleSnap: () => void
  setCtrl: (ctrl: boolean) => void
}

/** 编辑器模块的私有状态（观察/工具状态，不进场景历史） */
export const useEditorStore = create<EditorState>(set => ({
  mode: 'translate',
  space: 'world',
  snap: true,
  ctrlHeld: false,
  setMode: mode => set({ mode }),
  setSpace: space => set({ space }),
  toggleSpace: () => set(s => ({ space: s.space === 'world' ? 'local' : 'world' })),
  toggleSnap: () => set(s => ({ snap: !s.snap })),
  setCtrl: ctrlHeld => set({ ctrlHeld }),
}))

/** 实际吸附是否生效：开关状态 XOR Ctrl 按住 */
export const effectiveSnap = (s: Pick<EditorState, 'snap' | 'ctrlHeld'>): boolean =>
  s.snap !== s.ctrlHeld
