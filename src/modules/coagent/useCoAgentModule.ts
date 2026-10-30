/**
 * useCoAgentModule（W03，SPEC §3.1）——CoAgent 的装配钩子。
 *
 * - enabled 时创建模块级唯一 runtime（StrictMode 双挂载不重复建立活跃 run：
 *   runtime 为懒创建单例；cleanup 只做 requestDisable，真正的 dispose 放在
 *   0ms 定时器里，若下一帧就重挂载则取消——StrictMode 不销毁、真卸载才销毁）。
 * - 宿主运行资格（旧 Agent 忙碌）经 isHostBusy 注入合作式校验。
 * - requestDisable 先取消并清理，再释放 adapter 订阅（T16：重复启停不增长订阅）。
 * - 相位与锁定都经 runtime.onPhase 投影到 uiStore；UI 不自造状态。
 * - dev 模式挂 window.__coagent（runtime）与 window.__coagentDev（真实宿主演示入口）。
 */

import { useEffect, useRef, useState } from 'react'
import type { CoAgentPhase, RunOutcome, ToolResult } from './contracts'
import type { PartitionPersistenceState } from './services/partitionPersistence'
import { createRuntime, type CoAgentRuntime } from './runtime/createRuntime'
import { keepRecent } from './uiProjection'
import { useCoAgentStore, isBusyPhase } from './uiStore'

export interface UseCoAgentModuleResult {
  phase: CoAgentPhase
  busy: boolean
  /** error_locked：禁止新 run，需人工 reset */
  locked: boolean
  start: (request: string) => Promise<ToolResult<RunOutcome>>
  cancel: () => Promise<void>
  /** 解除 error_locked（§5.4）；活跃 run 中拒绝并给出原因 */
  reset: () => void
  /** 分区就绪标志（W06 前恒 false，面板据此禁用开始并给出指引） */
  partitionReady: boolean
  /** P3：最近一轮是否有可撤销的历史（没有实际写入时为 false） */
  canUndoLastRun: boolean
  /** P3：撤销最近一轮（只支持栈顶；不可用时返回原因） */
  undoLastRun: () => { ok: boolean; message?: string }
  /** P4：分区配套文件状态 */
  partitionPersistence: PartitionPersistenceState
  /** P4：重新读取并核对分区文件 */
  restorePartition: () => Promise<void>
  /** P4：把当前分区写成配套文件 */
  savePartition: () => Promise<void>
  runtime: CoAgentRuntime | null
}

/** 模块级懒单例：StrictMode 反复 mount/unmount 复用同一 runtime */
let runtimeSingleton: CoAgentRuntime | null = null
/** 延迟释放计时器：StrictMode 的 cleanup→remount 之间不清掉单例 */
let disposeTimer: ReturnType<typeof setTimeout> | null = null

