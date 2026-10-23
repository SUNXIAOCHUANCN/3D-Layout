# CoAgent 技术路线与开发交接

**开发主入口：[DEVELOPMENT-SPEC.md](./DEVELOPMENT-SPEC.md)。** 该文档进一步明确模块职责、通信协议、外部依赖、W00～W09 工作包、测试矩阵与 SubAgent 交接规则。本文件保留技术路线背景；实施细节冲突时以开发规格为准。

日期：2026-10-20  
状态：开发规格，未实现；接口均为拟定契约，不能当作仓库已有接口直接调用。  
读者：负责实现的代码开发 LLM 与维护者。  
优先级：本文件覆盖 README 中早期“先手写工作流”的技术建议，保留已确认业务流程。

## 0. 先读结论

采用 **React 插件入口 + LangGraph JS 工作流 + 普通 TypeScript 业务函数 + 编辑器适配层 + 插件内 R3F 渲染桥**。

- 新业务代码、测试、提示词和工具放在 `src/modules/coagent/`。
- `src/core/` 不修改；场景编辑仍走现有 `core/edit`，读取走现有 store。
- 不引入独立服务、数据库、LangGraph Server、LangSmith 云服务或 Python 运行时。
- 先完成最小浏览器验证，再锁定依赖版本；不把框架学习与真实模型、GPU、事务同时调试。
- 工作流的节点连接与条件路由集中在 `workflow/`；业务函数和工具不依赖 LangGraph。
- 图状态只携带可序列化任务与结果；Three 对象、图片 Blob、API Key、事务句柄留在运行时服务中。
- 一条用户指令只创建一个编辑事务；图失败不会自动撤销外部场景，必须由运行控制器处理。
- 判定者先取证、执行者再修改、判定者同视角复拍。跨区域模型调用并行，渲染与写入有序执行。

### 0.1 “所有开发在 modules”的可实施解释

现有 `App.tsx` 静态注册插件，并不存在自动发现 modules 的插件加载器。完全不修改 modules 外文件，无法让新插件出现在现有平台中。禁止通过 DOM 注入、猴子补丁或运行时改写 core 来绕开装配。

允许的最小宿主接入建议如下；实施者应在交付中单独列出这些改动：

| 文件范围 | 允许改动 | 不允许塞入的逻辑 |
|---|---|---|
| `src/App.tsx` | import、插件开关、hook、侧栏槽位、Canvas 子组件、忙碌状态接线 | 提示词、图定义、工具执行、渲染算法 |
| `src/package.json` 与实际使用的锁文件 | 声明/锁定必要依赖与测试命令 | 独立后端启动框架 |
| `src/modules/coagent/**` | 全部新增功能 | 直接绕过 edit 改场景 |
| 其它 modules | 仅现有入口无法通过宿主禁用时的最小互斥接入，先说明理由 | 为新插件大规模重构旧模块 |
| `src/core/**` | **预期零改动** | 所有 CoAgent 专属能力 |
| `src/components/**`、`src/ui/**` | 默认不改；优先在 App 外层禁用交互并使用已有 children | 新插件业务 |

若用户要求 modules 外连装配和依赖声明也不能改，则只能交付未挂载模块和接入说明，不能声称已经集成。

### 0.2 与旧目录约定的协调

旧 store 注释约定只有 `src/components/*` 操作 Three 对象；但现有 `modules/editor/EditorGizmo`、`modules/agent/AgentPickHighlight` 已通过 Canvas children 挂载渲染组件。

本方案采用同类插件渲染桥：`modules/coagent/rendering/CoAgentBridge.tsx` 是渲染侧组件的明确例外，只管理自有相机、离屏目标、临时观察状态；不改资产 transform、不向文档添加对象。业务模块仍不得操作 Three 对象。无需为更改注释而修改 core；开发者需保留这一边界说明。

## 1. 当前代码事实与需要补齐的能力

本次已读取相关源码；实施前再次检查文件，避免覆盖期间其它修改。

