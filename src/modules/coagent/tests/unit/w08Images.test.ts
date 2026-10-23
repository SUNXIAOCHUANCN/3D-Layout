/**
 * W08.2：判定/执行真正拿到证据图。
 *
 * 不 mock 图片转换（FakeRender 给 Blob，fakeContext 用同一个 blobToDataUrl），
 * 断言的是"请求里确实有 PNG dataURL"以及"没图时 visual 不能 pass"。
 */

import { describe, expect, it } from 'vitest'
import type { ModelImage, ModelRequest, Observation, UnitTask, WorkflowContext } from '../../contracts'
import { judgeTask } from '../../agents/judge'
import { runToolLoop } from '../../agents/modelLoop'
import { regionCamera, captureWith } from '../../tools/cameraTools'
import { createToolRegistry } from '../../tools/registry'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { createDirectorModel, evidenceIdsFromPrompt, textReply, toolReply, verdictReply } from '../fakes/directorModel'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

const task: UnitTask = {
  schemaVersion: 1,
  id: 'task-visual',
  regionId: 'region-north',
  objective: '让北树一保持在区内',
  targetObjectIds: ['tree-1'],
  allowedOperations: ['transform'],
  criteria: [{ id: 'c-visual', kind: 'visual', description: '树完整在区内' }],
  constraints: [{ kind: 'stay_in_region' }],
  dependsOn: [],
}

async function observationsFor(context: WorkflowContext): Promise<{ before: Observation; after: Observation }> {
  const partition = makeTwoRegionPartition()
  const camera = regionCamera(partition.regions[0])
  const before = await captureWith(context, {
    runId: 'run-img',
    camera,
    phase: 'task_before',
    objectIds: ['tree-1'],
    marked: true,
    taskId: task.id,
    regionId: task.regionId,
  })
  const after = await captureWith(context, {
    runId: 'run-img',
    camera,
    phase: 'after',
    objectIds: ['tree-1'],
    marked: true,
    taskId: task.id,
    regionId: task.regionId,
  })
  return { before, after }
}

function judgeRequest(req: ModelRequest): { images: ModelImage[]; text: string } {
  const user = req.messages.find(m => m.role === 'user') as { text: string; images?: ModelImage[] }
  return { images: user.images ?? [], text: user.text }
}

