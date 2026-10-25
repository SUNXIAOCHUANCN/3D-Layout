/**
 * graphFeed —— 图可视化页的数据出口（W10）。
 *
 * 为什么走浏览器原生通道：图视图是**独立页面**（graph.html），与主应用是两个标签页，
 * 同一个 origin。BroadcastChannel 直连即可，不需要 WebSocket、不需要加 vite 中间件，
 * 生产静态托管也能用；再叠一层 localStorage 快照，让"后开的页面 / 关掉再开"仍能看到
 * 上一轮的图与事件。
 *
 * 三条约束（与 runLog/recorder 同款口径）：
 * 1. 只读投影：feed 不参与任何业务决策，图页也永远不回写；
 * 2. 失败不影响运行：通道不可用、localStorage 超配额、拓扑导出失败，全部吞掉；
 * 3. 不新开第二条状态源：事件来自 recorder（唯一事件源），拓扑来自 getGraphAsync（唯一图源）。
 */

import type { CoAgentEventEnvelope, CoAgentEventType } from './contracts'
import type { RawTopologyGraph, TopologyGraph } from './workflow/state'

/** 通道名 / 快照键：图页与主应用必须一致（图页直接 import 这两个常量） */
export const GRAPH_FEED_CHANNEL = 'coagent-graph-v1'
export const GRAPH_FEED_STORAGE_KEY = 'coagent.graph.v1.last'

/** 内存里最多留多少条事件（回 `hello` 时整包给图页） */
const MAX_EVENTS = 800
/** 落 localStorage 的事件条数（够还原上一轮，又不至于撑爆配额） */
const STORAGE_EVENTS = 300
/** 落盘去抖 */
const PERSIST_DEBOUNCE_MS = 400

const TERMINAL: ReadonlySet<CoAgentEventType> = new Set<CoAgentEventType>([
  'run.committed',
  'run.rolled_back',
  'run.failed',
])

export type FeedMsg =
  | { kind: 'topology'; graphId: string; topo: TopologyGraph }
  | { kind: 'events'; runId: string; events: CoAgentEventEnvelope[] }
  | { kind: 'run.end'; runId: string; outcome: string }
  | { kind: 'hello' }
  | {
      kind: 'snapshot'
      runId: string | null
      topologies: Record<string, TopologyGraph>
      events: CoAgentEventEnvelope[]
      outcome: string | null
    }

export interface GraphFeed {
  /** 每次 recorder 有变化时调用（传入全量事件，内部按 eventSeq 增量切） */
  onEvents(events: readonly CoAgentEventEnvelope[]): void
  /** 拓扑就绪（getGraphAsync 的结果） */
  publishTopology(graphId: string, topo: TopologyGraph): void
  dispose(): void
}

export function createGraphFeed(): GraphFeed {
  let channel: BroadcastChannel | null = null
  try {
    if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(GRAPH_FEED_CHANNEL)
  } catch {
    channel = null // 老环境：只走 localStorage 快照
  }

  let runId: string | null = null
  let outcome: string | null = null
  let lastSeq = 0
  let events: CoAgentEventEnvelope[] = []
  const topologies = new Map<string, TopologyGraph>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const post = (msg: FeedMsg): void => {
    try {
      channel?.postMessage(msg)
    } catch {
      /* 结构化克隆失败等：忽略，绝不影响运行 */
    }
  }

  const snapshot = (): FeedMsg => ({
    kind: 'snapshot',
    runId,
    topologies: Object.fromEntries(topologies),
    events: [...events],
    outcome,
  })

  if (channel) {
    channel.onmessage = ev => {
      const msg = ev.data as FeedMsg | undefined
      if (msg?.kind === 'hello') post(snapshot())
    }
  }

  const persist = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(
          GRAPH_FEED_STORAGE_KEY,
          JSON.stringify({
            runId,
            topologies: Object.fromEntries(topologies),
            events: events.slice(-STORAGE_EVENTS),
            outcome,
            savedAt: Date.now(),
          }),
        )
      } catch {
        /* 超配额 / 隐私模式：忽略 */
      }
    }, PERSIST_DEBOUNCE_MS)
    const t = timer as unknown as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
  }

  return {
    onEvents(all) {
      const fresh = all.filter(e => e.eventSeq > lastSeq)
      if (fresh.length === 0) return
      lastSeq = fresh[fresh.length - 1].eventSeq
      for (const e of fresh) {
        if (e.type === 'run.started') {
          // 新一轮：图与事件都重来（否则会把上一轮的 region-* 节点留在画布上）
          topologies.clear()
          events = []
          runId = e.runId
          outcome = null
        }
        runId = runId ?? e.runId
        events.push(e)
        if (TERMINAL.has(e.type)) {
          outcome = e.type
          runId = e.runId
        }
      }
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS)
      post({ kind: 'events', runId: runId ?? '', events: fresh })
      if (outcome) post({ kind: 'run.end', runId: runId ?? '', outcome })
      persist()
    },

    publishTopology(graphId, topo) {
      topologies.set(graphId, topo)
      post({ kind: 'topology', graphId, topo })
      persist()
    },

    dispose() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      try {
        channel?.close()
      } catch {
        /* noop */
      }
      channel = null
    },
  }
}

// ---------- 模块级活跃句柄（与 runLog 同款：没有 handle 时全部 no-op） ----------

let active: GraphFeed | null = null

export function beginGraphFeed(): GraphFeed {
  active ??= createGraphFeed()
  return active
}

export function disposeGraphFeed(): void {
  active?.dispose()
  active = null
}

/**
 * 把 compiled 图的拓扑广播给图页。
 *
 * `getGraphAsync()` 只读结构、不执行任何节点；节点 data 里是 Runnable 对象（不可克隆），
 * 所以这里只保留 id / name 与边的三条信息。
 */
export async function publishGraphTopology(
  graphId: string,
  compiled: { getGraphAsync(config?: { xray?: boolean | number }): Promise<RawTopologyGraph> },
): Promise<void> {
  const feed = active
  if (!feed) return
  try {
    const g = await compiled.getGraphAsync()
    const nodes = Object.entries(g?.nodes ?? {}).map(([id, n]) => ({
      id: String(n?.id ?? id),
      name: String(n?.name ?? n?.id ?? id),
    }))
    if (nodes.length === 0) return
    const known = new Set(nodes.map(n => n.id))
    const edges = (g?.edges ?? [])
      .map(e => ({ source: String(e.source ?? ''), target: String(e.target ?? ''), conditional: !!e.conditional }))
      .filter(e => known.has(e.source) && known.has(e.target))
      .map(e => ({ source: e.source, target: e.target, ...(e.conditional ? { conditional: true } : {}) }))
    feed.publishTopology(graphId, { nodes, edges })
  } catch (e) {
    // 可视化失败绝不影响运行
    // eslint-disable-next-line no-console
    console.warn('[coagent-graph] 导出图拓扑失败：', e instanceof Error ? e.message : String(e))
  }
}
