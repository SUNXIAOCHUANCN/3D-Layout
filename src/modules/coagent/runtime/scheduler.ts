/**
 * Scheduler（W03，SPEC §3.2）——两个独立资源：
 *
 * - model semaphore：全局限制并发模型请求数（默认 2）。不是每区一个"全局"限制。
 * - scene queue：串行化写入、几何快照与离屏捕获。网络请求绝不能占据该队列
 *   （§3.2 红线），由调用方自律：runScene 的 job 内不得 await 网络。
 *
 * 等待均可被 AbortSignal 取消（§5.4：等待信号量的模型请求、等待场景队列的工具）。
 */

import { CoAgentError } from '../contracts'

interface Waiter {
  resolve: () => void
  reject: (e: CoAgentError) => void
  onAbort: () => void
  signal: AbortSignal
}

export interface Scheduler {
  /** 获得一个模型并发名额；resolve 值为释放函数；abort 时以 cancelled 拒绝 */
  acquireModel(signal: AbortSignal): Promise<() => void>
  /** 场景队列：串行执行；队列内任务失败不阻塞后续 */
  runScene<T>(job: () => T | Promise<T>): Promise<T>
  /** 等待当前已入队的场景任务全部完成（commit 前调用；§5.3"等队列清空"） */
  sceneIdle(): Promise<void>
  /** 诊断：当前占用/等待数 */
  stats(): { modelInUse: number; modelWaiting: number }
}

export function createScheduler(modelConcurrency: number): Scheduler {
  let inUse = 0
  const waiters: Waiter[] = []

  const releaseOne = (): void => {
    const next = waiters.shift()
    if (!next) return
    next.signal.removeEventListener('abort', next.onAbort)
    // 名额直接移交给队首等待者（不经过 inUse-- / inUse++ 抖动）
    next.resolve()
  }

  const acquireModel = (signal: AbortSignal): Promise<() => void> =>
    new Promise<() => void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new CoAgentError('cancelled', '等待模型名额时已取消'))
        return
      }
      const done = (): void => {
        inUse--
        releaseOne()
      }
      if (inUse < modelConcurrency) {
        inUse++
        resolve(done)
        return
      }
      const waiter: Waiter = {
        signal,
        resolve: () => {
          inUse++
          resolve(done)
        },
        reject,
        onAbort: () => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          reject(new CoAgentError('cancelled', '等待模型名额时被取消'))
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      waiters.push(waiter)
    })

  // ---------- 场景队列：promise 链串行 ----------

  let tail: Promise<unknown> = Promise.resolve()

  const runScene = <T,>(job: () => T | Promise<T>): Promise<T> => {
    const next = tail.then(job, job) // 前序失败不阻塞后续任务
    // 吞掉链尾异常，避免 unhandled rejection 传染后续入队者
    tail = next.catch(() => undefined)
    return next
  }

  const sceneIdle = (): Promise<void> =>
    new Promise<void>(resolve => {
      void tail.then(() => resolve())
    })

  return {
    acquireModel,
    runScene,
    sceneIdle,
    stats: () => ({ modelInUse: inUse, modelWaiting: waiters.length }),
  }
}
