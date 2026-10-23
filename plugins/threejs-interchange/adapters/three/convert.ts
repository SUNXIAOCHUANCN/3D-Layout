/**
 * 浏览器转换管线（一期 A）：layout-import.json + 每模型一个自包含静态 GLB
 * → 规范 GLB + 原生 scene.json/meta.json/integrity + 报告（候选文件集）。
 *
 * 需要浏览器纹理解码能力，运行在插件 UI 页面；服务端用纯数据检查器独立复核。
 * 转换在内存完成，不触碰宿主场景（架构文档 §2 插件边界）。
 */

import { Box3, Group, Matrix4, Mesh, Object3D, Quaternion, SkinnedMesh, Vector3, type Material, type Texture } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import {
  NORMALIZATION_VERSION,
  type ImportIntegrity, type ImportModelDecl, type ImportReport,
  type ImportPlan, type LayoutImport, type ModelPlanEntry, type Vec3,
} from '../../application/contracts.js'
import { InterchangeError, type Issue, infoIssue } from '../../application/errors.js'
import { sha256Hex, textBytes } from '../../application/digest.js'
import { stableStringify, roundForHash } from '../../application/json.js'
import { inspectGlb, COMPRESSED_EXTENSIONS } from '../../application/glb-inspect.js'
import { modelDirName, modelRef } from '../../application/naming.js'
import {
  normalizationMatrix, sourceBoundsOf, convertInstanceTrs, convertPoint, convertGroundSize,
  matrixToArrayColMajor,
  type InstanceTrs,
} from './normalize-math.js'
import { buildSceneDocument, buildModelMeta, buildReport, buildViewBinding } from '../layout/native-write.js'

export interface ConvertInput {
  declaration: LayoutImport
  /** 声明文件原始字节（候选包内保留 import/layout-import.json 作来源凭证） */
  declarationBytes: Uint8Array
  /** 输入文件集：posix 相对路径 → 字节 */
  files: Map<string, Uint8Array>
}

export interface ConvertOutput {
  /** 候选原生文件集：工程相对路径 → 字节（scenes/...、assets/...、import/layout-import.json） */
  candidateFiles: Map<string, Uint8Array>
  plan: ImportPlan
  report: ImportReport
  issues: Issue[]
}

