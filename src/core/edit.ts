import { bus } from './events'
import { useSceneStore } from './store'
import type { SceneAsset, Transform } from './types'
import { queueWorkspace } from './persistence'
import type { Workspace } from './workspaceTypes'

/**
 * edit —— 引擎中唯一的场景变更入口（架构定案：编辑接口 + 历史记录 + 撤销回滚一体化）。
 *
 * - 每次修改必留痕：命令期刊记 {before, after, source, txId}，undo/redo = 写回对应一侧；
 *   不用全量快照，语义信息（谁改的、改了什么、属于哪个事务）直接喂给历史面板与审计。
 * - 事务（begin/commit/rollback）把连续修改变成一条可撤销记录：
 *   人工拖 gizmo 一个事务，Agent 一项任务一个事务。
 * - 红线：本文件不感知 mouse/gizmo/LLM/WS —— 只认识"谁(source)要把什么从 X 改成 Y"。
 * - selection / 相机等观察状态不进历史；删除资产时顺带清掉选中，属于一致性整理，不留痕。
 */

export type EditSource = 'human' | 'agent'

export type EditCommand = 'set_transform' | 'add_asset' | 'remove_asset' | 'update_asset'

/** 期刊条目：before/after 携带完整的资产对象，撤销/重做就是写回对应侧 */
export interface HistoryEntry {
  cmd: EditCommand
  assetId: string
  before: SceneAsset | null // add 时为 null
  after: SceneAsset | null // remove 时为 null
  source: EditSource
  txId: number
  label: string
  time: number
}

interface Unit {
  txId: number
  label: string
  source: EditSource
  entries: HistoryEntry[]
}

export interface TxHandle {
  readonly id: number
  /** 提交：事务内修改合并为一条可撤销记录 */
  commit(): void
  /** 回滚：立即撤销本事务全部修改，且不进入重做栈 */
  rollback(): void
}

export interface EditMeta {
  source?: EditSource
  /** 拖拽等连续修改传入事务句柄，合并为一条历史 */
  tx?: TxHandle
}

/** 历史面板的步骤视图 */
export interface HistoryUnitView {
  txId: number
  label: string
  source: EditSource
  time: number
  /** 事务内包含的原子操作数（如一次拖拽的多帧写入） */
  ops: number
}

let journal: Unit[] = []
let redoStack: Unit[] = []
let txCounter = 0
let openTx: { handle: TxHandle; unit: Unit } | null = null

function toUnitView(u: Unit): HistoryUnitView {
  return {
    txId: u.txId,
    label: u.label,
    source: u.source,
    time: u.entries[0]?.time ?? 0,
    ops: u.entries.length,
  }
}

/** 应用某条目的某一侧（undo=before / redo=after）。直接改文档，不记历史。 */
function applySide(entry: HistoryEntry, side: 'before' | 'after'): void {
  const target = side === 'before' ? entry.before : entry.after
  const s = useSceneStore.getState()
  const doc = s.document
  if (!doc) return
  let assets: SceneAsset[]
  if (target === null) {
    assets = doc.assets.filter(a => a.id !== entry.assetId)
  } else {
    const exists = doc.assets.some(a => a.id === entry.assetId)
    assets = exists
      ? doc.assets.map(a => (a.id === entry.assetId ? target : a))
      : [...doc.assets, target]
  }
  useSceneStore.setState({ document: { ...doc, assets } })
}

function record(entry: HistoryEntry): void {
  redoStack = [] // 有新修改就清空重做栈
  if (openTx && openTx.handle.id === entry.txId) {
    openTx.unit.entries.push(entry)
  } else {
    journal.push({ txId: entry.txId, label: entry.label, source: entry.source, entries: [entry] })
  }
  applySide(entry, 'after')
  bus.emit('history:changed', {})
  if (!openTx) persist(entry.label)
}

function persist(label: string): void {
  const document = useSceneStore.getState().document
  if (document) queueWorkspace({ document, journal, redoStack, txCounter }, label)
}

export function restoreHistory(workspace: Workspace): void {
  journal = workspace.journal
  redoStack = workspace.redoStack
  txCounter = workspace.txCounter
  openTx = null
  bus.emit('history:changed', {})
}

export function exportWorkspace(): Workspace | null {
  const document = useSceneStore.getState().document
  return document ? structuredClone({ document, journal, redoStack, txCounter }) : null
}

