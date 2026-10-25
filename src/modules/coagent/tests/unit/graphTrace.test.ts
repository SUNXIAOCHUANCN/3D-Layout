/**
 * W10 图可视化：looseGraph 门面追踪 + 拓扑导出。
 *
 * 这两条是图页的唯一数据来源，必须锁住：
 * 1. 节点进出发 node.started / node.finished（且不改变返回值与失败语义）；
 * 2. getGraphAsync() 在**不执行任何节点**的前提下导出拓扑（含运行时动态建的节点）。
 */

import { describe, expect, it } from 'vitest'
import { Annotation, END, START } from '@langchain/langgraph'
import type { WorkflowEventInput } from '../../contracts'
import { beginGraphFeed, disposeGraphFeed, publishGraphTopology } from '../../graphFeed'
import { looseGraph } from '../../workflow/state'

const S = Annotation.Root({
  n: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
})
type SType = typeof S.State

function collect() {
  const events: WorkflowEventInput[] = []
  return { events, emit: (e: WorkflowEventInput) => events.push(e) }
}

describe('looseGraph 节点追踪', () => {
  it('每个节点各发 started/finished，返回值不变', async () => {
    const sink = collect()
    const graph = looseGraph<SType>(S, { runId: 'run-1', emit: sink.emit })
    graph.addNode('a', () => ({ n: 1 }))
    graph.addNode('b', async () => {
      await new Promise(r => setTimeout(r, 5))
      return { n: 2 }
    })
    graph.addEdge(START, 'a')
    graph.addConditionalEdges('a', () => 'b', ['b'])
    graph.addEdge('b', END)

    const out = await graph.compile().invoke({})
    expect(out.n).toBe(2)
    expect(sink.events.map(e => `${e.type}:${String(e.payload.node)}`)).toEqual([
      'node.started:a',
      'node.finished:a',
      'node.started:b',
      'node.finished:b',
    ])
    const finished = sink.events.filter(e => e.type === 'node.finished')
    expect(finished.every(e => e.payload.status === 'ok')).toBe(true)
    expect(finished.every(e => typeof e.payload.ms === 'number' && (e.payload.ms as number) >= 0)).toBe(true)
    expect(sink.events.every(e => e.runId === 'run-1')).toBe(true)
  })

  it('regionId 会把节点名变成 A/execute，并在事件上带 regionId', async () => {
    const sink = collect()
    const graph = looseGraph<SType>(S, { runId: 'run-2', regionId: 'A', emit: sink.emit })
    graph.addNode('execute', () => ({ n: 1 }))
    graph.addEdge(START, 'execute')
    graph.addEdge('execute', END)

    await graph.compile().invoke({})
    expect(sink.events.map(e => String(e.payload.node))).toEqual(['A/execute', 'A/execute'])
    expect(sink.events.every(e => e.regionId === 'A')).toBe(true)
  })

  it('节点抛错：先发 error 事件，再原样抛出（失败语义不变）', async () => {
    const sink = collect()
    const graph = looseGraph<SType>(S, { runId: 'run-3', emit: sink.emit })
    graph.addNode('boom', () => {
      throw new Error('炸了')
    })
    graph.addEdge(START, 'boom')
    graph.addEdge('boom', END)

    await expect(graph.compile().invoke({})).rejects.toThrow('炸了')
    const last = sink.events[sink.events.length - 1]
    expect(last.type).toBe('node.finished')
    expect(last.payload.status).toBe('error')
    expect(String(last.payload.message)).toContain('炸了')
  })

  it('不传 emit 时完全不产生事件（旧行为）', async () => {
    const graph = looseGraph<SType>(S)
    graph.addNode('plain', () => ({ n: 7 }))
    graph.addEdge(START, 'plain')
    graph.addEdge('plain', END)
    const out = await graph.compile().invoke({})
    expect(out.n).toBe(7)
  })

  it('getGraphAsync 导出拓扑（含动态节点），且不执行节点', async () => {
    let executed = 0
    const graph = looseGraph<SType>(S)
    graph.addNode('planner', () => {
      executed++
      return {}
    })
    // 模拟 mainGraph 里按分区动态建的节点
    for (const region of ['A', 'B']) {
      graph.addNode(`region-${region}`, () => {
        executed++
        return {}
      })
    }
    graph.addEdge(START, 'planner')
    for (const region of ['A', 'B']) {
      graph.addEdge('planner', `region-${region}`)
      graph.addEdge(`region-${region}`, END)
    }

    const topo = await graph.compile().getGraphAsync()
    expect(Object.keys(topo.nodes)).toEqual(expect.arrayContaining(['__start__', 'planner', 'region-A', 'region-B', '__end__']))
    expect(topo.edges.some(e => e.source === 'planner' && e.target === 'region-A')).toBe(true)
    expect(executed).toBe(0)
  })

  it('publishGraphTopology 在无通道环境静默通过（绝不向运行抛错）', async () => {
    beginGraphFeed()
    try {
      await expect(
        publishGraphTopology('main', {
          getGraphAsync: async () => ({ nodes: { a: { id: 'a', name: 'a' } }, edges: [] }),
        }),
      ).resolves.toBeUndefined()
      // 拓扑导出失败也只告警：这里让 getGraphAsync 直接抛
      await expect(
        publishGraphTopology('main', {
          getGraphAsync: async () => {
            throw new Error('boom')
          },
        }),
      ).resolves.toBeUndefined()
    } finally {
      disposeGraphFeed()
    }
  })
})
