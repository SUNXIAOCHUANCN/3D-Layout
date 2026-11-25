import { GizmoHelper, GizmoViewport, OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { Suspense, type ReactNode } from 'react'
import { MOUSE } from 'three'
import { bus } from '../core/events'
import { useSceneStore } from '../core/store'
import { CameraRig } from './CameraRig'
import { EngineBridgeReg } from './EngineBridgeReg'
import { LIGHT_HELPER_LAYER } from './LightInstance'
import { SceneContent } from './SceneContent'
import { ViewRig } from './ViewRig'

/** OrbitControls 没有"无操作"常量；-1 会落到其内部 switch 的 NONE 分支 */
const NO_CAMERA_ACTION = -1 as unknown as MOUSE

/**
 * 三维视口。key=sceneId：切换场景时整体重建，Suspense 与 GPU 资源干净重置。
 * children 是模块装配点①（Canvas 内，如编辑器的 gizmo 层）；
 * 点击空白只上报 viewport:empty-click，由模块决定是否取消选中。
 */
export function SceneCanvas(props: { children?: ReactNode; showLightHelpers?: boolean; honorEditorHidden?: boolean; fixedView?: boolean; disableOrbitRotate?: boolean }) {
  const sceneId = useSceneStore(s => s.sceneId)
  const cameras = useSceneStore(s => s.document?.cameras)
  const environment = useSceneStore(s => s.document?.environment)
  const view = useSceneStore(s => s.view)
  if (!cameras || !environment) return null

  return (
    <Canvas
      key={sceneId}
      shadows
      dpr={[1, 2]}
      camera={{ fov: 50, position: [8, 6, 10], near: 0.1, far: 300 }}
      onCreated={({ camera, raycaster }) => {
        camera.layers.enable(LIGHT_HELPER_LAYER)
        raycaster.layers.enable(LIGHT_HELPER_LAYER)
      }}
      onPointerMissed={e => {
        if (e.button === 0) bus.emit('viewport:empty-click', {})
      }}
    >
      <EngineBridgeReg />
      <SceneCameraRig />
      <Suspense fallback={null}>
        <SceneContent showLightHelpers={props.showLightHelpers} honorEditorHidden={props.honorEditorHidden} />
        <ViewRig env={environment} view={view} />
      </Suspense>
      <OrbitControls
        makeDefault
        enableRotate={!props.fixedView && !props.disableOrbitRotate}
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2 - 0.02}
        mouseButtons={{ LEFT: NO_CAMERA_ACTION, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }}
      />
      {/* 坐标轴指示器：右手系（X红 Y绿上 Z蓝朝向观察者）；点击轴球把相机对齐到该轴 */}
      <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
        <GizmoViewport
          axisColors={['#d9694a', '#9bb87c', '#86aab7']}
          labelColor="#ece5d7"
        />
      </GizmoHelper>
      {props.children}
    </Canvas>
  )
}

/** Asset movement updates clipping without rebuilding the whole Canvas tree. */
function SceneCameraRig() {
  const document = useSceneStore(s => s.document)
  const sceneId = useSceneStore(s => s.sceneId)
  const view = useSceneStore(s => s.view)
  return document && <CameraRig cameras={document.cameras} view={view} sceneKey={sceneId ?? ''} assets={document.assets} />
}
