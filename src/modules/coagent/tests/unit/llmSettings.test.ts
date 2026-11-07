/**
 * llmSettings 单测（阶段 A：多档案）。
 *
 * 覆盖：v1 → v2 迁移、坏数据消毒、档案增删改与当前指针、持久化往返。
 * 环境是 node（无 DOM），故用最小 localStorage 桩件替代浏览器实现。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const V1_KEY = 'agent-llm-settings-v1'
const V2_KEY = 'agent-llm-settings-v2'

/** 最小 localStorage 桩件：够 llmSettings 用（get/set/remove） */
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage

// store 在模块加载时读一次 storage，所以必须在 import 之前装好桩件
const mod = await import('../../../agent/llmSettings')
const {
  createProfileFromPreset,
  duplicateProfile,
  getActiveProfile,
  getActiveSettings,
  isLlmConfigured,
  LLM_PROVIDERS,
  newProfileId,
  useLlmSettingsStore,
} = mod

/** 重新载入模块（换掉模块缓存里的 store 实例），用于验证"首启加载"路径 */
async function reload(): Promise<typeof mod> {
  vi.resetModules()
  return import('../../../agent/llmSettings')
}

function reset(): void {
  storage.clear()
  useLlmSettingsStore.setState({ profiles: [], activeId: '' })
}

describe('llmSettings · 首次使用', () => {
  beforeEach(reset)

  it('没有存储记录时给出一份默认 GLM 档案', async () => {
    const m = await reload()
    const s = m.useLlmSettingsStore.getState()
    expect(s.profiles.length).toBe(1)
    expect(s.profiles[0].provider).toBe('glm')
    expect(s.activeId).toBe(s.profiles[0].id)
  })
})

describe('llmSettings · v1 → v2 迁移', () => {
  beforeEach(reset)

  it('旧版单条记录被迁移成一份档案，Key 不丢', async () => {
    storage.setItem(
      V1_KEY,
      JSON.stringify({
        provider: 'deepseek',
        protocol: 'openai-chat',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-legacy-key',
        model: 'deepseek-chat',
        sendImages: false,
      }),
    )
    const m = await reload()
    const s = m.useLlmSettingsStore.getState()
    expect(s.profiles.length).toBe(1)
    expect(s.profiles[0].provider).toBe('deepseek')
    expect(s.profiles[0].apiKey).toBe('sk-legacy-key')
    expect(s.profiles[0].model).toBe('deepseek-chat')
    expect(s.profiles[0].sendImages).toBe(false)
    expect(s.activeId).toBe(s.profiles[0].id)
  })

  it('v2 存在时优先于 v1（不回退到旧数据）', async () => {
    storage.setItem(V1_KEY, JSON.stringify({ provider: 'deepseek', apiKey: 'sk-old' }))
    const p = createProfileFromPreset('openai')
    p.apiKey = 'sk-new'
    useLlmSettingsStore.getState().saveProfiles([p], p.id)
    const m = await reload()
    expect(m.useLlmSettingsStore.getState().profiles[0].apiKey).toBe('sk-new')
  })

  it('迁移后保存写进 v2 键', () => {
    const p = createProfileFromPreset('glm')
    p.apiKey = 'sk-x'
    useLlmSettingsStore.getState().saveProfiles([p], p.id)
    const raw = storage.getItem(V2_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw as string) as { profiles: unknown[]; activeId: string }
    expect(parsed.profiles.length).toBe(1)
    expect(parsed.activeId).toBe(p.id)
  })
})