describe('W08.2 Judge 看图', () => {
  it('判定请求附带 before/after 两张 PNG dataURL，并给出图片顺序', async () => {
    const model = createDirectorModel()
    let images: ModelImage[] = []
    let text = ''
    model.on('judge', req => {
      const parsed = judgeRequest(req)
      images = parsed.images
      text = parsed.text
      const { baselineId, afterId } = evidenceIdsFromPrompt(req)
      return verdictReply({ taskId: task.id, criteria: ['c-visual'], status: 'pass', evidenceIds: [baselineId, afterId] })
    })
    const context = createFakeWorkflowContext({ model })
    const { before, after } = await observationsFor(context)

    const out = await judgeTask({
      task,
      runId: 'run-img',
      before,
      after,
      model,
      signal: context.signal,
      config: context.config,
      context,
    })

    expect(out.verdict.status).toBe('pass')
    expect(images.length).toBe(2)
    expect(images[0].mediaType).toBe('image/png')
    expect(images[0].dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(images[1].dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(images[0].dataUrl).not.toBe(images[1].dataUrl)
    expect(text).toContain('before → after')
  })

  it('证据图取不回时 visual 不能 pass（且不调用模型）', async () => {
    const model = createDirectorModel()
    let called = 0
    model.on('judge', () => {
      called++
      return textReply('{}')
    })
    const context = createFakeWorkflowContext({ model })
    const { before, after } = await observationsFor(context)
    const noImages = { ...context, getImageDataUrl: async () => null } as unknown as WorkflowContext

    const out = await judgeTask({
      task,
      runId: 'run-img',
      before,
      after,
      model,
      signal: context.signal,
      config: context.config,
      context: noImages,
    })

    expect(called).toBe(0)
    expect(out.verdict.status).toBe('fail')
    expect(out.issues.join('\n')).toContain('缺少证据图')
  })

  it('引用其他 run 的执行期证据 → 判定不可信（证据版本校验）', async () => {
    const model = createDirectorModel()
    const context = createFakeWorkflowContext({ model })
    const { before, after } = await observationsFor(context)
    const partition = makeTwoRegionPartition()
    const foreign = await captureWith(context, {
      runId: 'run-other',
      camera: regionCamera(partition.regions[0]),
      phase: 'supplement',
      objectIds: ['tree-1'],
      marked: true,
      taskId: task.id,
      regionId: task.regionId,
    })
    model.on('judge', req => {
      const { baselineId, afterId } = evidenceIdsFromPrompt(req)
      return verdictReply({ taskId: task.id, criteria: ['c-visual'], status: 'pass', evidenceIds: [baselineId, afterId, foreign.id] })
    })

    const out = await judgeTask({
      task,
      runId: 'run-img',
      before,
      after,
      extraEvidenceIds: [foreign.id],
      model,
      signal: context.signal,
      config: context.config,
      context,
    })

    expect(out.credible).toBe(false)
    expect(out.verdict.status).toBe('fail')
    expect(out.issues.join('\n')).toContain('run-other')
    expect(out.issues.join('\n')).toContain('不是当前 run')
  })

  it('before/after 不同相位/相机时不可配对，直接 fail（§6.3）', async () => {
    const model = createDirectorModel()
    let called = 0
    model.on('judge', () => {
      called++
      return textReply('{}')
    })
    const context = createFakeWorkflowContext({ model })
    const { before, after } = await observationsFor(context)
    const badAfter = await captureWith(context, {
      runId: 'run-img',
      camera: regionCamera(makeTwoRegionPartition().regions[1]), // 不同相机
      phase: 'supplement', // 不同相位
      objectIds: ['tree-1'],
      marked: true,
      taskId: task.id,
      regionId: task.regionId,
    })

    const out = await judgeTask({
      task,
      runId: 'run-img',
      before,
      after: badAfter ?? after,
      model,
      signal: context.signal,
      config: context.config,
      context,
    })

    expect(called).toBe(0)
    expect(out.verdict.status).toBe('fail')
    expect(out.issues.join('\n')).toContain('phase')
    expect(out.issues.join('\n')).toContain('相机快照不同')
  })
})

describe('W08.2 toolResult 附图', () => {
  it('camera.capture 的 toolResult 带真实图片（模型下一轮能看到）', async () => {
    const model = createDirectorModel()
    let toolImages = 0
    model.on('executor', (req, index) => {
      if (index === 0) {
        return toolReply('先拍一张', [{ name: 'camera.capture', args: { phase: 'supplement', marked: true }, id: 'cap-1' }])
      }
      const toolResult = req.messages.filter(m => m.role === 'toolResult').pop() as { images?: ModelImage[] } | undefined
      toolImages = toolResult?.images?.length ?? 0
      return textReply('完成')
    })

    const context = createFakeWorkflowContext({ model })
    const registry = createToolRegistry(context, { maxCallsPerTask: 5 })
    const result = await runToolLoop({
      role: 'executor',
      purpose: 'executor',
      system: 'test',
      messages: [{ role: 'user', text: '拍一张' }],
      model,
      registry,
      site: { runId: 'run-tool', taskId: task.id, regionId: task.regionId },
      signal: context.signal,
      config: context.config,
      maxRounds: 2,
      imagesForToolResult: async (call, toolResult) => {
        if (call.name !== 'camera.capture' || !toolResult.ok) return []
        const obs = toolResult.data as Observation
        const url = await context.getImageDataUrl(obs.rgbImageId)
        return url ? [{ mediaType: 'image/png', dataUrl: url }] : []
      },
    })

    expect(result.toolResults[0]?.call.name).toBe('camera.capture')
    expect(toolImages).toBe(1)
    expect(result.transcript.some(m => m.role === 'toolResult' && (m.images?.length ?? 0) === 1)).toBe(true)
  })
})
