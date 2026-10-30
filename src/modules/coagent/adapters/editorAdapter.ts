/**
 * editorAdapter —— 真实 core 的 EditorReadPort + EditorWritePort 实现（W03）。
 *
 * 依赖规则（SPEC §2.2）：core 导入只允许出现在本文件（模块内唯一边界）。
 * - 读：useSceneStore 快照 → AssetDTO（rotation→rotationDeg、缺省 scale 归一 [1,1,1]、
 *   manifest→catalog、fingerprint 用 schemas 口径）；订阅 document 变化驱动
 *   plugin sceneRevision（§6.4）；bus 'scene:changed' 作废武装事务（core 切场景
 *   会清 openTx，若不作废，后续写入会静默开启新事务——危险）。
 * - 写：构建在 runtime/writeFacade 之上；core edit 的 boolean 返回 false 一律
 *   映射 write_failed（W00 §1.2：false 不得记成功）。
 */

import { edit, type TxHandle } from '../../../core/edit'
import { bus } from '../../../core/events'
import { saveScene } from '../../../core/io'
import { useSceneStore } from '../../../core/store'
import { describeModel } from '../../../core/modelCatalog'
import type { SceneAsset, SceneDocument } from '../../../core/types'
import type {
  AssetDTO,
  EditorCommand,
  EditorReadPort,
  EditorWritePort,
  ModelCatalogEntry,
  ObjectId,
  ReadScope,
  RunHistoryRef,
  SceneChange,
  SceneSnapshot,
  UndoEligibility,
} from '../contracts'
import {
  createEditorWriteFacade,
  fingerprintOf,
  type EditorWriteFacade,
  type PreparedWrite,
  type WriteTargetObject,
  type WriteTargetPrimitives,
} from '../runtime/writeFacade'
import { computeAssetFingerprint } from '../schemas'

export type EditorAdapter = EditorReadPort & EditorWritePort & { dispose(): void }

interface StoreAssetView {
  id: string
  ref: string
  name: string | null
  position: [number, number, number]
  rotationDeg: [number, number, number]
  scale: [number, number, number]
  visible: boolean
}

function toView(a: SceneAsset): StoreAssetView {
  const t = a.transform
  return {
    id: a.id,
    ref: a.ref,
    name: a.name ?? null,
    position: [...t.position] as [number, number, number],
    rotationDeg: [...t.rotation] as [number, number, number],
    scale: [...(t.scale ?? [1, 1, 1])] as [number, number, number],
    visible: a.visible !== false,
  }
}

function toTarget(v: StoreAssetView): WriteTargetObject {
  const o: WriteTargetObject = {
    id: v.id,
    ref: v.ref,
    name: v.name,
    transform: { position: v.position, rotationDeg: v.rotationDeg, scale: v.scale },
    visible: v.visible,
    fingerprint: '',
  }
  o.fingerprint = fingerprintOf(o)
  return o
}

function toCoreTransform(t: { position: [number, number, number]; rotationDeg: [number, number, number]; scale: [number, number, number] }) {
  return { position: t.position, rotation: t.rotationDeg, scale: t.scale }
}

