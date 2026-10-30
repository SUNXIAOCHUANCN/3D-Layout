/**
 * devHarness（W03）——真实宿主里的演示/验证入口，只在 DEV 构建挂载（生产被摇掉）。
 *
 * 为什么需要它：W03 的完成条件是"真实 core 上事务和互斥通过，不只 FakeEditor 通过"。
 * 单元/集成测试能覆盖真实 core 的事务语义，但"面板点开始 → 写者互斥真的锁住
 * 快捷键/历史/场景切换 → 整轮一条 undo"只有在真实 App 里能验。
 * 生产装配在 W06 才有真实分区来源，因此在 DEV 下提供：
 *
 * - 按场景实际资产造两个区域（z<0 / z>=0），每区取最多 2 个可写对象；
 * - 注入 W03 已知 transform 假 workflow（走完整 applyWrite 门面）；
 * - 启动/取消/读历史/读资产/读订阅数的探针，供 CDP 驱动的 T08/T13/T16 使用。
 *
 * 观察者只订阅 runtime 的相位与 recorder 事件（单向），不驱动业务。
 * 本文件不参与生产路径：useCoAgentModule 只在 import.meta.env.DEV 分支动态 import。
 */

import { edit, type HistoryUnitView } from '../../../core/edit'
import type {
  CameraSnapshot,
  GeometryRequest,
  GeometryResult,
  Observation,
  ObservationPhase,
  PartitionSnapshot,
  PickRequest,
  PickResult,
  Region,
  RenderPortDiagnostics,
  TransformDTO,
} from '../contracts'
import type { CoAgentRuntime } from '../runtime/createRuntime'
import type { EvidenceStoreStats } from '../runtime/evidenceStore'
import { createKnownTransformWorkflow, type KnownTransformStep } from '../tests/fakes/fakeWorkflow'

export interface DemoPlan {
  partition: PartitionSnapshot
  steps: KnownTransformStep[]
}

export interface DemoCaptureInput {
  camera: CameraSnapshot
  width: number
  height: number
  objectIds: string[]
  marked?: boolean
  phase?: ObservationPhase
  runId?: string
}

/** 页面内解码一张证据图（真实像素检查，不靠外部图像库） */
export interface DecodedImage {
  width: number
  height: number
  /** 与左上角像素明显不同的像素比例（判断"不是纯色/纯黑图"） */
  nonUniformRatio: number
  uniqueColors: number
  mean: [number, number, number]
}

export interface DemoResult {
  /** 是否正常落定（不代表业务成功；看 outcomeKind） */
  settled: boolean
  outcomeKind: string | null
  historyAdded: number
  units: HistoryUnitView[]
  after: Record<string, TransformDTO>
  phasesSeen: string[]
}

export interface DevHarness {
  runtime: CoAgentRuntime
  phase(): string
  locked(): boolean
  plan(): DemoPlan
  /** 只注入分区 + workflow 工厂，不启动（面板路径验证用：让用户点"开始"） */
  arm(opts?: { delayMs?: number }): DemoPlan
  startDemo(opts?: { delayMs?: number }): Promise<DemoResult>
  startSlow(delayMs: number): void
  awaitPending(): Promise<DemoResult | null>
  cancel(): Promise<void>
  historyCount(): number
  units(): HistoryUnitView[]
  redoUnits(): HistoryUnitView[]
  /** 造一条人工编辑历史（T13：验证活跃期 Ctrl+Z 被互斥挡掉） */
  humanTouch(objectId?: string): boolean
  assets(): Record<string, TransformDTO>
  undo(): boolean
  redo(): boolean
  phaseListeners(): number
  reset(): boolean
  /** W04：走完整观测链路的一次真实捕获（ready → 渲染 → 证据登记） */
  capture(input: DemoCaptureInput): Promise<Observation>
  /** W04：证据占用 */
  evidenceStats(): EvidenceStoreStats
  /** W04：渲染端口自检（未挂桥时 null） */
  renderDiagnostics(): RenderPortDiagnostics | null
  /** W08.3：真实渲染端口上的几何检测（AABB/三角形/包含/接触） */
  geometry(input: GeometryRequest): Promise<GeometryResult>
  /** P2：真实渲染端口上的截图点选（用观测相机，不用主视口） */
  pick(input: PickRequest): Promise<PickResult>
  /** W04：页面内解码证据图，供像素/方向/颜色断言 */
  decode(imageId: string): Promise<DecodedImage>
  /** W04：读证据图某像素（左上原点） */
  pixel(imageId: string, x: number, y: number): Promise<[number, number, number]>
  /** W04：移动一个资产（真实 core 编辑，制造"移动后立即捕获"场景） */
  moveObject(objectId: string, position: [number, number, number]): boolean
  dispose(): void
}

interface SnapshotAsset {
  id: string
  ref: string
  transform: TransformDTO
}

