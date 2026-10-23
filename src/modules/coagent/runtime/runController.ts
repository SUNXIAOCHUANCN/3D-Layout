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
  ImageId,
  ModelPort,
  Observation,
  ObservationId,
  PartitionSnapshot,
  RenderPort,
  RunInput,
  RunOutcome,
  ToolResult,
  TransformDTO,
  WorkflowContext,
  WorkflowRunner,
} from '../contracts'
import { CoAgentError } from '../contracts'
import type { Scheduler } from './scheduler'
import type { Recorder } from './recorder'

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

  const setPhase = (p: CoAgentPhase, note?: string): void => {
    phase = p
    deps.onPhase(p, { runId: active?.runId ?? null, ...(note !== undefined ? { note } : {}) })
  }

  return {
    phase: () => phase,
    locked: () => locked,
    emitPhase: (p, note) => setPhase(p, note),

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
          // 迟到回调拦截（§5.4）：信号已中止的 run 不允许再写
          if (abort.signal.aborted) {
            return { ok: false, error: new CoAgentError('cancelled', 'run 已取消，拒绝迟到写入').toToolError() }
          }
          const result = await deps.scheduler.runScene(() =>
            deps.editorWrite.applyAuthorized(command, {
              runId,
              taskId: call.taskId,
              toolCallId: call.toolCallId,
              token,
              writableObjectIds: writable,
            }),
          )
          // 新增对象加入本 run 写集合（§6.2）
          if (result.ok && command.kind === 'add') writable.add(result.data.objectId)
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
        let outcome: RunOutcome
        try {
          outcome = await deps.workflowFactory().run(input, context)
        } catch (e) {
          if (abort.signal.aborted) {
            outcome = { kind: 'cancelled' }
          } else {
            outcome = { kind: 'rolled_back', reason: CoAgentError.from(e).toToolError() }
          }
        }

        // ---- 终态处理：等场景队列清空 → 提交或回滚 → 保存 → 清理 ----
        try {
          if (outcome.kind === 'completed') {
            setPhase('committing')
            await deps.scheduler.sceneIdle()
            deps.editorWrite.commitRun(token)
            deps.recorder.append({ type: 'run.committed', runId, payload: {} })
            setPhase('completed')
            try {
              await deps.editorWrite.save()
            } catch (e) {
              // 保存失败不改变已提交结果（§3.2 recorder 同款语义）；事件记录
              deps.recorder.append({
                type: 'save.failed',
                runId,
                payload: { message: e instanceof Error ? e.message.slice(0, 200) : String(e) },
              })
            }
          } else if (outcome.kind === 'needs_clarification') {
            // 澄清不保留活跃事务（§7.1）；本 run 未产生写入则直接结束
            deps.editorWrite.endRun(token)
            setPhase('awaiting_clarification')
          } else {
            // rolled_back / cancelled：回滚本轮修改
            if (outcome.kind === 'cancelled') setPhase('cancelling')
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
              return { ok: true, data: outcome }
            }
            deps.recorder.append({
              type: 'run.rolled_back',
              runId,
              payload:
                outcome.kind === 'rolled_back'
                  ? {
                      reason: outcome.reason.code,
                      message: outcome.reason.message,
                      ...(outcome.reason.details?.stage !== undefined ? { stage: outcome.reason.details.stage } : {}),
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
          return { ok: true, data: outcome }
        }

        return { ok: true, data: outcome }
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
      active.abort.abort()
      await active.settle.catch(() => undefined)
    },

    async requestDisable(): Promise<void> {
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
      deps.recorder.append({ type: 'runtime.reset', runId: lastRunId ?? 'runtime', payload: { from } })
      setPhase('idle')
      return { ok: true, data: null }
    },
  }
}
