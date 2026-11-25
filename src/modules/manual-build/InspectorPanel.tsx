import { edit } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import type { SceneLight, Vec3 } from '../../core/types'
import { LIGHT_NAMES } from './ops'
import { TerrainFields } from './terrain'
import { assetHierarchy } from '../../core/assetHierarchy'
import { EditableAssetProperties } from './LayoutTools'
import { NumberField } from './NumberField'

const AXES = [0, 1, 2] as const

function VectorField({ label, value, step, onCommit }: {
  label: string
  value: Vec3
  step: number
  onCommit: (value: Vec3) => void
}) {
  return (
    <div className="vec-row" role="group" aria-label={label}>
      <span className="vec-label">{label}</span>
      {AXES.map(axis => (
        <label className="vec-cell" key={axis}>
          <span className={`ax ax-${'xyz'[axis]}`}>{'XYZ'[axis]}</span>
          <NumberField value={value[axis]} step={step} onCommit={next => {
            const vector: Vec3 = [...value]
            vector[axis] = next
            onCommit(vector)
          }} />
        </label>
      ))}
    </div>
  )
}

function LightInspector({ light }: { light: SceneLight }) {
  return (
    <aside className="inspector">
      <div className="inspector-head">{light.name ?? LIGHT_NAMES[light.type]}</div>
      <div className="inspector-sub" title={light.id}>{LIGHT_NAMES[light.type]} · {light.id}</div>
      <div className="inspector-body">
        <VectorField label="位置(m)" value={light.position} step={0.1} onCommit={position => edit.updateLight(light.id, { position })} />
        {light.type === 'spot' && (
          <VectorField label="旋转(°)" value={light.rotation} step={1} onCommit={rotation => edit.updateLight(light.id, { rotation })} />
        )}
        <label className="light-field">
          启用
          <input type="checkbox" checked={light.enabled !== false} onChange={event => edit.updateLight(light.id, { enabled: event.target.checked })} />
        </label>
        <label className="light-field">
          颜色
          <input type="color" value={light.color} onChange={event => edit.updateLight(light.id, { color: event.currentTarget.value })} />
        </label>
        <label className="light-field">
          强度(cd)
          <NumberField value={light.intensity} step={1} min={0} onCommit={intensity => edit.updateLight(light.id, { intensity })} />
        </label>
        <label className="light-field" title="填 0 表示不限距离">
          距离(m)
          <NumberField value={light.distance} step={0.1} min={0} onCommit={distance => edit.updateLight(light.id, { distance })} />
        </label>
        {light.type === 'spot' && (
          <label className="light-field">
            锥半角(°)
            <NumberField value={light.angle} step={1} min={0} max={90} onCommit={angle => edit.updateLight(light.id, { angle })} />
          </label>
        )}
      </div>
    </aside>
  )
}

export function InspectorPanel() {
  const light = useSceneStore(s => s.document?.lights?.find(item => item.id === s.selectedLightId))
  const asset = useSceneStore(s => s.document?.assets.find(item => item.id === s.selectedAssetId))
  const assets = useSceneStore(s => s.document?.assets)
  const selected = useSceneStore(s => s.selectedAssetIds)
  const modelName = useSceneStore(s => asset ? s.manifest?.models[asset.ref]?.name : undefined)

  if (light) return <LightInspector key={light.id} light={light} />
  if (selected.length > 1) return <aside className="inspector"><div className="inspector-head">已选中 {selected.length} 个对象</div>
    <div className="inspector-empty">使用视口手柄整体移动、旋转或等比缩放。</div></aside>
  if (!asset) {
    return (
      <aside className="inspector">
        <div className="inspector-head">属性</div>
        <div className="inspector-empty">选择对象查看与编辑属性</div>
      </aside>
    )
  }

  const { id, transform } = asset
  const tree = assetHierarchy(assets ?? [])
  const locked = tree.locked(asset)
  const transformLocked = locked || tree.descendants(asset.id).some(tree.locked)
  return (
    <aside className="inspector" key={id}>
      <div className="inspector-head">{asset.name ?? id}</div>
      <div className="inspector-sub">{modelName ?? asset.ref} · {id}</div>
      <div className="inspector-body">
        <EditableAssetProperties asset={asset} locked={locked} />
        {asset.terrain && <TerrainFields asset={{ ...asset, terrain: asset.terrain }} disabled={locked} />}
        <fieldset className="build-fields" disabled={transformLocked}>
        <VectorField label="位置(m)" value={transform.position} step={0.1} onCommit={position => edit.setTransform(id, { ...transform, position })} />
        <VectorField label="旋转(°)" value={transform.rotation} step={1} onCommit={rotation => edit.setTransform(id, { ...transform, rotation })} />
        <VectorField label="缩放" value={transform.scale ?? [1, 1, 1]} step={0.05} onCommit={scale => {
          if (scale.some(value => value === 0)) return
          if (asset.group) {
            const before = transform.scale ?? [1, 1, 1]
            const axis = scale.findIndex((value, i) => value !== before[i])
            const factor = scale[axis] / before[axis]
            if (Number.isFinite(factor) && factor > 0) edit.setTransform(id, { ...transform, scale: before.map(value => value * factor) as Vec3 })
          } else edit.setTransform(id, { ...transform, scale })
        }} />
        </fieldset>
      </div>
    </aside>
  )
}
