import { create } from 'zustand'
import { bus } from './events'
import { openWorkspace, flushWorkspace } from './persistence'
import { restoreHistory } from './edit'
import { loadManifest, loadViewBinding } from './loader'
import type { ModelManifest, SceneDocument, ViewBinding } from './types'

/**
 * SceneDocument 的运行时内存映像；已提交状态由后端工作区持久化。
 *
 * 规则：
 * - 对场景数据的修改一律走 core/edit.ts（编辑接口+历史），本 store 不提供任何文档变更 action；
 * - selection / 相机是观察状态，不进历史，用普通 action 即可；
 * - 除渲染同步组件（src/components/*）外，任何代码不得直接操作 three 对象。
 */
interface SceneState {
  sceneId: string | null
  document: SceneDocument | null
  /** threejs/view.json 的渲染绑定 */
  view: ViewBinding
  manifest: ModelManifest | null
  sceneError: string | null
  selectedAssetId: string | null
  loading: boolean

  /** 启动：拉 manifest 并加载首个场景 */
  boot: (sceneId: string) => Promise<void>
  loadScene: (sceneId: string) => Promise<void>
  select: (assetId: string | null) => void
}

export const useSceneStore = create<SceneState>((set, get) => ({
  sceneId: null,
  document: null,
  view: {},
  manifest: null,
  sceneError: null,
  selectedAssetId: null,
  loading: false,

  boot: async sceneId => {
    if (!get().manifest) {
      try {
        set({ manifest: await loadManifest() })
      } catch (e) {
        set({ sceneError: `模型库 manifest 加载失败：${e instanceof Error ? e.message : e}` })
        return
      }
    }
    await get().loadScene(sceneId)
  },

  loadScene: async sceneId => {
    if (get().loading) return
    set({ sceneError: null, loading: true })
    try {
      await flushWorkspace()
      const [workspace, view] = await Promise.all([
        openWorkspace(sceneId),
        loadViewBinding(sceneId),
      ])
      set({ sceneId, document: workspace.document, view, selectedAssetId: null })
      bus.emit('scene:changed', { sceneId })
      restoreHistory(workspace)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.set('scene', sceneId)
        window.history.replaceState(null, '', url)
      }
    } catch (e) {
      set({ sceneError: `场景 ${sceneId} 加载失败：${e instanceof Error ? e.message : e}` })
    } finally {
      set({ loading: false })
    }
  },

  select: assetId => {
    if (get().selectedAssetId === assetId) return
    set({ selectedAssetId: assetId })
    bus.emit('asset:selected', { assetId })
  },
}))
