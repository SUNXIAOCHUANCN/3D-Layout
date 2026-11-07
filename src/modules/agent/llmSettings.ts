import { create } from 'zustand'

/**
 * LLM 接入设置（OpenCode Go 本地转发，其他厂商浏览器直连）。
 * 三种接入方式（wire 协议）：openai-chat（/chat/completions）、
 * openai-response（/responses）、anthropic（/v1/messages）。
 * 预设覆盖常见厂商；模型名只是建议值，可自由输入（各厂 API 迭代快）。
 *
 * **多档案（阶段 A）**：设置不再是"一条记录"，而是一组档案（profile）——
 * 每份档案自带一套 baseURL / API Key / 模型，互不干扰；`activeId` 指向当前
 * 生效的那一份，AI 编辑聊天与 CoAgent 都只读"当前档案"。
 * 持久化到 localStorage（API Key 保存在本浏览器；Go 调用时经本机服务转发且不落盘）。
 * 旧版 v1（单条记录）首次读取时自动迁移成一份档案，用户的 Key 不丢。
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
    note: '已自动附带 anthropic-dangerous-direct-browser-access 头（直连回退时同样生效）',
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
  {
    id: 'opencode-go', name: 'OpenCode Go',
    baseURL: 'https://opencode.ai/inference/go/openai/v1', protocol: 'openai-chat',
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro'],
    keyUrl: 'https://opencode.ai/console',
    note: '通过本机服务连接，使用 OpenCode Go 密钥。服务商面向编码 Agent；实际任务是否可用以服务商响应为准。',
  },
  { id: 'custom', name: '自定义', baseURL: '', protocol: 'openai-chat', models: [] },
]

/** 一条连接配置（扁平结构，正是 llmClient 需要的东西） */
export interface LlmSettings {
  provider: string
  protocol: LlmProtocol
  baseURL: string
  apiKey: string
  model: string
  /** 视觉回传：截图作为工具结果附图发给模型（viewport.pick 视觉点选的前提；需多模态模型） */
  sendImages: boolean
}

/**
 * 一份档案 = 一条连接配置 + 标识 + 显示名。
 * 多档案并行存在互不干扰；`provider` 仍是厂商预设 id（自定义时为 'custom'），
 * `name` 才是用户自己起的名字（如「工作机 GLM」「备用 Claude」）。
 */
export interface LlmProfile extends LlmSettings {
  /** 档案 id（localStorage 内唯一） */
  id: string
  /** 显示名（用户可改） */
  name: string
}

const STORAGE_KEY = 'agent-llm-settings-v2'
/** 旧版单条记录（阶段 A 之前），只用于一次性迁移 */
const LEGACY_STORAGE_KEY = 'agent-llm-settings-v1'

const PROTOCOLS = new Set<string>(['openai-chat', 'openai-response', 'anthropic'])

// 默认预选 GLM（智谱），国内可达且本仓库作者常用；可随时在设置里换
const glmPreset = LLM_PROVIDERS.find(p => p.id === 'glm')!

// ---------- 存储读写（隐私模式/无 localStorage 时静默降级） ----------

function readStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式等场景写不进就算了 */
  }
}

