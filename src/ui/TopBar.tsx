import { commandBus } from '../core/commands'
import { engine } from '../core/engine'
import { useSceneStore } from '../core/store'
import type { SceneIndexEntry } from '../core/types'

export function TopBar(props: { scenes: SceneIndexEntry[]; locked?: boolean }) {
  const { scenes, locked } = props
  const sceneId = useSceneStore(s => s.sceneId)
  const sceneDoc = useSceneStore(s => s.document)
  const selected = useSceneStore(s => s.selectedAssetId)
  const sceneError = useSceneStore(s => s.sceneError)

  const shot = () => {
    const url = engine.captureScreenshot()
    const a = document.createElement('a')
    a.href = url
    a.download = `${sceneId ?? 'scene'}.png`
    a.click()
  }

  return (
    <header className="topbar">
      <span className="brand">3D-Layout</span>
      <select
        value={sceneId ?? ''}
        disabled={locked}
        title={locked ? 'CoAgent 运行中：场景切换已锁定' : undefined}
        onChange={e => commandBus.dispatch({ type: 'load_scene', sceneId: e.target.value })}
      >
        {scenes.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {sceneDoc && <span className="muted">{sceneDoc.assets.length} 个资产</span>}
      {selected && <span className="chip">已选中：{selected}</span>}
      {sceneError && <span className="error">{sceneError}</span>}
      <span style={{ flex: 1 }} />
      <button onClick={shot} title="测试 engine.captureScreenshot 预留接口">
        截图
      </button>
    </header>
  )
}
