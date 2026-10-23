/**
 * CoAgent 公共契约（W01 冻结版）。
 *
 * 本文件只含纯类型、常量与 CoAgentError：不导入任何宿主运行时（core/react/three），
 * contracts 层可被模块内任何工作包与 tests/fakes 安全引用（SPEC §2.2）。
 * DTO 形状依据 DEVELOPMENT-SPEC §4；Ports 依据 §5.2；
 * 与规格的少量偏差集中在 RenderPort.capture（返回 CaptureFrame 而非 Observation，
 * observationId 由 evidenceStore 铸造，见 §3.2 职责划分），记录于 IMPLEMENTATION-STATUS.md。
 *
 * 通用约定（§4.1）：所有 DTO 带 schemaVersion；ID 由程序生成；图内只放 JSON 可序列化数据；
 * 单位米；rotationDeg 角度制；相机 position/target/up；像素坐标左上原点，归一化 [0,1]。
 */

// ---------- 语义 ID 别名（第一版 string，不引品牌类型） ----------

export type RunId = string
export type SceneId = string
export type ObjectId = string
export type RegionId = string
export type TaskId = string
export type ObservationId = string
export type ImageId = string
export type ToolCallId = string
export type CameraId = string

// ---------- 几何与变换 ----------

export type Vec3 = [number, number, number]
/** 地面 XZ 平面上的点（米） */
export type PointXZ = [number, number]

/**
 * 统一变换 DTO：scale 必填（编辑器适配层把 core 的可选 scale 归一为 [1,1,1]），
 * 旋转字段名用 rotationDeg 以显式标注角度制，避免与弧_RAD 混用。
 */
export type TransformDTO = {
  position: Vec3
  /** 欧拉角，角度制，XYZ 顺序 */
  rotationDeg: Vec3
  scale: Vec3
}

// ---------- 分区 ----------

export type Region = {
  schemaVersion: 1
  id: RegionId
  name: string
  /** 地面多边形（XZ，米）；顶点序不约定方向，面积取绝对值 */
  polygonXZ: PointXZ[]
  /** 主归属对象（冻结于 run 开始；人工覆盖后重算） */
  objectIds: ObjectId[]
  cameraId: CameraId
  partitionVersion: number
}

/** run 开始时冻结的分区快照（§2.3：分区状态唯一拥有者是 partition service） */
export type PartitionSnapshot = {
  partitionVersion: number
  regions: Region[]
  /** 地形/道路等跨区共享大对象：可读、首版禁改（§6.1） */
  globalReadonlyObjectIds: ObjectId[]
}

// ---------- 任务 ----------

export type Criterion =
  | { id: string; kind: 'visual'; description: string }
  | {
      id: string
      kind: 'metric'
      metric: string
      operator: 'gte' | 'lte' | 'eq'
      value: number
      unit: string
    }

export type Constraint =
  | { kind: 'preserve_objects'; objectIds: ObjectId[] }
  | { kind: 'stay_in_region' }
  | { kind: 'no_collision' }
  | { kind: 'preserve_count' }

export type UnitTask = {
  schemaVersion: 1
  id: TaskId
  regionId: RegionId
  objective: string
  targetObjectIds: ObjectId[]
  allowedOperations: Array<'add' | 'transform' | 'remove'>
  criteria: Criterion[]
  constraints: Constraint[]
  /** 同区内任务依赖（DAG，禁止循环；跨区依赖非法） */
  dependsOn: TaskId[]
}

/** Planner 输出：结构化任务 / 澄清 / 不支持 三态（§3.4） */
export type Plan =
  | { schemaVersion: 1; kind: 'tasks'; assumptions: string[]; tasks: UnitTask[] }
  | { schemaVersion: 1; kind: 'clarify'; question: string; options: string[] }
  | { schemaVersion: 1; kind: 'unsupported'; reason: string }

// ---------- 相机与观测 ----------

/**
 * 完整相机快照（§4.2）：只存 cameraId 不足以复拍，投影参数必须显式。
 */
export type CameraSnapshot = {
  schemaVersion: 1
  id: CameraId
  projection: 'perspective' | 'orthographic'
  position: Vec3
  target: Vec3
  up: Vec3
  near: number
  far: number
  /** 图像宽高比 width/height */
  aspect: number
  /** projection=perspective 时必填（垂直视场角，度） */
  fovDeg?: number
  /** projection=orthographic 时必填 */
  ortho?: { left: number; right: number; top: number; bottom: number }
}

