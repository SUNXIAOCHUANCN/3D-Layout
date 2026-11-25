import { TerrainModel } from '../modules/terrain/TerrainModel'
import { useGLTF } from '@react-three/drei'
import { memo, useEffect, useMemo } from 'react'
import { BackSide, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three'
import type { Object3D, SkinnedMesh } from 'three'
import { bus } from '../core/events'
import { useSceneStore } from '../core/store'
import type { ModelMeta, SceneAsset } from '../core/types'

const degToRad = (deg: number) => (deg * Math.PI) / 180
const asRad = (r: readonly [number, number, number]): [number, number, number] => [
  degToRad(r[0]),
  degToRad(r[1]),
  degToRad(r[2]),
]

/** 选中描边材质：Blender 风橙色 + 背面渲染（倒角壳轮廓） */
const OUTLINE_MATERIAL = new MeshBasicMaterial({ color: '#ff9a2e', side: BackSide })

const bakedRoots = new WeakSet<Object3D>()

/**
 * glb 一次性规范化：① 蒙皮网格烘焙成普通 Mesh（three 射线拾取不计算蒙皮形变）；
 * ② 重算所有几何的包围球/包围盒缓存。
 * 部分 glb 的缓存包围球与顶点数据单位不一致（如 cm 顶点配 m 缓存球）——
 * 渲染不受影响，但 Mesh.raycast 的球测试会永远 miss（"看得见点不中"的根因）。
 * 布局软件静态展示模型，烘焙后拾取/描边/克隆全部按普通网格处理（播动画需另走原始 glb）。
 */
function normalizeGltf(root: Object3D): void {
  if (bakedRoots.has(root)) return
  bakedRoots.add(root)
  root.updateMatrixWorld(true)

  // ① 蒙皮烘焙
  const skinned: Array<{ mesh: SkinnedMesh; parent: Object3D | null }> = []
  root.traverse(o => {
    if ((o as SkinnedMesh).isSkinnedMesh) skinned.push({ mesh: o as SkinnedMesh, parent: o.parent })
  })
  for (const { mesh, parent } of skinned) {
    const geom = mesh.geometry
    const pos = geom.attributes.position
    const baked = pos.clone()
    const v = new Vector3()
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i)
      mesh.applyBoneTransform(i, v)
      baked.setXYZ(i, v.x, v.y, v.z)
    }
    geom.setAttribute('position', baked)
    geom.computeVertexNormals()
    const plain = new Mesh(geom, mesh.material)
    plain.name = mesh.name
    plain.position.copy(mesh.position)
    plain.quaternion.copy(mesh.quaternion)
    plain.scale.copy(mesh.scale)
    if (parent) {
      parent.remove(mesh)
      parent.add(plain)
    }
  }

  // ② 重算几何缓存（防陈旧包围球/包围盒）
  root.traverse(o => {
    const m = o as Mesh
    if (m.isMesh && m.geometry) {
      m.geometry.computeBoundingSphere()
      m.geometry.computeBoundingBox()
    }
  })
}

/**
 * 生成描边壳：克隆源对象，统一换成橙色背面材质并整体放大 4.5%。
 * 克隆共享几何体（零拷贝）；SkinnedMesh 克隆沿用同一副骨骼，描边跟随动作。
 * userData.editorHelper 标记：engine.captureScreenshot 截图时临时隐藏（无 UI 截图）。
 * 选中描边与 Agent 点选高亮共用本实现（后者见 modules/agent/AgentPickHighlight）。
 */
export function makeOutline(src: Object3D): Object3D {
  const c = src.clone(true)
  c.userData.editorHelper = true
  c.traverse(o => {
    const m = o as Mesh
    if (m.isMesh) {
      m.material = OUTLINE_MATERIAL
      m.castShadow = false
      m.receiveShadow = false
      m.scale.multiplyScalar(1.045)
    }
  })
  return c
}

