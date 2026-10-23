/**
 * 原生格式写出层：把转换结果组装为宿主可消费的 scene.json / meta.json /
 * view.json / 报告。纯数据构造，无 three.js 依赖。
 *
 * 字段镜像 src/core/types.ts（见 application/contracts.ts 说明）。
 */

import type {
  ImportModelDecl, ImportReport, LayoutImport, NativeModelMeta,
  NativeSceneAsset, NativeSceneDocument, NativeViewBinding, Vec3,
} from '../../application/contracts.js'
import { CONVERTER_NAME, CONVERTER_VERSION } from '../../application/contracts.js'
import { modelRef } from '../../application/naming.js'
import type { ConvertedTrs } from '../three/normalize-math.js'

export interface SceneAssetInput {
  instance: { id: string; modelKey: string; name?: string; visible?: boolean }
  transform: ConvertedTrs
}

export function buildSceneDocument(
  scene: { id: string; name: string },
  assets: SceneAssetInput[],
  camera?: { id: string; position: Vec3; target?: Vec3; fov?: number },
  environment?: NativeSceneDocument['environment'],
): NativeSceneDocument {
  const outAssets: NativeSceneAsset[] = assets.map(({ instance, transform }) => {
    const asset: NativeSceneAsset = {
      id: instance.id,
      ref: modelRefFor(scene.id, instance.modelKey),
      transform: {
        position: transform.position,
        rotation: transform.rotation,
        scale: transform.scale,
      },
    }
    if (instance.name !== undefined) asset.name = instance.name
    if (instance.visible === false) asset.visible = false
    return asset
  })
  return {
    meta: { id: scene.id, name: scene.name, version: 1, unit: 'm', up: '+Y' },
    environment: environment ?? {},
    assets: outAssets,
    cameras: camera ? [camera] : [],
  }
}

function modelRefFor(sceneId: string, modelKey: string): string {
  return modelRef(`${sceneId}-${modelKey}`)
}

export function buildModelMeta(
  dir: string,
  model: ImportModelDecl,
  dimensions: { w: number; d: number; h: number },
): NativeModelMeta {
  const meta: NativeModelMeta = {
    id: dir,
    name: model.name,
    dimensions,
    source: { type: 'glb', file: 'model.glb' },
    normalized: { unitScale: 1, origin: 'base-center', up: '+Y' },
  }
  if (model.category !== undefined) meta.category = model.category
  if (model.tags !== undefined) meta.tags = model.tags
  if (model.color !== undefined) meta.color = model.color
  if (model.license !== undefined) meta.license = model.license
  return meta
}

export function buildViewBinding(decl: LayoutImport): NativeViewBinding | null {
  if (!decl.view && !decl.camera) return null
  const view: NativeViewBinding = {}
  view.cameraId = decl.view?.cameraId ?? decl.camera?.id ?? 'main-camera'
  if (decl.view?.grid !== undefined) view.grid = decl.view.grid
  return view
}

export function buildReport(input: {
  sceneId: string
  models: ImportReport['models']
  issues: Array<{ code: string; severity: string; message: string }>
  instanceCount: number
}): ImportReport {
  return {
    format: '3d-layout-import-report',
    schemaVersion: 1,
    sceneId: input.sceneId,
    instanceCount: input.instanceCount,
    models: input.models,
    issues: input.issues,
    converter: CONVERTER_NAME,
    converterVersion: CONVERTER_VERSION,
    createdAt: new Date().toISOString(),
  }
}

/** suffix-hash 冲突策略：改写场景 ID 与全部模型 ref（服务端暂存阶段使用） */
export function rewriteSceneDoc(
  doc: NativeSceneDocument,
  newSceneId: string,
  dirRenames: Map<string, string>,
): NativeSceneDocument {
  const rewritten: NativeSceneDocument = {
    ...doc,
    meta: { ...doc.meta, id: newSceneId },
    assets: doc.assets.map(a => {
      const dir = a.ref.replace(/^models\//, '')
      const newDir = dirRenames.get(dir) ?? dir
      return { ...a, ref: modelRef(newDir) }
    }),
  }
  return rewritten
}
