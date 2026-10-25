/**
 * createRuntime（W03，SPEC §3.2）——唯一装配点。
 *
 * 注入 Ports、配置、workflow factory、scheduler、recorder；测试可全部换成 fake。
 * 生产装配（useCoAgentModule）使用真实 editorAdapter；测试注入 FakeEditor +
 * 已知 transform 假 workflow。W04 起 registerRenderPort 接 CoAgentBridge，
 * W06 起换真实 modelAdapter 与分区来源。
 */

import { createEditorAdapter } from '../adapters/editorAdapter'
import type {
  CameraSnapshot,
  CaptureRequest,
  CoAgentConfig,
  CoAgentPhase,
  EditorReadPort,
  EditorWritePort,
  GeometryRequest,
  GeometryResult,
  ModelPort,
  Observation,
  ObservationPhase,
  PartitionSnapshot,
  RenderPort,
  RenderPortDiagnostics,
  RunOutcome,
  ToolResult,
  TransformDTO,
  WorkflowRunner,
} from '../contracts'
import { CoAgentError } from '../contracts'
import { DEFAULT_COAGENT_CONFIG } from '../config'
import { createWorkflow } from '../workflow/createWorkflow'
import { createObservationService, type ObservationService } from '../services/observations'
import { birdseyeCamera, blobToDataUrl, buildPartition, requestPartition, type PartitionReport } from '../services/partition'
import { createModelAdapter, currentLlmSettings, isModelConfigured, modelConfigSummary } from '../adapters/modelAdapter'
import { createEvidenceStore, type EvidenceStore, type EvidenceStoreStats } from './evidenceStore'
import { createRecorder, type Recorder } from './recorder'
import { beginGraphFeed, disposeGraphFeed } from '../graphFeed'
import { createRunController, isActivePhase, type RunController } from './runController'
import { beginRunLog, finishRunLog, logError, logStage, activeRunLog } from './runLog'
import { createScheduler, type Scheduler } from './scheduler'

export interface CoAgentRuntimeDeps {
  config?: Partial<CoAgentConfig>
  /** 生产缺省 createEditorAdapter()（真实 core）；测试传 FakeEditor */
  editor?: { read: EditorReadPort; write: EditorWritePort; dispose?(): void }
  /** 生产缺省 createWorkflow()（W05 起 = mainGraph 真实闭环）；测试注入已知 transform 假 workflow */
  workflowFactory?: () => WorkflowRunner
  /** 合作式编辑资格检查；生产由 useCoAgentModule 注入（旧 Agent phase 等） */
  isHostBusy?: () => boolean
  /** 分区来源；W06 前生产返回 null（start 给出 invalid_plan 明确指引） */
  partitionProvider?: () => PartitionSnapshot | null
  modelPort?: ModelPort
}

