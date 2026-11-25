import { useState } from 'react'
import { Box3, Vector3 } from 'three'
import { assetHierarchy, followTransform, orientation } from '../../core/assetHierarchy'
import { edit, type AssetChange } from '../../core/edit'
import { engine } from '../../core/engine'
import { useSceneStore } from '../../core/store'
import type { SceneAsset, Transform, Vec3 } from '../../core/types'
import { cloneAssets, confirmLayout, previewLayout, selectedRoots, useBuildTools, type ViewDirection } from './buildTools'
import { cancelPlacement } from './placement'
import { useEditorStore } from './editorStore'

const directions = { perspective: '透视', top: '俯视', front: '正视', right: '右视' } as const
type LayoutAction = 'min' | 'center' | 'max' | 'distribute' | 'array'
const actions: Record<LayoutAction, string> = { min: '最小边对齐', center: '中心对齐', max: '最大边对齐', distribute: '等距分布', array: '阵列复制' }

function worldBounds(asset: SceneAsset, children: SceneAsset[]) {
  const result = new Box3().expandByPoint(new Vector3(...asset.transform.position))
  for (const item of [asset, ...children]) {
    const object = engine.findAssetObject(item.id)
    if (object) result.union(new Box3().setFromObject(object))
  }
  return result
}

export function replaceShape(modelRef: string, fit: boolean) {
  const state = useSceneStore.getState()
  const asset = state.document?.assets.find(item => item.id === state.selectedAssetId)
  const model = state.manifest?.models[modelRef]
  if (!asset?.shape || !model || !state.document || assetHierarchy(state.document.assets).locked(asset)) return
  const { shape, ...original } = asset
  const { w, h, d } = model.dimensions
  const previous = asset.transform.scale ?? [1, 1, 1]
  const scale: Vec3 = fit
    ? [previous[0] * shape.size[0] / (w || 1), shape.kind === 'plane' ? previous[1] : previous[1] * shape.size[1] / (h || 1), previous[2] * shape.size[2] / (d || 1)]
    : previous
  edit.applyAssets([{ id: asset.id, after: { ...original, ref: modelRef, name: model.name, transform: { ...asset.transform, scale } } }], '替换灰盒模型')
}

