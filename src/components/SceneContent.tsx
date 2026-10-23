import { useSceneStore } from '../core/store'
import { AssetInstance } from './AssetInstance'

/** 把 SceneDocument 的 assets 映射成资产实例 —— 数据驱动渲染的唯一入口 */
export function SceneContent() {
  const assets = useSceneStore(s => s.document?.assets)
  if (!assets) return null
  return <>{assets.map(asset => <AssetInstance key={asset.id} asset={asset} />)}</>
}
