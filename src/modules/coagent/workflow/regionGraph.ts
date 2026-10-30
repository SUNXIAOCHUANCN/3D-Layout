/**
 * regionGraph（W05，SPEC §3.3）——一个区域的私有任务循环。
 *
 * 拓扑（静态节点名，可用原生/loose builder）：
 *   prepare（取本任务 task_before 证据） → execute（executor 工具循环）
 *     → judge（同视角 after 证据 + 判定） → 通过则 advance，未过则回到 execute（修正轮）
 *     → 修正轮用尽则 finishFail（本区终局失败）
 *
 * 语义要点：
 * - 修正轮重新执行前**不重新取基线**：同视角 before/after 才是可比证据；
 * - 每项任务独立取 task_before，所以"同区第二项任务的即时基线"不覆盖整轮 baseline；
 * - 子图终态写共享通道 `regionResults`，父图用 mergeKeyedNoLWW 合并（禁止 LWW）。
 */

import type { ExecutionStateView, GeometryResult, Observation, TaskResult, UnitTask, Verdict, WorkflowContext, ModelPort, CoAgentConfig, Region, ModelCatalogEntry } from '../contracts'
import { END, START } from '@langchain/langgraph'
import { CoAgentError } from '../contracts'
import { judgeTask, repairSuggestionsOf, taskPassed } from '../agents/judge'
import { runExecutor } from '../agents/executor'
import type { ToolRegistry } from '../tools/registry'
import { captureWith, regionCamera } from '../tools/cameraTools'
import { Annotation } from '@langchain/langgraph'
import { looseGraph } from './state'
import { logError, logStage, logWarn } from '../runtime/runLog'
import { prioritizeAnnotationIds } from '../services/annotation'

const RegionState = Annotation.Root({
  regionId: Annotation<string>({ reducer: (_l, r) => r, default: () => '' }),
  index: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  repairs: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  feedback: Annotation<string[]>({ reducer: (_l, r) => r, default: () => [] }),
  writes: Annotation<{ created: string[]; modified: string[] }>({
    reducer: (_l, r) => r,
    default: () => ({ created: [], modified: [] }),
  }),
  executionEvidence: Annotation<string[]>({ reducer: (_l, r) => r, default: () => [] }),
  /** 本任务的 task_before 证据 id 与其中对象指纹（交给 executor，写入可直接引用） */
  baselineObservationId: Annotation<string | null>({ reducer: (_l, r) => r, default: () => null }),
  baselineFingerprints: Annotation<Record<string, string>>({ reducer: (_l, r) => r, default: () => ({}) }),
  taskVerdicts: Annotation<Record<string, Verdict[]>>({
    reducer: (l, r) => ({ ...l, ...r }),
    default: () => ({}),
  }),
  route: Annotation<string>({ reducer: (_l, r) => r, default: () => 'advance' }),
  failureReason: Annotation<string | null>({ reducer: (_l, r) => r, default: () => null }),
  regionResults: Annotation<Record<string, { regionId: string; status: 'pass' | 'fail' | 'cancelled'; tasks: TaskResult[] }>>({
    reducer: (l, r) => ({ ...l, ...r }),
    default: () => ({}),
  }),
  trace: Annotation<Array<{ type: string; at: number; note?: string }>>({
    reducer: (l, r) => l.concat(r),
    default: () => [],
  }),
})

export type RegionStateType = typeof RegionState.State

export interface RegionGraphDeps {
  context: WorkflowContext
  model: ModelPort
  registry: ToolRegistry
  config: CoAgentConfig
  region: Region
  runId: string
}

/**
 * 选给执行器的模型库候选（add 任务用）。
 *
 * 顺序：① 本区已有对象正在用的 ref（最贴近"再添一个同款"）→ ② 其余库里资产（兜底）。
 * 数量封顶，避免上下文膨胀。
 */
