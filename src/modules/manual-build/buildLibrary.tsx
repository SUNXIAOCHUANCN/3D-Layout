import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { Suspense, useEffect, useState } from 'react'
import { Box3 } from 'three'
import { create } from 'zustand'
import { AssetInstance } from '../../components/AssetInstance'
import { assetHierarchy, followTransform } from '../../core/assetHierarchy'
import { engine } from '../../core/engine'
import { useSceneStore } from '../../core/store'
import type { ModelMeta, SceneAsset, Transform, Vec3 } from '../../core/types'
import { ErrorBoundary } from '../../ui/ErrorBoundary'
import { cloneAssets, selectedRoots, selectionPivot } from './buildTools'

export interface Combination { id: string; name: string; assets: SceneAsset[] }
export const useCombinations = create<{ entries: Combination[] }>(() => ({ entries: [] }))
const ZERO: Transform = { position: [0, 0, 0], rotation: [0, 0, 0] }

async function result<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload) throw new Error(payload?.error ?? `素材服务不可用（HTTP ${response.status}）`)
  return payload as T
}

export function cloneCombination(combo: Combination, position: Vec3, yaw: number): SceneAsset[] {
  const clones = cloneAssets(combo.assets, [0, 0, 0])
  return clones.map(asset => ({ ...asset, transform: followTransform(asset.transform, ZERO, { position, rotation: [0, yaw, 0] }) }))
}

