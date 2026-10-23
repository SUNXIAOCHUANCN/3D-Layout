import { useState } from 'react'
import { testLlmConnection } from './llmClient'
import { LLM_PROTOCOLS, LLM_PROVIDERS, useLlmSettingsStore } from './llmSettings'
import type { LlmProtocol, LlmSettings } from './llmSettings'

/**
 * API 设置窗口（新窗口级浮层）：接入方式（OpenAI Chat / OpenAI Response / Anthropic）
 * + 服务商预设（9 家 + 自定义）+ Base URL / API Key / 模型，附测试连接。
 * 保存进 localStorage（Key 只存本浏览器）。模型输入框带 datalist 建议但可自由输入。
 */
export function LlmSettingsModal(props: { onClose: () => void }) {
  const saved = useLlmSettingsStore()
  const [draft, setDraft] = useState<LlmSettings>({
    provider: saved.provider,
    protocol: saved.protocol,
    baseURL: saved.baseURL,
    apiKey: saved.apiKey,
    model: saved.model,
    sendImages: saved.sendImages,
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  const preset = LLM_PROVIDERS.find(p => p.id === draft.provider)
  const modelOptions = preset?.models ?? []
  const canSave = draft.baseURL.trim() !== '' && draft.model.trim() !== ''

  const patch = (p: Partial<LlmSettings>) => {
    setTestResult(null)
    setDraft(d => ({ ...d, ...p }))
  }

  const pickProvider = (id: string) => {
    const p = LLM_PROVIDERS.find(x => x.id === id)
    if (!p) return
    patch({
      provider: id,
      protocol: p.protocol,
      baseURL: p.baseURL,
      model: p.models.includes(draft.model) || id === 'custom' ? draft.model : (p.models[0] ?? ''),
    })
  }

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await testLlmConnection(draft))
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  const save = () => {
    useLlmSettingsStore.getState().apply(draft)
    props.onClose()
  }

  return (
    <div className="modal-mask" onClick={e => { if (e.target === e.currentTarget) props.onClose() }}>
      <div className="modal llm-modal">
        <div className="modal-title">AI 编辑 · API 设置</div>
        <div className="llm-form">
          <div className="llm-label">服务商</div>
          <div className="llm-providers">
            {LLM_PROVIDERS.map(p => (
              <button
                key={p.id}
                className={`llm-chip${draft.provider === p.id ? ' on' : ''}`}
                onClick={() => pickProvider(p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="llm-label">接入方式</div>
          <select
            className="llm-input"
            value={draft.protocol}
            onChange={e => patch({ protocol: e.target.value as LlmProtocol })}
          >
            {LLM_PROTOCOLS.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.desc}
              </option>
            ))}
          </select>

          <div className="llm-label">Base URL</div>
          <input
            className="llm-input"
            value={draft.baseURL}
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
            value={draft.apiKey}
            placeholder="sk-… 仅保存在本浏览器 localStorage"
            onChange={e => patch({ apiKey: e.target.value })}
          />

          <div className="llm-label">模型（可自由输入）</div>
          <input
            className="llm-input"
            list="llm-model-list"
            value={draft.model}
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
              checked={draft.sendImages}
              onChange={e => patch({ sendImages: e.target.checked })}
            />
            截图回传给模型（视觉点选，需多模态模型）
          </label>

          {preset?.note && <div className="llm-note">{preset.note}</div>}

          <div className="llm-test-row">
            <button className="llm-test-btn" disabled={testing || !canSave} onClick={() => void runTest()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && (
              <span className={testResult.ok ? 'llm-test-ok' : 'llm-test-err'} title={testResult.message}>
                {testResult.ok ? '✓' : '✗'} {testResult.message}
              </span>
            )}
          </div>
          <div className="llm-hint">
            模型名是建议值，各厂迭代快，可直接输入任意型号。浏览器直连需服务商允许跨域（CORS），
            失败时可换接入方式或改走代理；全部流量只在 你的浏览器 与 模型商 之间。
          </div>
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
