/**
 * runController（W03，SPEC §3.2）——一轮用户请求的唯一编排者。
 *
 * 职责：就绪校验（宿主 idle/分区/重复 start）、合作式编辑资格、冻结分区与配置、
 * runId/AbortController、武装唯一事务（惰性 begin 在 writeFacade 内）、运行注入的
 * workflow、终态提交/回滚/保存/清理；对外最多一个活跃 run。
 *
 * 相位（W03 粗粒度）：idle → executing → committing → completed /
 * rolled_back / failed / error_locked / awaiting_clarification。
 * W05 起由工作流事件细化 planning/baselining/validating。
 *
 * 取消语义（§5.4）：cancel 只 abort 信号；迟到模型回调经 context.applyWrite 的
 * signal 检查与令牌失效双重拦截，不产生取消后写入。
 */

import type {
  CaptureRequest,
  CoAgentConfig,
  CoAgentPhase,
  EditorReadPort,
  EditorWritePort,
  EditReceipt,
  ImageId,
  ModelPort,
  Observation,
  ObservationId,
  PartitionSnapshot,
  RenderPort,
  RunInput,
  RunHistoryRef,
  RunOutcome,
  SceneSnapshot,
  ToolResult,
  TransformDTO,
  WorkflowContext,
  WorkflowRunner,
} from '../contracts'
import { CoAgentError } from '../contracts'
import type { Scheduler } from './scheduler'
import type { Recorder } from './recorder'
import { beginRunLog, eventsTable, finishRunLog, logStage, logWarn } from './runLog'
import { createRunState } from './runState'
import { createRegionViews } from './regionViews'

export interface RunControllerDeps {
  editorRead: EditorReadPort
  editorWrite: EditorWritePort
  scheduler: Scheduler
  recorder: Recorder
  config: CoAgentConfig
  /** 创建每轮使用的 workflow（W03 注入已知 transform 假 workflow；W05+ 真 mainGraph） */
  workflowFactory: () => WorkflowRunner
  /** 合作式编辑资格：宿主其它写者（旧 Agent 等）忙碌时拒绝新 run */
  isHostBusy: () => boolean
  /** 冻结前的分区来源（W06 前生产装配返回 null；测试注入） */
  partitionProvider: () => PartitionSnapshot | null
  /** 模型端口（W06 前为"未装配"桩，调用即明确报错） */
  modelPort: ModelPort
  /**
   * 观测服务（W04）：一次 capture 的完整口径在 services/observations 内
   * （ready → 渲染捕获 → 证据登记）。桥未挂载时由它抛 bridge_unavailable。
   */
  observations: {
    capture(request: CaptureRequest, signal: AbortSignal, partitionVersion: number): Promise<Observation>
    get(id: ObservationId): Observation | undefined
  }
  /** W05：图内的只读渲染能力（ready/geometry）——未挂桥时给明确报错的桩 */
  getRenderPort: () => RenderPort | null
  /** W08.2：证据图 dataURL（判定/执行送模型）；实现来自 evidenceStore */
  getImageDataUrl: (imageId: ImageId) => Promise<string | null>
  /** 相位投影出口（uiStore 订阅；不反向驱动） */
  onPhase: (phase: CoAgentPhase, info: { runId: string | null; note?: string }) => void
  /** 脱敏后的模型配置摘要（写进运行日志头部；不得含 key） */
  modelLabel?: () => string
  /**
   * P4：提交+保存之后的收尾钩子（分区落盘）。
   * `snapshot` 是**保存场景之前**取的同一份快照，用于保证两个文件描述同一时刻。
   */
  afterCommit?: (info: {
    snapshot: SceneSnapshot
    saved: { mode: 'server' | 'download'; version: number } | null
    saveError?: string
  }) => Promise<void>
}

/** 运行终态的日志摘要（写进日志头部与结果明细） */
function describeOutcome(outcome: RunOutcome | null): string {
  if (!outcome) return '未产出 outcome（工作流异常中断）'
  if (outcome.kind === 'completed') return `completed：${outcome.summary}`
  if (outcome.kind === 'retained_with_issues') {
    return `retained_with_issues：已保留修改，${outcome.issues.length} 个未通过项（${outcome.summary}）`
  }
  if (outcome.kind === 'needs_clarification') return `needs_clarification：${outcome.question}`
  if (outcome.kind === 'rolled_back') {
    const stage = outcome.reason.details?.stage
    return `rolled_back（${outcome.reason.code}${typeof stage === 'string' ? ` @${stage}` : ''}）：${outcome.reason.message}`
  }
  return 'cancelled'
}

