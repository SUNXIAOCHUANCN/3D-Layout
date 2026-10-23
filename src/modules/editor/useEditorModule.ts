import { useEffect } from 'react'
import { bus } from '../../core/events'
import { useSceneStore } from '../../core/store'
import { useEditorShortcuts } from './useEditorShortcuts'

/**
 * 编辑器模块的装配钩子（App 调用一次）。
 * 模块挂载 = 订阅渲染层上报的交互事实：点击资产→选中、点空白→取消；
 * 模块卸载 = 无人订阅 → 点击无任何效果（纯渲染器模式）。
 */
export function useEditorModule(enabled: boolean): void {
  useEditorShortcuts(enabled)

  useEffect(() => {
    if (!enabled) return
    const offClicked = bus.on('asset:clicked', ({ assetId }) => {
      useSceneStore.getState().select(assetId)
    })
    const offEmpty = bus.on('viewport:empty-click', () => {
      useSceneStore.getState().select(null)
    })
    // 撤销/重做可能删掉选中资产，保持选中状态与文档一致
    const offHistory = bus.on('history:changed', () => {
      const s = useSceneStore.getState()
      const id = s.selectedAssetId
      if (id && !s.document?.assets.some(a => a.id === id)) s.select(null)
    })
    return () => {
      offClicked()
      offEmpty()
      offHistory()
    }
  }, [enabled])
}
