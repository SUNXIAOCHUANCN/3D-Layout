import { create } from 'zustand'

export interface AgentCapabilities { modelSearch: boolean; overlapCheck: boolean }
const key = 'layout-agent-capabilities-v1'
function load(): AgentCapabilities {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return { modelSearch: value.modelSearch === true, overlapCheck: value.overlapCheck === true }
  } catch { return { modelSearch: false, overlapCheck: false } }
}
export const useAgentCapabilities = create<AgentCapabilities>(() => load())
export function setAgentCapability(name: keyof AgentCapabilities, enabled: boolean) {
  useAgentCapabilities.setState({ [name]: enabled })
  try { localStorage.setItem(key, JSON.stringify(useAgentCapabilities.getState())) } catch { /* Session settings still work. */ }
}
export function enabledAgentTools<T extends { name: string }>(tools: readonly T[], options: AgentCapabilities): T[] {
  return tools.filter(tool => (tool.name !== 'model.search' || options.modelSearch) &&
    (tool.name !== 'scene.check_overlaps' || options.overlapCheck))
}
export function agentSystemPrompt(base: string, options: AgentCapabilities): string {
  return base + (options.modelSearch ? '\n可选模型检索已开启：scene_get_state 默认不提供全库。需要新增模型时按关键词用 model_search 获取候选，不反复穷举类别。' : '') +
    (options.overlapCheck ? '\n可选重叠粗筛已开启：必要时可调用 scene_check_overlaps。它只检查包围盒疑似重叠，可能误报，不证明实际穿模或无穿模。' : '')
}