export type ObservationPhase = 'preprocess' | 'baseline' | 'task_before' | 'after' | 'supplement'

export type ObservationLabel = {
  /** 短编号（仅用于显示），必须配合 labels 的 label→objectId 映射使用（§3.8） */
  label: string
  objectId: ObjectId
  visibility: 'visible' | 'uncertain'
  /**
   * W04：同帧 ID pass 得到的像素包围盒（左上原点，含端点）。给了它，判定/复核就不用
   * 再猜"对象在图里哪儿"；像素数少于阈值时不给（uncertain 的对象没有可信位置）。
   */
  pixelBox?: { minX: number; minY: number; maxX: number; maxY: number }
  /** 该对象在本次捕获中占的像素数（0 表示看不见） */
  pixels?: number
}

export type Observation = {
  schemaVersion: 1
  id: ObservationId
  runId: RunId
  taskId?: TaskId
  regionId?: RegionId
  phase: ObservationPhase
  sceneRevision: number
  partitionVersion: number
  camera: CameraSnapshot
  width: number
  height: number
  rgbImageId: ImageId
  markedImageId?: ImageId
  labels: ObservationLabel[]
  observedObjectFingerprints: Record<string, string>
  capturedAt: string
}

// ---------- 判定 ----------

export type VerdictCriterionResult = {
  criterionId: string
  status: 'pass' | 'fail' | 'uncertain'
  evidenceIds: ObservationId[]
  reason: string
}

export type Verdict = {
  schemaVersion: 1
  taskId: TaskId
  status: 'pass' | 'fail' | 'uncertain'
  criteria: VerdictCriterionResult[]
  repairSuggestions: string[]
}

// ---------- 错误与工具结果 ----------

/** 固定首批错误码（§4.3）；internal_error 用于未知异常收口 */
export const ERROR_CODES = [
  'run_busy',
  'cancelled',
  'bridge_unavailable',
  'renderer_not_ready',
  'invalid_plan',
  'invalid_arguments',
  'out_of_scope',
  'stale_object',
  'unsupported_cross_region',
  'unsupported_metric',
  'asset_not_found',
  'model_timeout',
  'model_protocol_error',
  'budget_exceeded',
  'geometry_unknown',
  'capture_failed',
  'write_failed',
  'rollback_failed',
  'internal_error',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type ToolError = {
  code: ErrorCode
  message: string
  /** 可重新评估/观察；绝不授权框架自动重放写入（§4.3） */
  retryable: boolean
  details?: Record<string, unknown>
}

export type ToolResult<T> =
  | { ok: true; data: T; evidenceIds?: ObservationId[] }
  | { ok: false; error: ToolError }

/**
 * 默认可重试错误码集合：均为"稍后重新观察/请求可能成功"的类别。
 * 写入类错误（write_failed/stale_object/out_of_scope 等）一律不可重试。
 */
const DEFAULT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'model_timeout',
  'bridge_unavailable',
  'renderer_not_ready',
  'capture_failed',
  'geometry_unknown',
])

/** CoAgent 统一错误：跨模块抛掷用；转成 ToolResult 时调 toToolError() */
export class CoAgentError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'CoAgentError'
    this.code = code
    this.retryable = opts?.retryable ?? DEFAULT_RETRYABLE.has(code)
    this.details = opts?.details
  }

  toToolError(): ToolError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    }
  }

  /** 未知异常收口（§4.3）：AbortError→cancelled，其余→internal_error 并保留脱敏诊断 */
  static from(e: unknown): CoAgentError {
    if (e instanceof CoAgentError) return e
    if (e instanceof Error && e.name === 'AbortError') {
      return new CoAgentError('cancelled', '操作已被取消', { cause: e })
    }
    const msg = e instanceof Error ? e.message : String(e)
    return new CoAgentError('internal_error', msg.slice(0, 300), { cause: e })
  }
}

// ---------- 模型协议（ModelPort） ----------

export type ModelImage = { mediaType: 'image/png'; dataUrl: string }

