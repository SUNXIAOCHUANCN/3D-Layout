/**
 * CoAgentBridge（W04）——Canvas 内的渲染端口装配点（SPEC §W04-1/5、§3.8）。
 *
 * 挂在 `SceneCanvas` 的 children 挂载点，用 R3F 的 useThree 拿真实 renderer/scene/
 * 主相机（这是模块内唯一允许 import three/R3F 的地方之一），构造一个实现 RenderPort
 * 的对象并注册到 runtime。**不复用 engine 单例**（§1.2）：CoAgent 需要独立相机与
 * 离屏目标，不能借用主视口的那台相机。
 *
 * 职责边界：
 * - ready：等 objectIds 真正进入渲染层（轮询，不 import core 的事件总线）；
 * - capture：delegate 给 capture.ts（独立相机 + 状态恢复 + 超时）；
 * - geometry：W08.3 起接真实 AABB/三角形/包含/接触检测（rendering/geometry.ts）；
 * - diagnostics：目标/字节/耗时 + 主相机快照（验证"捕获不动用户相机"）；
 * - 卸载：注销端口 + 释放全部离屏目标。
 */

import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { Euler, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3, WebGLRenderTarget, type Camera, type Object3D, type Scene, type WebGLRenderer } from 'three'
import type {
  CameraSnapshot,
  CaptureFrame,
  CaptureRequest,
  GeometryRequest,
  GeometryResult,
  ObjectId,
  RenderPort,
  RenderPortDiagnostics,
  TransformDTO,
} from '../contracts'
import { CoAgentError } from '../contracts'
import type { CoAgentRuntime } from '../runtime/createRuntime'
import { captureStill } from './capture'
import { checkSceneGeometry } from './geometry'

export interface CoAgentBridgeProps {
  runtime: CoAgentRuntime | null
}

/** 离屏目标缓存上限（超出按最旧释放；W04 只用到 1~2 个尺寸） */
const MAX_TARGETS = 6

function collectAssetIds(scene: Scene): Set<string> {
  const ids = new Set<string>()
  scene.traverse(o => {
    const id = o.userData?.assetId
    if (typeof id === 'string') ids.add(id)
  })
  return ids
}

function mainCameraSnapshot(camera: Camera): CameraSnapshot {
  camera.updateMatrixWorld()
  // 朝向直接取世界矩阵的 -Z 轴（不 new 临时对象、不改相机）
  const e = camera.matrixWorld.elements
  const forward = { x: -e[8], y: -e[9], z: -e[10] }
  const pos: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z]
  const look: [number, number, number] = [pos[0] + forward.x * 10, pos[1] + forward.y * 10, pos[2] + forward.z * 10]
  const up: [number, number, number] = [camera.up.x, camera.up.y, camera.up.z]
  const frustum = camera as unknown as { near: number; far: number }
  const base = {
    schemaVersion: 1 as const,
    id: 'main',
    position: pos,
    target: look,
    up,
    near: frustum.near,
    far: frustum.far,
  }
  if ((camera as OrthographicCamera).isOrthographicCamera) {
    const o = camera as OrthographicCamera
    return {
      ...base,
      projection: 'orthographic',
      aspect: (o.right - o.left) / Math.max(1e-6, o.top - o.bottom),
      ortho: { left: o.left, right: o.right, top: o.top, bottom: o.bottom },
    }
  }
  const p = camera as PerspectiveCamera
  return { ...base, projection: 'perspective', aspect: p.aspect, fovDeg: p.fov }
}

