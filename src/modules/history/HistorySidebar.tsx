import { useEffect, useReducer, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { edit, type HistoryUnitView } from '../../core/edit'
import { bus } from '../../core/events'

const fmtTime = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

interface Pending {
  mode: 'undo' | 'redo'
  txId: number
  label: string
  steps: number
}

/**
 * 编辑历史侧栏（右侧，可收起，可拖拽调宽）。展示统一历史谱系（人工/Agent 同一本账）：
 * 每条 = 一个事务（一次拖拽/一次输入/Agent 一项任务），最新在下、高亮当前步；
 * 点击某条 → 确认框 → 撤回到该步之后的状态（灰色已撤销条目可点击重做）。
 */
export function HistorySidebar(props: {
  collapsed: boolean
  onToggle: () => void
  /** 宽度由 App 持有（拖拽手柄在外侧），这里只透传 */
  style?: CSSProperties
  /** CoAgent 运行中锁定 undo/redo（W03 互斥入口：防止中途撤销搅事务） */
  locked?: boolean
}) {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => bus.on('history:changed', bump), [])
  const listRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<Pending | null>(null)

  const done = edit.historyUnits()
  const undone = edit.redoUnits()
  const total = done.length + undone.length

  // 新记录产生时滚动到底部（最新步）
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [total])

  if (props.collapsed) {
    return (
      <button className="rail rail-right" onClick={props.onToggle} title="展开历史记录">
        « 历史
      </button>
    )
  }

  const clickUndoable = (u: HistoryUnitView) => {
    if (props.locked) return
    const idx = done.findIndex(d => d.txId === u.txId)
    const steps = done.length - 1 - idx
    if (steps <= 0) return // 已是当前步，无需撤回
    setPending({ mode: 'undo', txId: u.txId, label: u.label, steps })
  }

  const clickRedoable = (u: HistoryUnitView) => {
    if (props.locked) return
    const steps = undone.findIndex(d => d.txId === u.txId) + 1
    if (steps <= 0) return
    setPending({ mode: 'redo', txId: u.txId, label: u.label, steps })
  }

  const confirm = () => {
    if (!pending) return
    if (pending.mode === 'undo') edit.undoTo(pending.txId)
    else edit.redoTo(pending.txId)
    setPending(null)
  }

  return (
    <aside className="sidebar sidebar-right" style={props.style}>
      <div className="sidebar-head row">
        <span>历史记录</span>
        <button className="collapse-btn" onClick={props.onToggle} title="收起">
          »
        </button>
      </div>
      <div className="history-list" ref={listRef}>
        {total === 0 && <div className="inspector-empty">暂无编辑记录</div>}
        {done.map((u, i) => (
          <button
            key={u.txId}
            className={'history-item' + (i === done.length - 1 ? ' current' : '')}
            onClick={() => clickUndoable(u)}
            title="撤回到此步之后的状态"
          >
            <span className="history-label">{u.label}</span>
            <span className="history-meta">
              {u.source === 'agent' ? 'Agent' : '人工'}
              {u.ops > 1 && ` · ${u.ops} 步`} · {fmtTime(u.time)}
            </span>
          </button>
        ))}
        {undone.map(u => (
          <button
            key={u.txId}
            className="history-item undone"
            onClick={() => clickRedoable(u)}
            title="重做到此步"
          >
            <span className="history-label">{u.label}</span>
            <span className="history-meta">已撤销 · 点击重做 · {fmtTime(u.time)}</span>
          </button>
        ))}
      </div>

      {pending && (
        <div className="modal-mask" onClick={() => setPending(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{pending.mode === 'undo' ? '撤回确认' : '重做确认'}</div>
            <div className="modal-text">
              {pending.mode === 'undo'
                ? `将撤销「${pending.label}」之后的 ${pending.steps} 步操作，场景回到该步完成时的状态。`
                : `将重做 ${pending.steps} 步操作，恢复到「${pending.label}」完成时的状态。`}
            </div>
            <div className="modal-actions">
              <button onClick={() => setPending(null)}>取消</button>
              <button className="primary" onClick={confirm}>
                {pending.mode === 'undo' ? '撤回' : '重做'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
