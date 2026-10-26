import { describe, expect, it } from 'vitest'
import type { UnitTask } from '../../contracts'
import { runExecutor } from '../../agents/executor'
import { runToolLoop } from '../../agents/modelLoop'
import { createToolRegistry } from '../../tools/registry'
import { createDirectorModel, textReply, toolReply } from '../fakes/directorModel'
import { createFakeWorkflowContext } from '../fakes/fakeContext'

const task: UnitTask = {
  schemaVersion: 1,
  id: 'task-rounds',
  regionId: 'region-north',
  objective: '整理北区树木',
  targetObjectIds: ['tree-1'],
  allowedOperations: ['transform'],
  criteria: [{ id: 'c1', kind: 'visual', description: '布局合理' }],
  constraints: [],
  dependsOn: [],
}

describe('模型工具循环的轮数限制', () => {
  it('执行器连续调用 8 轮工具后，第 9 轮仍能正常收尾', async () => {
    const model = createDirectorModel()
    model.on('executor', (_request, index) => index < 8
      ? toolReply('查询对象', [{ id: `read-${index}`, name: 'scene.get_objects', args: { objectIds: ['tree-1'] } }])
      : textReply('完成'))
    const context = createFakeWorkflowContext({ model })
    const registry = createToolRegistry(context, { maxCallsPerTask: context.config.toolBudgetPerTask })

    const result = await runExecutor({
      task,
      context,
      registry,
      model,
      signal: context.signal,
      config: context.config,
      runId: 'run-rounds',
      regionObjectIds: ['tree-1', 'tree-2'],
      readonlyObjectIds: [],
    })

    expect(model.count('executor')).toBe(9)
    expect(result.text).toBe('完成')
    expect(result.toolCalls).toBe(8)
    expect(result.toolResults.every(r => r.result.ok)).toBe(true)
  })

  it('显式指定轮数的规划器仍在到达上限时中止', async () => {
    const model = createDirectorModel()
    model.on('planner', (_request, index) => toolReply('继续查询', [
      { id: `list-${index}`, name: 'scene.list_region', args: {} },
    ]))
    const context = createFakeWorkflowContext({ model })
    const registry = createToolRegistry(context, { maxCallsPerTask: context.config.toolBudgetPerTask })

    await expect(runToolLoop({
      role: 'main',
      purpose: 'planner',
      system: 'test',
      messages: [{ role: 'user', text: '规划布局' }],
      model,
      registry,
      site: { runId: 'run-rounds', taskId: null, regionId: null },
      signal: context.signal,
      config: context.config,
      maxRounds: 2,
    })).rejects.toMatchObject({ code: 'budget_exceeded', message: '模型-工具往返超过 2 轮仍未收尾' })
    expect(model.count('planner')).toBe(2)
  })

  it('不限轮数的循环超过 6 轮后仍可取消', async () => {
    const controller = new AbortController()
    const model = createDirectorModel()
    model.on('executor', (_request, index) => toolReply('继续查询', [
      { id: `list-${index}`, name: 'scene.list_region', args: {} },
    ]))
    const context = createFakeWorkflowContext({ model, signal: controller.signal })
    const registry = createToolRegistry(context, { maxCallsPerTask: context.config.toolBudgetPerTask })
    let completedCalls = 0

    await expect(runToolLoop({
      role: 'executor',
      purpose: 'executor',
      system: 'test',
      messages: [{ role: 'user', text: '整理布局' }],
      model,
      registry,
      site: { runId: 'run-rounds', taskId: task.id, regionId: task.regionId },
      signal: controller.signal,
      config: context.config,
      onToolResult: () => {
        if (++completedCalls === 7) controller.abort()
      },
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(model.count('executor')).toBe(7)
    expect(registry.toolCalls(task.id)).toBe(7)
  })
})