describe('llmSettings · 档案操作', () => {
  beforeEach(reset)

  it('createProfileFromPreset 套用厂商预设（自定义预设无地址）', () => {
    const glm = createProfileFromPreset('glm')
    expect(glm.provider).toBe('glm')
    expect(glm.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(glm.model).not.toBe('')
    const custom = createProfileFromPreset('custom')
    expect(custom.baseURL).toBe('')
    expect(custom.model).toBe('')
  })

  it('duplicateProfile 复制内容但换新 id', () => {
    const src = createProfileFromPreset('openai')
    src.apiKey = 'sk-abc'
    const copy = duplicateProfile(src)
    expect(copy.id).not.toBe(src.id)
    expect(copy.apiKey).toBe('sk-abc')
    expect(copy.baseURL).toBe(src.baseURL)
  })

  it('newProfileId 互不相同', () => {
    expect(newProfileId()).not.toBe(newProfileId())
  })

  it('saveProfiles 落盘多份档案并保留当前指针', () => {
    const a = createProfileFromPreset('glm')
    const b = createProfileFromPreset('deepseek')
    b.apiKey = 'sk-b'
    useLlmSettingsStore.getState().saveProfiles([a, b], b.id)
    const s = useLlmSettingsStore.getState()
    expect(s.profiles.length).toBe(2)
    expect(s.activeId).toBe(b.id)
    expect(getActiveProfile(s).apiKey).toBe('sk-b')
  })

  it('saveProfiles 传入不存在的 activeId 时回落到第一份', () => {
    const a = createProfileFromPreset('glm')
    useLlmSettingsStore.getState().saveProfiles([a], 'not-exist')
    expect(useLlmSettingsStore.getState().activeId).toBe(a.id)
  })

  it('saveProfiles 传空列表时补一份默认档案（不允许空档案表）', () => {
    useLlmSettingsStore.getState().saveProfiles([], '')
    const s = useLlmSettingsStore.getState()
    expect(s.profiles.length).toBe(1)
    expect(s.activeId).toBe(s.profiles[0].id)
  })

  it('selectProfile 只切指针，不改档案内容', () => {
    const a = createProfileFromPreset('glm')
    const b = createProfileFromPreset('deepseek')
    b.apiKey = 'sk-b'
    useLlmSettingsStore.getState().saveProfiles([a, b], a.id)
    useLlmSettingsStore.getState().selectProfile(b.id)
    const s = useLlmSettingsStore.getState()
    expect(s.activeId).toBe(b.id)
    expect(s.profiles.find(p => p.id === a.id)?.apiKey).toBe('')
  })

  it('selectProfile 拒绝未知 id', () => {
    const a = createProfileFromPreset('glm')
    useLlmSettingsStore.getState().saveProfiles([a], a.id)
    useLlmSettingsStore.getState().selectProfile('nope')
    expect(useLlmSettingsStore.getState().activeId).toBe(a.id)
  })
})

describe('llmSettings · 消毒', () => {
  beforeEach(reset)

  it('非法协议被丢弃并回落默认，非法类型字段被丢弃', () => {
    const p = createProfileFromPreset('glm')
    const raw = p as unknown as Record<string, unknown>
    raw.protocol = 'not-a-protocol'
    raw.apiKey = 12345
    useLlmSettingsStore.getState().saveProfiles([p], p.id)
    const s = useLlmSettingsStore.getState()
    expect(s.profiles[0].protocol).toBe('openai-chat')
    expect(s.profiles[0].apiKey).toBe('')
  })

  it('坏档案不污染档案表', async () => {
    storage.setItem(
      V2_KEY,
      JSON.stringify({
        profiles: [{ id: 'a', name: '好档案', provider: 'glm', protocol: 'openai-chat', baseURL: 'u', apiKey: 'k', model: 'm' }, null, 42],
        activeId: 'a',
      }),
    )
    const m = await reload()
    const s = m.useLlmSettingsStore.getState()
    expect(s.profiles.length).toBe(1)
    expect(s.profiles[0].id).toBe('a')
    expect(s.activeId).toBe('a')
  })
})

describe('llmSettings · 读取助手', () => {
  beforeEach(reset)

  it('getActiveSettings 只暴露 llmClient 需要的扁平字段', () => {
    const p = createProfileFromPreset('openai')
    p.apiKey = 'sk-x'
    useLlmSettingsStore.getState().saveProfiles([p], p.id)
    const s = getActiveSettings()
    expect(Object.keys(s).sort()).toEqual(
      ['apiKey', 'baseURL', 'model', 'provider', 'protocol', 'sendImages'].sort(),
    )
    expect(s.apiKey).toBe('sk-x')
  })

  it('isLlmConfigured 要求地址/模型/Key 齐备', () => {
    const p = createProfileFromPreset('glm')
    p.apiKey = ''
    useLlmSettingsStore.getState().saveProfiles([p], p.id)
    expect(isLlmConfigured()).toBe(false)
    p.apiKey = 'sk-y'
    useLlmSettingsStore.getState().saveProfiles([p], p.id)
    expect(isLlmConfigured()).toBe(true)
  })

  it('厂商预设表包含原有厂商、OpenCode Go 和自定义', () => {
    expect(LLM_PROVIDERS.length).toBe(11)
    expect(createProfileFromPreset('opencode-go')).toMatchObject({
      provider: 'opencode-go', protocol: 'openai-chat',
      baseURL: 'https://opencode.ai/inference/go/openai/v1',
    })
    expect(LLM_PROVIDERS.some(p => p.id === 'custom')).toBe(true)
  })
})
