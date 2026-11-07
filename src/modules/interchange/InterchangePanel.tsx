/**
 * 导入导出插件薄入口（架构 v3 §2/§10 内嵌入口模式）：
 * 只负责打开独立插件页面（127.0.0.1:5175），不含任何插件逻辑；
 * 插件服务与页面由 plugins/threejs-interchange 自己提供，宿主零耦合。
 */

import { useEffect, useState } from 'react'

const PLUGIN_URL = 'http://127.0.0.1:5175/'

export function InterchangePanel() {
  // 服务可达性探测：no-cors 请求对端端口,连不上才 reject(不读响应内容,不受 CORS 限制)
  const [up, setUp] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    fetch(PLUGIN_URL + 'api/interchange/status', { mode: 'no-cors' })
      .then(() => { if (alive) setUp(true) })
      .catch(() => { if (alive) setUp(false) })
    return () => { alive = false }
  }, [])

  return (
    <div className="interchange-panel">
      <div className={`ip-status ${up === null ? 'is-checking' : up ? 'is-up' : 'is-down'}`}>
        <span className="ip-dot" />
        {up === null ? '正在检查插件服务…' : up ? '插件服务运行中 · 127.0.0.1:5175' : '插件服务未启动'}
      </div>
      <button
        className="ip-open"
        onClick={() => window.open(PLUGIN_URL, '_blank', 'noopener')}
        title="在新标签页打开导入导出工具"
      >
        打开导入导出工具
        <span className="ip-arrow">↗</span>
      </button>
      <p className="ip-hint">
        {up === false
          ? '双击 dev.bat 会自动拉起；也可手动运行 plugins/threejs-interchange 下的 pnpm start。'
          : '导入外部 Three.js 场景、导出场景包（.layout.zip）与模型包（.model.zip），都在新标签页完成，不影响当前页面。'}
      </p>
    </div>
  )
}
