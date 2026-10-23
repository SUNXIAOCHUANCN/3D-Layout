/**
 * FakeEditor —— EditorReadPort + EditorWritePort 的确定性假实现。
 *
 * W03 起写路径构建在 runtime/writeFacade（与真实 editorAdapter 同一份门面逻辑）之上，
 * 只注入内存版原子操作；事务语义（单 openTx、begin 顶替、惰性 begin、幂等、
 * 作用域/指纹校验）因此与真实 core 天然一致（SPEC §5.2）。
 * 期刊仅用于 rollback（mirror core applySide）；不模拟 redo 栈（core 的职责）。
 */

import type {
  AssetDTO,
  EditorReadPort,
  EditorWritePort,
  ModelCatalogEntry,
  ObjectId,
  ReadScope,
  SceneChange,
  SceneId,
  SceneSnapshot,
} from '../../contracts'
import {
  createEditorWriteFacade,
  fingerprintOf,
  type PreparedWrite,
  type WriteTargetObject,
  type WriteTargetPrimitives,
} from '../../runtime/writeFacade'

interface AssetRecord {
  id: ObjectId
  ref: string
  name: string | null
  transform: { position: [number, number, number]; rotationDeg: [number, number, number]; scale: [number, number, number] }
  visible: boolean
}

/** 期刊条目：rollback 时按 before 侧恢复（对齐 core 事务语义） */
interface JournalEntry {
  objectId: ObjectId
  before: AssetRecord | null
  after: AssetRecord | null
}

export interface FakeEditorOptions {
  sceneId?: SceneId
  assets?: Array<{
    id: string
    ref: string
    name?: string
    transform: AssetRecord['transform']
    visible?: boolean
  }>
  catalog?: ModelCatalogEntry[]
}

export interface FakeEditorState {
  sceneId: SceneId | null
  sceneRevision: number
  openTxLabel: string | null
  committedRuns: number
  rolledBackRuns: number
  orphanedTxLabels: string[]
  savedVersions: number[]
  assetCount: number
}

export interface FakeEditor extends EditorReadPort, EditorWritePort {
  state(): FakeEditorState
  /** 模拟用户/宿主切场景：作废武装事务、替换资产集（对齐 core 'scene:changed'） */
  simulateSceneSwitch(nextSceneId: SceneId, assets: FakeEditorOptions['assets']): void
  /** 最近一次 save() 落盘的资产深拷贝（断言最终场景用）；未保存过为 null */
  readonly lastSavedAssets: ReadonlyArray<Readonly<AssetRecord>> | null
}

