/**
 * CoAgentPanel（W03 最小版 + W06 分区 + W06.5 进度投影）。
 *
 * 结构（按用户视角从上到下）：
 *   1. 状态行（相位 / 事件数）
 *   2. 运行反馈（错误或上一轮结果，紧贴操作区，避免"点了没反应"）
 *   3. 进度（百分比 / 阶段 / 当前动作 / 可折叠执行明细）
 *   4. 分区（模型状态、生成、俯视示意、归属修正）
 *   5. 布局指令 + 开始/取消（按钮为什么不可点会写出来）
 *
 * 样式复用宿主既有 agent-* 类；进度条与分区 SVG 用内联样式，不扩展全局 CSS。
 */

import { useEffect, useState } from 'react'
import { composeClarifiedRequest, isUsableAnswer } from './clarify'
import type { CoAgentPhase } from './contracts'
import { PartitionPreview, RunProgress } from './CoAgentProgress'
import type { PartitionReport } from './services/partition'
import type { PartitionPersistenceState } from './services/partitionPersistence'
import { useCoAgentModule } from './useCoAgentModule'
import { useCoAgentStore } from './uiStore'

const PHASE_TEXT: Record<CoAgentPhase, string> = {
  disabled: '已停用',
  initializing: '初始化',
  idle: '空闲',
  preprocessing: '分区预处理',
  planning: '规划',
  awaiting_clarification: '等待澄清',
  baselining: '取证基线',
  executing: '执行中',
  validating: '判定中',
  committing: '提交中',
  completed: '已完成',
  retained: '已保留（有未通过项）',
  cancelling: '取消中',
  rolled_back: '已回滚',
  failed: '失败',
  error_locked: '错误锁定',
}

/** P4：把分区持久化状态翻成一句人话（"没有文件"与"读取失败"必须区分） */
function persistenceText(state: PartitionPersistenceState): string {
  switch (state.status) {
    case 'loading':
      return '读取中…'
    case 'absent':
      return '尚未保存（首次使用属正常）'
    case 'ready':
      return `已恢复（${state.report.fingerprintMatch ? '内容一致' : '场景已变化，已按当前场景核对'}）`
    case 'needs_review':
      return `已恢复，但有 ${state.issues.length} 项待核对——${state.issues.slice(0, 2).join('；')}`
    case 'invalid':
      return `不可用（已保留原文件）：${state.issues.slice(0, 2).join('；')}`
    case 'load_failed':
      return `读取失败：${state.message}`
    case 'save_failed':
      return `保存失败：${state.message}`
    default:
      return '未检查'
  }
}

/** 同一份状态的语气：好 / 待看 / 坏（用来上色，不重复文案） */
function persistenceTone(state: PartitionPersistenceState): '' | 'ok' | 'warn' | 'bad' {
  switch (state.status) {
    case 'ready':
      return 'ok'
    case 'needs_review':
      return 'warn'
    case 'invalid':
    case 'load_failed':
    case 'save_failed':
      return 'bad'
    default:
      return ''
  }
}

