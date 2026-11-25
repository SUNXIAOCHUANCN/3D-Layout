import { useEffect } from 'react'
import { bus } from '../../core/events'
import { useSceneStore } from '../../core/store'
import { useEditorShortcuts } from './useEditorShortcuts'
import { usePlacement } from './placement'
import { toggleAssetSelection, useBuildTools } from './buildTools'

/**
 * 编辑器模块的装配钩子（App 调用一次）。
 * 点击选择是只读交互，与修改快捷键独立控制。
 * AI 任务锁定人工修改时，仍可点击选中和取消选中。
 */
export function useEditorModule(enabled: boolean, selectionEnabled = enabled): void {
  useEditorShortcuts(enabled)

  useEffect(() => {
    if (!selectionEnabled) return
    const offClicked = bus.on('asset:clicked', ({ assetId, additive }) => {
      if (usePlacement.getState().ref || useBuildTools.getState().interaction !== 'select') return
      toggleAssetSelection(assetId, additive)
    })
    const offLightClicked = bus.on('light:clicked', ({ lightId }) => {
      if (usePlacement.getState().ref || useBuildTools.getState().interaction !== 'select') return
      useSceneStore.getState().selectLight(lightId)
    })
    const offEmpty = bus.on('viewport:empty-click', () => {
      if (usePlacement.getState().ref || useBuildTools.getState().interaction !== 'select') return
      useSceneStore.getState().select(null)
    })
    // 撤销/重做可能删掉选中资产，保持选中状态与文档一致
    const offHistory = bus.on('history:changed', () => {
      const s = useSceneStore.getState()
      const ids = s.selectedAssetIds.filter(id => s.document?.assets.some(asset => asset.id === id))
      if (ids.length !== s.selectedAssetIds.length) s.selectMany(ids)
      if (s.selectedLightId && !s.document?.lights?.some(light => light.id === s.selectedLightId)) s.select(null)
    })
    const offScene = bus.on('scene:will-change', () => useBuildTools.setState({ preview: null, interaction: 'select', viewDirection: 'perspective' }))
    return () => {
      offClicked()
      offLightClicked()
      offEmpty()
      offHistory()
      offScene()
    }
  }, [selectionEnabled])
}
