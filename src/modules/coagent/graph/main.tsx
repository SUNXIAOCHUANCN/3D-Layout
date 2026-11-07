/**
 * 图可视化页（W10）的独立入口。
 *
 * 这个页面**不加载主应用**（没有 three.js、没有 zustand store、没有 editor 模块）：
 * 它只消费 graphFeed 广播的"拓扑 + 事件"，所以可以开在第二个显示器 / 第二个窗口里，
 * 一边跑 CoAgent 一边看节点推进。生产构建里它是 graph.html 这个独立入口。
 *
 * 只带 tokens.css（两套色系）+ graph.css（本页布局），不加载主应用的壳。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../styles/tokens.css'
import '../../../styles/graph.css'
import { initTheme } from '../../../ui/theme'
import { GraphPage } from './GraphPage'

initTheme()

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <GraphPage />
    </StrictMode>,
  )
}