export type ModelToolCall = { id: string; name: string; args: Record<string, unknown> }

export type ModelToolSpec = {
  name: string
  description: string
  /** JSON Schema 形状的参数定义 */
  schema: Record<string, unknown>
}

/** 统一消息（§3.7）：文本、图像、工具调用、工具结果 */
export type ModelMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string; images?: ModelImage[] }
  | { role: 'assistant'; text: string; toolCalls: ModelToolCall[] }
  | { role: 'toolResult'; callId: string; ok: boolean; content: unknown; images?: ModelImage[] }

export type ModelUsage = { inputTokens?: number; outputTokens?: number }

export type ModelStopReason = 'end' | 'tool_use' | 'max_tokens'

export type ModelReply = {
  stopReason: ModelStopReason
  text: string
  toolCalls: ModelToolCall[]
  usage?: ModelUsage
}

export type ModelRequest = {
  /** 用途标签（planner/executor/judge/partition…）：进 recorder 时保留，便于归类 */
  purpose: string
  system: string
  messages: ModelMessage[]
  tools: ModelToolSpec[]
  timeoutMs: number
}

export interface ModelPort {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>
}

// ---------- 渲染协议（RenderPort） ----------

export type CaptureRequest = {
  runId: RunId
  taskId?: TaskId
  regionId?: RegionId
  phase: ObservationPhase
  camera: CameraSnapshot
  width: number
  height: number
  /** 捕获前需确认已同步到渲染层的资产（空=只确认渲染就绪） */
  objectIds: ObjectId[]
  /** 是否同时产出 ID 标记图（§3.8 markers） */
  marked: boolean
  /**
   * 调用方（runtime）冻结的场景版本：渲染层只回显，不自己去读编辑器状态
   * （§2.2 依赖约束：rendering 不许 import core/adapters）。W04 新增。
   */
  sceneRevision: number
  /**
   * 调用方在捕获前对 request.objectIds 取的指纹（§6.4）。渲染层同样只回显：
   * 指纹口径属于 editorAdapter/schemas，渲染层无从得知。W04 新增。
   */
  fingerprints: Record<ObjectId, string>
  /**
   * W08.4：调用方期望的资产 transform。渲染层在捕获前比对本对象
   * matrixWorld，未同步就继续等（§6.3：不能只等固定毫秒）。
   */
  expectedTransforms?: Record<ObjectId, TransformDTO>
}

/**
 * 渲染层捕获产物。observationId 与证据登记是 evidenceStore 的职责（§3.2），
 * 因此 RenderPort 只交回像素与元数据，Observation 由上层组装——这是对
 * SPEC §5.2 签名的唯一一处显式修正（见 IMPLEMENTATION-STATUS 接口差异）。
 */
export type CaptureFrame = {
  camera: CameraSnapshot
  width: number
  height: number
  rgbPng: Blob
  markedPng?: Blob
  labels: ObservationLabel[]
  observedObjectFingerprints: Record<string, string>
  sceneRevision: number
}

export type GeometryCheckLevel = 'aabb' | 'mesh' | 'mesh+containment'

export type GeometryPairResult = {
  a: ObjectId
  b: ObjectId
  status: 'clear' | 'collision' | 'unknown'
  level: GeometryCheckLevel
  note?: string
}

/** §6.5：必须给算法级别与对象对，不只给 boolean */
export type GeometryResult = {
  /** 任一 collision→collision；全部 clear 才 clear；否则 unknown */
  status: 'clear' | 'collision' | 'unknown'
  /** 本次检测达到的最高算法级别 */
  highestLevel: GeometryCheckLevel
  pairs: GeometryPairResult[]
}

export type GeometryRequest = {
  /** 待检（本区写入集合）对象 */
  objectIds: ObjectId[]
  /** 参与检测但禁止修改的邻区/共享静态对象；缺省=场景内其余静态对象 */
  staticObjectIds?: ObjectId[]
  /** 接触容差（米）；地面支撑接触是否允许由 allowGroundContact 决定 */
  contactToleranceM: number
  allowGroundContact: boolean
}

/**
 * 渲染端口自检（W04，§3.8 "GPU 状态恢复、超时、卸载和资源释放"）。
 * 可选实现：无渲染层的 fake 可以不给；浏览器验证与诊断读取它。
 */
