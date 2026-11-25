import { memo, useState } from 'react'
import { MathUtils, Object3D } from 'three'
import { bus } from '../core/events'
import { useSceneStore } from '../core/store'
import type { SceneLight } from '../core/types'

const spotTargetPosition: [number, number, number] = [0, 0, -1]
// Keep editor geometry out of the contact-shadow camera's depth pass.
export const LIGHT_HELPER_LAYER = 1
const helperMask = 1 << LIGHT_HELPER_LAYER

export const LightInstance = memo(function LightInstance({ light, showHelpers }: { light: SceneLight; showHelpers: boolean }) {
  const selected = useSceneStore(s => s.selectedLightId === light.id)
  const [target] = useState(() => new Object3D())
  const rotation = light.type === 'spot' ? light.rotation.map(MathUtils.degToRad) as [number, number, number] : undefined
  const angle = light.type === 'spot' ? MathUtils.degToRad(light.angle) : 0
  const properties = { color: light.color, intensity: light.enabled === false ? 0 : light.intensity, distance: light.distance }
  const markerColor = selected ? '#ffbd55' : light.enabled === false ? '#8b9099' : '#fff1bd'
  const coneDepth = 1.4 * Math.cos(angle)

  return (
    <group name={light.id} userData={{ lightId: light.id }} position={light.position} rotation={rotation}>
      {light.type === 'point' ? <pointLight {...properties} /> : (
        <>
          <primitive object={target} position={spotTargetPosition} />
          <spotLight {...properties} position={[0, 0, 0]} angle={angle} target={target} />
        </>
      )}
      {showHelpers && (
        <group userData={{ editorHelper: true }}>
          <mesh
            layers-mask={helperMask}
            onClick={event => {
              if (event.button !== 0) return
              event.stopPropagation()
              bus.emit('light:clicked', { lightId: light.id })
            }}
          >
            {light.type === 'point' ? <sphereGeometry args={[0.18, 12, 8]} /> : <octahedronGeometry args={[0.24]} />}
            <meshBasicMaterial color={markerColor} toneMapped={false} />
          </mesh>
          {selected && light.type === 'spot' && (
            <mesh layers-mask={helperMask} position-z={-coneDepth / 2} rotation-x={Math.PI / 2}>
              <coneGeometry args={[1.4 * Math.sin(angle), coneDepth, 12, 1, true]} />
              <meshBasicMaterial color={markerColor} toneMapped={false} wireframe />
            </mesh>
          )}
        </group>
      )}
    </group>
  )
})
