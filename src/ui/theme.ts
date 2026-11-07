import { useSyncExternalStore } from 'react'

/**
 * 主题（配色）状态：暗房 / 纸面。
 *
 * - 首次进入跟随系统 prefers-color-scheme；用户手动切换后写入 localStorage，之后不再跟随系统。
 * - 切换时优先用 View Transitions 做交叉淡化（合成层动画，不逐元素过渡，3D 视口不受影响）；
 *   不支持或用户要求减少动效时直接落位。
 * - 真正的颜色定义在 styles/tokens.css 的 :root[data-theme=…] 里，这里只负责 <html data-theme>。
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'ui-theme-v1'
const listeners = new Set<() => void>()

let current: Theme = 'dark'
let initialized = false

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

/** 多窗口同步：图视图（graph.html）与主应用共用同一个偏好键，任一边切换另一边跟着走 */
function watchOtherWindows(): void {
  window.addEventListener('storage', ev => {
    if (ev.key !== STORAGE_KEY) return
    if (ev.newValue !== 'light' && ev.newValue !== 'dark') return
    if (ev.newValue === current) return
    current = ev.newValue
    applyTheme(current)
    emit()
  })
}

/** 在 React 挂载前调用一次：?theme= 显式指定 > 上次选择 > 跟随系统 */
export function initTheme(): void {
  if (initialized) return
  initialized = true
  // 截图 / 演示用：?theme=dark|light 只对本次加载生效，不写入偏好
  const urlTheme = new URLSearchParams(location.search).get('theme')
  if (urlTheme === 'light' || urlTheme === 'dark') {
    current = urlTheme
    applyTheme(current)
    watchOtherWindows()
    return
  }
  current = readStored() ?? systemTheme()
  applyTheme(current)
  watchOtherWindows()
  if (!window.matchMedia) return

  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener?.('change', () => {
    // 用户没有手动选过时才跟随系统
    if (readStored()) return
    current = systemTheme()
    applyTheme(current)
    emit()
  })
}

export function getTheme(): Theme {
  return current
}

export function setTheme(next: Theme, opts: { animate?: boolean } = {}): void {
  if (!initialized) initTheme()
  if (next === current) return

  const commit = (): void => {
    current = next
    applyTheme(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 写不进就算了：本次仍然生效 */
    }
    emit()
  }

  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const doc = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<void> }
  }

  if (opts.animate !== false && !reduce && typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(commit)
  } else {
    commit()
  }
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark')
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme)
}
