import { edit, type TxHandle } from '../../core/edit'
import { engine } from '../../core/engine'
import type { CaptureCamera } from '../../core/engine'
import { bus } from '../../core/events'
import { buildLogFilename, listLogs, sanitizeLogName, saveLog } from '../../core/io'
import { useSceneStore } from '../../core/store'
import { describeModel } from '../../core/modelCatalog'
import { modelWorldBounds } from '../../shared/modelBounds'
import type { SceneAsset, Transform, Vec3 } from '../../core/types'
import type { AgentAccess, AgentToolName } from './protocol'
import { recorder } from './recorder'
import { GENERATION_TOOLS } from './generationTools'

/**
 * 工具注册表 = 编辑器对 Agent 开放的权限清单。
 * 只有在这里注册的工具会被执行，其余一律拒绝——注册表即白名单。
 * 每个工具的 exec 只依赖 core（store/edit/engine/io）与本模块 recorder，
 * 不感知传输与 UI。
 */

export interface AgentToolContext {
  /** 当前任务事务句柄；写工具必须有，读/导出工具忽略 */
  tx: TxHandle | null
  signal?: AbortSignal
}

export interface AgentToolDef {
  readonly name: AgentToolName
  readonly access: AgentAccess
  /** 一句话说明（面板权限区展示） */
  readonly summary: string
  /** 完整说明（三期供 Harness 生成 LLM 工具描述） */
  readonly description: string
  /** 参数说明（三期生成 schema 用） */
  readonly argsDoc: string
  /** JSON Schema 参数定义（LLM function calling / Anthropic tools 直接可用） */
  readonly schema: Record<string, unknown>
  exec(args: Record<string, unknown>, ctx: AgentToolContext): unknown
}

// ---------- 参数校验：Agent 输入按不可信处理 ----------

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`参数 ${key} 必须是非空字符串`)
  return v
}

function reqInt(args: Record<string, unknown>, key: string): number {
  const v = args[key]
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`参数 ${key} 必须是整数`)
  return v
}

function optVec3(args: Record<string, unknown>, key: string): Vec3 | undefined {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`参数 ${key} 必须是 [x,y,z] 有限数字数组`)
  }
  return v as Vec3
}

function reqVec3(args: Record<string, unknown>, key: string): Vec3 {
  const v = optVec3(args, key)
  if (!v) throw new Error(`参数 ${key} 缺失`)
  return v
}

function optNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`参数 ${key} 必须是正数`)
  return v
}

function reqTransform(args: Record<string, unknown>): { position: Vec3; rotation: Vec3; scale?: Vec3 } {
  const t = args.transform
  if (typeof t !== 'object' || t === null) throw new Error('参数 transform 缺失')
  const obj = t as Record<string, unknown>
  const position = reqVec3(obj, 'position')
  const rotation = reqVec3(obj, 'rotation')
  const scale = optVec3(obj, 'scale')
  return scale ? { position, rotation, scale } : { position, rotation }
}

function findAsset(assetId: string): SceneAsset {
  const a = useSceneStore.getState().document?.assets.find(x => x.id === assetId)
  if (!a) throw new Error(`资产 ${assetId} 不存在`)
  return a
}

// ---------- 向量小工具（adjust_transform 的增量运算） ----------

const addVec3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

/** 角度归一到 (-180, 180]：增量旋转反复叠加后文档仍保持整洁 */
const wrapDeg = (deg: number): number => {
  const r = (((deg + 180) % 360) + 360) % 360 - 180
  return r === -180 ? 180 : r
}

/** scaleMul 校验：正数（三轴同倍）或三个正数 [x,y,z]（分轴） */
function parseScaleMul(args: Record<string, unknown>): number | Vec3 | undefined {
  const v = args.scaleMul
  if (v === undefined || v === null) return undefined
  const positive = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0
  if (typeof v === 'number') {
    if (!positive(v)) throw new Error('参数 scaleMul 必须为正数')
    return v
  }
  if (Array.isArray(v) && v.length === 3 && v.every(positive)) return v as Vec3
  throw new Error('参数 scaleMul 必须是正数或三个正数的 [x,y,z]')
}

// ---------- 各工具实现 ----------

