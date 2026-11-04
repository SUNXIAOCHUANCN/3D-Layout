import { create } from 'zustand'
import type { Workspace, WorkspaceResponse } from './workspaceTypes'

type SaveStatus = 'loading' | 'saved' | 'saving' | 'offline' | 'conflict' | 'error'
export const usePersistence = create<{ status: SaveStatus; message: string }>(() => ({ status: 'loading', message: '' }))
const status = (value: SaveStatus, message = '') => usePersistence.setState({ status: value, message })

interface Pending {
  requestId: string
  clientId: string
  sceneId: string
  baseRevision: number
  workspace: Workspace
  label: string
}

let database: Promise<IDBDatabase> | undefined
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('3d-layout-workspaces', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'requestId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function pending<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await db()
  return new Promise((resolve, reject) => {
    const tx = database.transaction('pending', mode)
    const request = operation(tx.objectStore('pending'))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('本地队列写入失败'))
  })
}

function clientId(): string {
  let id = sessionStorage.getItem('layout-client-id')
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('layout-client-id', id) }
  return id
}

let activeScene = ''
let revision = 0
const staged: Pending[] = []
let localWrites: Promise<void> = Promise.resolve()
let sending: Promise<void> | null = null

function persistStaged(): Promise<void> {
  localWrites = localWrites.catch(() => {}).then(async () => {
    while (staged.length) {
      await pending('readwrite', store => store.put(staged[0]))
      staged.shift()
    }
  })
  return localWrites
}

async function jobs(scene = activeScene): Promise<Pending[]> {
  const all = await pending<Pending[]>('readonly', store => store.getAll())
  return all.filter(item => item.clientId === clientId() && item.sceneId === scene).sort((a, b) => a.baseRevision - b.baseRevision)
}

export async function openWorkspace(id: string): Promise<Workspace> {
  if (activeScene) await flushWorkspace()
  status('loading')
  const response = await fetch(`/api/workspaces/${encodeURIComponent(id)}`, { cache: 'no-store' }).catch(error => {
    status('offline', '工作区读取失败，请确认后端已启动后重新加载')
    throw error
  })
  if (!response.ok) {
    const message = `工作区读取失败（HTTP ${response.status}），请确认后端已启动`
    status('error', message)
    throw new Error(message)
  }
  const remote: WorkspaceResponse = await response.json()
  const queued = await jobs(id)
  activeScene = id
  revision = queued.length ? queued[queued.length - 1].baseRevision + 1 : remote.revision
  status(queued.length ? 'saving' : 'saved', remote.projectionError ?? '')
  // A retry uses the same requestId, including when the previous response was lost.
  if (queued.length) void flushWorkspace().catch(() => {})
  return queued.length ? queued[queued.length - 1].workspace : remote.workspace
}

/** Called only at completed edit boundaries, never during a drag/agent transaction. */
export function queueWorkspace(workspace: Workspace, label: string): void {
  if (!activeScene) return
  const item: Pending = {
    requestId: crypto.randomUUID(), clientId: clientId(), sceneId: activeScene,
    baseRevision: revision++, workspace: structuredClone(workspace), label,
  }
  status('saving')
  staged.push(item)
  void persistStaged().then(() => flushWorkspace()).catch(error => {
    if (usePersistence.getState().status === 'saving') status('error', String(error))
  })
}

export async function flushWorkspace(expectedScene?: string): Promise<void> {
  if (expectedScene && activeScene !== expectedScene) throw new Error('场景尚未连接持久化后端')
  if (!activeScene) return
  await persistStaged()
  if (sending) { await sending; if (staged.length || (await jobs()).length) return flushWorkspace(); return }
  sending = (async () => {
    for (;;) {
      await persistStaged()
      const [item] = await jobs()
      if (!item) { status('saved', usePersistence.getState().message); return }
      let response: Response
      try {
        response = await fetch(`/api/workspaces/${encodeURIComponent(item.sceneId)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Layout-Client': '1' },
          body: JSON.stringify(item),
        })
      } catch { status('offline', '连接失败，待提交记录保留在本机；恢复连接后重试'); throw new Error('后端连接失败') }
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
        status(response.status === 409 ? 'conflict' : 'error', body.error)
        throw new Error(body.error)
      }
      const result: { projectionError: string | null } = await response.json()
      await pending('readwrite', store => store.delete(item.requestId))
      status('saving', result.projectionError ?? '')
    }
  })()
  try { await sending } finally { sending = null }
}

export async function discardPending(): Promise<void> {
  await localWrites.catch(() => {})
  if (sending) await sending.catch(() => {})
  staged.length = 0
  for (const item of await jobs()) await pending('readwrite', store => store.delete(item.requestId))
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (activeScene) void flushWorkspace().catch(() => {}) })
  window.addEventListener('beforeunload', event => {
    if (usePersistence.getState().status !== 'saved') { event.preventDefault(); event.returnValue = '' }
  })
}
