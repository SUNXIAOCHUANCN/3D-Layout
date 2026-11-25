import { useState } from 'react'
import { edit } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import type { SceneLight, Vec3 } from '../../core/types'
import { LIGHT_NAMES } from './ops'

interface NumberFieldProps {
  value: number
  step: number
  min?: number
  max?: number
  onCommit: (value: number) => void
}

function NumberField({ value, step, min, max, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={draft ?? value}
      onChange={event => setDraft(event.target.value)}
      onBlur={event => {
        setDraft(null)
        const next = event.currentTarget.valueAsNumber
        if (Number.isFinite(next) && next !== value && next >= (min ?? -Infinity) && next <= (max ?? Infinity)) {
          onCommit(next)
        }
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

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
  const modelName = useSceneStore(s => asset ? s.manifest?.models[asset.ref]?.name : undefined)

  if (light) return <LightInspector key={light.id} light={light} />
  if (!asset) {
    return (
      <aside className="inspector">
        <div className="inspector-head">属性</div>
        <div className="inspector-empty">选择对象查看与编辑属性</div>
      </aside>
    )
  }

  const { id, transform } = asset
  return (
    <aside className="inspector" key={id}>
      <div className="inspector-head">{asset.name ?? id}</div>
      <div className="inspector-sub">{modelName ?? asset.ref} · {id}</div>
      <div className="inspector-body">
        <VectorField label="位置(m)" value={transform.position} step={0.1} onCommit={position => edit.setTransform(id, { ...transform, position })} />
        <VectorField label="旋转(°)" value={transform.rotation} step={1} onCommit={rotation => edit.setTransform(id, { ...transform, rotation })} />
        <VectorField label="缩放" value={transform.scale ?? [1, 1, 1]} step={0.05} onCommit={scale => {
          if (scale.every(value => value !== 0)) edit.setTransform(id, { ...transform, scale })
        }} />
      </div>
    </aside>
  )
}
