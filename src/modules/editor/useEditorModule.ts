import { useEffect } from 'react'
import { bus } from '../../core/events'
import { useSceneStore } from '../../core/store'
import { useEditorShortcuts } from './useEditorShortcuts'

/**
 * 编辑器模块的装配钩子（App 调用一次）。
 * 点击选择是只读交互，与修改快捷键独立控制。
 * AI 任务锁定人工修改时，仍可点击选中和取消选中。
 */
export function useEditorModule(enabled: boolean, selectionEnabled = enabled): void {
  useEditorShortcuts(enabled)

  useEffect(() => {
    if (!selectionEnabled) return
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
  }, [selectionEnabled])
}