| 已有位置 | 已有能力 / 限制 | 实施方式 |
|---|---|---|
| `App.tsx` | 插件面板、hook、Canvas children 静态装配 | 增加 CoAgent 装配 |
| `components/SceneCanvas.tsx` | 提供 Canvas children、共享 Scene 与 renderer | 挂载插件桥，不改文件 |
| `core/edit.ts` | 增改删、commit/rollback、undo/redo；仅一个 openTx | 运行控制器独占唯一事务 |
| `core/store.ts` | document、manifest、sceneId、选择状态 | 适配层只读与订阅 |
| `core/engine.ts` | 当前相机截图、聚焦、拾取 | 不能拿 focusAsset 冒充独立相机 |
| `modules/agent/llmClient.ts` | 普通流式 fetch，工具调用、图片工具结果、AbortSignal | 包装成 ModelPort，不复用旧 session |
| `modules/agent/llmClient.ts` | user turn 当前仅支持 text | 基线图可通过合法的 observation 工具结果输入；不得制造无对应调用的 toolResults |
| `modules/agent/tools.ts` | 世界 AABB 基于元数据的近似 | 不把它作为精确 mesh 碰撞实现 |
| `ui/TopBar.tsx` | 场景切换直接派发命令 | CoAgent 忙碌时在宿主层禁用该操作入口 |

`asset:loaded` 事件只表示某资产加载；不能把“收到一次事件”当作整个场景已经就绪。插件需检查待观察资产的渲染对象与矩阵同步状态。

## 2. 目录与依赖边界

这是目标布局，不要求第一天创建所有文件；按阶段增加。

```text
src/modules/coagent/
  index.ts                       # 唯一宿主公开入口
  CoAgentPanel.tsx                # 极简交互
  useCoAgentModule.ts             # 建立/释放运行时
  uiStore.ts                     # UI 投影状态，不存第二份场景
  contracts.ts                   # 纯数据类型与 Port 契约
  schemas.ts                     # 模型输出/工具参数运行时校验
  config.ts                      # 默认值集中管理
  runtime/
    createRuntime.ts             # 装配依赖
    runController.ts             # 锁、事务、取消、最终清理
    scheduler.ts                 # 小型信号量、写入/截图队列
    evidenceStore.ts             # Blob、相机与证据索引
    recorder.ts                  # 有序事件与日志导出
  workflow/
    createWorkflow.ts            # WorkflowRunner 工厂
    mainGraph.ts                 # 节点、边、并行路由
    regionGraph.ts               # 区内顺序任务、执行/判定循环
    state.ts                     # LangGraph state/reducer
  agents/
    planner.ts                   # 任务与澄清输出
    executor.ts                  # 一项任务的工具循环
    judge.ts                     # 取证计划与判定
    modelLoop.ts                 # 共用有界工具调用循环
    prompts.ts                   # 分角色模板与版本号
  services/
    partition.ts                 # 分区生成/校验/归属
    observations.ts              # 观测包与前后对应
    validation.ts                # 计划、结果与最终一致性校验
  tools/
    registry.ts                  # 工具定义及角色可见集合
    sceneTools.ts
    editTools.ts
    cameraTools.ts
    geometryTools.ts
  adapters/
    editorAdapter.ts             # 唯一 core 导入区
    modelAdapter.ts              # 唯一旧 llmClient 导入区
  rendering/
    CoAgentBridge.tsx            # R3F useThree/useFrame
    capture.ts                   # 离屏截图与状态恢复
    markers.ts                   # 投影及 ID 叠加
    geometry.ts                  # 世界几何快照/BVH
  tests/                         # 假模型、假编辑器与集成测试
```

依赖方向：

```text
UI -> runController -> WorkflowRunner -> agents/services -> Ports
                         LangGraph           |
                                      tool registry -> Ports
Ports <- editorAdapter / modelAdapter / CoAgentBridge
```

限制：

- 只有 `workflow/` 导入 `@langchain/langgraph`。
- 只有 `adapters/editorAdapter.ts` 导入 core；实际需要多个文件时保留在同一 adapter 边界。
- 只有 `rendering/` 导入 Three/R3F 并访问渲染对象。
- 只有 `modelAdapter.ts` 了解供应商协议和旧 Agent 客户端类型。
- 所有 Agent 使用明确工具白名单；不得通过 import 直接拿到 editorAdapter。
- 工作流改动不应要求修改渲染、碰撞、事务或宿主 App。

## 3. 不过度抽象的四个接口

以下为接口形状；引用的 DTO 在 contracts.ts 定义，不直接依赖 core 类型。无需为每个函数创建 class。

