import { useProgress } from '@react-three/drei'

/** glb 等异步资源的加载进度浮层（useProgress 是全局 store，Canvas 外可用） */
export function LoadingOverlay() {
  const { active, progress } = useProgress()
  if (!active) return null
  return (
    <div className="overlay">
      <div className="overlay-card">
        <div>加载场景资源… {Math.round(progress)}%</div>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  )
}