export async function convertImport(input: ConvertInput): Promise<ConvertOutput> {
  const { declaration, files } = input
  const issues: Issue[] = []
  const sceneId = declaration.scene.id

  const hdriPath = declaration.environment?.hdri
  if (hdriPath !== undefined && !files.has(hdriPath)) {
    throw new InterchangeError('MISSING_RESOURCE', `environment.hdri 声明了 ${hdriPath} 但未提供文件`, { path: hdriPath })
  }

  const candidateFiles = new Map<string, Uint8Array>()
  const modelEntries: ModelPlanEntry[] = []
  const nByModelKey = new Map<string, Matrix4>()
  const reportModels: ImportReport['models'] = []

  for (const model of declaration.models) {
    const sourceBytes = files.get(model.file)
    if (!sourceBytes) {
      throw new InterchangeError('MISSING_RESOURCE', `模型 ${model.key} 声明的文件 ${model.file} 不在输入集合中（共 ${files.size} 个文件）`, { path: model.file })
    }
    const converted = await convertModel(model, sourceBytes, declaration)
    const dir = modelDirName(sceneId, model.key)

    candidateFiles.set(`assets/models/${dir}/model.glb`, new Uint8Array(converted.canonicalGlb))
    candidateFiles.set(`assets/models/${dir}/meta.json`, textBytes(prettyJson(buildModelMeta(dir, model, converted.dimensions))))
    candidateFiles.set(`assets/models/${dir}/import-integrity.json`, textBytes(prettyJson(converted.integrity)))

    const warnings = converted.issues
    modelEntries.push({
      key: model.key,
      dir,
      ref: modelRef(dir),
      sourceFile: model.file,
      canonicalSha256: converted.canonicalSha256,
      canonicalBytes: converted.canonicalGlb.byteLength,
      dimensions: converted.dimensions,
      warnings,
    })
    reportModels.push({
      key: model.key,
      dir,
      sourceSha256: converted.sourceSha256,
      canonicalSha256: converted.canonicalSha256,
      dimensions: converted.dimensions,
      warnings,
    })
    nByModelKey.set(model.key, converted.n)
    issues.push(...converted.issues)
  }

  // 实例变换换算：W_target = C · W_src · N⁻¹，逐实例补偿规范化
  const assetsOut = []
  for (const inst of declaration.instances) {
    const n = nByModelKey.get(inst.modelKey)
    if (!n) throw new InterchangeError('INVALID_DECLARATION', `实例 ${inst.id} 引用未转换的模型 ${inst.modelKey}`, { assetId: inst.id })
    const result = convertInstanceTrs(declaration.coordinates, inst.transform as InstanceTrs, n)
    if (!result.ok) {
      throw new InterchangeError(result.code, `实例 ${inst.id}：${result.message}`, { assetId: inst.id })
    }
    assetsOut.push({ instance: inst, transform: result.value })
  }

  const camera = declaration.camera
    ? {
        id: declaration.camera.id ?? 'main-camera',
        position: convertPoint(declaration.coordinates, declaration.camera.position),
        target: declaration.camera.target ? convertPoint(declaration.coordinates, declaration.camera.target) : undefined,
        fov: declaration.camera.fov,
      }
    : undefined

  const environment = declaration.environment
    ? {
        background: declaration.environment.background,
        hdri: hdriPath,
        sunIntensity: declaration.environment.sunIntensity,
        ground: declaration.environment.ground
          ? {
              size: declaration.environment.ground.size
                ? convertGroundSize(declaration.coordinates, declaration.environment.ground.size)
                : undefined,
              receiveShadow: declaration.environment.ground.receiveShadow,
            }
          : undefined,
      }
    : undefined
  if (hdriPath !== undefined) candidateFiles.set(hdriPath, files.get(hdriPath)!)

  const sceneDoc = buildSceneDocument(declaration.scene, assetsOut, camera, environment)
  candidateFiles.set(`scenes/${sceneId}/scene.json`, textBytes(prettyJson(sceneDoc)))

  const view = buildViewBinding(declaration)
  if (view) candidateFiles.set(`scenes/${sceneId}/threejs/view.json`, textBytes(prettyJson(view)))

  candidateFiles.set('import/layout-import.json', input.declarationBytes)

  const report = buildReport({ sceneId, models: reportModels, issues, instanceCount: declaration.instances.length })
  candidateFiles.set(`scenes/${sceneId}/import-report.json`, textBytes(prettyJson(report)))

  const plan: ImportPlan = {
    sceneId,
    sceneDir: `scenes/${sceneId}`,
    models: modelEntries,
    instanceCount: declaration.instances.length,
    files: Array.from(candidateFiles.keys()).sort(),
    warnings: issues.map(i => ({ code: i.code, severity: i.severity, message: i.message })),
  }

  return { candidateFiles, plan, report, issues }
}

interface ModelConversion {
  canonicalGlb: ArrayBuffer
  canonicalSha256: string
  sourceSha256: string
  dimensions: { w: number; d: number; h: number }
  localBounds: { min: Vec3; max: Vec3 }
  integrity: ImportIntegrity
  n: Matrix4
  issues: Issue[]
}

