import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { Vector3 } from 'three'
import { registerBridge } from '../core/engine'

/** 把渲染上下文注册到 engine 单例，让 DOM 侧能调用 pick / captureScreenshot / focusAsset 等预留 API */
export function EngineBridgeReg() {
  const gl = useThree(s => s.gl)
  const scene = useThree(s => s.scene)
  const camera = useThree(s => s.camera)
  const controls = useThree(s => s.controls)

  useEffect(() => {
    registerBridge({
      gl,
      scene,
      camera,
      controls: controls as unknown as { target: Vector3; update: () => void } | null,
    })
    return () => registerBridge(null)
  }, [gl, scene, camera, controls])

  return null
}