export function createEditorAdapter(): EditorAdapter {
  let revision = 1
  /** P3：编辑器会话序号——同一 sceneId 重新加载后历史会被清空，事务 id 会重来 */
  let sessionSeq = 1
  const listeners = new Set<(change: SceneChange) => void>()

  const currentDoc = (): SceneDocument | null => useSceneStore.getState().document
  const viewMap = (): Map<ObjectId, StoreAssetView> => {
    const m = new Map<ObjectId, StoreAssetView>()
    for (const a of currentDoc()?.assets ?? []) m.set(a.id, toView(a))
    return m
  }

  // ---------- 读侧订阅：document/sceneId 引用变化 → revision 增长 + 通知 ----------

  const notify = (changed: ObjectId[] | null): void => {
    const sceneId = useSceneStore.getState().sceneId
    const change: SceneChange = {
      sceneRevision: revision,
      changedObjectIds: changed,
      ...(sceneId ? { sceneId } : {}),
    }
    for (const l of listeners) l(change)
  }

  const unsubStore = useSceneStore.subscribe(state => {
    // zustand 原始 subscribe：任何 set 都触发；只对 document/sceneId 引用变化起反应
    const prev = lastSeen
    if (state.document === prev.document && state.sceneId === prev.sceneId) return
    const changed: ObjectId[] | null = diffObjects(prev.fingerprints, state.document)
    lastSeen = { document: state.document, sceneId: state.sceneId, fingerprints: fingerprintMap(state.document) }
    revision++
    notify(changed)
  })
  let lastSeen = {
    document: useSceneStore.getState().document,
    sceneId: useSceneStore.getState().sceneId,
    fingerprints: fingerprintMap(useSceneStore.getState().document),
  }

  const unsubScene = bus.on('scene:changed', () => {
    writeFacade.invalidateAll('scene:changed')
    sessionSeq++ // core 切场景会清空 journal，旧的事务 id 不再可比
    revision++
    notify(null)
  })

  // ---------- 写侧：共享门面 + core 原子操作 ----------

  /**
   * P3：撤销资格判定。
   *
   * core 的历史是数组当栈，`undoTo(txId)` 的语义是"撤销该步之后的所有步"，
   * 没有"只撤销中间某个事务"的能力。所以只有**栈顶**才允许一键撤销；
   * 其后有用户编辑时必须拒绝，并告诉他有多少次。
   */
  const queryUndoImpl = (ref: RunHistoryRef): UndoEligibility => {
    if (useSceneStore.getState().sceneId !== ref.sceneId) {
      return { eligible: false, reason: '场景已切换，旧历史不可用', editsAfter: 0 }
    }
    if (ref.sceneSessionId !== String(sessionSeq)) {
      return { eligible: false, reason: '编辑器已重新加载，旧历史不可用', editsAfter: 0 }
    }
    const units = edit.historyUnits()
    const idx = units.findIndex(u => u.txId === ref.transactionId)
    if (idx < 0) return { eligible: false, reason: '该事务已不在编辑历史中（可能已被撤销）', editsAfter: 0 }
    const editsAfter = units.length - 1 - idx
    if (editsAfter > 0) {
      return { eligible: false, reason: `其后还有 ${editsAfter} 次编辑，只能从最新一步开始撤销`, editsAfter }
    }
    return { eligible: true, editsAfter: 0 }
  }

  const primitives: WriteTargetPrimitives = {
    getObject: id => {
      const doc = currentDoc()
      const a = doc?.assets.find(x => x.id === id)
      return a ? toTarget(toView(a)) : undefined
    },
    refExists: ref => Boolean(useSceneStore.getState().manifest?.models[ref]),
    mintId(ref) {
      const doc = currentDoc()
      const base = `${ref.split('/').pop() ?? 'asset'}-agent`
      let id = base
      let n = 0
      while (doc?.assets.some(a => a.id === id)) id = `${base}-${++n}`
      return id
    },
    beginTargetTx(label: string) {
      return edit.begin(label, 'agent')
    },
    executeWrite(tx, prepared: PreparedWrite) {
      const handle = tx as TxHandle
      const meta = { source: 'agent' as const, tx: handle }
      let ok: boolean
      if (prepared.kind === 'add') {
        const asset: SceneAsset = {
          id: prepared.objectId,
          ref: prepared.ref,
          ...(prepared.name !== null ? { name: prepared.name } : {}),
          transform: toCoreTransform(prepared.transform),
        }
        ok = edit.addAsset(asset, meta)
      } else if (prepared.kind === 'transform') {
        ok = edit.setTransform(prepared.objectId, toCoreTransform(prepared.transform), meta)
      } else {
        ok = edit.removeAsset(prepared.objectId, meta)
      }
      if (!ok) {
        // core boolean false（对象不存在/文档缺失/重复 id）不得记成功
        return {
          error: {
            code: 'write_failed',
            message: `core 拒绝了写入（${prepared.kind} ${prepared.objectId}）`,
            retryable: false,
          },
        }
      }
      const after = primitives.getObject(prepared.objectId)
      return { objectId: prepared.objectId, fingerprintAfter: after?.fingerprint ?? '' }
    },
    commitTargetTx(tx) {
      const handle = tx as TxHandle
      handle.commit()
      // core 的 commit() 对不匹配的 openTx 是静默 no-op，不能凭"调用没抛错"就宣称提交成功。
      // 用"该事务是否真的进了历史"来验证（有写入必然产生 journal entry）。
      return edit.historyUnits().some(u => u.txId === handle.id)
    },
    rollbackTargetTx(tx) {
      ;(tx as TxHandle).rollback()
      return true
    },
    transactionIdOf(tx) {
      return (tx as TxHandle).id
    },
  }

  const writeFacade: EditorWriteFacade = createEditorWriteFacade(primitives)

  return {
    snapshot(scope: ReadScope): SceneSnapshot {
      const views = [...viewMap().values()]
      const ids = scope.objectIds
      const filtered = ids ? views.filter(v => ids.includes(v.id)) : views
      const manifest = useSceneStore.getState().manifest
      const catalog: ModelCatalogEntry[] | null =
        scope.includeCatalog && manifest
          ? Object.entries(manifest.models).map(([ref, m]) => describeModel(ref, m))
          : null
      const assets: AssetDTO[] = filtered.map(v => {
        const target = toTarget(v)
        const meta = manifest?.models[v.ref]
        return {
          id: target.id,
          ref: target.ref,
          name: target.name,
          transform: { ...target.transform },
          visible: target.visible,
          catalog: meta ? describeModel(v.ref, meta) : null,
          fingerprint: target.fingerprint,
        }
      })
      return {
        sceneId: useSceneStore.getState().sceneId,
        sceneRevision: revision,
        assets,
        catalog,
      }
    },

    subscribe(listener: (change: SceneChange) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    beginRun: label => writeFacade.beginRun(label),
    commitRun: token => writeFacade.commitRun(token),
    rollbackRun: token => writeFacade.rollbackRun(token),
    endRun: token => writeFacade.endRun(token),
    applyAuthorized: (command: EditorCommand, ctx) => writeFacade.applyAuthorized(command, ctx),

    // ---- P3：撤销资格与撤销（只支持栈顶，符合 core 的历史模型） ----
    sceneSessionId: () => String(sessionSeq),
    queryUndo: (ref: RunHistoryRef): UndoEligibility => queryUndoImpl(ref),
    undoRun: (ref: RunHistoryRef): { ok: boolean; message?: string } => {
      const eligibility = queryUndoImpl(ref)
      if (!eligibility.eligible) return { ok: false, ...(eligibility.reason ? { message: eligibility.reason } : {}) }
      const before = edit.historyUnits().length
      const done = edit.undo()
      const after = edit.historyUnits().length
      // core 的 undo 是纯栈顶 pop：长度必须真的减少，否则不能声称撤销成功
      if (!done || after >= before) return { ok: false, message: '撤销未生效（编辑器拒绝或历史为空）' }
      return { ok: true }
    },

    save: () => saveScene(),

    dispose(): void {
      unsubStore()
      unsubScene()
      listeners.clear()
    },
  }
}

function fingerprintMap(doc: SceneDocument | null): Map<ObjectId, string> {
  const m = new Map<ObjectId, string>()
  for (const a of doc?.assets ?? []) {
    const v = toView(a)
    m.set(
      v.id,
      computeAssetFingerprint({
        ref: v.ref,
        transform: { position: v.position, rotationDeg: v.rotationDeg, scale: v.scale },
        visible: v.visible,
      }),
    )
  }
  return m
}

/** 变更对象集合：按 id 出现/消失/指纹差异 */
function diffObjects(prev: Map<ObjectId, string>, doc: SceneDocument | null): ObjectId[] | null {
  if (!doc) return null
  const next = fingerprintMap(doc)
  const changed = new Set<ObjectId>()
  for (const [id, fp] of next) {
    if (!prev.has(id) || prev.get(id) !== fp) changed.add(id)
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) changed.add(id)
  }
  return [...changed]
}
