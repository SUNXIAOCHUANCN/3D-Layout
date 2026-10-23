/**
 * hostLocks 单测（W03）——互斥选择器的唯一真相来源。
 * 覆盖 SPEC §1.4 清单：活跃期人工编辑/gizmo/快捷键/历史/场景切换全部受控，
 * 以及 error_locked（回滚失败）同样停用这些入口；非活跃相位一律放行。
 */

import { describe, expect, it } from 'vitest'
import { deriveHostLocks } from '../../hostLocks'
import type { CoAgentPhase } from '../../contracts'

const base = { editorEnabled: true, agentBusy: false }

describe('hostLocks：CoAgent 活跃期', () => {
  const active: CoAgentPhase[] = [
    'preprocessing',
    'planning',
    'baselining',
    'executing',
    'validating',
    'committing',
    'cancelling',
    'awaiting_clarification',
  ]

  it.each(active)('%s 相位：四个宿主写入口全部停用', phase => {
    const l = deriveHostLocks({ ...base, coagentPhase: phase })
    expect(l.coagentActive).toBe(true)
    expect(l.errorLocked).toBe(false)
    expect(l.manualEditing).toBe(false)
    expect(l.agentModuleEnabled).toBe(false)
    expect(l.sceneSwitchLocked).toBe(true)
    expect(l.historyLocked).toBe(true)
  })

  it('非活跃相位（idle/completed/rolled_back/failed/disabled/initializing）全部放行', () => {
    const passive: CoAgentPhase[] = ['idle', 'completed', 'rolled_back', 'failed', 'disabled', 'initializing']
    for (const phase of passive) {
      const l = deriveHostLocks({ ...base, coagentPhase: phase })
      expect(l.coagentActive).toBe(false)
      expect(l.manualEditing).toBe(true)
      expect(l.agentModuleEnabled).toBe(true)
      expect(l.sceneSwitchLocked).toBe(false)
      expect(l.historyLocked).toBe(false)
    }
  })
})

describe('hostLocks：error_locked 与既有开关', () => {
  it('error_locked：不仅禁止新 run，宿主编辑入口也停用（§5.4 不积累不可信修改）', () => {
    const l = deriveHostLocks({ ...base, coagentPhase: 'error_locked' })
    expect(l.errorLocked).toBe(true)
    expect(l.coagentActive).toBe(false) // 不是"运行中"，但仍是锁定态
    expect(l.manualEditing).toBe(false)
    expect(l.agentModuleEnabled).toBe(false)
    expect(l.sceneSwitchLocked).toBe(true)
    expect(l.historyLocked).toBe(true)
  })

  it('旧 Agent 任务中：人工编辑停用，但旧 Agent 自身与场景切换不受影响', () => {
    const l = deriveHostLocks({ editorEnabled: true, agentBusy: true, coagentPhase: 'idle' })
    expect(l.manualEditing).toBe(false)
    expect(l.agentModuleEnabled).toBe(true)
    expect(l.sceneSwitchLocked).toBe(false)
    expect(l.historyLocked).toBe(false)
  })

  it('人工编辑插件本就关闭时，不因 CoAgent 而"额外"打开', () => {
    const l = deriveHostLocks({ editorEnabled: false, agentBusy: false, coagentPhase: 'executing' })
    expect(l.manualEditing).toBe(false)
  })
})
