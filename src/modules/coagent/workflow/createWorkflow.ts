/**
 * WorkflowRunner 入口（SPEC §3.3 的"唯一替换工作流实现的入口"）。
 *
 * W05 起：`createWorkflow()` = mainGraph（planner → baseline → 并行 regionGraph →
 * finalCheck → summarize），走真实 model/tools/证据链路。
 *
 * W02 的占位外壳保留在 `placeholderWorkflow.ts`，仅用于拓扑与失败映射回归，
 * 不再进入运行时装配（`createRuntime` 默认用的就是本文件的 createWorkflow）。
 */

export { createMainWorkflow as createWorkflow } from './mainGraph'
export { createPlaceholderWorkflow } from './placeholderWorkflow'
export type { MainWorkflowOptions } from './mainGraph'
export type { PlaceholderWorkflowOptions } from './placeholderWorkflow'
