/**
 * 界面用的小型线性图标（1.1px 描边，随 currentColor）。
 * 不用 emoji：图标要么是这套线稿，要么留文字。
 */

type IconProps = { size?: number }

/** 品牌记号：制图用的十字定位标记 */
export function BrandMark({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.1} aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 .8v3.2M8 12v3.2M.8 8h3.2M12 8h3.2" />
    </svg>
  )
}

export function SunIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.1} aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.2v1.7M8 13.1v1.7M1.2 8h1.7M13.1 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" />
    </svg>
  )
}

export function MoonIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.1} aria-hidden="true">
      <path d="M13.2 9.7A5.5 5.5 0 0 1 6.3 2.8a5.6 5.6 0 1 0 6.9 6.9Z" />
    </svg>
  )
}

export function SendIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden="true">
      <path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" />
    </svg>
  )
}

export function StopIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="8" height="8" rx="1" />
    </svg>
  )
}

/** 清空 / 重置 */
export function ClearIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.1} aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
      <path d="M13.4 2.2v3.3h-3.3" />
    </svg>
  )
}
