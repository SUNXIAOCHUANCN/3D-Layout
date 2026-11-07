import type { CSSProperties, ReactNode } from 'react'

export interface PluginSlot {
  id: string
  name: string
  description?: string
  enabled: boolean
  onToggle: () => void
  /** 插件启用时渲染的面板 UI */
  panel?: ReactNode
}

/**
 * 左侧插件侧边栏（外壳常驻，不随插件卸载，可收起成细条，可拖拽调宽）。
 * 每个插件一行：序号 + 名称/一句说明 + 机械式开关；启用时其面板展开在本行下方。
 * 插件全部关闭时侧边栏仍在——这是重新开启插件的入口。
 */
export function Sidebar(props: {
  plugins: PluginSlot[]
  collapsed: boolean
  onToggle: () => void
  /** 宽度由 App 持有（拖拽手柄在外侧），这里只透传 */
  style?: CSSProperties
}) {
  if (props.collapsed) {
    return (
      <button className="rail rail-left" onClick={props.onToggle} title="展开插件栏">
        插件 »
      </button>
    )
  }
  return (
    <aside className="sidebar" style={props.style}>
      <div className="sheet-head">
        <span className="sheet-title">插件</span>
        <span className="sheet-meta">PLUG-INS / {String(props.plugins.length).padStart(2, '0')}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={props.onToggle} title="收起插件栏" aria-label="收起插件栏">
          «
        </button>
      </div>
      {props.plugins.map((p, i) => (
        <section className="plugin-section" key={p.id}>
          <div className="plugin-row">
            <span className="plugin-idx">{String(i + 1).padStart(2, '0')}</span>
            <div className="plugin-info">
              <span className="plugin-name">{p.name}</span>
              {p.description && <span className="plugin-desc">{p.description}</span>}
            </div>
            <button
              className={`switch${p.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={p.enabled}
              aria-label={`${p.name}开关`}
              title={p.enabled ? '已启用，点击停用' : '已停用，点击启用'}
              onClick={p.onToggle}
            />
          </div>
          {p.enabled && p.panel && <div className="plugin-body">{p.panel}</div>}
        </section>
      ))}
    </aside>
  )
}