export function CoAgentPanel(props: { coagent: ReturnType<typeof useCoAgentModule> }) {  const { coagent } = props
  const [request, setRequest] = useState('')
  const [running, setRunning] = useState(false)
  const lastResult = useCoAgentStore(s => s.lastResult)
  const lastError = useCoAgentStore(s => s.lastError)
  const eventCount = useCoAgentStore(s => s.eventCount)
  const events = useCoAgentStore(s => s.events)
  const pendingClarify = useCoAgentStore(s => s.pendingClarify)
  // 分区预处理事件（runId=preprocess）不算 run 进度，否则会出现"0% 已停止"
  const runEvents = events.filter(e => e.runId !== 'preprocess')
  const [clarifyAnswer, setClarifyAnswer] = useState('')

  const locked = coagent.locked
  const busy = coagent.busy || running
  const runtime = coagent.runtime
  const model = runtime?.modelStatus()

  // ---- W06：分区状态 ----
  const [partitioning, setPartitioning] = useState(false)
  const [report, setReport] = useState<PartitionReport | null>(null)
  const [preError, setPreError] = useState<string | null>(null)
  const [partition, setPartition] = useState(runtime?.partition() ?? null)
  const regionNames = partition?.regions.map(r => r.id) ?? []

  // 分区可能来自：生成、人工修正、dev harness 注入 —— 统一由 runtime 订阅同步，
  // 否则"注入了分区但按钮仍然不可用"这种 UI/运行时脱节会很难查。
  useEffect(() => {
    if (!runtime) return
    setPartition(runtime.partition())
    return runtime.onPartition(p => setPartition(p))
  }, [runtime])

  const onPreprocess = () => {
    if (!runtime) return
    setPartitioning(true)
    setPreError(null)
    // 分区不是一次 run：清掉上一轮的进度/结果，避免"0% 已停止"挂在分区操作上
    const s = useCoAgentStore.getState()
    s.setEvents([])
    s.setResult(null)
    s.setError(null)
    void runtime
      .preprocess()
      .then(res => {
        setReport(res.report)
        setPartition(res.partition)
      })
      .catch(e => setPreError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPartitioning(false))
  }

  const onFix = (objectId: string, target: { regionId: string } | { readonly: true }) => {
    try {
      const next = runtime?.applyPartitionFix(objectId, target)
      if (next) setPartition(next)
    } catch (e) {
      setPreError(e instanceof Error ? e.message : String(e))
    }
  }

  // W07：回答澄清 → 拼回原请求，重新规划（同一诉求的补充，不是新对话）
  const onSubmitClarify = (answer: string) => {
    if (!pendingClarify || busy) return
    const composed = composeClarifiedRequest(pendingClarify.originalRequest, answer)
    setRequest(composed)
    setClarifyAnswer('')
    useCoAgentStore.getState().setPendingClarify(null)
    setRunning(true)
    void coagent
      .start(composed)
      .catch(e => useCoAgentStore.getState().setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false))
  }

  // ---- 开始/取消与"为什么不能点" ----
  const blockedReason = locked
    ? '运行时已锁定（error_locked），请先重置'
    : coagent.phase === 'preprocessing' || partitioning
      ? '正在生成分区'
      : busy
        ? '正在运行'
        : coagent.phase === 'disabled'
          ? '插件已停用'
          : !request.trim()
            ? '先输入一句布局指令'
            : !partition
              ? '先点「生成分区」并确认归属（或在开发模式下注入测试分区）'
              : null
  const canStart = blockedReason === null
  // 只在"真正的 run"期间或已有 run 事件时显示进度；分区生成不算 run
  const showRunProgress = (busy && coagent.phase !== 'preprocessing') || runEvents.length > 0

  const onStart = () => {
    if (!canStart) return
    setRunning(true)
    void coagent
      .start(request.trim())
      .catch(e => useCoAgentStore.getState().setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false))
  }

  return (
    <div className="agent-panel coagent-panel" data-partition={partition ? String(partition.partitionVersion) : 'none'}>
      <div className="agent-status">
        <span className={`agent-dot${busy ? ' on' : ''}`} />
        <span className="agent-transport">
          状态：{PHASE_TEXT[coagent.phase]}
          {busy && ' …'}
        </span>
        {eventCount > 0 && (
          <span className="sheet-meta" title="本轮已记录的事件数">
            EVT / {String(eventCount).padStart(2, '0')}
          </span>
        )}
      </div>

      {(lastError || lastResult) && (
        <div className={lastError ? 'agent-denied' : 'agent-chat-note'}>
          {lastError
            ? `！${lastError}`
            : lastResult?.kind === 'undone'
              ? `↶ ${lastResult.summary ?? '已撤销本轮修改'}`
              : lastResult?.kind === 'completed'
                ? `✓ ${lastResult.summary ?? '已完成'}`
                : lastResult?.kind === 'retained_with_issues'
                  ? `！ 改动已保留，存在未通过项（${lastResult.issueCount ?? 0} 项）：${lastResult.summary ?? ''}`
                  : lastResult?.kind === 'rolled_back'
                    ? `↺ 已回滚${lastResult.code ? `（${lastResult.code}${lastResult.stage ? ` @${lastResult.stage}` : ''}）` : ''}：${lastResult.reason ?? ''}`
                    : lastResult?.kind === 'cancelled'
                      ? '已取消并回滚'
                      : '需要澄清（见下方问答）'}
          {/* P3：只有本轮真的产生了可撤销历史、且仍是栈顶时才给按钮 */}
          {coagent.canUndoLastRun && (lastResult?.kind === 'completed' || lastResult?.kind === 'retained_with_issues') && (
            <div className="agent-input-row">
              <button className="agent-mini-btn" disabled={busy} onClick={() => coagent.undoLastRun()}>
                撤销本轮修改
              </button>
            </div>
          )}
        </div>
      )}

      {showRunProgress && <RunProgress events={runEvents} phase={coagent.phase} busy={busy} />}

      {locked && (
        <div className="agent-section">
          <div className="agent-denied">{lastError ?? '上一轮回滚失败，运行时已锁定：请查看日志、确认场景状态后重置'}</div>
          <div className="agent-input-row">
            <button className="agent-mini-btn" onClick={() => coagent.reset()}>
              重置（解除锁定）
            </button>
          </div>
        </div>
      )}

      <div className="agent-section">
        <div className="panel-label">分区</div>
        <dl className="kv">
          <dt>模型</dt>
          <dd className={`mono${model ? (model.configured ? ' ok' : ' warn') : ' bad'}`}>
            {model ? (model.configured ? model.summary : '未配置') : 'runtime 未就绪'}
          </dd>
          <dt>分区文件</dt>
          <dd className={persistenceTone(coagent.partitionPersistence)}>
            {persistenceText(coagent.partitionPersistence)}
          </dd>
        </dl>
        {model && !model.configured && (
          <div className="agent-chat-note">去「AI 编辑 → 设置」填 baseURL / Key / 模型名后，才能生成分区。</div>
        )}
        <div className="cp-actions">
          <button
            className="agent-mini-btn"
            disabled={!runtime || partitioning || busy || !model?.configured}
            onClick={onPreprocess}
            title="用鸟瞰图让 VLM 自动划分可用区域"
          >
            {partitioning ? '生成中…' : '生成分区'}
          </button>
          <button className="agent-mini-btn" disabled={!runtime || busy} onClick={() => void coagent.restorePartition()}>
            恢复已保存
          </button>
          <button className="agent-mini-btn" disabled={!runtime || busy || !partition} onClick={() => void coagent.savePartition()}>
            保存分区
          </button>
        </div>
        {partition && (
          <>
            <div className="agent-chat-note">
              分区 v{partition.partitionVersion}：
              {partition.regions.map(r => `${r.name}(${r.objectIds.length})`).join(' / ')}
              {partition.globalReadonlyObjectIds.length > 0 ? `；只读 ${partition.globalReadonlyObjectIds.length}` : ''}
            </div>
            <PartitionPreview partition={partition} />
          </>
        )}
        {report && report.issues.length > 0 && <div className="agent-denied">{report.issues.slice(0, 5).join('；')}</div>}
        {report && (report.ambiguous.length > 0 || report.unassigned.length > 0) && (
          <div className="agent-chat-note">
            <div>需要人工归属（点区域名归入，或标只读）：</div>
            {report.ambiguous.slice(0, 6).map(it => (
              <div key={it.objectId}>
                {it.objectId}{' '}
                {it.regionIds.map(rid => (
                  <button key={rid} className="agent-mini-btn" onClick={() => onFix(it.objectId, { regionId: rid })}>
                    {rid}
                  </button>
                ))}
                <button className="agent-mini-btn" onClick={() => onFix(it.objectId, { readonly: true })}>
                  只读
                </button>
              </div>
            ))}
            {report.unassigned.slice(0, 6).map(id => (
              <div key={id}>
                {id}{' '}
                {regionNames.map(rid => (
                  <button key={rid} className="agent-mini-btn" onClick={() => onFix(id, { regionId: rid })}>
                    {rid}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {preError && <div className="agent-denied">{preError}</div>}
      </div>

      {pendingClarify && (
        <div className="agent-section">
          <div className="panel-label">需要澄清</div>
          <div className="agent-chat-note">{pendingClarify.question}</div>
          {pendingClarify.options.length > 0 && (
            <div className="agent-input-row" style={{ flexWrap: 'wrap' }}>
              {pendingClarify.options.map(opt => (
                <button key={opt} className="agent-mini-btn" disabled={busy} onClick={() => onSubmitClarify(opt)}>
                  {opt}
                </button>
              ))}
            </div>
          )}
          <input
            className="agent-input"
            value={clarifyAnswer}
            disabled={busy}
            placeholder="或直接输入补充说明（例如：按 3 米间距拉稀疏）"
            onChange={e => setClarifyAnswer(e.target.value)}
          />
          <div className="agent-input-row">
            <button className="agent-mini-btn send" disabled={busy || !isUsableAnswer(clarifyAnswer)} onClick={() => onSubmitClarify(clarifyAnswer)}>
              提交补充并继续
            </button>
          </div>
        </div>
      )}

      <div className="agent-section">
        <div className="panel-label">布局指令</div>
        <textarea
          className="agent-input"
          rows={3}
          value={request}
          disabled={busy}
          placeholder={'例如：把北边林地拉稀疏一点，南区空地加两块石头'}
          onChange={e => setRequest(e.target.value)}
        />
        <div className="agent-input-row">
          <button className="agent-mini-btn send" disabled={!canStart} onClick={onStart} title={blockedReason ?? undefined}>
            开始
          </button>
          <button className="agent-mini-btn stop" disabled={!busy} onClick={() => void coagent.cancel()}>
            取消
          </button>
        </div>
        {blockedReason && <div className="agent-chat-note">开始按钮不可用：{blockedReason}</div>}
        {busy && <div className="agent-chat-note">运行中：进度与执行明细见上方「进度」。</div>}
      </div>
    </div>
  )
}
