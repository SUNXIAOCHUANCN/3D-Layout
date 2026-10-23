/**
 * mainGraph（W05，SPEC §3.3/§5.3）——一轮请求的主流程。
 *
 *   collectContext → plan → validatePlan → captureBaselines（全部初始基线）
 *     → dispatch（建每区子图） → 并行 region-<id>（原生子图节点） → finalCheck → summarize
 *
 * 顺序保证（不靠"节点写得快"）：
 * - captureBaselines 是独立节点，dispatch 的所有分支都在它的下一个超步才开始 —— 
 *   W02 已验证 Pregel 超步屏障：所有 baseline 完成前不发生任何写入；
 * - 分支汇合到 finalCheck 由屏障保证"等齐且只跑一次"（finalCheckRuns 计数断言）。
 *
 * 失败语义：本图不自己决定 rollback，只把失败写进 failureCode/failureReason；
 * 由 runController 统一处理回滚与事件（W03 已定）。
 */

import { Annotation } from '@langchain/langgraph'
import type {
  AssetDTO,
  FinalCheckItem,
  GeometryResult,
  ModelCatalogEntry,
  ModelPort,
  PartitionSnapshot,
  Plan,
  RegionId,
  RegionResult,
  RunInput,
  RunOutcome,
  TaskResult,
  TasksPlan,
  ToolError,
  UnitTask,
  WorkflowContext,
  WorkflowRunner,
} from '../contracts'
import { CoAgentError } from '../contracts'
import { judgeTask, taskPassed } from '../agents/judge'
import { makePlan, tasksOfRegion } from '../agents/planner'
import { buildPlannerContext } from '../agents/plannerContext'
import { validatePlanSemantics } from '../services/planValidation'
import { validateFinalScene } from '../services/validation'
import { captureWith, regionCamera } from '../tools/cameraTools'
import { createToolRegistry } from '../tools/registry'
import { buildRegionGraph, regionPassed, type RegionStateType } from './regionGraph'
import { looseGraph, mergeKeyedNoLWW } from './state'
import { END, START } from '@langchain/langgraph'

const MainState = Annotation.Root({
  runId: Annotation<string>({ reducer: (_l, r) => r, default: () => '' }),
  request: Annotation<string>({ reducer: (_l, r) => r, default: () => '' }),
  partition: Annotation<PartitionSnapshot | null>({ reducer: (_l, r) => r, default: () => null }),
  plan: Annotation<Plan | null>({ reducer: (_l, r) => r, default: () => null }),
  route: Annotation<string>({ reducer: (_l, r) => r, default: () => 'tasks' }),
  baselines: Annotation<Record<RegionId, string[]>>({
    reducer: (l, r) => ({ ...l, ...r }),
    default: () => ({}),
  }),
  regionResults: Annotation<Record<RegionId, RegionResult>>({ reducer: mergeKeyedNoLWW, default: () => ({}) }),
  trace: Annotation<Array<{ type: string; at: number; note?: string }>>({
    reducer: (l, r) => l.concat(r),
    default: () => [],
  }),
  finalCheckRuns: Annotation<number>({ reducer: (l, r) => l + r, default: () => 0 }),
  finalCheckNote: Annotation<string | null>({ reducer: (_l, r) => r, default: () => null }),
  finalChecks: Annotation<FinalCheckItem[]>({ reducer: (_l, r) => r, default: () => [] }),
  summary: Annotation<string>({ reducer: (_l, r) => r, default: () => '' }),
  failureCode: Annotation<ToolError['code'] | null>({ reducer: (_l, r) => r, default: () => null }),
  failureReason: Annotation<string | null>({ reducer: (_l, r) => r, default: () => null }),
  /** 失败发生在哪个节点（诊断用：planner / validatePlan / captureBaselines / region-x / finalCheck） */
  failureStage: Annotation<string | null>({ reducer: (_l, r) => r, default: () => null }),
  clarifyQuestion: Annotation<string | null>({ reducer: (_l, r) => r, default: () => null }),
  clarifyOptions: Annotation<string[]>({ reducer: (_l, r) => r, default: () => [] }),
})

export type MainStateType = typeof MainState.State

export interface MainWorkflowOptions {
  /** 模型-工具往返上限（每任务执行内） */
  executorRounds?: number
}