export function useCoAgentModule(enabled: boolean, opts?: { isHostBusy?: () => boolean }): UseCoAgentModuleResult {
  const [phase, setPhase] = useState<CoAgentPhase>('disabled')
  const [locked, setLocked] = useState(false)
  const [runtime, setRuntime] = useState<CoAgentRuntime | null>(null)
  const runtimeRef = useRef<CoAgentRuntime | null>(null)

  useEffect(() => {
    if (!enabled) {
      setPhase('disabled')
      setLocked(false)
      return
    }
    // 上一轮 cleanup 排的释放被取消：这是 StrictMode 重挂载或用户重新打开插件
    if (disposeTimer !== null) {
      clearTimeout(disposeTimer)
      disposeTimer = null
    }

    const store = useCoAgentStore.getState()
    store.setPhase('initializing')

    runtimeSingleton ??= createRuntime({ isHostBusy: opts?.isHostBusy })
    const runtime = runtimeSingleton
    runtimeRef.current = runtime
    setRuntime(runtime) // 供 <CoAgentBridge/> 注册渲染端口（W04）
    runtime.enable() // 重挂载后复活（disabled → idle；锁定保留为 error_locked）
    // P4：开启分区配套文件的自动恢复（首挂载与切场景都会读一次；无文件是正常状态）
    runtime.enablePartitionPersistence()

    const sync = (): void => {
      const p = runtime.phase()
      setPhase(p)
      setLocked(runtime.locked())
      const s = useCoAgentStore.getState()
      s.setPhase(p)
      s.setLocked(runtime.locked())
    }

    const unsubPhase = runtime.onPhase(() => sync())
    const unsubRec = runtime.recorder.subscribe(() => {
      const events = runtime.recorder.events()
      const s = useCoAgentStore.getState()
      s.setEventCount(events.length)
      s.setEvents(keepRecent(events))
    })
    useCoAgentStore.getState().setEventCount(runtime.recorder.events().length)
    useCoAgentStore.getState().setEvents(keepRecent(runtime.recorder.events()))
    sync()

    let uninstallDev: (() => void) | null = null
    let mounted = true
    if (import.meta.env.DEV) {
      ;(window as unknown as { __coagent?: CoAgentRuntime }).__coagent = runtime
      void import('./dev/devHarness').then(m => {
        // 卸载竞态：cleanup 后 import 才 resolve 时不能再把 harness 挂到已释放的 runtime
        if (mounted) uninstallDev = m.installDevHarness(runtime)
      })
    }

    return () => {
      mounted = false
      unsubPhase()
      unsubRec()
      // 卸载 = 取消活跃 run 并进入 disabled；单例与 adapter 订阅的释放延后一拍
      void runtime.requestDisable()
      uninstallDev?.()
      disposeTimer = setTimeout(() => {
        disposeTimer = null
        runtime.dispose()
        if (runtimeSingleton === runtime) runtimeSingleton = null
      }, 0)
    }
    // opts.isHostBusy 由调用方保证引用稳定（App 内联箭头函数不参与依赖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const busy = isBusyPhase(phase)
  return {
    phase,
    busy,
    locked,
    start: async request => {
      useCoAgentStore.getState().beginRun()
      const rt = runtimeRef.current ?? runtimeSingleton
      if (!rt) {
        return { ok: false, error: { code: 'run_busy', message: 'runtime 未初始化', retryable: false } }
      }
      if (rt.locked()) {
        return { ok: false, error: { code: 'run_busy', message: 'error_locked：需先重置', retryable: false } }
      }
      const result = await rt.start(request)
      if (result.ok) {
        const k = result.data.kind
        if (k === 'needs_clarification') {
          // W07：把问题留在面板里，回答后拼回原请求再规划（不是新会话）
          useCoAgentStore.getState().setPendingClarify({
            originalRequest: request,
            question: result.data.question,
            options: [...result.data.options],
          })
        }
        useCoAgentStore.getState().setResult(
          k === 'completed'
            ? { kind: k, summary: result.data.summary }
            : k === 'retained_with_issues'
              ? {
                  kind: k,
                  summary: result.data.summary,
                  issueCount: result.data.issues.length,
                  issues: result.data.issues.slice(0, 5).map(i => `${i.name}：${i.reason}`),
                }
              : k === 'rolled_back'
              ? {
                  kind: k,
                  reason: result.data.reason.message,
                  code: result.data.reason.code,
                  ...(typeof result.data.reason.details?.stage === 'string' ? { stage: result.data.reason.details.stage } : {}),
                }
              : { kind: k },
        )
      } else {
        useCoAgentStore.getState().setError(result.error.message)
      }
      return result
    },
    cancel: async () => {
      await runtimeRef.current?.cancel()
    },
    reset: () => {
      const rt = runtimeRef.current ?? runtimeSingleton
      if (!rt) return
      const r = rt.reset()
      if (!r.ok) useCoAgentStore.getState().setError(r.error.message)
      else useCoAgentStore.getState().setError(null)
    },
    // ---- P3：撤销本轮 ----
    canUndoLastRun: Boolean(runtime?.lastRunHistoryRef()),
    undoLastRun: () => {
      const rt = runtimeRef.current ?? runtimeSingleton
      if (!rt) return { ok: false, message: '运行时未就绪' }
      const res = rt.undoLastRun()
      // 撤销成功后结果卡片要反映"已撤销"，否则按钮还在说可以撤
      if (res.ok) {
        const s = useCoAgentStore.getState()
        const prev = s.lastResult
        if (prev) s.setResult({ ...prev, kind: 'undone', summary: '已撤销本轮修改' })
      } else if (res.message) {
        useCoAgentStore.getState().setError(res.message)
      }
      setPhase(rt.phase())
      return res
    },
    // ---- P4：分区持久化 ----
    partitionPersistence: runtime?.partitionPersistenceState() ?? { status: 'idle' as const },
    restorePartition: async () => {
      const rt = runtimeRef.current ?? runtimeSingleton
      if (!rt) return
      await rt.restorePartition()
      setPhase(rt.phase())
    },
    savePartition: async () => {
      const rt = runtimeRef.current ?? runtimeSingleton
      if (!rt) return
      await rt.savePartition()
      setPhase(rt.phase())
    },
    partitionReady: Boolean(runtime?.partition()),
    runtime,
  }
}
