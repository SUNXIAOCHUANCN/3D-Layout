/**
 * 数据契约：layout-import.json 输入契约 + 宿主原生格式镜像。
 *
 * 宿主镜像（NativeSceneDocument / NativeModelMeta / NativeViewBinding）按
 * 3D-Layout src/core/types.ts v0.1.0 逐字段复刻；插件不 import 宿主源码，
 * 漂移由 tests/fixtures 兼容性样例检测（架构文档 §13）。
 */

export type Vec3 = [number, number, number]

export const IMPORT_SCHEMA_VERSION = 1
/** 一期固定转换配置版本；影响 definitionHash */
export const NORMALIZATION_VERSION = 'layout-static-v1'
export const CONVERTER_NAME = 'threejs-interchange'
export const CONVERTER_VERSION = '0.1.0'

export const CONFLICT_POLICIES = ['reject', 'suffix-hash'] as const
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number]

// ---------- layout-import.json（一期 A 输入契约） ----------

export interface ImportCoordinates {
  /** 源场景 1 单位 = 多少米 */
  metersPerUnit: number
  up: '+Y' | '+Z'
  handedness: 'right'
}

export interface ImportModelDecl {
  key: string
  name: string
  category?: string
  tags?: string[]
  /** 包内相对路径，如 'models/pine-tree.glb' */
  file: string
  license?: string
  /** 占位显示色（host ModelMeta.color） */
  color?: string
}

export interface ImportTransform {
  position: Vec3
  /** 欧拉角角度制 XYZ，源坐标系 */
  rotation?: Vec3
  scale?: Vec3
}

export interface ImportInstance {
  id: string
  modelKey: string
  name?: string
  transform: ImportTransform
  visible?: boolean
}

export interface ImportSceneDecl {
  id: string
  name: string
}

export interface ImportCamera {
  id?: string
  position: Vec3
  target?: Vec3
  fov?: number
}

export interface ImportEnvironment {
  background?: string
  /** 包内路径，必须随包提供，如 'assets/hdri/foo.hdr' */
  hdri?: string
  sunIntensity?: number
  ground?: {
    size?: [number, number]
    receiveShadow?: boolean
  }
}

export interface ImportView {
  cameraId?: string
  grid?: { enabled?: boolean; size?: number }
}

export interface LayoutImport {
  schemaVersion: number
  profile: 'layout-static-v1'
  scene: ImportSceneDecl
  coordinates: ImportCoordinates
  models: ImportModelDecl[]
  instances: ImportInstance[]
  camera?: ImportCamera
  environment?: ImportEnvironment
  view?: ImportView
  options?: { conflict?: ConflictPolicy }
}

// ---------- 宿主原生格式镜像（src/core/types.ts） ----------

export interface NativeSceneMeta {
  id: string
  name: string
  version: number
  unit: 'm'
  up: '+Y'
}

export interface NativeTransform {
  position: Vec3
  rotation: Vec3
  scale?: Vec3
}

export interface NativeSceneAsset {
  id: string
  ref: string
  name?: string
  transform: NativeTransform
  tint?: string
  visible?: boolean
}

export interface NativeSceneDocument {
  meta: NativeSceneMeta
  environment: {
    background?: string
    hdri?: string
    sunIntensity?: number
    ground?: { size?: [number, number]; receiveShadow?: boolean }
  }
  assets: NativeSceneAsset[]
  cameras: Array<{ id: string; position: Vec3; target?: Vec3; fov?: number }>
}

export interface NativeModelMeta {
  id: string
  name: string
  category?: string
  tags?: string[]
  dimensions: { w: number; d: number; h: number }
  source: { type: 'glb'; file: string; draco?: boolean }
  color?: string
  normalized?: { unitScale?: number; origin?: string; up?: string }
  license?: string
}

export interface NativeViewBinding {
  cameraId?: string
  camera?: { position: Vec3; target?: Vec3; fov?: number }
  environment?: { hdri?: string | null; background?: string; sunIntensity?: number }
  grid?: { enabled?: boolean; size?: number }
  editor?: { enabled?: boolean }
}

// ---------- sidecar：import-integrity.json ----------

export interface ImportIntegrity {
  format: '3d-layout-import-integrity'
  schemaVersion: 1
  converter: string
  converterVersion: string
  normalizationVersion: string
  source: {
    file: string
    sha256: string
    bytes: number
    coordinates: ImportCoordinates
  }
  canonical: { file: 'model.glb'; sha256: string; bytes: number }
  /** 稳定序列化的模型定义摘要：规范化版本 + 规范边界 + 规范字节摘要（不含名称/标签） */
  definitionHash: string
  localBounds: { min: Vec3; max: Vec3 }
  /** 源模型局部 → 规范局部的矩阵 N，16 元素列主序 */
  sourceToCanonical: number[]
  createdAt: string
}

// ---------- 导出包 package.json ----------

export interface PackageManifest {
  format: '3d-layout-package'
  schemaVersion: 1
  kind: 'scene' | 'model'
  entry: string
  sceneId?: string
  modelRef?: string
  createdAt: string
  /** 逐文件校验和；不含 package.json 自身 */
  files: Record<string, { sha256: string; bytes: number }>
}

// ---------- 计划与报告 ----------

export interface ModelPlanEntry {
  key: string
  dir: string
  ref: string
  sourceFile: string
  canonicalSha256: string
  canonicalBytes: number
  dimensions: { w: number; d: number; h: number }
  warnings: Array<{ code: string; severity: string; message: string }>
}

export interface ImportPlan {
  sceneId: string
  sceneDir: string
  models: ModelPlanEntry[]
  instanceCount: number
  files: string[]
  warnings: Array<{ code: string; severity: string; message: string }>
}

export interface ImportReport {
  format: '3d-layout-import-report'
  schemaVersion: 1
  sceneId: string
  converter: string
  converterVersion: string
  instanceCount: number
  models: Array<{
    key: string
    dir: string
    sourceSha256: string
    canonicalSha256: string
    dimensions: { w: number; d: number; h: number }
    warnings: Array<{ code: string; severity: string; message: string }>
  }>
  issues: Array<{ code: string; severity: string; message: string; path?: string }>
  createdAt: string
}
