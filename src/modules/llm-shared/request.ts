/** Shared transport for settings tests, both chat panels, and CoAgent. */
export interface RequestSettings {
  provider: string
  protocol: 'openai-chat' | 'openai-response' | 'anthropic'
  baseURL: string
  apiKey: string
}

export const GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'

export function newLlmSession(): string {
  return crypto.randomUUID()
}

export function usesGoRelay(settings: RequestSettings): boolean {
  if (settings.provider === 'opencode-go') return true
  try {
    const url = new URL(settings.baseURL)
    return url.hostname === 'opencode.ai' && /^\/(?:inference|zen)\/go\//.test(url.pathname)
  } catch { return false }
}

export function joinLlmUrl(base: string, path: string): string {
  const clean = base.trim().replace(/\/+$/, '')
  // Accept a pasted complete endpoint without appending it twice.
  return clean.endsWith(path) ? clean : clean + path
}

function directHeaders(s: RequestSettings): Record<string, string> {
  return s.protocol === 'anthropic'
    ? { 'Content-Type': 'application/json', 'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` }
}

export function redactLlmError(value: string, key: string): string {
  return key ? value.split(key).join('***') : value
}

export async function requestLlm(
  settings: RequestSettings, url: string, body: string, signal: AbortSignal, sessionId?: string,
): Promise<Response> {
  const relay = usesGoRelay(settings)
  if (relay && settings.protocol !== 'openai-chat') {
    throw new Error('OpenCode Go 本地转发目前支持 OpenAI Chat，请在设置中切换接入方式')
  }
  let res: Response
  try {
    res = await fetch(relay ? '/api/llm/request' : url, {
      method: 'POST', signal,
      headers: relay ? {
        'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}`,
        'x-layout-upstream': url, 'x-opencode-session': sessionId ?? newLlmSession(),
      } : directHeaders(settings),
      body,
    })
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    throw new Error(relay
      ? '网络请求失败：无法连接本地模型转发服务，请检查 3D-Layout 是否正常运行'
      : '网络请求失败：可能是 CORS 或网络不可达，请检查地址和代理')
  }
  if (relay && res.headers.get('x-layout-llm-relay') !== '1') {
    await res.body?.cancel()
    throw new Error('当前启动方式未提供模型转发服务，请重启项目的开发服务或构建预览；纯静态托管需要服务端转发')
  }
  if (!res.ok) {
    const detail = redactLlmError(await res.text(), settings.apiKey).slice(0, 600)
    const hint = res.status === 401 || res.status === 403 ? '请检查密钥、模型权限或服务商使用限制'
      : res.status === 404 ? '请检查接口地址和模型名称'
      : res.status === 429 ? '额度或请求频率受限，请查看服务商详情' : '模型请求失败'
    throw new Error(`HTTP ${res.status}：${hint}；${detail}`)
  }
  return res
}
