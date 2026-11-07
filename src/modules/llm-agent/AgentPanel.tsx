import { useEffect, useRef, useState } from 'react'
import { agentSession } from './session'
import { usePlan, clearPlan } from './plan'
import { resetTask, selectTask, setLimits, useTaskState } from './taskState'
import { useSceneStore } from '../../core/store'
import { useAgentStore } from './agentStore'
import { useLlmSettingsStore } from '../agent/llmSettings'
import { LlmSettingsModal } from './LlmSettingsModal'
import { AGENT_DENIED, AGENT_TOOLS } from './tools'
import { ClearIcon, SendIcon, StopIcon } from '../../ui/icons'

/**
 * Agent 模块面板（装配点②：左侧插件侧边栏）——聊天式 AI 编辑。
 * 上半：状态 + API 设置入口 + 任务提案卡（接受/拒绝）+ 截图预览；
 * 中部：对话气泡（user/assistant）+ 过程行（工具调用/裁决/错误），流式输出；
 * 底部：输入框（发送/停止/清空）；权限清单与调用日志折叠收纳。
 * 面板同时回答「编辑器给 Agent 开放了什么权限」。
 */
export function AgentPanel() {
  const plan = usePlan()
  const sceneId = useSceneStore(s => s.sceneId)
  const taskState = useTaskState(s => s.task)
  useEffect(() => { selectTask(sceneId) }, [sceneId])
  const transportName = useAgentStore(s => s.transportName)
  const connected = useAgentStore(s => s.connected)
  const chatEnabled = useAgentStore(s => s.chatEnabled)
  const llmBusy = useAgentStore(s => s.llmBusy)
  const permissionMode = useAgentStore(s => s.permissionMode)
  const setPermissionMode = useAgentStore(s => s.setPermissionMode)
  const phase = useAgentStore(s => s.phase)
  const task = useAgentStore(s => s.task)
  const lastScreenshot = useAgentStore(s => s.lastScreenshot)
  const chat = useAgentStore(s => s.chat)
  const log = useAgentStore(s => s.log)
  // 双保险：store 加载层已消毒，这里仍对空值兜底，坏数据不许炸渲染
  const configured = useLlmSettingsStore(
    s => {
      const p = s.profiles.find(x => x.id === s.activeId)
      return (
        (p?.baseURL ?? '').trim() !== '' &&
        (p?.model ?? '').trim() !== '' &&
        (p?.apiKey ?? '').trim() !== ''
      )
    },
  )
  // 多档案：当前生效的那一份（用于面板顶部快速切换）
  const profiles = useLlmSettingsStore(s => s.profiles)
  const activeId = useLlmSettingsStore(s => s.activeId)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(true)

  // 新消息/流式增量时滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [chat])

  const isLoopback = transportName.includes('回环')
  const awaitingVerdict = phase === 'awaiting_user'
  const inputDisabled = !chatEnabled || llmBusy || awaitingVerdict

  const submit = () => {
    const text = input.trim()
    if (!text || inputDisabled) return
    setInput('')
    agentSession.sendChat(text)
  }

  return (
    <div className="agent-panel">
      {/* 状态 + 设置 */}
      <div className="agent-status">
        <span className={`agent-dot${connected ? ' on' : ''}`} />
        <span className="agent-transport" title={transportName}>
          {transportName}
        </span>
        {!connected && (
          <button className="agent-mini-btn" onClick={() => agentSession.reconnect()}>
            重连
          </button>
        )}
        {chatEnabled && (
          <button className="agent-mini-btn" disabled={llmBusy} onClick={() => setSettingsOpen(true)} title="API 设置">
            设置
          </button>
        )}
      </div>

      <details>
        <summary>目标与运行预算</summary>
        <p>{taskState.goal || '发送第一条指令后保存原始目标'}</p>
        {taskState.criteria.length > 0 && <ul>{taskState.criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>}
        <label>最多 API 请求
          <input type="number" min={1} max={300} value={taskState.limits.requests} disabled={llmBusy}
            onChange={e => setLimits({ ...taskState.limits, requests: Number(e.target.value) })} />
        </label>
        <label>运行分钟数
          <input type="number" min={1} max={120} value={taskState.limits.minutes} disabled={llmBusy}
            onChange={e => setLimits({ ...taskState.limits, minutes: Number(e.target.value) })} />
        </label>
        <label>最多工具调用
          <input type="number" min={1} max={2000} value={taskState.limits.tools} disabled={llmBusy}
            onChange={e => setLimits({ ...taskState.limits, tools: Number(e.target.value) })} />
        </label>
        {taskState.checkpoint && <p>
          已运行 {taskState.checkpoint.requests} 次请求、{taskState.checkpoint.tools} 次工具调用。
          {taskState.checkpoint.reason}
        </p>}
        <button disabled={llmBusy || phase !== 'idle' || !sceneId} onClick={() => {
          resetTask()
          if (sceneId) clearPlan(sceneId)
          agentSession.clearChat()
        }}>新建目标</button>
      </details>

      {plan.length > 0 && (
        <details open>
          <summary>场景计划 {plan.filter(step => step.status === 'done').length}/{plan.length}</summary>
          <ol>{plan.map(step => (
            <li key={step.id}>{({ pending: '待执行', active: '进行中', done: '完成', blocked: '受阻' })[step.status]} · {step.title}
              {step.acceptance && <div>验收条件 · {step.acceptance}</div>}
              {step.evidence && <div>{step.evidence}</div>}
            </li>
          ))}</ol>
        </details>
      )}

      {/* 档案快速切换（多档案：立即切到对应那一份的 baseURL/Key/模型） */}
      {chatEnabled && profiles.length > 0 && (
        <select
          className="agent-profile-select"
          value={activeId}
          disabled={llmBusy}
          onChange={e => useLlmSettingsStore.getState().selectProfile(e.target.value)}
          title="当前使用的 API 档案"
        >
          {profiles.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.model || '未填模型'}
            </option>
          ))}
        </select>
      )}

      {/* 未配置 API 引导（仅浏览器直连模式） */}
      {chatEnabled && !configured && (
        <button className="agent-setup-btn" onClick={() => setSettingsOpen(true)}>
          先配置模型 API —— 点击设置（OpenAI / Claude / Gemini / DeepSeek / GLM / …）
        </button>
      )}

      {/* 任务卡：提案执行 / 等待裁决 */}
      {task && (
        <div className={`agent-task${awaitingVerdict ? ' verdict' : ''}`}>
          <span className="agent-task-tag">{awaitingVerdict ? '待裁决' : '提案'}</span>
          <div className="agent-task-label">{task.label}</div>
          <div className="agent-task-meta">
            读 {task.reads} · 写 {task.writes}
            {phase === 'task' && <span className="muted"> · 执行中，人工编辑已暂停</span>}
          </div>
          {awaitingVerdict && (
            <div className="agent-task-btns">
              <button className="agent-accept" onClick={() => agentSession.accept()}>
                接受（入账）
              </button>
              <button className="agent-reject" onClick={() => agentSession.reject()}>
                拒绝（回滚）
              </button>
            </div>
          )}
        </div>
      )}

      {/* 最近一次无 UI 截图 */}
      {lastScreenshot && (
        <img
          className="agent-shot"
          src={lastScreenshot}
          alt="Agent 最近截图"
          title="viewport.screenshot（无UI截图）"
        />
      )}

      {/* 对话区 */}
      <div className="agent-chat" ref={listRef} onScroll={e => {
        const el = e.currentTarget
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
      }}>
        {chat.length === 0 && (
          <div className="agent-chat-empty">
            {'还没有对话。\n例如：把长桌向北移动 0.5 米，别挡住门。'}
          </div>
        )}
        {chat.map(m =>
          m.role === 'note' ? (
            <div key={m.id} className="agent-chat-note">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`agent-chat-row ${m.role}`}>
              <div className={`agent-bubble ${m.role === 'user' ? 'user' : 'ai'}`}>
                {m.text}
                {m.streaming && <span className="agent-cursor">▌</span>}
              </div>
            </div>
          ),
        )}
      </div>

      {/* 权限模式：变更前确认 / 自动编辑 */}
      {chatEnabled && (
        <div className="agent-mode-row">
          <button
            className={permissionMode === 'confirm' ? 'on' : ''}
            disabled={llmBusy}
            onClick={() => setPermissionMode('confirm')}
            title="Agent 的每项改动先预览，人工点「接受」才入账"
          >
            预览后确认
          </button>
          <button
            className={permissionMode === 'auto' ? 'on' : ''}
            disabled={llmBusy}
            onClick={() => setPermissionMode('auto')}
            title="Agent 的改动直接入账并自动保存"
          >
            自动编辑
          </button>
        </div>
      )}

      {/* 输入区 */}
      {chatEnabled && (
        <div className="agent-input-row">
          <textarea
            className="agent-input"
            value={input}
            disabled={inputDisabled}
            rows={2}
            placeholder={
              awaitingVerdict
                ? '等待你对提案的裁决…'
                : llmBusy
                  ? '生成中…'
                  : '输入指令，回车发送'
            }
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
            }}
          />
          {llmBusy ? (
            <button className="agent-mini-btn stop" onClick={() => agentSession.abortChat()} title="停止生成" aria-label="停止生成">
              <StopIcon />
            </button>
          ) : (
            <button className="agent-mini-btn send" disabled={inputDisabled} onClick={submit} title="发送" aria-label="发送">
              <SendIcon />
            </button>
          )}
          <button
            className="agent-mini-btn"
            disabled={llmBusy}
            onClick={() => agentSession.clearChat()}
            title="清空对话"
            aria-label="清空对话"
          >
            <ClearIcon />
          </button>
        </div>
      )}

      {/* 权限与日志（折叠收纳） */}
      <details className="agent-section">
        <summary>权限清单（开放 {AGENT_TOOLS.length} 项）</summary>
        <ul className="agent-tools">
          {AGENT_TOOLS.map(t => (
            <li key={t.name} className={t.access}>
              <span className="agent-tool-access">{t.access === 'read' ? '读' : t.access === 'write' ? '写' : t.access === 'generate' ? '生成' : '导出'}</span>
              <span className="agent-tool-body">
                <code>{t.name}</code>
                <span className="agent-tool-summary">{t.summary}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="agent-denied-title">不开放</div>
        <ul className="agent-denied">
          {AGENT_DENIED.map(d => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      </details>

      <details className="agent-section">
        <summary>调用日志</summary>
        <ul className="agent-log">
          {[...log].reverse().map(l => (
            <li key={l.id} className={l.kind}>
              {l.text}
            </li>
          ))}
        </ul>
      </details>

      {isLoopback && (
        <button className="agent-demo-btn" onClick={() => agentSession.runDemo()}>
          运行演示任务（读场景 → 截图 → 提案修改）
        </button>
      )}

      {settingsOpen && <LlmSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
