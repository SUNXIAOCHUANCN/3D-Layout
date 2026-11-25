import { bus } from './events'
import { useSceneStore } from './store'
import type { SceneAsset, SceneLight, Transform } from './types'
import { queueWorkspace } from './persistence'
import type { Workspace } from './workspaceTypes'
import { assetHierarchy, followTransform, validHierarchy } from './assetHierarchy'
import { dataEqual } from './dataEqual'

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

type AssetEditCommand = 'set_transform' | 'add_asset' | 'remove_asset' | 'update_asset'
type LightEditCommand = 'add_light' | 'remove_light' | 'update_light'
export type EditCommand = AssetEditCommand | LightEditCommand

interface HistoryMetadata {
  source: EditSource
  txId: number
  label: string
  time: number
}

/** 撤销/重做写回对象的完整前态或后态。 */
export type HistoryEntry = HistoryMetadata & (
  | { cmd: AssetEditCommand; assetId: string; before: SceneAsset | null; after: SceneAsset | null }
  | { cmd: LightEditCommand; lightId: string; before: SceneLight | null; after: SceneLight | null }
)

type LightPatch = Partial<Pick<SceneLight, 'name' | 'position' | 'color' | 'intensity' | 'distance' | 'enabled'>> &
  { rotation?: Transform['rotation']; angle?: number }

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

export type AssetPatch = Partial<Pick<SceneAsset, 'name' | 'parentId' | 'visible' | 'locked' | 'ref' | 'shape' | 'materialOverride' | 'terrain'>>
export interface AssetChange { id: string; after: SceneAsset | null }

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
  const s = useSceneStore.getState()
  const doc = s.document
  if (!doc) return
  if ('lightId' in entry) {
    useSceneStore.setState({ document: { ...doc, lights: replaceObject(doc.lights ?? [], entry.lightId, entry[side]) } })
    if (entry[side] === null && s.selectedLightId === entry.lightId) s.select(null)
    return
  }
  useSceneStore.setState({ document: { ...doc, assets: replaceObject(doc.assets, entry.assetId, entry[side]) } })
}

function replaceObject<T extends { id: string }>(objects: T[], id: string, target: T | null): T[] {
  if (target === null) return objects.filter(object => object.id !== id)
  return objects.some(object => object.id === id)
    ? objects.map(object => object.id === id ? target : object)
    : [...objects, target]
}

function canWrite(meta?: EditMeta): boolean {
  return !useSceneStore.getState().loading && openTx?.handle === meta?.tx
}

function validLight(light: SceneLight): boolean {
  const vector = (value: number[]) => value.length === 3 && value.every(Number.isFinite)
  return light.id.length > 0 && vector(light.position) && /^#[0-9a-f]{6}$/i.test(light.color)
    && Number.isFinite(light.intensity) && light.intensity >= 0
    && Number.isFinite(light.distance) && light.distance >= 0
    && (light.type === 'point' || (light.type === 'spot' && vector(light.rotation)
      && Number.isFinite(light.angle) && light.angle > 0 && light.angle <= 90))
}

function recordLight(cmd: LightEditCommand, light: SceneLight, before: SceneLight | null, after: SceneLight | null, label: string, meta?: EditMeta): boolean {
  const source = meta?.source ?? 'human'
  record({ cmd, lightId: light.id, before, after, source, txId: meta?.tx?.id ?? ++txCounter, label, time: Date.now() })
  return true
}

