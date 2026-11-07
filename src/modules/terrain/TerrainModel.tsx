import { Html } from '@react-three/drei'
import { useEffect, useMemo, useState } from 'react'
import { BufferGeometry, Float32BufferAttribute } from 'three'
import type { SceneAsset } from '../../core/types'
import { createSurfaceMaterial } from './material'
export function TerrainModel({ terrain, material }: { terrain: NonNullable<SceneAsset['terrain']>; material?: SceneAsset['materialOverride'] }) {
  const [textureErrors, setTextureErrors] = useState<string[]>([])
  const { width, depth, samplesX, samplesZ, heights } = terrain
  const geometry = useMemo(() => {
    const g = new BufferGeometry(), positions: number[] = [], uvs: number[] = [], indices: number[] = []
    for (let z = 0; z < samplesZ; z++) for (let x = 0; x < samplesX; x++) {
      const u = x / (samplesX - 1), v = z / (samplesZ - 1)
      positions.push((u - 0.5) * width, heights[z * samplesX + x], (v - 0.5) * depth)
      uvs.push(u, v)
      if (x < samplesX - 1 && z < samplesZ - 1) {
        const a = z * samplesX + x, b = a + 1, c = a + samplesX, d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }
    g.setAttribute('position', new Float32BufferAttribute(positions, 3))
    g.setAttribute('uv', new Float32BufferAttribute(uvs, 2)); g.setIndex(indices); g.computeVertexNormals()
    return g
  }, [width, depth, samplesX, samplesZ, heights])
  const [layered, setLayered] = useState<ReturnType<typeof createSurfaceMaterial> | null>(null)
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => {
    let active = true
    const runtime = terrain.surface ? createSurfaceMaterial(terrain.surface, width, depth) : null
    setLayered(runtime)
    setTextureErrors([])
    void runtime?.ready.then(() => { if (active) setTextureErrors([...runtime.errors]) })
    return () => { active = false; runtime?.dispose() }
  }, [terrain.surface, width, depth])
  return <group>
    {textureErrors.length > 0 && <Html center><div role="alert" style={{ background: '#402820', color: '#fff', padding: 8, width: 260, fontSize: 12 }}>地形材质贴图加载失败，当前显示替代材质：{textureErrors.join('; ')}</div></Html>}
    <mesh geometry={geometry} castShadow receiveShadow>
    {layered ? <primitive object={layered.material} attach="material" /> : <meshStandardMaterial color={material?.color ?? '#66875b'} roughness={material?.roughness ?? 0.9} metalness={material?.metalness ?? 0} />}
  </mesh></group>
}
