import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import type { PerspectiveCamera } from 'three'
import type { SceneAsset, SceneCamera, Vec3, ViewBinding } from '../core/types'

interface ControlsLike {
  target: { set: (x: number, y: number, z: number) => void }
  update: () => void
}

/** 与 SceneCanvas 的 camera 属性一致：常规尺度场景保持这组默认裁剪面不变 */
const DEFAULT_NEAR = 0.1
const DEFAULT_FAR = 300
/** 24 位深度缓冲可接受的 far/near 比，再大远处开始 z-fighting */
const MAX_FAR_NEAR_RATIO = 10_000
/** far 在"相机到包围球最远点"之上留的余量：盖住模型自身尺寸与拉远观察 */
const FAR_MARGIN = 1.5
const FALLBACK_POSITION: Vec3 = [8, 6, 10]

/** scene.json cameras 中 id 匹配 view.cameraId 的那台（默认第一台） */
const resolveBase = (cameras: SceneCamera[], view: ViewBinding) =>
  cameras.find(c => c.id === view.cameraId) ?? cameras[0]

/** 资产位置的包围球（只看 transform.position；模型自身尺寸由 FAR_MARGIN 覆盖） */
function assetBounds(assets: SceneAsset[]): { center: Vec3; radius: number } | null {
  if (assets.length === 0) return null
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const a of assets) {
    const [x, y, z] = a.transform.position
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    radius: Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
  }
}

/**
 * 应用场景绑定的初始相机：
 * scene.json cameras 中 id 匹配 view.cameraId 的那台（默认第一台），
 * 可被 threejs/view.json 的 camera 字段覆盖。
 * 裁剪面按场景尺度自适应：导入场景可能是公里级（相机离内容数千米），
 * 固定 far=300 会把整个场景裁掉——视口一片空、但模型其实已加载。
 */
export function CameraRig(props: { cameras: SceneCamera[]; view: ViewBinding; sceneKey: string; assets: SceneAsset[] }) {
  const { cameras, view, sceneKey, assets } = props
  const camera = useThree(s => s.camera)
  const controls = useThree(s => s.controls) as unknown as ControlsLike | null

  useEffect(() => {
    const base = resolveBase(cameras, view)
    if (!base && !view.camera) return
    const pos = view.camera?.position ?? base?.position ?? FALLBACK_POSITION
    const fov = view.camera?.fov ?? base?.fov ?? 50
    camera.position.set(pos[0], pos[1], pos[2])
    const persp = camera as PerspectiveCamera
    if (persp.isPerspectiveCamera && persp.fov !== fov) {
      persp.fov = fov
      persp.updateProjectionMatrix()
    }
  }, [sceneKey, camera, cameras, view])

  // OrbitControls（makeDefault）可能晚于首个 effect 就绪，单独响应
  useEffect(() => {
    if (!controls) return
    const base = resolveBase(cameras, view)
    const tgt = view.camera?.target ?? base?.target ?? [0, 0, 0]
    controls.target.set(tgt[0], tgt[1], tgt[2])
    controls.update()
  }, [sceneKey, controls, cameras, view])

  // 裁剪面：far 盖住"初始相机位 → 包围球最远点"，near 随 far 按比例抬高保证深度精度。
  // 按初始相机位而非实时位置计算，编辑过程中资产微动不会让 far 来回抖动。
  const bounds = useMemo(() => assetBounds(assets), [assets])
  useEffect(() => {
    const persp = camera as PerspectiveCamera
    if (!persp.isPerspectiveCamera) return
    let far = DEFAULT_FAR
    if (bounds) {
      const base = resolveBase(cameras, view)
      const pos = view.camera?.position ?? base?.position ?? FALLBACK_POSITION
      const viewDist = Math.hypot(pos[0] - bounds.center[0], pos[1] - bounds.center[1], pos[2] - bounds.center[2])
      far = Math.max(DEFAULT_FAR, (viewDist + bounds.radius) * FAR_MARGIN)
    }
    const near = Math.max(DEFAULT_NEAR, far / MAX_FAR_NEAR_RATIO)
    if (persp.far === far && persp.near === near) return
    persp.near = near
    persp.far = far
    persp.updateProjectionMatrix()
  }, [sceneKey, camera, cameras, view, bounds])

  return null
}