```ts
interface ModelPort {
  complete(input: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}

interface EditorPort {
  snapshot(scope: ReadScope): SceneSnapshot;
  subscribe(listener: (change: SceneChange) => void): () => void;
  openTransaction(label: string): TransactionPort;
  apply(command: EditCommandDTO, tx: TransactionPort): EditReceipt;
  // 图、Agent、工具只拿受限 facade；openTransaction 仅 runtime 能调用。
}

interface RenderPort {
  ready(assetIds: string[], signal: AbortSignal): Promise<void>;
  capture(request: CaptureRequest, signal: AbortSignal): Promise<ObservationRef>;
  geometry(assetIds: string[], signal: AbortSignal): Promise<GeometrySnapshot>;
}

interface WorkflowRunner {
  run(input: RunInput, context: WorkflowContext): Promise<RunOutcome>;
}
```

`WorkflowContext` 注入模型、工具调度、证据服务、日志及 AbortSignal，不作为图 state 序列化。运行时闭包保持事务句柄，图节点不能提交事务。

`ModelRequest` 至少含 system、规范化 messages、tools、角色及输出 schema；`ModelReply` 含文本、工具调用与可获得的 usage。使用 discriminated union 表示文本/图像/工具结果，不把 Blob URL 当成模型已读图片。

`RunOutcome` 使用 `completed | needs_clarification | unsupported | failed | cancelled`；“需要澄清”不是异常，也不应在持有编辑事务时等待用户。

### 3.1 模型复用策略

第一步包装现有 llmClient 的普通请求函数，避免接入旧 `agentSession`、`agentStore`、`llmChatTransport` 的任务生命周期。先核实实际 export 名称，不假定函数名。

多模态输入优先利用已有合法工具调用返回图片路径：Agent 调用观察工具 → toolResults 附带实际图像 → 后续推理。如必须直接给首条 user message 附图，而旧客户端不支持，则在 CoAgent modelAdapter 内实现一种供应商协议，或在 modules 内抽取共享客户端；不伪造历史工具调用。第一版只承诺一种实测供应商，其它供应商仍可配置但标注未验证。

配置可读取现有设置格式，但运行开始时创建不可变快照，不能让另一设置面板中途改掉活跃请求。凭据不进图状态或日志。

## 4. 状态、任务与证据

沿用 README 的 UnitTask/Region/Verdict，并补齐：

| 数据 | 字段与用途 |
|---|---|
| RunInput | runId、用户请求、sceneId、partitionVersion、配置快照 |
| Plan | 解释后的意图、assumptions、任务列表、澄清问题或不支持原因 |
| RegionJob | jobId、regionId、该区有序任务、授权对象范围 |
| GraphState | 请求、计划、baseline 引用、按 jobId 汇总结果、阶段状态 |
| RegionState | 本区任务索引、执行反馈、判定结果、修正次数 |
| Observation | imageRef、sceneRevision、对象 fingerprint、完整 CameraConfig、捕获时间 |
| ToolContext | runId、taskId、role、regionId、AbortSignal、运行令牌 |
| ToolResult | ok、code、data、evidenceRefs、retryable；不能只有自然语言一句话 |

对象 ID 全局稳定；视图使用缩短标签时必须保存标签到全局 ID 的一一映射。模型返回标签后先解析，不允许猜测对象。

图片 Blob 与 PNG 放 EvidenceStore；图只存引用。图中不要存 WebGLRenderer、Camera、Object3D、TxHandle、DOM、API Key 或全量场景副本。

并行结果使用以 jobId 为键的合并 reducer。不同 jobId 合并满足交换/结合；同一 jobId 出现冲突结果应报错或按显式 attempt 处理，禁止依赖分支结束先后覆盖结果。日志事件由 recorder 在真实事件发生时分配单调序号，不靠 reducer 数组顺序推断时间。

## 5. LangGraph 的具体组织

采用一个主图、一个区域子图；独立预处理不必纳入图。官方 API 会演进，开发者应按安装版本核对 StateGraph、Send、schema/reducer 用法，不混用不同版本示例。

主图语义：

```text
collectContext -> plan -> validatePlan
                         |-> clarification / unsupported -> END
                         |-> captureBaselines -> baselineBarrier
                             -> parallelRegionJobs -> finalCheck -> summarize -> END
```

区域子图：

```text
取下一项任务 -> 判定者补充该任务的即时基线（只读）
            -> executor -> judgeAfter
                            | pass -> 下一任务或返回区域结果
                            | fail/uncertain 且有预算 -> executor
                            | 超限 -> 返回区域失败
```

