/**
 * 图页侧的 feed 订阅（W10）。
 *
 * 数据只有两个来源，都来自主应用：
 * 1. BroadcastChannel 实时消息（topology / events / run.end）；
 * 2. localStorage 快照（后开页面、或主应用已关时仍能看上一轮）。
 *
 * 页面只读：任何写操作都不存在。
 */

import { useEffect, useRef, useState } from 'react'
import type { CoAgentEventEnvelope } from '../contracts'
import { GRAPH_FEED_CHANNEL, GRAPH_FEED_STORAGE_KEY, type FeedMsg } from '../graphFeed'
import type { TopologyGraph } from '../workflow/state'

export interface FeedState {
  /** 是否收到过主应用的任何消息（握手成功） */
  connected: boolean
  runId: string | null
  topologies: Record<string, TopologyGraph>
  events: CoAgentEventEnvelope[]
  /** 终态事件类型（run.committed / run.rolled_back / run.failed） */
  outcome: string | null
}

const EMPTY: FeedState = { connected: false, runId: null, topologies: {}, events: [], outcome: null }

/** 事件上限（与主应用侧一致，避免长时间开着把内存吃满） */
const MAX_EVENTS = 800

function readSnapshot(): FeedState | null {
  try {
    const raw = localStorage.getItem(GRAPH_FEED_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as {
      runId?: unknown
      topologies?: unknown
      events?: unknown
      outcome?: unknown
    }
    if (!v || !Array.isArray(v.events)) return null
    return {
      connected: false,
      runId: typeof v.runId === 'string' ? v.runId : null,
      topologies: (v.topologies as Record<string, TopologyGraph>) ?? {},
      events: v.events as CoAgentEventEnvelope[],
      outcome: typeof v.outcome === 'string' ? v.outcome : null,
    }
  } catch {
    return null
  }
}

/** 按 eventSeq 合并去重（同一轮内 eventSeq 单调；跨轮由调用方先判 runId） */
function mergeEvents(prev: CoAgentEventEnvelope[], next: CoAgentEventEnvelope[]): CoAgentEventEnvelope[] {
  if (next.length === 0) return prev
  const bySeq = new Map<number, CoAgentEventEnvelope>()
  for (const e of prev) bySeq.set(e.eventSeq, e)
  for (const e of next) bySeq.set(e.eventSeq, e)
  const all = [...bySeq.values()].sort((a, b) => a.eventSeq - b.eventSeq)
  return all.length > MAX_EVENTS ? all.slice(all.length - MAX_EVENTS) : all
}

export function useGraphFeed(): FeedState {
  const [state, setState] = useState<FeedState>(() => readSnapshot() ?? EMPTY)
  const channelRef = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(GRAPH_FEED_CHANNEL)
    } catch {
      channel = null
    }
    channelRef.current = channel
    if (!channel) return

    channel.onmessage = ev => {
      const msg = ev.data as FeedMsg | undefined
      if (!msg) return
      switch (msg.kind) {
        case 'topology':
          setState(s => ({
            ...s,
            connected: true,
            topologies: { ...s.topologies, [msg.graphId]: msg.topo },
          }))
          break
        case 'events': {
          setState(s => {
            const sameRun = s.runId === null || msg.runId === s.runId
            return {
              ...s,
              connected: true,
              runId: msg.runId || s.runId,
              events: sameRun ? mergeEvents(s.events, msg.events) : msg.events,
            }
          })
          break
        }
        case 'run.end':
          setState(s => ({ ...s, connected: true, runId: msg.runId || s.runId, outcome: msg.outcome }))
          break
        case 'snapshot':
          setState(s => {
            const sameRun = s.runId === null || msg.runId === s.runId
            return {
              connected: true,
              runId: msg.runId ?? s.runId,
              topologies: Object.keys(msg.topologies).length > 0 ? msg.topologies : s.topologies,
              events: msg.events.length > 0 ? (sameRun ? mergeEvents(s.events, msg.events) : msg.events) : s.events,
              outcome: msg.outcome ?? s.outcome,
            }
          })
          break
        default:
          break
      }
    }

    // 握手：主应用收到 hello 会把"当前拓扑 + 已有事件"整包回过来
    channel.postMessage({ kind: 'hello' } satisfies FeedMsg)
    return () => {
      channel?.close()
      channelRef.current = null
    }
  }, [])

  return state
}
