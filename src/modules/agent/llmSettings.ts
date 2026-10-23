import { create } from 'zustand'

/**
 * LLM 接入设置（浏览器直连模式）。
 * 三种接入方式（wire 协议）：openai-chat（/chat/completions）、
 * openai-response（/responses）、anthropic（/v1/messages）。
 * 预设覆盖常见厂商；模型名只是建议值，可自由输入（各厂 API 迭代快）。
 * 设置持久化到 localStorage —— API Key 只存在本浏览器，不经过任何服务器。
 */

export type LlmProtocol = 'openai-chat' | 'openai-response' | 'anthropic'

export interface LlmProviderPreset {
  id: string
  name: string
  baseURL: string
  protocol: LlmProtocol
  /** 常见模型（建议值，可自由输入其他型号） */
  models: string[]
  /** 获取 API Key 的入口 */
  keyUrl?: string
  note?: string
}

export const LLM_PROTOCOLS: Array<{ id: LlmProtocol; name: string; desc: string }> = [
  { id: 'openai-chat', name: 'OpenAI Chat', desc: '/chat/completions（兼容面最广，多数国产厂商用此协议）' },
  { id: 'openai-response', name: 'OpenAI Response', desc: '/responses（OpenAI 新一代接口）' },
  { id: 'anthropic', name: 'Anthropic', desc: '/v1/messages（Claude 系）' },
]

export const LLM_PROVIDERS: readonly LlmProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    protocol: 'openai-chat',
    models: ['gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com',
    protocol: 'anthropic',
    models: ['claude-sonnet-4.5', 'claude-opus-4.5', 'claude-haiku-4.5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: '浏览器直连已自动附带 anthropic-dangerous-direct-browser-access 头',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai-chat',
    models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
    note: '走 Google 官方 OpenAI 兼容端点',
  },
  {
    id: 'grok',
    name: 'Grok',
    baseURL: 'https://api.x.ai/v1',
    protocol: 'openai-chat',
    models: ['grok-4.5', 'grok-4.1-fast', 'grok-4'],
    keyUrl: 'https://console.x.ai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    protocol: 'openai-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen',
    name: 'Qwen 通义',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai-chat',
    models: ['qwen3-max', 'qwen-max', 'qwen-plus'],
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'glm',
    name: 'GLM 智谱',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai-chat',
    models: ['glm-5.3', 'glm-5', 'glm-4.6'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'kimi',
    name: 'Kimi 月之暗面',
    baseURL: 'https://api.moonshot.cn/v1',
    protocol: 'openai-chat',
    models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2'],
    keyUrl: 'https://platform.kimi.ai',
    note: '也兼容 Anthropic 协议，可在接入方式中切换',
  },
  {
    id: 'mimo',
    name: 'Xiaomi MiMo',
    baseURL: 'https://api.xiaomi.com/v1',
    protocol: 'openai-chat',
    models: ['MiMo-V2-Pro', 'MiMo-V2'],
    keyUrl: 'https://platform.xiaomimimo.com',
    note: 'OpenAI 兼容；文档见 mimo.mi.com',
  },
  { id: 'custom', name: '自定义', baseURL: '', protocol: 'openai-chat', models: [] },
]

export interface LlmSettings {
  provider: string
  protocol: LlmProtocol
  baseURL: string
  apiKey: string
  model: string
  /** 视觉回传：截图作为工具结果附图发给模型（viewport.pick 视觉点选的前提；需多模态模型） */
  sendImages: boolean
}

const STORAGE_KEY = 'agent-llm-settings-v1'

const PROTOCOLS = new Set<string>(['openai-chat', 'openai-response', 'anthropic'])

/**
 * 逐字段消毒后再合并：localStorage 里的旧数据/异常写入（字段为 null、
 * 类型不对、协议值非法）一律丢弃该字段，绝不让坏数据进 store——
 * 否则 AgentPanel 的 selector 会在渲染期抛错，整页崩成错误边界。
 */
function loadSaved(): Partial<LlmSettings> {
  let raw: unknown = null
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null) return {}
  const o = raw as Record<string, unknown>
  const clean: Partial<LlmSettings> = {}
  if (typeof o.provider === 'string' && o.provider) clean.provider = o.provider
  if (typeof o.protocol === 'string' && PROTOCOLS.has(o.protocol)) {
    clean.protocol = o.protocol as LlmProtocol
  }
  if (typeof o.baseURL === 'string') clean.baseURL = o.baseURL
  if (typeof o.apiKey === 'string') clean.apiKey = o.apiKey
  if (typeof o.model === 'string') clean.model = o.model
  if (typeof o.sendImages === 'boolean') clean.sendImages = o.sendImages
  return clean
}

// 默认预选 GLM（智谱），国内可达且本仓库作者常用；可随时在设置里换
const glmPreset = LLM_PROVIDERS.find(p => p.id === 'glm')!

interface LlmSettingsState extends LlmSettings {
  /** 更新并持久化 */
  apply(patch: Partial<LlmSettings>): void
  /** 套用厂商预设（保留 API Key） */
  applyProvider(presetId: string): void
}

const DEFAULTS: LlmSettings = {
  provider: glmPreset.id,
  protocol: glmPreset.protocol,
  baseURL: glmPreset.baseURL,
  apiKey: '',
  model: glmPreset.models[0] ?? '',
  sendImages: true,
}

export const useLlmSettingsStore = create<LlmSettingsState>((set, get) => ({
  ...DEFAULTS,
  ...loadSaved(),
  apply(patch) {
    set(patch)
    const { provider, protocol, baseURL, apiKey, model, sendImages } = get()
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ provider, protocol, baseURL, apiKey, model, sendImages }))
    } catch {
      /* 隐私模式等场景写不进就算了 */
    }
  },
  applyProvider(presetId) {
    const preset = LLM_PROVIDERS.find(p => p.id === presetId)
    if (!preset) return
    get().apply({ provider: presetId, protocol: preset.protocol, baseURL: preset.baseURL })
  },
}))

/** 聊天可用前提：地址、模型、Key 齐备 */
export function isLlmConfigured(): boolean {
  const s = useLlmSettingsStore.getState()
  return s.baseURL.trim() !== '' && s.model.trim() !== '' && s.apiKey.trim() !== ''
}
