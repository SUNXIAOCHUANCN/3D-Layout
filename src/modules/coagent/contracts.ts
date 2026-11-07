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
  // basis 对旧计划可选；新生成计划由 planValidation 强制核对原始请求依据。
  | { kind: 'no_collision'; basis?: { source: 'user_request'; quote: string } }
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
  /**
   * P1 增补：结构化数量目标（add 任务专用）。
   *
   * 可选以兼容旧计划与日志重放；**新生成的 add 计划由 planValidation 强制要求**。
   * 名额判定只看"本任务仍存活的新增对象数"，不看调用次数、也不看区域总量。
   */
  creationTarget?: { minCount: number; maxCount: number }
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
  /** P1：本任务新增名额已用尽（达到 creationTarget.maxCount） */
  'task_creation_limit',
  /** P2：截图已过期（场景在截图之后改过），需要重新捕获再点选 */
  'stale_observation',
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
  /** Stable for all model requests belonging to one run. */
  sessionId?: string
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

/**
 * 覆盖报告（W08.3 增补）：说清哪些对象真正参与了检测、哪些被排除及原因。
 * 目的是让"没算"与"算了但结果 unknown"可区分——候选被截断时不能伪报 clear。
 */
export type GeometryCoverage = {
  /** 实际参与了配对检测的对象（targets ∪ statics 中未被排除者） */
  checkedObjectIds: ObjectId[]
  /** 被排除的对象及原因；空数组表示没有截断 */
  skipped: Array<{ objectId: ObjectId; reason: string }>
  /** 是否因上限/预算截断（为真时 status 不可能是 clear） */
  truncated: boolean
  /** 实际生成的配对数（targets×targets + targets×statics，不含 statics×statics） */
  pairCount: number
}

