/**
 * 数据契约：scene.json / threejs 视图绑定 / 模型库 meta.json。
 * 这些类型是整个系统（前端渲染、二期编辑器、后期 Agent/其他语言）的公共语言。
 *
 * 全局约定：单位=米；+Y 向上；欧拉角用角度制（对人友好）；模型原点在底面中心。
 */

/** [x, y, z] */
export type Vec3 = [number, number, number]

export interface Transform {
  position: Vec3
  /** 欧拉角，角度制，XYZ 顺序 */
  rotation: Vec3
  /** 相对模型 native 尺寸的缩放，缺省 [1,1,1] */
  scale?: Vec3
}

// ---------- scene.json（中立的场景描述，唯一事实源） ----------

export interface SceneMeta {
  id: string
  name: string
  version: number
  /** 数据单位，目前固定 'm' */
  unit: 'm'
  /** 向上轴，目前固定 '+Y' */
  up: '+Y'
}

export interface SceneEnvironment {
  /** 背景色 */
  background?: string
  /** 环境贴图，assets 下的路径（如 'assets/hdri/studio-01.hdr'）；缺省用程序化 RoomEnvironment（离线可用） */
  hdri?: string
  /** 主方向光强度，默认 1.6 */
  sunIntensity?: number
  ground?: {
    /** 地面尺寸 [x, z]，默认 [20, 20] */
    size?: [number, number]
    receiveShadow?: boolean
  }
}

export interface SceneAsset {
  /** 场景内唯一 id —— 编辑器与 Agent 都用它寻址 */
  id: string
  /** 模型库引用，如 'models/placeholder-box' */
  ref: string
  /** 显示名（可中文） */
  name?: string
  transform: Transform
  /** 覆盖占位模型的显示颜色（对 glb 无效），也供 Agent 高亮使用 */
  tint?: string
  /** 默认 true */
  visible?: boolean
}

export interface SceneCamera {
  id: string
  position: Vec3
  /** 注视点，默认 [0,0,0] */
  target?: Vec3
  fov?: number
}

export interface SceneDocument {
  meta: SceneMeta
  environment: SceneEnvironment
  assets: SceneAsset[]
  cameras: SceneCamera[]
}

// ---------- scenes/<id>/threejs/view.json（ThreeJS 渲染绑定，可选） ----------

/** 场景的渲染器专属配置。同一场景以后可并列增加 python/ 等其他语言的绑定目录 */
export interface ViewBinding {
  /** 使用 scene.json 中的哪个相机，默认 cameras[0] */
  cameraId?: string
  /** 覆盖初始相机（优先级高于 cameras） */
  camera?: { position: Vec3; target?: Vec3; fov?: number }
  environment?: {
    hdri?: string | null
    background?: string
    sunIntensity?: number
  }
  grid?: { enabled?: boolean; size?: number }
  /** 模块装配配置：编辑器模块的默认开关（URL ?editor=0/1 优先级更高） */
  editor?: { enabled?: boolean }
}

// ---------- 模型库 meta.json ----------

export type ModelSource =
  | { type: 'primitive'; shape: 'box' | 'cylinder' | 'sphere' }
  | { type: 'glb'; file: string; draco?: boolean }

/**
 * 每个模型一个 meta.json。
 * dimensions 是 native（未缩放）真实尺寸，米；场景中最终尺寸 = dimensions × transform.scale。
 */
export interface ModelMeta {
  id: string
  name: string
  category?: string
  tags?: string[]
  /** native 包围盒尺寸 [宽 w(x), 高 h(y), 深 d(z)] */
  dimensions: { w: number; d: number; h: number }
  source: ModelSource
  /** 占位模型的默认颜色 */
  color?: string
  /** 入库归一化记录 */
  normalized?: { unitScale?: number; origin?: string; up?: string }
  license?: string
}

/** assets/models/manifest.json —— 由 scripts/gen-manifest.mjs 生成，勿手改 */
export interface ModelManifest {
  generatedAt: string
  /** key 为模型引用：'models/<文件夹名>' */
  models: Record<string, ModelMeta>
}

/** scenes/index.json —— 由 scripts/gen-manifest.mjs 生成 */
export interface SceneIndexEntry {
  id: string
  name: string
}