说明：

1. 初始全局基线在任何编辑前拍摄，供整条用户指令前后比较。
2. 同区若有多项顺序任务，第二项前的状态已经包含第一项效果。因此额外保存“任务即时基线”；原始全局基线不能被覆盖，两种比较都记录。
3. 每区一个 region job，内部按依赖拓扑顺序处理任务；新增对象结果映射只在本区共享。
4. 用 Send 动态分发 region job，每个 job 调用私有状态的区域子图，返回小结果；不共享聊天数组。
5. 初始基线节点先完成所有判定者取证，再 dispatch 执行分支，避免各分支自行开始修改。
6. 在阶段 0 用不同耗时、不同循环次数的假分支验证汇合语义，最终检查必须等所有分支结束，不能在第一个分支返回时提交。
7. 模型并发数由 runtime semaphore 控制；图分支数不等于模型连接数。
8. 写入与截图由场景队列调度；不在一个队列临界区内等待网络请求。

当一个分支返回失败时，停止其它分支工具写入并等待收敛；最终由 runController 回滚。取消路径不能寄希望于图中的“失败节点必然执行”，因为图可能被异常直接打断。

### 5.1 最简 Agent 实现

所有角色使用同一个 `runModelLoop(role, context, tools, budget)`，差异为提示词、上下文构造、白名单和输出 schema。executor 内部普通 while 工具循环即可，不必把每个工具做成 LangGraph 节点。

- planner 输出 Plan，不直接写场景。
- judgeBefore 输出取证视角/指标并调用只读工具，保存基线。
- executor 根据目标条件调用编辑工具，结束时返回修改摘要。
- judgeAfter 使用原任务及前后证据输出逐条件 Verdict，无编辑权限。

格式错误最多一次结构化修复请求；修复输出不得跳过 schema 校验。`pass` 必须引用存在且与任务版本匹配的证据。碰撞 unknown 不能被语义模型强制改成 clear。

## 6. 运行控制器与事务

伪代码说明责任边界，不作为可直接复制的实现：

```ts
async function runUserRequest(input: RunInput) {
  // 主 Agent 规划阶段只读；若场景在规划中改变，废弃计划并重新观察。
  const lease = await acquireEditorLease();
  const run = createRunContext(input);
  try {
    const outcome = await workflow.run(input, run.context);
    await run.sceneQueue.drain();
    if (outcome.status === "completed" && run.hasFinalValidation()) {
      run.commitIfOpened();
    } else {
      await run.invalidateAndDrain();
      run.rollbackIfOpened();
    }
    return outcome;
  } catch (error) {
    await run.invalidateAndDrain();
    run.rollbackIfOpened();
    return run.failureOutcome(error);
  } finally {
    run.releaseTemporaryResources();
    lease.release();
  }
}
```

编辑锁可在整轮规划时获取以简化一致性；如果需要澄清，立即返回、释放锁，下次回复重新读取场景。上面注释指任何不持锁的准备动作都需要 revision 校验。

总事务在第一次写入时由 runtime 惰性打开，且仅在 baselineBarrier 完成后放行。整轮零修改时不产生历史。executor 工具只能调用受限 `apply`，不能拿 TxHandle。

现有 edit.begin 会覆盖活动事务且不暴露所有者；开始前必须确保旧 Agent idle、无人工拖拽/预览、无其它协作任务。第一版不声称拥有 core 级强互斥，保证范围为当前编辑器已接入 UI 和 Agent 路径。

### 6.1 写入与取消

每个调用使用 `(runId, taskId, toolCallId)` 作为幂等键。已经成功的调用返回保存结果；相同 key 不同参数报错。add 的 ID 由程序生成并保存收据，网络重试不能新增副本。

写入提交前同步检查：运行令牌有效、场景未切换、对象存在、对象归属及写范围有效、参数有限、资产 ref 合法、相关对象 fingerprint 与读取时一致。

全球 revision 改变不必拒绝所有并行操作；以被写对象和相关参照对象的 fingerprint 判定冲突，避免区域 A 的正常修改导致区域 B 全部失败。观测本身仍记录全局 revision。

取消顺序：使运行令牌失效 → abort 模型请求 → 拒绝队列中未开始任务 → 等待当前同步临界区退出 → 回滚 → 释放编辑锁。远端模型不响应 abort 也不能继续写入。