async function convertModel(model: ImportModelDecl, sourceBytes: Uint8Array, declaration: LayoutImport): Promise<ModelConversion> {
  const issues: Issue[] = []
  const coords = declaration.coordinates
  const { key, file } = model

  // 第一道：纯数据检查（与服务端共享同一实现，先于解码，快速失败）
  const inspection = inspectGlb(sourceBytes, coords)
  for (const ext of inspection.extensionsUsed) {
    if (COMPRESSED_EXTENSIONS.has(ext) || inspection.extensionsRequired.includes(ext)) {
      throw new InterchangeError('COMPRESSED_INPUT', `模型 ${key} 使用压缩/必需扩展 ${ext}；一期只接收未压缩静态 GLB，请先解码导出`, { path: file })
    }
  }
  if (inspection.externalRefs.length > 0) {
    throw new InterchangeError('EXTERNAL_RESOURCE_REF', `模型 ${key} 引用外部资源 ${inspection.externalRefs.join(', ')}；请导出自包含 GLB（一期 B 才支持 glTF 文件集合）`, { path: file })
  }
  if (inspection.stats.skins > 0) {
    throw new InterchangeError('UNSUPPORTED_SKIN', `模型 ${key} 含蒙皮（skins=${inspection.stats.skins}）；请先烘焙为静态网格`, { path: file })
  }
  if (inspection.stats.morphTargets > 0) {
    throw new InterchangeError('UNSUPPORTED_MORPH', `模型 ${key} 含 morph 目标；请先固化目标姿态导出`, { path: file })
  }
  if (inspection.stats.animations > 0) {
    issues.push(infoIssue('ANIMATIONS_IGNORED', `模型 ${key} 含 ${inspection.stats.animations} 段动画；静态导入不携带，转换时忽略`))
  }

  // 第二道：解码后的对象级检查
  const root = await parseGlb(sourceBytes, key)
  checkObjectTree(root, key, file)

  const bounds = sourceBoundsOf(root)
  if (bounds.isEmpty()) {
    throw new InterchangeError('INVALID_DECLARATION', `模型 ${key} 无有效几何（空包围盒）`, { path: file })
  }

  const { n } = normalizationMatrix(coords, bounds)
  const canonicalBounds = new Box3().copy(bounds).applyMatrix4(n)

  // 规范模型：N 挂在根节点，源层级与材质数据原样保留（不合并网格）
  const canonicalRoot = new Group()
  canonicalRoot.name = key
  canonicalRoot.matrixAutoUpdate = false
  canonicalRoot.matrix.copy(n)
  canonicalRoot.add(root)

  const canonicalGlb = await exportGlb(canonicalRoot)

  const sourceSha256 = await sha256Hex(sourceBytes)
  const canonicalSha256 = await sha256Hex(canonicalGlb)
  const size = canonicalBounds.getSize(new Vector3())
  const dimensions = { w: size.x, h: size.y, d: size.z }
  const localBounds = {
    min: [canonicalBounds.min.x, canonicalBounds.min.y, canonicalBounds.min.z] as Vec3,
    max: [canonicalBounds.max.x, canonicalBounds.max.y, canonicalBounds.max.z] as Vec3,
  }
  const definitionHash = await sha256Hex(
    textBytes(stableStringify({
      normalizationVersion: NORMALIZATION_VERSION,
      localBounds: {
        min: localBounds.min.map(v => roundForHash(v)),
        max: localBounds.max.map(v => roundForHash(v)),
      },
      canonicalSha256,
    })),
  )

  const integrity: ImportIntegrity = {
    format: '3d-layout-import-integrity',
    schemaVersion: 1,
    converter: 'threejs-interchange',
    converterVersion: '0.1.0',
    normalizationVersion: NORMALIZATION_VERSION,
    source: { file, sha256: sourceSha256, bytes: sourceBytes.byteLength, coordinates: coords },
    canonical: { file: 'model.glb', sha256: canonicalSha256, bytes: canonicalGlb.byteLength },
    definitionHash,
    localBounds,
    sourceToCanonical: matrixToArrayColMajor(n),
    createdAt: new Date().toISOString(),
  }

  return { canonicalGlb, canonicalSha256, sourceSha256, dimensions, localBounds, integrity, n, issues }
}

