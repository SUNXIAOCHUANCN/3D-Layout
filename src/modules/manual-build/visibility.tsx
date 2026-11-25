import { Canvas, useThree } from '@react-three/fiber'
import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Box3, Frustum, Matrix4, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, WebGLRenderTarget,
  type Camera, type Material, type Mesh, type Object3D, type Scene, type Texture, type WebGLRenderer,
} from 'three'
import { AssetInstance } from '../../components/AssetInstance'
import { useSceneStore } from '../../core/store'
import { assetHierarchy } from '../../core/assetHierarchy'
import type { ModelManifest, SceneAsset, SceneDocument } from '../../core/types'
import { createVisibilityUpload, finishAnalysis, useRecording } from './recording'
import { applyEvent, modelResource, type Recording, type ViewportSample, type Visibility } from './recordingData'

export function matchAsset(asset: SceneAsset, recording: Recording, manifest: ModelManifest | null): boolean {
  if (asset.terrain || asset.shape || asset.group) return true
  const recorded = recording.session.resources[asset.ref]
  const model = manifest?.models[asset.ref]
  return Boolean(model) && (!recorded || JSON.stringify(recorded) === JSON.stringify(modelResource(model)))
}

class AssetBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? null : this.props.children }
}

export function RecordedAssets({ doc, recording, hiddenIds }: { doc: SceneDocument; recording: Recording; hiddenIds?: string[] }) {
  const manifest = useSceneStore(state => state.manifest)
  const tree = useMemo(() => assetHierarchy(doc.assets), [doc.assets])
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds])
  return <>{doc.assets.map(asset => (
    matchAsset(asset, recording, manifest) && <AssetBoundary key={`${asset.id}:${asset.ref}`}>
      <AssetInstance asset={tree.visible(asset, hidden) ? asset : { ...asset, visible: false }} interactive={false} />
    </AssetBoundary>
  ))}</>
}

export function recordedCamera(sample: ViewportSample) {
  const camera = sample.projection === 'orthographic' ? new OrthographicCamera() : new PerspectiveCamera()
  camera.near = sample.near
  camera.far = sample.far
  camera.position.fromArray(sample.position)
  camera.quaternion.fromArray(sample.quaternion)
  camera.projectionMatrix.fromArray(sample.projectionMatrix)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  camera.updateMatrixWorld(true)
  return Object.assign(camera, { manual: true })
}

interface AssetGeometry {
  id: string
  index: number
  root?: Object3D
  bounds?: Box3
  hidden: boolean
  group: boolean
}

