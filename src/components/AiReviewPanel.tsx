import { useMemo } from 'react'
import { assetBox, assetChanges, changeColors, useAiReview } from '../core/aiReview'
import { engine } from '../core/engine'
import { useSceneStore } from '../core/store'

const vector = (v: number[]) => `(${v.map(n => Number(n.toFixed(3))).join(', ')})`
const labels = { added: '新增', removed: '删除', modified: '修改' }

export function AiReviewPanel({ channel }: { channel: string }) {
  const review = useAiReview()
  const scene = useSceneStore()
  const changes = useMemo(() => review.before && scene.document && review.sceneId === scene.sceneId
    ? assetChanges(review.before, scene.document) : [], [review.before, review.sceneId, scene.document, scene.sceneId])
  if (review.channel !== channel || !review.before || review.sceneId !== scene.sceneId) return null
  return <section className="ai-review" aria-label="AI 修改对比">
    <strong>修改前后对比</strong>
    <div className="ai-review-legend">{Object.entries(labels).map(([kind, label]) =>
      <span key={kind} style={{ color: changeColors[kind as keyof typeof labels] }}>{label} {changes.filter(c => c.kind === kind).length}</span>)}</div>
    <div className="ai-review-options">
      <label><input type="checkbox" checked={review.highlighted} onChange={e => useAiReview.setState({ highlighted: e.target.checked })} />突出变化</label>
      <label><input type="checkbox" checked={review.showBefore} onChange={e => useAiReview.setState({ showBefore: e.target.checked })} />显示原位置</label>
    </div>
    <div className="ai-review-list">
      {changes.length === 0 && <div className="muted">尚无物体变化</div>}
      {changes.map(change => {
        const asset = change.after ?? change.before!
        return <button key={change.id} className={`ai-review-item${review.focusedId === change.id ? ' active' : ''}`}
          style={{ borderLeftColor: changeColors[change.kind] }} onClick={() => {
            useAiReview.setState({ focusedId: change.id })
            scene.select(change.after ? change.id : null)
            engine.focusBounds(assetBox(asset, scene.manifest))
          }} title="点击定位物体；删除项定位原位置">
          <span>{labels[change.kind]} · {asset.name ?? scene.manifest?.models[asset.ref]?.name ?? change.id}</span>
          <small>{change.id}{change.fields.length > 0 && ` · ${change.fields.join('、')}`}</small>
          {change.fields.includes('位置') && <small>{vector(change.before!.transform.position)} → {vector(change.after!.transform.position)} m</small>}
          {change.fields.includes('旋转') && <small>旋转 {vector(change.before!.transform.rotation)} → {vector(change.after!.transform.rotation)}°</small>}
          {change.fields.includes('缩放') && <small>缩放 {vector(change.before!.transform.scale ?? [1,1,1])} → {vector(change.after!.transform.scale ?? [1,1,1])}</small>}
          {change.kind === 'removed' && <small>原位置 {vector(asset.transform.position)} m</small>}
        </button>
      })}
    </div>
    <small className="muted">实线为当前范围，淡色框为修改前范围；仅作审查，不写入场景。</small>
  </section>
}
