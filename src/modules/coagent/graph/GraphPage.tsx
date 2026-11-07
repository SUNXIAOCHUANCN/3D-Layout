/**
 * CoAgent 图可视化页（W10）——独立页面 graph.html。
 *
 * 三块内容：
 * 1. 画布：LangGraph 拓扑（getGraphAsync 导出，不执行节点）+ 运行时节点状态；
 * 2. 详情抽屉：点节点看耗时/错误/关联业务事件；
 * 3. 底部时间轴：最近的节点边界事件，点一条也能定位到节点。
 *
 * 只读投影：本页不发任何业务请求，也不回写主应用。
 * 外观走「制图台」：纸面做节点、墨线做边、朱砂标着正在跑的那个；配色与主应用同步。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CoAgentEventEnvelope } from '../contracts'
import { deriveView, formatEventLine, relatedEvents, str, type VisualState } from './derive'
import { buildFlow, type GraphNodeData } from './toFlow'
import { useGraphFeed } from './useGraphFeed'
import { BrandMark } from '../../../ui/icons'
import { ThemeSwitch } from '../../../ui/ThemeSwitch'
import { useTheme } from '../../../ui/theme'

/** 节点状态 → 类名（颜色全在 graph.css 里，按主题切换） */
const STATE_CLASS: Record<VisualState, string> = {
  idle: 'is-idle',
  running: 'is-running',
  ok: 'is-ok',
  error: 'is-error',
}

function CoAgentNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const visual = data.visual

  if (data.kind !== 'node') {
    return (
      <div className="gp-term">
        {data.kind === 'start' ? (
          <Handle type="source" position={Position.Bottom} className="gp-handle" />
        ) : (
          <Handle type="target" position={Position.Top} className="gp-handle" />
        )}
        {data.kind === 'start' ? 'START' : 'END'}
      </div>
    )
  }

  const label =
    visual.state === 'running'
      ? '执行中…'
      : visual.state === 'ok'
        ? `✓ ${visual.ms ?? 0}ms`
        : visual.state === 'error'
          ? '✗ 失败'
          : '未执行'

  return (
    <div className={`gp-node ${STATE_CLASS[visual.state]}${selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} className="gp-handle" />
      <div className="gp-node-head">
        <span className="gp-node-dot" />
        <span className="gp-node-title" title={data.label}>
          {data.label}
        </span>
      </div>
      <div className="gp-node-foot">
        <span>{label}</span>
        {visual.substep ? <span className="gp-node-sub">· {visual.substep}</span> : null}
      </div>
      <Handle type="source" position={Position.Bottom} className="gp-handle" />
    </div>
  )
}

const nodeTypes = { coagent: CoAgentNode }

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1)
}

function off(e: CoAgentEventEnvelope, startedAt: number | null): string {
  const t = Date.parse(e.time)
  if (!Number.isFinite(t) || startedAt === null) return ''
  return `+${((t - startedAt) / 1000).toFixed(2)}s`
}

/**
 * 从 CSS 变量里取实际色值：边的描边与网格点要的是具体颜色
 * （SVG 的 marker 用呈现属性，吃不了 var()），主题一换就重取。
 */
function useFlowColors(): { edge: string; edgeConditional: string; grid: string } {
  const theme = useTheme()
  return useMemo(() => {
    const style = typeof window === 'undefined' ? null : getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string): string => style?.getPropertyValue(name).trim() || fallback
    return {
      edge: read('--rule-2', '#3d4654'),
      edgeConditional: read('--ink-3', '#6b7280'),
      grid: read('--grid', '#1b222b'),
    }
    // theme 变化时重取（此时 data-theme 已经落位）
  }, [theme])
}

function Header(props: {
  runId: string | null
  connected: boolean
  label: string
  tone: 'idle' | 'running' | 'ok' | 'error'
  activeCount: number
  elapsedMs: number
  nodeCount: number
  edgeCount: number
  follow: boolean
  onToggleFollow: () => void
  onFit: () => void
}) {
  return (
    <header className="gp-bar">
      <span className="gp-brand">
        <BrandMark size={14} />
        <span className="gp-brand-name">COAGENT</span>
      </span>
      <span className="vrule" />
      <span className="gp-title">图视图</span>
      <span className="sheet-meta">
        LANGGRAPH / {props.nodeCount}N · {props.edgeCount}E
      </span>

      <span className={`gp-phase is-${props.tone}`}>
        <span className="gp-phase-dot" />
        {props.label}
      </span>
      {props.activeCount > 0 ? <span className="gp-active">{props.activeCount} 并行</span> : null}

      {props.elapsedMs > 0 ? (
        <span className="readout" title="本轮已用时">
          <b>{seconds(props.elapsedMs)}</b>
          <i>s</i>
        </span>
      ) : null}

      <span className="spacer" />

      <span className={`gp-link${props.connected ? ' on' : ''}`} title={props.connected ? '已收到主应用广播' : '等待主应用广播'}>
        <span className="gp-link-dot" />
        {props.connected ? '已连接主应用' : '等待主应用'}
      </span>
      <span className="gp-runid" title={props.runId ?? '本轮 runId'}>
        {props.runId ?? '—'}
      </span>
      <button type="button" className={`btn${props.follow ? ' is-on' : ''}`} onClick={props.onToggleFollow} title="视图自动跟到正在跑的节点">
        跟随当前节点
      </button>
      <button type="button" className="btn" onClick={props.onFit} title="缩放到看得见整张图">
        适应窗口
      </button>
      <ThemeSwitch />
    </header>
  )
}

function Drawer(props: { node: string; events: CoAgentEventEnvelope[]; startedAt: number | null; onClose: () => void }) {
  const view = useMemo(() => deriveView(props.events, null), [props.events])
  const visual = view.visuals.get(props.node) ?? { state: 'idle' as const }
  const related = useMemo(() => relatedEvents(props.events, props.node), [props.events, props.node])
  const lastNodeEvent = [...props.events].reverse().find(e => str(e.payload.node) === props.node && e.type === 'node.finished')
  const message = visual.message ?? str(lastNodeEvent?.payload.message)

  return (
    <aside className="gp-drawer">
      <div className="gp-drawer-head">
        <span className="gp-drawer-title" title={props.node}>
          {props.node}
        </span>
        <button type="button" className="btn" onClick={props.onClose}>
          关闭
        </button>
      </div>

      <dl className="gp-kv">
        <dt>状态</dt>
        <dd>
          {visual.state === 'running' ? '执行中' : visual.state === 'ok' ? '已完成' : visual.state === 'error' ? '失败' : '未执行'}
        </dd>
        {visual.ms !== undefined ? (
          <>
            <dt>耗时</dt>
            <dd className="mono">{visual.ms} ms</dd>
          </>
        ) : null}
        {visual.substep ? (
          <>
            <dt>子步骤</dt>
            <dd className="mono">{visual.substep}</dd>
          </>
        ) : null}
        {message ? (
          <>
            <dt>错误</dt>
            <dd className="is-error">{message}</dd>
          </>
        ) : null}
      </dl>

      <div className="gp-subhead">相关事件 · {related.length}</div>
      <div className="gp-events">
        {related.length === 0 ? (
          <span className="gp-events-empty">（无）</span>
        ) : (
          related.map(e => <div key={e.eventSeq}>{formatEventLine(e)}</div>)
        )}
      </div>
    </aside>
  )
}

function GraphView() {
  const feed = useGraphFeed()
  const view = useMemo(() => deriveView(feed.events, feed.outcome), [feed.events, feed.outcome])
  const topo = feed.topologies.main
  const colors = useFlowColors()
  const { nodes, edges } = useMemo(() => buildFlow(topo, view.visuals, colors), [topo, view.visuals, colors])
  const [selected, setSelected] = useState<string | null>(null)
  // 默认关：先给"整张图"的全景（找得到上下文）；想看"当前在哪"再点右上角跟随
  const [follow, setFollow] = useState(false)
  const followRef = useRef(follow)
  followRef.current = follow
  const { fitView } = useReactFlow()
  const now = useNow(view.phase.tone === 'running')
  const activeKey = view.active.join('|')

  const fit = () => {
    void fitView({ duration: 300, padding: 0.2 })
  }

  useEffect(() => {
    if (!followRef.current) return
    const known = new Set(nodes.map(n => n.id))
    const targets = activeKey.split('|').filter(id => id && known.has(id))
    if (targets.length === 0) return
    // padding 留大一点 + 限制最大缩放：并行 3~4 个节点时不至于把上下文裁掉
    void fitView({ nodes: targets.map(id => ({ id })), duration: 400, padding: 0.6, maxZoom: 1 })
  }, [activeKey, fitView, nodes])

  const timeline = useMemo(
    () => feed.events.filter(e => e.type === 'node.started' || e.type === 'node.finished').slice(-12),
    [feed.events],
  )

  const elapsedMs = view.startedAt ? Math.max(0, (view.lastAt ?? now) - view.startedAt) : 0

  return (
    <div className="gp">
      <Header
        runId={feed.runId}
        connected={feed.connected}
        label={view.phase.label}
        tone={view.phase.tone}
        activeCount={view.active.length}
        elapsedMs={elapsedMs}
        nodeCount={nodes.length}
        edgeCount={edges.length}
        follow={follow}
        onToggleFollow={() => setFollow(v => !v)}
        onFit={fit}
      />

      <div className="gp-canvas">
        <ReactFlow
          className="gp-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.15}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => setSelected(node.id)}
          onPaneClick={() => setSelected(null)}
        >
          <Background gap={18} size={1} color={colors.grid} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {nodes.length === 0 ? (
          <div className="gp-empty">
            <div className="gp-empty-title">等待 CoAgent 运行…</div>
            <div className="gp-empty-note">在主应用里点「开始」，图拓扑会实时出现在这里（本轮结束前不会消失）</div>
          </div>
        ) : null}

        {selected ? (
          <Drawer node={selected} events={feed.events} startedAt={view.startedAt} onClose={() => setSelected(null)} />
        ) : null}
      </div>

      <div className="gp-timeline">
        <div className="gp-timeline-head">
          <span className="sheet-meta">时间轴 / 节点边界 · 最近 12 条</span>
        </div>
        {timeline.length === 0 ? (
          <div className="gp-timeline-empty">（还没有节点事件）</div>
        ) : (
          timeline.map(e => {
            const node = str(e.payload.node)
            const running = e.type === 'node.started'
            const failed = !running && e.payload.status === 'error'
            const cls = `gp-tl-row${node ? ' is-clickable' : ''}${running ? ' is-running' : failed ? ' is-error' : ' is-ok'}`
            return (
              <div
                key={e.eventSeq}
                className={cls}
                onClick={() => (node ? setSelected(node) : undefined)}
              >
                <span className="gp-tl-off">{off(e, view.startedAt)}</span>
                <span className="gp-tl-name">
                  {running ? '▸ ' : failed ? '✗ ' : '✓ '}
                  {node}
                  {!running && typeof e.payload.ms === 'number' ? ` · ${e.payload.ms}ms` : ''}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

export function GraphPage() {
  return (
    <ReactFlowProvider>
      <GraphView />
    </ReactFlowProvider>
  )
}
