/**
 * Agent 模块（提案式场景编辑 Agent 的前端半边）—— 可整体拆卸。
 * 装配点②（左侧边栏）： <AgentPanel />       挂在插件侧边栏的面板槽位
 * 装配点③（视口内）：    <AgentPickHighlight /> 挂在 SceneCanvas（点选高亮视觉件）
 * 装配钩子：           useAgentModule(enabled)
 *
 * 权限模型（模块的核心设计）：
 * - 只读：scene.get_state（场景中立快照）/ viewport.screenshot（无UI截图，多模态模型可看图）/
 *   viewport.pick（截图像素坐标 → 射线拾取资产）免确认；
 * - 写：asset.set_transform / asset.adjust_transform（增量）/ asset.add / asset.remove
 *   仅任务事务内，提案式生效，task_end 后人工裁决：接受=commit 入历史，拒绝=rollback 无痕回滚；
 * - 传输层可换：默认浏览器直连 LLM（聊天+工具循环）；?agent=loopback 演示回环（含视觉点选自测）；
 *   ?agent=1 或 ?agent=ws://host:port 切到 WebSocket，三期 Harness 实现同一协议即可接管。
 * 全部修改经 core/edit（source:'agent'），与人工编辑同一本历史账。
 */
export { AgentPanel } from './AgentPanel'
export { AgentPickHighlight } from './AgentPickHighlight'
export { useAgentModule } from './useAgentModule'
export { useAgentStore } from './agentStore'
export { agentSession } from './session'