export type RenderPortDiagnostics = {
  /** 当前持有的离屏渲染目标（尺寸） */
  targets: Array<{ width: number; height: number }>
  /** 离屏资源估算占用（字节） */
  allocatedBytes: number
  captured: number
  failed: number
  /** 最近一次捕获耗时（毫秒） */
  lastCaptureMs: number | null
  /** 主视口相机（验证"捕获不改用户相机姿态"） */
  mainCamera: CameraSnapshot
  /** 是否仍挂载（卸载后 capture 应报 bridge_unavailable） */
  mounted: boolean
  /** WebGL 上下文是否丢失（T10：异常捕获后主视口仍应正常） */
  contextLost: boolean
}

export interface RenderPort {
  /** W08.4：expectedTransforms 可选；给了就必须等世界矩阵与文档 transform 一致 */
  ready(objectIds: ObjectId[], signal: AbortSignal, expectedTransforms?: Record<ObjectId, TransformDTO>): Promise<void>
  capture(request: CaptureRequest, signal: AbortSignal): Promise<CaptureFrame>
  geometry(request: GeometryRequest, signal: AbortSignal): Promise<GeometryResult>
  /** 可选：诊断（W04 起真实 bridge 提供） */
  diagnostics?(): RenderPortDiagnostics
}

// ---------- 编辑器读协议（EditorReadPort） ----------

export type ModelCatalogEntry = {
  ref: string
  name: string
  /** native 尺寸（米）[w,h,d] 对应 x/y/z 轴 */
  dimensions: { w: number; h: number; d: number }
  category: string | null
}

export type AssetDTO = {
  id: ObjectId
  ref: string
  name: string | null
  transform: TransformDTO
  visible: boolean
  /** 模型库元数据；ref 未入库时 null */
  catalog: ModelCatalogEntry | null
  /** §6.4 对象指纹：规范化 ref/transform/visible 派生（schemas.computeAssetFingerprint） */
  fingerprint: string
}

export type ReadScope = {
  objectIds?: ObjectId[]
  includeCatalog?: boolean
}

export type SceneSnapshot = {
  sceneId: SceneId | null
  /** plugin sceneRevision：随 document 变化单调增长（§6.4） */
  sceneRevision: number
  assets: AssetDTO[]
  catalog: ModelCatalogEntry[] | null
}

export type SceneChange = {
  sceneRevision: number
  /** 变更涉及的对象；null = 场景级变更（切换等） */
  changedObjectIds: ObjectId[] | null
}

export interface EditorReadPort {
  snapshot(scope: ReadScope): SceneSnapshot
  subscribe(listener: (change: SceneChange) => void): () => void
}

// ---------- 编辑器写协议（runtime 独占事务 + 工具门面） ----------

export type EditorCommand =
  | { kind: 'add'; ref: string; name?: string; transform: TransformDTO }
  | { kind: 'transform'; objectId: ObjectId; transform: TransformDTO; expectedFingerprint: string }
  | { kind: 'remove'; objectId: ObjectId; expectedFingerprint: string }

export type EditReceipt = {
  command: EditorCommand
  objectId: ObjectId
  fingerprintAfter: string
  /** 幂等键命中：同 runId+taskId+toolCallId 且同参数，返回原 receipt 未重复执行（§6.4） */
  idempotentHit?: boolean
  /**
   * 目标状态**已经达成**（模型重发同一条命令，且当前 transform 与目标一致）。
   * 这不是错误：返回成功并标记，让模型知道"不用再改了"，避免它反复重发直到超预算。
   */
  alreadySatisfied?: boolean
}

/** 写入授权令牌：不透明对象，只由 runtime 持有；图与工具仅能透传 */
export type WriteToken = Readonly<{ __coagentWriteToken: true }>

