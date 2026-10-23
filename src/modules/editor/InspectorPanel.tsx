import { useEffect, useState } from 'react'
import { edit } from '../../core/edit'
import { useSceneStore } from '../../core/store'
import type { Vec3 } from '../../core/types'

interface LocalTransform {
  p: Vec3
  r: Vec3
  s: Vec3
}

type Kind = 'p' | 'r' | 's'
const AXIS: [0, 1, 2] = [0, 1, 2]

/**
 * 数值面板（Inspector，装配点②：DOM 侧）。
 * 显示选中资产的 Position/Rotation(°)/Scale，数值可输入（回车或失焦提交）；
 * gizmo 拖拽时数值实时反向同步，但不覆盖正在输入的格子。
 * 所有修改走 edit（唯一入口，自动进历史）。
 */
export function InspectorPanel() {
  const asset = useSceneStore(s =>
    s.selectedAssetId ? s.document?.assets.find(a => a.id === s.selectedAssetId) : undefined,
  )
  const modelName = useSceneStore(s => (asset ? s.manifest?.models[asset.ref]?.name : undefined))
  const [focused, setFocused] = useState<string | null>(null)
  const [local, setLocal] = useState<LocalTransform | null>(null)

  useEffect(() => {
    if (!asset) {
      setLocal(null)
      return
    }
    const t = asset.transform
    setLocal(prev => {
      const next: LocalTransform = {
        p: [...t.position] as Vec3,
        r: [...t.rotation] as Vec3,
        s: [...(t.scale ?? [1, 1, 1])] as Vec3,
      }
      if (!prev || !focused) return next
      // 有格子正在输入时，保留该组三个格子的本地值
      if (focused[0] === 'p') next.p = prev.p
      if (focused[0] === 'r') next.r = prev.r
      if (focused[0] === 's') next.s = prev.s
      return next
    })
  }, [asset?.transform, focused])

  if (!asset || !local) {
    return (
      <aside className="inspector">
        <div className="inspector-head">属性</div>
        <div className="inspector-empty">左键点击资产查看与编辑</div>
      </aside>
    )
  }

  const commit = () => {
    const cur = asset.transform
    const eq = (a: readonly number[], b: readonly number[]) =>
      a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
    if (eq(cur.position, local.p) && eq(cur.rotation, local.r) && eq(cur.scale ?? [1, 1, 1], local.s))
      return
    edit.setTransform(
      asset.id,
      { position: [...local.p], rotation: [...local.r], scale: [...local.s] },
      { source: 'human' },
    )
  }

  const field = (kind: Kind, axis: 0 | 1 | 2) => ({
    type: 'number' as const,
    step: kind === 'r' ? 1 : kind === 's' ? 0.05 : 0.1,
    value: kind === 'p' ? local.p[axis] : kind === 'r' ? local.r[axis] : local.s[axis],
    onFocus: () => setFocused(`${kind}-${axis}`),
    onBlur: () => {
      setFocused(null)
      commit()
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value)
      if (Number.isNaN(v)) return
      setLocal(l => {
        if (!l) return l
        const next: LocalTransform = { p: [...l.p], r: [...l.r], s: [...l.s] }
        if (kind === 'p') next.p[axis] = v
        else if (kind === 'r') next.r[axis] = v
        else next.s[axis] = v
        return next
      })
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    },
  })

  const row = (kind: Kind, label: string, unit?: string) => (
    <div className="vec-row">
      <span className="vec-label">
        {label}
        {unit ? `(${unit})` : ''}
      </span>
      {AXIS.map(axis => (
        <label className="vec-cell" key={axis}>
          <span className={`ax ax-${'xyz'[axis]}`}>{'XYZ'[axis]}</span>
          <input {...field(kind, axis)} />
        </label>
      ))}
    </div>
  )

  return (
    <aside className="inspector">
      <div className="inspector-head">{asset.name ?? asset.id}</div>
      <div className="inspector-sub">
        {modelName ?? asset.ref} · {asset.id}
      </div>
      <div className="inspector-body">
        {row('p', '位置', 'm')}
        {row('r', '旋转', '°')}
        {row('s', '缩放')}
      </div>
    </aside>
  )
}