export const edit = {
  updateAsset(assetId: string, patch: Partial<Pick<SceneAsset, 'materialOverride' | 'terrain'>>, meta?: EditMeta): boolean {
    const cur = useSceneStore.getState().document?.assets.find(a => a.id === assetId)
    if (!cur) return false
    record({ cmd: 'update_asset', assetId, before: cur, after: { ...cur, ...patch }, source: meta?.source ?? 'human', txId: meta?.tx?.id ?? ++txCounter, label: `修改 ${cur.name ?? assetId}`, time: Date.now() })
    return true
  },
  setTransform(assetId: string, transform: Transform, meta?: EditMeta): boolean {
    if (useSceneStore.getState().loading) return false
    const doc = useSceneStore.getState().document
    const cur = doc?.assets.find(a => a.id === assetId)
    if (!cur) return false
    record({
      cmd: 'set_transform',
      assetId,
      before: cur,
      after: { ...cur, transform },
      source: meta?.source ?? 'human',
      txId: meta?.tx?.id ?? ++txCounter,
      label: `变换 ${cur.name ?? assetId}`,
      time: Date.now(),
    })
    return true
  },

  addAsset(asset: SceneAsset, meta?: EditMeta): boolean {
    if (useSceneStore.getState().loading) return false
    const doc = useSceneStore.getState().document
    if (!doc || doc.assets.some(a => a.id === asset.id)) return false
    record({
      cmd: 'add_asset',
      assetId: asset.id,
      before: null,
      after: asset,
      source: meta?.source ?? 'human',
      txId: meta?.tx?.id ?? ++txCounter,
      label: `添加 ${asset.name ?? asset.id}`,
      time: Date.now(),
    })
    return true
  },

  removeAsset(assetId: string, meta?: EditMeta): boolean {
    if (useSceneStore.getState().loading) return false
    const doc = useSceneStore.getState().document
    const cur = doc?.assets.find(a => a.id === assetId)
    if (!cur) return false
    record({
      cmd: 'remove_asset',
      assetId,
      before: cur,
      after: null,
      source: meta?.source ?? 'human',
      txId: meta?.tx?.id ?? ++txCounter,
      label: `删除 ${cur.name ?? assetId}`,
      time: Date.now(),
    })
    if (useSceneStore.getState().selectedAssetId === assetId) {
      useSceneStore.getState().select(null)
    }
    return true
  },

  /** 开启事务：事务内的所有修改合并为一条可撤销记录 */
  begin(label: string, source: EditSource = 'human'): TxHandle {
    if (useSceneStore.getState().loading) throw new Error('正在切换场景')
    if (openTx) throw new Error('已有未完成的编辑事务')
    const previousRedo = redoStack
    const id = ++txCounter
    const unit: Unit = { txId: id, label, source, entries: [] }
    const handle: TxHandle = {
      id,
      commit() {
        if (openTx?.handle.id !== id) return
        const compact = new Map<string, HistoryEntry>()
        for (const entry of unit.entries) {
          const first = compact.get(entry.assetId)
          compact.set(entry.assetId, first ? { ...entry, before: first.before } : entry)
        }
        unit.entries = [...compact.values()].filter(e => JSON.stringify(e.before) !== JSON.stringify(e.after))
        for (const entry of unit.entries) entry.cmd = entry.before === null ? 'add_asset' : entry.after === null ? 'remove_asset' : 'set_transform'
        if (unit.entries.length > 0) journal.push(unit)
        else redoStack = previousRedo
        openTx = null
        bus.emit('history:changed', {})
        if (unit.entries.length) persist(label)
      },
      rollback() {
        if (openTx?.handle.id !== id) return
        for (const e of [...unit.entries].reverse()) applySide(e, 'before')
        openTx = null
        redoStack = previousRedo
        bus.emit('history:changed', {})
      },
    }
    openTx = { handle, unit }
    return handle
  },

  get canUndo(): boolean {
    return journal.length > 0
  },

  get canRedo(): boolean {
    return redoStack.length > 0
  },

  undo(): boolean {
    if (openTx || useSceneStore.getState().loading) return false
    const unit = journal.pop()
    if (!unit) return false
    for (const e of [...unit.entries].reverse()) applySide(e, 'before')
    redoStack.push(unit)
    bus.emit('history:changed', {})
    persist(`撤销 ${unit.label}`)
    return true
  },

  redo(): boolean {
    if (openTx || useSceneStore.getState().loading) return false
    const unit = redoStack.pop()
    if (!unit) return false
    for (const e of unit.entries) applySide(e, 'after')
    journal.push(unit)
    bus.emit('history:changed', {})
    persist(`重做 ${unit.label}`)
    return true
  },

  /** 供历史面板/审计展示：时间正序的操作谱系（人与 Agent 同一本账） */
  history(): HistoryEntry[] {
    return journal.flatMap(u => u.entries)
  },

  /** 历史面板视图：一条 = 一个事务（拖拽一次/一次输入/Agent 一项任务） */
  historyUnits(): HistoryUnitView[] {
    return journal.map(toUnitView)
  },

  /** 已撤销、可重做的步骤（时间正序，供历史面板灰色显示） */
  redoUnits(): HistoryUnitView[] {
    return redoStack.map(toUnitView)
  },

  /** 撤回到指定步骤：保留该步，撤销其后所有步骤；返回撤销的步数 */
  undoTo(txId: number): number {
    let n = 0
    while (journal.length > 0 && journal[journal.length - 1].txId !== txId) {
      if (!edit.undo()) break
      n++
    }
    return n
  },

  /** 重做到指定步骤（含）：返回重做的步数 */
  redoTo(txId: number): number {
    let n = 0
    while (redoStack.length > 0) {
      edit.redo()
      n++
      if (journal.length > 0 && journal[journal.length - 1].txId === txId) break
    }
    return n
  },
}

// 先清理旧场景历史；store 随后通过 restoreHistory 恢复新工作区。
bus.on('scene:changed', () => {
  journal = []
  redoStack = []
  openTx = null
})