export function CombinationLibrary({ place }: { place: (ref: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const selected = useSceneStore(state => state.selectedAssetIds.length)
  const entries = useCombinations(state => state.entries)
  useEffect(() => {
    let cancelled = false
    if (open) void fetch('/api/build-combinations').then(result<Combination[]>).then(
      items => { if (!cancelled) useCombinations.setState({ entries: items }) },
      error => { if (!cancelled) setMessage(error.message) },
    )
    return () => { cancelled = true }
  }, [open])
  const save = async () => {
    const { document, selectedAssetIds } = useSceneStore.getState()
    if (!document || !name.trim() || !selectedAssetIds.length) return
    const tree = assetHierarchy(document.assets)
    const roots = selectedRoots(document.assets, selectedAssetIds)
    const included = roots.flatMap(root => [root, ...tree.descendants(root.id)])
    const ids = new Set(included.map(asset => asset.id))
    const pivot = selectionPivot(roots)
    const bounds = new Box3()
    for (const asset of included) {
      const object = engine.findAssetObject(asset.id)
      if (object) bounds.union(new Box3().setFromObject(object))
    }
    if (!bounds.isEmpty()) pivot[1] = bounds.min.y
    const assets = included.map(asset => ({
      ...asset, parentId: ids.has(asset.parentId ?? '') ? asset.parentId : undefined,
      scatterTerrainId: ids.has(asset.scatterTerrainId ?? '') ? asset.scatterTerrainId : undefined,
      transform: { ...asset.transform, position: asset.transform.position.map((value, axis) => value - pivot[axis]) },
    }))
    setSaving(true)
    setMessage('')
    try {
      const saved = await result<Combination>(await fetch('/api/build-combinations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Layout-Client': '1' },
        body: JSON.stringify({ assets, name }),
      }))
      useCombinations.setState(state => ({ entries: [...state.entries, saved] }))
      setName('')
      setMessage('组合已保存')
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  return <>
    <button className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>素材组合</button>
    {open && <div className="build-combinations">
      <form className="build-actions" onSubmit={event => { event.preventDefault(); void save() }}>
        <input className="llm-input" aria-label="素材组合名称" placeholder="组合名称" maxLength={120} value={name} onChange={event => setName(event.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim() || !selected || saving}>保存所选为组合</button>
      </form>
      {message && <small role="status">{message}</small>}
      {entries.map(item => <div className="build-actions" key={item.id}>
        <strong>{item.name}</strong><small>{item.assets.length} 个对象</small>
        <button className="btn" onClick={() => place(`combo:${item.id}`)}>放置组合</button>
      </div>)}
    </div>}
  </>
}

export function ImportModel() {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File>()
  const [name, setName] = useState('')
  const [yaw, setYaw] = useState(0)
  const [unitScale, setUnitScale] = useState(1)
  const [offsetY, setOffsetY] = useState(0)
  const [preview, setPreview] = useState<ModelMeta>()
  const [previewReady, setPreviewReady] = useState(false)
  const [blob, setBlob] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const invalidate = () => { setPreview(undefined); setPreviewReady(false); setMessage('') }
  useEffect(() => {
    if (!file || !open) return
    const url = URL.createObjectURL(file)
    setBlob(url)
    return () => URL.revokeObjectURL(url)
  }, [file, open])
  const upload = async (save: boolean) => {
    if (!file || !name.trim()) return
    setBusy(true)
    setMessage('')
    try {
      const query = new URLSearchParams({ name, yaw: String(yaw), offsetY: String(offsetY), unitScale: String(unitScale) })
      const next = await result<ModelMeta>(await fetch(`/api/build-models${save ? '' : '/inspect'}?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Layout-Client': '1' }, body: file,
      }))
      if (save) {
        useSceneStore.setState(state => ({ manifest: {
          generatedAt: state.manifest?.generatedAt ?? new Date().toISOString(),
          models: { ...state.manifest?.models, [`models/${next.id}`]: next },
        } }))
        setMessage(`「${next.name}」已加入手工导入类别`)
        setPreview(undefined)
        setFile(undefined)
      } else {
        if (preview?.id !== next.id) setPreviewReady(false)
        setPreview(next)
      }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const size = preview ? Math.max(preview.dimensions.w, preview.dimensions.h, preview.dimensions.d, 0.1) : 1
  return <>
    <button className="btn" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>导入 GLB</button>
    {open && <div className="build-import">
      <fieldset disabled={busy} className="build-terrain-layers">
        <label>静态 GLB<input className="llm-input" type="file" accept=".glb,model/gltf-binary" onChange={event => {
          const next = event.target.files?.[0]
          setFile(next)
          setName(next?.name.replace(/\.glb$/i, '').slice(0, 120) ?? '')
          invalidate()
        }} /></label>
        <label>名称<input className="llm-input" maxLength={120} value={name} onChange={event => { setName(event.target.value); invalidate() }} /></label>
        <label>朝向 (°)<input className="llm-input" type="number" min={-360} max={360} value={yaw} onChange={event => { setYaw(event.target.valueAsNumber || 0); invalidate() }} /></label>
        <label>每单位米数<input className="llm-input" type="number" min={0.00001} max={10000} step="any" value={unitScale} onChange={event => { setUnitScale(event.target.valueAsNumber || 1); invalidate() }} /></label>
        <label>模型底部相对原点 (m)<input className="llm-input" type="number" step="any" value={offsetY} onChange={event => { setOffsetY(event.target.valueAsNumber || 0); invalidate() }} /></label>
        <button className="btn" disabled={!file || !name.trim()} onClick={() => void upload(false)}>校验并预览</button>
      </fieldset>
      {preview && preview.source.type === 'glb' && blob && <div className="build-import-preview">
        <small>{[preview.dimensions.w, preview.dimensions.h, preview.dimensions.d].map(value => value.toFixed(2)).join(' × ')} m</small>
        <ErrorBoundary key={preview.id}>
          <Canvas dpr={1} camera={{ position: [size * 1.8, size * 1.4 + offsetY, size * 1.8], near: size / 100, far: size * 100 + Math.abs(offsetY) * 2 }}>
            <ambientLight intensity={2} />
            <directionalLight position={[3, 6, 4]} intensity={2} />
            <axesHelper args={[size * 0.45]} />
            <OrbitControls target={[0, offsetY + preview.dimensions.h / 2, 0]} />
            <Suspense fallback={null}>
              <AssetInstance asset={{ id: 'import-preview', ref: '', transform: ZERO }} model={{ ...preview, source: { ...preview.source, url: blob } }} interactive={false} />
              <PreviewReady key={preview.id} ready={setPreviewReady} />
            </Suspense>
          </Canvas>
        </ErrorBoundary>
        <button className="btn" disabled={busy || !previewReady} onClick={() => void upload(true)}>确认入库</button>
      </div>}
      {message && <small role="status">{message}</small>}
    </div>}
  </>
}

function PreviewReady({ ready }: { ready: (value: boolean) => void }) {
  useEffect(() => { ready(true); return () => ready(false) }, [ready])
  return null
}
