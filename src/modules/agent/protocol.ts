import type { Transform, Vec3 } from '../../core/types'

/**
 * Agent 插件协议 —— 编辑器对 Agent 的权限边界（v3）。
 *
 * 权限模型（本插件存在的核心理由）：
 * 1. 只读工具（scene.get_state / viewport.screenshot / viewport.pick / log.list）：
 *    随时可调、立即返回、不产生历史；
 * 2. 写工具（asset.*）：只允许在「任务事务」内调用，且是提案式的——
 *    操作即时生效到视口供人查看，但是否入账（commit）由人工裁决；
 * 3. 导出工具（log.write）：有落盘副作用但不是场景编辑——不进任务事务、
 *    不可回滚，只允许写 logs/ 下符合命名规约的调用记录文件；
 * 4. 一切场景修改走 core/edit（source:'agent'），与人工编辑同一本历史账；
 *    Agent 拿不到 three 对象的直接引用、不能落盘场景、不能切场景/动相机/改选中。
 *
 * v2 新增视觉工作流：viewport.screenshot 的图像可随工具结果回传给多模态 LLM，
 * viewport.pick 把截图上的像素坐标经射线拾取换成资产（含世界坐标命中点），
 * asset.adjust_transform 以增量方式调整被选中物体的变换。
 * v3 新增调用记录导出：log.write 把某轮对话的调用记录写成 logs/ 下的 md
 * （第一、二部分 LLM 撰写，第三部分由编辑器 recorder 按事实数据生成）。
 *
 * 传输层由 AgentTransport 抽象：一期内置 演示回环（loopback）与 WebSocket 两种实现，
 * 三期 Harness（Node 后端）实现同一协议即可接入，前端零改动。
 */

export const AGENT_PROTOCOL_VERSION = 3

// ---------- 工具名与参数 ----------

/** 工具权限层级：read=随时可调；write=仅任务事务内（提案式）；export=落盘副作用但不改场景 */
export type AgentAccess = 'read' | 'write' | 'export'

/** 只读工具：无副作用，任务内外均可调用 */
export type AgentReadToolName =
  | 'scene.get_state'
  | 'model.search'
  | 'scene.check_overlaps'
  | 'viewport.screenshot'
  | 'viewport.pick'
  | 'log.list'

/** 写工具：仅任务事务内可用，提案式生效，commit 由人工裁决 */
export type AgentWriteToolName =
  | 'asset.set_transform'
  | 'asset.adjust_transform'
  | 'asset.add'
  | 'asset.remove'

/** 导出工具：写 logs/ 下的调用记录文件，不受任务事务约束 */
export type AgentExportToolName = 'log.write'

export type AgentToolName = AgentReadToolName | AgentWriteToolName | AgentExportToolName

export interface SceneGetStateArgs {
  /** 是否附带当前场景引用模型的介绍，默认 false；新增模型用 model.search */
  includeManifest?: boolean
}

export interface ViewportScreenshotArgs {
  /** 返回 PNG dataURL 的最大宽度（等比缩小），默认 1024 */
  maxWidth?: number
}

export interface ViewportPickArgs {
  /** 截图图像上的像素列（左上原点） */
  x: number
  /** 截图图像上的像素行（左上原点） */
  y: number
  /** 坐标所属截图的宽（即 viewport.screenshot 返回的 width） */
  imageWidth: number
  /** 坐标所属截图的高（即 viewport.screenshot 返回的 height） */
  imageHeight: number
  /** 是否在视口瞬时高亮命中的物体（视觉反馈，不等于选中），默认 true */
  highlight?: boolean
}

export interface AssetSetTransformArgs {
  assetId: string
  transform: Transform
}

export interface AssetAdjustTransformArgs {
  assetId: string
  /** 平移增量（米，世界坐标），叠加到当前 position */
  translate?: Vec3
  /** 旋转增量（角度制 XYZ），叠加到当前 rotation */
  rotateDeg?: Vec3
  /** 缩放倍率，乘到当前 scale：数字=三轴同倍，[x,y,z]=分轴 */
  scaleMul?: number | Vec3
}

export interface LogWriteArgs {
  /** 覆盖第几轮对话（一条用户指令 = 一轮，从 1 起）；缺省 'last' = 最近一轮 */
  round?: number | 'last'
  /** 日志名称（进文件名，LLM 起名，可中文） */
  name: string
  /** 第一部分：LLM 回忆的本轮编辑清单与参数（markdown） */
  editsRecap: string
  /** 第二部分：总目的与每一步理由（markdown） */
  explanation: string
  /** 编辑已有日志时传（log.write 成功结果里返回的文件名），覆写该文件 */
  filename?: string
}

export interface LogListArgs {}

export interface AssetAddArgs {
  /** 模型库引用，如 'models/placeholder-box'；必须是 manifest 中存在的条目 */
  ref: string
  /** 底面中心的世界坐标（米，+Y 向上） */
  position: Vec3
  /** 欧拉角，角度制；缺省 [0,0,0] */
  rotation?: Vec3
  /** 相对 native 尺寸的缩放；缺省 [1,1,1] */
  scale?: Vec3
  name?: string
}

export interface AssetRemoveArgs {
  assetId: string
}

// ---------- 消息 ----------

/** Harness → 插件 */
export type AgentInbound =
  /** 开启一个任务事务：后续写工具并入该事务；label 进历史面板 */
  | { kind: 'task_begin'; taskId: string; label: string }
  /** 一次工具调用；写工具必须带与 task_begin 一致的 taskId。
   *  tool 是不可信线上输入（LLM/远端给的名字），session 会对照白名单注册表校验 */
  | {
      kind: 'call'
      callId: string
      tool: string
      args?: Record<string, unknown>
      taskId?: string
    }
  /** 任务提案结束：进入等待人工裁决（接受=commit / 拒绝=rollback） */
  | { kind: 'task_end'; taskId: string }

/** 插件 → Harness */
export type AgentOutbound =
  | { kind: 'hello'; protocol: number; sceneId: string | null }
  | { kind: 'call_result'; callId: string; ok: true; data: unknown }
  | { kind: 'call_result'; callId: string; ok: false; error: string }
  | { kind: 'task_result'; taskId: string; verdict: 'accepted' | 'rejected'; writes: number }
  | { kind: 'log'; text: string }

// ---------- 传输层 ----------

export interface AgentTransportHandlers {
  /** 收到 Harness 的入站消息 */
  onInbound(msg: AgentInbound): void
  /** 连接状态变化；变为已连接时应回发 hello（由会话层负责） */
  onStatus(connected: boolean): void
}

export interface AgentTransport {
  /** 展示名（面板状态区显示） */
  readonly name: string
  start(handlers: AgentTransportHandlers): void
  send(msg: AgentOutbound): void
  stop(): void
}