/** 单资产的 Agent 视图：标准模型介绍 + 含 XYZ 旋转/有符号缩放的世界 AABB。 */
function describeAsset(a: SceneAsset): {
  id: string
  ref: string
  name: string | null
  transform: Transform
  visible: boolean
  model: { name: string; category: string | null; dimensions: { w: number; d: number; h: number } } | null
  worldSize: Vec3 | null
  worldAabb: { min: Vec3; max: Vec3 } | null
  terrain: Omit<NonNullable<SceneAsset['terrain']>, 'heights'> | null
  materialOverride: SceneAsset['materialOverride'] | null
} {
  const meta = useSceneStore.getState().manifest?.models[a.ref]
  const worldAabb = meta ? modelWorldBounds(meta, a.transform) : null
  const size: Vec3 | null = worldAabb
    ? [worldAabb.max[0] - worldAabb.min[0], worldAabb.max[1] - worldAabb.min[1], worldAabb.max[2] - worldAabb.min[2]] : null
  return {
    id: a.id,
    ref: a.ref,
    name: a.name ?? null,
    transform: a.transform,
    visible: a.visible !== false,
    model: meta
      ? describeModel(a.ref, meta)
      : null,
    worldSize: size,
    worldAabb,
    terrain: a.terrain ? { width: a.terrain.width, depth: a.terrain.depth, samplesX: a.terrain.samplesX, samplesZ: a.terrain.samplesZ, seed: a.terrain.seed } : null,
    materialOverride: a.materialOverride ?? null,
  }
}

/** 把 SceneDocument + 模型尺寸换算成 Agent 便于空间推理的中立快照 */
function sceneGetState(args: Record<string, unknown>): unknown {
  const s = useSceneStore.getState()
  const doc = s.document
  if (!doc) throw new Error('场景未加载')
  const includeManifest = args.includeManifest !== false

  return {
    sceneId: s.sceneId,
    meta: doc.meta,
    environment: doc.environment,
    selectedAssetId: s.selectedAssetId,
    /** 约定：米；+Y 向上；欧拉角角度制；原点在底面中心 */
    conventions: { unit: 'm', up: '+Y', rotation: 'deg XYZ', origin: 'bottom-center' },
    assets: doc.assets.map(describeAsset),
    manifest:
      includeManifest && s.manifest
        ? Object.fromEntries(
            Object.entries(s.manifest.models).map(([ref, m]) => [
              ref,
              describeModel(ref, m),
            ]),
          )
        : null,
  }
}

/** 无 UI 截图：与视口同一相机同一构图，隐藏编辑器视觉件（描边/gizmo），等比缩小后返回 dataURL */
let latestCapture: { id: string; camera: CaptureCamera; width: number; height: number; document: unknown } | null = null

async function viewportScreenshot(args: Record<string, unknown>): Promise<unknown> {
  if (args.camera !== undefined) {
    if (!args.camera || typeof args.camera !== 'object' || Array.isArray(args.camera)) throw new Error('camera 必须为对象')
    const c = args.camera as Record<string, unknown>
    const projection = c.projection
    if (projection !== 'perspective' && projection !== 'orthographic') throw new Error('projection 必须是 perspective 或 orthographic')
    const position = reqVec3(c, 'position')
    const target = reqVec3(c, 'target')
    const up = optVec3(c, 'up') ?? [0, 1, 0]
    const near = optNumber(c, 'near', 0.1), far = optNumber(c, 'far', 300)
    const direction = position.map((n, i) => n - target[i])
    const cross = [direction[1] * up[2] - direction[2] * up[1], direction[2] * up[0] - direction[0] * up[2], direction[0] * up[1] - direction[1] * up[0]]
    if (near >= far || Math.hypot(...direction) < 1e-6 || Math.hypot(...cross) < 1e-6) throw new Error('相机裁剪范围或方向无效')
    const fovDeg = projection === 'perspective' ? optNumber(c, 'fovDeg', 50) : undefined
    if (fovDeg !== undefined && fovDeg >= 180) throw new Error('fovDeg 必须小于 180')
    const viewHeight = projection === 'orthographic' ? optNumber(c, 'viewHeight', 20) : undefined
    const width = args.width === undefined ? 1024 : reqInt(args, 'width')
    const height = args.height === undefined ? 768 : reqInt(args, 'height')
    if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error('截图宽高须为 1–2048 的整数')
    const camera: CaptureCamera = { projection, position, target, up, near, far, ...(fovDeg === undefined ? {} : { fovDeg }), ...(viewHeight === undefined ? {} : { viewHeight }) }
    const image = engine.captureFromCamera(camera, width, height)
    const id = crypto.randomUUID()
    latestCapture = { id, camera, width, height, document: useSceneStore.getState().document }
    return { image, width, height, screenshotId: id, camera }
  }
  latestCapture = null
  const maxWidth = optNumber(args, 'maxWidth', 1024)
  const src = engine.captureScreenshot()
  const img = new Image()
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('截图解码失败'))
    img.src = src
  })
  await loaded
  if (img.width <= maxWidth) return { image: src, width: img.width, height: img.height }
  const scale = maxWidth / img.width
  const canvas = document.createElement('canvas')
  canvas.width = maxWidth
  canvas.height = Math.round(img.height * scale)
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  return { image: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}

