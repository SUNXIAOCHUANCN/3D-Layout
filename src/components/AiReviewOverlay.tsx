import { useMemo } from 'react'
import { Vector3, type Box3 } from 'three'
import { assetBox, assetChanges, changeColors, useAiReview } from '../core/aiReview'
import { useSceneStore } from '../core/store'

function ReviewBox({ box, color, faded = false, focused = false }: { box: Box3; color: string; faded?: boolean; focused?: boolean }) {
  const center = box.getCenter(new Vector3())
  const size = box.getSize(new Vector3()).max(new Vector3(0.05, 0.05, 0.05))
  return <mesh position={center} scale={size.multiplyScalar(focused ? 1.035 : 1.01)} raycast={() => {}} renderOrder={1000}>
    <boxGeometry />
    <meshBasicMaterial color={color} wireframe transparent opacity={faded ? 0.3 : focused ? 1 : 0.8} depthTest={false} depthWrite={false} toneMapped={false} />
  </mesh>
}

/** Review helpers have no asset ID and are excluded from model screenshots and picking. */
export function AiReviewOverlay() {
  const review = useAiReview()
  const sceneId = useSceneStore(s => s.sceneId)
  const document = useSceneStore(s => s.document)
  const manifest = useSceneStore(s => s.manifest)
  const changes = useMemo(() => review.before && document && review.sceneId === sceneId
    ? assetChanges(review.before, document) : [], [review.before, review.sceneId, document, sceneId])
  if (!review.highlighted) return null
  return <group userData={{ editorHelper: true }}>
    {changes.map(c => <group key={c.id}>
      {c.after && <ReviewBox box={assetBox(c.after, manifest)} color={changeColors[c.kind]} focused={review.focusedId === c.id} />}
      {c.before && (c.kind === 'removed' || review.showBefore) && <ReviewBox box={assetBox(c.before, manifest)} color={changeColors[c.kind]}
        faded={c.kind !== 'removed'} focused={review.focusedId === c.id} />}
    </group>)}
  </group>
}
