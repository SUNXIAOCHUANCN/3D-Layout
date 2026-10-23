/**
 * CoAgent 模块对宿主的公开面（§3.1）。
 *
 * 只公开面板、hook、bridge 与必要类型；内部 store、事务、fakes 一律不从这里走。
 * 宿主（App.tsx）只允许 import 本文件。
 */

export { CoAgentPanel } from './CoAgentPanel'
export { CoAgentBridge } from './rendering/CoAgentBridge'
export { useCoAgentModule } from './useCoAgentModule'
export { useCoAgentStore, isBusyPhase } from './uiStore'
export { isActivePhase } from './runtime/runController'
export { deriveHostLocks } from './hostLocks'
export type { HostLockInputs, HostLocks } from './hostLocks'
export { DEFAULT_COAGENT_CONFIG } from './config'
export type { CoAgentConfig, CoAgentPhase } from './contracts'