/**
 * 视觉点选：LLM 基于最近一次截图给出像素坐标，经射线拾取换回资产。
 * 坐标契约：(x,y) 是那张截图图像上的像素位置（左上原点）；
 * 拾取口径与截图一致（跳过描边/gizmo），命中点为世界坐标（米）。
 */
function viewportPick(args: Record<string, unknown>): unknown {
  const x = reqInt(args, 'x')
  const y = reqInt(args, 'y')
  const imageWidth = reqInt(args, 'imageWidth')
  const imageHeight = reqInt(args, 'imageHeight')
  if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) {
    throw new Error(`像素坐标 (${x},${y}) 超出图像范围 ${imageWidth}×${imageHeight}`)
  }
  const highlight = args.highlight !== false
  // 像素中心 → 归一化图像坐标（左上原点）
  let hit
  if (args.screenshotId !== undefined) {
    if (!latestCapture || args.screenshotId !== latestCapture.id) throw new Error('截图不存在或已过期')
    if (latestCapture.document !== useSceneStore.getState().document) throw new Error('场景已变化，截图已过期')
    if (imageWidth !== latestCapture.width || imageHeight !== latestCapture.height) throw new Error('截图尺寸不匹配')
    hit = engine.pickFromCamera(latestCapture.camera, imageWidth, imageHeight, (x + 0.5) / imageWidth, (y + 0.5) / imageHeight)
  } else {
    if (latestCapture) throw new Error('自定义相机截图拾取必须提供 screenshotId')
    hit = engine.pickNormalized((x + 0.5) / imageWidth, (y + 0.5) / imageHeight)
  }
  if (!hit) {
    if (highlight) bus.emit('agent:picked', { assetId: null })
    return { assetId: null, note: '该点未命中资产；可换相邻像素重试，或用 scene.get_state 重新定位' }
  }
  const a = findAsset(hit.assetId)
  if (highlight) bus.emit('agent:picked', { assetId: a.id })
  return {
    ...describeAsset(a),
    hit: { point: hit.point, distance: hit.distance },
    hint: 'hit.point 为命中点世界坐标（米）；可用 asset.adjust_transform 增量微调，或 asset.set_transform 设定绝对变换',
  }
}

function assetSetTransform(args: Record<string, unknown>, ctx: AgentToolContext): unknown {
  const assetId = reqString(args, 'assetId')
  const transform = reqTransform(args)
  findAsset(assetId) // 不存在即抛错
  if (!ctx.tx) throw new Error('写工具仅在任务事务内可用')
  if (!edit.setTransform(assetId, transform, { source: 'agent', tx: ctx.tx })) {
    throw new Error(`更新 ${assetId} 变换失败`)
  }
  return { assetId, transform }
}

/**
 * 相对增量调整变换（视觉微调主路径）：translate/rotateDeg/scaleMul 叠加到当前值，
 * 未提供的轴保持不变——比让 LLM 复述绝对全量更不易错（漏写的轴不会被悄悄归位）。
 */