/** 占位几何：按 meta 的 native 尺寸建模，原点归一化到底面中心 */
function PrimitiveModel(props: { meta: ModelMeta; tint?: string; outline?: boolean; ghost?: boolean; materialOverride?: SceneAsset['materialOverride'] }) {
  const { meta, tint, outline, ghost, materialOverride } = props
  const { w, d, h } = meta.dimensions
  const color = tint ?? meta.color ?? '#7ea6e0'
  const shape = meta.source.type === 'primitive' ? meta.source.shape : 'box'
  const common = outline
    ? {
        scale: 1.045,
        material: <primitive object={OUTLINE_MATERIAL} attach="material" />,
        // 描边壳是编辑器视觉件：无 UI 截图时隐藏
        userData: { editorHelper: true },
      }
    : {
        scale: 1,
        material: <meshStandardMaterial color={materialOverride?.color ?? color} roughness={materialOverride?.roughness ?? 0.65} metalness={materialOverride?.metalness ?? 0.05} transparent={ghost} opacity={ghost ? 0.45 : 1} depthWrite={!ghost} />,
        userData: undefined,
      }

  if (shape === 'cylinder') {
    return (
      <mesh castShadow={!outline && !ghost} receiveShadow={!outline} position={[0, h / 2, 0]} scale={common.scale} userData={common.userData}>
        <cylinderGeometry args={[w / 2, w / 2, h, 32]} />
        {common.material}
      </mesh>
    )
  }
  if (shape === 'sphere') {
    return (
      <mesh castShadow={!outline && !ghost} receiveShadow={!outline} position={[0, w / 2, 0]} scale={common.scale} userData={common.userData}>
        <sphereGeometry args={[w / 2, 32, 16]} />
        {common.material}
      </mesh>
    )
  }
  return (
    <mesh castShadow={!outline && !ghost} receiveShadow={!outline} position={[0, h / 2, 0]} scale={common.scale} userData={common.userData}>
      <boxGeometry args={[w, h, d]} />
      {common.material}
    </mesh>
  )
}

/** glb 资产：useGLTF 缓存 + clone 共享几何/材质，同一模型多实例零拷贝 */
function GlbModel(props: {
  url: string
  draco: boolean
  assetId: string
  refId: string
  selected: boolean
  ghost?: boolean
  interactive: boolean
  materialOverride?: SceneAsset['materialOverride']
}) {
  const { url, draco, assetId, refId, selected, materialOverride, ghost, interactive } = props
  const { scene } = useGLTF(url, draco ? '/assets/decoders/' : false)
  const cloned = useMemo(() => {
    normalizeGltf(scene)
    const copy = scene.clone(true)
    if (ghost) {
      const materials = new Map<Mesh['material'], Mesh['material']>()
      const transparent = (source: Mesh['material']) => {
        if (Array.isArray(source)) return source.map(material => {
          const clone = material.clone()
          clone.transparent = true
          clone.opacity *= 0.45
          clone.depthWrite = false
          return clone
        })
        const clone = source.clone()
        clone.transparent = true
        clone.opacity *= 0.45
        clone.depthWrite = false
        return clone
      }
      copy.traverse(object => {
        const mesh = object as Mesh
        if (!mesh.isMesh) return
        if (!materials.has(mesh.material)) materials.set(mesh.material, transparent(mesh.material))
        mesh.material = materials.get(mesh.material)!
      })
    }
    if (materialOverride) {
      const material = new MeshStandardMaterial(materialOverride)
      copy.traverse(o => { if ((o as Mesh).isMesh) (o as Mesh).material = material })
    }
    return copy
  }, [scene, materialOverride, ghost])
  useEffect(() => () => {
    if (!materialOverride && !ghost) return
    const materials = new Set<import('three').Material>()
    cloned.traverse(o => { const m = o as Mesh; if (m.isMesh) for (const material of [m.material].flat()) materials.add(material) })
    materials.forEach(m => m.dispose())
  }, [cloned, materialOverride, ghost])
  const outline = useMemo(() => (selected ? makeOutline(cloned) : null), [cloned, selected])

  useEffect(() => {
    cloned.traverse(obj => {
      if ((obj as Mesh).isMesh) obj.castShadow = !ghost
    })
    if (interactive) bus.emit('asset:loaded', { assetId, ref: refId })
  }, [cloned, assetId, refId, ghost, interactive])

  return (
    <>
      <primitive object={cloned} />
      {outline && <primitive object={outline} />}
    </>
  )
}