插件关闭使用 `requestDisable()` 等待清理后再卸载桥；不能先卸载再寄希望于异步清理访问已销毁的 renderer。React StrictMode 重复挂载不能自动创建运行或重复订阅。

### 6.2 保存与撤销

commit 成功后，再调用平台现有保存功能。保存失败只说明落盘失败，不回滚已经提交的历史；提示用户重试保存。不在每个子任务结束时保存。

区域标签为派生映射，订阅 document 变化后按多边形重算。撤销/重做后的新增/删除对象不能留下悬空 ID。分区修改发生在 idle，增加 partitionVersion；第一版不写入 core 场景 schema。

## 7. 最小宿主装配与交互互斥

公开 API 建议：

```ts
export { CoAgentPanel } from "./CoAgentPanel";
export { CoAgentBridge } from "./rendering/CoAgentBridge";
export { useCoAgentModule } from "./useCoAgentModule";
export { useCoAgentUiStore } from "./uiStore";
```

在 App：

- 新增一个 coagent 插件 descriptor，不改变 Sidebar 的通用接口。
- 调用模块 hook；在 SceneCanvas children 中挂载 bridge。
- 计算 `manualEditing = editorOn && oldAgentIdle && !coAgentBusy`，停用既有快捷键 hook 与 gizmo。
- 原 Agent 活动时禁止启动 CoAgent；CoAgent 活动时禁止原 Agent发送。旧插件禁用不能误触已有提案回滚，因此必须先确认 idle 再切换运行资格。
- 用宿主包装器的 `inert` 和明确 busy 状态禁用 TopBar 场景切换、history、导入导出等 DOM 入口；不修改这些组件实现即可覆盖正常指针/键盘交互。
- 另外核对全局快捷键、portal 对话框、异步导入及拖拽路径；inert 无法取消后台程序写入。启动前拒绝正在进行的导入/拖拽，必要时只在相关 modules 增加入口守卫。
- 用户视口旋转可保留，因为它不是场景写入；用户视口取证必须使用捕获瞬间姿态。

不能只禁用侧栏按钮而让 Ctrl+Z 或另一个模型仍写入。没有 core 统一锁时，也不能宣称恶意外部脚本无法修改场景。

## 8. 后台相机与视觉证据实现

`CoAgentBridge` 使用 `useThree()` 获取 scene、renderer、用户 camera。创建自有 PerspectiveCamera/OrthographicCamera 和 WebGLRenderTarget，不替换用户相机、不调用现有 focusAsset 改用户视口。

截图算法：

1. 场景队列阻止写入；等待目标对象已加载且 React/R3F 已反映当前 document。
2. 更新世界矩阵，核对目标对象 transform 与 scene snapshot；超时返回 renderer_not_ready。
3. 保存 render target、viewport、scissor/scissorTest、clear 状态及实际改动的 renderer 配置。
4. 暂时隐藏明确标记为 editorHelper 的 gizmo/高亮；避免过滤掉真实资产。只改自有相机与临时观察状态。
5. 离屏渲染到固定尺寸，读回像素；处理上下翻转、颜色空间、透明背景。用非对称测试场景校验坐标方向。
6. 从同一份像素复制生成 RGB 和标记图，避免二次渲染时状态改变。
7. 在 finally 恢复所有修改，即使编码或读取失败；释放临界区，再异步编码 PNG。
8. 将图像 Blob、CameraConfig、对象状态和 revision 存入 EvidenceStore。

标记初版用投影对象锚点/包围框加 2D canvas 文本。标记位置应通过射线可见性检查或可见几何点采样验证；被遮挡对象不能假装在 RGB 中可见。投影包围框是近似证据，日志注明模式。后续精确 ID pass 作为 RenderPort 的可替换实现。

大场景按实际包围盒计算相机距离、near/far 与正交范围，不复用 SceneCanvas 默认 far=300。对细长地形、贴近目标和地面高度变化做测试。相机每次补拍保存新 snapshot；判定复拍显式使用 baseline snapshot，不使用“当前相机”。

## 9. 预处理与工具清单

预处理最小流水线：场景摘要 → 鸟瞰 RGB/标记图 → VLM polygon 输出 → schema/几何校验 → 分配对象 → 人工修正 → region cameras。

多边形输入建议使用归一化鸟瞰坐标，程序通过记录的正交相机映射到世界 XZ；或使用世界 XZ，两者只选一种作为模型输出协议，不混用。边界点、重叠区、遗漏对象必须显式报告。

