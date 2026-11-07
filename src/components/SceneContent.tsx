import { useSceneStore } from '../core/store'
import { AssetInstance } from './AssetInstance'
import { Suspense } from 'react'
import { AiReviewOverlay } from './AiReviewOverlay'

/** 把 SceneDocument 的 assets 映射成资产实例 —— 数据驱动渲染的唯一入口 */
export function SceneContent() {
  const assets = useSceneStore(s => s.document?.assets)
  if (!assets) return null
  return <>{assets.map(asset => (
    <Suspense key={asset.id} fallback={null}>
      <AssetInstance asset={asset} />
    </Suspense>
  ))}<AiReviewOverlay /></>
}