const ACTIVE_PHASES: ReadonlySet<CoAgentPhase> = new Set<CoAgentPhase>([
  'preprocessing',
  'planning',
  'awaiting_clarification',
  'baselining',
  'executing',
  'validating',
  'committing',
  'cancelling',
])

export function isActivePhase(phase: CoAgentPhase): boolean {
  return ACTIVE_PHASES.has(phase)
}

/** W06 前的模型端口桩：调用即失败，错误可读（不假装可用） */
export function createUnavailableModelPort(reason: string): ModelPort {
  return {
    async complete() {
      throw new CoAgentError('model_protocol_error', reason)
    },
  }
}

/** W05：图内看到的 RenderPort —— 未挂桥时所有调用都明确报 bridge_unavailable */
export function createUnavailableRenderPort(reason: string): RenderPort {
  const fail = async (): Promise<never> => {
    throw new CoAgentError('bridge_unavailable', reason)
  }
  return {
    ready: fail,
    capture: fail,
    geometry: fail,
  }
}

interface ActiveRun {
  runId: string
  abort: AbortController
  settle: Promise<ToolResult<RunOutcome>>
}

export interface RunController {
  start(request: string): Promise<ToolResult<RunOutcome>>
  /** 取消当前 run 并等它完全落定（含回滚与清理） */
  cancel(): Promise<void>
  /** 模块卸载路径：取消 + 清理 + 禁止新 run */
  requestDisable(): Promise<void>
  /** 重新装配（StrictMode 重挂载/宿主重新启用）：disabled → idle；锁定与活跃 run 不受影响 */
  enable(): void
  phase(): CoAgentPhase
  /** error_locked 后须重置才能再次运行 */
  locked(): boolean
  /** P3：最近一次可撤销的编辑历史引用（没有实际写入时为 null） */
  lastHistoryRef(): RunHistoryRef | null
  /** P3：撤销最近一轮的修改（只支持栈顶；其后有编辑则拒绝） */
  undoLastRun(): { ok: boolean; message?: string }
  /**
   * 人工解锁（§5.4）：清 error_locked → idle；有活跃 run 时拒绝。
   * 不自动恢复被回滚失败的资产，只解除"禁止新 run"的闸门，并要求操作者已看过日志。
   */
  reset(): ToolResult<null>
  /** 供 createRuntime 组装 bridge 注册（W04） */
  emitPhase(phase: CoAgentPhase, note?: string): void
}