export function createFakeEditor(opts: FakeEditorOptions = {}): FakeEditor {
  let sceneId: SceneId | null = opts.sceneId ?? 'fake-scene'
  let revision = 1
  const catalog = new Map<string, ModelCatalogEntry>((opts.catalog ?? []).map(c => [c.ref, c]))
  const assets = new Map<ObjectId, AssetRecord>()
  for (const a of opts.assets ?? []) {
    assets.set(a.id, { id: a.id, ref: a.ref, name: a.name ?? null, transform: { ...a.transform }, visible: a.visible !== false })
  }
  const listeners = new Set<(change: SceneChange) => void>()
  let savedVersions: number[] = []
  let lastSavedAssets: AssetRecord[] | null = null
  let savedVersion = 0

  const notify = (changedObjectIds: ObjectId[] | null): void => {
    const change: SceneChange = { sceneRevision: revision, changedObjectIds }
    for (const l of listeners) l(change)
  }
  const recordOf = (a: AssetRecord): AssetRecord => ({ ...a, transform: { ...a.transform } })
  const toTarget = (a: AssetRecord): WriteTargetObject => ({
    id: a.id,
    ref: a.ref,
    name: a.name,
    transform: a.transform,
    visible: a.visible,
    fingerprint: fingerprintOf(a as WriteTargetObject),
  })

  const primitives: WriteTargetPrimitives = {
    getObject: id => {
      const a = assets.get(id)
      return a ? toTarget(a) : undefined
    },
    refExists: ref => catalog.has(ref),
    mintId(ref) {
      const base = `${ref.split('/').pop() ?? 'asset'}-agent`
      let id = base
      let n = 0
      while (assets.has(id)) id = `${base}-${++n}`
      return id
    },
    beginTargetTx(label: string) {
      // fake 事务 = 期刊数组；label 保留便于诊断
      return { label, entries: [] as JournalEntry[] }
    },
    executeWrite(tx, prepared: PreparedWrite) {
      const journal = tx as { entries: JournalEntry[] }
      if (prepared.kind === 'add') {
        const after: AssetRecord = {
          id: prepared.objectId,
          ref: prepared.ref,
          name: prepared.name,
          transform: { ...prepared.transform },
          visible: true,
        }
        assets.set(after.id, after)
        journal.entries.push({ objectId: after.id, before: null, after: recordOf(after) })
        revision++
        notify([after.id])
        return { objectId: after.id, fingerprintAfter: toTarget(after).fingerprint }
      }
      const cur = assets.get(prepared.objectId)
      if (!cur) {
        return { error: { code: 'asset_not_found', message: `对象 ${prepared.objectId} 不存在`, retryable: false } }
      }
      if (prepared.kind === 'transform') {
        const after: AssetRecord = { ...cur, transform: { ...prepared.transform } }
        assets.set(after.id, after)
        journal.entries.push({ objectId: after.id, before: recordOf(cur), after: recordOf(after) })
        revision++
        notify([after.id])
        return { objectId: after.id, fingerprintAfter: toTarget(after).fingerprint }
      }
      assets.delete(prepared.objectId)
      journal.entries.push({ objectId: prepared.objectId, before: recordOf(cur), after: null })
      revision++
      notify([prepared.objectId])
      return { objectId: prepared.objectId, fingerprintAfter: '' }
    },
    commitTargetTx() {
      return true // fake 期刊不长期保留已提交单元（历史栈属 core 职责）
    },
    rollbackTargetTx(tx) {
      const journal = tx as { entries: JournalEntry[] }
      for (const e of [...journal.entries].reverse()) {
        if (e.before === null) assets.delete(e.objectId)
        else assets.set(e.objectId, recordOf(e.before))
      }
      revision++
      notify(null)
      return true
    },
  }

  const facade = createEditorWriteFacade(primitives)

  return {
    snapshot(scope: ReadScope): SceneSnapshot {
      const list = [...assets.values()]
      const ids = scope.objectIds
      const filtered = ids ? list.filter(a => ids.includes(a.id)) : list
      return {
        sceneId,
        sceneRevision: revision,
        assets: filtered.map(
          (a): AssetDTO => ({
            id: a.id,
            ref: a.ref,
            name: a.name,
            transform: { ...a.transform },
            visible: a.visible,
            catalog: catalog.get(a.ref) ?? null,
            fingerprint: toTarget(a).fingerprint,
          }),
        ),
        catalog: scope.includeCatalog ? [...catalog.values()] : null,
      }
    },

    subscribe(listener: (change: SceneChange) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    beginRun: label => facade.beginRun(label),
    commitRun: token => facade.commitRun(token),
    rollbackRun: token => facade.rollbackRun(token),
    endRun: token => facade.endRun(token),
    applyAuthorized: (command, ctx) => facade.applyAuthorized(command, ctx),

    async save(): Promise<{ mode: 'server' | 'download'; version: number }> {
      savedVersion++
      savedVersions = [...savedVersions, savedVersion]
      lastSavedAssets = [...assets.values()].map(recordOf)
      return { mode: 'server', version: savedVersion }
    },

    simulateSceneSwitch(nextSceneId: SceneId, next: FakeEditorOptions['assets']): void {
      sceneId = nextSceneId
      assets.clear()
      for (const a of next ?? []) {
        assets.set(a.id, { id: a.id, ref: a.ref, name: a.name ?? null, transform: { ...a.transform }, visible: a.visible !== false })
      }
      facade.invalidateAll('scene:changed（模拟）') // 对齐 core：切场景作废武装事务
      revision++
      notify(null)
    },

    state(): FakeEditorState {
      const fs = facade.state()
      return {
        sceneId,
        sceneRevision: revision,
        openTxLabel: fs.armedLabel,
        committedRuns: fs.committedRuns,
        rolledBackRuns: fs.rolledBackRuns,
        orphanedTxLabels: fs.orphanedTxLabels,
        savedVersions: [...savedVersions],
        assetCount: assets.size,
      }
    },

    get lastSavedAssets(): ReadonlyArray<Readonly<AssetRecord>> | null {
      return lastSavedAssets
    },
  }
}

export type { AssetRecord }