function assetAdjustTransform(args: Record<string, unknown>, ctx: AgentToolContext): unknown {
  const assetId = reqString(args, 'assetId')
  const translate = optVec3(args, 'translate')
  const rotateDeg = optVec3(args, 'rotateDeg')
  const scaleMul = parseScaleMul(args)
  if (!translate && !rotateDeg && !scaleMul) {
    throw new Error('至少提供 translate / rotateDeg / scaleMul 之一')
  }
  const t = findAsset(assetId).transform
  const mul = typeof scaleMul === 'number' ? [scaleMul, scaleMul, scaleMul] : scaleMul
  const baseScale = t.scale ?? [1, 1, 1]
  const nextScale = mul ? ([0, 1, 2].map(i => baseScale[i] * mul[i]) as Vec3) : t.scale
  const transform: Transform = {
    position: translate ? addVec3(t.position, translate) : t.position,
    rotation: rotateDeg
      ? ([0, 1, 2].map(i => wrapDeg(t.rotation[i] + rotateDeg[i])) as Vec3)
      : t.rotation,
    ...(nextScale ? { scale: nextScale } : {}),
  }
  if (!ctx.tx) throw new Error('写工具仅在任务事务内可用')
  if (!edit.setTransform(assetId, transform, { source: 'agent', tx: ctx.tx })) {
    throw new Error(`调整 ${assetId} 变换失败`)
  }
  return { assetId, transform }
}

function assetAdd(args: Record<string, unknown>, ctx: AgentToolContext): unknown {
  const ref = reqString(args, 'ref')
  const position = reqVec3(args, 'position')
  const rotation = optVec3(args, 'rotation') ?? [0, 0, 0]
  const scale = optVec3(args, 'scale')
  const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : undefined

  const s = useSceneStore.getState()
  if (!s.document) throw new Error('场景未加载')
  const meta = s.manifest?.models[ref]
  if (!meta) throw new Error(`模型库中不存在 ${ref}（可用引用见 scene.get_state 的 manifest）`)

  // id 由前端铸造，保证场景内唯一；Agent 不应自带 id
  const base = `${ref.split('/').pop() ?? 'asset'}-agent`
  let id = base
  let n = 0
  while (s.document.assets.some(a => a.id === id)) id = `${base}-${++n}`

  const asset: SceneAsset = {
    id,
    ref,
    ...(name ? { name } : {}),
    transform: { position, rotation, ...(scale ? { scale } : {}) },
  }
  if (!ctx.tx) throw new Error('写工具仅在任务事务内可用')
  if (!edit.addAsset(asset, { source: 'agent', tx: ctx.tx })) throw new Error(`添加 ${ref} 失败`)
  return { assetId: id, asset }
}

function assetRemove(args: Record<string, unknown>, ctx: AgentToolContext): unknown {
  const assetId = reqString(args, 'assetId')
  const cur = findAsset(assetId)
  if (!ctx.tx) throw new Error('写工具仅在任务事务内可用')
  if (!edit.removeAsset(assetId, { source: 'agent', tx: ctx.tx })) throw new Error(`删除 ${assetId} 失败`)
  return { assetId, removed: cur.ref }
}

// ---------- 调用记录（logs/ 目录） ----------

/**
 * 写调用记录：第一、二部分由 LLM 凭自己的回忆撰写（参数传入），
 * 第三部分由 recorder 按编辑器侧事实数据自动拼接——构成"自述 vs 记录"对照。
 * 不传 filename = 新建（log时间戳-名称.md）；传已有文件名 = 覆写（编辑）。
 */