export function createRunController(deps: RunControllerDeps): RunController {
  let phase: CoAgentPhase = 'idle'
  let locked = false
  let active: ActiveRun | null = null
  let runCounter = 0
  /** 最近一次 runId：解锁事件挂在它名下，便于按 run 追溯（§5.5） */
  let lastRunId: string | null = null
  /** P3：最近一轮可撤销的历史引用 */
  let lastHistoryRef: RunHistoryRef | null = null

  const setPhase = (p: CoAgentPhase, note?: string): void => {
    const from = phase
    phase = p
    // 相位也是诊断信息：日志里能看到"卡在哪个相位"，与时间线对齐
    logStage('phase', `${from} → ${p}`, note)
    deps.onPhase(p, { runId: active?.runId ?? null, ...(note !== undefined ? { note } : {}) })
  }

  return {
    phase: () => phase,
    locked: () => locked,
    emitPhase: (p, note) => setPhase(p, note),
    lastHistoryRef: () => lastHistoryRef,
    undoLastRun: () => {
      if (active) return { ok: false, message: '有活跃 run，暂不能撤销' }
      const ref = lastHistoryRef
      if (!ref) return { ok: false, message: '没有可撤销的本轮修改' }
      const eligibility = deps.editorWrite.queryUndo(ref)
      if (!eligibility.eligible) return { ok: false, ...(eligibility.reason ? { message: eligibility.reason } : {}) }
      const res = deps.editorWrite.undoRun(ref)
      if (!res.ok) return res
      // 同一事务只能撤一次：成功即失效
      lastHistoryRef = null
      deps.recorder.append({
        type: 'run.undone',
        runId: ref.runId,
        payload: { transactionId: ref.transactionId },
      })
      logStage('undo', `已撤销 ${ref.runId} 的修改（事务 #${ref.transactionId}）`)
      return { ok: true }
    },

    async start(request: string): Promise<ToolResult<RunOutcome>> {
      if (locked) {
        return { ok: false, error: new CoAgentError('run_busy', 'runtime 处于 error_locked，需重置后才能继续').toToolError() }
      }
      if (active) {
        return { ok: false, error: new CoAgentError('run_busy', `已有活跃 run（${active.runId}）`).toToolError() }
      }
      if (phase === 'disabled') {
        return { ok: false, error: new CoAgentError('run_busy', '模块已禁用').toToolError() }
      }
      if (deps.isHostBusy()) {
        return { ok: false, error: new CoAgentError('run_busy', '宿主其它编辑者忙碌（旧 Agent 任务中）').toToolError() }
      }
      const partition = deps.partitionProvider()
      if (!partition) {
        return {
          ok: false,
          error: new CoAgentError('invalid_plan', '分区未准备（预处理属于 W06；测试可经 debugSetPartition 注入）').toToolError(),
        }
      }

      // ---- 冻结本轮输入（分区快照深拷贝，§2.3） ----
      const runId = `run-${Date.now().toString(36)}-${++runCounter}`
      lastRunId = runId
      const frozenPartition: PartitionSnapshot = JSON.parse(JSON.stringify(partition)) as PartitionSnapshot
      const abort = new AbortController()
      const snapshotStart = deps.editorRead.snapshot({}).sceneRevision

      const token = deps.editorWrite.beginRun(`CoAgent：${request.slice(0, 40)}`)
      // 冻结写权限集合：各区对象 - 共享只读对象；run 内新增对象动态加入
      const writable = new Set<string>()
      const readonlyIds = new Set(frozenPartition.globalReadonlyObjectIds)
      for (const region of frozenPartition.regions) {
        for (const id of region.objectIds) {
          if (!readonlyIds.has(id)) writable.add(id)
        }
      }
      // P1：run 级台账。任务在规划校验通过后经 context.runState.registerTasks 登记。
      const runState = createRunState({ runId, readonlyObjectIds: [...readonlyIds] })
      // P2：每区工作相机状态（本轮内有效；随 run 结束丢弃）
      const regionViews = createRegionViews()

      // ---- 本轮日志（诊断）：一轮运行 = logs/CoAgent 下的一份 md ----
      let modelLabel = ''
      try {
        modelLabel = deps.modelLabel?.() ?? ''
      } catch {
        modelLabel = ''
      }
      beginRunLog({
        kind: 'run',
        runId,
        request,
        partition: frozenPartition,
        config: deps.config,
        ...(modelLabel ? { model: modelLabel } : {}),
      })
      logStage(
        'run.start',
        `新运行 ${runId}`,
        [
          `场景版本（开始）：${snapshotStart}`,
          `分区：v${frozenPartition.partitionVersion}，${frozenPartition.regions.length} 个区（${frozenPartition.regions
            .map(r => `${r.id}:${r.objectIds.length}`)
            .join('，')}）`,
          `可写对象：${writable.size} 个；跨区只读：${readonlyIds.size} 个`,
        ].join('\n'),
      )

      const context: WorkflowContext = {
        signal: abort.signal,
        model: deps.modelPort,
        // W05：图内只读渲染能力（几何/就绪）；未挂桥时是明确报错的桩，不装成可用
        render:
          deps.getRenderPort() ??
          createUnavailableRenderPort('渲染桥未挂载（CoAgentBridge 不在 Canvas 内）'),
        editorRead: deps.editorRead,
        partition: frozenPartition,
        config: deps.config,
        runState,
        regionViews,
        emit: event => {
          deps.recorder.append({ ...event, runId })
        },
        capture: async req => {
          // 冻结口径由调用方（runtime）提供：渲染层不许读编辑器状态（§2.2）
          const sceneRevision = deps.editorRead.snapshot({ objectIds: [] }).sceneRevision
          const fingerprints: Record<string, string> = {}
          const expectedTransforms: Record<string, TransformDTO> = {}
          if (req.objectIds.length > 0) {
            for (const a of deps.editorRead.snapshot({ objectIds: req.objectIds }).assets) {
              fingerprints[a.id] = a.fingerprint
              expectedTransforms[a.id] = a.transform
            }
          }
          return deps.observations.capture(
            { ...req, runId, sceneRevision, fingerprints, expectedTransforms },
            abort.signal,
            frozenPartition.partitionVersion,
          )
        },
        getObservation: id => deps.observations.get(id),
        getImageDataUrl: imageId => deps.getImageDataUrl(imageId),
        applyWrite: async (command, call) => {
          // P1：检查与登记都必须在场景队列**内部**完成。
          // 旧实现只在入队前看 signal，排队期间的取消/状态变化一律拦不住。
          const result = await deps.scheduler.runScene((): ToolResult<EditReceipt> => {
            if (abort.signal.aborted) {
              return { ok: false, error: new CoAgentError('cancelled', 'run 已取消，拒绝迟到写入').toToolError() }
            }
            // 任务级规则（名额/操作声明）：幂等重放会在这里直接放行
            const rejected = runState.checkWrite(call.taskId, command, call.toolCallId)
            if (rejected) {
              deps.recorder.append({
                type: 'write.rejected',
                runId,
                ...(call.taskId !== null ? { taskId: call.taskId } : {}),
                ...(typeof call.regionId === 'string' ? { regionId: call.regionId } : {}),
                payload: { code: rejected.code, message: rejected.message, command: command.kind },
              })
              logWarn('write.rejected', `[${call.taskId ?? 'main'}] ${rejected.code}：${rejected.message}`)
              return { ok: false, error: rejected }
            }
            const written = deps.editorWrite.applyAuthorized(command, {
              runId,
              taskId: call.taskId,
              toolCallId: call.toolCallId,
              token,
              writableObjectIds: writable,
            })
            // 写成功即刻登记：正常响应绝不能先于登记返回
            if (written.ok) {
              runState.recordWrite(call.taskId, command, written.data.objectId, call.toolCallId)
              // 新增对象加入本 run 写集合（§6.2）
              if (command.kind === 'add') writable.add(written.data.objectId)
            }
            return written
          })
          return result
        },
      }

      setPhase('executing')
      const input: RunInput = {
        runId,
        request,
        partition: frozenPartition,
        sceneRevisionAtStart: snapshotStart,
      }
      deps.recorder.append({
        type: 'run.started',
        runId,
        payload: { request, regionIds: frozenPartition.regions.map(r => r.id) },
      })

      const settle = (async (): Promise<ToolResult<RunOutcome>> => {
        let outcome: RunOutcome | null = null
        try {
          try {
            outcome = await deps.workflowFactory().run(input, context)
          } catch (e) {
            if (abort.signal.aborted) {
              outcome = { kind: 'cancelled' }
            } else {
              outcome = { kind: 'rolled_back', reason: CoAgentError.from(e).toToolError() }
            }
          }
          const decided: RunOutcome = outcome
          logStage('outcome', `工作流结束：${describeOutcome(decided)}`, undefined, decided)

          // ---- 终态处理：等场景队列清空 → 提交或回滚 → 保存 → 清理 ----
          try {
            if (decided.kind === 'completed' || decided.kind === 'retained_with_issues') {
              // P3：正常结束——无论判据是否全部通过，**提交并保留**。判据结果照实上报。
              const hasIssues = decided.kind === 'retained_with_issues'
              setPhase('committing')
              await deps.scheduler.sceneIdle()
              // P3：提交必须拿回执——"有历史"由回执证明，不靠调用没抛错
              const receipt = deps.editorWrite.commitRun(token)
              if (receipt.historyTransactionId !== null) {
                lastHistoryRef = {
                  runId,
                  sceneId: deps.editorRead.snapshot({}).sceneId ?? '',
                  sceneSessionId: deps.editorWrite.sceneSessionId(),
                  transactionId: receipt.historyTransactionId,
                }
              } else {
                // 没有实际写入：不生成假的撤销入口
                lastHistoryRef = null
              }
              deps.recorder.append({
                type: 'run.committed',
                runId,
                payload: {
                  validationStatus: hasIssues ? 'issues' : 'pass',
                  ...(hasIssues ? { issueCount: decided.issues.length } : {}),
                  writes: receipt.writes,
                  ...(receipt.historyTransactionId !== null ? { historyTransactionId: receipt.historyTransactionId } : {}),
                },
              })
              setPhase(hasIssues ? 'retained' : 'completed')
              // P4：保存前取一份快照，场景与分区都用它——否则分区指纹描述的是另一个时刻
              const snapshotBeforeSave = deps.editorRead.snapshot({})
              let saved: { mode: 'server' | 'download'; version: number } | null = null
              let saveError: string | undefined
              try {
                saved = await deps.editorWrite.save()
                logStage('commit', `${hasIssues ? '已保留（存在未通过项）' : '已提交'}并保存（${saved.mode}，版本 v${saved.version}）`)
              } catch (e) {
                // 保存失败不撤销已提交修改（§3.2 recorder 同款语义）；事件记录
                saveError = e instanceof Error ? e.message : String(e)
                logWarn('commit', '已提交，但保存失败（不改变本轮结果）', saveError)
                deps.recorder.append({
                  type: 'save.failed',
                  runId,
                  payload: { message: saveError.slice(0, 200) },
                })
              }
              // 分区落盘（可选）：失败只影响持久化状态，不影响已提交的结果
              if (deps.afterCommit) {
                try {
                  await deps.afterCommit({ snapshot: snapshotBeforeSave, saved, ...(saveError ? { saveError } : {}) })
                } catch (e) {
                  logWarn('commit', '分区保存失败（结果不受影响）', e instanceof Error ? e.message : String(e))
                }
              }
            } else if (decided.kind === 'needs_clarification') {
              // 澄清不保留活跃事务（§7.1）；本 run 未产生写入则直接结束
              deps.editorWrite.endRun(token)
              setPhase('awaiting_clarification')
              logStage('outcome', '需要澄清：本轮不保留事务', decided.question)
            } else {
              // rolled_back / cancelled：回滚本轮修改
              if (decided.kind === 'cancelled') setPhase('cancelling')
              await deps.scheduler.sceneIdle()
              const ok = deps.editorWrite.rollbackRun(token)
              if (!ok) {
                locked = true
                deps.recorder.append({
                  type: 'run.failed',
                  runId,
                  payload: { reason: 'rollback_failed：回滚失败，进入 error_locked' },
                })
                deps.editorWrite.endRun(token)
                setPhase('error_locked')
                return { ok: true, data: decided }
              }
              deps.recorder.append({
                type: 'run.rolled_back',
                runId,
                payload:
                  decided.kind === 'rolled_back'
                    ? {
                        reason: decided.reason.code,
                        message: decided.reason.message,
                        ...(decided.reason.details?.stage !== undefined ? { stage: decided.reason.details.stage } : {}),
                      }
                    : { reason: 'cancelled' },
              })
              deps.editorWrite.endRun(token)
              setPhase('rolled_back')
            }
          } catch (e) {
            locked = true
            deps.recorder.append({
              type: 'run.failed',
              runId,
              payload: { reason: `terminal 阶段异常：${e instanceof Error ? e.message.slice(0, 200) : String(e)}` },
            })
            deps.editorWrite.endRun(token)
            setPhase('error_locked')
            return { ok: true, data: decided }
          }

          return { ok: true, data: decided }
        } finally {
          // P1：终态后立刻封闸——迟到写入即使绕过 signal 也会被 runState 拒绝
          runState.finish()
          // 落盘：成功/回滚/取消/异常都留同一份可读记录（附 recorder 事件表，便于对账）
          const runEvents = deps.recorder.events().filter(e => e.runId === runId)
          await finishRunLog(describeOutcome(outcome), {
            sections: [{ title: 'recorder 事件', body: eventsTable(runEvents) }],
            data: { outcome, phase },
          })
        }
      })()

      active = { runId, abort, settle }
      // 终态后清理活跃标记（start 在 settle 完成前仍应拒绝重入）
      void settle.finally(() => {
        if (active?.runId === runId) active = null
      })
      return settle
    },

    async cancel(): Promise<void> {
      if (!active) return
      logStage('cancel', `用户取消：${active.runId}`)
      active.abort.abort()
      await active.settle.catch(() => undefined)
    },

    async requestDisable(): Promise<void> {
      logStage('disable', '模块被停用/卸载（若有活跃 run 先取消）')
      if (active) {
        active.abort.abort()
        await active.settle.catch(() => undefined)
      }
      active = null
      setPhase('disabled')
    },

    enable(): void {
      // StrictMode 重挂载/宿主重新启用：仅从 disabled 复位；锁定与活跃 run 不动。
      // 锁定必须在复位后仍然可见——否则面板会把"禁止新 run"显示成普通空闲。
      if (phase === 'disabled' && !active) setPhase(locked ? 'error_locked' : 'idle')
    },

    reset(): ToolResult<null> {
      if (active) {
        return { ok: false, error: new CoAgentError('run_busy', `活跃 run（${active.runId}）中不能重置`).toToolError() }
      }
      if (!locked && phase !== 'error_locked') {
        return { ok: false, error: new CoAgentError('invalid_plan', '当前不处于 error_locked，无需重置').toToolError() }
      }
      const from = phase
      locked = false
      logStage('reset', `人工解除锁定（${from} → idle）`)
      deps.recorder.append({ type: 'runtime.reset', runId: lastRunId ?? 'runtime', payload: { from } })
      setPhase('idle')
      return { ok: true, data: null }
    },
  }
}
