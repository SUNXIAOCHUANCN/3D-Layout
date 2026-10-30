import { useEffect, useState } from 'react'
import { makeOutline } from '../../components/AssetInstance'
import { engine } from '../../core/engine'
import { bus } from '../../core/events'

const HIGHLIGHT_MS = 4000

/**
 * Agent 视觉点选的瞬时高亮：viewport.pick 命中后橙色描边 4 秒，
 * 让用户看见 Agent「看」的是哪个物体。
 * 纯视觉件——不碰 selectedAssetId、不进历史；描边壳挂在资产 three 对象
 * 下（命令式 attach，同 EditorGizmo 模式），自动跟随其后续变换；
 * userData.editorHelper 标记保证无 UI 截图口径不受影响。
 */
export function AgentPickHighlight() {
  const [assetId, setAssetId] = useState<string | null>(null)

  useEffect(() => {
    let timer = 0
    const off = bus.on('agent:picked', ({ assetId }) => {
      window.clearTimeout(timer)
      setAssetId(assetId)
      if (assetId) timer = window.setTimeout(() => setAssetId(null), HIGHLIGHT_MS)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [])

  useEffect(() => {
    if (!assetId) return
    const obj = engine.findAssetObject(assetId)
    if (!obj) return
    const shell = makeOutline(obj)
    // 壳自身变换归零，作为子对象完全跟随资产的后续变换（避免双重叠加）
    shell.position.set(0, 0, 0)
    shell.rotation.set(0, 0, 0)
    shell.scale.set(1, 1, 1)
    obj.add(shell)
    return () => {
      obj.remove(shell)
    }
  }, [assetId])

  return null
}