/** 解码后对象级静态检查：蒙皮/morph/视频与压缩纹理/剪切/镜像 */
function checkObjectTree(root: Object3D, key: string, file: string): void {
  root.updateWorldMatrix(true, true)
  root.traverse(obj => {
    if (obj instanceof SkinnedMesh || (obj as { isBone?: boolean }).isBone) {
      throw new InterchangeError('UNSUPPORTED_SKIN', `模型 ${key} 装载后仍含蒙皮对象 ${obj.name || obj.type}；请先烘焙`, { path: file })
    }
    const geometry = (obj as Mesh).geometry as { morphAttributes?: Record<string, unknown> } | undefined
    if (geometry?.morphAttributes && Object.keys(geometry.morphAttributes).length > 0) {
      throw new InterchangeError('UNSUPPORTED_MORPH', `模型 ${key} 的 ${obj.name || 'mesh'} 含 morph 属性；请先固化姿态`, { path: file })
    }
    const material = (obj as Mesh).material as Material | Material[] | undefined
    if (material) {
      for (const m of Array.isArray(material) ? material : [material]) {
        for (const value of Object.values(m)) {
          if (isTexture(value)) {
            const t = value as Texture & { isVideoTexture?: boolean; isCompressedTexture?: boolean }
            if (t.isVideoTexture) {
              throw new InterchangeError('UNSUPPORTED_VIDEO_TEXTURE', `模型 ${key} 的材质含视频纹理；一期不支持`, { path: file })
            }
            if (t.isCompressedTexture) {
              throw new InterchangeError('COMPRESSED_INPUT', `模型 ${key} 的材质含压缩纹理；请导出为未压缩贴图`, { path: file })
            }
          }
        }
      }
    }
    // 世界矩阵可表达性：剪切/镜像/奇异拒绝（架构文档 §5.2）
    const w = obj.matrixWorld
    const det = w.determinant()
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      throw new InterchangeError('SINGULAR_TRANSFORM', `模型 ${key} 的节点 ${obj.name || obj.type} 世界矩阵奇异`, { path: file })
    }
    if (det < 0) {
      throw new InterchangeError('MIRRORED_TRANSFORM', `模型 ${key} 的节点 ${obj.name || obj.type} 含镜像（det<0）；请先在源端烘焙`, { path: file })
    }
    const pos = new Vector3()
    const quat = new Quaternion()
    const scl = new Vector3()
    w.decompose(pos, quat, scl)
    const err = matrixRecomposeError(w, new Matrix4().compose(pos, quat, scl))
    if (err > 1e-6) {
      throw new InterchangeError('NON_TRS_TRANSFORM', `模型 ${key} 的节点 ${obj.name || obj.type} 世界矩阵含剪切（重构误差 ${err.toExponential(2)}）；请先烘焙为静态几何`, { path: file })
    }
  })
}

function matrixRecomposeError(original: Matrix4, recomposed: Matrix4): number {
  let maxNorm = 1e-12
  let maxDiff = 0
  for (let i = 0; i < 16; i++) {
    maxNorm = Math.max(maxNorm, Math.abs(original.elements[i]))
    maxDiff = Math.max(maxDiff, Math.abs(original.elements[i] - recomposed.elements[i]))
  }
  return maxDiff / maxNorm
}

function isTexture(v: unknown): v is Texture {
  return !!v && typeof v === 'object' && 'isTexture' in v
}

function parseGlb(bytes: Uint8Array, key: string): Promise<Group> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader()
    // slice() 确保 buffer 自包含（视图可能偏移）
    loader.parse(bytes.slice().buffer as ArrayBuffer, '', gltf => resolve(gltf.scene), err => {
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? (err.stack ?? '').split('\n').slice(1, 3).join(' | ') : ''
      if (/draco/i.test(msg)) reject(new InterchangeError('COMPRESSED_INPUT', `模型 ${key}：GLB 使用 Draco 压缩：${msg}`, { path: key }))
      else if (/basis|ktx2/i.test(msg)) reject(new InterchangeError('COMPRESSED_INPUT', `模型 ${key}：GLB 使用 KTX2/Basis 压缩：${msg}`, { path: key }))
      else reject(new InterchangeError('INVALID_DECLARATION', `模型 ${key}：GLB 解析失败：${msg}（${stack}）`, { path: key }))
    })
  })
}

function exportGlb(object: Object3D): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter()
    exporter.parse(object, result => resolve(result as ArrayBuffer), err => {
      reject(new InterchangeError('INVALID_DECLARATION', `GLB 导出失败：${err instanceof Error ? err.message : String(err)}`))
    }, { binary: true, onlyVisible: false })
  })
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}