export interface CoAgentRuntime {
  start(request: string): Promise<ToolResult<RunOutcome>>
  cancel(): Promise<void>
  requestDisable(): Promise<void>
  /** 重新装配（hook 重挂载）：disabled → idle；锁定可见地保留为 error_locked */
  enable(): void
  /** 人工解锁 error_locked（§5.4）；活跃 run 中拒绝 */
  reset(): ToolResult<null>
  phase(): CoAgentPhase
  busy(): boolean
  locked(): boolean
  /** 冻结后的运行配置（CoAgentBridge 用它取场景就绪超时） */
  config(): Readonly<CoAgentConfig>
  /** W04：Canvas 内 CoAgentBridge 注册/注销渲染端口 */
  registerRenderPort(port: RenderPort | null): void
  /** W04：证据登记处（图片/observationId/内存上限） */
  evidence: EvidenceStore
  /** W04：观测服务（ready → 捕获 → 登记） */
  observations: ObservationService
  recorder: Recorder
  scheduler: Scheduler
  /** 相位投影订阅（uiStore 用；返回退订函数） */
  onPhase(listener: (phase: CoAgentPhase, info: { runId: string | null; note?: string }) => void): () => void
  /** 诊断（T16 生命周期：订阅数不能随 mount/unmount 增长） */
  diagnostics(): { phaseListeners: number; disposed: boolean }
  /** W04 诊断：真实渲染端口自检（未挂桥时 null） */
  renderDiagnostics(): RenderPortDiagnostics | null
  /** W08.3：dev/E2E 限定——直接走真实渲染端口的几何检测（桥未挂载时明确报错） */
  debugGeometry(request: GeometryRequest, signal?: AbortSignal): Promise<GeometryResult>
  /** W04 诊断：证据占用 */
  evidenceStats(): EvidenceStoreStats
  /**
   * W06：鸟瞰 VLM 生成分区（一次完整流程：场景鸟瞰相机 → 证据图 → 模型提案 →
   * 程序反算/校验/归属 → 记 partitionVersion 与报告）。需要已配置模型。
   */
  preprocess(signal?: AbortSignal): Promise<{ partition: PartitionSnapshot; report: PartitionReport }>
  /** 当前分区（未生成时 null） */
  partition(): PartitionSnapshot | null
  /** 最近一次分区报告（含 issues/歧义/只读建议） */
  partitionReport(): PartitionReport | null
  /** 人工修正：把对象挪到某区，或标为 global_readonly */
  applyPartitionFix(objectId: string, target: { regionId: string } | { readonly: true }): PartitionSnapshot | null
  /** 外部注入/确认分区（人工编辑的多边形也走这里） */
  setPartition(partition: PartitionSnapshot | null): void
  /** 分区变更订阅（面板显示/按钮可用性用；返回退订） */
  onPartition(listener: (partition: PartitionSnapshot | null) => void): () => void
  /** 模型配置状态（脱敏；不返回 key） */
  modelStatus(): { configured: boolean; summary: string }
  /** W06 前测试注入分区用（dev/测试限定，生产面板依赖 partitionProvider） */
  debugSetPartition(partition: PartitionSnapshot | null): void
  /** dev/E2E 限定：替换 workflow 工厂（如注入已知 transform 工作流）；生产恒用装配时的工厂 */
  debugSetWorkflowFactory(factory: () => WorkflowRunner): void
  /** dev/诊断限定：只读场景快照（E2E 构造分区用） */
  debugSnapshot(scope: { objectIds?: string[]; includeCatalog?: boolean }): ReturnType<EditorReadPort['snapshot']>
  /**
   * dev/E2E 限定：走完整观测链路的一次捕获（ready → 真实渲染 → 证据登记）。
   * 调用方不必自己拼 sceneRevision/fingerprints——这里按当前文档补齐。
   */
  debugCapture(
    input: {
      camera: CameraSnapshot
      width: number
      height: number
      objectIds: string[]
      marked: boolean
      phase?: ObservationPhase
      runId?: string
      taskId?: string
      regionId?: string
    },
    signal?: AbortSignal,
  ): Promise<Observation>
  /** 彻底释放：退订相位监听、释放 editor adapter 与证据（StrictMode 安全由调用方负责） */
  dispose(): void
}

