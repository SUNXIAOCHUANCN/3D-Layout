import { useEffect } from 'react'
import { agentSession } from './session'

/**
 * Agent 模块的装配钩子（App 调用一次）。
 * 模块挂载 = 启动会话（传输层 + 事件订阅）；卸载 = 停止会话，
 * 未裁决的提案自动回滚——关插件即撤销，不留半账。
 */
export function useAgentModule(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    agentSession.start()
    return () => agentSession.stop()
  }, [enabled])
}