export function EditableAssetProperties({ asset, locked }: { asset: SceneAsset; locked: boolean }) {
  const assets = useSceneStore(state => state.document!.assets)
  const tree = assetHierarchy(assets)
  const related = new Set([asset.id, ...tree.descendants(asset.id).map(child => child.id)])
  const groups = assets.filter(item => item.group && !related.has(item.id) && !tree.locked(item))
  const override = asset.materialOverride ?? { color: '#ffffff', roughness: 0.65, metalness: 0 }
  return <>
    <label className="light-field">名称<input className="llm-input" key={asset.name} defaultValue={asset.name ?? asset.id} maxLength={120} disabled={locked}
      onBlur={event => {
        const name = event.target.value.trim()
        if (name && name !== asset.name) edit.updateAsset(asset.id, { name })
        else if (!name) event.target.value = asset.name ?? asset.id
      }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label>
    <label className="light-field">父级<select className="llm-input" value={asset.parentId ?? ''} disabled={locked} onChange={event => edit.updateAsset(asset.id, { parentId: event.target.value || undefined })}>
      <option value="">根级</option>
      {asset.parentId && !groups.some(group => group.id === asset.parentId) && <option value={asset.parentId}>{tree.byId.get(asset.parentId)?.name ?? asset.parentId}</option>}
      {groups.map(group => <option key={group.id} value={group.id}>{group.name ?? group.id}</option>)}
    </select></label>
    <label className="light-field">场景可见<input type="checkbox" checked={asset.visible !== false} disabled={locked} onChange={event => edit.updateAsset(asset.id, { visible: event.target.checked })} /></label>
    <label className="light-field">锁定对象<input type="checkbox" checked={asset.locked === true} disabled={tree.ancestors(asset).some(parent => parent.locked)}
      onChange={event => edit.updateAsset(asset.id, { locked: event.target.checked })} /></label>
    {!asset.group && !asset.terrain?.surface && <details className="build-material">
      <summary>实例材质</summary>
      <label className="light-field">颜色<input type="color" value={override.color} disabled={locked} onChange={event => edit.updateAsset(asset.id, { materialOverride: { ...override, color: event.target.value } })} /></label>
      {(['roughness', 'metalness'] as const).map(field => <label key={field} className="light-field">
        {field === 'roughness' ? '粗糙度' : '金属度'}
        <input type="number" key={override[field]} defaultValue={override[field]} min={0} max={1} step={0.05} disabled={locked} onBlur={event => {
          const value = event.target.valueAsNumber
          if (Number.isFinite(value) && value >= 0 && value <= 1 && value !== override[field]) {
            edit.updateAsset(asset.id, { materialOverride: { ...override, [field]: value } })
          }
        }} />
      </label>)}
      <button className="btn" disabled={locked || !asset.materialOverride} onClick={() => edit.updateAsset(asset.id, { materialOverride: undefined })}>恢复模型材质</button>
    </details>}
  </>
}

export function LayoutTools() {
  const ids = useSceneStore(state => state.selectedAssetIds)
  const doc = useSceneStore(state => state.document)
  const { viewDirection, interaction, surfaceSnap, preview } = useBuildTools()
  const [open, setOpen] = useState(false)
  const [axis, setAxis] = useState<0 | 1 | 2>(0)
  const [action, setAction] = useState<LayoutAction>('center')
  const [repeat, setRepeat] = useState(3)
  const [spacing, setSpacing] = useState(2)
  const [message, setMessage] = useState('')
  const buildPreview = () => {
    if (!doc) return
    const roots = selectedRoots(doc.assets, ids)
    const tree = assetHierarchy(doc.assets)
    if (roots.some(asset => tree.locked(asset) || tree.descendants(asset.id).some(tree.locked))) {
      setMessage('所选对象或子对象已锁定')
      return
    }
    if (roots.length < (action === 'array' ? 1 : action === 'distribute' ? 3 : 2)) {
      setMessage(action === 'distribute' ? '等距分布至少选择三个独立对象' : '请选择更多独立对象')
      return
    }
    setMessage('')
    const changes: AssetChange[] = []
    if (action === 'array') {
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 64 || !Number.isFinite(spacing) || spacing === 0) {
        setMessage('请输入 1–64 个副本和非零间距')
        return
      }
      const assets = roots.flatMap(asset => [asset, ...tree.descendants(asset.id)])
      if (assets.length * repeat > 1024) { setMessage('请减少副本数或选中的对象'); return }
      const direction = new Vector3().setComponent(axis, spacing)
      if (useEditorStore.getState().space === 'local') direction.applyQuaternion(orientation(roots.at(-1)!.transform.rotation))
      for (let i = 1; i <= repeat; i++) {
        const duplicates = cloneAssets(assets, direction.clone().multiplyScalar(i).toArray())
        for (const asset of duplicates) changes.push({ id: asset.id, after: asset })
      }
    } else {
      const items = roots.map(asset => {
        const bounds = worldBounds(asset, tree.descendants(asset.id))
        return { asset, value: action === 'min' ? bounds.min.getComponent(axis) : action === 'max' ? bounds.max.getComponent(axis) : bounds.getCenter(new Vector3()).getComponent(axis) }
      })
      let target = items.at(-1)!.value
      let step = 0
      if (action === 'distribute') {
        items.sort((a, b) => a.value - b.value)
        target = items[0].value
        step = (items.at(-1)!.value - target) / (items.length - 1)
      }
      items.forEach(({ asset, value }, i) => {
        const delta = target + i * step - value
        if (Math.abs(delta) < 1e-8) return
        const position = [...asset.transform.position] as Vec3
        position[axis] += delta
        const after: Transform = { ...asset.transform, position }
        changes.push({ id: asset.id, after: { ...asset, transform: after } })
        for (const child of tree.descendants(asset.id)) changes.push({ id: child.id, after: { ...child, transform: followTransform(child.transform, asset.transform, after) } })
      })
    }
    if (!changes.length) setMessage('所选对象已在目标位置')
    previewLayout(changes, actions[action])
  }
  return <div className="build-layout-tools">
    <div className="btn-grid g2">
      <label>视角<select className="llm-input" aria-label="搭建视角" value={viewDirection} onChange={event => useBuildTools.setState({ viewDirection: event.target.value as ViewDirection })}>
        {Object.entries(directions).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <button className={interaction === 'box' ? 'active' : ''} onClick={() => { cancelPlacement(); useBuildTools.setState({ interaction: interaction === 'box' ? 'select' : 'box' }) }}>框选</button>
      <button className={surfaceSnap ? 'toggle on' : 'toggle'} onClick={() => useBuildTools.setState({ surfaceSnap: !surfaceSnap })}>表面吸附</button>
      <button onClick={() => setOpen(!open)} aria-expanded={open}>批量布局</button>
    </div>
    {open && <div className="build-terrain">
      <label>操作<select className="llm-input" value={action} onChange={event => setAction(event.target.value as LayoutAction)}>
        {Object.entries(actions).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>{action === 'array' ? '方向轴' : '世界轴'}<select className="llm-input" value={axis} onChange={event => setAxis(Number(event.target.value) as typeof axis)}>
        <option value={0}>X</option><option value={1}>Y</option><option value={2}>Z</option>
      </select></label>
      {action === 'array' && <>
        <label>副本数<input className="llm-input" type="number" min={1} max={64} value={repeat} onChange={event => setRepeat(event.target.valueAsNumber || 0)} /></label>
        <label>间距 (m)<input className="llm-input" type="number" step="any" value={spacing} onChange={event => setSpacing(event.target.valueAsNumber || 0)} /></label>
      </>}
      <button className="btn" onClick={buildPreview}>预览布局</button>
      {message && <span className="error" role="status">{message}</span>}
    </div>}
    {preview && <div className="build-placement">
      <strong>{preview.label} · {preview.changes.length} 个对象</strong>
      <div className="build-actions">
        <button className="btn" disabled={preview.doc !== doc} onClick={confirmLayout}>应用布局</button>
        <button className="btn" onClick={() => useBuildTools.setState({ preview: null })}>取消预览</button>
      </div>
    </div>}
  </div>
}