async function logWrite(args: Record<string, unknown>): Promise<unknown> {
  const name = sanitizeLogName(reqString(args, 'name'))
  if (!name) throw new Error('参数 name 消毒后为空，请重新起一个名称')
  const editsRecap = reqString(args, 'editsRecap')
  const explanation = reqString(args, 'explanation')

  const roundArg = args.round === undefined ? 'last' : args.round
  let round: number
  if (roundArg === 'last') {
    round = recorder.currentRound
    if (round < 1) throw new Error('尚无对话轮次可记录（一条用户指令 = 一轮）')
  } else if (typeof roundArg === 'number' && Number.isInteger(roundArg) && roundArg >= 1) {
    round = roundArg
  } else {
    throw new Error("参数 round 必须是正整数或 'last'")
  }

  const part3 = recorder.renderMarkdown(round) // 该轮无调用则抛错并附可用轮次
  const title = recorder.roundTitle(round).slice(0, 40)
  const filename =
    typeof args.filename === 'string' && args.filename.length > 0
      ? args.filename
      : buildLogFilename(name)
  const s = useSceneStore.getState()
  const content = [
    '# 编辑操作日志',
    '',
    `> 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })} ｜ 场景：${s.sceneId ?? '（未加载）'} ｜ 覆盖：第 ${round} 轮「${title}」 ｜ Agent 命名：${name}`,
    '',
    '## 第一部分：我实际发起的写操作（编辑）清单',
    '',
    editsRecap,
    '',
    '---',
    '',
    '## 第二部分：每一步的目的说明',
    '',
    explanation,
    '',
    '---',
    '',
    part3,
    '',
  ].join('\n')

  const r = await saveLog(filename, content)
  return {
    file: r.file,
    filename,
    round,
    mode: r.mode,
    ...(r.mode === 'download' ? { note: '保存服务不可用，已降级为下载 md 文件' } : {}),
  }
}

async function logList(): Promise<unknown> {
  const r = await listLogs()
  return r.available ? { files: r.files } : { files: [], note: '保存服务不可用，无法列出已有日志' }
}

// ---------- 注册表 ----------

const vec3Schema = (desc: string): Record<string, unknown> => ({
  type: 'array',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
  description: desc,
})

