/**
 * 拓扑 → React Flow 图元（W10）。
 *
 * 只做两件事：dagre 分层布局 + 把 node/edge 数据映射成 React Flow 的 nodes/edges。
 * 条件边在 LangGraph 里是 router（静态图只能表达"候选"），所以画成虚线 + 动画。
 */

import dagre from '@dagrejs/dagre'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { TopologyGraph } from '../workflow/state'
import type { NodeVisual } from './derive'

export type NodeKind = 'node' | 'start' | 'end'

/** React Flow 要求 data 可赋给 Record<string, unknown>，所以用 type 而非 interface */
export type GraphNodeData = {
  label: string
  kind: NodeKind
  visual: NodeVisual
}

export const NODE_W = 184
export const NODE_H = 46
const TERM_W = 104
const TERM_H = 28

const TERMINAL: Record<string, NodeKind> = { __start__: 'start', __end__: 'end' }

function sizeOf(kind: NodeKind): { w: number; h: number } {
  return kind === 'node' ? { w: NODE_W, h: NODE_H } : { w: TERM_W, h: TERM_H }
}

export function buildFlow(
  topo: TopologyGraph | undefined,
  visuals: Map<string, NodeVisual>,
): { nodes: Array<Node<GraphNodeData>>; edges: Edge[] } {
  if (!topo || topo.nodes.length === 0) return { nodes: [], edges: [] }

  const layout = new dagre.graphlib.Graph()
  layout.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 56, marginx: 24, marginy: 24 })
  layout.setDefaultEdgeLabel(() => ({}))

  const kinds = new Map<string, NodeKind>()
  for (const n of topo.nodes) {
    const kind = TERMINAL[n.id] ?? 'node'
    kinds.set(n.id, kind)
    const { w, h } = sizeOf(kind)
    layout.setNode(n.id, { width: w, height: h })
  }
  for (const e of topo.edges) {
    if (e.source === e.target) continue // 自环不进布局（主图没有；子图另画）
    if (!kinds.has(e.source) || !kinds.has(e.target)) continue
    layout.setEdge(e.source, e.target)
  }
  dagre.layout(layout)

  const nodes: Array<Node<GraphNodeData>> = topo.nodes.map(n => {
    const kind = kinds.get(n.id) ?? 'node'
    const { w, h } = sizeOf(kind)
    const point = layout.node(n.id) as { x?: number; y?: number } | undefined
    return {
      id: n.id,
      type: 'coagent',
      position: { x: (point?.x ?? 0) - w / 2, y: (point?.y ?? 0) - h / 2 },
      data: { label: n.id === '__start__' ? 'start' : n.id === '__end__' ? 'end' : n.name, kind, visual: visuals.get(n.id) ?? { state: 'idle' } },
      style: { width: w, height: h },
      draggable: false,
      selectable: true,
    }
  })

  const seen = new Set<string>()
  const edges: Edge[] = []
  for (const e of topo.edges) {
    if (e.source === e.target) continue
    const key = `${e.source}->${e.target}`
    if (seen.has(key) || !kinds.has(e.source) || !kinds.has(e.target)) continue
    seen.add(key)
    edges.push({
      id: key,
      source: e.source,
      target: e.target,
      animated: !!e.conditional,
      style: e.conditional ? { stroke: '#6b7280', strokeDasharray: '5 4' } : { stroke: '#3d4654' },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: e.conditional ? '#6b7280' : '#3d4654' },
    })
  }

  return { nodes, edges }
}
