/**
 * WorkflowContext 的 fake 装配（W02 引入，W03/W05 复用）。
 * capture 用 FakeRender + 计数器铸造 observationId 组装 Observation（真实
 * evidenceStore 的职责占位）；事件收集进数组供断言。
 */

import type {
  CoAgentConfig,
  EditorCommand,
  ModelPort,
  Observation,
  ObservationId,
  PartitionSnapshot,
  ToolResult,
  WorkflowContext,
  WorkflowEventInput,
  WorkflowWriteCall,
} from '../../contracts'
import type { EditReceipt } from '../../contracts'
import { DEFAULT_COAGENT_CONFIG } from '../../config'
import { blobToDataUrl } from '../../services/imageData'
import { createFakeEditor, type FakeEditor, type FakeEditorOptions } from './FakeEditor'
import { createFakeModel } from './FakeModel'
import { createFakeRender, type FakeRender } from './FakeRender'
import { TWO_REGION_ASSETS, TWO_REGION_CATALOG, makeTwoRegionPartition } from '../fixtures/twoRegionScene'

export interface FakeWorkflowContext extends WorkflowContext {
  readonly events: ReadonlyArray<WorkflowEventInput>
  readonly observations: ReadonlyMap<ObservationId, Observation>
  readonly fakeModel: ModelPort
  readonly fakeRender: FakeRender
  readonly fakeEditor: FakeEditor
}

export interface FakeContextOptions {
  partition?: PartitionSnapshot
  model?: ModelPort
  render?: FakeRender
  editor?: FakeEditorOptions
  config?: Partial<CoAgentConfig>
  signal?: AbortSignal
}

export function createFakeWorkflowContext(opts: FakeContextOptions = {}): FakeWorkflowContext {
  const model = opts.model ?? createFakeModel()
  const render = opts.render ?? createFakeRender()
  const editor = createFakeEditor({
    sceneId: 'scene-fixture',
    assets: TWO_REGION_ASSETS,
    catalog: TWO_REGION_CATALOG,
    ...opts.editor,
  })
  const partition = opts.partition ?? makeTwoRegionPartition()
  const config: CoAgentConfig = { ...DEFAULT_COAGENT_CONFIG, ...opts.config }
  const signal = opts.signal ?? new AbortController().signal
  const events: WorkflowEventInput[] = []
  const observations = new Map<ObservationId, Observation>()
  const imageBlobs = new Map<string, Blob>()
  let obsSeq = 0
  // 写门面：首个 applyWrite 时武装（runController 正式路径在 runtime；fakeContext 供直接驱动 workflow 的测试）
  let writeToken = editor.beginRun('fakeContext-run')
  const writable = new Set<string>()
  const readonlyIds = new Set(partition.globalReadonlyObjectIds)
  for (const region of partition.regions) {
    for (const id of region.objectIds) {
      if (!readonlyIds.has(id)) writable.add(id)
    }
  }

  return {
    signal,
    model,
    render,
    editorRead: editor,
    partition,
    config,
    emit: event => {
      events.push(event)
    },
    capture: async request => {
      const frame = await render.capture(request, signal)
      const id = `obs-${String(++obsSeq).padStart(3, '0')}`
      const observation: Observation = {
        schemaVersion: 1,
        id,
        runId: request.runId,
        ...(request.taskId !== undefined ? { taskId: request.taskId } : {}),
        ...(request.regionId !== undefined ? { regionId: request.regionId } : {}),
        phase: request.phase,
        sceneRevision: frame.sceneRevision,
        partitionVersion: partition.partitionVersion,
        camera: frame.camera,
        width: frame.width,
        height: frame.height,
        rgbImageId: `img-${id}`,
        ...(frame.markedPng !== undefined ? { markedImageId: `img-${id}-marked` } : {}),
        labels: frame.labels,
        observedObjectFingerprints: frame.observedObjectFingerprints,
        capturedAt: new Date().toISOString(),
      }
      observations.set(id, observation)
      imageBlobs.set(observation.rgbImageId, frame.rgbPng)
      if (observation.markedImageId && frame.markedPng) imageBlobs.set(observation.markedImageId, frame.markedPng)
      return observation
    },
    getObservation: id => observations.get(id),
    getImageDataUrl: async imageId => {
      const blob = imageBlobs.get(imageId)
      return blob ? await blobToDataUrl(blob) : null
    },
    applyWrite: (command: EditorCommand, call: WorkflowWriteCall): Promise<ToolResult<EditReceipt>> =>
      Promise.resolve(
        editor.applyAuthorized(command, {
          runId: 'fakeContext-run',
          taskId: call.taskId,
          toolCallId: call.toolCallId,
          token: writeToken,
          writableObjectIds: writable,
        }),
      ).then(result => {
        if (result.ok && command.kind === 'add') writable.add(result.data.objectId)
        return result
      }),
    get events() {
      return events
    },
    get observations() {
      return observations
    },
    fakeModel: model,
    fakeRender: render,
    fakeEditor: editor,
  }
}