/** §6.5：必须给算法级别与对象对，不只给 boolean */
export type GeometryResult = {
  /** 任一 collision→collision；全部 clear 才 clear；否则 unknown */
  status: 'clear' | 'collision' | 'unknown'
  /** 本次检测达到的最高算法级别 */
  highestLevel: GeometryCheckLevel
  pairs: GeometryPairResult[]
  /** W08.3 增补：覆盖报告。旧构造点可省略（视为无覆盖信息），新实现必须给。 */
  coverage?: GeometryCoverage
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

/**
 * P2：截图点选请求。
 *
 * 用**观测自己的相机与画幅**做拾取，绝不用主视口相机——否则点选结果
 * 与模型看到的图不是同一个视角（文档 05 §7 的核心要求）。
 */
export type PickRequest = {
  camera: CameraSnapshot
  width: number
  height: number
  /** 归一化图像坐标，左上原点 */
  u: number
  v: number
}

export type PickResult = {
  /** 空命中是正常结果，不自动吸附最近物体 */
  hit: null | {
    objectId: ObjectId
    point: [number, number, number]
    distance: number
  }
}

export interface RenderPort {
  /** W08.4：expectedTransforms 可选；给了就必须等世界矩阵与文档 transform 一致 */
  ready(objectIds: ObjectId[], signal: AbortSignal, expectedTransforms?: Record<ObjectId, TransformDTO>): Promise<void>
  capture(request: CaptureRequest, signal: AbortSignal): Promise<CaptureFrame>
  geometry(request: GeometryRequest, signal: AbortSignal): Promise<GeometryResult>
  /**
   * P2：按观测相机做射线拾取（可选能力）。
   * 未实现时必须明确报 unavailable，不能返回"空命中"来伪装正常。
   */
  pick?(request: PickRequest, signal: AbortSignal): Promise<PickResult>
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
  bounds?: { min: Vec3; max: Vec3 }
  description?: string
  tags?: string[]
  retrievalTerms?: string[]
  scaleStatus?: string
  frontStatus?: string
  style?: { modeling: string | null; rendering: string | null; quality: string | null; precision: string | null }
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
  /**
   * 场景身份（T0-5 增补）：给出时可用于判断"是否换了场景"。
   * 场景级变更（changedObjectIds === null）必须带上，否则调用方只能保守地当切换处理。
   */
  sceneId?: SceneId
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
/** P3：一轮运行对应的编辑历史引用（撤销要靠它，不能靠"最后一次编辑"猜） */
export type RunHistoryRef = {
  runId: RunId
  sceneId: SceneId
  /** 同一 sceneId 重新加载后事务计数会重来，必须用会话 id 区分 */
  sceneSessionId: string
  /** core 的 TxHandle.id */
  transactionId: number
}

/** P3：撤销资格（只支持栈顶；其后有编辑就拒绝，避免误撤用户操作） */
export type UndoEligibility = {
  eligible: boolean
  reason?: string
  /** 该事务之后还有多少次编辑 */
  editsAfter: number
}

/** P3：提交回执——"有历史"必须由回执证明，不能凭调用没抛错就宣称可撤销 */
export type RunCommitReceipt = {
  committed: boolean
  /** 没有实际写入时为 null（此时不应生成撤销入口） */
  historyTransactionId: number | null
  /** 本次提交包含的写入条数 */
  writes: number
}

export interface EditorWritePort {
  /** 开启整轮唯一事务并铸造写令牌（core 单 openTx：重复 begin 会顶掉未关闭事务） */
  beginRun(label: string): WriteToken
  /** 提交并返回回执：`historyTransactionId` 非 null 才说明存在可撤销的历史 */
  commitRun(token: WriteToken): RunCommitReceipt
  /** 回滚本事务全部修改；令牌不匹配返回 false（幂等） */
  rollbackRun(token: WriteToken): boolean
  /** run 终态后清理令牌与幂等表 */
  endRun(token: WriteToken): void
  /** 工具写入门面：授权、作用域、指纹、幂等、事务注入都在实现内部（§5.2） */
  applyAuthorized(command: EditorCommand, ctx: AuthorizedCallContext): ToolResult<EditReceipt>
  /** 现有保存通路（core/io.saveScene 包装） */
  save(): Promise<{ mode: 'server' | 'download'; version: number }>
  /** P3：撤销资格（只支持栈顶；其后有编辑则不可用） */
  queryUndo(ref: RunHistoryRef): UndoEligibility
  /** P3：撤销指定轮次的历史事务（必须仍是栈顶） */
  undoRun(ref: RunHistoryRef): { ok: boolean; message?: string }
  /** P3：当前编辑器会话 id（同一 sceneId 重新加载后会变） */
  sceneSessionId(): string
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
  /** P2：聚焦+截图、相对调整+截图（一次调用完成一次观察） */
  'camera.inspect',
  'camera.adjust',
  'edit.add',
  'edit.transform',
  'edit.remove',
  'geometry.check',
  /** P2：按截图坐标识别对象（只识别，不授权写入） */
  'scene.pick',
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
  /** **累计创建历史**（审计语义，含已被删除的）。判"此刻还剩几个"请用 liveCreatedObjectIds */
  createdObjectIds: ObjectId[]
  modifiedObjectIds: ObjectId[]
  evidenceIds: ObservationId[]
  /** W08.5：该任务判定时的 task_before 证据（终检视觉重判要用同视角 before） */
  baselineObservationId?: ObservationId
  /** W08.5：判定时相关对象的指纹；终检据此判断"后续编辑是否改过它们" */
  judgedFingerprints?: Record<ObjectId, string>
  /** P1：本任务仍存活的新增对象（数量验收与修复上下文都用它） */
  liveCreatedObjectIds?: ObjectId[]
  /** P1：本任务创建后又被删除的对象（释放名额的依据，不进入几何/截图查询） */
  removedObjectIds?: ObjectId[]
}

/** P1：任务级台账的只读视图 */
export type TaskLedgerView = {
  taskId: TaskId
  regionId: RegionId
  phase: 'initial' | 'repair'
  attempt: number
  /** 本任务创建过、且当前仍存在的对象 */
  liveCreatedObjectIds: ObjectId[]
  /** 本任务创建过但已被删除的对象 */
  removedObjectIds: ObjectId[]
  modifiedObjectIds: ObjectId[]
  /** 还剩多少新增名额；任务没声明 creationTarget 时为 null（不受名额限制） */
  remainingAddCapacity: number | null
}

/**
 * P1：交给执行器的"当前事实"。
 *
 * 修复轮的关键：它必须知道**上一轮已经创建了哪些对象、现在还允许加几个**，
 * 否则模型只会照着原任务再新增一遍（样本日志的 2 栋变 4 栋）。
 */
export type ExecutionStateView = {
  phase: 'initial' | 'repair'
  attempt: number
  sceneRevision: number
  /** 任务声明的数量目标；未声明为 null */
  creationTarget: { minCount: number; maxCount: number } | null
  /** 本任务创建且仍存活的对象 */
  liveCreatedObjectIds: ObjectId[]
  /** 还能新建几个；null = 不受名额限制 */
  remainingAddCapacity: number | null
  /** 本任务当前涉及的对象（含**最新** transform 与 fingerprint，不是基线快照里的） */
  objects: Array<{
    id: ObjectId
    ref: string
    transform: TransformDTO
    fingerprint: string
    role: 'created' | 'modified' | 'target'
  }>
  /** 本任务创建过但已被删除的对象 */
  removedObjectIds: ObjectId[]
  /** 本任务当前允许操作的对象（显式列出，避免靠猜） */
  allowedObjectIds: ObjectId[]
  /** 只作比较基线，不能当作"当前状态" */
  baselineObservationId: ObservationId | null
  latestObservationId: ObservationId | null
  /** 上一轮未通过的判据问题（来自判定器的修正建议） */
  problems: string[]
  /** 是否因对象过多被截断展示（权威台账不受影响） */
  truncated?: boolean
}

/**
 * P2：一个区域的**工作相机状态**。
 *
 * 没有它，`camera.adjust` 每次都从俯视总览重来——"绕到侧面看"根本无法连续完成。
 * 工作相机只属于本轮运行的该区域，**不写进用户 selection、不进编辑历史**。
 */
export type RegionViewState = {
  regionId: RegionId
  camera: CameraSnapshot
  target: Vec3
  /** 最近一次聚焦的对象（被删除后需要回退并说明） */
  focusedObjectIds: ObjectId[]
  viewVersion: number
  latestObservationId: ObservationId | null
}

/** P2：每区工作相机的运行时容器（实现见 runtime/regionViews.ts） */
export interface RegionViews {
  get(regionId: RegionId): RegionViewState | null
  /** 写入并返回新状态（viewVersion 自增） */
  put(regionId: RegionId, next: { camera: CameraSnapshot; target: Vec3; focusedObjectIds?: ObjectId[]; latestObservationId?: ObservationId | null }): RegionViewState
  /** 聚焦对象已被删除：退回总览并记录原因 */
  clearFocus(regionId: RegionId): void
  /** 本轮所有区域的状态（诊断/日志） */
  all(): RegionViewState[]
}

/** P1：区域成员与权限分类（唯一成员口径，查询/验收/持久化共用） */export type RegionView = {
  regionId: RegionId
  /** 初始归属该区 ∪ 本轮在该区创建，且当前仍存在 */
  memberIds: ObjectId[]
  writableIds: ObjectId[]
  readonlyIds: ObjectId[]
  /** 归属无法唯一确定的对象：可见但不可写 */
  unresolvedIds: ObjectId[]
  sceneRevision: number
}

/**
 * P1：run 级状态服务的窄接口（实现见 runtime/runState.ts）。
 *
 * 图与工具只经这个接口读写台账；regionGraph 不再自己维护第二份权威写集。
 * 所有方法都是同步的——写入路径必须在场景队列内一次完成检查与登记。
 */
export interface RunStatePort {
  /** 规划校验通过后注册任务、数量目标与允许操作 */
  registerTasks(tasks: UnitTask[]): void
  /** 进入首轮/修正轮（只影响展示与日志，不重置台账） */
  setPhase(taskId: TaskId, phase: 'initial' | 'repair', attempt: number): void
  /**
   * 任务级写入前检查：返回 null 表示允许。
   * 顺序：幂等重放（放行）→ 任务声明 add → 存活新增数 < 上限。
   */
  checkWrite(taskId: TaskId | null, command: EditorCommand, toolCallId: ToolCallId): ToolError | null
  /** 写入成功后登记；同一对象重复登记幂等 */
  recordWrite(taskId: TaskId | null, command: EditorCommand, objectId: ObjectId, toolCallId: ToolCallId): void
  /** 当前快照下的任务成果；live 用于过滤"已被外部删除"的对象 */
  getTaskLedger(taskId: TaskId, live: ReadonlySet<ObjectId>): TaskLedgerView | null
  /** 当前快照下的区域成员与权限分类 */
  resolveRegion(region: Region, live: ReadonlySet<ObjectId>, sceneRevision: number): RegionView
  /** 本轮创建的存活对象（run 级） */
  liveCreatedObjectIds(live: ReadonlySet<ObjectId>): ObjectId[]
  /** run 终态清理：禁止迟到写入并丢弃临时记录 */
  finish(): void
  /** 诊断/日志：每个任务的存活新增数 */
  summary(live: ReadonlySet<ObjectId>): Array<{ taskId: TaskId; liveCreated: number; remaining: number | null }>
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

/** P3：一条结构化未通过项（不是错误文本，UI 与日志都读它） */
export type RunIssue = {
  scope: 'finalCheck' | 'task'
  taskId?: TaskId
  regionId?: RegionId
  /** 检查项名（终检项名或判据 id） */
  name: string
  status: 'fail' | 'uncertain'
  reason: string
  evidenceIds?: ObservationId[]
}

export type RunOutcome =
  | {
      kind: 'completed'
      summary: string
      plan: TasksPlan
      /** 按 regionId 索引的结果表；不同分支禁止写同一键（§4.4） */
      regions: Record<RegionId, RegionResult>
      finalCheck: FinalCheck
    }
  /**
   * P3：正常执行结束、但有判据未通过 —— **修改已提交并保留**，由用户决定是否撤销。
   * 与 completed 共享全部报告字段，额外带结构化 issues；tasks/regions 状态如实为 fail/uncertain。
   */
  | {
      kind: 'retained_with_issues'
      summary: string
      plan: TasksPlan
      regions: Record<RegionId, RegionResult>
      finalCheck: FinalCheck
      issues: RunIssue[]
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
  /**
   * P1：run 级台账（谁创建了什么、名额还剩几个、区域成员与权限）。
   * 图与工具只读它，不再各自维护写集副本。
   */
  runState: RunStatePort
  /**
   * P2：每区工作相机状态（本轮运行内有效，不入用户 selection、不进编辑历史）。
   */
  regionViews: RegionViews
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
  /** P1 扩展：任务级写入被拒（名额/操作声明），payload 带 code 与对象 id */
  'write.rejected',
  /** P3 扩展：用户撤销了某一轮的修改 */
  'run.undone',
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
  /**
   * W10 扩展：图节点边界（图可视化页消费）。
   * payload.node 为节点名：主图 'planner'，区域子图 'A/execute'；
   * finished 另带 status('ok'|'error') / ms / message。
   * 这两个事件由 workflow/state.ts 的 looseGraph 门面自动发出，节点函数无需感知。
   */
  'node.started',
  'node.finished',
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
  /** P3：修改已保留但存在未通过项（**不是** active 相位） */
  | 'retained'
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
  /**
   * P2：单次模型请求最多携带几张证据图（**最新**优先）。
   * 旧实现只限制"产生"，图进了 transcript 就每轮重发，模型永远看最早的两张。
   */
  maxImagesPerRequest: number
}
