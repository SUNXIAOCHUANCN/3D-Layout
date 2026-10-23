/**
 * W02 验证图集成测试（Node 侧）：
 * 分支乱序完成、修正循环、恰好一次 finalCheck、某支终局失败、某支异常、等待取消、reducer 冲突。
 * 浏览器侧同套场景见 tests/browser/（probe 页）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildVerificationGraph,
  type VerificationEvent,
  type VerificationBranchSpec,
} from '../../workflow/verificationGraph'
import { mergeKeyedNoLWW } from '../../workflow/state'

function collect(): { events: VerificationEvent[]; recorder: (e: VerificationEvent) => void } {
  const events: VerificationEvent[] = []
  return { events, recorder: e => events.push(e) }
}

const FAST: VerificationBranchSpec = {
  regionId: 'region-fast',
  nodeKey: 'branchFast',
  delayMs: 15,
  failFirstAttempts: 0,
  maxAttempts: 1,
}

const SLOW_WITH_REPAIR: VerificationBranchSpec = {
  regionId: 'region-slow',
  nodeKey: 'branchSlow',
  delayMs: 60,
  failFirstAttempts: 1,
  maxAttempts: 3,
}

describe('W02 验证图拓扑', () => {
  it('双分支不同耗时：乱序完成、慢支修正一轮后通过、finalCheck 恰好一次且晚于全部分支', async () => {
    const { events, recorder } = collect()
    const out = await buildVerificationGraph([FAST, SLOW_WITH_REPAIR], recorder).invoke({ runId: 'run-1', request: '测试' })

    expect(Object.keys(out.regionResults).sort()).toEqual(['region-fast', 'region-slow'])
    expect(out.finalCheckRuns).toBe(1)
    expect(out.regionResults['region-slow'].status).toBe('pass')

    const slowAttempts = events.filter(e => e.type === 'attempt' && e.regionId === 'region-slow')
    expect(slowAttempts.length).toBe(2) // 修正循环：首轮 fail，第二轮 pass
    expect(slowAttempts[0]).toMatchObject({ status: 'fail' })
    expect(slowAttempts[1]).toMatchObject({ status: 'pass' })

    // 乱序完成：慢支最后一次尝试晚于快支唯一一次尝试
    const fastDone = events.find(e => e.type === 'attempt' && e.regionId === 'region-fast')!
    expect(slowAttempts[1].at).toBeGreaterThanOrEqual(fastDone.at)

    // finalCheck 恰好一次，且在两分支终态之后
    const finalChecks = events.filter(e => e.type === 'finalCheck')
    expect(finalChecks.length).toBe(1)
    expect(finalChecks[0].at).toBeGreaterThanOrEqual(slowAttempts[1].at)
  })

  it('某支终局失败（尝试耗尽）：finalCheck 运行但未通过，invoke 拒绝', async () => {
    const { events, recorder } = collect()
    const exhausted: VerificationBranchSpec = {
      regionId: 'region-bad',
      nodeKey: 'branchBad',
      delayMs: 10,
      failFirstAttempts: 99,
      maxAttempts: 2,
    }
    await expect(
      buildVerificationGraph([FAST, exhausted], recorder).invoke({ runId: 'run-2', request: '失败路径' }),
    ).rejects.toThrow(/finalCheck 未通过/)
    const finalChecks = events.filter(e => e.type === 'finalCheck')
    expect(finalChecks.length).toBe(1)
    expect(finalChecks[0].passed).toBe(false)
  })

  it('某支节点异常：invoke 拒绝，finalCheck 从未运行', async () => {
    const { events, recorder } = collect()
    const throwing: VerificationBranchSpec = {
      regionId: 'region-boom',
      nodeKey: 'branchBoom',
      delayMs: 5,
      failFirstAttempts: 0,
      maxAttempts: 1,
      throwOnAttempt: 1,
    }
    await expect(
      buildVerificationGraph([FAST, throwing], recorder).invoke({ runId: 'run-3', request: '异常路径' }),
    ).rejects.toThrow(/异常（注入）/)
    expect(events.filter(e => e.type === 'finalCheck').length).toBe(0)
  })

  it('等待取消：abort 后 invoke 拒绝，finalCheck 从未运行', async () => {
    const { events, recorder } = collect()
    const longSlow: VerificationBranchSpec = {
      regionId: 'region-slow',
      nodeKey: 'branchSlow',
      delayMs: 400,
      failFirstAttempts: 0,
      maxAttempts: 1,
    }
    const ac = new AbortController()
    const pending = buildVerificationGraph([FAST, longSlow], recorder).invoke(
      { runId: 'run-4', request: '取消路径' },
      { signal: ac.signal },
    )
    setTimeout(() => ac.abort(), 60)
    await expect(pending).rejects.toBeTruthy()
    expect(events.filter(e => e.type === 'finalCheck').length).toBe(0)
  })
})

describe('mergeKeyedNoLWW reducer（§4.4）', () => {
  type Status = Record<string, { status: 'pass' | 'fail' }>
  it('不同键合并、同键同值幂等', () => {
    const a: Status = { r1: { status: 'pass' } }
    const b: Status = { r2: { status: 'fail' } }
    expect(mergeKeyedNoLWW(a, b)).toEqual({ r1: { status: 'pass' }, r2: { status: 'fail' } })
    expect(mergeKeyedNoLWW(a, { r1: { status: 'pass' } })).toEqual(a)
  })
  it('同键不同值报错（禁止 last-write-wins）', () => {
    const a: Status = { r1: { status: 'pass' } }
    expect(() => mergeKeyedNoLWW(a, { r1: { status: 'fail' } })).toThrow(/键冲突/)
  })
})
