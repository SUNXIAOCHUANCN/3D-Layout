import { useEffect, useReducer, useState } from 'react'
import { edit } from '../../core/edit'
import { bus } from '../../core/events'
import { saveScene } from '../../core/io'
import { useSceneStore } from '../../core/store'
import { addLight, duplicateSelected, focusSelected, removeSelected } from './ops'
import { SNAP, useEditorStore } from './editorStore'
import { cancelPlacement, rotatePlacement, usePlacement } from './placement'
import { CreateTerrain } from './terrain'
import { RecordingsPanel } from './RecordingsPanel'
import { BuildHierarchy, CreateShape } from './BuildHierarchy'
import { LayoutTools } from './LayoutTools'
import { BrushControls } from './terrainBrush'
import { useCombinations } from './buildLibrary'

/**
 * 人工编辑插件的面板 UI（挂在左侧插件侧边栏）：
 * 变换工具 + 操作按钮 + 数值面板。撤销/重做直接驱动引擎的 edit 历史栈。
 */
export function ManualBuildPanel({ openLibrary }: { openLibrary: () => void }) {
  const space = useEditorStore(s => s.space)
  const toggleSpace = useEditorStore(s => s.toggleSpace)
  const snap = useEditorStore(s => s.snap)
  const toggleSnap = useEditorStore(s => s.toggleSnap)
  const selectedId = useSceneStore(s => s.selectedAssetId)
  const selectedLightId = useSceneStore(s => s.selectedLightId)
  const lights = useSceneStore(s => s.document?.lights)
  const assetCount = useSceneStore(s => s.document?.assets.length ?? 0)
  const loading = useSceneStore(s => s.loading)
  const catalog = useSceneStore(s => s.manifest?.models)
  const placement = usePlacement()
  const combo = useCombinations(s => s.entries.find(item => 'combo:' + item.id === placement.ref))
  const selectedLight = lights?.find(light => light.id === selectedLightId)
  const hasSelection = Boolean(selectedId || selectedLight)
  const sceneId = useSceneStore(s => s.sceneId)
  const hasDoc = useSceneStore(s => s.document !== null)

  // edit 的历史栈不是响应式 store，用 history:changed 事件驱动按钮状态
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => bus.on('history:changed', bump), [])

  return (
    <div className="editor-panel manual-build-panel">
      <SaveBuildScene key={sceneId} disabled={!hasDoc || loading} />
      <div className="btn-grid g2">
        <CreateTerrain />
        <CreateShape />
        <button onClick={openLibrary}>浏览素材</button>
      </div>
      {!assetCount && !lights?.length && <div className="inspector-empty">创建地形，或从素材库选个模型放到参考网格。</div>}
      <label className="build-checkbox">
        <input type="checkbox" checked={placement.continuous} onChange={e => usePlacement.setState({ continuous: e.target.checked })} /> 连续放置
      </label>
      {placement.ref && <div className="build-placement">
        <strong>{combo?.name ?? catalog?.[placement.ref]?.name} · {placement.rotation}°</strong>
        <small>左键放置 · 按住右键拖动旋转 · Esc 退出</small>
        <div className="btn-grid g2">
          <button onClick={() => rotatePlacement(-15)}>左转 15°</button>
          <button onClick={() => rotatePlacement(15)}>右转 15°</button>
          <button onClick={cancelPlacement}>取消放置</button>
        </div>
      </div>}
      <BrushControls openLibrary={openLibrary} />
      <LayoutTools />
      <RecordingsPanel />
      <div className="btn-grid g2">
        <button onClick={toggleSpace} title="快捷键 X：切换坐标系">
          坐标系：{space === 'world' ? '全局' : '局部'}
        </button>
        <button
          className={snap ? 'toggle on' : 'toggle'}
          onClick={toggleSnap}
          title={`移动 ${SNAP.translate}m / 旋转 ${SNAP.rotateDeg}° / 缩放 ${SNAP.scale}，按住 Ctrl 临时反转`}
        >
          吸附
        </button>
      </div>

      <div className="panel-label">操作</div>
      <div className="btn-grid g2">
        <button disabled={!edit.canUndo} onClick={() => edit.undo()} title="Ctrl+Z">
          ↩ 撤销
        </button>
        <button disabled={!edit.canRedo} onClick={() => edit.redo()} title="Ctrl+Shift+Z / Ctrl+Y">
          ↪ 重做
        </button>
        <button
          disabled={!hasSelection}
          onClick={focusSelected}
          title="快捷键 F"
        >
          聚焦
        </button>
        <button disabled={!hasSelection} onClick={() => duplicateSelected()} title="Ctrl+D">
          复制
        </button>
        <button
          disabled={!hasSelection}
          onClick={removeSelected}
          title="Delete"
        >
          删除
        </button>
      </div>

      <div className="panel-label">灯光</div>
      <div className="btn-grid g2">
        <button disabled={!hasDoc} onClick={() => addLight('point')}>新建点光源</button>
        <button disabled={!hasDoc} onClick={() => addLight('spot')}>新建聚光灯</button>
      </div>
      <BuildHierarchy />
    </div>
  )
}

function SaveBuildScene({ disabled }: { disabled: boolean }) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const save = async () => {
    setSaving(true)
    setMessage('')
    setFailed(false)
    try {
      const result = await saveScene()
      setMessage(result.mode === 'server' ? '场景已保存' : '场景文件已下载')
    } catch (cause) {
      setFailed(true)
      setMessage(`保存失败：${cause instanceof Error ? cause.message : cause}`)
    } finally {
      setSaving(false)
    }
  }
  return <>
    <div className="build-panel-heading">
      <div className="panel-label">搭建工具</div>
      <button className="btn primary" type="button" disabled={disabled || saving} onClick={() => void save()}>
        {saving ? '保存中…' : '保存场景'}
      </button>
    </div>
    {message && <div className={failed ? 'error' : 'save-status'} role={failed ? 'alert' : 'status'}>{message}</div>}
  </>
}