/**
 * 场景资产实例 —— 数据驱动渲染的最小单元。
 * 拾取 = 纯 mesh 精确点击（Blender 式，无包围盒代理）；选中高亮 = 橙色倒角壳描边。
 * 渲染层只上报事实（asset:clicked），"点了之后发生什么"由编辑器模块订阅决定；
 * 没有任何模块订阅时，点击不产生任何效果（纯渲染器模式）。
 * 除本文件与 ViewRig 外，任何代码不得直接操作 three 对象。
 */
export const AssetInstance = memo(function AssetInstance(props: { asset: SceneAsset; interactive?: boolean; ghost?: boolean; model?: ModelMeta; visible?: boolean }) {
  const { asset, interactive = true, ghost = false, model } = props
  const catalogMeta = useSceneStore(s => s.manifest?.models[asset.ref])
  const meta = model ?? catalogMeta
  const selected = useSceneStore(s => interactive && s.selectedAssetIds.includes(asset.id))

  const { position, rotation, scale } = asset.transform
  const scl: [number, number, number] = scale ?? [1, 1, 1]
  const glbSource = meta?.source.type === 'glb' ? meta.source : null

  return (
    <group
      name={asset.id}
      userData={ghost ? { editorHelper: true } : { assetId: asset.id }}
      position={position}
      rotation={asRad(rotation)}
      scale={scl}
      visible={props.visible ?? asset.visible !== false}
    >
      {/* R3F 事件沿对象树上冒：内部任意 mesh 的点击都会上报该资产 */}
      <group
        onClick={interactive ? e => {
          if (e.button !== 0) return
          e.stopPropagation()
          bus.emit('asset:clicked', { assetId: asset.id, additive: e.nativeEvent.shiftKey || e.nativeEvent.ctrlKey || e.nativeEvent.metaKey })
        } : undefined}
        onPointerOver={interactive ? () => (document.body.style.cursor = 'pointer') : undefined}
        onPointerOut={interactive ? () => (document.body.style.cursor = 'auto') : undefined}
      >
        {asset.group ? null : asset.shape ? <BuildShape asset={asset} ghost={ghost} selected={selected} /> : asset.terrain ? <TerrainModel terrain={asset.terrain} material={asset.materialOverride} /> : meta ? (
          glbSource ? (
            <group position={glbSource.offset} rotation-y={degToRad(glbSource.rotationY ?? 0)}>
              <group scale={glbSource.unitScale ?? 1}>
              <GlbModel
                url={glbSource.url ?? `/assets/${asset.ref}/${glbSource.file}`}
                draco={glbSource.draco === true}
                assetId={asset.id}
                refId={asset.ref}
                selected={selected}
                ghost={ghost}
                interactive={interactive}
                materialOverride={asset.materialOverride}
              />
              </group>
            </group>
          ) : (
            <>
              <PrimitiveModel meta={meta} tint={asset.tint} ghost={ghost} materialOverride={asset.materialOverride} />
              {selected && <PrimitiveModel meta={meta} outline />}
            </>
          )
        ) : (
          // 引用缺失时的红色警示占位
          <mesh castShadow position={[0, 0.5, 0]}>
            <boxGeometry args={[0.5, 1, 0.5]} />
            <meshStandardMaterial color="#e53935" />
          </mesh>
        )}
      </group>
    </group>
  )
})

function BuildShape({ asset, ghost, selected }: { asset: SceneAsset; ghost: boolean; selected: boolean }) {
  const { kind, size: [width, height, depth] } = asset.shape!
  const geometry = kind === 'plane' ? <planeGeometry args={[width, depth]} />
    : kind === 'cylinder' ? <cylinderGeometry args={[0.5, 0.5, height, 32]} />
      : <boxGeometry args={[width, height, depth]} />
  return <mesh
    castShadow={!ghost} receiveShadow
    position-y={kind === 'plane' ? 0 : height / 2}
    rotation-x={kind === 'plane' ? -Math.PI / 2 : 0}
    scale={kind === 'cylinder' ? [width, 1, depth] : 1}
  >
    {geometry}
    <meshStandardMaterial color={asset.materialOverride?.color ?? (selected ? '#b9a386' : '#92887b')}
      roughness={asset.materialOverride?.roughness ?? 0.8} metalness={asset.materialOverride?.metalness ?? 0}
      transparent={ghost} opacity={ghost ? 0.45 : 1} depthWrite={!ghost} side={kind === 'plane' ? 2 : 0} />
  </mesh>
}