/** applyAuthorized 的调用上下文（runtime 注入；模型不可指定） */
export type AuthorizedCallContext = {
  runId: RunId
  taskId: TaskId | null
  toolCallId: ToolCallId
  token: WriteToken
  /** 本调用可写的对象集合（冻结分区写权限 ∪ 本 run 新增对象） */
  writableObjectIds: ReadonlySet<ObjectId>
}
export interface EditorWritePort {
  /** 开启整轮唯一事务并铸造写令牌（core 单 openTx：重复 begin 会顶掉未关闭事务） */
  beginRun(label: string): WriteToken
  commitRun(token: WriteToken): void
  /** 回滚本事务全部修改；令牌不匹配返回 false（幂等） */
  rollbackRun(token: WriteToken): boolean
  /** run 终态后清理令牌与幂等表 */
  endRun(token: WriteToken): void
  /** 工具写入门面：授权、作用域、指纹、幂等、事务注入都在实现内部（§5.2） */
  applyAuthorized(command: EditorCommand, ctx: AuthorizedCallContext): ToolResult<EditReceipt>
  /** 现有保存通路（core/io.saveScene 包装） */
  save(): Promise<{ mode: 'server' | 'download'; version: number }>
}

// ---------- 工具注册表 ----------

export type AgentRole = 'main' | 'executor' | 'judge'
export type ToolEffect = 'read' | 'write' | 'render'