function objectIdMaterial(source: Material, id: number): MeshBasicMaterial {
  const original = source as Material & { map?: Texture; alphaMap?: Texture }
  const material = new MeshBasicMaterial({
    map: original.map ?? null, alphaMap: original.alphaMap ?? null, vertexColors: source.vertexColors,
    alphaTest: source.alphaTest || (source.transparent ? 1 / 255 : 0),
    side: source.side, opacity: source.opacity, visible: source.visible, toneMapped: false,
  })
  material.color.setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255)
  // Preserve texture cutouts without allowing texture RGB to modify the ID.
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #ifdef USE_COLOR_ALPHA
        diffuseColor.a *= vColor.a;
      #endif
    `).replace('#include <map_fragment>', `
      #ifdef USE_MAP
        diffuseColor.a *= texture2D( map, vMapUv ).a;
      #endif
    `)
  }
  return material
}

function prepareRaster(scene: Scene, gl: WebGLRenderer, doc: SceneDocument, hiddenIds?: string[]) {
  const materials: MeshBasicMaterial[] = []
  const replaced: { mesh: Mesh; original: Mesh['material'] }[] = []
  const roots = new Map(scene.children.map(child => [child.userData.assetId, child]))
  const tree = assetHierarchy(doc.assets)
  const viewHidden = new Set(hiddenIds)
  const objects: AssetGeometry[] = doc.assets.map((asset, i) => {
    const hidden = !tree.visible(asset, viewHidden)
    const root = roots.get(asset.id)
    const index = i + 1
    root?.traverse(object => {
      const mesh = object as Mesh
      if (!mesh.isMesh) return
      replaced.push({ mesh, original: mesh.material })
      const convert = (original: Material) => {
        const material = objectIdMaterial(original, index)
        materials.push(material)
        return material
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material)
    })
    return { id: asset.id, index, root, hidden, group: asset.group === true, bounds: root ? new Box3().setFromObject(root) : undefined }
  })
  const target = new WebGLRenderTarget(1, 1, { samples: 0 })
  let pixels = new Uint8Array(4)
  const originalTarget = gl.getRenderTarget()
  gl.setClearColor(0, 0)
  const render = (camera: Camera) => {
    gl.setRenderTarget(target)
    gl.clear()
    gl.render(scene, camera)
    gl.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels)
    const counts = new Uint32Array(objects.length + 1)
    for (let i = 0; i < pixels.length; i += 4) {
      counts[pixels[i] | pixels[i + 1] << 8 | pixels[i + 2] << 16]++
    }
    return counts
  }

  return {
    measure(sample: ViewportSample, width: number, focus: Set<string>): Visibility[] {
      const height = Math.max(1, Math.round(width * sample.height / sample.width))
      const shrink = Math.min(1, gl.capabilities.maxTextureSize / Math.max(width, height))
      width = Math.max(1, Math.floor(width * shrink))
      const rasterHeight = Math.max(1, Math.floor(height * shrink))
      target.setSize(width, rasterHeight)
      if (pixels.length !== width * rasterHeight * 4) pixels = new Uint8Array(width * rasterHeight * 4)
      const camera = recordedCamera(sample)
      const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
      const counts = render(camera)
      const row = (objectId: string, status: Visibility['status'], visiblePixels: number | null = null, projectedPixels: number | null = null): Visibility => ({
        sampleId: sample.sampleId, sceneRevision: sample.sceneRevision, objectId, status, visiblePixels, projectedPixels,
        screenOccupancy: visiblePixels === null ? null : visiblePixels / (width * rasterHeight),
        visibilityRatio: projectedPixels ? visiblePixels! / projectedPixels : null,
        rasterWidth: width, rasterHeight,
      })
      const projected = new Map<number, number>()
      const candidates = objects.filter(o => o.root && !o.hidden && o.bounds && !o.bounds.isEmpty() && frustum.intersectsBox(o.bounds))
      try {
        // Suppress out-of-view roots too, including conservative or missing bounds.
        for (const object of objects) if (object.root) object.root.visible = false
        for (const object of candidates) {
          if (!focus.has(object.id)) continue
          object.root!.visible = true
          projected.set(object.index, render(camera)[object.index])
          object.root!.visible = false
        }
      } finally {
        for (const object of objects) if (object.root) object.root.visible = !object.hidden
        gl.setRenderTarget(originalTarget)
      }
      const results = objects.map(object => {
        const { id, index, hidden, bounds, root } = object
        if (object.group) return row(id, 'not_applicable')
        if (hidden) return row(id, 'hidden', 0)
        if (!root || !bounds || bounds.isEmpty()) return row(id, 'resource_unavailable')
        const count = counts[index]
        if (!count && !frustum.intersectsBox(bounds)) return row(id, 'out_of_view', 0)
        const alone = projected.get(index) ?? null
        return row(id, count || alone ? 'measured' : 'unresolved', count, alone)
      })
      return [...results, ...(doc.lights ?? []).map(light => row(light.id, 'not_applicable'))]
    },
    dispose() {
      gl.setRenderTarget(originalTarget)
      for (const { mesh, original } of replaced) mesh.material = original
      for (const material of materials) material.dispose()
      target.dispose()
    },
  }
}

function MeasureRevision({ doc, samples, recording, focus, appendRows, onComplete, onError }: {
  doc: SceneDocument
  samples: ViewportSample[]
  recording: Recording
  focus: Set<string>
  appendRows: (rows: Visibility[]) => Promise<void>
  onComplete: () => void
  onError: (error: string) => void
}) {
  const { scene, gl } = useThree()
  useEffect(() => {
    const config = recording.session.analysis
    let stop = false
    let raster: ReturnType<typeof prepareRaster> | undefined
    const run = async () => {
      // Yield between samples so editing remains responsive while analysis runs.
      for (const sample of samples) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (stop) return
        raster ??= prepareRaster(scene, gl, doc, sample.hiddenAssetIds)
        let frame = raster.measure(sample, config.width, focus)
        const keyFrame = sample.reason !== 'camera' && sample.reason !== 'resize'
        if (keyFrame && config.maxWidth > config.width && frame.some(row => row.status === 'unresolved' && focus.has(row.objectId))) {
          frame = raster.measure(sample, config.maxWidth, focus)
        }
        await appendRows(frame)
      }
      raster?.dispose()
      raster = undefined
      if (!stop) onComplete()
    }
    void run().catch(error => { if (!stop) onError(error instanceof Error ? error.message : String(error)) })
    return () => { stop = true; raster?.dispose() }
  }, [scene, gl, doc, recording, focus, samples, appendRows, onComplete, onError])
  return null
}

function Analyze({ recording, upload }: { recording: Recording; upload: ReturnType<typeof createVisibilityUpload> }) {
  const revisions = useMemo(() => {
    let doc = recording.initial.document
    let next = 0
    const groups: { doc: SceneDocument; samples: ViewportSample[] }[] = []
    let previous: number | undefined
    let previousHidden = ''
    for (const sample of recording.samples) {
      const hidden = JSON.stringify(sample.hiddenAssetIds ?? [])
      if (sample.sceneRevision !== previous || hidden !== previousHidden) {
        while (next < recording.edits.length && recording.edits[next].revisionAfter <= sample.sceneRevision) {
          doc = applyEvent(doc, recording.edits[next++])
        }
        groups.push({ doc, samples: [] })
        previous = sample.sceneRevision
        previousHidden = hidden
      }
      groups.at(-1)!.samples.push(sample)
    }
    return groups
  }, [recording])
  const focus = useMemo(() => {
    const edited = new Set(recording.edits.flatMap(event => event.changes.map(change => change.objectId)))
    const others = recording.initial.document.assets.filter(asset => !asset.terrain && !edited.has(asset.id))
    return new Set([...edited, ...others.slice(0, recording.session.analysis.referenceCount).map(asset => asset.id)])
  }, [recording])
  const [index, setIndex] = useState(0)
  const group = revisions[index]
  const measure = useMemo(() => () => {
    useRecording.setState({ progress: (index + 1) / revisions.length })
    if (index + 1 >= revisions.length) {
      setIndex(revisions.length)
      void finishAnalysis(recording, upload)
    } else setIndex(index + 1)
  }, [index, recording, upload, revisions])
  const fail = useMemo(() => (message: string) => {
    setIndex(revisions.length)
    void finishAnalysis(recording, upload, message)
  }, [recording, upload, revisions])
  return <div className="build-offscreen" aria-hidden="true">
    <Canvas frameloop="never" dpr={1}>
      {group && <Suspense fallback={null}>
        <RecordedAssets doc={group.doc} recording={recording} hiddenIds={group.samples[0].hiddenAssetIds} />
        <MeasureRevision doc={group.doc} samples={group.samples} recording={recording} focus={focus}
          appendRows={upload.append} onComplete={measure} onError={fail} />
      </Suspense>}
    </Canvas>
  </div>
}

class AnalysisBoundary extends Component<{ recording: Recording }, { failed: boolean }> {
  private upload = createVisibilityUpload(this.props.recording)
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { void finishAnalysis(this.props.recording, this.upload, error.message) }
  render() { return this.state.failed ? null : <Analyze recording={this.props.recording} upload={this.upload} /> }
}

export function RecordingAnalysis() {
  const next = useRecording(state => state.jobs[0])
  if (!next) return null
  return <AnalysisBoundary recording={next} key={next.session.sessionId} />
}