export function createMainWorkflow(_opts: MainWorkflowOptions = {}): WorkflowRunner {
  return {
    async run(input: RunInput, context: WorkflowContext): Promise<RunOutcome> {
      const registry = createToolRegistry(context, { maxCallsPerTask: context.config.toolBudgetPerTask })
      const regionGraphs = new Map<RegionId, ReturnType<typeof buildRegionGraph>>()
      let planTasks: TasksPlan | null = null
      let assets: AssetDTO[] = []
      let catalog: ModelCatalogEntry[] = []
      const model: ModelPort = context.model
      const partition = input.partition
      // LangGraph 1.5.1 的 compiled 类型只声明了 signal，但运行期支持 recursionLimit；
      // 8 任务 × 修正轮不应撞默认 25 步上限。
      const runConfig = { signal: context.signal, recursionLimit: 64 } as { signal: AbortSignal }
      /** 当前节点名：异常时带进 rolled_back 的 details，便于定位"死在哪一步" */
      let stage = 'collectContext'

      const graph = looseGraph<MainStateType>(MainState)

      graph.addNode('collectContext', () => {
        stage = 'collectContext'
        const snap = context.editorRead.snapshot({ includeCatalog: true })
        assets = snap.assets
        catalog = snap.catalog ?? []
        return {
          trace: [
            {
              type: 'collectContext',
              at: Date.now(),
              note: `${partition.regions.length} 个区 / ${assets.length} 个对象 / ${catalog.length} 个模型`,
            },
          ],
        }
      })

      // 注意：LangGraph 禁止节点名与状态通道同名，所以节点叫 planner/summarizer
      graph.addNode('planner', async (state: MainStateType) => {
        stage = 'planner'
        // W07：精简上下文 + 只读工具（按需观察视口/对象），不再把全场景塞给模型
        const viewport = context.render.diagnostics ? context.render.diagnostics().mainCamera : null
        const bundle = buildPlannerContext({ request: state.request, partition, assets, catalog, viewport })
        const plan = await makePlan({
          runId: input.runId,
          model,
          signal: context.signal,
          config: context.config,
          registry,
          contextText: bundle.text,
          partition,
          assets,
        })
        if (plan.kind === 'tasks') planTasks = plan
        context.emit({
          type: 'plan.ready',
          runId: input.runId,
          payload: {
            kind: plan.kind,
            tasks: plan.kind === 'tasks' ? plan.tasks.length : 0,
            candidates: bundle.candidateIds.length,
            truncated: bundle.truncated,
          },
        })
        return {
          plan,
          route: plan.kind,
          ...(plan.kind === 'clarify' ? { clarifyQuestion: plan.question, clarifyOptions: plan.options } : {}),
          trace: [{ type: 'plan', at: Date.now(), note: `${plan.kind}（候选对象 ${bundle.candidateIds.length}）` }],
        }
      })

      graph.addNode('validatePlan', (state: MainStateType) => {
        stage = 'validatePlan'
        // clarify / unsupported 不进入执行，由 run() 映射成对应的 RunOutcome
        if (state.plan?.kind !== 'tasks') return { trace: [{ type: 'validatePlan', at: Date.now(), note: state.plan?.kind ?? 'null' }] }
        const issues = validatePlanSemantics(state.plan, partition, assets)
        if (issues.length > 0) {
          return {
            failureCode: 'invalid_plan' as const,
            failureReason: issues.slice(0, 3).map(i => `${i.path} ${i.message}`).join('；'),
            failureStage: 'validatePlan',
            trace: [{ type: 'validatePlan', at: Date.now(), note: `${issues.length} 个问题` }],
          }
        }
        return { trace: [{ type: 'validatePlan', at: Date.now(), note: `${state.plan.tasks.length} 个任务` }] }
      })

      graph.addNode('captureBaselines', async () => {
        stage = 'captureBaselines'
        const baselines: Record<RegionId, string[]> = {}
        for (const region of partition.regions) {
          const obs = await captureWith(context, {
            runId: input.runId,
            camera: regionCamera(region),
            phase: 'baseline',
            objectIds: region.objectIds.slice(0, 12),
            marked: true,
            taskId: null,
            regionId: region.id,
          })
          baselines[region.id] = [obs.id]
          context.emit({
            type: 'baseline.ready',
            runId: input.runId,
            regionId: region.id,
            payload: { observationId: obs.id, phase: 'baseline', partitionVersion: partition.partitionVersion },
          })
        }
        return { baselines, trace: [{ type: 'captureBaselines', at: Date.now(), note: `${Object.keys(baselines).length} 个区` }] }
      })

      graph.addNode('dispatch', (state: MainStateType) => {
        stage = 'dispatch'
        const plan = state.plan
        if (!plan || plan.kind !== 'tasks') throw new CoAgentError('invalid_plan', 'dispatch 时没有可执行计划')
        for (const region of partition.regions) {
          const tasks = tasksOfRegion(plan, region.id)
          regionGraphs.set(
            region.id,
            buildRegionGraph(
              { context, model, registry, config: context.config, region, runId: input.runId },
              tasks,
              state.baselines[region.id] ?? [],
            ),
          )
        }
        context.emit({ type: 'tool.started', runId: input.runId, payload: { dispatch: partition.regions.map(r => r.id) } })
        return { trace: [{ type: 'dispatch', at: Date.now(), note: partition.regions.map(r => r.id).join(',') }] }
      })

      for (const region of partition.regions) {
        const nodeName = `region-${region.id}`
        graph.addNode(nodeName, async () => {
          stage = nodeName
          const sub = regionGraphs.get(region.id)
          if (!sub) throw new CoAgentError('internal_error', `区域子图未建立：${region.id}`)
          const out = (await sub.invoke({ regionId: region.id, index: 0 }, runConfig)) as RegionStateType
          return { regionResults: out.regionResults, trace: out.trace }
        })
      }

      graph.addNode('finalCheck', async (state: MainStateType) => {
        stage = 'finalCheck'
        const checks: FinalCheckItem[] = []
        const problems: string[] = []
        const plan = state.plan as TasksPlan

        for (const region of partition.regions) {
          const result = state.regionResults[region.id]
          const passed = regionPassed(result)
          checks.push({ name: `region:${region.id}`, passed, evidenceIds: (result?.tasks ?? []).flatMap(t => t.evidenceIds) })
          if (!passed) problems.push(`区域 ${region.id} 未通过`)
        }

        // 证据可解析（judge 引用过的 id 必须还在）
        const allEvidence = Object.values(state.regionResults).flatMap(r => r.tasks.flatMap(t => t.evidenceIds))
        const missingEvidence = allEvidence.filter(id => !context.getObservation(id))
        checks.push({ name: 'evidence:resolvable', passed: missingEvidence.length === 0, evidenceIds: [], ...(missingEvidence.length > 0 ? { note: `缺失 ${missingEvidence.length} 条` } : {}) })
        if (missingEvidence.length > 0) problems.push(`证据无法取回：${missingEvidence.slice(0, 3).join(', ')}`)

        // W08.1：终检几何用**最终场景**重算；no_collision 不能拿区域执行期的旧结果充当终检。
        const geometryByTask: Record<string, GeometryResult | undefined> = {}
        for (const task of plan.tasks) {
          if (!task.constraints.some(c => c.kind === 'no_collision')) continue
          const result = state.regionResults[task.regionId]?.tasks.find(t => t.taskId === task.id)
          const writeIds = [...new Set([...task.targetObjectIds, ...(result?.createdObjectIds ?? [])])]
          if (writeIds.length === 0) continue
          const region = partition.regions.find(r => r.id === task.regionId)
          try {
            geometryByTask[task.id] = await context.render.geometry(
              {
                objectIds: writeIds,
                staticObjectIds: region ? region.objectIds.filter(id => !writeIds.includes(id)) : [],
                contactToleranceM: 0.02,
                allowGroundContact: true,
              },
              context.signal,
            )
          } catch (e) {
            // 取消必须向上传播，不能把 cancelled 记成"终检几何失败"
            if (context.signal.aborted) throw e
            const err = CoAgentError.from(e)
            problems.push(`任务 ${task.id} 终检几何失败：${err.message}`)
          }
        }

        // W08.1：metric/constraint 用最终场景逐任务重算；visual 用最后一轮判定。
        // 这样"后任务破坏前任务条件"不会因为历史 pass 被漏掉（T17）。
        const finalSnapshot = context.editorRead.snapshot({})
        const finalById = new Map(finalSnapshot.assets.map(a => [a.id, a]))

        // W08.5：后任务改过某任务的相关对象时，用**同视角最终图**重判 visual；
        // 不能只拿该任务当时那一轮 Verdict 当终态（§6.6）。
        for (const task of plan.tasks) {
          if (!task.criteria.some(c => c.kind === 'visual')) continue
          const result = state.regionResults[task.regionId]?.tasks.find(t => t.taskId === task.id)
          if (!result || result.status !== 'pass' || !result.baselineObservationId || !result.judgedFingerprints) continue
          const relevant = [...new Set([...task.targetObjectIds, ...(result.createdObjectIds ?? [])])]
          if (relevant.length === 0) continue
          const affected = relevant.some(id => finalById.get(id)?.fingerprint !== result.judgedFingerprints?.[id])
          if (!affected) continue

          const region = partition.regions.find(r => r.id === task.regionId)
          if (!region) continue
          const before = context.getObservation(result.baselineObservationId)
          if (!before) {
            result.status = 'fail'
            checks.push({ name: `visual-refresh:${task.id}`, passed: false, evidenceIds: [], note: '基线证据无法取回' })
            problems.push(`任务 ${task.id} 的基线证据无法取回，不能做终检视觉重判`)
            continue
          }

          try {
            const after = await captureWith(context, {
              runId: input.runId,
              camera: regionCamera(region),
              phase: 'after',
              objectIds: [...new Set([...task.targetObjectIds, ...region.objectIds, ...(result.createdObjectIds ?? [])])].slice(0, 12),
              marked: true,
              taskId: task.id,
              regionId: task.regionId,
            })
            const judged = await judgeTask({
              task,
              runId: input.runId,
              before,
              after,
              extraEvidenceIds: result.evidenceIds,
              ...(result.createdObjectIds.length > 0 ? { createdObjectIds: result.createdObjectIds } : {}),
              ...(geometryByTask[task.id] ? { geometry: geometryByTask[task.id] } : {}),
              model,
              signal: context.signal,
              config: context.config,
              context,
            })
            result.verdicts.push(judged.verdict)
            result.evidenceIds = [...new Set([...result.evidenceIds, after.id])]
            const ok = taskPassed(judged)
            checks.push({
              name: `visual-refresh:${task.id}`,
              passed: ok,
              evidenceIds: [before.id, after.id],
              note: ok ? '终检视觉重判通过' : `终检视觉重判未通过（${judged.verdict.status}）`,
            })
            if (!ok) {
              result.status = 'fail'
              problems.push(`任务 ${task.id} 终检视觉重判未通过（${judged.verdict.status}）`)
            }
          } catch (e) {
            if (context.signal.aborted) throw e
            const err = CoAgentError.from(e)
            result.status = 'fail'
            checks.push({ name: `visual-refresh:${task.id}`, passed: false, evidenceIds: [], note: err.message })
            problems.push(`任务 ${task.id} 终检视觉重判失败：${err.message}`)
          }
        }

        const sceneValidation = validateFinalScene({
          plan,
          partition,
          snapshot: finalSnapshot,
          regions: state.regionResults,
          geometryByTask,
        })
        checks.push(...sceneValidation.checks)
        problems.push(...sceneValidation.problems)

        const passed = problems.length === 0
        const note = passed ? `${checks.length} 项检查通过` : problems.slice(0, 3).join('；')
        return {
          finalCheckRuns: 1,
          finalCheckNote: note,
          finalChecks: checks,
          ...(passed
            ? { trace: [{ type: 'finalCheck', at: Date.now(), note }] }
            : {
                failureCode: 'write_failed' as const,
                failureReason: note,
                failureStage: 'finalCheck',
                trace: [{ type: 'finalCheck', at: Date.now(), note }],
              }),
        }
      })

      graph.addNode('summarizer', (state: MainStateType) => {
        stage = 'summarizer'
        const regions = Object.values(state.regionResults)
        const tasks = regions.flatMap(r => r.tasks)
        const passedTasks = tasks.filter(t => t.status === 'pass').length
        const summary = `已完成：${regions.filter(r => r.status === 'pass').length}/${regions.length} 个区域，${passedTasks}/${tasks.length} 个任务通过（终检：${state.finalCheckNote ?? '未执行'}）`
        return { summary, trace: [{ type: 'summarize', at: Date.now(), note: summary }] }
      })

      graph.addEdge(START, 'collectContext')
      graph.addEdge('collectContext', 'planner')
      graph.addEdge('planner', 'validatePlan')
      graph.addConditionalEdges('validatePlan', (s: MainStateType) =>
        s.plan?.kind === 'tasks' && !s.failureCode ? 'captureBaselines' : END,
      )
      graph.addEdge('captureBaselines', 'dispatch')
      for (const region of partition.regions) {
        graph.addEdge('dispatch', `region-${region.id}`)
        graph.addEdge(`region-${region.id}`, 'finalCheck')
      }
      graph.addEdge('finalCheck', 'summarizer')
      graph.addEdge('summarizer', END)

      try {
        const compiled = graph.compile()
        const final = (await compiled.invoke({ runId: input.runId, request: input.request, partition }, runConfig)) as MainStateType
        const plan = final.plan

        if (plan?.kind === 'clarify') {
          return { kind: 'needs_clarification', question: plan.question, options: plan.options }
        }
        if (plan?.kind === 'unsupported') {
          // SPEC 的 Plan 有 unsupported 三态，但 RunOutcome 没有对应 kind：
          // 这里映射成 rolled_back + invalid_plan，并把原因原样带给用户。
          return {
            kind: 'rolled_back',
            reason: { code: 'invalid_plan', message: `不支持该请求：${plan.reason}`, retryable: false },
          }
        }
        if (final.failureCode) {
          return {
            kind: 'rolled_back',
            reason: {
              code: final.failureCode,
              message: final.failureReason ?? '流程失败',
              retryable: false,
              details: { stage: final.failureStage ?? stage },
            },
          }
        }
        if (!planTasks) {
          return {
            kind: 'rolled_back',
            reason: { code: 'invalid_plan', message: '没有可执行计划', retryable: false, details: { stage } },
          }
        }

        return {
          kind: 'completed',
          summary: final.summary,
          plan: planTasks,
          regions: final.regionResults,
          finalCheck: {
            passed: final.finalChecks.every(c => c.passed),
            checkedAt: new Date().toISOString(),
            checks: [
              ...final.finalChecks,
              ...Object.values(final.regionResults).flatMap((r: RegionResult) =>
                r.tasks.map((t: TaskResult) => ({ name: `task:${t.taskId}`, passed: t.status === 'pass', evidenceIds: t.evidenceIds })),
              ),
            ],
          },
        }
      } catch (e) {
        if (context.signal.aborted) return { kind: 'cancelled' }
        const err = CoAgentError.from(e)
        // 带上失败节点与错误细节：事件日志里只看到错误码无法定位（用户实测踩过）
        // 注意：区域子图是**并行**跑的，共享的 `stage` 会被后完成的区覆盖；
        // 区域子图抛出的错误自带 regionId/taskId/stage，优先用它们定位。
        const own = (err.details ?? {}) as Record<string, unknown>
        const regionId = typeof own.regionId === 'string' ? own.regionId : null
        const ownStage = typeof own.stage === 'string' ? own.stage : null
        const withStage = new CoAgentError(err.code, err.message, {
          retryable: err.retryable,
          details: {
            ...(err.details ?? {}),
            stage: regionId ? `region-${regionId}${ownStage ? `:${ownStage}` : ''}` : (ownStage ?? stage),
          },
          cause: err,
        })
        return { kind: 'rolled_back', reason: withStage.toToolError() }
      }
    },
  }
}

/** 显式导出，供测试断言"任务全部通过" */
export function allTasksPassed(regions: Record<RegionId, RegionResult>, plan: TasksPlan): boolean {
  const expected = new Set(plan.tasks.map((t: UnitTask) => t.id))
  const seen = new Set<string>()
  for (const r of Object.values(regions)) {
    for (const t of r.tasks) {
      seen.add(t.taskId)
      if (t.status !== 'pass') return false
    }
  }
  for (const id of expected) if (!seen.has(id)) return false
  return true
}
