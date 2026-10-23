/**
 * W02 LangGraph 可行性验证图（拓扑原型，长期保留作回归）。
 *
 * 验证目标（SPEC §W02）：两个不同耗时分支并行、其中一个带修正循环；
 * 结果 reducer 汇合（同键不同值报错）；finalCheck 恰好一次且等待全部分支；
 * AbortSignal 取消。这些拓扑结论直接被 W05 的 mainGraph/regionGraph 继承：
 * 分支 = 原生子图节点（内部修正循环不泄漏到父图超步），汇合靠 Pregel 超步屏障。
 *
 * 本图不含任何业务与写操作；分支"执行体"是可配置延时 + 可配置失败次数的占位。
 */

import { END, START, StateGraph } from '@langchain/langgraph'
import type { RegionId } from '../contracts'
import {
  looseGraph,
  RegionBranchState,
  RunGraphState,
  type RegionBranchStateType,
  type RunGraphStateType,
} from './state'

export interface VerificationBranchSpec {
  regionId: RegionId
  /** 父图内节点名（须互不相同） */
  nodeKey: string
  /** 每次尝试耗时（毫秒）——制造分支间不同耗时 */
  delayMs: number
  /** 前 N 次尝试结果为 fail（制造修正循环） */
  failFirstAttempts: number
  /** 尝试上限（含首次）；到限仍 fail 则该分支终局失败 */
  maxAttempts: number
  /** 第 N 次尝试直接抛异常（测某支异常终止）；与 failFirstAttempts 二选一 */
  throwOnAttempt?: number
}

export type VerificationEvent =
  | { type: 'dispatched'; at: number; regionIds: RegionId[] }
  | { type: 'attempt'; at: number; regionId: RegionId; attempt: number; status: 'pass' | 'fail' }
  | { type: 'finalCheck'; at: number; passed: boolean; missing: RegionId[] }

export type VerificationRecorder = (event: VerificationEvent) => void

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 区域分支子图：execute 尝试 → 未过且未到上限则回到 execute（修正循环）→ 终态写入共享 regionResults。
 * 结果条目 tasks 恒为空（验证图无任务语义，只验拓扑）。
 */
export function buildRegionBranch(spec: VerificationBranchSpec, recorder?: VerificationRecorder) {
  // 分支节点名是静态的（execute），原生链式 builder 即可
  return new StateGraph(RegionBranchState)
    .addNode('execute', async (state: RegionBranchStateType) => {
      const attempt = state.attempt + 1
      if (spec.throwOnAttempt === attempt) {
        throw new Error(`区域 ${spec.regionId} 第 ${attempt} 次尝试异常（注入）`)
      }
      await sleep(spec.delayMs)
      const status: 'pass' | 'fail' = attempt <= spec.failFirstAttempts ? 'fail' : 'pass'
      const done = status === 'pass' || attempt >= spec.maxAttempts
      recorder?.({ type: 'attempt', at: Date.now(), regionId: spec.regionId, attempt, status })
      return {
        attempt,
        branchStatus: status,
        ...(done
          ? {
              regionResults: {
                [spec.regionId]: { regionId: spec.regionId, status: status === 'pass' ? 'pass' : 'fail', tasks: [] },
              } as Record<RegionId, RegionBranchStateType['regionResults'][RegionId]>,
              trace: [{ type: 'attempt' as const, at: Date.now(), regionId: spec.regionId, note: `终态 ${status}（第 ${attempt} 次）` }],
            }
          : {}),
      }
    })
    .addConditionalEdges('execute', (state: RegionBranchStateType) =>
      state.branchStatus === 'pass' || state.attempt >= spec.maxAttempts ? END : 'execute',
    )
    .addEdge(START, 'execute')
    .compile()
}

/**
 * 验证图：dispatch → 并行分支（原生子图节点）→ finalCheck → END。
 * finalCheck 在所有分支终态后才运行（恰好一次）；缺结果或有终局失败分支时抛错。
 */
export function buildVerificationGraph(
  specs: readonly VerificationBranchSpec[],
  recorder?: VerificationRecorder,
) {
  const builder = looseGraph<RunGraphStateType>(RunGraphState)
  builder.addNode('dispatch', (_state: RunGraphStateType) => {
    recorder?.({ type: 'dispatched', at: Date.now(), regionIds: specs.map(s => s.regionId) })
    return { trace: [{ type: 'dispatched' as const, at: Date.now(), note: `${specs.length} 个分支` }] }
  })

  for (const spec of specs) {
    builder.addNode(spec.nodeKey, buildRegionBranch(spec, recorder))
    builder.addEdge('dispatch', spec.nodeKey)
    builder.addEdge(spec.nodeKey, 'finalCheck')
  }

  builder.addNode('finalCheck', (state: RunGraphStateType) => {
    const missing = specs.filter(s => !(s.regionId in state.regionResults)).map(s => s.regionId)
    const failed = specs.filter(s => state.regionResults[s.regionId]?.status !== 'pass').map(s => s.regionId)
    const passed = missing.length === 0 && failed.length === 0
    recorder?.({ type: 'finalCheck', at: Date.now(), passed, missing: [...missing, ...failed] })
    if (!passed) {
      throw new Error(`finalCheck 未通过：缺结果 [${missing.join(', ')}]，终局失败 [${failed.join(', ')}]`)
    }
    return {
      finalCheckRuns: 1,
      finalCheckNote: `${specs.length} 个分支全部通过`,
      trace: [{ type: 'finalCheck' as const, at: Date.now() }],
    }
  })
  builder.addEdge(START, 'dispatch')
  builder.addEdge('finalCheck', END)

  return builder.compile()
}
