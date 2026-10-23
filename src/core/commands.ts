import { edit } from './edit'
import { bus } from './events'
import { useSceneStore } from './store'
import type { SceneAsset, Transform } from './types'

/**
 * 命令分发层（兼容保留）：场景数据变更全部委托给 core/edit.ts（编辑接口+历史）。
 * 一期 UI 经此触发；三期 Agent 远端命令同样落到 edit，只是 source 标记不同，
 * 届时在这里叠加 WebSocket 转发与权限校验。
 */
export type Command =
  | { type: 'set_transform'; assetId: string; transform: Transform }
  | { type: 'add_asset'; asset: SceneAsset }
  | { type: 'remove_asset'; assetId: string }
  | { type: 'select'; assetId: string | null }
  | { type: 'load_scene'; sceneId: string }
  | { type: 'undo' }
  | { type: 'redo' }

export const commandBus = {
  dispatch(cmd: Command): void {
    bus.emit('command:dispatched', { type: cmd.type })
    const s = useSceneStore.getState()
    switch (cmd.type) {
      case 'set_transform':
        edit.setTransform(cmd.assetId, cmd.transform, { source: 'human' })
        break
      case 'add_asset':
        edit.addAsset(cmd.asset, { source: 'human' })
        break
      case 'remove_asset':
        edit.removeAsset(cmd.assetId, { source: 'human' })
        break
      case 'select':
        s.select(cmd.assetId)
        break
      case 'load_scene':
        void s.loadScene(cmd.sceneId)
        break
      case 'undo':
        edit.undo()
        break
      case 'redo':
        edit.redo()
        break
    }
  },
}