export function createRuntime(deps: CoAgentRuntimeDeps = {}): CoAgentRuntime {
  const editor =
    deps.editor ??
    (() => {
      const adapter = createEditorAdapter()
      return { read: adapter, write: adapter, dispose: () => adapter.dispose() }
    })()
  const config: CoAgentConfig = { ...DEFAULT_COAGENT_CONFIG, ...deps.config }
  const scheduler = createScheduler(config.modelConcurrency)
  const recorder = createRecorder()
  /**
   * W10：把事件流实时转给图可视化页（独立标签页，BroadcastChannel + localStorage 快照）。
   * 只读投影：feed 不参与业务，通道/配额任何异常都在 feed 内部吞掉。
   */
  const graphFeed = beginGraphFeed()
  recorder.subscribe(() => graphFeed.onEvents(recorder.events()))
  const baseModelPort = deps.modelPort ?? createModelAdapter()
  /**
   * 全局模型并发上限（§3.2）：走 scheduler 的 semaphore，而不是每个区各建一个"全局"限制。
   * 图里拿到的始终是这个受控端口，取消会以 cancelled 拒绝等待中的请求。
   *
   * **每一个模型请求/回包都在这里落日志**（诊断：purpose 标出 planner/executor/judge/
   * partition，排队时间单独记，便于区分"模型慢"与"并发排队"）。
   */
  const modelPort: ModelPort = {
    async complete(request, signal) {
      const log = activeRunLog()
      const queuedAt = Date.now()
      log?.modelRequest(request)
      let release: () => void
      try {
        release = await scheduler.acquireModel(signal)
      } catch (e) {
        log?.modelError(request, e, Date.now() - queuedAt, Date.now() - queuedAt)
        throw e
      }
      const startedAt = Date.now()
      const queueMs = startedAt - queuedAt
      try {
        const reply = await baseModelPort.complete(request, signal)
        log?.modelReply(request, reply, Date.now() - startedAt, queueMs)
        return reply
      } catch (e) {
        log?.modelError(request, e, Date.now() - startedAt, queueMs)
        throw e
      } finally {
        release()
      }
    },
  }

  let renderPort: RenderPort | null = null
  let partitionOverride: PartitionSnapshot | null = null
  let partitionReport: PartitionReport | null = null
  let workflowFactory: () => WorkflowRunner = deps.workflowFactory ?? (() => createWorkflow())
  let disposed = false

  // W04：证据登记 + 观测服务（桥未挂载时 observations 会抛 bridge_unavailable）
  const evidence = createEvidenceStore({ maxBytes: config.imageMemoryCapBytes, maxEntries: config.evidenceMaxEntries })
  const observations = createObservationService({ getPort: () => renderPort, store: evidence })

  const controller: RunController = createRunController({
    editorRead: editor.read,
    editorWrite: editor.write,
    scheduler,
    recorder,
    config,
    workflowFactory: () => workflowFactory(),
    isHostBusy: deps.isHostBusy ?? (() => false),
    partitionProvider: () => partitionOverride ?? deps.partitionProvider?.() ?? null,
    modelPort,
    observations,
    getRenderPort: () => renderPort,
    // W08.2：判定/执行送模型时按需把证据 Blob 转 dataURL（不复制进图状态）
    getImageDataUrl: imageId => evidence.dataUrlFor(imageId),
    // 运行日志头部：脱敏的模型配置摘要（绝不含 key）
    modelLabel: () => modelConfigSummary(),
    onPhase: (phase, info) => {
      onPhaseListeners.forEach(l => l(phase, info))
    },
  })

  const onPhaseListeners = new Set<(phase: CoAgentPhase, info: { runId: string | null; note?: string }) => void>()
  const onPartitionListeners = new Set<(partition: PartitionSnapshot | null) => void>()
  /** 分区的唯一写入口：赋值 + 通知（面板按钮可用性依赖它，不能漏） */
  const commitPartition = (next: PartitionSnapshot | null): void => {
    partitionOverride = next
    for (const l of onPartitionListeners) l(next)
  }

  return {
    start: request => {
      if (disposed) {
        return Promise.resolve({
          ok: false as const,
          error: { code: 'run_busy' as const, message: 'runtime 已释放（重新启用会创建新实例）', retryable: false },
        })
      }
      return controller.start(request)
    },
    cancel: () => controller.cancel(),
    requestDisable: () => controller.requestDisable(),
    enable: () => controller.enable(),
    reset: () => controller.reset(),
    phase: () => controller.phase(),
    busy: () => {
      const p = controller.phase()
      return (
        p === 'executing' ||
        p === 'committing' ||
        p === 'cancelling' ||
        p === 'planning' ||
        p === 'baselining' ||
        p === 'validating' ||
        p === 'preprocessing'
      )
    },
    locked: () => controller.locked(),
    config: () => config,
    registerRenderPort: port => {
      renderPort = port
    },
    evidence,
    observations,
    recorder,
    scheduler,
    onPhase: listener => {
      if (disposed) return () => undefined
      onPhaseListeners.add(listener)
      return () => {
        onPhaseListeners.delete(listener)
      }
    },
    onPartition: listener => {
      if (disposed) return () => undefined
      onPartitionListeners.add(listener)
      return () => {
        onPartitionListeners.delete(listener)
      }
    },
    diagnostics: () => ({ phaseListeners: onPhaseListeners.size, disposed }),
    renderDiagnostics: () => (renderPort?.diagnostics ? renderPort.diagnostics() : null),
    debugGeometry: (request, signal = new AbortController().signal) => {
      if (!renderPort) return Promise.reject(new CoAgentError('bridge_unavailable', '渲染桥未挂载：CoAgentBridge 不在 Canvas 内'))
      return renderPort.geometry(request, signal)
    },
    evidenceStats: () => evidence.stats(),

    async preprocess(signal = new AbortController().signal) {
      if (disposed) throw new CoAgentError('run_busy', 'runtime 已释放')
      if (isActivePhase(controller.phase())) {
        throw new CoAgentError('run_busy', '已有运行在进行，不能同时重新生成分区')
      }
      if (controller.locked()) throw new CoAgentError('run_busy', 'error_locked：请先重置再生成分区')
      // 分区生成也有自己的相位：面板据此显示"分区预处理"、宿主据此暂停编辑；
      // 结束后必须回到 idle（不能被上一轮 rolled_back 的终态粘住）。
      controller.emitPhase('preprocessing')
      // 分区预处理也是一条完整的模型链路：单独落一份日志（否则"生成分区失败"无迹可查）
      beginRunLog({
        kind: 'preprocess',
        runId: 'preprocess',
        request: '生成分区（鸟瞰 VLM）',
        config,
        model: modelConfigSummary(),
        note: '鸟瞰截图 → 模型提案 → 程序反算/校验/归属',
      })
      let logSummary = '分区预处理未产出结果'
      try {
        logStage('preprocess.start', '开始生成分区')
        if (!isModelConfigured()) {
          throw new CoAgentError('model_protocol_error', '未配置模型：先在「AI 编辑 → 设置」填好 baseURL / API Key / 模型名')
        }
        const snap = editor.read.snapshot({})
        if (snap.assets.length === 0) throw new CoAgentError('invalid_plan', '场景里没有资产，无法分区')
        logStage('preprocess.snapshot', `场景快照：${snap.assets.length} 个资产，sceneRevision=${snap.sceneRevision}`)
        const camera = birdseyeCamera(snap.assets)
        logStage(
          'preprocess.camera',
          `鸟瞰正交相机（${camera.id}）`,
          `position=${JSON.stringify(camera.position)} ortho=${JSON.stringify(camera.ortho)}`,
        )
        const observation = await observations.capture(
          {
            runId: 'preprocess',
            phase: 'preprocess',
            camera,
            width: 768,
            height: 576,
            objectIds: snap.assets.slice(0, 120).map(a => a.id),
            marked: false,
            sceneRevision: snap.sceneRevision,
            fingerprints: {},
          },
          signal,
          partitionOverride?.partitionVersion ?? 0,
        )
        logStage('preprocess.capture', `鸟瞰图已登记：${observation.id}（image=${observation.rgbImageId}）`)
        const url = evidence.urlFor(observation.rgbImageId)
        if (!url) throw new CoAgentError('capture_failed', '鸟瞰图未登记到证据库')
        const blob = await (await fetch(url)).blob()
        const imageDataUrl = await blobToDataUrl(blob)
        logStage('preprocess.image', `鸟瞰图转 dataURL：${Math.round(blob.size / 1024)} KB`)

        const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
        for (const a of snap.assets) {
          bounds.minX = Math.min(bounds.minX, a.transform.position[0])
          bounds.maxX = Math.max(bounds.maxX, a.transform.position[0])
          bounds.minZ = Math.min(bounds.minZ, a.transform.position[2])
          bounds.maxZ = Math.max(bounds.maxZ, a.transform.position[2])
        }
        logStage('preprocess.request', '向模型请求分区提案（见下一条 llm.request / llm.reply）', undefined, { bounds })

        const { proposal } = await requestPartition({
          model: modelPort,
          imageDataUrl,
          cameraId: camera.id,
          objectCount: snap.assets.length,
          bounds,
          signal,
          timeoutMs: config.modelTimeoutMs,
        })
        logStage('preprocess.proposal', `模型提案：${proposal.regions.length} 个区域`, undefined, proposal)
        const version = (partitionOverride?.partitionVersion ?? 0) + 1
        const built = buildPartition({ proposal, camera, assets: snap.assets, partitionVersion: version })
        commitPartition(built.partition)
        partitionReport = built.report
        logStage(
          'preprocess.done',
          `分区 v${version} 生成完成`,
          [
            `区域：${built.partition.regions.map(r => `${r.id}(${r.objectIds.length})`).join(' / ')}`,
            `只读：${built.partition.globalReadonlyObjectIds.length} 个；问题 ${built.report.issues.length} 条`,
            `未归属：${built.report.unassigned.length} 个；歧义：${built.report.ambiguous.length} 个`,
          ].join('\n'),
          built.report,
        )
        logSummary = `分区 v${version}：${built.partition.regions.map(r => `${r.id}(${r.objectIds.length})`).join(' / ')}`
        recorder.append({
          type: 'partition.ready',
          runId: 'preprocess',
          payload: {
            partitionVersion: version,
            cameraId: camera.id,
            regions: built.partition.regions.map(r => ({ id: r.id, objects: r.objectIds.length })),
            issues: built.report.issues.length,
            model: modelConfigSummary(),
          },
        })
        return built
      } catch (e) {
        logError('preprocess.error', '分区预处理失败', e instanceof Error ? e.message : String(e))
        logSummary = `分区预处理失败：${e instanceof Error ? e.message : String(e)}`
        throw e
      } finally {
        // 无论成功失败都回到 idle：终态相位只属于"运行"，不该粘在分区操作上
        controller.emitPhase(controller.locked() ? 'error_locked' : 'idle')
        await finishRunLog(logSummary)
      }
    },

    partition: () => partitionOverride,
    partitionReport: () => partitionReport,

    applyPartitionFix(objectId, target) {
      if (!partitionOverride) return null
      const next: PartitionSnapshot = {
        ...partitionOverride,
        regions: partitionOverride.regions.map(r => ({ ...r, objectIds: r.objectIds.filter(id => id !== objectId) })),
        globalReadonlyObjectIds: partitionOverride.globalReadonlyObjectIds.filter(id => id !== objectId),
      }
      if ('readonly' in target) next.globalReadonlyObjectIds = [...next.globalReadonlyObjectIds, objectId]
      else {
        const region = next.regions.find(r => r.id === target.regionId)
        if (!region) throw new CoAgentError('invalid_arguments', `分区里没有 ${target.regionId}`)
        region.objectIds = [...region.objectIds, objectId]
      }
      commitPartition(next)
      return next
    },

    setPartition: partition => commitPartition(partition),

    modelStatus: () => ({ configured: isModelConfigured(), summary: modelConfigSummary(currentLlmSettings()) }),
    debugCapture: async (input, signal = new AbortController().signal) => {
      const sceneRevision = editor.read.snapshot({ objectIds: [] }).sceneRevision
      const fingerprints: Record<string, string> = {}
      const expectedTransforms: Record<string, TransformDTO> = {}
      for (const a of editor.read.snapshot({ objectIds: input.objectIds }).assets) {
        fingerprints[a.id] = a.fingerprint
        expectedTransforms[a.id] = a.transform
      }
      if (!renderPort) throw new CoAgentError('bridge_unavailable', '渲染桥未挂载：CoAgentBridge 不在 Canvas 内')
      const request: CaptureRequest = {
        runId: input.runId ?? 'debug-run',
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.regionId !== undefined ? { regionId: input.regionId } : {}),
        phase: input.phase ?? 'supplement',
        camera: input.camera,
        width: input.width,
        height: input.height,
        objectIds: input.objectIds,
        marked: input.marked,
        sceneRevision,
        fingerprints,
        expectedTransforms,
      }
      return observations.capture(request, signal, partitionOverride?.partitionVersion ?? 1)
    },
    debugSetPartition: partition => commitPartition(partition),
    debugSetWorkflowFactory: factory => {
      workflowFactory = factory
    },
    debugSnapshot: scope => editor.read.snapshot(scope),
    dispose: () => {
      if (disposed) return
      disposed = true
      onPhaseListeners.clear()
      onPartitionListeners.clear()
      disposeGraphFeed() // W10：关掉图可视化通道
      evidence.reset() // 撤销所有 objectURL，避免浏览器一直占着像素
      editor.dispose?.()
    },
  }
}