const SETTLED_PHASES = new Set(['completed', 'rolled_back', 'failed', 'error_locked', 'awaiting_clarification'])

function boundsPolygon(assets: SnapshotAsset[], pad: number): Array<[number, number]> {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const a of assets) {
    const [x, , z] = a.transform.position
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  if (!Number.isFinite(minX)) {
    minX = -10
    maxX = 10
    minZ = -10
    maxZ = 10
  }
  return [
    [minX - pad, minZ - pad],
    [maxX + pad, minZ - pad],
    [maxX + pad, maxZ + pad],
    [minX - pad, maxZ + pad],
  ]
}

const readAssets = (runtime: CoAgentRuntime): Record<string, TransformDTO> => {
  const out: Record<string, TransformDTO> = {}
  for (const a of runtime.debugSnapshot({}).assets as SnapshotAsset[]) out[a.id] = a.transform
  return out
}

/** 用场景实际资产造一个两区演示计划（不依赖 fake 夹具，随当前场景变化） */
function buildPlan(runtime: CoAgentRuntime): DemoPlan {
  const snap = runtime.debugSnapshot({ includeCatalog: false })
  const all = snap.assets as SnapshotAsset[]
  const byZ = (neg: boolean): SnapshotAsset[] =>
    all
      .filter(a => (neg ? a.transform.position[2] < 0 : a.transform.position[2] >= 0))
      .sort((a, b) => Math.abs(a.transform.position[0]) - Math.abs(b.transform.position[0]))
  const north = byZ(true).slice(0, 2)
  const south = byZ(false).slice(0, 2)
  const used = new Set([...north, ...south].map(a => a.id))
  const readonly = all
    .filter(a => !used.has(a.id))
    .map(a => a.id)
    .slice(0, 1)

  const regions: Region[] = []
  const steps: KnownTransformStep[] = []

  const push = (regionId: string, list: SnapshotAsset[], offsets: Array<[number, number, number]>): void => {
    list.forEach((a, i) => {
      const off = offsets[i % offsets.length]
      steps.push({
        regionId,
        objectId: a.id,
        transform: {
          position: [a.transform.position[0] + off[0], a.transform.position[1] + off[1], a.transform.position[2] + off[2]],
          rotationDeg: [...a.transform.rotationDeg] as [number, number, number],
          scale: [...a.transform.scale] as [number, number, number],
        },
      })
    })
    regions.push({
      schemaVersion: 1,
      id: regionId,
      name: regionId === 'region-north' ? '北区' : '南区',
      polygonXZ: boundsPolygon(list.length > 0 ? list : all.slice(0, 1), 4),
      objectIds: list.map(a => a.id),
      cameraId: `cam-${regionId}`,
      partitionVersion: 1,
    })
  }

  push('region-north', north, [
    [1.2, 0, 0.6],
    [-1.0, 0, 0.8],
  ])
  push('region-south', south, [
    [0.9, 0, -0.7],
    [-1.4, 0, -0.5],
  ])

  return { partition: { partitionVersion: 1, regions, globalReadonlyObjectIds: readonly }, steps }
}

