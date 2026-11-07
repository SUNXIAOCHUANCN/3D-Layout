/** Shared transport for settings tests, both chat panels, and CoAgent. */
export interface RequestSettings {
  provider: string
  protocol: 'openai-chat' | 'openai-response' | 'anthropic'
  baseURL: string
  apiKey: string
}

export const GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'

/** 服务端（Node）没有 CORS 限制，直连上游；浏览器才需要本机转发。由后端在加载模型客户端前置位。 */
const serverSide = (globalThis as { __LAYOUT_NO_RELAY__?: boolean }).__LAYOUT_NO_RELAY__ === true

export function newLlmSession(): string {
  return crypto.randomUUID()
}

function isOpencodeGo(settings: RequestSettings): boolean {
  if (settings.provider === 'opencode-go') return true
  try {
    const url = new URL(settings.baseURL)
    return url.hostname === 'opencode.ai' && /^\/(?:inference|zen)\/go\//.test(url.pathname)
  } catch { return false }
}

export function usesGoRelay(settings: RequestSettings): boolean {
  if (serverSide) return false
  return isOpencodeGo(settings)
}

export function joinLlmUrl(base: string, path: string): string {
  const clean = base.trim().replace(/\/+$/, '')
  // Accept a pasted complete endpoint without appending it twice.
  return clean.endsWith(path) ? clean : clean + path
}

function directHeaders(s: RequestSettings, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = s.protocol === 'anthropic'
    ? { 'Content-Type': 'application/json', 'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` }
  // OpenCode Go 要求会话标识，否则 400 MissingSessionID（浏览器走转发时由 relay 补，直连时在这里补）。
  if (isOpencodeGo(s)) {
    headers['x-opencode-session'] = sessionId ?? newLlmSession()
    headers['User-Agent'] = '3d-layout/0.1.0'
  }
  return headers
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
      } : directHeaders(settings, sessionId),
      body,
    })
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    throw Object.assign(new Error(relay
      ? '网络请求失败：无法连接本地模型转发服务，请检查 3D-Layout 是否正常运行'
      : '网络请求失败：可能是 CORS 或网络不可达，请检查地址和代理'), {
      code: 'MODEL_SERVICE_ERROR', providerCode: 'network_error',
    })
  }
  if (relay && res.headers.get('x-layout-llm-relay') !== '1') {
    await res.body?.cancel()
    throw Object.assign(new Error('当前启动方式未提供模型转发服务，请重启项目的开发服务或构建预览；纯静态托管需要服务端转发'), {
      code: 'MODEL_SERVICE_ERROR', providerCode: 'relay_unavailable',
    })
  }
  if (!res.ok) {
    const detail = redactLlmError(await res.text(), settings.apiKey).slice(0, 600)
    const hint = res.status === 401 || res.status === 403 ? '请检查密钥、模型权限或服务商使用限制'
      : res.status === 404 ? '请检查接口地址和模型名称'
      : res.status === 429 ? '额度、频率或上游容量受限（上下文过大同样会触发），请稍后重试或减小上下文' : '模型请求失败'
    throw Object.assign(new Error(`HTTP ${res.status}：${hint}；${detail}`), {
      code: 'MODEL_SERVICE_ERROR', providerCode: `http_${res.status}`,
    })
  }
  return res
}
