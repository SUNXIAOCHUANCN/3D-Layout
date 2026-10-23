import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { edit } from './core/edit'
import { engine } from './core/engine'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './style.css'

// 开发调试入口：控制台可用 __engine.pick(x,y) 探测拾取、__edit 直接驱动编辑引擎
const g = window as unknown as { __engine: typeof engine; __edit: typeof edit }
g.__engine = engine
g.__edit = edit

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
