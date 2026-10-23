/**
 * capture（W04）——独立相机的离屏捕获（SPEC §W04-2/4/5、§3.8）。
 *
 * 关键约束：
 * - **相机独立**：捕获用 `cameraFromSnapshot` 现造一台相机，不碰用户主视口相机；
 *   同一 CameraSnapshot 两次捕获 = 同视角（before/after 复拍的前提）。
 * - **GPU 状态可恢复**：renderTarget/clearColor/自动清屏/裁剪/色调映射/输出色彩空间/
 *   阴影开关全部先存后还，异常路径也一样（finally），主视口不因捕获而变黑或变色。
 * - **超时与取消**：编码阶段可被 AbortSignal 或 timeoutMs 中断；渲染本身是同步的，
 *   这里如实注明（同步 GPU 工作不能被 JS 定时器抢占，见 DECISIONS 的 15 s 说明）。
 * - 只 import three；不 import React / core。
 */

import {
  Color,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
  type Camera,
  type Scene,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three'
import type { CameraSnapshot, CaptureFrame, CaptureRequest, ObservationLabel, ObjectId } from '../contracts'
import { CoAgentError } from '../contracts'
import { encodePng, readTargetPixels, type RgbaImage } from './pixels'
import { captureMarkers } from './markers'

export interface RenderScene {
  gl: WebGLRenderer
  scene: Scene
}

export interface CaptureRuntime {
  /** 离屏目标由 bridge 缓存并负责释放 */
  getTarget(width: number, height: number): WebGLRenderTarget
  timeoutMs: number
  signal: AbortSignal
}

/** 由完整相机快照构造相机（不修改任何既有相机对象） */
export function cameraFromSnapshot(s: CameraSnapshot, width: number, height: number): Camera {
  const aspect = width > 0 && height > 0 ? width / height : s.aspect
  let camera: Camera
  if (s.projection === 'orthographic') {
    const o = s.ortho ?? { left: -1, right: 1, top: 1, bottom: -1 }
    camera = new OrthographicCamera(o.left, o.right, o.top, o.bottom, s.near, s.far)
  } else {
    camera = new PerspectiveCamera(s.fovDeg ?? 50, aspect, s.near, s.far)
  }
  camera.position.set(s.position[0], s.position[1], s.position[2])
  camera.up.set(s.up[0], s.up[1], s.up[2])
  camera.lookAt(new Vector3(s.target[0], s.target[1], s.target[2]))
  ;(camera as PerspectiveCamera | OrthographicCamera).updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

interface GpuSnapshot {
  target: WebGLRenderTarget | null
  clearColor: Color
  clearAlpha: number
  autoClear: boolean
  scissorTest: boolean
  toneMapping: WebGLRenderer['toneMapping']
  outputColorSpace: WebGLRenderer['outputColorSpace']
  shadowAutoUpdate: boolean
  xrEnabled: boolean
}

function saveGpuState(gl: WebGLRenderer): GpuSnapshot {
  return {
    target: gl.getRenderTarget(),
    clearColor: gl.getClearColor(new Color()).clone(),
    clearAlpha: gl.getClearAlpha(),
    autoClear: gl.autoClear,
    scissorTest: gl.getScissorTest(),
    toneMapping: gl.toneMapping,
    outputColorSpace: gl.outputColorSpace,
    shadowAutoUpdate: gl.shadowMap.autoUpdate,
    xrEnabled: gl.xr.enabled,
  }
}

function restoreGpuState(gl: WebGLRenderer, s: GpuSnapshot): void {
  gl.setRenderTarget(s.target)
  gl.setClearColor(s.clearColor, s.clearAlpha)
  gl.autoClear = s.autoClear
  gl.setScissorTest(s.scissorTest)
  gl.toneMapping = s.toneMapping
  gl.outputColorSpace = s.outputColorSpace
  gl.shadowMap.autoUpdate = s.shadowAutoUpdate
  gl.xr.enabled = s.xrEnabled
}

function throwIfAborted(signal: AbortSignal, phase: string): void {
  if (signal.aborted) throw new CoAgentError('cancelled', `捕获在「${phase}」阶段被取消`)
}

/** 带超时/取消的异步护栏（编码等异步段用；同步渲染段无法被抢占，已在本文件头注明） */
async function guarded<T>(work: Promise<T>, rt: CaptureRuntime, phase: string): Promise<T> {
  if (rt.signal.aborted) throw new CoAgentError('cancelled', `捕获在「${phase}」前被取消`)
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CoAgentError('capture_failed', `「${phase}」超时（>${rt.timeoutMs} ms）`))
    }, rt.timeoutMs)
  })
  const aborted = new Promise<never>((_, reject) => {
    rt.signal.addEventListener(
      'abort',
      () => reject(new CoAgentError('cancelled', `捕获在「${phase}」中被取消`)),
      { once: true },
    )
  })
  try {
    return await Promise.race([work, timeout, aborted])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 单次 RGB 渲染 + 读回（左上原点）。调用方负责把目标与状态复位。 */
export function renderRgb(ctx: RenderScene, camera: Camera, target: WebGLRenderTarget): RgbaImage {
  const { gl, scene } = ctx
  const before = saveGpuState(gl)
  try {
    gl.setRenderTarget(target)
    gl.clear(true, true, true)
    gl.render(scene, camera)
    return readTargetPixels(gl, target)
  } finally {
    restoreGpuState(gl, before)
  }
}

/**
 * 完整捕获：RGB 图 +（可选）同帧 ID 标记与映射。
 * 抛错只可能是 cancelled / capture_failed / renderer_not_ready（由 bridge 预检）。
 */
export async function captureStill(
  ctx: RenderScene,
  request: CaptureRequest,
  rt: CaptureRuntime,
  present: (id: ObjectId) => boolean,
): Promise<CaptureFrame> {
  throwIfAborted(rt.signal, '开始')
  if (!(request.width > 0) || !(request.height > 0) || request.width > 4096 || request.height > 4096) {
    throw new CoAgentError('invalid_arguments', `非法捕获尺寸 ${request.width}×${request.height}`)
  }

  const camera = cameraFromSnapshot(request.camera, request.width, request.height)
  const target = rt.getTarget(request.width, request.height)

  throwIfAborted(rt.signal, 'RGB 渲染')
  let rgb: RgbaImage
  try {
    rgb = renderRgb(ctx, camera, target)
  } catch (e) {
    throw new CoAgentError('capture_failed', `RGB 渲染/读回失败：${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }

  const png = await guarded(encodePng(rgb), rt, 'PNG 编码')

  let labels: ObservationLabel[]
  let markedPng: Blob | undefined
  if (request.marked) {
    throwIfAborted(rt.signal, 'ID 标记')
    const markers = captureMarkers({ gl: ctx.gl, scene: ctx.scene, camera, target, width: request.width, height: request.height, objectIds: request.objectIds })
    labels = markers.labels
    markedPng = await guarded(markers.compose(rgb), rt, '标记图合成')
  } else {
    // 未开标记时没有像素级可见性证据：按"是否已进入渲染层"如实给 visible/uncertain
    labels = request.objectIds.map(id => ({
      label: '',
      objectId: id,
      visibility: present(id) ? ('visible' as const) : ('uncertain' as const),
    }))
  }

  return {
    camera: request.camera,
    width: request.width,
    height: request.height,
    rgbPng: png,
    ...(markedPng ? { markedPng } : {}),
    labels,
    observedObjectFingerprints: { ...request.fingerprints },
    sceneRevision: request.sceneRevision,
  }
}
