import { useState } from 'react'
import { commandBus } from '../core/commands'
import { engine } from '../core/engine'
import { createScene, deleteScene } from '../core/io'
import { useSceneStore } from '../core/store'
import type { SceneIndexEntry } from '../core/types'
import { ThemeSwitch } from './ThemeSwitch'
import { BrandMark } from './icons'

type Dialog = { kind: 'create' } | { kind: 'delete' } | null

/** 顶栏：品牌 / 场景字段板 / 场景增删 / 仪表读数 / 配色切换 / 截图 */
export function TopBar(props: { scenes: SceneIndexEntry[]; locked?: boolean }) {
  const { scenes, locked } = props
  const sceneId = useSceneStore(s => s.sceneId)
  const sceneDoc = useSceneStore(s => s.document)
  const selected = useSceneStore(s => s.selectedAssetId)
  const sceneError = useSceneStore(s => s.sceneError)

  const [dialog, setDialog] = useState<Dialog>(null)
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const shot = () => {
    const url = engine.captureScreenshot()
    const a = document.createElement('a')
    a.href = url
    a.download = `${sceneId ?? 'scene'}.png`
    a.click()
  }

  const openCreate = () => {
    setName('')
    setMsg('')
    setDialog({ kind: 'create' })
  }

  const openDelete = () => {
    if (!sceneId) return
    if (scenes.length <= 1) {
      setMsg('至少要保留一个场景')
      setTimeout(() => setMsg(''), 4000)
      return
    }
    setMsg('')
    setDialog({ kind: 'delete' })
  }

  /** 新建：服务端建目录 + 登记索引 → 切到新场景 */
  const doCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const { id } = await createScene(trimmed)
      setDialog(null)
      commandBus.dispatch({ type: 'load_scene', sceneId: id })
    } catch (e) {
      setMsg(`新建失败：${e instanceof Error ? e.message : e}`)
      setTimeout(() => setMsg(''), 6000)
    }
  }

  /** 删除：服务端删目录 + 摘索引 → 切到剩下的第一个场景 */
  const doDelete = async () => {
    if (!sceneId) return
    try {
      await deleteScene(sceneId)
      setDialog(null)
      const rest = scenes.filter(s => s.id !== sceneId)
      if (rest.length) commandBus.dispatch({ type: 'load_scene', sceneId: rest[0].id })
    } catch (e) {
      setMsg(`删除失败：${e instanceof Error ? e.message : e}`)
      setTimeout(() => setMsg(''), 6000)
    }
  }

  const assetCount = sceneDoc ? String(sceneDoc.assets.length).padStart(2, '0') : null

  return (
    <header className="topbar">
      <span className="brand">
        <BrandMark />
        <span className="brand-name">3D·LAYOUT</span>
      </span>
      <span className="vrule" />

      <label className={`field${locked ? ' is-disabled' : ''}`}>
        <span className="field-tag">SCENE</span>
        <select
          value={sceneId ?? ''}
          disabled={locked}
          title={locked ? 'CoAgent 运行中：场景切换已锁定' : '切换场景'}
          onChange={e => commandBus.dispatch({ type: 'load_scene', sceneId: e.target.value })}
        >
          {scenes.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <button className="btn" onClick={openCreate} disabled={locked} title="新建空场景">
        <span className="glyph">+</span>新建
      </button>
      <button className="btn" onClick={openDelete} disabled={locked || !sceneId} title="删除当前场景">
        <span className="glyph">−</span>删除
      </button>

      {assetCount !== null && (
        <span className="readout" title="当前场景资产数">
          <b>{assetCount}</b>
          <i>资产</i>
        </span>
      )}
      {selected && (
        <span className="chip" title={`已选中：${selected}`}>
          <span className="pip" />
          {selected}
        </span>
      )}
      {sceneError && <span className="error">{sceneError}</span>}
      {msg && <span className="error">{msg}</span>}

      <span className="spacer" />
      <ThemeSwitch />
      <button className="btn" onClick={shot} title="按当前相机导出视口截图（不含 UI）">
        截图
      </button>

      {dialog && (
        <div className="modal-mask" onClick={() => setDialog(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{dialog.kind === 'create' ? '新建场景' : '删除场景'}</div>
            {dialog.kind === 'create' ? (
              <>
                <div className="modal-text">
                  将创建一个空场景（无资产），场景 id 自动生成，名称用于下拉栏显示。
                </div>
                <input
                  className="llm-input"
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  autoFocus
                  value={name}
                  placeholder="场景名称"
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void doCreate()
                  }}
                />
                <div className="modal-actions" style={{ marginTop: 14 }}>
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="primary" onClick={() => void doCreate()}>
                    创建
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-text">
                  将删除场景「{sceneDoc?.meta.name ?? sceneId}」（{sceneId}）及其全部文件。
                  未保存的编辑会一并丢失，且不可恢复。
                </div>
                <div className="modal-actions">
                  <button onClick={() => setDialog(null)}>取消</button>
                  <button className="primary" onClick={() => void doDelete()}>
                    删除
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  )
}
