/**
 * CoAgentProgress（W06.5）——运行进度、可折叠事件流、分区示意。
 *
 * 三条都是**只读投影**：进度来自 recorder 事件，分区来自 runtime 的 PartitionSnapshot。
 * 这里不发起任何业务动作（开始/取消/生成分区仍在面板按钮上）。
 */

import { useEffect, useRef, useState } from 'react'
import type { CoAgentEventEnvelope, CoAgentPhase, PartitionSnapshot } from './contracts'
import { deriveRunProgress, formatEvent } from './uiProjection'

const STYLE_BAR: React.CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: '#2d333b',
  overflow: 'hidden',
  margin: '6px 0 4px',
}
const STYLE_FILL: React.CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg,#4c8dff,#6ee7b7)',
  transition: 'width .25s ease',
}

/** 简单计时：active 变 true 时重新开始，结束后保留总耗时 */
export function useElapsed(active: boolean): number {
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const wasActive = useRef(false)

  useEffect(() => {
    if (active && !wasActive.current) {
      setStartedAt(Date.now())
      setElapsed(0)
    }
    wasActive.current = active
    if (!active || startedAt === null) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 500)
    return () => clearInterval(timer)
  }, [active, startedAt])

  return active ? elapsed : elapsed
}

export function RunProgress(props: { events: CoAgentEventEnvelope[]; phase: CoAgentPhase; busy: boolean }) {
  const view = deriveRunProgress(props.events, props.phase)
  const elapsed = useElapsed(props.busy)
  const seconds = Math.max(0, Math.round(elapsed / 1000))
  const latest = props.events.slice(-120)
  const failed = props.phase === 'rolled_back' || props.phase === 'failed' || props.phase === 'error_locked'
  const fillStyle: React.CSSProperties = failed
    ? { ...STYLE_FILL, background: 'linear-gradient(90deg,#f85149,#f0b429)', transition: 'none' }
    : STYLE_FILL

  return (
    <div className="agent-section">
      <div className="agent-task-label">
        进度 {view.percent}%
        {view.total > 0 ? `（${view.passed}/${view.total} 任务${view.failed > 0 ? `，失败 ${view.failed}` : ''}）` : '（按阶段估算）'}
        {props.busy ? `，${seconds}s` : ''}
        {failed ? '，已停止' : ''}
      </div>
      <div style={STYLE_BAR}>
        <div style={{ ...fillStyle, width: `${view.percent}%` }} />
      </div>
      <div className="agent-chat-note">
        阶段：{view.step}｜当前：{view.current}
      </div>
      <details open={props.busy || failed} style={{ marginTop: 4 }}>
        <summary style={{ cursor: 'pointer', color: '#9aa4b2', fontSize: 12 }}>
          执行明细（{props.events.length} 条事件，可折叠）
        </summary>
        <div
          style={{
            maxHeight: 180,
            overflowY: 'auto',
            fontFamily: 'ui-monospace, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.5,
            color: '#9aa4b2',
            borderLeft: '2px solid #2d333b',
            paddingLeft: 6,
            marginTop: 4,
          }}
        >
          {latest.length === 0 ? (
            <div>（还没有事件）</div>
          ) : (
            latest.map(e => <div key={e.eventSeq}>{formatEvent(e)}</div>)
          )}
        </div>
      </details>
    </div>
  )
}

const PALETTE = ['#4c8dff', '#6ee7b7', '#f0b429', '#f97583', '#b392f0', '#79c0ff']

/** 分区俯视示意（俯视图：画面上方 = 世界 -Z，与鸟瞰相机一致） */
export function PartitionPreview(props: { partition: PartitionSnapshot | null }) {
  const partition = props.partition
  if (!partition || partition.regions.length === 0) return null

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const r of partition.regions) {
    for (const [x, z] of r.polygonXZ) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
  }
  const pad = 0.5
  const w = Math.max(maxX - minX, 1) + pad * 2
  const h = Math.max(maxZ - minZ, 1) + pad * 2
  const VW = 220
  const VH = 150
  const scale = Math.min(VW / w, VH / h)
  const ox = (VW - w * scale) / 2
  const oy = (VH - h * scale) / 2
  const toX = (x: number): number => ox + (x - minX + pad) * scale
  const toY = (z: number): number => oy + (z - minZ + pad) * scale

  const ratio = h / w
  // 细长场景（例如 11m × 217m）不要撑满 132px，否则只是一根线
  const previewHeight = Math.round(Math.min(132, Math.max(56, 132 * Math.min(1, ratio))))

  return (
    <svg
      viewBox={`0 0 ${VW} ${VH}`}
      style={{ width: '100%', height: previewHeight, background: '#0f1319', border: '1px solid #2d333b', borderRadius: 4 }}
      role="img"
      aria-label="分区俯视示意"
    >
      {partition.regions.map((r, i) => {
        const points = r.polygonXZ.map(([x, z]) => `${toX(x)},${toY(z)}`).join(' ')
        const cx = r.polygonXZ.reduce((s, p) => s + toX(p[0]), 0) / r.polygonXZ.length
        const cy = r.polygonXZ.reduce((s, p) => s + toY(p[1]), 0) / r.polygonXZ.length
        const color = PALETTE[i % PALETTE.length]
        return (
          <g key={r.id}>
            <polygon points={points} fill={`${color}22`} stroke={color} strokeWidth="1.2" />
            <text x={cx} y={cy} fill={color} fontSize="8" textAnchor="middle" dominantBaseline="middle">
              {r.name}
            </text>
          </g>
        )
      })}
      <text x={4} y={VH - 3} fill="#586069" fontSize="7">
        {`x:${minX.toFixed(1)}~${maxX.toFixed(1)}  z:${minZ.toFixed(1)}~${maxZ.toFixed(1)}（上方=-Z）`}
      </text>
    </svg>
  )
}