export const TOOL_NAMES = [
  'scene.list_region',
  'scene.get_objects',
  'library.search',
  'camera.capture',
  'camera.focus',
  'camera.set',
  'edit.add',
  'edit.transform',
  'edit.remove',
  'geometry.check',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

/** 工具调用上下文：全部由 runtime 注入，模型不可伪造（§3.6） */
export type ToolCallContext = {
  runId: RunId
  taskId: TaskId | null
  regionId: RegionId | null
  role: AgentRole
  signal: AbortSignal
  token: WriteToken | null
  /**
   * 本次工具调用的模型侧 id（W05 新增）：写门面的幂等键是
   * runId+taskId+toolCallId（§6.4），工具层必须能把它透传下去，
   * 否则重放/重试会被当成"新写入"。
   */
  toolCallId: ToolCallId
}

export interface ToolDef {
  readonly name: ToolName
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly allowedRoles: readonly AgentRole[]
  readonly effect: ToolEffect
  handler(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult<unknown>>
}

// ---------- 工作流 ----------

export type TaskResult = {
  taskId: TaskId
  status: 'pass' | 'fail' | 'skipped'
  /** 首次判定与修正轮的 Verdict（时间序） */
  verdicts: Verdict[]
  createdObjectIds: ObjectId[]
  modifiedObjectIds: ObjectId[]
  evidenceIds: ObservationId[]
  /** W08.5：该任务判定时的 task_before 证据（终检视觉重判要用同视角 before） */
  baselineObservationId?: ObservationId
  /** W08.5：判定时相关对象的指纹；终检据此判断"后续编辑是否改过它们" */
  judgedFingerprints?: Record<ObjectId, string>
}

export type RegionResult = {
  regionId: RegionId
  status: 'pass' | 'fail' | 'cancelled'
  tasks: TaskResult[]
}

export type FinalCheckItem = {
  name: string
  passed: boolean
  evidenceIds: ObservationId[]
  note?: string
}

export type FinalCheck = {
  passed: boolean
  checkedAt: string
  /** §6.6 的逐项重检（终态完整性/保留对象/硬约束/后续破坏前任务） */
  checks: FinalCheckItem[]
}

export type TasksPlan = Extract<Plan, { kind: 'tasks' }>

export type RunOutcome =
  | {
      kind: 'completed'
      summary: string
      plan: TasksPlan
      /** 按 regionId 索引的结果表；不同分支禁止写同一键（§4.4） */
      regions: Record<RegionId, RegionResult>
      finalCheck: FinalCheck
    }
  | { kind: 'needs_clarification'; question: string; options: string[] }
  | { kind: 'rolled_back'; reason: ToolError }
  | { kind: 'cancelled' }

export type RunInput = {
  runId: RunId
  request: string
  partition: PartitionSnapshot
  sceneRevisionAtStart: number
}

/** 事件输入（recorder 负责补 eventSeq/time/schemaVersion；§5.5） */
export type WorkflowEventInput = {
  type: CoAgentEventType
  runId: RunId
  regionId?: RegionId
  taskId?: TaskId
  payload: Record<string, unknown>
}

/** context.applyWrite 的调用定位（幂等键 = runId+taskId+toolCallId；§6.4） */
export type WorkflowWriteCall = {
  taskId: TaskId | null
  toolCallId: ToolCallId
  regionId: RegionId | null
}

/** 工作流上下文：ports 全部注入；写入不进图，只经工具门面（§2.2） */
export interface WorkflowContext {
  signal: AbortSignal
  model: ModelPort
  render: RenderPort
  editorRead: EditorReadPort
  partition: PartitionSnapshot
  config: CoAgentConfig
  /** 事件出口（recorder 注入，单向） */
  emit(event: WorkflowEventInput): void
  /** 证据出口（evidenceStore/observations 注入）：铸 observationId 并登记图像 */
  capture(request: CaptureRequest): Promise<Observation>
  /** 按 ID 取已登记观测（判定复核用） */
  getObservation(id: ObservationId): Observation | undefined
  /**
   * W08.2：按 imageId 取证据图 dataURL（判定/执行送模型）。
   * 图只在请求瞬间转成 dataURL，不复制进图状态；找不到返回 null。
   */
  getImageDataUrl(imageId: ImageId): Promise<string | null>
  /**
   * 授权写门面（§5.2）：串行场景队列 + 作用域/指纹/幂等/事务注入都在实现内部；
   * 图与工具拿不到事务句柄。W05 的 editTools 经 registry 走到这里。
   */
  applyWrite(command: EditorCommand, call: WorkflowWriteCall): Promise<ToolResult<EditReceipt>>
}

export interface WorkflowRunner {
  run(input: RunInput, context: WorkflowContext): Promise<RunOutcome>
}

// ---------- 事件 ----------

export const EVENT_TYPES = [
  'run.started',
  'plan.ready',
  'baseline.ready',
  'task.started',
  'tool.started',
  'tool.finished',
  'verdict.ready',
  'task.finished',
  'run.cancelling',
  'run.committed',
  'run.rolled_back',
  'run.failed',
  'save.failed',
  /** W03 扩展：error_locked 经人工确认后复位（§5.4"保留错误和日志"之后的显式解锁动作） */
  'runtime.reset',
  /** W06 扩展：鸟瞰分区生成完成（分区版本/相机/提案摘要） */
  'partition.ready',
] as const

export type CoAgentEventType = (typeof EVENT_TYPES)[number]

export type CoAgentEventEnvelope = {
  schemaVersion: 1
  /** 单调递增，由唯一 recorder 分配；并行事件只有发生顺序不暗示因果（§5.5） */
  eventSeq: number
  time: string
  runId: RunId
  regionId?: RegionId
  taskId?: TaskId
  type: CoAgentEventType
  payload: Record<string, unknown>
}

// ---------- 生命周期与配置 ----------

/** §7.1 状态机 */
export type CoAgentPhase =
  | 'disabled'
  | 'initializing'
  | 'idle'
  | 'preprocessing'
  | 'planning'
  | 'awaiting_clarification'
  | 'baselining'
  | 'executing'
  | 'validating'
  | 'committing'
  | 'completed'
  | 'cancelling'
  | 'rolled_back'
  | 'failed'
  | 'error_locked'

/** 配置契约（默认值见 config.ts；§7.2：所有上限必须有限） */
export interface CoAgentConfig {
  /** 全局模型并发（semaphore，不是每区一个） */
  modelConcurrency: number
  /** 每任务额外修正次数（不含首次执行） */
  maxRepairsPerTask: number
  /** 每任务工具预算（含失败与修正轮） */
  toolBudgetPerTask: number
  /** 单次模型请求超时（毫秒） */
  modelTimeoutMs: number
  /** 场景就绪超时（毫秒） */
  sceneReadyTimeoutMs: number
  /** schema 修复请求次数（模型输出不合 schema 时重问） */
  schemaRepairAttempts: number
  /** 自动恢复编辑：首版禁用（字面量类型） */
  autoRecoverEdits: false
  /** 导出凭据/完整请求头：禁用（字面量类型） */
  exportCredentials: false
  /** 整轮运行总时限（毫秒） */
  runTotalTimeoutMs: number
  /** 证据图像内存上限（字节） */
  imageMemoryCapBytes: number
  /** 单轮事件/日志序列化上限（字节） */
  logSizeCapBytes: number
  /** evidenceStore 最多保留的观测条数 */
  evidenceMaxEntries: number
}
