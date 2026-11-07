import { useState } from 'react'
import { usesGoRelay } from '../llm-shared/request'
import { testLlmConnection } from './llmClient'
import {
  createProfileFromPreset,
  duplicateProfile,
  LLM_PROTOCOLS,
  LLM_PROVIDERS,
  useLlmSettingsStore,
} from '../agent/llmSettings'
import type { LlmProtocol, LlmProfile } from '../agent/llmSettings'

/**
 * API 设置窗口（新窗口级浮层）：**多档案**管理 —— 左侧档案列表，右侧当前档案的编辑器。
 *
 * 每份档案 = 一套独立的 baseURL / API Key / 模型；列表里点选即编辑该档案，
 * 「设为当前」决定 AI 编辑聊天与 CoAgent 实际用哪一份（阶段 A：手动切换，不做按用途路由）。
 *
 * 接入方式（OpenAI Chat / OpenAI Response / Anthropic）+ 服务商预设（含 OpenCode Go 和自定义）
 * + Base URL / API Key / 模型，附测试连接。
 * 保存进 localStorage（Key 只存本浏览器）。模型输入框带 datalist 建议但可自由输入。
 */
export function LlmSettingsModal(props: { onClose: () => void }) {
  const saved = useLlmSettingsStore()
  // 本地草稿：编辑期间不落盘，「保存」时一次性写回（沿用旧版"确认才生效"的语义）
  const [drafts, setDrafts] = useState<LlmProfile[]>(() => saved.profiles.map(p => ({ ...p })))
  const [activeId, setActiveId] = useState<string>(saved.activeId)
  const [editingId, setEditingId] = useState<string>(() => saved.profiles[0]?.id ?? '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const editing = drafts.find(p => p.id === editingId) ?? drafts[0]
  const preset = editing ? LLM_PROVIDERS.find(p => p.id === editing.provider) : undefined
  const modelOptions = preset?.models ?? []
  /** 档案是否填全（地址 + 模型）——未填全的档案会在列表里标出来 */
  const isComplete = (p: LlmProfile): boolean => p.baseURL.trim() !== '' && p.model.trim() !== ''
  /** 只有"当前档案"必须填全：它是实际被使用的那一份；其余半填的档案允许先存着 */
  const canSave = drafts.length > 0 && isComplete(drafts.find(p => p.id === activeId) ?? drafts[0])
  /** 当前正在编辑的档案是否可测（测试只针对正在编辑的那一份） */
  const canTest = editing ? isComplete(editing) : false

  const patch = (p: Partial<LlmProfile>) => {
    setTestResult(null)
    setDrafts(list => list.map(d => (d.id === editingId ? { ...d, ...p } : d)))
  }

  const pickProvider = (id: string) => {
    const p = LLM_PROVIDERS.find(x => x.id === id)
    if (!p || !editing) return
    patch({
      provider: id,
      protocol: p.protocol,
      baseURL: p.baseURL,
      // 换预设保留 API Key（与旧版 applyProvider 行为一致），模型名沿用或取预设首个
      model: p.models.includes(editing.model) || id === 'custom' ? editing.model : (p.models[0] ?? ''),
    })
  }

  const addProfile = (presetId: string) => {
    const p = createProfileFromPreset(presetId)
    setDrafts(list => [...list, p])
    setEditingId(p.id)
    setTestResult(null)
  }

  const removeProfile = (id: string) => {
    // 先算好结果再一次性 setState：不在 setDrafts 的 updater 里调别的 setState
    const next = drafts.filter(p => p.id !== id)
    if (next.length === 0) {
      // 至少留一份：删空了就补一个默认档案
      const fresh = createProfileFromPreset('custom')
      setDrafts([fresh])
      setActiveId(fresh.id)
      setEditingId(fresh.id)
    } else {
      setDrafts(next)
      if (id === activeId) {
        // 删掉的是当前档案 → 顺位到第一份，并切过去
        const fallback = next[0].id
        setActiveId(fallback)
        setEditingId(fallback)
      } else if (id === editingId) {
        setEditingId(next[0].id)
      }
    }
    setTestResult(null)
  }

  const duplicate = () => {
    if (!editing) return
    const copy = duplicateProfile(editing)
    setDrafts(list => [...list, copy])
    setEditingId(copy.id)
    setTestResult(null)
  }

  const runTest = async () => {
    if (!editing) return
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testLlmConnection(editing))
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const save = () => {
    useLlmSettingsStore.getState().saveProfiles(drafts, activeId)
    props.onClose()
  }

  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) props.onClose() }}>
      <div className="modal llm-modal llm-modal-wide">
        <div className="modal-title">场景分区 Agent · 模型设置</div>
        <div className="llm-layout">
          {/* 左：档案列表 */}
          <div className="llm-side">
            <div className="llm-side-title">档案（可存多套服务商）</div>
            <ul className="llm-list">
              {drafts.map(p => {
                const presetName = LLM_PROVIDERS.find(x => x.id === p.provider)?.name ?? p.provider
                return (
                  <li
                    key={p.id}
                    className={`llm-list-item${p.id === editingId ? ' on' : ''}`}
                    onClick={() => { setEditingId(p.id); setTestResult(null) }}
                  >
                    <div className="llm-list-name">
                      {p.name}
                      {p.id === activeId && <span className="llm-badge">使用中</span>}
                      {!isComplete(p) && <span className="llm-badge llm-badge-warn">待填</span>}
                    </div>
                    <div className="llm-list-meta">
                      {presetName} · {p.model || '未填模型'}
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="llm-side-actions">
              <select
                className="llm-input llm-select"
                value=""
                onChange={e => { if (e.target.value) addProfile(e.target.value) }}
                title="新增一份档案"
              >
                <option value="">＋ 新增档案…</option>
                {LLM_PROVIDERS.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 右：档案编辑器 */}
          {editing && (
            <div className="llm-form">
              <div className="llm-label">档案名</div>
              <input
                className="llm-input"
                value={editing.name}
                placeholder="如：工作机 GLM"
                onChange={e => patch({ name: e.target.value })}
              />

              <div className="llm-label">服务商</div>
              <div className="llm-providers">
                {LLM_PROVIDERS.map(p => (
                  <button
                    key={p.id}
                    className={`llm-chip${editing.provider === p.id ? ' on' : ''}`}
                    onClick={() => pickProvider(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>

              <div className="llm-label">接入方式</div>
              <select
                className="llm-input"
                value={editing.protocol}
                onChange={e => patch({ protocol: e.target.value as LlmProtocol })}
              >
                {LLM_PROTOCOLS.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.desc}
                  </option>
                ))}
              </select>

              <div className="llm-note">
                {usesGoRelay(editing) ? '连接方式：本机服务转发（OpenCode Go）' : '连接方式：浏览器直连'}
              </div>
              <div className="llm-label">Base URL</div>
              <input
                className="llm-input"
                value={editing.baseURL}
                placeholder="https://api.example.com/v1"
                onChange={e => patch({ baseURL: e.target.value })}
              />

              <div className="llm-label">
                API Key
                {preset?.keyUrl && (
                  <>
                    {'（'}
                    <a href={preset.keyUrl} target="_blank" rel="noreferrer">
                      获取 Key
                    </a>
                    {'）'}
                  </>
                )}
              </div>
              <input
                className="llm-input"
                type="password"
                value={editing.apiKey}
                placeholder="sk-… 仅保存在本浏览器 localStorage"
                onChange={e => patch({ apiKey: e.target.value })}
              />

              <div className="llm-label">模型（可自由输入）</div>
              <input
                className="llm-input"
                list="llm-model-list"
                value={editing.model}
                placeholder={modelOptions[0] ?? '模型名'}
                onChange={e => patch({ model: e.target.value })}
              />
              <datalist id="llm-model-list">
                {modelOptions.map(m => (
                  <option key={m} value={m} />
                ))}
              </datalist>

              <label className="llm-check" title="把 viewport.screenshot 的截图作为附图发给模型（视觉点选的前提）。纯文本模型请关闭，否则请求可能被拒绝。">
                <input
                  type="checkbox"
                  checked={editing.sendImages}
                  onChange={e => patch({ sendImages: e.target.checked })}
                />
                截图回传给模型（视觉点选，需多模态模型）
              </label>

              {preset?.note && <div className="llm-note">{preset.note}</div>}

              <div className="llm-test-row">
                <button className="llm-test-btn" disabled={testing || !canTest} onClick={() => void runTest()}>
                  {testing ? '测试中…' : '测试连接'}
                </button>
                {testResult && (
                  <span className={testResult.ok ? 'llm-test-ok' : 'llm-test-err'} title={testResult.message}>
                    {testResult.ok ? '✓' : '✗'} {testResult.message}
                  </span>
                )}
              </div>

              <div className="llm-profile-actions">
                <button
                  className="llm-test-btn"
                  disabled={editing.id === activeId || !isComplete(editing)}
                  onClick={() => setActiveId(editing.id)}
                  title="设为当前档案：AI 编辑聊天与 CoAgent 改用这一份"
                >
                  {editing.id === activeId ? '当前使用中' : '设为当前'}
                </button>
                <button className="llm-test-btn" onClick={duplicate} title="复制当前档案（含 Key）">
                  复制
                </button>
                <button className="llm-test-btn llm-danger" onClick={() => removeProfile(editing.id)} title="删除当前档案">
                  删除
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="llm-hint">
          可保存多套服务商配置，各自独立保存 Key；「设为当前」决定实际使用哪一套。
          模型名是建议值，各厂迭代快，可直接输入任意型号。浏览器直连需服务商允许跨域（CORS），
          OpenCode Go 经本机服务转发，密钥不在服务端保存。测试连接成功后，还需验证工具调用及截图能力。
        </div>
        <div className="modal-actions">
          <button onClick={props.onClose}>取消</button>
          <button className="primary" disabled={!canSave} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
