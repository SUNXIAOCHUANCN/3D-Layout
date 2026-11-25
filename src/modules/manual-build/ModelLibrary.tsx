import { useMemo, useState } from 'react'
import { searchModels } from '../../core/modelSearch'
import { useSceneStore } from '../../core/store'
import { cancelPlacement, MODEL_DRAG_TYPE, startPlacement, usePlacement } from './placement'
import { CombinationLibrary, ImportModel } from './buildLibrary'
import { replaceShape } from './LayoutTools'
import { activateBrush } from './terrainBrush'

const PAGE_SIZE = 20
const dimensions = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

export function ModelLibrary({ revealTools }: { revealTools: () => void }) {
  const manifest = useSceneStore(state => state.manifest)
  const active = usePlacement(state => state.ref)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(0)
  const shape = useSceneStore(state => state.document?.assets.find(asset => asset.id === state.selectedAssetId)?.shape)
  const [fit, setFit] = useState(true)
  const categories = useMemo(() => [...new Set(Object.values(manifest?.models ?? {}).flatMap(model => model.category ? [model.category] : []))].sort(), [manifest])
  const { refs, total } = useMemo(() => {
    const models = manifest?.models ?? {}
    const filtered = Object.keys(models).filter(ref => !category || models[ref].category === category)
    const offset = page * PAGE_SIZE
    const term = query.trim()
    if (!term) return { refs: filtered.slice(offset, offset + PAGE_SIZE), total: filtered.length }
    const result = searchModels(category ? Object.fromEntries(filtered.map(ref => [ref, models[ref]])) : models, { query: term, offset, limit: PAGE_SIZE })
    return { refs: result.models.map(model => model.ref), total: result.total }
  }, [manifest, query, category, page])
  return (
    <div className="build-side-content">
      <ImportModel />
      <CombinationLibrary place={startPlacement} />
      {shape && <label className="build-checkbox"><input type="checkbox" checked={fit} onChange={event => setFit(event.target.checked)} />替换时适配灰盒尺寸</label>}
      <input className="llm-input" type="search" aria-label="搜索模型" placeholder="搜索模型…" maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} />
      <select className="llm-input" aria-label="素材类别" value={category} onChange={event => { setCategory(event.target.value); setPage(0) }}>
        <option value="">所有类别</option>
        {categories.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <div className="build-library">
        {refs.map(ref => {
          const model = manifest!.models[ref]
          return (
            <article className="build-model" key={ref} draggable
              onDragStart={event => {
                event.dataTransfer.setData(MODEL_DRAG_TYPE, ref)
                event.dataTransfer.effectAllowed = 'copy'
                startPlacement(ref)
              }}
              onDragEnd={event => { if (event.dataTransfer.dropEffect === 'none') cancelPlacement() }}
            >
              {model.thumbnail && <img className="build-thumbnail" src={model.thumbnail.startsWith('/') ? model.thumbnail : '/' + model.thumbnail} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true }} />}
              <div className="build-model-info">
                <strong>{model.name}</strong>
                <small>{[model.dimensions.w, model.dimensions.h, model.dimensions.d].map(value => dimensions.format(value)).join(' × ')} m</small>
                <button className={'btn' + (active === ref ? ' active' : '')} onClick={() => startPlacement(ref)} aria-pressed={active === ref}>放置</button>
                <button className="btn" onClick={() => { activateBrush('vegetation', ref); revealTools() }}>用于散布</button>
                {shape && <button className="btn" onClick={() => replaceShape(ref, fit)}>替换所选灰盒</button>}
              </div>
            </article>
          )
        })}
        {!refs.length && <div className="inspector-empty">{manifest ? '没有匹配的模型' : '正在加载素材目录…'}</div>}
      </div>
      {total > PAGE_SIZE && <div className="build-paging">
        <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
        <span>{page + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
        <button className="btn" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>下一页</button>
      </div>}
    </div>
  )
}
