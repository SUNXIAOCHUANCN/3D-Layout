/**
 * runLog（诊断日志）单测：只验"日志内容与落盘契约"，不测业务。
 *
 * 关键契约：
 * - 文件名必须是 vite 端点接受的形状（^[A-Za-z0-9][A-Za-z0-9._-]*\.md$）；
 * - 每个模型请求/回包、每个工具调用都出现在同一份 markdown 里；
 * - 图片只记尺寸不记 dataURL（日志不能带几十 MB 的 base64）；
 * - finishRunLog 之后模块级句柄必须被清掉（下一轮重新开始）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelReply, ModelRequest } from '../../contracts'
import {
  activeRunLog,
  beginRunLog,
  eventsTable,
  finishRunLog,
  logStage,
  logWarn,
  runLogFilename,
} from '../../runtime/runLog'

const posted: Array<{ filename: string; content: string }> = []

function stubBrowser(): void {
  vi.stubGlobal('window', {})
  vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
    posted.push(JSON.parse(String(init?.body)) as { filename: string; content: string })
    return { ok: true, status: 200 } as Response
  })
}

const request: ModelRequest = {
  purpose: 'planner',
  system: '你是规划器',
  messages: [{ role: 'user', text: '把北边林地拉稀疏' }],
  tools: [{ name: 'scene.get_objects', description: '读对象', schema: { type: 'object' } }],
  timeoutMs: 1_000,
}

const reply: ModelReply = {
  stopReason: 'tool_use',
  text: '我先看一眼对象',
  toolCalls: [{ id: 'c1', name: 'scene.get_objects', args: { objectIds: ['a'] } }],
}

describe('runLog', () => {
  beforeEach(() => {
    posted.length = 0
    stubBrowser()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('文件名符合落盘端点规约（只能落在 logs/coAgent）', () => {
    const runName = runLogFilename({ kind: 'run', runId: 'run-abc_1', request: 'x' })
    const preName = runLogFilename({ kind: 'preprocess', runId: 'preprocess', request: 'x' })
    for (const name of [runName, preName]) {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/)
      expect(name).not.toContain('..')
      expect(name).not.toContain('/')
    }
    expect(runName).toContain('run-abc_1')
    expect(preName.startsWith('coagent-preprocess-')).toBe(true)
  })

  it('模型请求/回包、工具调用、阶段都写进同一份 markdown', async () => {
    beginRunLog({ kind: 'run', runId: 'run-test-1', request: '把北边林地拉稀疏', model: 'openai / m @ host' })
    const log = activeRunLog()
    expect(log).not.toBeNull()
    logStage('node.planner', '规划器开始', '候选对象 3 个')
    logWarn('planner.schema', '计划不合格', '- tasks[0].id 缺失')
    log?.modelRequest(request)
    log?.modelReply(request, reply, 120, 10)
    log?.toolCall(reply.toolCalls[0], { ok: true, data: { objects: [] } }, 8)

    const md = log?.markdown() ?? ''
    expect(md).toContain('# CoAgent 运行日志（布局运行）')
    expect(md).toContain('把北边林地拉稀疏')
    expect(md).toContain('规划器开始')
    expect(md).toContain('planner → 模型')
    expect(md).toContain('我先看一眼对象')
    expect(md).toContain('scene.get_objects ✓')

    await finishRunLog('completed：ok', {
      sections: [{ title: 'recorder 事件', body: eventsTable([]) }],
    })
    expect(activeRunLog()).toBeNull()
    // 落盘（至少一次：增量 + 收尾）
    expect(posted.length).toBeGreaterThan(0)
    const last = posted[posted.length - 1]
    expect(last.filename).toBe(log?.filename)
    expect(last.content).toContain('## recorder 事件')
    expect(last.content).toContain('completed：ok')
  })

  it('图像只记规模，不把 dataURL 写进日志', async () => {
    beginRunLog({ kind: 'run', runId: 'run-test-2', request: '看图' })
    const big = `data:image/png;base64,${'A'.repeat(50_000)}`
    activeRunLog()?.modelRequest({
      ...request,
      purpose: 'judge',
      messages: [{ role: 'user', text: '对比两图', images: [{ mediaType: 'image/png', dataUrl: big }] }],
    })
    const md = activeRunLog()?.markdown() ?? ''
    expect(md).toContain('附图 1 张')
    expect(md).not.toContain('AAAA')
    await finishRunLog('cancelled')
  })

  it('没有活跃句柄时所有写入都是 no-op（不抛、不落盘）', async () => {
    expect(activeRunLog()).toBeNull()
    expect(() => {
      logStage('x', 'y')
      logWarn('x', 'y')
    }).not.toThrow()
    await finishRunLog('noop')
    expect(posted.length).toBe(0)
  })
})
