import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bus } from '../events'
import { edit, restoreHistory } from '../edit'
import { useSceneStore } from '../store'
import { queueWorkspace } from '../persistence'
import { createAssetTreeSelector, createLightTreeSelector } from '../sceneStructure'
import { dataEqual } from '../dataEqual'
import type { SceneAsset, SceneDocument } from '../types'

vi.mock('../persistence', () => ({ queueWorkspace: vi.fn(), openWorkspace: vi.fn(), flushWorkspace: vi.fn() }))

const asset = (id: string): SceneAsset => ({ id, ref: 'builtin/box', transform: { position: [0, 0, 0], rotation: [0, 0, 0] } })
const document = (): SceneDocument => ({
  meta: { id: 'perf', name: 'Performance', unit: 'm', up: '+Y', version: 1 },
  assets: [asset('a'), asset('b')], cameras: [], environment: {},
})

beforeEach(() => {
  const doc = document()
  useSceneStore.setState({ document: doc, loading: false, selectedAssetId: null, selectedAssetIds: [], selectedLightId: null })
  restoreHistory({ document: doc, journal: [], redoStack: [], txCounter: 0 })
  vi.clearAllMocks()
})

describe('continuous editing', () => {
  it('publishes live transforms but refreshes history and saves only once at commit', () => {
    const changed = vi.fn()
    const off = bus.on('history:changed', changed)
    const before = useSceneStore.getState().document!
    try {
      const tx = edit.begin('drag')
      for (let i = 1; i <= 100; i++) {
        expect(edit.transformAssets([{ id: 'a', transform: { position: [i, 0, 0], rotation: [0, 0, 0] } }], 'drag', { tx })).toBe(true)
      }
      expect(useSceneStore.getState().document!.assets[0].transform.position[0]).toBe(100)
      expect(useSceneStore.getState().document!.assets[1]).toBe(before.assets[1])
      expect(changed).not.toHaveBeenCalled()
      expect(queueWorkspace).not.toHaveBeenCalled()
      tx.commit()
      expect(changed).toHaveBeenCalledTimes(1)
      expect(queueWorkspace).toHaveBeenCalledTimes(1)
      expect(edit.history()).toHaveLength(1)
      expect(edit.history()[0].before).toBe(before.assets[0])
      expect(edit.undo()).toBe(true)
      expect(useSceneStore.getState().document!.assets[0]).toBe(before.assets[0])
      expect(edit.redo()).toBe(true)
      expect(useSceneStore.getState().document!.assets[0].transform.position[0]).toBe(100)
    } finally { off() }
  })

  it('restores both the scene and previous redo branch on rollback', () => {
    edit.setTransform('a', { position: [5, 0, 0], rotation: [0, 0, 0] })
    edit.undo()
    vi.clearAllMocks()
    const tx = edit.begin('cancelled drag')
    edit.transformAssets([{ id: 'a', transform: { position: [12, 0, 0], rotation: [0, 0, 0] } }], 'drag', { tx })
    tx.rollback()
    expect(useSceneStore.getState().document!.assets[0].transform.position[0]).toBe(0)
    expect(queueWorkspace).not.toHaveBeenCalled()
    expect(edit.canRedo).toBe(true)
    edit.redo()
    expect(useSceneStore.getState().document!.assets[0].transform.position[0]).toBe(5)
  })

  it('does not save a drag that returns to its starting position', () => {
    const before = useSceneStore.getState().document!.assets[0]
    const tx = edit.begin('no-op drag')
    edit.setTransform('a', { position: [1, 0, 0], rotation: [0, 0, 0] }, { tx })
    edit.setTransform('a', before.transform, { tx })
    tx.commit()
    expect(edit.history()).toHaveLength(0)
    expect(queueWorkspace).not.toHaveBeenCalled()
  })
})

describe('tree subscriptions', () => {
  it('ignores light movement but responds to changes in the light list', () => {
    const select = createLightTreeSelector()
    const light = { id: 'light', type: 'point' as const, position: [0, 0, 0] as [number, number, number], color: '#ffffff', intensity: 1, distance: 0 }
    const rows = select([light])
    expect(select([{ ...light, position: [1, 0, 0] }])).toBe(rows)
    expect(select([{ ...light, name: 'renamed' }])).not.toBe(rows)
    expect(select([{ ...light, enabled: false }])[0].enabled).toBe(false)
    expect(select(undefined)).toEqual([])
  })
  it('keeps rows stable for transforms and updates names, hierarchy, visibility and terrain markers', () => {
    const select = createAssetTreeSelector()
    const assets = document().assets
    const rows = select(assets)
    const moved = [{ ...assets[0], transform: { ...assets[0].transform, position: [1, 0, 0] as [number, number, number] } }, assets[1]]
    expect(select(moved)).toBe(rows)
    for (const patch of [{ name: 'renamed' }, { parentId: 'group' }, { visible: false }, { locked: true }, { group: true }, { ref: 'other' },
      { terrain: { width: 1, depth: 1, samplesX: 2, samplesZ: 2, heights: [0, 0, 0, 0], seed: 0 } }]) {
      const next = select([{ ...moved[0], ...patch }, assets[1]])
      expect(next).not.toBe(rows)
      expect(next[1]).toBe(rows[1])
      select(moved)
    }
    expect(select([...moved].reverse())[0].id).toBe('b')
    expect(select([moved[0]])).toHaveLength(1)
    expect(select(undefined)).toEqual([])
  })
})

describe('scene data equality', () => {
  it('skips shared terrain arrays, including when optional properties are removed', () => {
    const heights = new Proxy([1, 2, 3], { get() { throw new Error('Shared arrays must not be traversed') } })
    expect(dataEqual({ terrain: { heights }, parentId: undefined }, { terrain: { heights } })).toBe(true)
    expect(dataEqual({ a: [0, 1] }, { a: [0, 2] })).toBe(false)
    expect(dataEqual({ a: null }, {})).toBe(false)
    expect(dataEqual({ a: [1] }, { a: { 0: 1 } })).toBe(false)
    expect(dataEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })
})
