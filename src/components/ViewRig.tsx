import { ContactShadows, Environment, Grid } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { PMREMGenerator } from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { SceneEnvironment, ViewBinding } from '../core/types'

/** 程序化环境光（零下载、离线可用）——RoomEnvironment + PMREM */
function RoomEnv() {
  const gl = useThree(s => s.gl)
  const scene = useThree(s => s.scene)
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = rt.texture
    return () => {
      scene.environment = null
      rt.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

/** 视图装配：灯光 / 环境 / 地面 / 网格 / 接触阴影 */
export function ViewRig(props: { env: SceneEnvironment; view: ViewBinding }) {
  const { env, view } = props
  const groundSize = env.ground?.size ?? [20, 20]
  const sun = view.environment?.sunIntensity ?? env.sunIntensity ?? 1.6
  const bg = view.environment?.background ?? env.background ?? '#1c2128'
  const hdri = view.environment?.hdri !== undefined ? view.environment.hdri : env.hdri
  const gridEnabled = view.grid?.enabled !== false
  const shadowOn = env.ground?.receiveShadow !== false

  return (
    <>
      <color attach="background" args={[bg]} />
      <ambientLight intensity={0.4} />
      <directionalLight
        castShadow
        position={[8, 12, 6]}
        intensity={sun}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-16}
        shadow-camera-far={60}
      />

      {/* 环境：优先用本地 hdri 文件；否则程序化 RoomEnvironment */}
      {hdri ? <Environment files={`/${hdri}`} /> : <RoomEnv />}

      {shadowOn && (
        <mesh rotation-x={-Math.PI / 2} receiveShadow>
          <planeGeometry args={groundSize} />
          <shadowMaterial transparent opacity={0.3} />
        </mesh>
      )}

      {gridEnabled && (
        <Grid
          position={[0, 0.002, 0]}
          args={groundSize}
          cellSize={0.5}
          cellThickness={0.8}
          cellColor="#465062"
          sectionSize={2.5}
          sectionThickness={1.2}
          sectionColor="#5f7191"
          fadeDistance={45}
          fadeStrength={1}
          followCamera={false}
          infiniteGrid
        />
      )}

      <ContactShadows
        position={[0, 0.004, 0]}
        scale={Math.max(groundSize[0], groundSize[1])}
        blur={2.4}
        far={4}
        resolution={512}
        opacity={0.55}
        color="#000000"
      />
    </>
  )
}