function createPort(gl: WebGLRenderer, scene: Scene, camera: Camera, timeoutMs: number): { port: RenderPort; dispose: () => void } {
  const targets = new Map<string, { target: WebGLRenderTarget; usedAt: number }>()
  let mounted = true
  const stats = { captured: 0, failed: 0, lastCaptureMs: null as number | null }
  let clock = 0

  const getTarget = (width: number, height: number): WebGLRenderTarget => {
    const key = `${width}x${height}`
    const hit = targets.get(key)
    if (hit) {
      hit.usedAt = ++clock
      return hit.target
    }
    if (targets.size >= MAX_TARGETS) {
      let oldestKey: string | null = null
      let oldest = Infinity
      for (const [k, v] of targets) {
        if (v.usedAt < oldest) {
          oldest = v.usedAt
          oldestKey = k
        }
      }
      if (oldestKey) {
        targets.get(oldestKey)?.target.dispose()
        targets.delete(oldestKey)
      }
    }
    const target = new WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false })
    target.texture.generateMipmaps = false
    targets.set(key, { target, usedAt: ++clock })
    return target
  }

  const present = (id: ObjectId): boolean => collectAssetIds(scene).has(id)

  const assetRoots = (ids: ObjectId[]): Map<ObjectId, Object3D> => {
    const wanted = new Set(ids)
    const found = new Map<ObjectId, Object3D>()
    scene.traverse(o => {
      const id = o.userData?.assetId
      if (typeof id === 'string' && wanted.has(id) && !found.has(id)) found.set(id, o)
    })
    return found
  }

  /** W08.4：文档 transform 与对象 matrixWorld 一致才算同步（§6.3） */
  const transformSynced = (root: Object3D | undefined, expected: TransformDTO): boolean => {
    if (!root) return false
    root.updateWorldMatrix(true, false)
    const pos = new Vector3()
    const quat = new Quaternion()
    const scale = new Vector3()
    root.matrixWorld.decompose(pos, quat, scale)
    const q = new Quaternion().setFromEuler(
      new Euler((expected.rotationDeg[0] * Math.PI) / 180, (expected.rotationDeg[1] * Math.PI) / 180, (expected.rotationDeg[2] * Math.PI) / 180, 'XYZ'),
    )
    const posOk = Math.hypot(pos.x - expected.position[0], pos.y - expected.position[1], pos.z - expected.position[2]) <= 1e-3
    const scaleOk =
      Math.abs(scale.x - expected.scale[0]) <= 1e-3 &&
      Math.abs(scale.y - expected.scale[1]) <= 1e-3 &&
      Math.abs(scale.z - expected.scale[2]) <= 1e-3
    const rotOk = Math.abs(quat.dot(q)) >= 1 - 1e-6
    return posOk && scaleOk && rotOk
  }

  const waitAll = async (
    ids: ObjectId[],
    signal: AbortSignal,
    what: string,
    expected?: Record<ObjectId, TransformDTO>,
  ): Promise<void> => {
    if (ids.length === 0) return
    const started = Date.now()
    for (;;) {
      if (signal.aborted) throw new CoAgentError('cancelled', `${what}等待渲染被取消`)
      // 先让当前文档变化进入矩阵，再判断"渲染层是否跟上"；不靠固定毫秒数
      scene.updateMatrixWorld(true)
      const have = collectAssetIds(scene)
      const missing = ids.filter(id => !have.has(id))
      const roots = expected ? assetRoots(Object.keys(expected)) : null
      const unsynced = expected
        ? Object.entries(expected)
            .filter(([id, t]) => !transformSynced(roots?.get(id), t))
            .map(([id]) => id)
        : []
      if (missing.length === 0 && unsynced.length === 0) return
      if (Date.now() - started > timeoutMs) {
        throw new CoAgentError(
          'renderer_not_ready',
          `${what}超时：${missing.length} 个对象未进入渲染层、${unsynced.length} 个对象 transform 未同步`,
          { details: { missing: missing.slice(0, 20), unsynced: unsynced.slice(0, 20) } },
        )
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, 40)
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(new CoAgentError('cancelled', `${what}等待渲染被取消`))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  const port: RenderPort = {
    async ready(objectIds: ObjectId[], signal: AbortSignal, expectedTransforms?: Record<ObjectId, TransformDTO>): Promise<void> {
      if (!mounted) throw new CoAgentError('bridge_unavailable', '渲染桥已卸载')
      await waitAll(objectIds, signal, '场景就绪', expectedTransforms)
    },

    async capture(request: CaptureRequest, signal: AbortSignal): Promise<CaptureFrame> {
      if (!mounted) throw new CoAgentError('bridge_unavailable', '渲染桥已卸载（Canvas 已卸载）')
      const started = performance.now()
      try {
        // 捕获前确认请求对象都已同步到渲染层：否则拍出来的图与文档状态不符
        await waitAll(request.objectIds, signal, '捕获前同步', request.expectedTransforms)
        const frame = await captureStill({ gl, scene }, request, { getTarget, timeoutMs, signal }, present)
        stats.captured++
        stats.lastCaptureMs = Math.round(performance.now() - started)
        return frame
      } catch (e) {
        stats.failed++
        throw CoAgentError.from(e)
      }
    },

    async geometry(request: GeometryRequest, signal: AbortSignal): Promise<GeometryResult> {
      if (!mounted) throw new CoAgentError('bridge_unavailable', '渲染桥已卸载')
      if (signal.aborted) throw new CoAgentError('cancelled', '几何检测前已取消')
      try {
        // 世界矩阵必须是最新的：刚写入的 transform 可能还没经过下一次 render loop。
        scene.updateMatrixWorld(true)
        const result = checkSceneGeometry(scene, request)
        if (signal.aborted) throw new CoAgentError('cancelled', '几何检测完成前已取消')
        return result
      } catch (e) {
        throw CoAgentError.from(e)
      }
    },

    diagnostics(): RenderPortDiagnostics {
      let allocatedBytes = 0
      for (const { target } of targets.values()) allocatedBytes += target.width * target.height * 8 // RGBA8 + depth
      return {
        targets: [...targets.values()].map(({ target }) => ({ width: target.width, height: target.height })),
        allocatedBytes,
        captured: stats.captured,
        failed: stats.failed,
        lastCaptureMs: stats.lastCaptureMs,
        mainCamera: mainCameraSnapshot(camera),
        mounted,
        contextLost: gl.getContext().isContextLost(),
      }
    },
  }

  return {
    port,
    dispose: () => {
      mounted = false
      for (const { target } of targets.values()) target.dispose()
      targets.clear()
    },
  }
}

export function CoAgentBridge(props: CoAgentBridgeProps) {
  const gl = useThree(s => s.gl)
  const scene = useThree(s => s.scene)
  const camera = useThree(s => s.camera)
  const { runtime } = props

  useEffect(() => {
    if (!runtime) return
    const { port, dispose } = createPort(gl, scene, camera, runtime.config().sceneReadyTimeoutMs)
    runtime.registerRenderPort(port)
    return () => {
      runtime.registerRenderPort(null)
      dispose()
    }
  }, [runtime, gl, scene, camera])

  return null
}
