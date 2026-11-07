import { Box3, Color, HalfFloatType, OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3, Vector4, WebGLRenderTarget } from 'three'
import type { Camera, Material, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 as V3, WebGLRenderer } from 'three'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

export interface CaptureCamera {
  projection: 'perspective' | 'orthographic'
  position: [number, number, number]
  target: [number, number, number]
  up: [number, number, number]
  near: number
  far: number
  fovDeg?: number
  viewHeight?: number
}

export interface CaptureOptions {
  /** Analysis maps can suppress glossy reflections without changing saved scene materials. */
  minRoughness?: number
  /** 编码格式：默认 png（无损，用于导出/展示）；给多模态模型看的截图用 jpeg 体积小一个数量级。 */
  format?: 'png' | 'jpeg'
  /** jpeg 质量 0.1–1，默认 0.85；png 时忽略。 */
  quality?: number
}

function encodeCapture(canvas: HTMLCanvasElement, options?: CaptureOptions): string {
  if (options?.format !== 'jpeg') return canvas.toDataURL('image/png')
  const quality = options.quality ?? 0.85
  if (!Number.isFinite(quality) || quality < 0.1 || quality > 1) throw new Error('截图质量须为 0.1–1')
  return canvas.toDataURL('image/jpeg', quality)
}

function makeCaptureCamera(spec: CaptureCamera, aspect: number): PerspectiveCamera | OrthographicCamera {
  const camera = spec.projection === 'perspective'
    ? new PerspectiveCamera(spec.fovDeg, aspect, spec.near, spec.far)
    : new OrthographicCamera(-spec.viewHeight! * aspect / 2, spec.viewHeight! * aspect / 2, spec.viewHeight! / 2, -spec.viewHeight! / 2, spec.near, spec.far)
  camera.position.fromArray(spec.position)
  camera.up.fromArray(spec.up)
  camera.lookAt(...spec.target)
  camera.updateMatrixWorld(true)
  return camera
}

/**
 * 引擎对外 API —— 封装渲染细节，供 UI / 编辑器模块 / 后期 Agent（截图→VLM）调用。
 * 实际实现由 Canvas 内的 <EngineBridgeReg/> 注册。
 */
/** 归一化图像坐标拾取结果：命中资产 + 世界坐标命中点与距离 */
export interface PickHit {
  assetId: string
  /** 射线命中点（世界坐标，米） */
  point: [number, number, number]
  /** 相机到命中点的距离（米） */
  distance: number
}

export interface EngineApi {
  /** 屏幕坐标拾取：返回资产 id 或 null */
  pick(clientX: number, clientY: number): string | null
  /**
   * 图像归一化坐标拾取（u/v ∈ [0,1]，左上原点）：Agent 视觉点选用。
   * 与截图同构图（u/v 即截图图像上的比例位置），并跳过编辑器视觉件
   * （描边/gizmo）——captureScreenshot 截图时它们不可见，拾取口径必须一致。
   */
  pickNormalized(u: number, v: number): PickHit | null
  /** 无 UI 视口截图（dataURL）：同构图、隐藏编辑器视觉件。场景预览图 / VLM 视觉校验用 */
  captureScreenshot(options?: CaptureOptions): string
  captureFromCamera(spec: CaptureCamera, width: number, height: number, options?: CaptureOptions): string
  pickFromCamera(spec: CaptureCamera, width: number, height: number, u: number, v: number): PickHit | null
  /** 找到某资产的 three 对象（gizmo attach、聚焦等渲染侧操作用） */
  findAssetObject(assetId: string): Object3D | null
  /** 把相机对准某资产（保持当前朝向，调整距离），F 聚焦 / Agent 定位用 */
  focusAsset(assetId: string): boolean
  /** Focus a review range, including a removed asset's former location. */
  focusBounds(box: Box3): boolean
  /** 二期：给资产挂 TransformControls gizmo（translate/rotate/scale）——由编辑器模块实现 */
  attachGizmo(assetId: string, mode: 'translate' | 'rotate' | 'scale'): void
}

interface Bridge {
  gl: WebGLRenderer
  scene: Scene
  camera: Camera
  controls: { target: V3; update: () => void } | null
}

