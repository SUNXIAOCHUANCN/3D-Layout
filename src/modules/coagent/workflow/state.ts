/**
 * LangGraph 图状态（W02）。
 *
 * 依赖规则（SPEC §2.2）：LangGraph 导入只允许出现在 workflow/ 内——本文件与
 * verificationGraph/createWorkflow 是模块内唯一直接依赖 @langchain/langgraph 的地方。
 *
 * 状态通道语义（§4.4）：
 * - regionResults 按 regionId 索引，并行合并禁止 last-write-wins（同键不同值报错）；
 * - trace 只追加（reducer concat），并行事件记录发生顺序不暗示因果；
 * - finalCheckRuns 计数器用于断言"最后检查恰好一次"。
 */

import { Annotation, StateGraph } from '@langchain/langgraph'
import type { RegionId, RegionResult } from '../contracts'

/**
 * 动态节点名父图的轻量门面（W02 定案）。
 * LangGraph 类型化 builder 靠链式调用累积字面量节点名联合，而 CoAgent 的父图
 * 按 regionId 动态建点（且节点名禁止冒号），无法走那条类型路径——这里收敛成
 * 一个自有小接口：addNode/addEdge/addConditionalEdges 收 string，compile 出的
 * invoke 仍保留 S 的完整类型。分支子图节点名是静态的，继续用原生链式builder。
 */
export interface LooseCompiled<S> {
  invoke(state: Partial<S>, config?: { signal?: AbortSignal }): Promise<S>
}

export interface LooseGraphApi<S> {
  addNode(name: string, action: unknown): LooseGraphApi<S>
  addEdge(from: string, to: string): LooseGraphApi<S>
  addConditionalEdges(source: string, router: (state: S) => string): LooseGraphApi<S>
  compile(): LooseCompiled<S>
}

export function looseGraph<S>(schema: unknown): LooseGraphApi<S> {
  return new StateGraph(schema as never) as unknown as LooseGraphApi<S>
}

/**
 * 并行结果表合并：同键同值幂等、同键不同值抛错（§4.4 "重复且不同的值应报错，
 * 不能 last-write-wins"）。真实 mainGraph 与 W02 验证图共用。
 */
export function mergeKeyedNoLWW<T>(left: Record<string, T>, right: Record<string, T>): Record<string, T> {
  for (const [key, value] of Object.entries(right)) {
    if (key in left && JSON.stringify(left[key]) !== JSON.stringify(value)) {
      throw new Error(`并行结果键冲突 regionId=${key}：不同分支写入了不同值（禁止 last-write-wins）`)
    }
  }
  return { ...left, ...right }
}

export type TraceEvent = {
  type: 'dispatched' | 'attempt' | 'finalCheck'
  at: number
  regionId?: RegionId
  note?: string
}

/** 主图（及 W02 验证图/shell）状态：runId、请求、按 regionId 的结果表、轨迹、终检计数 */
export const RunGraphState = Annotation.Root({
  runId: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
  request: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
  regionResults: Annotation<Record<RegionId, RegionResult>>({
    reducer: mergeKeyedNoLWW,
    default: () => ({}),
  }),
  trace: Annotation<TraceEvent[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  finalCheckRuns: Annotation<number>({ reducer: (left, right) => left + right, default: () => 0 }),
  finalCheckNote: Annotation<string | null>({ reducer: (_left, right) => right, default: () => null }),
})

/**
 * 区域分支子图状态：attempt/branchStatus 是分支私有通道（修正循环），
 * regionResults/trace 与父图共享——子图完成后经共享通道把结果汇入父图。
 */
export const RegionBranchState = Annotation.Root({
  regionId: Annotation<RegionId>({ reducer: (_left, right) => right, default: () => '' }),
  attempt: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  branchStatus: Annotation<'pass' | 'fail'>({ reducer: (_left, right) => right, default: () => 'fail' }),
  regionResults: Annotation<Record<RegionId, RegionResult>>({
    reducer: mergeKeyedNoLWW,
    default: () => ({}),
  }),
  trace: Annotation<TraceEvent[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
})

export type RunGraphStateType = typeof RunGraphState.State
export type RegionBranchStateType = typeof RegionBranchState.State
