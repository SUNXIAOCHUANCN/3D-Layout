/**
 * 占位 WorkflowRunner 外壳（W02 产物，W05 起仅作拓扑回归用）。
 *
 * 结构真实（输入校验 → dispatch → 每区一个分支子图 → finalCheck 汇合 → 保底摘要），
 * 但分支执行体是占位：不连接写工具、不调用模型、不取证。W05 的真实流程在
 * `mainGraph.ts` + `regionGraph.ts`；本文件保留是为了让 W02 的拓扑/取消/失败映射
 * 用例继续有稳定对象可测（真实流程的拓扑由 W05 用例覆盖）。
 */

import { END, START, StateGraph } from '@langchain/langgraph'
import type {
  FinalCheck,
  RegionId,
  RegionResult,
  RunInput,
  RunOutcome,
  TasksPlan,
  WorkflowContext,
  WorkflowRunner,
} from '../contracts'
import { CoAgentError } from '../contracts'
import { validatePartitionSnapshot } from '../schemas'
import { looseGraph, RegionBranchState, RunGraphState, type RegionBranchStateType, type RunGraphStateType } from './state'

export interface PlaceholderWorkflowOptions {
  /** 分支延迟毫秒（测取消时让运行持续可中断）；缺省 0 */
  branchDelayMs?: number
  /** 这些区域的占位分支抛 write_failed（测失败→回滚映射）；缺省无 */
  failRegions?: readonly RegionId[]
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function synthesizeStubPlan(input: RunInput): TasksPlan {
  return {
    schemaVersion: 1,
    kind: 'tasks',
    assumptions: ['占位外壳：未接 planner，占位计划，无编辑发生'],
    tasks: input.partition.regions.map(region => ({
      schemaVersion: 1 as const,
      id: `stub-${region.id}`,
      regionId: region.id,
      objective: '（占位任务：验证拓扑，不执行编辑）',
      targetObjectIds: [...region.objectIds],
      allowedOperations: ['transform' as const],
      criteria: [{ id: `stub-${region.id}`, kind: 'visual' as const, description: '占位判据' }],
      constraints: [],
      dependsOn: [],
    })),
  }
}

function compileShell(regionIds: readonly RegionId[], options: PlaceholderWorkflowOptions) {
  const delayMs = options.branchDelayMs ?? 0
  const failRegions = new Set(options.failRegions ?? [])

  const builder = looseGraph<RunGraphStateType>(RunGraphState)
  builder.addNode('dispatch', (_state: RunGraphStateType) => ({
    trace: [{ type: 'dispatched' as const, at: Date.now(), note: `${regionIds.length} 个区域` }],
  }))

  for (const regionId of regionIds) {
    builder.addNode(`region-${regionId}`, buildStubRegionBranch(regionId, delayMs, failRegions))
    builder.addEdge('dispatch', `region-${regionId}`)
    builder.addEdge(`region-${regionId}`, 'finalCheck')
  }

  builder
    .addNode('finalCheck', (state: RunGraphStateType) => {
      const missing = regionIds.filter(id => !(id in state.regionResults))
      if (missing.length > 0) throw new Error(`finalCheck：缺少区域结果 [${missing.join(', ')}]`)
      return {
        finalCheckRuns: 1,
        finalCheckNote: `${regionIds.length} 个区域占位分支全部完成`,
        trace: [{ type: 'finalCheck' as const, at: Date.now() }],
      }
    })
    .addEdge(START, 'dispatch')
    .addEdge('finalCheck', END)

  return builder.compile()
}

function buildStubRegionBranch(regionId: RegionId, delayMs: number, failRegions: ReadonlySet<RegionId>) {
  return new StateGraph(RegionBranchState)
    .addNode('stub', async (state: RegionBranchStateType) => {
      if (delayMs > 0) await sleep(delayMs)
      if (failRegions.has(regionId)) {
        throw new CoAgentError('write_failed', `区域 ${regionId} 占位分支注入失败`)
      }
      return {
        attempt: state.attempt + 1,
        branchStatus: 'pass' as const,
        regionResults: { [regionId]: { regionId, status: 'pass', tasks: [] } } as Record<RegionId, RegionResult>,
      }
    })
    .addEdge(START, 'stub')
    .addEdge('stub', END)
    .compile()
}

export function createPlaceholderWorkflow(options: PlaceholderWorkflowOptions = {}): WorkflowRunner {
  return {
    async run(input: RunInput, context: WorkflowContext): Promise<RunOutcome> {
      const partitionCheck = validatePartitionSnapshot(input.partition)
      if (!partitionCheck.ok) {
        const err = new CoAgentError('invalid_plan', `分区快照非法：${partitionCheck.issues.map(i => `${i.path} ${i.message}`).join('；')}`)
        return { kind: 'rolled_back', reason: err.toToolError() }
      }

      context.emit({
        type: 'run.started',
        runId: input.runId,
        payload: { request: input.request, regionIds: input.partition.regions.map(r => r.id) },
      })

      const regionIds = input.partition.regions.map(r => r.id)
      const graph = compileShell(regionIds, options)

      try {
        const finalState = await graph.invoke(
          { runId: input.runId, request: input.request } as RunGraphStateType,
          { signal: context.signal },
        )
        const finalCheck: FinalCheck = {
          passed: true,
          checkedAt: new Date().toISOString(),
          checks: regionIds.map(id => ({
            name: `region-${id}`,
            passed: finalState.regionResults[id]?.status === 'pass',
            evidenceIds: [],
          })),
        }
        const regions: Record<RegionId, RegionResult> = {}
        for (const id of regionIds) regions[id] = finalState.regionResults[id]
        return {
          kind: 'completed',
          summary: `${regionIds.length} 个区域处理完成（占位外壳：未发生任何编辑）`,
          plan: synthesizeStubPlan(input),
          regions,
          finalCheck,
        }
      } catch (e) {
        if (context.signal.aborted) return { kind: 'cancelled' }
        const err = CoAgentError.from(e)
        return { kind: 'rolled_back', reason: err.toToolError() }
      }
    },
  }
}
