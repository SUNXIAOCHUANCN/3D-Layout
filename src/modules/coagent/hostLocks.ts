/**
 * hostLocks（W03，SPEC §1.4 互斥清单的单一来源）——纯函数，无副作用、无宿主依赖。
 *
 * 宿主（App.tsx）只把两件事喂进来：人工编辑模块是否开启、旧 Agent 是否忙碌，
 * 加上 CoAgent 自己的相位；本函数决定 5 个互斥位的取值。App 不写第二份判断，
 * 单元测试覆盖"活跃期全部入口受控"，浏览器侧由 W03 的 T13 实跑复核。
 *
 * 为什么把错误锁定也算作锁：§5.4 要求 rollback 失败后不让用户继续积累不可信修改，
 * 因此 error_locked 期间人工编辑、旧 Agent、历史 undo/redo、场景切换一并停用，
 * 直到操作者经面板"重置"显式解锁（runtime.reset）。
 */

import type { CoAgentPhase } from './contracts'
import { isActivePhase } from './runtime/runController'

export interface HostLockInputs {
  /** 人工编辑插件开关（URL/scene view 决定的宿主偏好） */
  editorEnabled: boolean
  /** 旧 Agent 是否处于任务/裁决期（agentPhase !== 'idle'） */
  agentBusy: boolean
  coagentPhase: CoAgentPhase
}

export interface HostLocks {
  /** CoAgent 处于活跃相位（写者互斥的依据） */
  coagentActive: boolean
  /** 回滚失败后的锁定：禁止新 run，且宿主编辑入口同样停用 */
  errorLocked: boolean
  manualEditing: boolean
  agentModuleEnabled: boolean
  sceneSwitchLocked: boolean
  historyLocked: boolean
}

export function deriveHostLocks(input: HostLockInputs): HostLocks {
  const coagentActive = isActivePhase(input.coagentPhase)
  const errorLocked = input.coagentPhase === 'error_locked'
  const coagentHolds = coagentActive || errorLocked
  return {
    coagentActive,
    errorLocked,
    manualEditing: input.editorEnabled && !input.agentBusy && !coagentHolds,
    agentModuleEnabled: !coagentHolds,
    sceneSwitchLocked: coagentHolds,
    historyLocked: coagentHolds,
  }
}
