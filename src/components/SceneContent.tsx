import { useSceneStore } from '../core/store'
import { AssetInstance } from './AssetInstance'
import { Suspense, useMemo } from 'react'
import { assetHierarchy } from '../core/assetHierarchy'
import { AiReviewOverlay } from './AiReviewOverlay'
import { LightInstance } from './LightInstance'

/** 将场景文档里的对象同步到视口。 */
export function SceneContent({ showLightHelpers = false, honorEditorHidden = false }: { showLightHelpers?: boolean; honorEditorHidden?: boolean }) {
  const assets = useSceneStore(s => s.document?.assets)
  const lights = useSceneStore(s => s.document?.lights)
  const hiddenIds = useSceneStore(s => s.editorHiddenIds)
  const tree = useMemo(() => assetHierarchy(assets ?? []), [assets])
  const hidden = useMemo(() => new Set(honorEditorHidden ? hiddenIds : []), [honorEditorHidden, hiddenIds])
  if (!assets) return null
  return (
    <>
      {assets.map(asset => (
        <Suspense key={asset.id} fallback={null}>
          <AssetInstance asset={asset} visible={tree.visible(asset, hidden)} />
        </Suspense>
      ))}
      {lights?.map(light => <LightInstance key={light.id} light={light} showHelpers={showLightHelpers} />)}
      <AiReviewOverlay />
    </>
  )
}
