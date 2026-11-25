import { memo, useMemo, useState } from 'react'
import { assetHierarchy } from '../../core/assetHierarchy'
import { edit } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import { createAssetTreeSelector, createLightTreeSelector, type AssetTreeRow } from '../../core/sceneStructure'
import type { SceneAsset, Vec3 } from '../../core/types'
import { groupSelection, reparentAssets, toggleAssetSelection } from './buildTools'
import { finishBuildTool } from './placement'
import { LIGHT_NAMES } from './ops'

export function CreateShape() {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<NonNullable<SceneAsset['shape']>['kind']>('box')
  const [size, setSize] = useState<Vec3>([2, 1, 2])
  const names = { box: '方块', plane: '平面', cylinder: '圆柱' } as const
  return <>
    <button className="btn" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>创建基础形体</button>
    {open && <form className="build-terrain" onSubmit={event => {
      event.preventDefault()
      if (!size.every(value => value > 0 && Number.isFinite(value))) return
      const id = `shape-${crypto.randomUUID()}`
      const state = useSceneStore.getState()
      const group = state.document?.assets.find(asset => asset.id === state.selectedAssetId && asset.group && !asset.locked)
      const asset: SceneAsset = {
        id, ref: `builtin/${kind}`, name: names[kind], parentId: group?.id,
        transform: { position: group?.transform.position ?? [0, 0, 0], rotation: [0, 0, 0] },
        shape: { kind, size: [...size] },
      }
      if (edit.addAsset(asset)) { state.select(id); setOpen(false) }
    }}>
      <label>形体<select className="llm-input" value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
        {Object.entries(names).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      {['宽度 (m)', '高度 (m)', '深度 (m)'].map((label, axis) => (axis !== 1 || kind !== 'plane') &&
        <label key={label}>{label}<input className="llm-input" type="number" min={0.01} max={5000} step="any" required value={size[axis] || ''}
          onChange={event => { const next: Vec3 = [...size]; next[axis] = Number(event.target.value); setSize(next) }} /></label>)}
      <button className="btn" type="submit">添加形体</button>
    </form>}
  </>
}

export const BuildHierarchy = memo(function BuildHierarchy() {
  const selectTree = useMemo(createAssetTreeSelector, [])
  const assets = useSceneStore(state => selectTree(state.document?.assets))
  const selectLights = useMemo(createLightTreeSelector, [])
  const lights = useSceneStore(state => selectLights(state.document?.lights))
  const catalog = useSceneStore(state => state.manifest?.models)
  const ids = useSceneStore(state => state.selectedAssetIds)
  const lightId = useSceneStore(state => state.selectedLightId)
  const hidden = useSceneStore(state => state.editorHiddenIds)
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const tree = useMemo(() => assetHierarchy(assets), [assets])
  const label = (asset: AssetTreeRow) => asset.name ?? catalog?.[asset.ref]?.name ?? asset.ref
  const term = filter.trim().toLowerCase()
  const matches = new Set(assets.filter(asset => `${label(asset)} ${asset.id}`.toLowerCase().includes(term))
    .flatMap(asset => [asset.id, ...tree.ancestors(asset).map(parent => parent.id)]))
  const drop = (event: React.DragEvent, parentId?: string) => {
    const raw = event.dataTransfer.getData('application/x-layout-objects')
    if (!raw) return
    event.preventDefault()
    event.stopPropagation()
    try {
      const dropped = JSON.parse(raw)
      if (Array.isArray(dropped) && dropped.every(id => typeof id === 'string')) reparentAssets(dropped, parentId)
    } catch { /* Ignore an external drag with an invalid payload. */ }
  }
  function nodes(parent?: string, depth = 0) {
    return (tree.children.get(parent) ?? []).filter(asset => matches.has(asset.id)).map(asset => <div key={asset.id}>
      <div className="build-tree-row" style={{ paddingInlineStart: depth * 11 }}
        draggable={!tree.locked(asset)}
        onDragStart={event => event.dataTransfer.setData('application/x-layout-objects', JSON.stringify(ids.includes(asset.id) ? ids : [asset.id]))}
        onDragOver={event => { if (asset.group && event.dataTransfer.types.includes('application/x-layout-objects')) event.preventDefault() }}
        onDrop={event => { if (asset.group) drop(event, asset.id) }}
      >
        {asset.group && <button className="icon-btn" aria-label={collapsed.includes(asset.id) ? '展开对象组' : '收起对象组'}
          onClick={() => setCollapsed(items => items.includes(asset.id) ? items.filter(id => id !== asset.id) : [...items, asset.id])}>
          {collapsed.includes(asset.id) && !term ? '▸' : '▾'}</button>}
        <button title={asset.id} className={ids.includes(asset.id) ? 'active' : ''} aria-pressed={ids.includes(asset.id)}
          onClick={event => { finishBuildTool(); toggleAssetSelection(asset.id, event.shiftKey || event.ctrlKey || event.metaKey) }}>
          {label(asset)}{asset.hasTerrain && <span className="hint">地形</span>}{tree.locked(asset) && <span className="hint">锁定</span>}
        </button>
        <button className="icon-btn" aria-pressed={hidden.includes(asset.id)} title="编辑视口临时隐藏"
          aria-label={`临时隐藏：${label(asset)}`} onClick={() => useSceneStore.getState().toggleEditorHidden(asset.id)}>
          {hidden.includes(asset.id) ? '◌' : '◉'}</button>
      </div>
      {asset.group && (term || !collapsed.includes(asset.id)) ? nodes(asset.id, depth + 1) : null}
    </div>)
  }
  return <>
    <div className="panel-label">场景对象</div>
    <input className="llm-input" type="search" aria-label="搜索场景对象" placeholder="搜索场景对象…" value={filter} onChange={event => setFilter(event.target.value)} />
    <div className="build-actions">
      <button className="btn" onClick={groupSelection}>{ids.length ? '分组所选' : '创建空组'}</button>
      {ids.length > 0 && <button className="btn" onDragOver={event => event.preventDefault()} onDrop={event => drop(event)} onClick={() => reparentAssets(ids)}>移到根级</button>}
    </div>
    <div className="btn-grid build-objects" aria-label="场景对象树">
      {nodes()}
      {lights?.filter(light => `${light.name ?? LIGHT_NAMES[light.type]} ${light.id}`.toLowerCase().includes(term)).map(light => (
        <button key={light.id} className={lightId === light.id ? 'active' : ''} aria-pressed={lightId === light.id}
          onClick={() => { finishBuildTool(); useSceneStore.getState().selectLight(light.id) }} title={light.id}>
          {light.name ?? LIGHT_NAMES[light.type]} {light.enabled === false && <span className="hint">已关闭</span>}
        </button>
      ))}
    </div>
  </>
})