首轮工具：

| 工具 | 角色 | 实现来源 |
|---|---|---|
| overview、user_view | planner | 结构化摘要与用户相机截图 |
| region_state、asset_get | executor/judge | 区内 snapshot |
| catalog_search | executor/planner | manifest 检索 |
| observe、focus、set_camera | executor/judge | RenderPort |
| add、set_transform、remove | executor | 受限 EditorPort facade |
| measure、check_collisions | executor/judge | 插件几何服务 |

各工具定义 name/schema/roles/effect/handler，schema 同时用于模型声明与本地校验。不接受模型输出任意 JavaScript，不执行 eval。工作流只调用工具注册表，不直接依赖工具文件的具体内容。

碰撞模块分阶段实现：宽阶段真实世界包围体 → 窄阶段三角网格/BVH → 包含/接触策略。可按需加入 three-mesh-bvh，但不强制在 P0 安装。读真实世界变换、缓存本地几何和拓扑版本；不能修改共享 mesh 几何去建立缓存。非闭合、蒙皮或未知几何返回 unknown；不要把 AABB 重叠当真实穿插。

## 10. 变更工作流时改哪里

| 未来变化 | 修改范围 | 保持不动 |
|---|---|---|
| 主 Agent 先讨论再拆解 | mainGraph、planner prompt/schema | editorAdapter、rendering |
| 去掉/替换判定 Agent | regionGraph、judge | 编辑事务和工具 |
| 改成两轮审查或专门碰撞审查 | 图节点/条件边、validation | 宿主接入 |
| 增加深度图 | RenderPort capture mode、rendering、观察工具 schema | 总事务与区域图主体 |
| 换模型厂商 | modelAdapter/配置 | 任务、场景接口 |
| 更换分区算法 | partition service | 执行/判定协议 |
| 更换 LangGraph | 新 WorkflowRunner 实现 | Agent 业务函数与 Ports |
| 未来跨区任务 | Plan/权限/调度策略及测试 | 能复用 renderer，但不能承诺仅改 prompt 即完成 |

## 11. 逐步开发顺序

### P0：浏览器与接口可行性，先排除集成风险

产物：模块骨架、必要依赖、假 ModelPort、最小 LangGraph 图。

- 核对实际包版本和 peer dependencies，安装必要的 `@langchain/langgraph`、`@langchain/core` 和匹配 schema 库；固定锁文件。
- Vite 中运行 start → fakePlanner → 两个不同耗时分支 → 汇合；包含一个有限循环分支。
- 验证不引入 Node-only 模块、server SDK 或自动云追踪；检查生产 build。
- 验证取消信号、异常路径与动态分支汇合。不要先接真实模型。

验收：浏览器输出一次准确汇总；快分支结束不导致提前汇总；取消不残留活动任务；build 通过。若失败，记录具体依赖阻塞再处理，不静默改为服务架构。

### P1：宿主挂载与运行边界

产物：Panel、hook、runtime、editorAdapter、公开 index、App 最小接线。

- 面板先只有初始化、指令输入、运行、停止、导出和状态。
- 假执行者经现有 edit 修改一个对象；验证唯一事务、整体撤销。
- 禁用所有已知冲突入口；旧 Agent 与 CoAgent 互斥。
- 完成停止、关闭、错误回滚和迟到调用拒绝。

验收：一次运行一条历史；任意失败恢复原场景；关闭重开不重复订阅；未修改 core。

### P2：观测桥与证据链

产物：CoAgentBridge、capture、markers、EvidenceStore。

- 独立鸟瞰/区域相机与 focus；RGB/ID、用户视口捕获。
- 同视角 before/after；等待加载、同步矩阵和 finally 恢复。
- 测试用户相机不动、截图不含 gizmo、图像坐标不翻转、200m 范围不截断。

验收：假任务也可导出一对可靠证据；两个区域同时请求截图不会混相机/版本；异常后用户视口正常。

### P3：最小闭环，仍用假模型

产物：mainGraph、regionGraph、agents、tools、假分区。

- 两个区域、各一项任务，判定者取证 → 全局基线屏障 → 并行执行 → 复拍。
- 一个区域一次失败后修正成功；另一次运行模拟终止失败验证整体回滚。
- 加入同区两项顺序任务，确认即时基线和全局基线不同且都保留。

