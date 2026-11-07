import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Connect, ViteDevServer } from 'vite'
import { partitionAgentPlugin } from '../server'
import { cacheSession, loadSession, saveSession } from '../persistence'
import { emptySession, type Partition, type SceneSession } from '../types'
afterEach(() => vi.unstubAllGlobals())

/** 最小 localStorage 桩件：支持 key()/length，并按字符配额拒绝写入。 */
function memoryStorage(limit = Number.POSITIVE_INFINITY) {
  const data = new Map<string, string>()
  const used = () => [...data].reduce((total, entry) => total + entry[0].length + entry[1].length, 0)
  return {
    data,
    get length() { return data.size },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (prefix: string) => data.get(prefix) ?? null,
    removeItem: (prefix: string) => { data.delete(prefix) },
    clear: () => { data.clear() },
    setItem(prefix: string, value: string) {
      const previous = data.get(prefix)?.length ?? 0
      if (used() - previous + value.length > limit) throw new DOMException(`Setting the value of '${prefix}' exceeded the quota.`, 'QuotaExceededError')
      data.set(prefix, value)
    },
  }
}

const partition = (patch: Partial<Partition> = {}): Partition =>
  ({ regions: [], owners: {}, workflowId: 'builtin-llm-partition-v1', workflowRevision: 1, runId: 'r', createdAt: 'now', ...patch })

const image = (fill: string, size: number) => ({ dataUrl: `data:image/png;base64,${fill.repeat(size)}` })

const toolResults = (session: SceneSession) => {
  const turn = session.turns[0]
  if (turn.role !== 'toolResults') throw new Error('expected the first turn to be toolResults')
  return turn.results
}

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'partition-agent-test-'))
  await mkdir(join(root, 'scenes', 'test'), { recursive: true })
  await writeFile(join(root, 'scenes', 'test', 'scene.json'), '{}')
  const plugin = partitionAgentPlugin(root)
  let middleware!: Connect.NextHandleFunction
  const configure = plugin.configureServer
  if (typeof configure !== 'function') throw new Error('Missing middleware hook')
  configure.call({} as never, { middlewares: { use(fn: Connect.NextHandleFunction) { middleware = fn } } } as unknown as ViteDevServer)
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => nativeFetch(url.startsWith('/') ? base + url : url, init))
  return { root, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) }
}

it('persists conversation to a scene sidecar and restores it with browser storage cleared', async () => {
  const { root, close } = await startServer()
  const storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  try {
    const s = emptySession('test'); s.chat.push({ role: 'user', text: '保留场景设计要求' }); s.turns.push({ role: 'user', text: '保留场景设计要求' })
    cacheSession(s); await saveSession(s)
    expect(storage.data.has('partition-agent:test')).toBe(true)
    storage.clear()
    const restored = await loadSession('test')
    expect(restored.chat).toEqual(s.chat); expect(restored.sessionId).toBe(s.sessionId)
    const disk = JSON.parse(await readFile(join(root, 'scenes', 'test', 'partition-agent', 'session.json'), 'utf8'))
    expect(disk.turns).toEqual(s.turns)
    const rejected = await fetch('/api/partition-agent/scenes/test', { method: 'PUT', body: JSON.stringify({ ...s, sceneId: 'other' }) })
    expect(rejected.ok).toBe(false)
    expect((await loadSession('test')).sceneId).toBe('test')
    expect((await loadSession('missing')).chat).toEqual([])
  } finally { await close() }
})

it('keeps screenshots and oversized previews out of the browser mirror', () => {
  const storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  const s = emptySession('test')
  s.partition = partition({ preview: image('B', 400_000).dataUrl, rawPreview: image('C', 400_000).dataUrl })
  s.turns = [
    { role: 'toolResults', results: [{ callId: 'c1', ok: true, content: { width: 1400, height: 900 }, images: [image('A', 400_000)] }] },
    { role: 'assistant', text: '', toolCalls: [] },
  ]
  expect(cacheSession(s)).toEqual({ ok: true })
  const raw = storage.data.get('partition-agent:test')!
  expect(raw.length).toBeLessThan(20_000)
  const cached = JSON.parse(raw) as SceneSession
  expect(toolResults(cached)[0].images).toBeUndefined()
  expect(toolResults(cached)[0].content).toMatchObject({ width: 1400, note: expect.stringContaining('未写入浏览器缓存') })
  expect(cached.partition!.preview).toBeUndefined()
  expect(cached.partition!.rawPreview).toBeUndefined()
  // 内存里的完整会话不受影响，磁盘仍会写入原图。
  expect(toolResults(s)[0].images).toHaveLength(1)
  expect(s.partition!.preview).toBeTruthy()
})

it('releases stale mirrors and retries smaller ones when the quota is exhausted', () => {
  const storage = memoryStorage(130_000)
  vi.stubGlobal('localStorage', storage)
  const s = emptySession('test')
  s.partition = partition({ preview: image('C', 140_000).dataUrl })
  // 模拟浏览器已被旧镜像与其他场景缓存占满（直接塞进 Map，绕过配额检查）。
  storage.data.set('partition-agent:test', 'x'.repeat(1_000))
  storage.data.set('partition-agent:other', 'y'.repeat(100_000))
  expect(cacheSession(s)).toEqual({ ok: true })
  expect(storage.data.has('partition-agent:other')).toBe(false)
  // 腾地方后仍放不下预览图，因此降级成不含预览的最小镜像。
  const cached = JSON.parse(storage.data.get('partition-agent:test')!) as SceneSession
  expect(cached.partition!.preview).toBeUndefined()
  expect(storage.data.get('partition-agent:test')!.length).toBeLessThan(130_000)
  expect(cacheSession(s).ok).toBe(true)
})

it('reports a reason instead of throwing when every fallback still exceeds the quota', () => {
  const storage = memoryStorage(100)
  vi.stubGlobal('localStorage', storage)
  const s = emptySession('test')
  s.chat.push({ role: 'user', text: '很长的需求'.repeat(100) })
  const result = cacheSession(s)
  expect(result.ok).toBe(false)
  expect(result.reason).toContain('quota')
  expect(storage.data.has('partition-agent:test')).toBe(false)
})

it('rewrites a legacy screenshot-laden mirror when the scene loads', async () => {
  const { close } = await startServer()
  const storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  try {
    const s = emptySession('test')
    s.turns = [{ role: 'toolResults', results: [{ callId: 'c', ok: true, content: { screenshotId: 'x' }, images: [image('A', 500_000)] }] }]
    s.updatedAt = Date.now() + 1_000 // 比磁盘新，恢复时选中缓存
    storage.data.set('partition-agent:test', JSON.stringify(s))
    await loadSession('test')
    const cached = JSON.parse(storage.data.get('partition-agent:test')!) as SceneSession
    expect(toolResults(cached)[0].images).toBeUndefined()
    expect(storage.data.get('partition-agent:test')!.length).toBeLessThan(20_000)
  } finally { await close() }
})