export const AGENT_TOOLS: readonly AgentToolDef[] = [
  ...GENERATION_TOOLS,
  {
    name: 'scene.get_state',
    access: 'read',
    summary: '读场景状态（资产/变换/AABB/模型目录）',
    description:
      '读取当前场景的中立快照：资产清单（id、ref、transform、世界包围盒）、环境、选中项，' +
      '可附带模型库目录。来源是内存中的 SceneDocument（含未保存编辑），不是磁盘文件。',
    argsDoc: '{ includeManifest?: boolean }',
    schema: {
      type: 'object',
      properties: {
        includeManifest: { type: 'boolean', description: '是否附带模型库目录（默认 true）' },
      },
      additionalProperties: false,
    },
    exec: sceneGetState,
  },
  {
    name: 'viewport.screenshot',
    access: 'read',
    summary: '视口截图或使用自定义相机截图',
    description: '截取当前视口，或提供 camera 指定透视/正交相机，隐藏编辑器辅助件；自定义相机不会改变用户视角。开启图像输入时附图回传。',
    argsDoc: '{ maxWidth?, width?, height?, camera?: { projection, position, target, up?, near?, far?, fovDeg?, viewHeight? } } → { image, width, height, screenshotId?, camera? }',
    schema: {
      type: 'object',
      properties: {
        maxWidth: { type: 'number', description: '返回 PNG 的最大宽度（等比缩小），默认 1024' },
        width: { type: 'integer', minimum: 1, maximum: 2048 },
        height: { type: 'integer', minimum: 1, maximum: 2048 },
        camera: { type: 'object', required: ['projection', 'position', 'target'], properties: {
          projection: { type: 'string', enum: ['perspective', 'orthographic'] },
          position: vec3Schema('相机世界坐标'), target: vec3Schema('相机目标世界坐标'), up: vec3Schema('向上方向，默认 [0,1,0]'),
          near: { type: 'number', exclusiveMinimum: 0 }, far: { type: 'number', exclusiveMinimum: 0 },
          fovDeg: { type: 'number', exclusiveMinimum: 0, maximum: 179 }, viewHeight: { type: 'number', exclusiveMinimum: 0 },
        }, additionalProperties: false },
      },
      additionalProperties: false,
    },
    exec: viewportScreenshot,
  },
  {
    name: 'viewport.pick',
    access: 'read',
    summary: '视觉点选（截图像素坐标 → 射线拾取资产）',
    description:
      '视觉点选：基于最近一次 viewport.screenshot 的截图拾取物体。(x,y) 是该截图图像上的像素坐标' +
      '（左上原点），imageWidth/imageHeight 填该截图返回的宽高。返回命中的资产' +
      '（id/transform/worldAabb）与射线命中点 hit.point（世界坐标，米）。' +
      '重要：坐标必须对应最近一次截图；截图后若场景或视角已变化，先重新截图再点选。' +
      '未命中不报错，返回 assetId:null。命中物体会在视口瞬时高亮（视觉反馈，不改变选中状态）。',
    argsDoc: '{ x, y, imageWidth, imageHeight, highlight? } → { assetId, transform, hit } | { assetId:null }',
    schema: {
      type: 'object',
      required: ['x', 'y', 'imageWidth', 'imageHeight'],
      properties: {
        x: { type: 'integer', minimum: 0, description: '像素列（截图图像，左上原点）' },
        y: { type: 'integer', minimum: 0, description: '像素行（截图图像，左上原点）' },
        imageWidth: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: '坐标所属截图的宽（即 viewport.screenshot 返回的 width）',
        },
        imageHeight: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: '坐标所属截图的高（即 viewport.screenshot 返回的 height）',
        },
        highlight: { type: 'boolean', description: '是否瞬时高亮命中的物体（默认 true）' },
        screenshotId: { type: 'string', description: '自定义相机截图返回的 screenshotId' },
      },
      additionalProperties: false,
    },
    exec: viewportPick,
  },
  {
    name: 'asset.set_transform',
    access: 'write',
    summary: '改资产变换（绝对值，仅任务内）',
    description:
      '设置资产的世界变换。position/rotation 为必填（欧拉角角度制），scale 可选。' +
      '仅在任务事务内可用；即时生效到视口，按当前权限模式入账（变更前确认 / 自动编辑）。' +
      '也可使用 asset.adjust_transform 做相对调整。',
    argsDoc: '{ assetId, transform: { position, rotation, scale? } }',
    schema: {
      type: 'object',
      required: ['assetId', 'transform'],
      properties: {
        assetId: { type: 'string', description: '场景内资产 id（见 scene.get_state / viewport.pick）' },
        transform: {
          type: 'object',
          required: ['position', 'rotation'],
          properties: {
            position: vec3Schema('世界坐标（米，+Y 向上，资产底面中心）'),
            rotation: vec3Schema('欧拉角，角度制，XYZ 顺序'),
            scale: vec3Schema('相对模型 native 尺寸的缩放，默认 [1,1,1]'),
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    exec: assetSetTransform,
  },
  {
    name: 'asset.adjust_transform',
    access: 'write',
    summary: '增量调整变换（仅任务内）',
    description:
      '相对增量调整资产变换（视觉微调主路径）：translate 叠加平移（米，世界坐标）、' +
      'rotateDeg 叠加旋转（角度制）、scaleMul 乘上当前缩放（数字=三轴同倍，[x,y,z]=分轴）。' +
      '未提供的轴保持不变——不需要先查当前值再复述全量。仅在任务事务内可用。',
    argsDoc: '{ assetId, translate?, rotateDeg?, scaleMul? } → { assetId, transform }',
    schema: {
      type: 'object',
      required: ['assetId'],
      properties: {
        assetId: { type: 'string', description: '场景内资产 id（如 viewport.pick 的返回）' },
        translate: vec3Schema('平移增量（米，世界坐标，叠加到当前 position）'),
        rotateDeg: vec3Schema('旋转增量（角度制 XYZ，叠加到当前 rotation）'),
        scaleMul: {
          description: '缩放倍率（乘到当前 scale）：数字=三轴同倍；[x,y,z]=分轴。须为正数',
          anyOf: [
            { type: 'number', exclusiveMinimum: 0 },
            {
              type: 'array',
              items: { type: 'number', exclusiveMinimum: 0 },
              minItems: 3,
              maxItems: 3,
            },
          ],
        },
      },
      additionalProperties: false,
    },
    exec: assetAdjustTransform,
  },
  {
    name: 'asset.add',
    access: 'write',
    summary: '添加资产（仅任务内，id 由前端铸造）',
    description:
      '从模型库引用添加资产实例（不复制模型文件）。id 由编辑器铸造并在结果中返回。',
    argsDoc: '{ ref, position, rotation?, scale?, name? } → { assetId }',
    schema: {
      type: 'object',
      required: ['ref', 'position'],
      properties: {
        ref: { type: 'string', description: "模型库引用，如 'models/placeholder-box'，必须来自 manifest" },
        position: vec3Schema('放置位置（米，+Y 向上，底面中心落点）'),
        rotation: vec3Schema('欧拉角，角度制，默认 [0,0,0]'),
        scale: vec3Schema('相对 native 尺寸的缩放，默认 [1,1,1]'),
        name: { type: 'string', description: '显示名（可中文）' },
      },
      additionalProperties: false,
    },
    exec: assetAdd,
  },
  {
    name: 'asset.remove',
    access: 'write',
    summary: '删除资产（仅任务内，可回滚）',
    description: '按 id 删除资产实例。提案被拒绝时自动恢复。',
    argsDoc: '{ assetId }',
    schema: {
      type: 'object',
      required: ['assetId'],
      properties: {
        assetId: { type: 'string', description: '要删除的资产 id' },
      },
      additionalProperties: false,
    },
    exec: assetRemove,
  },
  {
    name: 'log.list',
    access: 'read',
    summary: '列出已有调用记录文件名',
    description:
      '列出 logs/ 目录下已有的调用记录文件名（log时间戳-名称.md，不含 Artificial 人工范文）。' +
      '写新记录前可查看命名示例，或找回要编辑（覆写）的文件名。',
    argsDoc: '{} → { files }',
    schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    exec: logList,
  },
  {
    name: 'log.write',
    access: 'export',
    summary: '生成/覆写调用记录 md（仅 logs/ 目录）',
    description:
      '把某轮对话的调用记录写成 markdown 文件（logs/log时间戳-名称.md）。三部分结构：' +
      '第一部分 editsRecap = 你凭自己的回忆写本轮的编辑清单与每次参数（只读调用可略述）；' +
      '第二部分 explanation = 总目的与每一步为什么这么做；第三部分由编辑器按实际调用记录自动生成，' +
      '不要在参数里伪造。name 为日志名称（进文件名，可中文，由你起名）；round 选覆盖第几轮对话' +
      '（一条用户指令 = 一轮，默认 last = 最近一轮）；要修改已生成的日志时，把上次结果返回的 ' +
      'filename 原样传入即覆写该文件。不进任务事务、不影响场景。',
    argsDoc: '{ name, editsRecap, explanation, round?, filename? } → { file, round, mode }',
    schema: {
      type: 'object',
      required: ['name', 'editsRecap', 'explanation'],
      properties: {
        name: { type: 'string', description: '日志名称（进文件名，可中文，≤40 字符）' },
        editsRecap: { type: 'string', description: '第一部分 markdown：你回忆的本轮编辑清单与参数' },
        explanation: { type: 'string', description: '第二部分 markdown：总目的与每步理由' },
        round: {
          description: '覆盖第几轮对话（正整数），默认 "last" = 最近一轮',
          anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['last'] }],
        },
        filename: {
          type: 'string',
          description: '编辑已有日志时传（上次 log.write 结果返回的 filename），覆写该文件',
        },
      },
      additionalProperties: false,
    },
    exec: logWrite,
  },
]

/** 明确不开放的能力（面板权限区展示；调用即拒绝） */
export const AGENT_DENIED: readonly string[] = [
  '直接操作 three 对象（渲染同步层私有）',
  '场景直接保存/落盘（任务入账后由编辑器自动保存）；log.write 仅可写 logs/ 下的调用记录',
  '切换场景、修改用户主相机或选中状态（截图可使用独立相机）',
  '任务事务之外的一切场景写操作',
  '未在工具白名单中的任何工具',
]

const TOOL_NAMES = new Set<string>(AGENT_TOOLS.map(t => t.name))

export function isAgentToolName(v: unknown): v is AgentToolName {
  return typeof v === 'string' && TOOL_NAMES.has(v)
}

export type AgentToolResult = { ok: true; data: unknown } | { ok: false; error: string }

/** 统一执行入口：白名单校验 + 异常兜底，session 只消费 Result */
export async function runAgentTool(
  name: unknown,
  args: Record<string, unknown>,
  ctx: AgentToolContext,
): Promise<AgentToolResult> {
  if (!isAgentToolName(name)) {
    return { ok: false, error: `工具 ${String(name)} 未授权（不在编辑器开放清单内）` }
  }
  const def = AGENT_TOOLS.find(t => t.name === name)!
  try {
    return { ok: true, data: await def.exec(args ?? {}, ctx) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