function readJson(key: string): unknown {
  const raw = readStorage(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------- 消毒（坏数据一律丢弃，绝不进 store） ----------

/**
 * 逐字段消毒：localStorage 里的旧数据/异常写入（字段为 null、
 * 类型不对、协议值非法）一律丢弃该字段，绝不让坏数据进 store——
 * 否则 AgentPanel 的 selector 会在渲染期抛错，整页崩成错误边界。
 */
function sanitizeSettings(raw: unknown): Partial<LlmSettings> {
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

/** 把任意来源的原始对象整形成合法档案；无法识别时返回 null */
function sanitizeProfile(raw: unknown, fallbackId: string): LlmProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const s = sanitizeSettings(o)
  const id = typeof o.id === 'string' && o.id ? o.id : fallbackId
  const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name : '未命名'
  return {
    id,
    name,
    provider: s.provider ?? 'custom',
    protocol: s.protocol ?? 'openai-chat',
    baseURL: s.baseURL ?? '',
    apiKey: s.apiKey ?? '',
    model: s.model ?? '',
    sendImages: s.sendImages ?? true,
  }
}

// ---------- 档案构造 ----------

/** 新档案 id：时间戳 + 随机后缀，够本地唯一即可 */
export function newProfileId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** 从厂商预设新建一份档案（自定义预设不带地址，模型名留空由用户填） */
export function createProfileFromPreset(presetId: string, name?: string): LlmProfile {
  const preset = LLM_PROVIDERS.find(p => p.id === presetId)
  return {
    id: newProfileId(),
    name: name ?? preset?.name ?? '新配置',
    provider: preset?.id ?? 'custom',
    protocol: preset?.protocol ?? 'openai-chat',
    baseURL: preset?.baseURL ?? '',
    apiKey: '',
    model: preset?.models[0] ?? '',
    sendImages: true,
  }
}

/** 复制一份档案（换新 id，名字加「副本」） */
export function duplicateProfile(src: LlmProfile): LlmProfile {
  return { ...src, id: newProfileId(), name: `${src.name} 副本` }
}

// ---------- 载入（含 v1 → v2 迁移） ----------

interface LoadedState {
  profiles: LlmProfile[]
  activeId: string
}

function loadState(): LoadedState {
  // ① 新版档案表
  const v2 = readJson(STORAGE_KEY)
  if (typeof v2 === 'object' && v2 !== null) {
    const o = v2 as Record<string, unknown>
    const list = Array.isArray(o.profiles) ? o.profiles : []
    const profiles = list
      .map((p, i) => sanitizeProfile(p, `p_${i}`))
      .filter((p): p is LlmProfile => p !== null)
    if (profiles.length > 0) {
      const activeId =
        typeof o.activeId === 'string' && profiles.some(p => p.id === o.activeId)
          ? o.activeId
          : profiles[0].id
      return { profiles, activeId }
    }
  }
  // ② 旧版单条记录 → 迁移成一份档案（用户的 Key 不丢）
  const v1 = readJson(LEGACY_STORAGE_KEY)
  if (typeof v1 === 'object' && v1 !== null) {
    const s = sanitizeSettings(v1)
    const preset = LLM_PROVIDERS.find(p => p.id === s.provider)
    const profile: LlmProfile = {
      id: newProfileId(),
      name: preset?.name ?? '我的配置',
      provider: s.provider ?? 'custom',
      protocol: s.protocol ?? 'openai-chat',
      baseURL: s.baseURL ?? '',
      apiKey: s.apiKey ?? '',
      model: s.model ?? '',
      sendImages: s.sendImages ?? true,
    }
    return { profiles: [profile], activeId: profile.id }
  }
  // ③ 首次使用：默认 GLM 档案
  const profile = createProfileFromPreset(glmPreset.id)
  return { profiles: [profile], activeId: profile.id }
}

function persist(profiles: LlmProfile[], activeId: string): void {
  writeStorage(STORAGE_KEY, JSON.stringify({ profiles, activeId }))
}

// ---------- store ----------

export interface LlmSettingsState {
  /** 全部档案（至少一份） */
  profiles: LlmProfile[]
  /** 当前生效档案 id */
  activeId: string
  /** 切换当前档案（只改指针，不动档案内容） */
  selectProfile(id: string): void
  /** 整体覆盖（设置窗口「保存」时一次性写入） */
  saveProfiles(profiles: LlmProfile[], activeId: string): void
}

export const useLlmSettingsStore = create<LlmSettingsState>((set, get) => ({
  ...loadState(),
  selectProfile(id) {
    const { profiles, activeId } = get()
    if (id === activeId) return
    if (!profiles.some(p => p.id === id)) return
    set({ activeId: id })
    persist(profiles, id)
  },
  saveProfiles(profiles, activeId) {
    // 再次消毒：设置窗口是外部输入口，坏数据同样不许进 store
    const list = profiles
      .map((p, i) => sanitizeProfile(p, `p_${i}`))
      .filter((p): p is LlmProfile => p !== null)
    const safe = list.length > 0 ? list : [createProfileFromPreset(glmPreset.id)]
    const active = safe.some(p => p.id === activeId) ? activeId : safe[0].id
    set({ profiles: safe, activeId: active })
    persist(safe, active)
  },
}))

// ---------- 读取助手 ----------

/** 当前生效档案（找不到时回落到第一条，保证调用方拿到的永远是合法对象） */
export function getActiveProfile(state?: LlmSettingsState): LlmProfile {
  const s = state ?? useLlmSettingsStore.getState()
  return s.profiles.find(p => p.id === s.activeId) ?? s.profiles[0] ?? createProfileFromPreset(glmPreset.id)
}

/** 当前生效档案的连接配置（llmClient 需要的扁平结构） */
export function getActiveSettings(state?: LlmSettingsState): LlmSettings {
  const p = getActiveProfile(state)
  return {
    provider: p.provider,
    protocol: p.protocol,
    baseURL: p.baseURL,
    apiKey: p.apiKey,
    model: p.model,
    sendImages: p.sendImages,
  }
}

/** 聊天可用前提：地址、模型、Key 齐备 */
export function isLlmConfigured(): boolean {
  const p = getActiveProfile()
  return p.baseURL.trim() !== '' && p.model.trim() !== '' && p.apiKey.trim() !== ''
}
