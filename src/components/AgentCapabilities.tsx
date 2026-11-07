import { setAgentCapability, useAgentCapabilities } from '../core/agentCapabilities'

export function AgentCapabilities({ disabled }: { disabled: boolean }) {
  const options = useAgentCapabilities()
  return <details className="agent-section">
    <summary>可选能力（默认使用原版编辑流程）</summary>
    <label><input type="checkbox" checked={options.modelSearch} disabled={disabled}
      onChange={e => setAgentCapability('modelSearch', e.target.checked)} /> 按需检索模型（实验）</label>
    <br />
    <label><input type="checkbox" checked={options.overlapCheck} disabled={disabled}
      onChange={e => setAgentCapability('overlapCheck', e.target.checked)} /> 疑似重叠粗筛（实验）</label>
  </details>
}
