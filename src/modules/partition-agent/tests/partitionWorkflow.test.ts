import { expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { convertBoundaries, ownerAt, type BoundaryMap } from '../geometry'
import { processBoundaries } from '../processServer'
import { DEFAULT_PARTITION_CONFIG, PARTITION_PRESET, runPartitionWorkflow, partitionConfig, type WorkflowDependencies } from '../partitionWorkflow'
import { GLOBAL } from '../types'
import type { LlmChatOptions, LlmChatResult } from '../llmClient'
import image from './birdseye-fixture.txt?raw'
vi.mock('../llmSettings', () => ({ getActiveSettings: () => ({ provider: 'test', protocol: 'openai-chat', baseURL: 'https://test', apiKey: 'test', model: 'test', sendImages: true }), isLlmConfigured: () => true }))
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const map: BoundaryMap = { schema_version: 1, source: { artifact_id: 'screenshot', width: 1200, height: 900 }, canvas: { width: 100, height: 100 }, vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 0 }], boundaries: [
  { id: 'bottom', start: 'b', end: 'a', points: [[100, 100], [0, 100]] }, { id: 'top', start: 'a', end: 'b', points: [] },
], regions: [{ id: 'r', name: '区域', design: '设计', boundary_ids: ['bottom', 'top'] }] }
const draw = { action: 'draw', note: '沿场景外围绘制', drawing: { vertices: [{ id: 'a', x: 0, y: 0 }], boundaries: [{ id: 'outer', start: 'a', end: 'a', points: [[1000, 0], [1000, 750], [0, 750]] }], regions: [{ id: 'r', name: '测试区', design: '保持核心完整', boundary_ids: ['outer'] }] } }
const response = (command: unknown): LlmChatResult => ({ stopReason: 'end', text: JSON.stringify(command), toolCalls: [] })
const processLocal: WorkflowDependencies['process'] = async <T>(request: Record<string, unknown>, signal: AbortSignal) => await processBoundaries(root, request, signal) as T
it('bundles the actual saved workflow prompt and its 16-round 3600-second configuration', () => {
  expect(PARTITION_PRESET.name).toBe('LLM分区')
  expect(DEFAULT_PARTITION_CONFIG.max_rounds).toBe(16)
  expect(DEFAULT_PARTITION_CONFIG.max_duration_seconds).toBe(3600)
  expect(DEFAULT_PARTITION_CONFIG.prompt_text).toContain('地图的所有部分都要在某个区域内')
  expect(DEFAULT_PARTITION_CONFIG.prompt_text).toContain('每个区域要尽可能包括该区域的所有物体')
  expect(() => partitionConfig({ max_rounds: 0 })).toThrow('无效')
})
it('reconstructs reversed, unordered shared edges in the exact birdseye coordinate frame', () => {
  const regions = convertBoundaries(map, [-10, -20, 10, 20])
  expect(regions[0].polygon).toEqual([[10, -20], [10, 20], [-10, 20], [-10, -20]])
  expect(ownerAt(regions, [0, 0, 0])).toBe('r')
  expect(ownerAt(regions, [11, 0, 0])).toBe(GLOBAL)
  expect(() => convertBoundaries({ ...map, regions: [{ ...map.regions[0], boundary_ids: ['top'] }] }, [-10, -20, 10, 20])).toThrow('闭合')
})
it('runs the migrated draw-review-refine pipeline using only bundled processing and a mocked model', async () => {
  const fetch = vi.fn(() => { throw new Error('No external service should be contacted') }); vi.stubGlobal('fetch', fetch)
  const requests: LlmChatOptions[] = []
  const chat = vi.fn(async (options: LlmChatOptions) => {
    requests.push(structuredClone({ ...options, signal: undefined, onEvent: undefined }) as unknown as LlmChatOptions)
    return response(requests.length === 1 ? draw : { action: 'finish', note: '查看渲染结果后确认' })
  })
  try {
    const result = await runPartitionWorkflow(image.trim(), [-10, -20, 10, 20], new AbortController().signal, () => {}, undefined, { process: processLocal, chat })
    expect(result.stopReason).toBe('model_finished')
    expect(result.regions[0].name).toBe('测试区')
    expect(result.preview).toMatch(/^data:image\/png;base64,/)
    expect(result.rawPreview).toMatch(/^data:image\/png;base64,/)
    expect(result.refinementReport?.algorithm).toBe('generic-dp-v1')
    expect(result.drawingHistory?.map(h => h.status)).toEqual(['drawn', 'reviewed'])
    expect(requests[0].turns[0]).toMatchObject({ text: expect.stringContaining(DEFAULT_PARTITION_CONFIG.prompt_text), images: [{ dataUrl: expect.stringMatching(/^data:image\/png;base64,/) }] })
    expect(requests[1].turns[0]).toMatchObject({ text: expect.stringContaining('当前绘图数据：') })
    expect(fetch).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
}, 30000)
it('feeds rejected drawing back to the model and preserves the last valid geometry', async () => {
  const commands = [{ action: 'finish' }, draw, { action: 'draw', operations: [{ op: 'delete_vertex', id: 'a' }] }, { action: 'finish', note: '已检查' }]
  const chat = vi.fn(async () => response(commands.shift()))
  const result = await runPartitionWorkflow(image.trim(), [-10, -20, 10, 20], new AbortController().signal, () => {}, { max_rounds: 4 }, { process: processLocal, chat })
  expect(result.drawingHistory?.map(h => h.status)).toEqual(['rejected', 'drawn', 'rejected', 'reviewed'])
  expect(result.boundaryMap?.vertices).toHaveLength(1)
}, 30000)
it('reports a round limit without claiming model confirmation', async () => {
  const result = await runPartitionWorkflow(image.trim(), [-10, -20, 10, 20], new AbortController().signal, () => {}, { max_rounds: 1 }, { process: processLocal, chat: async () => response(draw) })
  expect(result.stopReason).toBe('max_rounds')
  expect(result.regions).toHaveLength(1)
}, 30000)
it('stops on model network failures without automatic resubmission', async () => {
  const chat = vi.fn().mockRejectedValue(new Error('Unknown remote outcome'))
  await expect(runPartitionWorkflow(image.trim(), [-10, -20, 10, 20], new AbortController().signal, () => {}, undefined, { process: processLocal, chat })).rejects.toThrow('Unknown remote outcome')
  expect(chat).toHaveBeenCalledTimes(1)
}, 30000)
it('aborts local processing before launch when cancelled', async () => {
  const ac = new AbortController(); ac.abort()
  await expect(processBoundaries(root, { action: 'health' }, ac.signal)).rejects.toThrow()
})
