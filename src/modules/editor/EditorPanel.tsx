import { useEffect, useReducer, useState } from 'react'
import { edit } from '../../core/edit'
import { engine } from '../../core/engine'
import { bus } from '../../core/events'
import { saveScene } from '../../core/io'
import { useSceneStore } from '../../core/store'
import { InspectorPanel } from './InspectorPanel'
import { duplicateSelected } from './ops'
import { SNAP, useEditorStore, type GizmoMode } from './editorStore'

const MODES: Array<{ key: GizmoMode; label: string; hint: string }> = [
  { key: 'translate', label: '移动', hint: 'W' },
  { key: 'rotate', label: '旋转', hint: 'E' },
  { key: 'scale', label: '缩放', hint: 'R' },
  { key: 'unified', label: '复合', hint: 'T' },
]

/**
 * 人工编辑插件的面板 UI（挂在左侧插件侧边栏）：
 * 变换工具 + 操作按钮 + 数值面板。撤销/重做直接驱动引擎的 edit 历史栈。
 */
export function EditorPanel() {
  const mode = useEditorStore(s => s.mode)
  const setMode = useEditorStore(s => s.setMode)
  const space = useEditorStore(s => s.space)
  const toggleSpace = useEditorStore(s => s.toggleSpace)
  const snap = useEditorStore(s => s.snap)
  const toggleSnap = useEditorStore(s => s.toggleSnap)
  const selectedId = useSceneStore(s => s.selectedAssetId)
  const sceneId = useSceneStore(s => s.sceneId)
  const hasDoc = useSceneStore(s => s.document !== null)

  // edit 的历史栈不是响应式 store，用 history:changed 事件驱动按钮状态
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => bus.on('history:changed', bump), [])

  const [saveStatus, setSaveStatus] = useState('')
  const save = async () => {
    try {
      const r = await saveScene()
      setSaveStatus(
        r.mode === 'server'
          ? `已保存 v${r.version} → scenes/${sceneId}/scene.json`
          : `无保存服务，已下载 ${sceneId}.scene.json (v${r.version})`,
      )
    } catch (e) {
      setSaveStatus(`保存失败：${e instanceof Error ? e.message : e}`)
    }
    setTimeout(() => setSaveStatus(''), 4000)
  }

  return (
    <div className="editor-panel">
      <div className="panel-label">变换工具</div>
      <div className="btn-grid g2">
        {MODES.map(m => (
          <button
            key={m.key}
            className={mode === m.key ? 'active' : ''}
            onClick={() => setMode(m.key)}
            title={`快捷键 ${m.hint}`}
          >
            {m.label} <span className="hint">{m.hint}</span>
          </button>
        ))}
      </div>
      <div className="btn-grid g2">
        <button onClick={toggleSpace} title="快捷键 X：切换坐标系">
          坐标系：{space === 'world' ? '全局' : '局部'}
        </button>
        <button
          className={snap ? 'active' : ''}
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
          disabled={!selectedId}
          onClick={() => selectedId && engine.focusAsset(selectedId)}
          title="快捷键 F"
        >
          聚焦
        </button>
        <button disabled={!selectedId} onClick={() => duplicateSelected()} title="Ctrl+D">
          复制
        </button>
        <button
          disabled={!selectedId}
          onClick={() => selectedId && edit.removeAsset(selectedId, { source: 'human' })}
          title="Delete"
        >
          删除
        </button>
        <button disabled={!hasDoc} onClick={() => void save()} title="写回 scenes/<id>/scene.json">
          保存
        </button>
      </div>
      {saveStatus && <div className="save-status">{saveStatus}</div>}

      <div className="panel-divider" />
      <InspectorPanel />
    </div>
  )
}