let bridge: Bridge | null = null
const raycaster = new Raycaster()
const ndc = new Vector2()

function findAssetId(obj: Object3D | null): string | null {
  while (obj) {
    const id = obj.userData?.assetId
    if (typeof id === 'string') return id
    obj = obj.parent
  }
  return null
}

/** 是否编辑器视觉件（描边/gizmo 等，含祖先标记）——视觉点选按截图口径跳过 */
function isEditorHelper(obj: Object3D | null): boolean {
  while (obj) {
    if (obj.userData?.editorHelper === true) return true
    obj = obj.parent
  }
  return false
}

export const engine: EngineApi = {
  captureFromCamera(spec, width, height, options) {
    if (!bridge) throw new Error('engine 尚未就绪（场景未渲染）')
    const { gl, scene } = bridge
    const camera = makeCaptureCamera(spec, width / height)
    const minRoughness = options?.minRoughness
    if (minRoughness !== undefined && (!Number.isFinite(minRoughness) || minRoughness < 0 || minRoughness > 1)) throw new Error('截图最小粗糙度须为 0–1')
    // Preserve HDR lighting until the same tone mapping and output transfer as the viewport.
    // An ordinary byte render target skips those stages and clips bright reflections to white.
    const linear = new WebGLRenderTarget(width, height, { type: HalfFloatType, samples: Math.min(4, gl.capabilities.maxSamples) })
    const target = new WebGLRenderTarget(width, height, { depthBuffer: false })
    const output = new OutputPass()
    const previousTarget = gl.getRenderTarget()
    const previousFace = gl.getActiveCubeFace(), previousLevel = gl.getActiveMipmapLevel()
    const previousViewport = gl.getViewport(new Vector4()), previousScissor = gl.getScissor(new Vector4())
    const previousClear = gl.getClearColor(new Color()).clone(), previousAlpha = gl.getClearAlpha()
    const previousScissorTest = gl.getScissorTest(), previousAutoClear = gl.autoClear, previousXr = gl.xr.enabled
    const hidden: Object3D[] = []
    const swapped: Array<{ mesh: Mesh; material: Material | Material[] }> = []
    const materials = new Map<Material, Material>()
    try {
      scene.traverse(o => {
        if (o.userData?.editorHelper === true && o.visible) { o.visible = false; hidden.push(o) }
        const mesh = o as Mesh
        if (minRoughness === undefined || !mesh.isMesh) return
        const stabilize = (material: Material): Material => {
          const standard = material as MeshStandardMaterial
          if (!standard.isMeshStandardMaterial || standard.roughness >= minRoughness) return material
          let copy = materials.get(material)
          if (!copy) {
            const clone = standard.clone(); clone.roughness = minRoughness
            clone.onBeforeCompile = standard.onBeforeCompile; clone.customProgramCacheKey = standard.customProgramCacheKey
            copy = clone; materials.set(material, copy)
          }
          return copy
        }
        const original = mesh.material
        const replacement = Array.isArray(original) ? original.map(stabilize) : stabilize(original)
        if (Array.isArray(original) ? (replacement as Material[]).some((m, i) => m !== original[i]) : replacement !== original) {
          swapped.push({ mesh, material: original }); mesh.material = replacement
        }
      })
      gl.autoClear = true; gl.xr.enabled = false; gl.setScissorTest(false)
      gl.setRenderTarget(linear)
      gl.render(scene, camera)
      output.render(gl, target, linear, 0, false)
      const pixels = new Uint8Array(width * height * 4)
      gl.readRenderTargetPixels(target, 0, 0, width, height, pixels)
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建截图画布')
      const image = context.createImageData(width, height)
      for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4)
      context.putImageData(image, 0, 0)
      return encodeCapture(canvas, options)
    } finally {
      gl.setRenderTarget(previousTarget, previousFace, previousLevel)
      gl.setViewport(previousViewport); gl.setScissor(previousScissor); gl.setScissorTest(previousScissorTest)
      gl.setClearColor(previousClear, previousAlpha)
      gl.autoClear = previousAutoClear; gl.xr.enabled = previousXr
      for (const o of hidden) o.visible = true
      for (const { mesh, material } of swapped) mesh.material = material
      for (const material of materials.values()) material.dispose()
      output.dispose(); linear.dispose(); target.dispose()
    }
  },

  pickFromCamera(spec, width, height, u, v) {
    if (!bridge || !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null
    ndc.set(u * 2 - 1, -(v * 2 - 1))
    raycaster.setFromCamera(ndc, makeCaptureCamera(spec, width / height))
    for (const hit of raycaster.intersectObjects(bridge.scene.children, true)) {
      if (isEditorHelper(hit.object)) continue
      const id = findAssetId(hit.object)
      if (id) return { assetId: id, point: [hit.point.x, hit.point.y, hit.point.z], distance: hit.distance }
    }
    return null
  },
  pick(clientX, clientY) {
    if (!bridge) return null
    const rect = bridge.gl.domElement.getBoundingClientRect()
    ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc, bridge.camera as PerspectiveCamera)
    // 纯 mesh 精确拾取（与编辑器点击一致，Blender 式）
    for (const hit of raycaster.intersectObjects(bridge.scene.children, true)) {
      const id = findAssetId(hit.object)
      if (id) return id
    }
    return null
  },

  pickNormalized(u, v) {
    if (!bridge) return null
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null
    // 图像坐标（左上原点）→ NDC（左下原点）
    ndc.set(u * 2 - 1, -(v * 2 - 1))
    raycaster.setFromCamera(ndc, bridge.camera as PerspectiveCamera)
    for (const hit of raycaster.intersectObjects(bridge.scene.children, true)) {
      if (isEditorHelper(hit.object)) continue
      const id = findAssetId(hit.object)
      if (id) return { assetId: id, point: [hit.point.x, hit.point.y, hit.point.z], distance: hit.distance }
    }
    return null
  },

  /**
   * 无 UI 截图：与视口同一相机同一构图，渲染前临时隐藏 userData.editorHelper
   * 标记的编辑器视觉件（选中描边、变换 gizmo），取完像素即恢复。
   * 坐标轴指示器走独立覆盖渲染通道，天然不出现在截图中。
   */
  captureScreenshot(options) {
    if (!bridge) throw new Error('engine 尚未就绪（场景未渲染）')
    const hidden: Object3D[] = []
    bridge.scene.traverse(o => {
      if (o.userData?.editorHelper === true && o.visible) {
        o.visible = false
        hidden.push(o)
      }
    })
    // Canvas 未开 preserveDrawingBuffer，必须在同一 tick 内先 render 再取像素
    bridge.gl.render(bridge.scene, bridge.camera)
    const url = encodeCapture(bridge.gl.domElement, options)
    for (const o of hidden) o.visible = true
    return url
  },

  findAssetObject(assetId) {
    if (!bridge) return null
    let found: Object3D | null = null
    bridge.scene.traverse(o => {
      if (!found && o.userData?.assetId === assetId) found = o
    })
    return found
  },

  focusAsset(assetId) {
    if (!bridge) return false
    const obj = engine.findAssetObject(assetId)
    if (!obj) return false
    const box = new Box3().setFromObject(obj)
    return engine.focusBounds(box)
  },

  focusBounds(box) {
    if (!bridge || box.isEmpty()) return false
    const center = box.getCenter(new Vector3())
    const radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.5)
    const camera = bridge.camera as PerspectiveCamera
    // 保持当前朝向，把相机移到包住资产的距离
    const dir = camera.position.clone().sub(bridge.controls?.target ?? center)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.75, 1)
    dir.normalize()
    camera.position.copy(center).add(dir.multiplyScalar(Math.max(radius * 3, 2)))
    camera.far = Math.max(camera.far, radius * 10)
    camera.updateProjectionMatrix()
    camera.lookAt(center)
    if (bridge.controls) {
      bridge.controls.target.copy(center)
      bridge.controls.update()
    }
    return true
  },

  attachGizmo(_assetId, _mode) {
    // 由编辑器模块的 <EditorGizmo/> 实现；引擎不再持有编辑器细节
    console.warn('[engine] attachGizmo 已由编辑器模块实现（modules/editor/EditorGizmo）')
  },
}

/** 供 EngineBridgeReg 注册/注销渲染上下文 */
export const registerBridge = (b: Bridge | null): void => {
  bridge = b
}
