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
 * 每个插件一行：名称 + 开关；启用时其面板 UI 展开在本行下方。
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
      <div className="sidebar-head row">
        <span>插件</span>
        <button className="collapse-btn" onClick={props.onToggle} title="收起">
          «
        </button>
      </div>
      {props.plugins.map(p => (
        <section className="plugin-section" key={p.id}>
          <div className="plugin-row">
            <div className="plugin-info">
              <span className="plugin-name">{p.name}</span>
              {p.description && <span className="plugin-desc">{p.description}</span>}
            </div>
            <button
              className={`switch${p.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={p.enabled}
              aria-label={`${p.name} 开关`}
              onClick={p.onToggle}
            >
              {p.enabled ? '开' : '关'}
            </button>
          </div>
          {p.enabled && p.panel}
        </section>
      ))}
    </aside>
  )
}