function pickCatalogCandidates(
  context: WorkflowContext,
  regionObjectIds: string[],
): ModelCatalogEntry[] {
  const snap = context.editorRead.snapshot({ objectIds: regionObjectIds, includeCatalog: true })
  const all = snap.catalog ?? []
  if (all.length === 0) return []
  const byRef = new Map(all.map(c => [c.ref, c]))
  const usedRefs: string[] = []
  for (const a of snap.assets) {
    if (!usedRefs.includes(a.ref) && byRef.has(a.ref)) usedRefs.push(a.ref)
  }
  const picked = [...usedRefs, ...all.map(c => c.ref).filter(r => !usedRefs.includes(r))].slice(0, 8)
  return picked
    .map(ref => byRef.get(ref))
    .filter((c): c is NonNullable<typeof c> => !!c)
}

export function buildRegionGraph(deps: RegionGraphDeps, tasks: UnitTask[], baselines: string[]) {
  const { context, model, registry, config, region, runId } = deps
  const camera = regionCamera(region)

  // W08.1 修复：计划只覆盖部分区域时，dispatch 仍会为每个区域建子图；
  // 空任务区若走 prepare → taskAt(0) 会内部报错。这里显式返回"无任务"终态。
  if (tasks.length === 0) {
    const empty = looseGraph<RegionStateType>(RegionState, { runId, regionId: region.id, emit: context.emit })
    empty.addNode('noTasks', () => ({
      regionResults: {
        [region.id]: { regionId: region.id, status: 'pass' as const, tasks: [] },
      },
      trace: [{ type: 'noTasks', at: Date.now(), note: `${region.id} 无任务` }],
    }))
    empty.addEdge(START, 'noTasks')
    empty.addEdge('noTasks', END)
    return empty.compile()
  }
  const readonly = region.objectIds.filter(id => context.partition.globalReadonlyObjectIds.includes(id))
  const writable = region.objectIds.filter(id => !readonly.includes(id))
  /**
   * add 任务要用的模型库候选（真机实测 2026-10-22：不给的话执行器只能靠 library.search
   * 反复猜关键词，把 6 轮预算耗在检索上 → budget_exceeded）。
   * 优先给**本区已有对象正在用的 ref**（"再添一个料箱"就该用现有料箱的 ref），
   * 再补几个同类目的兜底。数量有限，避免上下文膨胀。
   */
  const catalogCandidates = pickCatalogCandidates(context, region.objectIds)
  const results: TaskResult[] = []
  let currentBaseline: Observation | null = null
  let currentAfter: Observation | null = null
  let currentGeometry: GeometryResult | undefined

  const taskAt = (state: RegionStateType): UnitTask => {
    const task = tasks[state.index]
    if (!task) throw new CoAgentError('internal_error', `区域 ${region.id} 任务下标越界：${state.index}`)
    return task
  }

  /** 当前存活对象 id（一次快照内取全，供台账过滤） */
  const liveIds = (): Set<string> => new Set(context.editorRead.snapshot({}).assets.map(a => a.id))

  /**
   * P1：构造交给执行器的"当前事实"。
   *
   * 每轮都用**同一份新快照**生成，所以修复轮拿到的是对象的当前指纹，
   * 而不是 prepare 时冻结的旧基线指纹（那会让写入一路 stale_object）。
   */
  const buildExecutionState = (task: UnitTask, state: RegionStateType, latest: string | null): ExecutionStateView => {
    const snap = context.editorRead.snapshot({})
    const live = new Set(snap.assets.map(a => a.id))
    const ledger = context.runState.getTaskLedger(task.id, live)
    const created = (ledger?.liveCreatedObjectIds ?? state.writes.created).filter(id => live.has(id))
    const modified = (ledger?.modifiedObjectIds ?? state.writes.modified).filter(id => live.has(id))
    const ids = [...new Set([...task.targetObjectIds, ...created, ...modified])].filter(id => live.has(id))
    const MAX_OBJECTS = 20
    const byId = new Map(snap.assets.map(a => [a.id, a]))
    const createdSet = new Set(created)
    const modifiedSet = new Set(modified)
    const objects: ExecutionStateView['objects'] = []
    for (const id of ids.slice(0, MAX_OBJECTS)) {
      const a = byId.get(id)
      if (!a) continue
      objects.push({
        id,
        ref: a.ref,
        transform: a.transform,
        fingerprint: a.fingerprint,
        role: createdSet.has(id) ? 'created' : modifiedSet.has(id) ? 'modified' : 'target',
      })
    }
    return {
      phase: state.repairs > 0 ? 'repair' : 'initial',
      attempt: state.repairs + 1,
      sceneRevision: snap.sceneRevision,
      creationTarget: task.creationTarget ?? null,
      liveCreatedObjectIds: created,
      remainingAddCapacity: ledger?.remainingAddCapacity ?? null,
      objects,
      removedObjectIds: ledger?.removedObjectIds ?? [],
      allowedObjectIds: [...new Set([...created, ...modified, ...task.targetObjectIds])].filter(id => live.has(id)),
      baselineObservationId: state.baselineObservationId,
      latestObservationId: latest,
      problems: state.feedback,
      truncated: ids.length > MAX_OBJECTS,
    }
  }

  // W10：regionId 带上后，节点事件名会变成 `A/prepare` / `A/execute`，图页可折叠到 region-A 节点
  const graph = looseGraph<RegionStateType>(RegionState, { runId, regionId: region.id, emit: context.emit })

  graph.addNode('prepare', async (state: RegionStateType) => {
    const task = taskAt(state)
    context.emit({ type: 'task.started', runId, taskId: task.id, regionId: region.id, payload: { index: state.index, repair: state.repairs } })
    currentBaseline = await captureWith(context, {
      runId,
      camera,
      phase: 'task_before',
      objectIds: prioritizeAnnotationIds({ created: state.writes.created, targets: task.targetObjectIds, environment: writable }),
      marked: true,
      taskId: task.id,
      regionId: region.id,
    })
    logStage(
      'region.prepare',
      `[${region.id}/${task.id}] 第 ${state.repairs + 1} 次执行，task_before 证据 ${currentBaseline.id}`,
      `对象 ${prioritizeAnnotationIds({ created: state.writes.created, targets: task.targetObjectIds, environment: writable }).join(', ')}`,
    )
    context.emit({
      type: 'baseline.ready',
      runId,
      taskId: task.id,
      regionId: region.id,
      payload: { observationId: currentBaseline.id, phase: 'task_before', baselines },
    })
    return {
      baselineObservationId: currentBaseline.id,
      baselineFingerprints: { ...currentBaseline.observedObjectFingerprints },
      trace: [{ type: 'prepare', at: Date.now(), note: `${task.id} 第 ${state.repairs + 1} 次执行` }],
    }
  })

  graph.addNode('execute', async (state: RegionStateType) => {
    const task = taskAt(state)
    // P1：进入本轮前先刷新阶段与尝试次数，再按**当前**快照生成执行上下文
    context.runState.setPhase(task.id, state.repairs > 0 ? 'repair' : 'initial', state.repairs + 1)
    const latestEvidence = state.executionEvidence.at(-1) ?? state.baselineObservationId
    const executionState = buildExecutionState(task, state, latestEvidence)
    if (executionState.phase === 'repair') {
      logStage(
        'repair.start',
        `[${region.id}/${task.id}] 第 ${executionState.attempt} 次执行（修正）：存活新增 ${executionState.liveCreatedObjectIds.length}，剩余名额 ${executionState.remainingAddCapacity ?? '不限'}`,
        [
          ...(executionState.liveCreatedObjectIds.length > 0
            ? [`已创建仍在：${executionState.liveCreatedObjectIds.join(', ')}`]
            : []),
          ...(executionState.problems.length > 0 ? ['待解决问题：', ...executionState.problems.map(p => `- ${p}`)] : []),
        ].join('\n'),
      )
    }
    let output
    try {
      output = await runExecutor({
        task,
        context,
        registry,
        model,
        signal: context.signal,
        config,
        runId,
        regionObjectIds: writable,
        readonlyObjectIds: readonly,
        ...(state.baselineObservationId !== null ? { baselineObservationId: state.baselineObservationId } : {}),
        ...(Object.keys(state.baselineFingerprints).length > 0 ? { baselineFingerprints: state.baselineFingerprints } : {}),
        ...(catalogCandidates.length > 0 ? { catalog: catalogCandidates } : {}),
        ...(state.feedback.length > 0 ? { feedback: state.feedback } : {}),
        executionState,
      })
    } catch (e) {
      // 区域子图并行执行：主图那个共享的 `stage` 变量会被后完成的区覆盖，
      // 定位不到真正出错的那个区。错误自带 regionId，主图优先用它。
      const err = CoAgentError.from(e)
      logError(
        'region.execute',
        `[${region.id}/${task.id}] 执行器失败：${err.code} ${err.message}`,
        (err.stack ?? '').split('\n').slice(0, 10).join('\n'),
        err.details,
      )
      throw new CoAgentError(err.code, err.message, {
        retryable: err.retryable,
        details: { ...(err.details ?? {}), regionId: region.id, taskId: task.id, stage: 'execute' },
        cause: err,
      })
    }

    const created: string[] = []
    const modified: string[] = []
    for (const { call, result } of output.toolResults) {
      if (!result.ok) continue
      if (call.name === 'edit.add') created.push((result.data as { objectId: string }).objectId)
      if (call.name === 'edit.transform' || call.name === 'edit.remove') {
        const id = (result.data as { objectId: string }).objectId
        modified.push(id)
      }
    }
    // W08.4：修正轮不重置写集/执行证据；否则第一轮 add 的对象在 TaskResult 里会丢
    logStage(
      'region.execute',
      `[${region.id}/${task.id}] 执行结束：${output.toolCalls} 次工具调用，stop=${output.stopReason}，新增 ${created.length} / 修改 ${modified.length}，证据 ${output.evidenceIds.length} 条`,
      output.text,
    )
    return {
      writes: {
        created: [...new Set([...state.writes.created, ...created])],
        modified: [...new Set([...state.writes.modified, ...modified])],
      },
      executionEvidence: [...new Set([...state.executionEvidence, ...output.evidenceIds])],
      trace: [{ type: 'execute', at: Date.now(), note: task.id }],
    }
  })

  graph.addNode('judge', async (state: RegionStateType) => {
    const task = taskAt(state)
    if (!currentBaseline) throw new CoAgentError('internal_error', '缺少 task_before 证据（prepare 未运行）')

    currentAfter = await captureWith(context, {
      runId,
      camera,
      phase: 'after',
      objectIds: prioritizeAnnotationIds({ created: state.writes.created, modified: state.writes.modified, targets: task.targetObjectIds, environment: writable }),
      marked: true,
      taskId: task.id,
      regionId: region.id,
    })
    logStage('region.judge', `[${region.id}/${task.id}] after 证据 ${currentAfter.id}`, `${currentAfter.width}×${currentAfter.height}，标注对象 ${currentAfter.labels.length} 个`)

    currentGeometry = undefined
    if (task.constraints.some(c => c.kind === 'no_collision')) {
      // W08.1：add 任务的目标是"本轮新增对象"，不能只看 targetObjectIds（通常为空）
      // P1：移动/删除过的对象也要复检（旧实现漏掉 modified）
      const writeIds = [...new Set([...task.targetObjectIds, ...state.writes.created, ...state.writes.modified])]
      currentGeometry = await context.render.geometry(
        {
          objectIds: writeIds.filter(id => !currentAfter?.labels.find(l => l.objectId === id && l.visibility === 'uncertain')),
          staticObjectIds: region.objectIds.filter(id => !writeIds.includes(id)),
          contactToleranceM: 0.02,
          allowGroundContact: true,
        },
        context.signal,
      )
      logStage(
        'region.judge',
        `[${region.id}/${task.id}] 几何检测：${currentGeometry.status}（level=${currentGeometry.highestLevel}，${currentGeometry.pairs.length} 对）`,
        currentGeometry.pairs
          .filter(p => p.status !== 'clear')
          .map(p => `- ${p.a} × ${p.b}：${p.status}${p.note ? `（${p.note}）` : ''}`)
          .join('\n'),
      )
      context.emit({ type: 'tool.finished', runId, taskId: task.id, regionId: region.id, payload: { geometry: currentGeometry.status } })
    }

    // P1：数量验收看"仍存活的新增对象"，不是累计创建历史、也不是区域总量
    const liveNow = liveIds()
    const ledger = context.runState.getTaskLedger(task.id, liveNow)
    const liveCreated = (ledger?.liveCreatedObjectIds ?? state.writes.created).filter(id => liveNow.has(id))
    const judged = await judgeTask({
      task,
      runId,
      before: currentBaseline,
      after: currentAfter,
      ...(state.executionEvidence.length > 0 ? { extraEvidenceIds: state.executionEvidence } : {}),
      // W08.1：add 任务没有 targetObjectIds，区域/计数检查必须知道本轮新增对象
      ...(liveCreated.length > 0 ? { createdObjectIds: liveCreated } : {}),
      ...(currentGeometry ? { geometry: currentGeometry } : {}),
      model,
      signal: context.signal,
      config,
      context,
    })

    context.emit({ type: 'verdict.ready', runId, taskId: task.id, regionId: region.id, payload: { status: judged.verdict.status, credible: judged.credible } })
    logStage(
      'region.judge',
      `[${region.id}/${task.id}] 判定：${judged.verdict.status}（可信=${judged.credible}）`,
      [
        ...judged.verdict.criteria.map(c => `- 判据 ${c.criterionId}：${c.status} — ${c.reason}`),
        ...(judged.issues.length > 0 ? ['', '代码侧问题：', ...judged.issues.map(i => `- ${i}`)] : []),
        ...(judged.verdict.repairSuggestions.length > 0
          ? ['', '修正建议：', ...judged.verdict.repairSuggestions.map(s => `- ${s}`)]
          : []),
      ].join('\n'),
      judged.verdict,
    )

    const verdicts = [...(state.taskVerdicts[task.id] ?? []), judged.verdict]
    const passedNow = taskPassed(judged)
    const canRepair = !passedNow && state.repairs < config.maxRepairsPerTask
    // W08.5：记录判定时的相关对象指纹，终检据此判断后续编辑是否改过它们
    const relevant = [...new Set([...task.targetObjectIds, ...state.writes.created, ...liveCreated])]
    const judgedFingerprints = Object.fromEntries(
      context.editorRead.snapshot({ objectIds: relevant }).assets.map(a => [a.id, a.fingerprint]),
    )
    const taskResult: TaskResult = {
      taskId: task.id,
      status: passedNow ? 'pass' : 'fail',
      verdicts,
      // 累计创建历史（审计）；"此刻还剩几个"看 liveCreatedObjectIds
      createdObjectIds: state.writes.created,
      modifiedObjectIds: state.writes.modified,
      liveCreatedObjectIds: liveCreated,
      removedObjectIds: ledger?.removedObjectIds ?? [],
      evidenceIds: [...new Set([currentBaseline.id, currentAfter.id, ...state.executionEvidence])],
      baselineObservationId: currentBaseline.id,
      judgedFingerprints,
    }
    if (passedNow || !canRepair) {
      results[state.index] = taskResult
    }

    return {
      taskVerdicts: { [task.id]: verdicts },
      route: passedNow ? 'advance' : canRepair ? 'execute' : 'fail',
      feedback: canRepair ? repairSuggestionsOf(judged) : [],
      repairs: canRepair ? state.repairs + 1 : state.repairs,      ...(passedNow || !canRepair
        ? { trace: [{ type: 'judge', at: Date.now(), note: `${task.id} ${passedNow ? 'pass' : 'fail'}` }] }
        : { trace: [{ type: 'judge', at: Date.now(), note: `${task.id} fail → 修正轮 ${state.repairs + 1}` }] }),
    }
  })

  graph.addNode('advance', async (state: RegionStateType) => {
    const next = state.index + 1
    const done = next >= tasks.length
    if (done) {
      context.emit({ type: 'task.finished', runId, regionId: region.id, payload: { tasks: results.length, status: 'pass' } })
    }
    logStage(
      'region.advance',
      `[${region.id}] ${tasks[state.index]?.id ?? '?'} 通过，${done ? '本区全部任务完成' : `推进到第 ${next + 1}/${tasks.length} 个任务`}`,
    )
    return {
      index: next,
      repairs: 0,
      feedback: [],
      // P1：切换任务必须清空本任务写集与执行证据。
      // writes 的 reducer 是"替换"语义，这里显式给空值才是清空；不给就会沿用上一任务的值。
      writes: { created: [], modified: [] },
      executionEvidence: [],
      route: done ? 'end' : 'next',
      ...(done
        ? {
            regionResults: {
              [region.id]: {
                regionId: region.id,
                status: 'pass' as const,
                tasks: results.map(r => r ?? ({ taskId: 'unknown', status: 'skipped' as const, verdicts: [], createdObjectIds: [], modifiedObjectIds: [], evidenceIds: [] } as TaskResult)),
              },
            },
            trace: [{ type: 'advance', at: Date.now(), note: `${region.id} 全部任务通过` }],
          }
        : {}),
    }
  })

  graph.addNode('finishFail', async (state: RegionStateType) => {
    const task = taskAt(state)
    // P1：补齐 judgedFingerprints——缺它会让终检的视觉重判直接跳过（mainGraph 有 `if (!judgedFingerprints) return`）
    const liveNow = liveIds()
    const ledger = context.runState.getTaskLedger(task.id, liveNow)
    const relevant = [...new Set([...task.targetObjectIds, ...state.writes.created, ...(ledger?.liveCreatedObjectIds ?? [])])].filter(
      id => liveNow.has(id),
    )
    const failedFingerprints = Object.fromEntries(
      context.editorRead.snapshot({ objectIds: relevant }).assets.map(a => [a.id, a.fingerprint]),
    )
    const failed: TaskResult =
      results[state.index] ?? {
        taskId: task.id,
        status: 'fail',
        verdicts: state.taskVerdicts[task.id] ?? [],
        createdObjectIds: state.writes.created,
        modifiedObjectIds: state.writes.modified,
        liveCreatedObjectIds: ledger?.liveCreatedObjectIds ?? state.writes.created.filter(id => liveNow.has(id)),
        removedObjectIds: ledger?.removedObjectIds ?? [],
        evidenceIds:
          currentBaseline && currentAfter
            ? [...new Set([currentBaseline.id, currentAfter.id, ...state.executionEvidence])]
            : [...state.executionEvidence],
        ...(currentBaseline ? { baselineObservationId: currentBaseline.id } : {}),
        judgedFingerprints: failedFingerprints,
      }
    context.emit({ type: 'task.finished', runId, taskId: task.id, regionId: region.id, payload: { status: 'fail' } })
    logWarn(
      'region.fail',
      `[${region.id}/${task.id}] 修正 ${config.maxRepairsPerTask} 轮后仍未通过（本区终局失败）`,
      (state.taskVerdicts[task.id] ?? [])
        .map((v, i) => `- 第 ${i + 1} 次判定：${v.status}；建议 ${v.repairSuggestions.slice(0, 3).join('；')}`)
        .join('\n'),
    )
    // P1：保留本区此前已完成的任务，并把未执行任务显式标成 skipped（旧实现只返回 [failed]，历史成果全丢）
    const earlier = results.filter((r): r is TaskResult => Boolean(r) && r.taskId !== task.id)
    const skipped: TaskResult[] = tasks.slice(state.index + 1).map(t => ({
      taskId: t.id,
      status: 'skipped' as const,
      verdicts: [],
      createdObjectIds: [],
      modifiedObjectIds: [],
      evidenceIds: [],
    }))
    return {
      failureReason: `区域 ${region.id} 任务 ${task.id} 修正 ${config.maxRepairsPerTask} 轮后仍未通过`,
      regionResults: {
        [region.id]: { regionId: region.id, status: 'fail' as const, tasks: [...earlier, failed, ...skipped] },
      },
      route: 'end',
      trace: [{ type: 'fail', at: Date.now(), note: `${region.id} 终局失败` }],
    }
  })

  graph.addEdge(START, 'prepare')
  graph.addEdge('prepare', 'execute')
  graph.addEdge('execute', 'judge')
  graph.addConditionalEdges('judge', (state: RegionStateType) => (state.route === 'execute' ? 'execute' : state.route === 'fail' ? 'finishFail' : 'advance'))
  graph.addConditionalEdges('advance', (state: RegionStateType) => (state.route === 'next' ? 'prepare' : END))
  graph.addEdge('finishFail', END)

  return graph.compile()
}

/** 供断言：区域结果里所有任务是否都 pass（父图 finalCheck 也用它） */
export function regionPassed(result: { status: string; tasks: TaskResult[] } | undefined): boolean {
  return Boolean(result && result.status === 'pass' && result.tasks.every(t => t.status === 'pass'))
}
