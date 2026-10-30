/**
 * CoAgent 默认配置（W01）。
 *
 * §7.2 默认值照落；标注 [P2/P4 实测调整] 的项当前取保守有限值，
 * 不允许无穷（超限状态纳入后续工作包测试）。
 */

import type { CoAgentConfig } from './contracts'

export const DEFAULT_COAGENT_CONFIG: Readonly<CoAgentConfig> = {
  modelConcurrency: 2,
  maxRepairsPerTask: 1,
  toolBudgetPerTask: 30,
  modelTimeoutMs: 120_000,
  sceneReadyTimeoutMs: 15_000,
  schemaRepairAttempts: 1,
  autoRecoverEdits: false,
  exportCredentials: false,
  // 20 分钟：两区并行 + 修正轮 + 判定的保守上界 [P2/P4 实测调整]
  runTotalTimeoutMs: 20 * 60_000,
  // 256 MB：8 张 1080p PNG 级别的证据预算 [P2/P4 实测调整]
  imageMemoryCapBytes: 256 * 1024 * 1024,
  // 32 MB：事件序列化上限 [P2/P4 实测调整]
  logSizeCapBytes: 32 * 1024 * 1024,
  evidenceMaxEntries: 200,
  // 4 张：基线 + 最新观察 + 同视角前后对，足以对比又不至于把请求撑爆 [P2 实测调整]
  maxImagesPerRequest: 4,
}