验收：日志时间线证明所有初始截图早于首次写入；任务真正并行调用；汇合不提前；结果不会因 reducer 丢失。

### P4：真实分区与主 Agent

产物：modelAdapter、partition、planner/schema、提示词。

- 先测一次“模型调用工具获取图片 → 返回结构化结果”的端到端协议。
- VLM 输出多边形，程序分组；提供最小人工修正入口，可先用区域表/顶点表和归属预览，不做复杂画布工具。
- 模糊请求形成目标条件任务；歧义返回澄清，区域外需求明确不支持。

验收：真实场景可形成可检查分区；错误 JSON、越界多边形、无对象、遗漏与多重归属都有明确状态。

### P5：真实执行、判定与几何检查

产物：executor/judge 提示词、几何工具、重试预算。

- 替换假模型，不更改 runtime/渲染接口。
- 工具参数校验、对象版本校验、asset manifest 校验。
- mesh 检查已知准确性，unknown 不冒充完成。
- 验证同区新增后再操作新对象；无真实资产不临时下载。

验收：模糊请求可执行并有前后证据；判定者不能写入；目标不满足时可修正；修正超限全回滚。

### P6：导出、验收与交接

产物：日志 ZIP、操作说明、变更清单、测试结果。

- run.json + events.jsonl + 图片 + 几何检查 + verdict + edit receipts。
- 排除密钥；真正导出 Blob，不能只导出已失效地址。
- 列出 modules 外每一处装配改动，确认 core diff 为空。
- 记录模型、版本、预算、实际场景规模及未支持能力。

验收：在重新打开的日志包中，不依赖活跃页面即可看原任务、执行步骤、截图和结果。

## 12. 有意义的测试清单

不写只镜像实现的测试；优先以下高风险行为：

1. 区域写权限、对象 ID 校验、相同 toolCallId 幂等、相同 key 不同参数拒绝。
2. 多区域不同延迟与修正次数下的结果合并、最终等待和并发限额。
3. 在模型等待、截图排队、写入前、判定中、关闭插件时停止，均无迟到写入。
4. 第二区失败后，第一区的新增/删除/变换全部恢复；undo/redo 后归属一致。
5. before/after 相机与对象映射一致；相机移动不污染用户视口；失败恢复 renderer。
6. 旋转缩放对象、嵌套 mesh、完全包含、接触、非闭合几何的碰撞结果符合声明。
7. 旧 Agent、人工快捷键、历史面板、导入和场景切换不能与运行抢写。
8. 多模态工具结果真的进入模型请求；日志不泄露凭据；示例图片可离线打开。

纯逻辑测试放 modules/coagent/tests，使用假 Ports。浏览器集成测试覆盖 R3F/渲染/实际宿主入口；依赖真实 GPU 的检查应记录运行环境，不能仅用 mock 声称截图已验证。

## 13. 给代码开发 LLM 的执行约束

- 先读取当前仓库与本文件，再按照 P0 到 P6 分阶段实施。文档不是已存在的代码。
- 不实现跨区协作、持久化 checkpoint、复杂 RAG、模型训练或通用插件市场。
- 所有新业务代码放 modules/coagent；core 预计零变更。外部改动只用于明确列出的装配和依赖。
- 不复制旧 Agent session 的事务状态机。复用客户端不等于复用整个 Agent 插件。
- 不开启 LangGraph 对包含场景写入节点的无条件自动重试，不启用 checkpoint 自动恢复重放编辑。
- 第一版不承诺崩溃/刷新后续跑；刷新会丢失内存图状态和未保存的编辑事务。
- 保持此前 workflow.png 的业务顺序；图框架是编排实现，不能改变用户确认的先取证后执行。
- 每阶段完成提供变更、验证结果和尚未覆盖项；出现阻塞先缩小验证，不用未测成功的结论代替结果。

## 14. 参考与版本注意

2026-10-20 查阅官方文档：

- [LangGraph JS Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)：StateGraph、节点、状态合并与 Send。
- [Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)：私有状态与多 Agent 子图。
- [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)：持久化另有成本，本方案第一版不启用。

官方文档描述框架能力，不证明该项目已完成浏览器兼容性验证；P0 必须实际构建和运行。关于功能预算，技术实施默认并发区域 2、每任务额外修正 1 次、最多 30 次工具调用；与早期 README 不一致时以本文件为准，全部集中在 config.ts。