export function installDevHarness(runtime: CoAgentRuntime): () => void {
  const phasesSeen: string[] = []
  let historyAtStart = 0
  let settled: DemoResult | null = null
  let waiters: Array<(r: DemoResult) => void> = []

  const buildResult = (phase: string): DemoResult => ({
    settled: true,
    outcomeKind: phase === 'rolled_back' && phasesSeen.includes('cancelling') ? 'cancelled' : phase,
    historyAdded: edit.historyUnits().length - historyAtStart,
    units: edit.historyUnits(),
    after: readAssets(runtime),
    phasesSeen: [...phasesSeen],
  })

  const unsubPhase = runtime.onPhase(p => {
    phasesSeen.push(p)
    if (SETTLED_PHASES.has(p)) {
      settled = buildResult(p)
      const ws = waiters
      waiters = []
      for (const w of ws) w(settled)
    }
  })

  // 每轮开始（run.started）重置观察基线：面板路径与 startDemo 路径一视同仁
  const unsubRec = runtime.recorder.subscribe(e => {
    if (e.type === 'run.started') {
      historyAtStart = edit.historyUnits().length
      phasesSeen.length = 0
      settled = null
    }
  })

  const arm = (opts?: { delayMs?: number }): DemoPlan => {
    const plan = buildPlan(runtime)
    runtime.debugSetPartition(plan.partition)
    runtime.debugSetWorkflowFactory(() =>
      createKnownTransformWorkflow({
        steps: plan.steps.map(s => ({ ...s, ...(opts?.delayMs ? { delayMs: opts.delayMs } : {}) })),
      }),
    )
    return plan
  }

  const awaitPending = (timeoutMs = 30_000): Promise<DemoResult | null> => {
    if (settled) return Promise.resolve(settled)
    return new Promise<DemoResult | null>(resolve => {
      const timer = setTimeout(() => resolve(settled), timeoutMs)
      waiters.push(r => {
        clearTimeout(timer)
        resolve(r)
      })
    })
  }

  // W04：证据图解码缓存（同一 imageId 只解码一次）
  const decoded = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>()
  const loadImage = async (imageId: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> => {
    const cached = decoded.get(imageId)
    if (cached) return cached
    const url = runtime.observations.urlFor(imageId)
    if (!url) throw new Error(`没有这张证据图：${imageId}`)
    const blob = await (await fetch(url)).blob()
    const bmp = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas 不可用')
    ctx.drawImage(bmp, 0, 0)
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    const out = { width: bmp.width, height: bmp.height, data }
    bmp.close()
    decoded.set(imageId, out)
    return out
  }

  const harness: DevHarness = {
    runtime,
    phase: () => runtime.phase(),
    locked: () => runtime.locked(),
    plan: () => buildPlan(runtime),
    arm: (opts?: { delayMs?: number }) => arm(opts),
    startDemo: async opts => {
      arm(opts)
      void runtime.start('W03 演示：两个区域的已知变换')
      return (await awaitPending()) ?? {
        settled: false,
        outcomeKind: null,
        historyAdded: 0,
        units: edit.historyUnits(),
        after: readAssets(runtime),
        phasesSeen: [...phasesSeen],
      }
    },
    startSlow: delayMs => {
      arm({ delayMs })
      void runtime.start('W03 演示：慢速两区变换')
    },
    awaitPending,
    cancel: () => runtime.cancel(),
    historyCount: () => edit.historyUnits().length,
    units: () => edit.historyUnits(),
    redoUnits: () => edit.redoUnits(),
    humanTouch: objectId => {
      const id = objectId ?? (runtime.debugSnapshot({}).assets[0]?.id ?? null)
      if (!id) return false
      const cur = runtime.debugSnapshot({ objectIds: [id] }).assets[0]
      if (!cur) return false
      const t = cur.transform
      return edit.setTransform(
        id,
        {
          position: [t.position[0] + 0.25, t.position[1], t.position[2]],
          rotation: t.rotationDeg,
          scale: t.scale,
        },
        { source: 'human' },
      )
    },
    assets: () => readAssets(runtime),
    undo: () => edit.undo(),
    redo: () => edit.redo(),
    phaseListeners: () => runtime.diagnostics().phaseListeners,
    reset: () => runtime.reset().ok,
    capture: input =>
      runtime.debugCapture({
        camera: input.camera,
        width: input.width,
        height: input.height,
        objectIds: input.objectIds,
        marked: input.marked ?? true,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
      }),
    evidenceStats: () => runtime.evidenceStats(),
    renderDiagnostics: () => runtime.renderDiagnostics(),
    geometry: input => runtime.debugGeometry(input),
    pick: input => runtime.debugPick(input),
    async decode(imageId: string): Promise<DecodedImage> {
      const img = await loadImage(imageId)
      const { width, height, data } = img
      const at = (x: number, y: number): [number, number, number] => {
        const i = (y * width + x) * 4
        return [data[i], data[i + 1], data[i + 2]]
      }
      const bg = at(0, 0)
      const colors = new Set<number>()
      let diff = 0
      let sr = 0
      let sg = 0
      let sb = 0
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [r, g, b] = at(x, y)
          sr += r
          sg += g
          sb += b
          colors.add((r << 16) | (g << 8) | b)
          if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 12) diff++
        }
      }
      const n = width * height
      return {
        width,
        height,
        nonUniformRatio: diff / n,
        uniqueColors: colors.size,
        mean: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
      }
    },
    async pixel(imageId: string, x: number, y: number): Promise<[number, number, number]> {
      const img = await loadImage(imageId)
      const cx = Math.max(0, Math.min(img.width - 1, Math.round(x)))
      const cy = Math.max(0, Math.min(img.height - 1, Math.round(y)))
      const i = (cy * img.width + cx) * 4
      return [img.data[i], img.data[i + 1], img.data[i + 2]]
    },
    moveObject: (objectId, position) => {
      const cur = runtime.debugSnapshot({ objectIds: [objectId] }).assets[0]
      if (!cur) return false
      return edit.setTransform(
        objectId,
        { position, rotation: cur.transform.rotationDeg, scale: cur.transform.scale },
        { source: 'human' },
      )
    },
    dispose: () => {
      unsubPhase()
      unsubRec()
      if ((window as unknown as { __coagentDev?: DevHarness }).__coagentDev === harness) {
        delete (window as unknown as { __coagentDev?: DevHarness }).__coagentDev
      }
    },
  }

  ;(window as unknown as { __coagentDev?: DevHarness }).__coagentDev = harness
  return () => harness.dispose()
}
