import { MoonIcon, SunIcon } from './icons'
import { setTheme, useTheme } from './theme'

/** 顶栏配色切换：日 / 夜两档，当前档位抬起（纸面高光） */
export function ThemeSwitch() {
  const theme = useTheme()
  return (
    <div className="theme-switch" role="group" aria-label="界面配色">
      <button
        type="button"
        aria-pressed={theme === 'light'}
        aria-label="浅色 · 纸面"
        title="浅色 · 纸面"
        onClick={() => setTheme('light')}
      >
        <SunIcon />
      </button>
      <button
        type="button"
        aria-pressed={theme === 'dark'}
        aria-label="深色 · 暗房"
        title="深色 · 暗房"
        onClick={() => setTheme('dark')}
      >
        <MoonIcon />
      </button>
    </div>
  )
}
