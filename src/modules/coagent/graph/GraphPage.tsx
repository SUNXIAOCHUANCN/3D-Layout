/**
 * CoAgent 图可视化页（W10）——独立页面 graph.html。
 *
 * 三块内容：
 * 1. 画布：LangGraph 拓扑（getGraphAsync 导出，不执行节点）+ 运行时节点状态；
 * 2. 详情抽屉：点节点看耗时/错误/关联业务事件；
 * 3. 底部时间轴：最近的节点边界事件，点一条也能定位到节点。
 *
 * 只读投影：本页不发任何业务请求，也不回写主应用。
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

const TONE: Record<VisualState, { border: string; dot: string; text: string; bg: string }> = {
  idle: { border: '#2d333b', dot: '#586069', text: '#9aa4b2', bg: '#161b22' },
  running: { border: '#4c8dff', dot: '#4c8dff', text: '#dbe9ff', bg: '#16202e' },
  ok: { border: '#2ea043', dot: '#3fb950', text: '#d7f5dd', bg: '#131c15' },
  error: { border: '#f85149', dot: '#f85149', text: '#ffd7d5', bg: '#211314' },
}

function CoAgentNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const visual = data.visual
  const tone = TONE[visual.state]

  if (data.kind !== 'node') {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px dashed ${tone.border}`,
          borderRadius: 999,
          color: '#8b949e',
          fontSize: 11,
          background: 'transparent',
        }}
      >
        {data.kind === 'start' ? '▶ start' : '■ end'}
        {data.kind === 'start' ? (
          <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        ) : (
          <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
        )}
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
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: '6px 10px',
        border: `1.5px solid ${selected ? '#79c0ff' : tone.border}`,
        borderRadius: 8,
        background: tone.bg,
        animation: visual.state === 'running' ? 'coagent-pulse 1.6s ease-in-out infinite' : undefined,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 16 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: tone.dot, flex: '0 0 auto' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: tone.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {data.label}
        </span>
      </div>
      <div style={{ fontSize: 10, color: '#8b949e', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
        {visual.substep ? ` · ${visual.substep}` : ''}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
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
  return `${(ms / 1000).toFixed(1)}s`
}

function off(e: CoAgentEventEnvelope, startedAt: number | null): string {
  const t = Date.parse(e.time)
  if (!Number.isFinite(t) || startedAt === null) return ''
  return `+${((t - startedAt) / 1000).toFixed(2)}s`
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
  const toneColor = TONE[props.tone === 'idle' ? 'idle' : props.tone === 'running' ? 'running' : props.tone === 'ok' ? 'ok' : 'error']
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderBottom: '1px solid #21262d',
        background: '#0d1117',
        flex: '0 0 auto',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>CoAgent 图视图</div>
      <span
        style={{
          fontSize: 11,
          padding: '2px 8px',
          borderRadius: 999,
          border: `1px solid ${toneColor.border}`,
          color: toneColor.text,
          background: toneColor.bg,
        }}
      >
        {props.label}
      </span>
      {props.activeCount > 0 ? (
        <span style={{ fontSize: 11, color: '#79c0ff' }}>{props.activeCount} 个节点并行</span>
      ) : null}
      <span style={{ fontSize: 11, color: '#8b949e' }}>
        {props.nodeCount} 节点 / {props.edgeCount} 边
        {props.elapsedMs > 0 ? ` · ${seconds(props.elapsedMs)}` : ''}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: props.connected ? '#3fb950' : '#8b949e' }}>
        {props.connected ? '● 已连接主应用' : '○ 等待主应用'}
      </span>
      <span style={{ fontSize: 11, color: '#586069', fontFamily: 'ui-monospace, Consolas, monospace' }}>{props.runId ?? '—'}</span>
      <button type="button" onClick={props.onToggleFollow} style={btn(props.follow)}>
        跟随当前节点
      </button>
      <button type="button" onClick={props.onFit} style={btn(false)}>
        适应窗口
      </button>
    </div>
  )
}

function btn(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '3px 8px',
    borderRadius: 6,
    cursor: 'pointer',
    border: `1px solid ${active ? '#4c8dff' : '#30363d'}`,
    background: active ? '#16202e' : '#161b22',
    color: active ? '#79c0ff' : '#8b949e',
  }
}

function Drawer(props: { node: string; events: CoAgentEventEnvelope[]; startedAt: number | null; onClose: () => void }) {
  const view = useMemo(() => deriveView(props.events, null), [props.events])
  const visual = view.visuals.get(props.node) ?? { state: 'idle' as const }
  const related = useMemo(() => relatedEvents(props.events, props.node), [props.events, props.node])
  const lastNodeEvent = [...props.events].reverse().find(e => str(e.payload.node) === props.node && e.type === 'node.finished')
  const message = visual.message ?? str(lastNodeEvent?.payload.message)

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 320,
        background: '#0d1117',
        borderLeft: '1px solid #21262d',
        padding: 12,
        overflowY: 'auto',
        fontSize: 12,
        zIndex: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3', flex: 1 }}>{props.node}</span>
        <button type="button" onClick={props.onClose} style={btn(false)}>
          关闭
        </button>
      </div>
      <div style={{ marginTop: 8, color: '#8b949e', lineHeight: 1.7 }}>
        <div>状态：{visual.state === 'running' ? '执行中' : visual.state === 'ok' ? '已完成' : visual.state === 'error' ? '失败' : '未执行'}</div>
        {visual.ms !== undefined ? <div>耗时：{visual.ms}ms</div> : null}
        {visual.substep ? <div>子步骤：{visual.substep}</div> : null}
        {message ? <div style={{ color: '#ff9c96' }}>错误：{message}</div> : null}
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: '#6e7681' }}>相关事件（最近 {related.length} 条）</div>
      <div style={{ marginTop: 4, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 10.5, lineHeight: 1.6, color: '#9aa4b2' }}>
        {related.length === 0 ? <div>（无）</div> : related.map(e => <div key={e.eventSeq}>{formatEventLine(e)}</div>)}
      </div>
    </div>
  )
}

function GraphView() {
  const feed = useGraphFeed()
  const view = useMemo(() => deriveView(feed.events, feed.outcome), [feed.events, feed.outcome])
  const topo = feed.topologies.main
  const { nodes, edges } = useMemo(() => buildFlow(topo, view.visuals), [topo, view.visuals])
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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

      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
        <ReactFlow
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
          style={{ background: '#0f1319' }}
        >
          <Background gap={18} color="#1b222b" />
          <Controls showInteractive={false} />
        </ReactFlow>

        {nodes.length === 0 ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 6,
              pointerEvents: 'none',
              color: '#586069',
              fontSize: 12,
            }}
          >
            <div style={{ fontSize: 14, color: '#8b949e' }}>等待 CoAgent 运行…</div>
            <div>在主应用里点「开始」，图拓扑会实时出现在这里（本轮结束前不会消失）</div>
          </div>
        ) : null}

        {selected ? (
          <Drawer node={selected} events={feed.events} startedAt={view.startedAt} onClose={() => setSelected(null)} />
        ) : null}
      </div>

      <div style={{ flex: '0 0 auto', borderTop: '1px solid #21262d', background: '#0d1117', padding: '6px 12px', maxHeight: 132, overflowY: 'auto' }}>
        <div style={{ fontSize: 10.5, color: '#6e7681', marginBottom: 2 }}>时间轴（节点边界，最近 12 条）</div>
        {timeline.length === 0 ? (
          <div style={{ fontSize: 11, color: '#484f58' }}>（还没有节点事件）</div>
        ) : (
          timeline.map(e => {
            const node = str(e.payload.node)
            const running = e.type === 'node.started'
            return (
              <div
                key={e.eventSeq}
                onClick={() => setSelected(node)}
                style={{
                  fontSize: 11,
                  fontFamily: 'ui-monospace, Consolas, monospace',
                  lineHeight: 1.65,
                  color: running ? '#79c0ff' : '#9aa4b2',
                  cursor: node ? 'pointer' : 'default',
                }}
              >
                <span style={{ color: '#484f58', display: 'inline-block', width: 62 }}>{off(e, view.startedAt)}</span>
                {running ? '▸ ' : e.payload.status === 'error' ? '✗ ' : '✓ '}
                {node}
                {!running && typeof e.payload.ms === 'number' ? ` ${e.payload.ms}ms` : ''}
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