function record(entry: HistoryEntry): void {
  redoStack = [] // 有新修改就清空重做栈
  if (openTx && openTx.handle.id === entry.txId) {
    openTx.unit.entries.push(entry)
  } else {
    journal.push({ txId: entry.txId, label: entry.label, source: entry.source, entries: [entry] })
  }
  applySide(entry, 'after')
  if (!openTx) bus.emit('edit:applied', {
    direction: 'commit', txId: entry.txId, label: entry.label, source: entry.source, entries: [entry],
  })
  if (!openTx) {
    bus.emit('history:changed', {})
    persist(entry.label)
  }
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
  /** Apply a complete, prevalidated scene change as one history step. */
  applyAssets(changes: readonly AssetChange[], label: string, meta?: EditMeta): boolean {
    if (!canWrite(meta)) return false
    const doc = useSceneStore.getState().document
    if (!doc) return false
    const assets = new Map(doc.assets.map(asset => [asset.id, asset]))
    const lightIds = new Set(doc.lights?.map(light => light.id))
    const seen = new Set<string>()
    const txId = meta?.tx?.id ?? txCounter + 1
    const source = meta?.source ?? 'human'
    const time = Date.now()
    const entries: HistoryEntry[] = []
    for (const { id, after } of changes) {
      if (!id || seen.has(id) || lightIds.has(id) || (after && (after.id !== id ||
        ![...after.transform.position, ...after.transform.rotation, ...(after.transform.scale ?? [])].every(Number.isFinite) ||
        after.transform.scale?.some(n => Math.abs(n) < 1e-9)))) return false
      seen.add(id)
      const before = assets.get(id) ?? null
      if (dataEqual(before, after)) continue
      if (after) assets.set(id, after)
      else assets.delete(id)
      let cmd: AssetEditCommand = before === null ? 'add_asset' : after === null ? 'remove_asset' : 'update_asset'
      if (before && after && before.transform !== after.transform) {
        const compare = { ...after, transform: before.transform }
        if (dataEqual(compare, before)) cmd = 'set_transform'
      }
      entries.push({ cmd, assetId: id, before, after, source, txId, label, time })
    }
    const next = [...assets.values()]
    if (!entries.length || !validHierarchy(next)) return false
    redoStack = []
    if (openTx) {
      for (const entry of entries) openTx.unit.entries.push(entry)
    } else {
      txCounter = txId
      journal.push({ entries, txId, label, source })
    }
    useSceneStore.setState({ document: { ...doc, assets: next } })
    if (!openTx) bus.emit('edit:applied', { direction: 'commit', txId, source, label, entries })
    if (!openTx) {
      bus.emit('history:changed', {})
      persist(label)
    }
    return true
  },

  updateAsset(assetId: string, patch: AssetPatch, meta?: EditMeta): boolean {
    if (!canWrite(meta)) return false
    const assets = useSceneStore.getState().document?.assets
    const cur = assets?.find(a => a.id === assetId)
    if (!cur) return false
    if (assets && (cur.parentId || cur.locked) && assetHierarchy(assets).locked(cur) && Object.keys(patch).some(key => key !== 'locked')) return false
    if (patch.parentId !== undefined || cur.parentId && 'parentId' in patch) {
      return edit.applyAssets([{ id: assetId, after: { ...cur, ...patch } }], `修改 ${cur.name ?? assetId}`, meta)
    }
    record({ cmd: 'update_asset', assetId, before: cur, after: { ...cur, ...patch }, source: meta?.source ?? 'human', txId: meta?.tx?.id ?? ++txCounter, label: `修改 ${cur.name ?? assetId}`, time: Date.now() })
    return true
  },
  setTransform(assetId: string, transform: Transform, meta?: EditMeta): boolean {
    if (!canWrite(meta)) return false
    const doc = useSceneStore.getState().document
    const cur = doc?.assets.find(a => a.id === assetId)
    if (!cur) return false
    if (doc && (cur.locked || cur.parentId) && assetHierarchy(doc.assets).locked(cur)) return false
    if (cur.group && doc) return edit.transformAssets([{ id: assetId, transform }], `变换 ${cur.name ?? assetId}`, meta)
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

  transformAssets(updates: readonly { id: string; transform: Transform }[], label: string, meta?: EditMeta): boolean {
    const doc = useSceneStore.getState().document
    if (!doc || !canWrite(meta)) return false
    const tree = assetHierarchy(doc.assets)
    const direct = new Set(updates.map(item => item.id))
    const changes: AssetChange[] = []
    for (const { id, transform } of updates) {
      const asset = tree.byId.get(id)
      if (!asset || tree.locked(asset) || tree.ancestors(asset).some(parent => direct.has(parent.id))) return false
      const descendants = tree.descendants(id)
      if (descendants.some(tree.locked)) return false
      changes.push({ id, after: { ...asset, transform } })
      for (const child of descendants) {
        changes.push({ id: child.id, after: { ...child, transform: followTransform(child.transform, asset.transform, transform) } })
      }
    }
    return edit.applyAssets(changes, label, meta)
  },

  addAsset(asset: SceneAsset, meta?: EditMeta): boolean {
    if (!canWrite(meta)) return false
    const doc = useSceneStore.getState().document
    if (!doc || doc.assets.some(a => a.id === asset.id) || doc.lights?.some(l => l.id === asset.id)) return false
    if (asset.parentId && !doc.assets.some(item => item.group && item.id === asset.parentId)) return false
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
    if (!canWrite(meta)) return false
    const doc = useSceneStore.getState().document
    const cur = doc?.assets.find(a => a.id === assetId)
    if (!cur) return false
    if (doc && (cur.locked || cur.parentId) && assetHierarchy(doc.assets).locked(cur)) return false
    if (cur.group && doc) {
      const changes: AssetChange[] = doc.assets.filter(asset => asset.parentId === assetId)
        .map(child => ({ id: child.id, after: { ...child, parentId: cur.parentId } }))
      if (!edit.applyAssets([...changes, { id: assetId, after: null }], `删除 ${cur.name ?? assetId}`, meta)) return false
      if (useSceneStore.getState().selectedAssetId === assetId) useSceneStore.getState().select(null)
      return true
    }
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

  addLight(light: SceneLight, meta?: EditMeta): boolean {
    if (!canWrite(meta) || !validLight(light)) return false
    const doc = useSceneStore.getState().document
    if (!doc || doc.lights?.some(l => l.id === light.id) || doc.assets.some(a => a.id === light.id)) return false
    return recordLight('add_light', light, null, light, `添加 ${light.name ?? light.id}`, meta)
  },

  updateLight(lightId: string, patch: LightPatch, meta?: EditMeta): boolean {
    if (!canWrite(meta)) return false
    const current = useSceneStore.getState().document?.lights?.find(light => light.id === lightId)
    if (!current) return false
    const { angle, rotation, ...properties } = patch
    const next: SceneLight = current.type === 'spot'
      ? { ...current, ...properties, angle: angle ?? current.angle, rotation: rotation ?? current.rotation }
      : { ...current, ...properties }
    if (!validLight(next) || dataEqual(current, next)) return false
    return recordLight('update_light', current, current, next, `修改 ${current.name ?? lightId}`, meta)
  },

  removeLight(lightId: string, meta?: EditMeta): boolean {
    if (!canWrite(meta)) return false
    const light = useSceneStore.getState().document?.lights?.find(light => light.id === lightId)
    if (!light) return false
    return recordLight('remove_light', light, light, null, `删除 ${light.name ?? lightId}`, meta)
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
          if ('lightId' in entry) {
            const key = `light:${entry.lightId}`
            const first = compact.get(key)
            compact.set(key, first && 'lightId' in first ? { ...entry, before: first.before } : entry)
          } else {
            const key = `asset:${entry.assetId}`
            const first = compact.get(key)
            compact.set(key, first && 'assetId' in first ? { ...entry, before: first.before } : entry)
          }
        }
        unit.entries = [...compact.values()].filter(e => !dataEqual(e.before, e.after))
        for (const entry of unit.entries) {
          if ('lightId' in entry) entry.cmd = entry.before === null ? 'add_light' : entry.after === null ? 'remove_light' : 'update_light'
          else entry.cmd = entry.before === null ? 'add_asset' : entry.after === null ? 'remove_asset'
            : entry.cmd === 'update_asset' ? 'update_asset' : 'set_transform'
        }
        if (unit.entries.length > 0) journal.push(unit)
        else redoStack = previousRedo
        openTx = null
        if (unit.entries.length) bus.emit('edit:applied', { ...unit, direction: 'commit' })
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

  get canBegin(): boolean {
    return !openTx && !useSceneStore.getState().loading
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
    bus.emit('edit:applied', { ...unit, direction: 'undo' })
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
    bus.emit('edit:applied', { ...unit, direction: 'redo' })
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
