import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { PerspectiveCamera } from 'three'
import type { SceneCamera, ViewBinding } from '../core/types'

interface ControlsLike {
  target: { set: (x: number, y: number, z: number) => void }
  update: () => void
}

/**
 * 应用场景绑定的初始相机：
 * scene.json cameras 中 id 匹配 view.cameraId 的那台（默认第一台），
 * 可被 threejs/view.json 的 camera 字段覆盖。
 */
export function CameraRig(props: { cameras: SceneCamera[]; view: ViewBinding; sceneKey: string }) {
  const { cameras, view, sceneKey } = props
  const camera = useThree(s => s.camera)
  const controls = useThree(s => s.controls) as unknown as ControlsLike | null

  useEffect(() => {
    const base = cameras.find(c => c.id === view.cameraId) ?? cameras[0]
    if (!base && !view.camera) return
    const pos = view.camera?.position ?? base?.position ?? [8, 6, 10]
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
    const base = cameras.find(c => c.id === view.cameraId) ?? cameras[0]
    const tgt = view.camera?.target ?? base?.target ?? [0, 0, 0]
    controls.target.set(tgt[0], tgt[1], tgt[2])
    controls.update()
  }, [sceneKey, controls, cameras, view])

  return null
}
