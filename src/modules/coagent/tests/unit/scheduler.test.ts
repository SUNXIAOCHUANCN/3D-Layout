/**
 * Scheduler 测试（W03）：模型信号量并发上限/等待取消、场景队列串行与 idle。
 */

import { describe, expect, it } from 'vitest'
import { CoAgentError } from '../../contracts'
import { createScheduler } from '../../runtime/scheduler'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('model semaphore', () => {
  it('并发上限 2：第三个请求等待，释放后获得名额', async () => {
    const s = createScheduler(2)
    const ac = new AbortController()
    const r1 = await s.acquireModel(ac.signal)
    const r2 = await s.acquireModel(ac.signal)
    expect(s.stats().modelInUse).toBe(2)
    let thirdResolved = false
    const p3 = s.acquireModel(ac.signal).then(release => {
      thirdResolved = true
      return release
    })
    await sleep(20)
    expect(thirdResolved).toBe(false)
    r1()
    const r3 = await p3
    expect(thirdResolved).toBe(true)
    expect(s.stats().modelInUse).toBe(2)
    r2()
    r3()
    expect(s.stats().modelInUse).toBe(0)
  })

  it('等待中被 abort → CoAgentError(cancelled)，不占名额', async () => {
    const s = createScheduler(1)
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const r1 = await s.acquireModel(ac1.signal)
    const p2 = s.acquireModel(ac2.signal)
    await sleep(10)
    ac2.abort()
    await expect(p2).rejects.toBeInstanceOf(CoAgentError)
    await expect(p2).rejects.toMatchObject({ code: 'cancelled' })
    r1()
    // 名额未被 aborted 等待者占用：下一个 acquire 立即成功
    const ac3 = new AbortController()
    const r3 = await s.acquireModel(ac3.signal)
    r3()
  })
})

describe('scene queue', () => {
  it('严格串行（后入队任务等前序完成才开始）', async () => {
    const s = createScheduler(2)
    const order: number[] = []
    const job1 = s.runScene(async () => {
      await sleep(40)
      order.push(1)
    })
    const job2 = s.runScene(async () => {
      order.push(2)
    })
    await Promise.all([job1, job2])
    expect(order).toEqual([1, 2])
  })

  it('前序失败不阻塞后续（隔离）', async () => {
    const s = createScheduler(2)
    const j1 = s.runScene(async () => {
      throw new Error('任务1失败')
    })
    await expect(j1).rejects.toThrow('任务1失败')
    const v = await s.runScene(() => 'ok')
    expect(v).toBe('ok')
  })

  it('sceneIdle 等待已入队任务全部完成', async () => {
    const s = createScheduler(2)
    let done = 0
    void s.runScene(async () => {
      await sleep(30)
      done++
    })
    void s.runScene(async () => {
      await sleep(10)
      done++
    })
    await s.sceneIdle()
    expect(done).toBe(2)
  })
})
