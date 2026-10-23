/**
 * W02 浏览器验证页脚本（通过 Vite dev server 在真实浏览器跑）。
 *
 * 只 import workflow 构建器（不直接 import @langchain/langgraph——依赖规则
 * "LangGraph 导入只允许出现在 workflow" 对测试页同样成立）。场景与 Node 集成
 * 测试一一对应，结果渲染进 DOM 并挂到 window.__w02 供自动化读取。
 */

import type { RunInput } from '../../contracts'
import { createWorkflow } from '../../workflow/createWorkflow'
import { buildVerificationGraph, type VerificationEvent } from '../../workflow/verificationGraph'
import { createFakeWorkflowContext } from '../fakes/fakeContext'
import { makeTwoRegionPartition } from '../fixtures/twoRegionScene'

interface CaseResult {
  name: string
  pass: boolean
  detail: Record<string, unknown>
}

const FAST = { regionId: 'region-fast', nodeKey: 'branchFast', delayMs: 15, failFirstAttempts: 0, maxAttempts: 1 }
const SLOW_REPAIR = { regionId: 'region-slow', nodeKey: 'branchSlow', delayMs: 60, failFirstAttempts: 1, maxAttempts: 3 }

async function caseTopology(): Promise<CaseResult> {
  const events: VerificationEvent[] = []
  const out = await buildVerificationGraph([FAST, SLOW_REPAIR], e => events.push(e)).invoke({ runId: 'w02b-1' })
  const slowAttempts = events.filter(e => e.type === 'attempt' && e.regionId === 'region-slow')
  const fastDone = events.find(e => e.type === 'attempt' && e.regionId === 'region-fast')!
  const finalChecks = events.filter(e => e.type === 'finalCheck')
  const pass =
    out.finalCheckRuns === 1 &&
    Object.keys(out.regionResults).length === 2 &&
    slowAttempts.length === 2 &&
    slowAttempts[1].at >= fastDone.at &&
    finalChecks.length === 1
  return {
    name: '拓扑：双分支乱序完成 + 修正循环 + finalCheck 恰好一次',
    pass,
    detail: {
      finalCheckRuns: out.finalCheckRuns,
      regions: Object.keys(out.regionResults),
      slowAttempts: slowAttempts.length,
      unordered: slowAttempts.length > 0 && slowAttempts[slowAttempts.length - 1].at >= fastDone.at,
    },
  }
}

async function caseExhaustedFailure(): Promise<CaseResult> {
  const events: VerificationEvent[] = []
  let rejected = false
  try {
    await buildVerificationGraph(
      [FAST, { ...SLOW_REPAIR, failFirstAttempts: 99, maxAttempts: 2 }],
      e => events.push(e),
    ).invoke({ runId: 'w02b-2' })
  } catch {
    rejected = true
  }
  const fc = events.filter(e => e.type === 'finalCheck')
  return {
    name: '某支终局失败：invoke 拒绝、finalCheck 未通过',
    pass: rejected && fc.length === 1 && fc[0].type === 'finalCheck' && fc[0].passed === false,
    detail: { rejected, finalChecks: fc.length },
  }
}

async function caseAbort(): Promise<CaseResult> {
  const events: VerificationEvent[] = []
  const ac = new AbortController()
  const pending = buildVerificationGraph(
    [FAST, { ...SLOW_REPAIR, delayMs: 500 }],
    e => events.push(e),
  ).invoke({ runId: 'w02b-3' }, { signal: ac.signal })
  setTimeout(() => ac.abort(), 60)
  let rejected = false
  let errName = ''
  try {
    await pending
  } catch (e) {
    rejected = true
    errName = (e as Error)?.name ?? (e as Error)?.constructor?.name ?? 'unknown'
  }
  const finalChecks = events.filter(e => e.type === 'finalCheck').length
  return {
    name: '等待取消：abort 后拒绝、finalCheck 未运行',
    pass: rejected && finalChecks === 0,
    detail: { rejected, errName, finalChecks },
  }
}

async function caseRunnerShell(): Promise<CaseResult> {
  const ctx = createFakeWorkflowContext()
  const input: RunInput = {
    runId: 'w02b-shell',
    request: '把村子整理一下',
    partition: makeTwoRegionPartition(),
    sceneRevisionAtStart: 1,
  }
  const outcome = await createWorkflow().run(input, ctx)
  const started = ctx.events.filter(e => e.type === 'run.started').length
  return {
    name: 'WorkflowRunner 外壳：completed、两区结果、run.started、场景零修改',
    pass:
      outcome.kind === 'completed' &&
      Object.keys(outcome.kind === 'completed' ? outcome.regions : {}).length === 2 &&
      started === 1 &&
      ctx.fakeEditor.state().assetCount === 5,
    detail: { outcomeKind: outcome.kind, started, assets: ctx.fakeEditor.state().assetCount },
  }
}

async function main(): Promise<void> {
  const cases = [caseTopology, caseExhaustedFailure, caseAbort, caseRunnerShell]
  const results: CaseResult[] = []
  for (const c of cases) {
    try {
      results.push(await c())
    } catch (e) {
      results.push({ name: c.name, pass: false, detail: { exception: String(e) } })
    }
  }
  const container = document.getElementById('cases')!
  for (const r of results) {
    const div = document.createElement('div')
    div.className = `case ${r.pass ? 'pass' : 'fail'}`
    const h = document.createElement('h2')
    h.textContent = `${r.pass ? '✓ PASS' : '✗ FAIL'} ${r.name}`
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(r.detail)
    div.append(h, pre)
    container.append(div)
  }
  const allPassed = results.every(r => r.pass)
  const heading = document.querySelector('h1')!
  heading.textContent += allPassed ? ' —— 全部通过' : ' —— 存在失败'
  ;(window as unknown as { __w02: unknown }).__w02 = {
    done: true,
    allPassed,
    userAgent: navigator.userAgent,
    results,
  }
}

void main()
