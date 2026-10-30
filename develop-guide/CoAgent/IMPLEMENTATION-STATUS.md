# CoAgent 实施状态

本文件由各工作包交付时更新，是"仓库实际做到哪了"的唯一权威记录。
文档（DEVELOPMENT-SPEC 等）描述目标设计；本表描述现实。
日期均为实际执行日。

## 工作包总览

| 工作包 | 状态 | 完成日期 | 备注 |
|---|---|---|---|
| W00 现状核查 | 完成 | 2026-10-21 | 本文件 §1 |
| W01 契约与假实现 | 完成 | 2026-10-21 | contracts/schemas/config/fakes/fixtures + 45 测试全绿 |
| W02 LangGraph 浏览器验证 | 完成 | 2026-10-21 | @langchain/langgraph 1.5.1 + 55 测试全绿 + 浏览器 4 场景实跑通过 |
| W03 Runtime/事务/宿主接入 | 完成 | 2026-10-21 | runController/writeFacade/editorAdapter/hostLocks + 98 测试全绿 + 浏览器 29 项实跑通过（T08/T09/T13/T16） |
| W04 相机与证据 | 完成 | 2026-10-21 | CoAgentBridge/capture/markers/evidenceStore/observations + 105 测试全绿 + 浏览器 35 项像素级实跑通过（T10/T11） |
| W05 假模型全闭环 | 完成 | 2026-10-21 | mainGraph/regionGraph/agents/tools + 125 测试全绿（6 个固定脚本场景 + 4 类错误路径） |
| W06 真实模型与预处理 | 完成（T14 真机通过） | 2026-10-22 | modelAdapter（OpenAI 兼容）/partition/预处理 UI/错误脱敏 + 260 测试全绿；**10-22 用 deepseek-flash 真机跑通 T14**（分区 9–19 s，整轮 35.4 s 完成）+ **3 个边界场景 3/3 通过**（澄清 / 跨区 unsupported / 不存在目标不编造）+ **add 类端到端示例通过**（44.4 s completed），详见 §8 末 |
| W07 Planner | 完成 | 2026-10-21 | 只读工具规划器 + 精简上下文 + 语义校验 + 澄清 UI + 190 测试全绿（W07 当时 26；10-22 修复后总数 190） |
| W08 Executor/Judge/几何闭环 | 完成（代码/自动化/浏览器） | 2026-10-22 | W08.1 判定 + W08.2 看图 + W08.3 几何 + W08.4 修正/矩阵同步 + W08.5 终检视觉重判 + 246 测试全绿；浏览器 W03 33/33、W04 35/35、W08 9/9。真实模型质量已在 W06 T14 验证 |
| W09 导出、综合验收 | 未开始 | | |
| W10-P0 碰撞配对与分区归属 | 完成 | 2026-10-27 | 见 §17：配对收窄为 targets×targets + targets×statics（不含 statics×statics）+ 覆盖报告 + 切场景作废分区；308 测试全绿 |
| W10-P1 实时状态与增量修复 | 完成 | 2026-10-27 | 见 §18：runState 台账（唯一写集）、写入名额、executionState 修复上下文、区域查询实时化、task-created-count；325 测试全绿 |
| W10-P3 验收保留 | 完成（撤销仅栈顶） | 2026-10-27 | 见 §19：`retained_with_issues` 终态 + 提交保留 + 提交回执 + 撤销资格 + "撤销本轮修改"按钮；353 测试全绿，浏览器 77/77 |
| W10-P4 分区长期存储 | 完成（保存链一致性待补） | 2026-10-27 | 见 §20：partition.json 契约/指纹/核对 + `/api/scene/<id>/coagent` 写接口 + 自动恢复 + 面板状态与按钮；353 测试全绿 |
| W10-P2 观察与定位 | 完成（分区相机状态未做） | 2026-10-27 | 见 §21：有界最新图片窗口 + `scene.pick` + `camera.inspect/adjust`；386 测试全绿；**新增 `w10-observe.mjs` 14/14** 验证真实场景点选与取景 |
| W10-P5 端到端复现 | fake 部分完成 | 2026-10-27 | 见 §22：`w11-endtoend.test.ts` 复现原失败链条并通过变异验证；**真实模型端到端需要模型配置，未做** |

## 1. W00 现状核查结果（2026-10-21）

### 1.1 构建基线

- `pnpm build`（= `tsc -b && vite build`）通过：611 modules，1.4 MB JS / gzip 393 kB，约 1 s。
- 仅有既存警告：单 chunk >500 kB（Vite 提示，与 CoAgent 无关）。
- 无任何测试框架/脚本（与 SPEC §9 一致：测试脚本由 W01 创建）。

### 1.2 core 实际 API 映射（`src/core/`，已逐一读源核实）

| SPEC 假设 | 实际情况 |
|---|---|
| `edit.begin/commit/rollback` | `edit.begin(label, source): TxHandle`；单模块级 `openTx`——begin 新事务会静默顶掉未关闭的旧事务（**不能嵌套**，CoAgent 必须自己保证整轮只有一个 open tx） |
| boolean 返回值 | `setTransform/addAsset/removeAsset` 均返回 `boolean`，false = 目标不存在/文档未加载/重复 id，**不得记成功** |
| rollback 语义 | 按事务内条目逆序恢复资产；**不恢复 redo 栈**（`record()` 一开始就清空 redoStack）；删除时的选中清理不回滚。SPEC §1.4 的已知宿主限制成立 |
| EditSource | `'human' | 'agent'`。CoAgent 用 `'agent'`，角色信息只写自己的 recorder，**不扩 core 枚举** |
| 场景事实 | `useSceneStore.getState().document`（zustand）；store 无任何文档变更 action，写路径只有 core/edit |
| 保存通路 | `core/io.ts saveScene()`：POST `/api/scene/<id>`（dev server 有此接口），失败降级下载 JSON。CoAgent 复用，不自建保存 |
| 单位/坐标 | 米、+Y 上、欧拉角度制 XYZ、模型原点底面中心（`core/types.ts` 头注释与 SPEC §4.1 一致） |
| 事件总线 | `core/events.ts bus`：已有 `scene:changed`（切场景清空历史+openTx）、`history:changed`、`scene:saved` 等。adapter 只在这里订阅 |
| 渲染上下文 | `core/engine.ts registerBridge(gl/scene/camera/controls)`，由 `<EngineBridgeReg/>` 注册。已有 `pickNormalized/captureScreenshot/focusAsset`。**CoAgentBridge 不复用 engine 单例**（CoAgent 需要独立相机/render target，见 SPEC §3.8），但 SceneCanvas 的 Canvas children 挂载点已确认可用（`SceneCanvas.tsx` `{props.children}`） |
| 资产→Three 同步 | `<SceneContent/>` 数据驱动渲染 `<AssetInstance>`；`userData.assetId` 标资产、`userData.editorHelper` 标视觉件、加载完成发 `asset:loaded`。CoAgent capture 前的"编辑已同步"检查可依赖 `asset:loaded` + document 状态比对 |

### 1.3 旧 LLM 客户端能力（`src/modules/agent/llmClient.ts`，已读源核实）

- 导出：`llmChat(opts): Promise<LlmChatResult>`、`testLlmConnection(s)`；非流式最小请求仅测试连接用。
- 三种 wire 协议：`openai-chat` / `openai-response` / `anthropic`，统一 SSE 流式。
- 取消：`opts.signal: AbortSignal` 传入 fetch；AbortError 原样抛出，网络/CORS 错误翻译成可读中文。
- 图像输入：**user 文本消息不支持图**；附图通过 toolResults 携带 `images: [{dataUrl}]`——OpenAI 系紧跟一条 user 图文消息回传，Anthropic 原生内联 tool_result image block。CoAgent modelAdapter 按 SPEC §3.7 直接包装 `llmChat`，图像走"真实 observation 工具调用回图"路径，不造无主 tool result。
- 结构化输出：仅 function calling（`tools` + 自动 `tool_choice`），无 JSON mode；CoAgent 结构化终态靠工具或后解析，schema 修复请求由 modelLoop 实现。
- 设置：`llmSettings.ts` zustand + localStorage，密钥只在本浏览器。CoAgent 复用该设置面，不另建密钥存储。

### 1.4 可修改场景的全部入口（W03 互斥清单）

| 入口 | 位置 | 失效方式（W03 落地） |
|---|---|---|
| 人工编辑模块整体 | `App.tsx` `manualEditing`（gizmo+快捷键+面板） | CoAgent 活跃期置 false |
| 快捷键 Delete/Ctrl+D/Ctrl+Z/Y | `modules/editor/useEditorShortcuts.ts`（window keydown） | 随 manualEditing=false 失效（`useEditorShortcuts(enabled)`） |
| gizmo 拖拽 | `modules/editor/EditorGizmo.tsx`（随 manualEditing 卸载） | 同上 |
| 旧 Agent 写工具 | `modules/agent/tools.ts` `asset.set_transform/adjust_transform/add/remove` | CoAgent 活跃期禁用 Agent 模块（App 已有 agentOn 开关先例） |
| 旧 Agent 事务裁决 | `modules/agent/session.ts`（phase: task/awaiting_user） | App 已按 `agentPhase !== 'idle'` 暂停人工编辑，CoAgent 接入同一互斥位 |
| 历史面板 undo/redo | `modules/history/HistorySidebar.tsx`（`edit.undoTo/redoTo`） | CoAgent 活跃期禁用该面板交互 |
| 场景切换 | `ui/TopBar` → `store.loadScene`（清历史+openTx，会打断事务） | CoAgent 活跃期禁用切换 |
| 导入插件写事务 | `modules/interchange/InterchangePanel.tsx`（导入入库走自己的后端，**不写当前场景**，仅需禁面板按钮防误触） | 低风险，禁入口即可 |

### 1.5 最小宿主改动清单（modules 外）

1. `src/App.tsx`：注册 CoAgent 面板/hook/bridge children、与 manualEditing/agentOn 的互斥接线。
2. `src/package.json` + `src/pnpm-lock.yaml`：devDeps 加 vitest；scripts 加 `test:coagent`（W01）与后续 LangGraph 依赖（W02）。
3. 不动 `src/tsconfig.json`：vitest 配置放模块内（`modules/coagent/vitest.config.ts` + 独立 tsconfig）。

## 2. W01 契约与假实现（完成，2026-10-21）

### 交付内容

新建 `src/modules/coagent/`（本包只含契约层与测试基建，业务实现留给后续包）：

- `contracts.ts`：全部 DTO（Region/UnitTask/Criterion/Constraint/Observation/Verdict/Plan/RunOutcome/事件/图状态）、Ports（ModelPort/RenderPort/EditorReadPort/EditorWritePort/WorkflowRunner/ToolDef）、语义 ID 别名、错误码常量与 `CoAgentError`（含 retryable 默认映射与 `from()` 未知异常收口）。
- `schemas.ts`：零依赖手写校验器：transform/polygon（自交+面积+顶点去重）/region/partition/unitTask/criterion（指标白名单）/constraint/plan（三态）/cameraSnapshot/verdict + 任务 DAG 无环与跨区依赖检查 + `computeAssetFingerprint`（真实适配器与 FakeEditor 共用，保证口径一致）。SPEC §W01"选定运行时 schema 校验方式"→ 结论：不引 zod（不给宿主加运行时依赖），手写守卫 + 单测覆盖。
- `config.ts`：§7.2 默认值（并发 2/修正 1/工具预算 30/超时 120 s/场景就绪 15 s/schema 修复 1 次/自动恢复禁用/凭据导出禁用）+ 有限性上限（总时限 20 min、图片内存 256 MB、日志 32 MB、证据 200 条，标注 [P2/P4 实测调整]）。
- `index.ts`：只公开 DEFAULT_COAGENT_CONFIG 与宿主所需类型；面板/hook/bridge 由 W03/W04 就绪后在此注册。
- `tests/fakes/`：`FakeEditor`（对齐 §1.2 真实语义：单 openTx、begin 顶替孤儿化、boolean 失败条件、rollback 不回孤儿事务、场景切换清 openTx；另有授权门面 applyAuthorized：令牌/作用域/指纹/幂等全查）、`FakeRender`（可编程捕获/就绪失败/离线/几何结果）、`FakeModel`（脚本队列 + hangNext 取消语义 + 请求留档）。
- `tests/fixtures/twoRegionScene.ts`：两区域×2 对象 + 跨区共享 road-1（globalReadonly）+ 4 条目模型目录 + 相机快照 + 可过校验的两任务计划工厂。
- `tests/unit/`：25（schemas）+ 20（fakes）个用例。
- `vitest.config.ts`：模块内测试配置（node 环境），宿主 tsconfig 零改动。

### 测试与结果

- 命令：`pnpm test:coagent`（在 src/ 下）。
- 结果：**45 个用例全绿**（2 文件，约 0.7 s）；覆盖 SPEC §W01 全部六类：非法数字、缺失 ID、错误 schemaVersion、任务循环（含自依赖/未知依赖/跨区依赖）、越权（out_of_scope/stale_object/幂等冲突）、假模型取消（进入前 abort + 挂起中 abort）。
- `pnpm build` 通过（W01 后复跑，1.01 s，仅既存 chunk 大小警告）。
- 修复过程记录：测试自身两处错误（面积期望值算错；rollback 用例误共用 toolCallId 触发正确的幂等拒绝）——fake 行为无误，修的是测试。

### 接口差异（相对 SPEC，均已在此冻结）

- `RenderPort.capture` 返回 `CaptureFrame`（像素+元数据）而非 `Observation`：observationId 由 evidenceStore 铸造（§3.2 职责），Observation 由上层组装。唯一一处对 §5.2 签名的显式修正。
- `EditorWritePort` 在 SPEC 未画出具体形状的基础上冻结为：beginRun/commitRun/rollbackRun/endRun + applyAuthorized（AuthorizedCallContext 携带 token 与 writableObjectIds）。
- `Plan` 落为三态 union（tasks/clarify/unsupported），对应 §3.4 planner 输出约束。
- 错误码全集含 internal_error（SPEC §4.3 提及"未知错误转换"，补为显式常量）。

### 未覆盖 / 已知限制

- `CoAgentPanel/useCoAgentModule/uiStore` 当时尚未实现（W03 已补，见 §5）。
- fakes 通过 contract tests 与真实 core 的等价性在 W03 补（本包阶段真实 core 行为已读源核实并记录于 §1.2）。
- LangGraph 未引入（W02）。

## 3. 决策记录

- 2026-10-21：schema 校验不引第三方库（zod 等），手写校验器 + 单测。理由：宿主 deps 极简（react/three/zustand/drei），契约层零运行时依赖可被任何工作包安全 import。
- 2026-10-21：`RenderPort.capture` 返回 `CaptureFrame` 而非 `Observation`——observationId 的铸造权在 evidenceStore（SPEC §3.2），渲染层只交像素与元数据。
- 2026-10-21：CoAgent 单元/集成测试跑 vitest（node 环境，无 jsdom），配置留在模块内（`modules/coagent/vitest.config.ts`），宿主 tsconfig 零改动；浏览器层测试（T10/T11/T13/T16）到 W04+ 另行引入。
- 2026-10-21：vitest 5.0.5 入宿主 devDependencies（W01 唯一的依赖变更；LangGraph 到 W02 才引入）。
- 2026-10-21（W02）：LangGraph 包名定案 @langchain/langgraph@1.5.1（SPEC 中 @langgraph/langgraph 不存在于 npm）。并行分支采用"原生子图节点 + 共享通道"拓扑；动态节点名经 `looseGraph` 门面绕开类型化 builder 限制。
- 2026-10-21（W03）：写路径收敛为 `runtime/writeFacade.ts` 一份实现，真实 adapter 与 FakeEditor 只注入原子操作。理由：让"fake 比真实 core 更宽松"在结构上不可能（§5.2 的等价性是事务正确性的前提）。
- 2026-10-21（W03）：惰性事务——`beginRun` 只 armed 令牌，首次 `applyWrite` 才 `edit.begin('agent')`。理由：baseline/失败早退的轮次不该在宿主历史里留下空事务。
- 2026-10-21（W03）：error_locked 期间连人工编辑/旧 Agent/历史/切场景一起停用，只留一个显式"重置"出口。理由：§5.4 要求不把 UI 恢复 idle 后让用户继续积累不可信修改；解锁必须是人看过后主动做的动作。
- 2026-10-21（W03）：宿主互斥判断抽成纯函数 `deriveHostLocks`，App 不再内联条件。理由：§1.4 的入口清单会随宿主增长，单点判断才能被单测覆盖（T13 的浏览器断言也引用同一份语义）。
- 2026-10-21（W03）：真实宿主验证用"DEV 专用 devHarness + CDP 脚本"，不引入 playwright。理由：宿主无浏览器测试依赖，Node 22 自带 WebSocket 足够；生产 bundle 经字符串扫描确认不含 harness。验证脚本会备份/还原 `scenes/*/scene.json`，因为 commit 走的是真实保存通路。
- 2026-10-21（W04）：`CaptureRequest` 携带 `sceneRevision` 与 `fingerprints`，渲染层只回显。理由：这两项属于编辑器冻结口径，让 rendering 去读 store 会把 core 依赖带进渲染层（§2.2 红线）；"谁冻结谁传"也更符合一次 run 的不可变快照语义。
- 2026-10-21（W04）：ID 标记用"序号色 + 逐像素解码"，不做拾取回读。理由：射线/颜色拾取只能取中心点，判不了"被遮挡"与"占多少像素"；ID pass 一次渲染就能给出 pixels + pixelBox，而且与 RGB 同帧同相机。
- 2026-10-21（W04）：ID pass 期间强制 `NoToneMapping + LinearSRGB`。理由：ACES 与 sRGB 编码会把序号色压成相邻值（实测会把 1 号读成 2 号），这是标记串号的根因；RGB pass 保持渲染器原设置，保证证据图与用户所见一致。
- 2026-10-21（W04）：证据容量超限直接 `budget_exceeded`，不淘汰旧证据。理由：§3.2 明确"接近上限时明确终止/提示，不静默删掉判定仍需的证据"；释放权交给 `releaseRun`。
- 2026-10-21（W04）：像素断言在页面内解码 PNG（`createImageBitmap + getImageData`），不用 node 图像库、不 mock。理由：W04 完成条件就是"浏览器实际图片可检查"；同时把证据图原样落盘，人工也能复核。
- 2026-10-21（W05）：LangGraph 节点名不能与状态通道同名（实测 `plan`/`summarize` 直接抛错）。节点改名为 `planner` / `summarizer`；这条限制与"节点名禁止冒号"一样，属于必须实测才能发现的运行时约束。
- 2026-10-21（W05）：修正轮不重新取 task_before。理由：before/after 必须同视角同状态，重取基线等于换了一把尺子；修正只改"怎么做"，不改"基准是什么"。
- 2026-10-21（W05）：judge 的结论要过三重代码校验（证据 id 属本轮且可解析、criterion 全覆盖、status 与判据自洽），任何一项不过都按 fail。理由：§3.4 明确"完成声明不等于通过"，判定不能被模型嘴硬带过去。
- 2026-10-21（W05）：写工具必须带 `expectedFingerprint` 或 `basisObservationId`。理由：没有基线的写入无法判断是不是基于旧画面；把这条放在工具层而不是提示词里，模型"忘记"时得到的是可读错误而不是静默写入。
- 2026-10-21（W05）：模型并发用 scheduler 的 semaphore 包住 `ModelPort`，而不是每区各建限制。理由：§3.2 的"全局默认 2"是全局的；包装端口还能让取消在等待名额时也生效。
- 2026-10-21（W05）：W02 的占位外壳改名 `createPlaceholderWorkflow` 并退出运行时装配，只保留拓扑回归。理由：`createWorkflow` 必须只有一个语义（§3.3 的唯一替换入口），两套实现并存会让"到底跑了哪个图"说不清。
- 2026-10-21（W05）：测试用 `directorModel`（按用途 + 轮次编排）替代静态回复队列。理由：judge 必须引用运行时才生成的 observation id，静态脚本写不出来；director 还能断言"证据 id 确实来自本轮"。
- 2026-10-21（W06）：`llmClient` 的 user turn 增加可选 `images`，而不是用"无主 toolResult"夹带鸟瞰图。理由：分区图是用户输入而非工具结果；造假的 tool_result 会污染 transcript 语义（W00 §1.3 已明确"不造无主 tool result"）。
- 2026-10-21（W06）：分区只接受模型给的**归一化图像坐标**，世界坐标一律由程序用同一正交相机反算。理由：模型给世界坐标等于让它猜尺度，错一处整块分区都偏；反过来 uv 与相机一一对应，可用单测锁死方向。
- 2026-10-21（W06）：正交相机必须按"更受限的一边"放大以满足输出图宽高比。理由：`halfH = halfW / aspect` 会在场景 Z 跨度大于 X 时裁掉上下边（实测把 20×20 场景裁成 20×15），属于"看不见的对象"类静默错误。
- 2026-10-21（W06）：模型错误消息统一脱敏后再抛。理由：部分网关会在错误体里回显请求头/密钥；`sanitize` 在适配层做一次，比依赖每个调用方更可靠。
- 2026-10-21（W06）：真实厂商验收坚持"用户手动跑、密钥不进自动化"。理由：DECISIONS §9 已定凭据只走平台设置；本地假装 SSE 服务能覆盖协议层，厂商差异（CORS/工具/视觉）只能真机验。
- 2026-10-21（W06.5）：进度只能由 recorder 事件推导，不允许"假进度条/定时动画"。理由：§5.1 禁止 UI 反向驱动业务，假进度还会掩盖"其实卡住了"；没有任务总数时明确写"按阶段估算"。
- 2026-10-21（W06.5）：分区状态的 UI 同步走 `runtime.onPartition` 订阅，而不是面板本地 state。理由：分区有三个来源（生成/修正/dev 注入），只靠面板自己的 setState 会出现"运行时已有分区、按钮还是灰的"这种脱节（实测踩到）。
- 2026-10-21（W06.5）：开始按钮不可用时必须写出原因，错误/结果紧贴操作区。理由：用户反馈"点了没反应"的根因不是功能没跑，而是 feedback 在折叠线以下或根本没有；可用性反馈属于验收标准而不是装饰。
- 2026-10-21（W07）：规划上下文必须裁剪，并把上限写进文本。理由：把整场景/整库塞给模型既贵又诱导编造；显式写出"最多 N 个任务/目标"后，模型越界时也能被 schema 直接拒。
- 2026-10-21（W07）：planner 只拿只读工具（scene/camera/library），写工具对 main 角色不可见。理由：规划阶段的越权写入没有基线、没有事务语义；"不给工具"比"提示词劝阻"可靠。
- 2026-10-21（W07）：schema 校验与语义校验分两层，真实/假模型共用。理由：形状合法≠事实成立（id 编造、阈值超尺、数量矛盾）；分层后单测能覆盖每一类编造，W05 的假模型用例也继续有效。
- 2026-10-21（W07）：澄清回答拼回"原请求 + 补充说明"再规划，不新开会话。理由：澄清是对同一诉求的补充；新会话会丢掉分区/阈值等上下文，模型容易重复提问。
- 2026-10-21（W07）：`preserve_count` 只与 remove 冲突、`stay_in_region` 对 add 任务允许无 target。理由：这是被 W05 的真实夹具测出来的语义——"别删已有对象、允许新增"与"新增对象的落点必须在区内"，最初写成"与 add 也冲突"是错的。
- 2026-10-22：工具名在 wire 上必须符合 OpenAI 规范（`^[a-zA-Z0-9_-]{1,64}$`），业务名与线上名做双向映射。理由：`scene.get_objects` 的点号会被严格端点 400 拒绝，而分区请求（无 tools）不受影响，症状极具迷惑性。
- 2026-10-22：`run.rolled_back` / `run.failed` 事件必须带 `message` 与 `stage`。理由：只记错误码时，用户只能看到 `model_protocol_error`，无法判断是鉴权、tools 不支持还是上下文超长；可诊断性属于验收标准。
- 2026-10-22（W08.1）：metric 用**最终场景的派生归属**计算，不读冻结的 `region.objectIds`。理由：add/remove/移动后冻结列表必然过期；按多边形重新归属才能反映"现在场景里到底有几个对象"。
- 2026-10-22（W08.1）：`preserve_count` 只查"run 开始时本区对象是否还存在"，新增不算破坏。理由：W05 夹具的"南区加石头 + preserve_count"就是这个语义，之前写成"数量相等"会错误拒绝合法新增。
- 2026-10-22（W08.1）：写前区域检查用保守 AABB + 10 cm 边界容差，越界直接 `out_of_scope`。理由：只查 position 会放过"中心在区内、建筑大半在区外"；容差吸收浮点与贴边摆放，符合 §6.1/§6.2。
- 2026-10-22（W08.1）：无 catalog 尺寸时 `checkRegionContainment` 返回 `unknown`，写前放行、终检不通过。理由：无法证明越界就不该假装合法；但也不能因为缺元数据就阻断所有移动，终检是最后一道闸。
- 2026-10-22（W08.1）：空任务区子图显式返回 `status=pass, tasks=[]`。理由：`dispatch` 为每个分区建子图，单区计划会让另一区走 `taskAt(0)` 抛内部错误；W07 的"只改一个区"请求会直接踩到。
- 2026-10-22（W08.2）：证据图以 dataURL 在请求瞬间交给模型，不把 Blob/dataURL 放进图状态。理由：§4.1 禁止图内放 Blob；同时 judge 必须真的看到像素，二者只能靠"按需转换"同时满足。
- 2026-10-22（W08.2）：before/after 必须同 run/任务/区域/分区版本/完整相机快照/输出尺寸；不满足直接 fail，不调模型。理由：不同相机或不同尺寸的两张图不可比较，模型看到的"变化"可能只是视角变化（§6.3）。
- 2026-10-22（W08.2）：visual 判据没有 before/after 图时不允许 pass。理由：W05 的判定原本只校验证据 id 存在，模型可以在没看图的情况下"嘴硬"；W08.2 把"图确实到达"变成硬条件。
- 2026-10-22（W08.2）：executor 的 camera.capture toolResult 附图每任务最多 2 张。理由：让执行器能核对自己拍到的画面，同时避免多轮捕获把请求和成本撑大。
- 2026-10-22（W08.3）：几何按"AABB → SAT 三角形 → 包含 → 最近距离接触"分层，每对都带 `level`。理由：§6.5 要求给出算法级别与对象对；只给 boolean 无法区分"离得远"和"没算"。
- 2026-10-22（W08.3）：开口网格的包含检测返回 unknown，而不是"不包含→clear"。理由：闭合性是包含测试的前提；没有它，"没检测到包含"不能证明不碰撞。
- 2026-10-22（W08.3）：三角形/对象超预算返回 unknown，不引入 BVH。理由：先保证页面不被高模卡死、结论不撒谎；BVH 的版本/实例矩阵兼容性需要单独验证（§6.5），W09 前再评估。
- 2026-10-22（W08.3）：地面支撑用"两者 minY≈0 且接触距离≤容差"放行。理由：MVP 没有地形接触分类；这是显式配置下的保守放行，不是把地形穿透当合法。没有此证据时接触仍判 collision。
- 2026-10-22（W08.3）：几何遍历跳过 `userData.editorHelper` 子树，缓存按 matrixWorld + geometry uuid/position.version。理由：选中描边壳是资产根的克隆，若把它当资产会拿到空几何；共享 geometry 不能被修改（§6.5）。
- 2026-10-22（W08.4）：修正轮的 `writes`/`executionEvidence` 取并集而不是覆盖。理由：第一轮 add 的对象已经真实存在；若第二轮覆盖写集，TaskResult 与 judge 的 createdObjectIds 会漏掉它（终检/计数都会错）。
- 2026-10-22（W08.4）：捕获前用 `expectedTransforms` 比对 matrixWorld，而不是等固定毫秒。理由：§6.3 要求确认 edit 已同步到 R3F；只等时间会在慢帧/大场景下拍到旧画面。
- 2026-10-22（W08.4）：主图/区域图显式 `recursionLimit: 64`。理由：LangGraph 默认 25，8 任务 × 修正轮 + 子图超步可能触顶；类型未声明，用显式断言保留运行期配置。
- 2026-10-22（W08.5）：终检只对"相关对象指纹确实变了"的任务重判 visual。理由：全量重判每轮多花 N 次模型调用，而多数任务的目标在后任务里没被改；指纹变化是最小可靠触发条件。
- 2026-10-22（W08.5）：重判用原 task_before + 同 regionCamera 的最终 after，并把最终 Verdict 追加进 TaskResult。理由：visual 必须同视角可比；只汇总历史 pass 会漏掉"后任务破坏前任务画面"（§6.6）。

## 4. W02 LangGraph 可行性验证（完成，2026-10-21）

### 交付内容

- 依赖：`@langchain/langgraph@1.5.1`（npm 包名是 @langchain/langgraph，**不是** SPEC 里写的 @langgraph/langgraph——该名在 npm registry 不存在）入宿主 dependencies；包自带 `browser` 导出条件（dist/web.js），Vite 自动选浏览器构建。
- `workflow/state.ts`：图状态通道（RunGraphState / RegionBranchState）+ `mergeKeyedNoLWW`（§4.4 禁止 last-write-wins 的结果表合并，同键不同值抛错）+ `looseGraph` 门面。
- `workflow/verificationGraph.ts`：W02 验证图（长期保留作拓扑回归）：dispatch → 并行区域分支（原生子图节点，内部修正循环）→ finalCheck → END。分支可配置耗时/失败次数/尝试上限/注入异常。
- `workflow/createWorkflow.ts`：WorkflowRunner 外壳——输入分区校验（invalid_plan→rolled_back）、run.started 事件、每区一个占位分支（不连真实写工具）、finalCheck 汇合、程序保底摘要、失败/取消→RunOutcome 映射。测试缝 branchDelayMs/failRegions（W05 移除）。
- `tests/fakes/fakeContext.ts`：WorkflowContext 装配（FakeModel/FakeRender/FakeEditor + capture 铸 observationId + 事件收集），W03/W05 复用。
- `tests/browser/`：probe 页（index.html + w02probe.ts，只 import workflow 构建器，不直接 import langgraph）+ 模块内生产构建配置。脚本 `pnpm build:coagent-probe`。

### 已核实的运行时行为（W02 结论，W05 直接依赖）

1. **并行汇合恰好一次**：两个 `addEdge(START→分支)` / `dispatch→分支` 的分支跑在同一 Pregel 超步内，超步屏障保证 join 节点（finalCheck）在两分支全部终态后**恰好运行一次**——不同耗时分支不会让 join 提前或重复触发。
2. **修正循环不泄漏超步**：分支 = 原生编译子图作为节点，内部 execute→execute 循环完全封闭在子图内，不干扰父图 join 时机。这正是 mainGraph dispatchRegions→regionGraph 的目标拓扑。
3. **AbortSignal**：`invoke(input, { signal })` 在节点执行中 abort 会以 `DOMException(name='AbortError')` 拒绝；`CoAgentError.from` 正确映射为 `cancelled`。外壳另加保险：catch 后只要 `signal.aborted` 一律返回 cancelled（不依赖错误形状）。
4. **节点名约束**：LangGraph 节点名**禁止冒号**（1.5.1 运行时校验）；区域分支节点名用 `region-${regionId}`。
5. **类型化 builder 与动态节点名冲突**：链式字面量累积联合类型无法接受运行期区域名——收敛为自有 `looseGraph<S>(schema)` 门面（state.ts），分支子图（静态节点名）继续用原生链式 builder。
6. **生产构建无 Node-only 依赖**：probe 页经 Vite 生产构建（943 kB / gzip 260 kB）后 bundle 中唯一 "node:" 字样是 langchain 的错误提示文案（建议用户在 Node 配 globalThis.File 的字符串），无真实 `node:` import。

### 测试与结果

- Node：`pnpm test:coagent`——**55 用例全绿**（W01 的 45 + 新增 10：拓扑乱序/修正循环/恰好一次、终局失败、节点异常、等待取消、reducer 冲突与幂等、外壳 4 场景）。
- 浏览器：dev server 实跑 probe 页（Chrome/Electron 146，Vite dev 转换链路）——**4 场景全部通过**（allPassed=true，截图已存会话工件）。
- `pnpm build` 通过（413 ms）；`pnpm build:coagent-probe` 通过。
- 修复过程记录：节点名冒号限制与 builder 类型冲突都是实测暴露后修正（非文档可预知）；验证产物 dist-w02 验后删除。

### 未覆盖 / 已知限制

- 未验证 stream() 分事件消费（MVP 用 invoke 即可，stream 属于 UI 进度投影需要时再加）。
- 未接 MemorySaver/checkpoint（SPEC §1.2 明确不做持久化 checkpoint）。
- 外壳合成的占位计划（每区一个零编辑任务）只在 W02 存在，W05 由真实 planner 产出替换。
- LangGraph 的 recursionLimit 默认 25：W05 的 regionGraph 任务循环要注意修正轮×任务数不触顶（必要时显式调大）。

## 5. W03 运行控制、事务与宿主接入（完成，2026-10-21）

### 交付内容

- `runtime/runController.ts`：一轮请求的唯一编排者。`start` 依次校验 error_locked / 重复 start / disabled / 宿主忙碌（`isHostBusy`）/ 分区缺失；冻结分区深拷贝、铸造 runId + AbortController + 写令牌；工作流结束后等场景队列清空再 commit 或 rollback，随后 save，异常统一转 `error_locked`。`cancel` 只 abort（迟到回调由信号 + 令牌双拦），`requestDisable` 取消并清理后进入 disabled，`reset` 是唯一的 error_locked 出口。
- `runtime/writeFacade.ts`：`EditorWritePort` 的共享实现核。真实 `editorAdapter` 与 `FakeEditor` 都构建在它上面，只注入不同的原子操作，因此 fake 不会比真实 core 宽松（§5.2）。含：令牌校验、惰性事务（首次写入才 `edit.begin`，§5.3）、幂等键 runId+taskId+toolCallId、写作用域、指纹校验、core boolean false → `write_failed`。
- `adapters/editorAdapter.ts`：模块内唯一 import core 的边界。读侧快照 → DTO（rotation→rotationDeg、缺省 scale 归一、manifest→catalog、指纹走 schemas 口径），`document`/`sceneId` 引用变化驱动 `sceneRevision`，`scene:changed` 直接作废武装事务（否则 core 清 openTx 后写入会静默开新事务）。
- `runtime/scheduler.ts` / `runtime/recorder.ts`：模型信号量（全局默认 2）+ 场景串行队列（网络永不占队列）；recorder 单调 eventSeq、写入前递归过滤凭据键，W03 补了 `subscribe`（UI 进度计数，单向）。
- `hostLocks.ts`：SPEC §1.4 互斥清单的唯一判断来源（纯函数）。活跃相位与 error_locked 期间，人工编辑 / 旧 Agent / 历史 undo-redo / 场景切换全部停用；App.tsx 不再写第二份判断。
- `useCoAgentModule.ts` / `uiStore.ts` / `CoAgentPanel.tsx`：模块级懒单例 runtime；相位与锁定投影到 uiStore；面板含状态行（事件计数）、指令输入、开始/取消、结果与错误、error_locked 重置按钮。StrictMode 的 cleanup→remount 用 0ms 延迟释放计时器区分"重挂载"与"真卸载"。
- `dev/devHarness.ts`（**仅 DEV**，生产 bundle 已验证不含）：按当前场景实际资产造两区计划（z<0 / z>=0，各取 ≤2 个可写对象，剩余取 1 个作 globalReadonly）、注入已知 transform 假 workflow、暴露启动/取消/历史/资产/订阅数探针，供 T08/T13/T16 的真实浏览器验证使用。
- `tests/browser/w03-run.mjs`：CDP 驱动脚本（无第三方依赖，Node 22 自带 WebSocket）。启动真实 Chrome → 打开真实 App → 用面板按钮发起 run → 断言真实 core 的 undo 单元与真实 DOM 的互斥状态 → 截图与 JSON 报告；跑完自行还原被保存通路改写的 `scenes/scene-01/scene.json`（字节级校验）。

### 测试与结果

- Node：`pnpm test:coagent` —— **98 用例全绿**（9 文件，约 2.3 s）。W03 新增 43 个：scheduler 5、realCoreTx 7、runController 9、hostLocks 12、runtimeLifecycle 10。
  - 覆盖 SPEC §W03 全部验收点：两区域多次写入只新增 1 个 undo 单元；undo 恢复初始资产、redo 重现成功结果；执行中失败/取消恢复资产集合与 transform；模型迟到（信号中止后写）、工具排队（并发 applyWrite 串行落盘）、重复 start、requestDisable 后残留引用再写；回滚不恢复 redo 栈的宿主限制在 `realCoreTx.test.ts` 有专门用例与注释。
  - 新增解锁/生命周期用例：rollback 失败 → error_locked → reset 可再运行且留 `runtime.reset` 事件；活跃 run 中 reset 被拒；disable/enable 后锁定态仍可见；dispose 退订并拒绝再 start；反复订阅不增长。
- 浏览器（真实宿主，`pnpm dev` + `pnpm test:coagent-browser`）：**29/29 通过**，报告与截图在 `src/modules/coagent/tests/browser/artifacts/`。
  - 场景 `alpinewoodlanddemo`（523 资产）实跑；面板"开始"按钮发起，4 步已知变换跨两区。
  - T08：整轮只新增 1 个 undo 单元（`source=agent`，ops=4，历史面板显示"CoAgent：… Agent 4 步"）；undo 后 523 个资产的 transform 全部回到初始值；redo 完整重放。
  - T13：执行中 TopBar 场景选择器 `disabled=true`、面板显示"执行中"、真实 `Ctrl+Z` 被挡（历史数不变）；人工编辑开关转为"关"。
  - T09：取消后相位 `cancelling → rolled_back`（outcome 记为 cancelled），历史不新增，资产完整恢复。
  - T16：插件连续启停 3 次，`phase disabled` + harness 卸载，重挂载后相位监听数恒为 2（hook 1 + dev harness 1），无增长；无页面级 JS 错误。
- `pnpm build` 通过（tsc + vite，1187 modules，约 0.64 s，仅既存 chunk 大小警告）。

### 接口差异 / 新增（相对 SPEC，均已冻结）

- 新增 `runtime.reset(): ToolResult<null>` 与事件类型 `runtime.reset`：§5.4 要求 rollback 失败后"保留错误与日志、禁止新 run"，因此必须有一个人工解锁动作；事件挂在最近一次 runId 下便于追溯。
- `runtime.diagnostics()`：暴露相位监听数与 disposed，用于 T16 证明"重复启停不重复订阅"。
- `recorder.subscribe(listener)`：单向追加通知，仅用于 UI 计数（W09 导出可复用）。
- `CoAgentRuntime.debugSetPartition / debugSetWorkflowFactory / debugSnapshot`：W06 前分区与模型都未装配，DEV 专用注入缝；生产装配路径不变。
- `index.ts` 新增导出 `deriveHostLocks` 与其输入输出类型（宿主互斥唯一入口）。

### 未覆盖 / 已知限制

- 真实渲染桥（`CoAgentBridge`、独立相机、capture）属 W04：`context.capture` 目前明确抛 `bridge_unavailable`，runController 组装的是最小 Observation 占位。
- 真实分区来源属 W06：生产 `partitionProvider` 返回 null，面板"开始"会给出 `invalid_plan` 明确指引；浏览器验证靠 DEV harness 注入。
- `preprocess`（§3.1 钩子接口）未实现：分区预处理 UI/服务是 W06，W03 不造空入口。
- 导入导出面板未加锁：SPEC §1.4 判定为低风险（不写当前场景），维持"仅提示、不禁用"。
- 浏览器截图在 headless + SwiftShader 下会滞后/偶发重复帧（软件渲染截图接口限制）；断言以 `artifacts/w03-report.json` 为准，截图仅作人工观感参考。执行中截图偶见视口未重绘（同一渲染限制），DOM 断言不受影响。
- 仅验证 `alpinewoodlanddemo` 单场景；W04 起用更小的确定性场景做像素/相机验证。
- `phase` 仍为 W03 粗粒度：baselining/planning/validating 由 W05 工作流事件细化。

## 6. W04 独立相机与证据（完成，2026-10-21）

### 交付内容

- `rendering/CoAgentBridge.tsx`：Canvas 内的端口装配点，用 R3F `useThree` 取真实 `gl/scene/主相机`，构造 `RenderPort` 并注册到 runtime；关插件即注销端口并释放全部离屏目标。**不复用 engine 单例**（§1.2）：捕获用独立相机，主视口相机完全不动。
- `rendering/capture.ts`：`cameraFromSnapshot` 由完整 `CameraSnapshot` 现造相机（perspective/orthographic 两态都支持），离屏 `WebGLRenderTarget` 渲染后读回像素并按左上原点翻行；GPU 状态（renderTarget / clearColor / autoClear / scissorTest / toneMapping / outputColorSpace / shadowMap.autoUpdate / xr）**先存后还，异常路径也一样**；异步段（PNG 编码/标记合成）带 `timeoutMs` 与 AbortSignal 双护栏。
- `rendering/markers.ts`：同帧 ID pass——请求内每个对象整体换成"序号色"材质再渲染一遍，逐像素解码出 `pixels` 与 `pixelBox`；像素数 < 24 判为 `uncertain`（被遮挡/画外显式可见）；ID pass 期间临时取消色调映射并切线性输出色彩空间，避免 ACES/sRGB 把序号色扭成邻号。标记图 = 原 RGB + 标签贴纸（不污染原图）。
- `rendering/pixels.ts`：像素读回/行翻转/PNG 编码（`OffscreenCanvas` 优先，`toBlob` 兜底）、以及"标记图合成"用的 canvas 工具。
- `runtime/evidenceStore.ts`：铸造不可变 `observationId`（`obs-<runId>-<seq>`）、登记 RGB/marked 图片与 objectURL、按字节与条目双上限拒绝继续登记（`budget_exceeded`，不静默淘汰旧证据）、`release/releaseRun/reset` 撤销 URL。
- `services/observations.ts`：一次观测的完整口径 `ready(objectIds) → port.capture → store.add`；桥未挂载 `bridge_unavailable`、取消 `cancelled`、容量 `budget_exceeded`。
- 接线：`runController` 的 `context.capture` 改为调用观测服务，并由 runtime 提供冻结口径（`sceneRevision` 取 `snapshot({objectIds:[]}).sceneRevision`，`fingerprints` 取本次请求对象的指纹）；`context.getObservation` 接到 store；`App.tsx` 在 `SceneCanvas` children 里挂 `{coagentOn && <CoAgentBridge runtime={coagent.runtime} />}`。
- `dev/devHarness.ts` 扩展：`capture()`（走完整链路的真实捕获）、`pixel()/decode()`（页面内解码证据图，供方向/颜色断言）、`moveObject()`（真实 core 编辑，制造"移动后立即捕获"）、`evidenceStats()/renderDiagnostics()`。

### 契约变更（已冻结，记录于接口差异）

- `CaptureRequest` 增加 `sceneRevision: number` 与 `fingerprints: Record<ObjectId,string>`：这两项属于"调用方冻结的上下文"，渲染层只回显——否则 rendering 必须 import editor/core，违反 §2.2 依赖约束。
- `ObservationLabel` 增加可选 `pixelBox` 与 `pixels`：同帧 ID pass 的直接产物，W08 判定与人工复核不必再猜对象在图里哪儿。
- 新增 `RenderPortDiagnostics` 与 `RenderPort.diagnostics?()`：目标/字节/耗时/主相机快照/`mounted`/`contextLost`，T10/T11 的断言依据。
- `CoAgentRuntime` 新增 `config()`、`evidence`、`observations`、`renderDiagnostics()`、`evidenceStats()`、`debugCapture()`。

### 测试与结果

- Node：`pnpm test:coagent` —— **105 用例全绿**（10 文件）。W04 新增 7 个：`tests/unit/evidence.test.ts`（铸号单调、imageId 回溯、URL 撤销、releaseRun 只清本 run、字节/条目双上限、visible 过滤；observations 的 ready→捕获→登记、桥缺失/取消/容量三类显式失败）。
- 浏览器：`node modules/coagent/tests/browser/w04-run.mjs --url=http://127.0.0.1:5173/` —— **35/35 通过**，报告 `artifacts/w04-report.json`，证据图原样落盘 `artifacts/w04-evidence-topdown.png` / `-marked.png`。
  - 场景 `scene-02`（10 个带 tint 的确定性占位体），俯视正交 320×240、`up=(0,0,-1)`。
  - 真实像素：PNG 可解码、132 色、非背景像素 13.7%（物体占比正常）；RGB 与 marked 两张都非空。
  - ID 映射：四个请求对象全部 `visible` 且带像素框；`barrel-01` 在 `barrel-02` 左侧（x 143 < 165）、`shelf-01`（z=-2.4）在 `shelf-04`（z=+2.4）上方（y 55 < 183）——行列方向都对。
  - 颜色：料桶中心像素 `[116,141,54]`（绿通道主导，对 `#7d8a4f`）、货架中心 `[81,97,120]`（蓝 > 红，对 `#66717f`），两者明显不同。
  - 同视角复拍：两次 `camera` 逐字段一致，标记框位移 0 px。
  - 移动后立即捕获：真实 core 把 `barrel-02` 移到 x=2.2 后，标记框右移 53 px（理论 53.3），新位置像素颜色仍是该物体。
  - 被遮挡：横向相机下远处 `shelf-01` 为 `uncertain`、`pixels=0`、无像素框；近处 `shelf-04` 可见（32204 px）。
  - 画外：窄视口下 `barrel-01` 可见、`shelf-06` 为 `uncertain`。
  - T10：非法尺寸 → `invalid_arguments` 且不留半张证据；失败后 `contextLost=false`、桥仍挂载、再次捕获图像正常（157 色）。
  - 用户相机：整轮捕获前后 `mainCamera` 逐字段一致；离屏目标按尺寸缓存（2 个）。
  - 卸载：关插件 → 端口注销、证据 6 条/166 KB/12 个 URL 全部释放为 0；重开 → 桥恢复、目标按需重建、可继续捕获。
- `pnpm build` 通过（tsc + vite，1193 modules，约 0.7 s）。

### 未覆盖 / 已知限制

- `RenderPort.geometry` 仍返回 `unknown`（`highestLevel: 'aabb'` + note）：几何检测属 W08，W04 不假装 clear。
- 捕获必须是同步渲染段：manifest 里的 15 s 超时只能护住异步段（编码/合成），同步 GPU 工作不能被 JS 定时器抢占（与 DECISIONS 的说明一致）。
- `ready()` 用轮询（40 ms）等对象进入渲染层，不订阅 core 事件（渲染层不许 import core）；对象永远不到时会等满 `sceneReadyTimeoutMs` 再报 `renderer_not_ready`。
- 证据图只在内存（Blob + objectURL），持久化/导出属 W09；条数上限 200、内存 256 MB 为 [P2/P4 实测调整] 的保守值。
- 仅对 320×240/300×200 两档尺寸做了像素级验证；更大分辨率未测（W09 导出再评估）。
- 主视口在 headless + SwiftShader 下的截图会滞后（同 W03 记录），因此 T10 用 `contextLost` + 复捕获 + 主相机快照做证据，而不是比截图。

## 7. W05 假模型端到端闭环（完成，2026-10-21）

### 交付内容

- `workflow/mainGraph.ts`：collectContext → planner → validatePlan → captureBaselines → dispatch → 并行 `region-<id>`（原生子图节点）→ finalCheck → summarizer。baseline 是独立节点，dispatch 分支在其下一超步才开始，因此"所有初始基线先于任何写入"由拓扑保证（W02 已验证的超步屏障），不靠执行速度。finalCheck 一次跑完四类检查：每区结果、证据可解析（`getObservation`）、`stay_in_region`（用**最终**场景与分区多边形）、`preserve_objects`。
- `workflow/regionGraph.ts`：`prepare`（取本任务 task_before）→ `execute`（executor 工具循环）→ `judge`（同相机 after + 判定）→ 通过 `advance` / 未过 `execute`（修正轮）/ 用尽 `finishFail`。修正轮**不重取基线**（同视角才可比）；每项任务各自 task_before，所以同区第二任务的即时基线不覆盖整轮 baseline。
- `agents/planner.ts`：一次模型调用产出计划；`validatePlan` 之外补语义检查（任务区必须存在、目标必须属区、global_readonly 不可作目标、add 与 targetObjectIds 互斥）+ DAG 检查；不合格按 `schemaRepairAttempts` 回灌 issues 修一次，仍不合格 `invalid_plan`。
- `agents/modelLoop.ts` + `agents/executor.ts`：模型↔工具往返；工具集按角色给（judge 的清单里没有写工具），每轮检查 AbortSignal，轮次/预算硬上限。
- `agents/judge.ts`：判定 JSON 必须过 `validateVerdict`；证据 id 必须属于本轮（before/after/执行期捕获）且能从证据库取回；`criterionId` 必须来自任务且不得漏判；`status=pass` 但存在非 pass 判据 → 降级 fail。判定不合格一律按 fail（不当作通过）。
- `tools/`：`registry`（角色过滤 / 作用域 / 预算 / 参数收口）、`sceneTools`（分区摘要、对象详情、模型库检索）、`editTools`（写命令 + 基线指纹解析）、`cameraTools`（区域俯视相机、聚焦相机、捕获）、`geometryTools`（透传，W05 仍 unknown）、`args`（不可信参数解析）。
- 接线：`runController.context.render` 现在接真实渲染端口（未挂桥时是明确报 `bridge_unavailable` 的桩，不是 null）；`createRuntime` 用 scheduler 的 semaphore 包住模型端口（全局并发上限，不是每区一个）；`createWorkflow()` = mainGraph；W02 占位外壳移到 `placeholderWorkflow.ts`，只作拓扑回归。

### 契约 / 接口变更

- `ToolCallContext` 增加 `toolCallId`：写门面的幂等键是 runId+taskId+toolCallId，工具层必须能透传。
- `createWorkflow` 语义变更（W05）：默认实现从"占位外壳"换成 mainGraph；需要占位行为的地方显式用 `createPlaceholderWorkflow`。

### 测试与结果

- Node：`pnpm test:coagent` —— **125 用例全绿**（12 文件，约 2.8 s）。W05 新增 20：`tests/unit/tools.test.ts` 12 + `tests/integration/w05-flow.test.ts` 8。
  - 场景 1/2/3/4/5（一个用例串起）：两区四任务；观测序列前两条是两区 baseline，第一次写入发生时已有 ≥2 条证据；task_before 恰好 4 条（每任务一次）；n1 判定两次（fail → 修正 → pass）；最终 transform 与新增对象符合脚本；`plan.ready` 早于 `baseline.ready` 早于 `task.started`；`add` 的回执进了 TaskResult；finalCheck 的 region 检查全过。
  - 场景 6：B 区 s2 两轮判定均 fail → 南区终局失败 → **runtime 真实事务 rolled_back**，`rolledBackRuns=1`、`committedRuns=0`、`savedVersions=[]`，A 区 tree-1/tree-2 恢复原值、新增岩石消失。
  - 场景 5（commit）：正常一轮 `committedRuns=1`、`savedVersions=[1]`。
  - 并发上限：`modelConcurrency=1` 时两区并行仍只有一个模型请求在飞（peak=1）。
  - 错误用例：schema 错误计划（不执行、零证据、`invalid_plan`）；越权工具（road-1 是 globalReadonly → 工具层拒绝，错误码回灌进 toolResult，场景未变，整轮 rolled_back）；编造证据 id（判定不可信 → fail → 整轮不通过，且是"区域未通过"而非内部异常）；T17（后任务把前任务对象移出分区 → finalCheck 报"离开"，整轮 rolled_back）。
- `pnpm build` 通过（1207 modules）。
- 浏览器回归：W03（29 项事务/互斥/生命周期）与 W04（35 项像素/相机/证据）在改动后重跑，均通过（见 §6/§5）。

### 未覆盖 / 已知限制

- **真实模型未接（W06）**：生产 `modelPort` 仍是"未装配"桩，面板点"开始"会在 planner 处得到 `model_protocol_error` 并整轮回滚——如实报错，不是流程缺陷。
- **判据没有真正计算**：`metric`（region.object_count / min_pair_distance_xz）与 `visual` 都只做形状与证据校验，真正算指标属 W08 的 validation service；W05 的"通过"来自假模型脚本 + 证据合法性，不代表视觉判断已实现。
- `geometry.check` 仍返回 `unknown`（W08 实现 AABB/mesh）；judge 提示词已明确"unknown 不能当 clear"。
- 同一区域内任务串行（不并行）；跨区任务禁止；regionGraph 的 recursionLimit 未显式调大（4 任务 × 修正轮未触顶，W07 任务更多时需要复核）。
- 图像没有进模型输入（`ModelMessage.images` 未用）：假模型只看文字；真实图片路径属 W06。
- planner 只看分区摘要与模型库，不看图；检索式上下文压缩属 W07。

## 8. W06 真实模型与分区预处理（代码完成，2026-10-21；**待真机验收**）

用户选型：**OpenAI 兼容协议 + 单一多模态模型 + 手动验收**（密钥只在浏览器本地，不进聊天/日志）。

### 交付内容

- `adapters/modelAdapter.ts`：把 `ModelPort` 接到宿主既有 `llmChat`（openai-chat / openai-response / anthropic 三种 wire 都通）。职责只有"契约翻译 + 错误翻译"：
  - `ModelRequest.images` → 用户轮附图（W06 给 `llmClient` 的 user turn 增加了 `images`，三个协议分别映射 `image_url` / `input_image` / anthropic image block）；
  - 401/403 → 不可重试的鉴权错误、429 → 可重试限流、超时 → `model_timeout`、取消 → `cancelled`；
  - 错误消息统一脱敏（`sanitize` 把 apiKey 替换成 `***`）；未配置（无 key/model/baseURL）直接报错且**不发请求**。
- `services/partition.ts`：鸟瞰 VLM 分区。模型只允许给**归一化图像坐标**，世界坐标由程序用同一台正交相机反算；随后做几何校验（≥3 点/无自交/面积>ε/u·v 范围）、对象归属（地面锚点：多命中=ambiguous、零命中=unassigned）、区域重叠检测、`global_readonly` 策略、`PartitionReport`（相机、提案、issues、歧义、只读建议、时间）与 `partitionVersion`。
- `runtime.createRuntime`：新增 `preprocess()`（鸟瞰相机 → 证据图 → 模型 → 反算/校验/归属 → 记版本与报告）、`partition()/partitionReport()/applyPartitionFix()/setPartition()/modelStatus()`；`modelPort` 默认装配 `createModelAdapter()`（换掉 W03 的"未装配"桩）。
- `CoAgentPanel`：新增"分区"区块——模型状态（已配置/未配置 + 脱敏摘要）、生成分区按钮、分区版本与各区对象数、issues 列表、**人工归属修正**（歧义对象点区域归入 / 标只读，未归属对象同样可点），ready 之前开始会如实报 `invalid_plan`。
- 事件：新增 `partition.ready`（版本、相机、各区对象数、issue 数、模型摘要），进 recorder 便于复盘。

### 测试与结果

- Node：`pnpm test:coagent` —— **148 用例全绿**（14 文件）。W06 新增 23：`modelAdapter.test.ts` 8 + `partition.test.ts` 15。
  - `modelAdapter` 用**本地假装 OpenAI 兼容的 SSE 服务**跑真实 wire：文本聚合、工具调用增量拼接、图片确实进请求（`content` 变 text+image_url 数组）、401 可读且消息不含 key、429 标记可重试、超时 → `model_timeout`、取消 → `cancelled`、未配置不发请求。
  - `partition`：uv↔世界坐标单调性与方向（画面上方=-Z）、非正交相机拒绝、脏 JSON/区域不足/非法点全部 `invalid_plan`、自交与过小多边形被跳过、多命中/零命中显式、重叠检测、`readonly` 策略、快照通过 `validatePartitionSnapshot`、鸟瞰相机覆盖全部资产。
- `pnpm build` 通过（1209 modules）。
- 浏览器回归：W03（29 项）与 W04（35 项）在改动后重跑通过。

### 本轮实测发现并修掉的缺陷（值得记住）

1. **正交相机宽高比处理错误**：`regionCamera`/`birdseyeCamera` 原来用 `halfH = halfW / aspect` 推竖直范围，场景在 Z 方向比 X 方向长时会被裁掉。现在按"更受限的一边"放大，保证宽高比等于输出图且两个方向都覆盖。
2. **uv→世界坐标的 z 符号反了**：`up=(0,0,-1)` 时局部 +Y 指向世界 -Z，原实现多取了一次负号，导致整块分区上下颠倒（归属会全错）。已修并由"v 增大 z 增大、画面上方=-Z"两条单测锁住。

### 待真机验收（T14 + 分区可复现，按此清单手动跑一次）

1. 打开 http://127.0.0.1:5173/ → 左栏「AI 编辑 → 设置」→ 选 OpenAI 兼容供应商、填 baseURL / API Key / **多模态模型名** → 保存。
2. 场景选 `scene-02`——下拉框里显示的是 `meta.name`，即**「示例·仓储排布」**（10 个资产，小、便宜）；也可直接用 `http://127.0.0.1:5173/?scene=scene-02`。
3. 左栏滚到「CoAgent 布局」→「分区」区块应显示"已配置（provider / protocol / model @ host）"→ 点「生成分区（鸟瞰 VLM）」。
4. 判定标准：
   - 面板出现"分区 v1：区名(对象数) / …"，且对象数加起来接近 10（允许有未归属/只读）；
   - 如果出现"需要人工归属"，点区域名后分区对象数变化；
   - recorder 里有 `partition.ready`（事件计数 +1 以上）。
5. 输入一句指令 → 开始 → 观察是否进入 planning/executing，以及最终是 completed 还是 rolled_back（**第一次真实调用允许失败**，重点看错误可读）。
6. 回传给我（脱敏）：面板截图 + 报错文本 + 事件计数；**不要**回传 API Key。若报 CORS/401/模型不支持工具，我会据此调整协议或降级策略。

### T14 真机验收结果（2026-10-22，deepseek-flash）——已通过

**执行方式**：新增 `tests/browser/w06-t14.mjs`（可见 Chrome + 独立 profile + CDP 驱动；Node 22 自带 WebSocket，零新依赖）。API Key 由用户在弹出的设置弹窗里手填，**脚本从不读取** localStorage 的 `apiKey`，输出只有 `provider / protocol / model @ host` 摘要。跑的是真实 `createWorkflow()`，**不调用** `__coagentDev.arm()`（那会换成假 workflow）。

**模型**：`deepseek-flash`（官方 = DeepSeek-V4.1-Flash-1017；能力表 Tool Calls ✓ / Vision ✓ / 1M 上下文，单模型即可覆盖分区+规划+执行+判定）。协议 `openai-chat`，baseURL `https://api.deepseek.com/v1`。浏览器直连**无需代理、无 CORS 问题**。

**场景**：scene-02「示例·仓储排布」，10 个资产（6 面墙 + 2 棵树 + 2 个木箱）。

**结果**：

- **分区（鸟瞰 VLM）**：3 次独立运行 9.1 s / 11.4 s / 19.3 s，10 个对象**全部归属**（歧义 0、未归属 0），语义正确——北/南建筑带 + 中部空地；另一次给了 4 区（含 1 个空区）。
- **整轮**：指令「把场景里两个木箱排成一行，间距 1.5 米以上，别碰到树」→ 1 个任务、4 个区基线、judge `pass`、`run.committed`，**35.4 s**，终检 10 项通过，进度 100%；历史里只有一条 `CoAgent: …`（整轮一个 undo 单元，T08 性质保持）。
- **落地效果（`scenes/scene-02/scene.json` 真实 diff）**：crate-01 `z 0.1→0`、`ry 20°→0°`；crate-02 `x 2.5→4.2`、`z -0.4→0`、`ry -10°→0°`；最终两箱间距 **2.6 m ≥ 1.5 m**，墙与树未被触碰。**跑完已按备份还原场景，sha256 与运行前一致**。
- **T14 判定**：错误可读（`run.rolled_back` 带 `{reason, message, stage}`）；面板进度/分区/历史均正常。

**真机暴露并已修的缺陷（提示词 / 归一化层）**：

- 首次运行失败：`tasks[0].criteria[0].unit 必须是非空字符串（如 m、count）`。
- **根因**：提示词只给了 visual 判据示例，metric 判据的 `metric/operator/value/unit` 从没被要求过；修复轮示例同样是 visual-only，模型两轮都补不出来。
- 修复三处：`prompts.SYSTEM_PLANNER` 补 metric 判据形状（含 `operator` 只允许 gte/lte/eq、`unit` 距离 m / 计数 count）；`planner.repairText` 在判据类 issue 时补完整示例；`planner.normalizePlanJson` 按 `schemas.METRIC_UNITS` 给漏填的 metric 判据补量纲（unit 只进判定文案、不参与计算，因此不属"猜语义"；显式写错的 `operator/value/schemaVersion` 仍被拒绝）。
- 新增 3 个测试（归一化补量纲、模型自己写的 unit 不被覆盖 + operator 错仍拒绝、修复轮含 metric 示例）。全量 **240 用例全绿**（23 文件）。

**真机暴露、留给 W09 的问题**：

1. **分区多边形每次都重叠**（3 区时 2 条 issue、4 区时 4 条）：程序如实报出，但不会自动修正，只能靠 `applyPartitionFix` 按对象搬区。重叠会削弱 `stay_in_region` 的约束力（对象落在 A 区多边形里，也可能落在 B 区里）。
2. **分区命名不稳定**：同场景三次分别叫「中央空地」「中部林地空地」「西侧树丛空地 / 东侧箱体营地」。用户按地名下指令容易指不上，建议规划上下文里同时给 region id 与对象清单（目前 `plannerContext` 已给 id，但提示词里鼓励按 name 指代）。
3. **`verdict.ready` 只记 `{status, credible}`**：judge 的 **after 证据 id**、逐条 criteria 结论、`repairSuggestions` 都没进 recorder。后果：事后无法复核"判定时到底看了什么"，面板只能显示 pass/fail，而且 **W09 导出要复用证据图时拿不到 after id**——必须先补事件字段，不能靠重新截图（§16 已记）。
4. **`plan.ready` 只记 `{kind, tasks, candidates, truncated}`**，不记计划正文：复盘"模型究竟规划了什么"必须重跑一轮。
5. 4 区那次出现 **0 对象的空区**，区子图如实返回 `noTasks` 跳过，但面板没有提示"这个区可能是模型幻觉"，用户会以为分区正确。

**复跑命令**（在 `src/` 下，dev server 需在 5173）：

```
node modules/coagent/tests/browser/w06-t14.mjs setup       # 起窗口、预置 deepseek-flash、打开设置弹窗（手填 Key）
node modules/coagent/tests/browser/w06-t14.mjs preprocess  # 鸟瞰 VLM 分区
node modules/coagent/tests/browser/w06-t14.mjs runui --text="…"   # 走真实 UI：填指令 → 点开始
node modules/coagent/tests/browser/w06-t14.mjs clarify      # 读「需要澄清」块并点第一个选项
node modules/coagent/tests/browser/w06-t14.mjs sniff        # 打印模型每轮往返（调了什么/返回什么/HTTP 错误原文）
node modules/coagent/tests/browser/w06-t14.mjs panel        # 面板文本 + 截图
node modules/coagent/tests/browser/w06-t14.mjs report       # 分区报告（issues/歧义/未归属）
node modules/coagent/tests/browser/w06-t14.mjs evidence     # 导出本轮证据图 PNG
node modules/coagent/tests/browser/w06-t14.mjs reload      # 改完模块必须整页重载，否则跑的是 HMR 旧闭包
```

`runui` / `clarify` 加 `--sniff=true` 可在**运行前**装上 fetch 拦截器，之后用 `sniff` 命令回看——这是定位"模型为什么不停调工具"的唯一手段（2026-10-22 靠它查出了重发写入的死循环）。

产物在 `tests/browser/artifacts/w06-t14-*.png`（分区面板、鸟瞰图、运行面板、任务基线证据图）。注意本地 dev server 只绑 `::1`，要用 `http://localhost:5173/`，`127.0.0.1` 连不上。

### T14 追加：边界场景实测（2026-10-22 第二轮，deepseek-flash）—— 3/3 通过，并修掉 3 个真机缺陷

第一轮 T14（上方）只验了"happy path"。本轮补了 3 个边界场景，并因此挖出 **3 个此前只在真机才会出现的缺陷**（全部已修 + 已加回归锁）。

**边界场景结果（全部通过）**：

| # | 指令 | 期望 | 实测 |
|---|---|---|---|
| 1 | 「把场景弄乱一点，看起来更自然」 | 不可量化 → 转澄清 | `plan.ready {kind:"clarify"}`，9.1 s。**模型没有自己编阈值**，正确 |
| 2 | 「把北侧的一个货架搬到南侧去」 | 判 unsupported | `plan.ready {kind:"unsupported"}` → `invalid_plan`。报错文案还给了替代方案（目标区新增货架 / 只在本区调整） |
| 3 | 「把那个红色的直升机停到南侧空地上」 | 不存在目标 → 不编造 | 转澄清，并列出场景里**真实存在**的对象（shelf-01~06 / barrel-01,02 / crate-01,02）、说明模型库检索 helicopter 无结果、并指出"停到南侧"属跨区搬移，给出 3 个可选方案 |

场景 1 选完澄清选项后**整轮 completed**（此前同一场景必然 `budget_exceeded`）：`barrel-01/02`、`crate-01/02` 移动并旋转（barrel-01 `ry 14°`），最小间距 **0.81 m ≥ 要求的 0.6 m**，6 个货架**完全未被触碰**。跑完已按备份还原场景，sha256 一致。

**本轮真机暴露并已修的 3 个缺陷**：

1. **并行下失败定位指向错误的区**（`workflow/mainGraph.ts` + `workflow/regionGraph.ts`）
   - 现象：报错 `stage: region-region-南侧建筑带`，但出错的其实是**另一个区**的任务。
   - 根因：`mainGraph` 里 `stage` 是**所有区域子图共享的可变变量**（`let stage`，并行节点里 `stage = nodeName` 互相覆盖），谁最后完成谁赢。四个区并行 → 定位信息随机。
   - 修复：区域子图 `execute` 节点把错误包一层，**自带 `regionId` / `taskId` / `stage:'execute'`**；主图 catch 时优先用错误自带的 region，否则才回落到共享 `stage`。修复后同一场景报 `stage: region-region-中央空地:execute`——正是真正出错的区。
   - 回归锁：`w05-flow.test.ts` 新增用例（北区任务超预算 → 必须指向 `region-north`）。**已验证该用例在回退修复后会失败**（报 `region-region-south`），确保它真能抓住这个 bug。

2. **planner 调 `camera.capture` 必然被拒**（`tools/registry.ts`）
   - 现象：planner（`main` 角色，`regionId=null`）一旦调 `camera.capture`，必定 `out_of_scope: 调用缺少有效的 region 上下文（regionId=null）`——**即使模型自带了 camera 快照也照样被拒**（旧实现无条件先 `regionOf()`）。
   - 修复：region 上下文改为**可选**——有 regionId 就用区域相机，没有就**必须自带 camera 快照**；两者都没有时报错文案明确指出"请在 camera 参数里给出相机快照"。
   - 回归锁：`tools.test.ts` 新增 2 例（自带 camera 可拍图 / 无 camera 时报错清晰）。

3. **模型重发同一条写入 → 死循环耗尽轮次预算**（`runtime/writeFacade.ts` + `tools/registry.ts` + `contracts.ts`）
   - 现象：`budget_exceeded: 模型-工具往返超过 6 轮仍未收尾`。抓包后发现：**模型其实早就干完了活**（4 个对象写完、几何 `clear`、after 图也拍了），但它重发同一批 `edit.transform` 时被拒 → 看到失败就再发 → 循环到超预算。
   - 根因：写入幂等键是 `runId|taskId|toolCallId`，**每次工具调用 id 不同 → 幂等缓存命不中**；而首次写入已改掉指纹，于是重发被判 `stale_object`。
   - 修复：指纹不匹配时，若**目标 transform 与当前状态已经一致**（容差 1e-3），判定为"已达成"，**返回成功**并打 `alreadySatisfied: true`，回执附明确文案"已经处于目标 transform，无需再次修改；请勿重复调用本工具"。目标**不同**的冲突重发仍返回 `stale_object`（不把真冲突吞成成功）。
   - 回归锁：`tools.test.ts` 新增 2 例（重发同目标 → 成功 + `alreadySatisfied`；重发不同目标 → 仍 `stale_object`）。

4. **400 错误的误分类**（`adapters/modelAdapter.ts`）
   - 现象：真机跑出 `model_protocol_error: 该模型/接口不支持函数调用（tools）：请换一个支持 function calling 的模型`——但同一个 `deepseek-flash` 前面明明调过工具，**这是误报**，会误导用户去换模型。
   - 根因：服务商 400 原文里**只是提到** "tool"（如 `tool_call_id` 不合法、tools 数量超限、tool 参数 schema 不合法），旧实现只要看到 `tool|function call` 字样就一律翻成"能力不支持"。
   - 修复：只有原文**明确表达"不支持"**（`not support|does not support|unsupported|不支持`）且提到 tool/function call 时才翻成能力问题；其余 400 回落到通用分支并把**原文透出**（`details.raw`），上下文超长的判断也补了"上下文"中文写法。

**本轮测试与回归**：单元 **246 全绿**（23 文件，新增 6 例）；`tsc -b` 干净；`pnpm build` 通过；浏览器回归 **W03 33/33、W04 35/35、W08 9/9** 全绿（这三套**必须显式传 `--url=http://localhost:5173/`**——脚本默认连 `127.0.0.1:5199`，而 dev server 只绑 `::1`，不传就 timeout；T14 脚本也改用独立端口 9334，避免与 w03/w04/w08 抢 9333）。

### T14 第三轮：端到端示例（add 类指令）与「提示词只给示例」类缺陷的根治（2026-10-22）

用户真机跑「雪屋有点少，再摆几栋」失败于 `constraints[1].kind 未知约束类型 no_overlap_existing`。
这暴露了一类**反复出现**的缺陷：提示词只给示例、不给全集，真实模型于是自创字面量。

**本轮修掉 4 个**（全部有回归锁）：

1. **约束白名单**（`schemas.ts` / `prompts.ts` / `planner.ts`）
   - 提示词列出 4 种约束全集（`stay_in_region` / `no_collision` / `preserve_count` / `preserve_objects`）并注明"不要自创名字"；
   - 修复轮识别约束类 issue 时给出白名单；
   - 归一化层映射**语义等价**的同义名（`no_overlap_existing`/`no_overlap`/`avoid_collision` → `no_collision`；`keep_in_region` → `stay_in_region` 等），**不在表里的名字仍被拒**（不猜语义）；
   - 校验错误信息也列出白名单，模型能自我纠正。
2. **add 任务的 targetObjectIds**（`prompts.ts` / `planner.ts` / `planValidation.ts`）
   - 真实模型给 add 任务也列了 targetObjectIds → `add 任务不应同时列 targetObjectIds`。提示词补上"add → targetObjectIds 留空数组"，修复轮补对应提示。
3. **执行器在 add 任务里不知道该用哪个 ref**（`prompts.ts` / `executor.ts` / `regionGraph.ts`）
   - 现象：`budget_exceeded`——执行器反复用不同关键词调 `library.search`，把 6 轮预算耗在检索上。
   - 根因：executor 上下文只给了目标区**已有**对象，没给可新增的模型库候选。
   - 修复：把模型库候选直接写进执行器上下文，**优先本区已在用的 ref**（"再添一个料箱"就该用现有料箱的 ref），再补同类兜底（封顶 8 项）。
4. **`library.search` 多关键词 + limit 越界**（`tools/sceneTools.ts` / `tools/registry.ts`）
   - 查询串按空白拆词，**任一命中**即匹配（原来整串匹配 → 模型发 "box crate 料箱" 必然返回空 → 它再换 3~4 个词反复试）；
   - `limit` 越界**夹到 [1,10]** 而不报错（模型偶尔要 12，报错只白白多花一轮）。

**示例结果（真实 deepseek-flash）**：指令「中央活动空地的料箱有点少，再添一个料箱，和现有的保持 1.5 米以上间距」→ 分区 9.1 s、整轮 **44.4 s completed**、`run.committed`、终检 10 项通过；新增 `placeholder-box-agent`（`models/placeholder-box`），与所有对象距离 ≥ 1.5 m（最近 barrel-01 = 1.628 m），6 个货架与 2 个料桶**未被触碰**。截图与运行记录见 `G:\GraduateDesign\Presentations\1022-3DLayout-CoAgent\`（`01-before.png` / `02-after.png` / `03-panel.png` / `示例-run-log.md` / 前后 scene.json）。

**本轮回归**：单元 **260 全绿**（23 文件，新增 9 例）；`tsc -b` 干净；`pnpm build` 通过；浏览器回归 W03 33/33、W04 35/35、W08 9/9。

### 未覆盖 / 已知限制

- 真实厂商的"文本+图片+工具"已在 `deepseek-flash` 上真机跑通（见上"T14 真机验收结果"）；**取消 / 限流 / 鉴权失败**等错误路径仍只有本地假 SSE 服务的 wire 级验证。
- 分区人工修正目前只有"归入某区 / 标为只读"，没有拖拽多边形顶点（SPEC 允许首版用顶点表/归属表，但多边形手编 UI 未做）。
- 鸟瞰图固定 768×576、单帧；没有多视角/分块，超大场景（如 523 资产的 alpine）可能一张图看不清，需要 W09 前再评估。
- 分区质量完全依赖 VLM；程序只能保证"坐标/拓扑/归属自洽"，保证不了"语义分区合理"。
- metric/visual 判据仍不计算（W08）；`geometry.check` 仍 unknown（W08）。
- `preprocess()` 要求已配置模型；未配置时按钮禁用并给出指引。

### W06.5 面板进度与分区可视化（同日追加，完成）

**问题（用户反馈）**：点"开始"像没反应。实际是三个原因叠加：
1. 没有分区时 `start` 如实返回 `invalid_plan`，但错误显示在面板最下方的"最近结果"里，看不到；
2. 缺少输入/分区/锁定时按钮直接 disabled，**没有说明为什么**；
3. 运行期没有进度投影，相位变化只体现在一行小字上。

**修复**：
- `uiProjection.ts`（纯函数）：从 recorder 事件推导进度——计划任务数、已完成/失败、百分比、阶段、当前动作、区域列表；`formatEvent()` 统一事件行文案。**不造假动画**：没有 `plan.ready` 时明确写"按阶段估算"。
- `CoAgentProgress.tsx`：进度条 + 阶段/当前动作 + 计时 + **可折叠执行明细**（真实事件流，运行中默认展开、最多保留 300 条）+ 分区俯视 SVG（等比例，画面上方 = -Z，带区域名与坐标范围）。
- `CoAgentPanel` 重排：错误/上一轮结果紧贴操作区置顶；按钮不可用时在下方写明原因（先输入指令 / 先生成分区 / 正在运行 / 已锁定）；运行中提示看上方进度。
- `runtime.onPartition(listener)`：分区变更（生成/人工修正/dev 注入）统一走订阅通知面板，修复"注入了分区但按钮还是灰的"这类 UI/运行时脱节。

**测试**：
- 新增 `tests/unit/uiProjection.test.ts` 9 个：百分比/完成数/当前动作/修正轮/阶段兜底/终态文案/事件行格式/裁剪上限。
- 浏览器 W03 从 29 项扩到 **33 项**，新增："运行中显示进度（百分比 + 阶段 + 当前动作）"、"执行明细可折叠且有事件行"、"完成后面板 100%"、"分区注入后面板同步"。

**放到 W08/W09 的**（本轮不做）：证据缩略图预览、工具参数/返回详情、任务级时间线回放、执行记录导出。理由：这些依赖 W08 的判定数据与 W09 的导出规格；事件流本身现在已可用，后续只需在文案表补类型。

**2026-10-21 追加修复（用户反馈"点生成分区就出现进度条 / 进度 0% 已停止"）**：
- 原因一：`partition.ready` 也是 recorder 事件，而进度面板"有事件就显示"，于是分区操作看起来像一次 run；
- 原因二：`preprocess()` 不改变相位，上一轮 `rolled_back` 的终态一直粘着，进度把旧终态套到新事件上（没有计划任务数 → 0% + "按阶段估算"，终态 → "已停止"）。
- 修复：`preprocess()` 现在有自己的相位（`preprocessing` → 结束回 `idle`，期间宿主互斥照常生效），运行中/锁定中拒绝重新生成；面板在开始生成时清空上一轮事件与结果；只统计 `runId !== 'preprocess'` 的事件，且只在"真正的 run"或已有 run 事件时显示进度条。

## 10. W07 真实 Planner（完成，2026-10-21）

### 交付内容

- `agents/plannerContext.ts`：**精简上下文**生成器（纯函数）。按请求关键词（中文 2-gram）匹配对象名/ref/模型库名/类别，再补每区样本与视口近邻，候选上限 24、模型库上限 12；文本里显式写出指标白名单、任务/目标/字数上限、"不要编造 id/阈值"、clarify/unsupported 的触发条件。没有视口时如实写"不可用"，不假装有。
- `agents/planner.ts`（重写）：规划器变成 **只读工具循环**（`runToolLoop` role=main，最多 4 轮），可以 `scene.get_objects` / `camera.capture` / `library.search` 核对事实；写工具对 main 角色不可见（registry 过滤）。最终文本解析成 `Plan`，走 **schema + 语义** 两层校验，失败把 issues 回灌修一次，仍不合格 `invalid_plan`。
- `services/planValidation.ts`：语义校验（W07 的核心产出）——目标 id 必须存在/属于该区/不是 global_readonly；transform/remove 必须有目标（不许"你猜"）；add 与 targetObjectIds 互斥；`region.object_count` 与当前数量及 add/remove 能力自洽；`min_pair_distance_xz` 不得超过场景尺度；`preserve_count` 与 remove 冲突；`stay_in_region` 对 add 任务允许无 target（约束落点）；任务数/目标数/objective 长度上限；跨区依赖与依赖不存在。**真实模型与假模型走同一套**。
- `workflow/mainGraph.ts`：collectContext 保存全量资产与模型库；planner 节点用视口相机（`context.render.diagnostics().mainCamera`）构造上下文；validatePlan 节点重复执行语义校验（纵深防御）；`clarify` → `needs_clarification`、`unsupported` → `rolled_back(invalid_plan)` 并把原因原样带给用户；其他非 tasks 计划不再误入 baseline/dispatch。
- 澄清 UI：`uiStore.pendingClarify` + 面板"需要澄清"区块（问题 + 选项按钮 + 自由输入 + 提交）；`clarify.ts` 的 `composeClarifiedRequest` 把回答拼成"原请求 + 补充说明"再规划（同一诉求的补充，不是新会话），空回答不允许提交、超长截断。
- 事件：`plan.ready` payload 增加 `candidates`/`truncated`，面板进度里能看到"规划拿到了多少候选"。

### 测试与结果

- Node：`pnpm test:coagent` —— **183 用例全绿**（18 文件）。W07 新增 26：
  - `plannerContext.test.ts` 6：关键词（中文 2-gram）、候选/模型库上限、视口近邻、无视口如实标注、文本含白名单与限制；
  - `planValidation.test.ts` 13：编造 id、跨区/只读目标、transform 无目标、add 与 target 互斥、对象数事实矛盾、阈值超场景尺度、preserve_count 语义、任务/目标超限、跨区依赖、依赖不存在；
  - `w07-planner.test.ts` 7：只读工具往返（且工具清单里没有 `edit.*`）、工具结果回灌、编造 id/超尺度阈值被拒、clarify → needs_clarification、unsupported → rolled_back 且原文保留、澄清拼装与截断。
- 回归：W05 的 8 个端到端用例（含修正轮、越权工具、错误证据、T17）与 W03/W04 浏览器套件在改动后重跑通过；`pnpm build` 通过（1211 modules）。

### 过程中发现并修正的规则错误

`preserve_count` 最初的实现是"与 add/remove 都冲突"，但项目夹具的"南区加石头 + preserve_count"语义是"别删已有对象、允许新增"。已改为只与 `remove` 冲突；`stay_in_region` 同样修正为对 add 任务允许无 target（约束的是落点）。这两条都是被 W05 的真实夹具测出来的，不是想象。

### 未覆盖 / 已知限制

- 真实模型的规划质量未验（需要你按 §8 的手动清单跑一次）；W07 只保证"无论模型输出什么，都过同一套校验"。
- 视口观察是"相机快照 + 最近邻对象"的近似，没有做投影裁剪（工作流层拿不到投影矩阵）；需要更准的"视口内对象"时要加渲染侧能力（W09 前评估）。
- 澄清只支持"选项/一段补充文字"，不支持多轮追问树；回答后若仍不明确，会再次返回 clarify（当前 UI 会再显示一次）。
- planner 的 4 轮工具预算与 8 任务上限是经验值，未在真实大场景上压测。
- 计划语义里"更稀疏"这类程度词仍靠模型给数值 + 场景尺度上限兜底，没有"用户确认阈值"的交互（可在 W08/W09 加）。

### 2026-10-22 追加修复（真实模型在规划阶段 `model_protocol_error`）

用户实测：分区（带图、无 tools）成功，但点开始后 `run.rolled_back — model_protocol_error`，事件里只有错误码，无法定位。

- **根因候选（已修）**：OpenAI 的函数名规范是 `^[a-zA-Z0-9_-]{1,64}$`，**不允许点号**；我们的工具名是 `scene.get_objects` 这类带点号的命名，一经在 planner/executor 请求里带上 `tools` 就可能被 400 拒绝（分区请求 `tools: []` 所以"看起来模型是好的"）。现在 `modelAdapter` 发请求时把工具名映射成下划线版（`scene_get_objects`），回包再映射回业务名，调用方无感。
- **诊断增强**：`mainGraph` 记录当前节点名，异常/终检失败时写进 `ToolError.details.stage`；`run.rolled_back` 事件从只记错误码改为 `{reason, message, stage}`；面板回滚行显示 `已回滚（code @stage）：message`。
- **错误翻译**：400/422 若报文提到 tools/function → "该模型/接口不支持函数调用（tools）"（`details.supportsTools=false`）；提到 context/length/token → "超出模型上下文长度"（`details.contextOverflow=true`）。
- 新增 4 个适配器/集成测试：线上工具名为下划线且回包映射、400-tools 翻译、400-context 翻译、`rolled_back` 事件带 stage 与 message。

**下一步若仍失败**：把新的 `#3 run.rolled_back` 行发来。若是 `supportsTools=false`，说明该模型不支持 function calling（多模态模型常见），需要换执行模型，或增加"分区/执行使用不同模型"的双模型配置（llmSettings 增 `agentModel`，`modelAdapter` 按 `purpose` 选模型）。

### 2026-10-22 追加修复（空任务计划 → 应改为澄清）

用户实测：请求"把建筑排布的乱一点"，模型两次返回 `{"kind":"tasks","tasks":[]}`，代码以 `invalid_plan@planner：计划连续 2 次不合格：plan.tasks 必须至少一个任务` 回滚。

- 这是 SPEC §W07 明确列出的场景（"无法量化的程度"应当澄清、不得编造阈值），但**提示词与修复轮都没有告诉模型"空任务时应返回 clarify"**，模型只能重复空计划。
- 修复：`SYSTEM_PLANNER` 增加"tasks 不能为空；无法拆成可执行任务（乱一点/好一点、缺对象）必须返回 clarify"；`repairText` 在检测到"至少一个任务"时附带 clarify 的 JSON 形状与要求；`invalid_plan` 的最终消息追加"改成可量化的要求"的示例。
- 新增 2 个测试：空任务 → 修复轮提示包含 clarify 且模型照做后返回 `clarify`；两次空任务 → 失败消息含可量化提示。

### 2026-10-22 追加修复（真实模型省略任务级 `schemaVersion` → `invalid_plan`）

用户实测：`invalid_plan@planner：计划连续 2 次不合格：tasks[0].task.schemaVersion 必须是 1`。

- `tasks[0].task.schemaVersion` 是 `validateUnitTask` 的通用路径前缀（`validatePlan` 会在前面拼 `tasks[i].`），不等于模型套了 `task`；真实原因是任务对象没写 `schemaVersion`（也可能同时省了 `dependsOn/constraints`）。
- 修复：`planner.normalizePlanJson` 在 schema 前做**安全归一化**：
  - 解包 `{plan:…}` 与每个 `{task:…}`；
  - 补 `schemaVersion=1`（仅当缺失）、空 `assumptions/dependsOn/constraints`；
  - 不猜 objective/target/region；显式写错的 `schemaVersion:3` 仍然拒绝。
- 提示词与修复轮都加入扁平任务示例，明确“不要再包一层 task/plan，字段要写全”。
- 新增 4 个测试：缺任务级版本/默认数组、`{task:…}` 解包、`{plan:…}` 解包、显式错误版本仍拒绝。

## 11. W08.1 判定服务、指标与终检（完成，2026-10-22）

### 交付内容

- `services/validation.ts`（新增）：W08.1 的核心，纯函数、无 core/react/three 依赖。
  - **metric 真正计算**：`region.object_count` 按最终地面锚点归属统计，`region.min_pair_distance_xz` 用 XZ 锚点两两距离；`gte/lte/eq` 带数值容差。
  - **约束真正检查**：`stay_in_region` 用保守世界 AABB 地面投影（10 cm 边界容差，§6.1/§6.2）；`preserve_objects`/`preserve_count` 查最终对象集合；`no_collision` 只认 `clear`，`unknown`/未执行一律 `uncertain`（§6.5/§6.6）。
  - **终检重算**：`validateFinalScene` 按最终场景逐任务重算 metric/constraint；visual 取该任务最后一轮 Verdict 的对应判据（后续编辑失效重判留 W08.5）。
  - **判定合并**：`applyComputedToVerdict` 在程序算 `fail/uncertain` 时把模型的 `pass` 降级，并写入 `repairSuggestions`；模型已判 `fail` 不会被程序 `pass` 抬回。
- `agents/judge.ts`：判定前先算 `TaskValidation`，把 metric/constraint 结果写进判定提示词；判定后再合并覆盖。add 任务通过 `createdObjectIds` 参与区域/计数检查。
- `workflow/regionGraph.ts`：
  - judge 传入 `createdObjectIds`；`no_collision` 的几何对象集合改为 `targetObjectIds + 本轮新增对象`（add 任务原先传空对象集）。
  - **修复空任务区子图**：计划只覆盖部分区域时，`dispatch` 仍会为每个区建子图，原先空任务区走 `prepare → taskAt(0)` 会内部报错；现在空区显式返回 `status='pass', tasks=[]`。这是 W05 遗留、W07 单区计划会踩到的问题。
- `workflow/mainGraph.ts`：`finalCheck` 改为 async。
  - 用**最终全场景**快照重算 metric/constraint，不再只查 `targetObjectIds`；
  - `preserve_objects` 取 `target ∪ preserve` 的对象集合，修掉"非 target 的保留对象被误判为已删除"；
  - `stay_in_region` 覆盖 `createdObjectIds`；
  - `no_collision` 在终检重新执行几何检查，不拿执行期旧结果充当终检。
- `tools/editTools.ts`：写前区域检查。`edit.add` 用 ref 的模型尺寸、`edit.transform` 用对象当前 catalog 尺寸，按世界 AABB 地面投影检查；越界返回 `out_of_scope`。缺少模型尺寸时只判中心点（`unknown` 不拦写入，但终检不会把它当通过）。
- 测试：
  - `tests/unit/validation.test.ts` 17 个：指标实际值/新增计数/只读排除、AABB 包容/旋转/缩放/pitch-roll 保守界/无尺寸、preserve 非 target、add 落点、preserve_count、unknown≠clear、判定降级、终检 T17；
  - `tests/unit/tools.test.ts` 新增 2 个：add 越界/区内、transform 占地越界；
  - `tests/integration/w08-validation.test.ts` 3 个：单区计划、metric 覆盖模型 pass、add 越界整轮回滚。

### 语义决策（已冻结，后续包按此执行）

- `region.object_count` 统计**最终场景中落在该区地面多边形内、且非 global_readonly 的对象**；不读冻结的 `region.objectIds`，否则 add/remove/移动后的计数会失真。
- `preserve_count` 语义是"不删除 run 开始时的本区对象"（新增允许），与 W05 夹具一致。
- 区域边界容差 10 cm；AABB 是保守上界，宁可拒绝靠边但实际合法的位置，也不放过越界（SPEC §6.2 允许的保守性）。
- 无 catalog 尺寸时 `checkRegionContainment` 返回 `unknown`：写前不拦（无法证明越界），终检按"硬约束未通过"处理（§6.6）。因此真实场景若大量资产缺尺寸，会在终检暴露而不是静默通过。
- finalCheck 的 visual 目前复用最后一轮 Verdict；"后续编辑使早期视觉判定失效后重判"是 W08.5，不在本包假装做了。

### 测试与结果

- `pnpm test:coagent`：**212 个用例全绿**（20 文件，约 4.5 s）。W08.1 新增 22 个（validation 17 + tools 2 + w08 集成 3）。
- `pnpm exec tsc -b`：通过。
- `pnpm build`：通过（1215 modules，2.44 MB / gzip 686 kB；仅既有 chunk >500 kB 警告）。
- 回归：W05 的 8 个端到端用例、W07 的 12 个规划器用例、W03/W04 的 Node 测试全部通过。浏览器 W03/W04 套件本轮未重跑（沿用 23:57 的报告；最后修改是 Node 侧 validation/judge/finalCheck，理论上不影响渲染/宿主互斥，但 W08.5 前应重跑一次）。

### 未覆盖 / 已知限制

- **Judge 还看不到图**：W08.1 只让 metric/constraint 成为程序事实，`visual` 仍依赖文字判定；before/after 图片入模型已在 W08.2 补上（见 §12）。
- **几何仍 unknown**：`rendering/geometry.ts` 未实现，`CoAgentBridge.geometry` 继续返回 unknown；因此真实运行中带 `no_collision` 的任务会被判 `uncertain` → 不通过。这是正确的保守行为，但要等 W08.3 才能真正完成"无碰撞"。
- **修正轮写集未累计**：`regionGraph` 的 `state.writes` 每轮覆盖，上一轮 add 的对象可能不在下一轮 `createdObjectIds` 里；终检仍能通过场景快照查到它，但 `TaskResult.createdObjectIds` 可能漏记。属 W08.4。
- **重叠分区 double count**：`region.object_count` 按多边形归属统计，分区重叠时同一对象可能被两个区各计一次；首版分区要求唯一主归属，派生归属重算留 W08.3/partition 侧。
- **`min_pair_distance_xz` 用锚点距离**，不是占地间隙；若后续需要"建筑外墙间距"要改成 AABB/OBB 间距离。
- **visual 终检未重判**：后任务改变前任务对象后，visual 仍看最后一轮 Verdict；W08.5 要按受影响对象重新拍/重判。
- 写前检查只覆盖 `edit.add`/`edit.transform`；`remove` 不涉及落点。`geometry.check` 仍走 RenderPort，W08.3 替换实现。

## 12. W08.2 Judge 看图与证据配对（完成，2026-10-22）

### 交付内容

- `services/imageData.ts`（新增）：Blob → dataURL 的单一实现（浏览器 FileReader；Node 用 `arrayBuffer + btoa`）。`services/partition.ts` 保留 re-export，旧导入不破。
- `runtime/evidenceStore.ts`：
  - `EvidenceImage` 保存原始 `Blob`（不复制像素，btyes 仍按原大小计）；
  - 新增 `EvidenceStore.dataUrlFor(imageId)`，按需转换；不存在返回 null。
- `contracts.ts`：`WorkflowContext` 新增 `getImageDataUrl(imageId): Promise<string | null>`。这是本包唯一的公共契约变更；`runController` 从 deps 注入、`createRuntime` 接 evidenceStore、`fakeContext` 用捕获的 Blob 实现。
- `services/validation.ts`：新增 `observationPairIssues`（§6.3）：
  - before/after 必须同为当前 run、同任务、同区域、同分区版本；
  - 完整 `CameraSnapshot` 与输出宽高必须一致；
  - `after.sceneRevision` 不得早于 before；
  - 相位必须分别是 `task_before` / `after`。
- `agents/judge.ts`：
  - 配对不成立时直接 fail，不调用模型；
  - 把 before/after 的 RGB 证据图作为 user 消息的 `images` 发给模型；
  - **visual 判据缺任一张图 → 直接 fail**（不调用模型）；
  - 判定引用的每条证据都校验 `runId`、`taskId`（若有）、`partitionVersion`；
  - 提示词明确“图片按 before → after 顺序，必须对比；没图不能判 visual pass”。
- `agents/modelLoop.ts` + `agents/executor.ts`：`camera.capture` 的 toolResult 可携带真实图片（`imagesForToolResult`），executor 每任务最多附 2 张；模型下一轮能看到自己刚拍的图，而不是只看到 observation id。
- 测试：
  - `tests/unit/w08Images.test.ts` 5 个：判定请求带 2 张 PNG dataURL、缺图 visual fail 且不调用模型、跨 run 证据被拒、before/after 相位/相机不同被拒、camera.capture toolResult 带图；
  - `tests/unit/evidence.test.ts` 新增 1 个：`dataUrlFor` 返回 PNG dataURL、未知 imageId 返回 null；
  - `tests/unit/modelAdapter.test.ts` 新增 1 个：toolResult 图片在 OpenAI wire 上变成 tool 消息后的 user 图文消息（真实 SSE 服务断言）。

### 语义决策

- 图片只在**请求瞬间**转 dataURL，不进入图状态，也不复制到 Observation（§2.3/§4.1）。
- 视觉比较必须使用同一完整相机快照和输出尺寸；只给 observationId 不算可复拍证据。
- 没有 before/after 图时，visual 判据不能 `pass`（返回 fail 而不是“相信文字”）；metric/constraint 仍按 W08.1 的程序计算。
- 执行期证据只能来自当前 run/task/partition；跨任务/跨轮证据即使 id 存在也拒绝。
- executor 的 toolResult 附图每任务最多 2 张，避免多轮捕获把请求撑爆。

### 测试与结果

- `pnpm test:coagent`：**219 个用例全绿**（21 文件，约 3.1 s）。W08.2 新增 7 个（w08Images 5 + evidence 1 + modelAdapter toolResult 图片 1）。
- `pnpm exec tsc -b`：通过。
- `pnpm build`：通过（1216 modules，2.45 MB / gzip 687 kB；仅既有 chunk >500 kB 警告）。
- 回归：W05 的 8 个端到端用例、W07 的 12 个规划器用例、W08.1 的 20 个 validation/tools/w08 用例全部通过。

### 未覆盖 / 已知限制

- 只附 **RGB before/after 两张图**，没有附 marked 图/多视角；对象 label→id 映射仍只在文字里。若真实模型对“哪个是目标对象”判断不稳，W08.5 可加 marked 图或像素框文字。
- 图片不缩放/不压缩，固定 320×240；更大分辨率或多图会增加 token。W09 导出/真实模型验收时再评估。
- 相机配对用完整快照 JSON 相等判断；当前 capture 用同一 `CameraSnapshot`，稳定；若未来相机适配器做归一化，需要同步调整比较口径。
- 视觉判定质量仍未对真实厂商验收（T14）；W08.2 只保证“图真的到了请求里，且没有图不能 pass”。
- `no_collision` 在本包仍是 unknown；W08.3 已补真实几何（见 §13）。

## 13. W08.3 几何检测（完成，2026-10-22）

### 交付内容

- `rendering/geometry.ts`（新增）：纯 Three 数学、不依赖 WebGL。
  - 世界 AABB 宽阶段：分离即 clear，不进入三角形；
  - 三角形窄阶段：SAT（3 个面法向 + 9 个边叉积轴），共面时退化为 2D 重叠；
  - 完全包含：AABB 包含 + 闭合网格顶点在对方内部（三方向射线奇偶投票）；不闭合/无法判定 → unknown；
  - 接触：三角形最近距离（顶点-面 + 边-边），≤ `contactToleranceM` 判接触；`allowGroundContact` 且两者 minY≈0 时按地面支撑放行；
  - unknown 兜底：对象缺失/不可见、蒙皮/实例化网格、缺少 position、退化到无三角形、超预算、开口网格的包含检测；
  - 预算：单对象 20k 三角形、500k 三角形对测试、最多 64 个对象；超限返回 unknown，不卡页面；
  - 缓存：按对象 + matrixWorld + geometry uuid/position.version 缓存世界三角形；不修改共享 geometry。
- `rendering/CoAgentBridge.tsx`：`geometry()` 改为调用 `checkSceneGeometry`，先 `scene.updateMatrixWorld(true)`；取消在完成前后都检查。
- `runtime/createRuntime.ts`：新增 `debugGeometry()`（DEV/E2E 用，桥未挂载明确报 `bridge_unavailable`）。
- `dev/devHarness.ts`：暴露 `geometry()` 探针。
- `tools/geometryTools.ts` / `registry`：描述更新为 W08.3 实现；unknown 仍是证据不足，不当 clear。
- `tests/browser/w08-geometry.mjs` + `package.json` 脚本 `test:coagent-browser:w08`。

### 算法语义

- 只有拿到 `clear` 才算无碰撞；`unknown` 在 judge/finalCheck 里仍是 `uncertain`（§6.5/§6.6）。
- 接触距离 ≤ 容差按 `collision` 处理（note 写明距离），除非 `allowGroundContact` 且两者都落在地面附近，才按地面支撑放行。
- 完全包含只在双方网格闭合时给出结论；开口网格返回 unknown，不宣称"在内部/不在内部"。
- 只跳过 `userData.editorHelper` 子树（选中描边壳），不会把 helper 当成资产；资产根仍按 `userData.assetId` 找。
- 三角形/对象超预算返回 unknown，这是 MVP 的保守选择；真正大场景需要 BVH 或分块（W09 前评估，未在本包引入新依赖）。

### 测试与结果

- Node：`pnpm test:coagent` —— **230 个用例全绿**（22 文件，约 3.3 s）。W08.3 新增 11 个 `tests/unit/geometry.test.ts`：AABB 分离、重叠、旋转/缩放、完全包含、开口网格 unknown、接触、地面接触放行、缺失对象、实例化网格、三角形预算、无对象对。
- 浏览器：`node modules/coagent/tests/browser/w08-geometry.mjs --url=http://127.0.0.1:5173/` —— **9/9 通过**（scene-02 真实资产 + 真实 bridge）：
  - shelf-01 vs shelf-04 → clear/aabb（真实 scale 2.2/1.9/0.6）；
  - 两桶摆到重叠 → collision/mesh（三角形相交）；
  - 两桶间距 5mm + allowGroundContact → clear（地面支撑）；
  - 同位置不允许地面 → collision（接触距离 0.0050m ≤ 0.01m）；
  - 不存在对象 → unknown；
  - 几何检测不影响渲染桥/上下文，无页面级 JS 错误。
- 回归：W03 浏览器 **33/33**、W04 浏览器 **35/35** 通过。
- `pnpm exec tsc -b`：通过。
- `pnpm build`：通过（1217 modules，2.46 MB / gzip 692 kB；仅既有 chunk >500 kB 警告）。

### 未覆盖 / 已知限制

- 接触是"三角形最近距离 ≤ 容差"；没有接触法向/材质分类，地面支撑用"两者 minY≈0"的粗启发式，不识别真实地形；地形接触不可靠时仍可能误判为 collision，而不是 unknown。
- 完全包含只对闭合网格给出结论；真实 GLB 常见开口/非流形网格，包含分支可能返回 unknown。
- 没有 BVH/空间索引；单对象 20k 三角形、单次 500k 三角形对是保守上限。超过就 unknown，大场景/高模可能频繁 unknown。
- 蒙皮网格返回 unknown；`AssetInstance` 加载时会把蒙皮烘焙成普通 Mesh，因此正常渲染资产通常能检测，但其它来源的 SkinnedMesh 仍不支持。
- 实例化网格返回 unknown；场景当前没有 InstancedMesh 资产。
- 只验证了 scene-02（10 个占位体）；alpine 523 资产/GLB 高模未做浏览器几何压测。
- 几何缓存按 matrixWorld/geometry version；如果外部直接改 BufferGeometry 顶点但不递增 position.version，缓存可能陈旧。
- `geometry.check` 工具默认容差 0.02m；`no_collision` 任务在只有一个可检对象（没有静态对象）时仍是 unknown。

## 14. W08.4 Executor/修正/载入同步（完成，2026-10-22）

### 交付内容

- `workflow/regionGraph.ts`：
  - 修正轮**写集累计**：`state.writes.created/modified` 与 `executionEvidence` 取并集，不再被第二轮覆盖；
  - 判定前后的捕获对象集合加入 `state.writes.created`，add 任务的新对象能被 `RenderPort.ready` 等待、被 judge 看到；
  - `TaskResult` 新增 `baselineObservationId` 与 `judgedFingerprints`（W08.5 重判依据）；
  - 失败兜底的 `TaskResult` 也保留执行期证据。
- `contracts.ts`：
  - `CaptureRequest.expectedTransforms?`：调用方冻结的资产 transform；
  - `RenderPort.ready(..., expectedTransforms?)`：渲染层可据此确认“文档 transform 已进入矩阵”。
- `rendering/CoAgentBridge.tsx`：
  - `waitAll` 在对象进入渲染层后，继续比对 `matrixWorld` 分解出的 position/scale/quaternion 与期望 transform；
  - 位置/缩放容差 1e-3，旋转用四元数点积；超时错误 details 同时给 `missing` 与 `unsynced`；
  - 每次轮询先 `scene.updateMatrixWorld(true)`，不靠固定毫秒数。
- `runtime/runController.ts` / `createRuntime.ts`：`context.capture` 与 `debugCapture` 从编辑器快照填 `expectedTransforms` 并传给观测服务。
- `workflow/mainGraph.ts`：主图/区域子图显式 `recursionLimit: 64`（8 任务 × 修正轮不撞默认 25）。

### 测试与结果

- 新增 `tests/integration/w08-final.test.ts` 3 个：
  - 第一轮 add 失败 → 修正轮不再 add，`TaskResult.createdObjectIds` 仍保留第一轮新增；最终 count=3 通过；
  - remove 任务删除 rock-1 后，终检按最终场景重算 count=1 并通过；
  - 后任务改过前任务目标 → 终检视觉重判失败，整轮 rolled_back（judge 恰好 3 次：n1 首次 + n1 重判 + n2 首次）。
- 全量：**237 个用例全绿**（23 文件，约 3.3 s；含 W07 形状归一化的 4 个新增）。
- 浏览器：W03 **33/33**、W04 **35/35**、W08 **9/9** 全通过（含 W04 的“移动后立即捕获”，现在会经过 transform 同步等待）。
- `pnpm exec tsc -b`、`pnpm build` 通过（1217 modules，2.46 MB / gzip 691 kB）。

### 语义与已知限制

- `expectedTransforms` 是“等待渲染层追上文档”的判据，不是写入校验；写权限/指纹仍由 writeFacade 负责。
- 动画/骨骼资产不在首版支持范围：期望 transform 只比对根对象矩阵，动画内部骨骼变化不参与。
- 没有单独的“add 后立即捕获”浏览器用例；W05 的 add 走假渲染，W04 的“移动后立即捕获”覆盖了矩阵同步路径，真实 add 的 ready 语义由 `RenderPort.ready` 保证。
- `remove` 的宿主撤销/重做沿用 W03 的真实 core 事务测试；本包只验证 agent 侧 remove + 终检。
- `recursionLimit` 在 LangGraph 1.5.1 的 compiled 类型里未声明，使用显式类型断言传入（运行期支持）。

## 15. W08.5 终检视觉重判（完成，2026-10-22）

### 交付内容

- `TaskResult` 记录 `baselineObservationId` 与 `judgedFingerprints`（任务判定时 target + created 对象的指纹）。
- `workflow/mainGraph.ts` finalCheck：
  - 用最终快照比对相关对象指纹；只有“后续编辑确实改过该任务相关对象”的任务才重判，避免无谓模型调用；
  - 重判时用同一 `regionCamera` 重新捕获 `after`（同视角、同尺寸、同分区版本），从 `baselineObservationId` 取原 before；
  - 调 `judgeTask`，把最终 Verdict 追加到 `TaskResult.verdicts`、最终 after 加进证据；
  - 重判失败 → 任务 status=fail、整轮不通过；重判通过 → 后续 `validateFinalScene` 仍会重算 metric/constraint。
- 终检检查项新增 `visual-refresh:<taskId>`，记录最终重判是否通过及前后证据。

### 测试与结果

- `w08-final.test.ts` 的第三个用例：n1/n2 都改 tree-1，n1 首次 pass、n2 pass，终检 n1 重判 fail → rolled_back；judge 调用数 3（n2 未被无谓重判）。
- 全量 237 用例、tsc、build 均通过；浏览器回归同上。

### 语义与已知限制

- 只对 **targetObjectIds + createdObjectIds** 的指纹变化触发重判；如果后任务只改变区域里的其它对象（例如删掉背景物），visual 上下文变化不会被检测。需要更严格时可按 region 级指纹重判，但会增加模型调用。
- 没有 target/created 的纯视觉任务（例如“整个区域更整齐”）不会触发重判；W09 前可补 region 级指纹。
- 重判会增加最多“每任务一次”的模型调用；真实成本需在 T14 实测。
- 仍未附 marked 图/多视角；视觉重判仍只看 RGB before/final-after。
- finalCheck 重判捕获会新增证据；证据容量上限在 W04 已按 run 管理，超限会明确 `budget_exceeded` 而不是静默丢弃。

## 16. 下一包入口（W09 导出与综合验收）

- W08 的判定/几何/视觉重判接口已稳定：`validateTaskAgainstScene`、`applyComputedToVerdict`、`validateFinalScene`、`observationPairIssues`、`checkSceneGeometry`、`judgeTask`。
- W09 导出应复用 `EvidenceStore` 的 Blob/dataURL 与 recorder 事件，不要重新截图；`TaskResult.verdicts/evidenceIds` 已含终检重判。
- **W06 T14 已关闭**（2026-10-22，deepseek-flash，见 §8 末）：分区与整轮都真机跑通；真实规划质量随之验收（1 个任务、35.4 s、终检 10 项通过）。
- **W09 开工前要先补事件字段**（T14 实测暴露）：`verdict.ready` 只记 `{status, credible}`，**judge 的 after 证据 id、逐条 criteria 结论、repairSuggestions 都没进 recorder** —— 导出要复用 after 图 id 就必须先补字段；`plan.ready` 也应带上计划正文（任务 id/objective/目标对象），否则复盘必须重跑。
- **分区质量待处理**：多边形每次都重叠（程序只报 issue 不修正）、命名不稳定、偶发 0 对象空区。至少要做到"重叠可自动消解"或"重叠时降级为对象归属表"，否则 `stay_in_region` 的约束力不可信。
- 浏览器回归命令：`pnpm dev -- --host 127.0.0.1 --port 5173 --strictPort`，然后 `test:coagent-browser`、`test:coagent-browser:w04`、`test:coagent-browser:w08`；真实模型场景用 `node modules/coagent/tests/browser/w06-t14.mjs`（可见 Chrome + 手填 Key）。
  - **实测坑（2026-10-22）**：这三个 w03/w04/w08 脚本**必须显式传 `--url=http://localhost:5173/`**（默认连 `127.0.0.1:5199`，而 dev server 只绑 `::1`，不传就报 `timeout waiting: dev harness`）；T14 脚本已改用独立端口 **9334**（默认 9333 会与 w03/w04/w08 抢端口，导致它们连到 T14 的浏览器上而误判失败）。
- 几何压测（alpine 523 资产/GLB 高模）放到 W09 前，统计 unknown/耗时，再决定是否引入 BVH；当前预算 20k 三角形/对象、500k 三角形对。

## 17. W10-P0 碰撞配对与分区归属（完成，2026-10-27）

来源：[revision-2026-10-27](revision-2026-10-27/README.md) 的 P0 阶段。本包只做"让现有检测不再误伤"和"分区不再跨场景串用"，**不改变验收语义**（保留/回滚策略属 P3）。

### 交付内容

| 项 | 改动 |
| --- | --- |
| 配对范围 | `rendering/geometry.ts` 入口：`targets = request.objectIds`、`statics = staticObjectIds − targets`；只测 `targets×targets`（去重）+ `targets×statics`，**不测 statics×statics** |
| 覆盖报告 | `contracts.ts` 新增 `GeometryCoverage { checkedObjectIds, skipped[], truncated, pairCount }`；`GeometryResult.coverage?` 为可选字段 |
| 上限 | `GeometryOptions.maxObjectsPerCheck`（默认 64，targets/statics **单侧**各计）、`maxPairsPerCheck`（默认 4096）；截断或三角预算耗尽时 `status` 强制不为 `clear` |
| 场景归属 | `SceneChange.sceneId?`；`createRuntime` 订阅编辑器变更，场景级变更或 sceneId 变化即作废 `partitionOverride` / `partitionReport` 并广播；`dispose` 退订 |
| fake 对齐 | `FakeRender.geometry` 与 `FakeEditor.notify` 采用同一口径（配对范围、sceneId），避免 fake 与真实实现分叉 |

### 测试与结果

```
pnpm test:coagent   → 28 文件 / 308 用例全绿（基线 298，新增 10）
pnpm exec tsc -b    → 通过
pnpm build          → 通过
```

新增用例：`tests/unit/geometry.test.ts` 7 条（静态×静态不参与、目标×静态仍 collision、targets×targets 仍检测、同 id 不自配对、超对象上限、超配对上限、未截断时 coverage 精确）；`tests/integration/runtimeLifecycle.test.ts` 3 条（切场景作废分区、对象级变更不误清、无分区时不产生多余通知）。

### 语义变更

- 静态物之间的旧碰撞**不再进入** `geometry.check` 的结果，原场景的既有穿插不会让新任务失败。
- 覆盖不足从"静默 `unknown` + 空 pairs"变为"`unknown` + 明确列出被排除对象"；`clear` 只在**没有截断**时出现。
- 切场景后 `partition()` 返回 `null`（此前会返回上一场景的分区）。

### 未覆盖 / 已知限制

- **没有**按包围盒筛选附近环境对象：`statics` 仍由调用方给出全量，超大场景可能撞 `maxPairsPerCheck` 而返回覆盖不足。按邻近度筛选属后续增强。
- `liveSceneId` 只能从变更事件学到（`SceneSnapshot` 不含 sceneId），首次 `setPartition` 时 `partitionSceneId` 可能为 null，靠"场景级变更"信号兜底。
- **未跑浏览器实跑**（W03/W04/W08 套件需要 dev server 与真实 Chrome，本轮只跑单测与构建）。几何改动的真实渲染行为尚未在浏览器中复验。
- 未改动 `mainGraph` / `regionGraph` 的几何调用点，`writeIds` 仍为 `targetObjectIds ∪ writes.created`（不含 `modified`），该缺口留给 P1。

## 18. W10-P1 实时状态与增量修复（完成，2026-10-27）

### 交付内容

- **唯一写集**：新建 `runtime/runState.ts`。修订前"本轮新增对象"散在 4 处（`RegionState.writes`、`TaskResult.createdObjectIds`、`registry.createdByRegion`、`runController.writable`），各自更新、口径不同 —— 这是"修复轮又加两栋"的根因。现在由 runState 按对象粒度记账。
- **写入名额**：`UnitTask.creationTarget` + `checkWrite` 在**场景队列内部**执行。名额口径是"本任务仍存活的新增数"，不是调用次数、不是区域总量。超限返回 `task_creation_limit`，附 current/max/存活 ID 与"调整或先删再建"的建议。
- **修复上下文**：`ExecutorInput.executionState` 每轮用新快照生成，含阶段/尝试次数/场景版本/数量目标/存活新增/剩余名额/对象当前 transform+fingerprint/已删除摘要/允许对象/基线证据/最新证据/待解决问题。**指纹是实时的**——旧实现复用 `prepare` 时冻结的基线指纹，修复轮必然 `stale_object`。
- **区域查询实时化**：`scene.list_region` 走 `runState.resolveRegion`，`objectCount === objectIds.length`，带 `sceneRevision` 与 `createdInRun`。不再出现"新建了但查询还是 32 个"。
- **数量判据**：程序生成 `task-created-count:<taskId>`，模型不能推翻。
- **任务隔离**：`advance` 显式清空 `writes`/`executionEvidence`（reducer 是替换语义，不返回值就等于沿用上一任务）；`finishFail` 保留本区已完成任务、未执行任务标 `skipped`、补 `judgedFingerprints`。

### 测试与结果

```
pnpm test:coagent   → 29 文件 / 325 用例全绿
pnpm exec tsc -b    → 通过
pnpm build          → 通过
```

### 语义变更

- 新增对象必须带 `creationTarget`（新计划强制），旧计划字段可选仍可解析。
- 超额新增从"静默多建"变成"稳定错误码 + 无场景副作用"。
- 同区相邻任务不再共享写集。

### 未覆盖 / 已知限制

- `registry.createdByRegion` 仍存在（`writableIn` 用它做 transform/remove 的存在性判断），尚未并入 runState。二者当前不会冲突（runState 只做名额，registry 只做作用域），但仍是重复状态。
- `validateFinalScene` 仍读 `TaskResult.createdObjectIds`（累计语义），终检的"数量"判断用的是最后场景重算的 metric，未接 `liveCreatedObjectIds`。
- 修复轮的 `latestObservationId` 取"最后一次执行期证据或基线"，尚未做"同视角最新复拍"。

## 19. W10-P3 验收保留（核心完成，2026-10-27）

### 交付内容

- `RunOutcome` 新增 `retained_with_issues`（与 completed 同报告字段 + `issues: RunIssue[]`）；`CoAgentPhase` 新增 `retained`（**不在** `ACTIVE_PHASES`，宿主锁按预期释放）。
- `mainGraph` 终检未通过不再编码成 `failureCode: 'write_failed'`，改为 `finalCheckProblems`；只有**基础设施错误**（invalid_plan / model_protocol_error / rollback_failed）仍走 `rolled_back`。
- `runController` 把 `completed` 与 `retained_with_issues` 统一按"提交 + 保存"处理，`run.committed` 事件带 `validationStatus`。
- UI 全链路同步：`PHASE_STEP`、`PHASE_TEXT`、`useCoAgentModule` 结果投影、面板结果卡片（"⚠ 改动已保留，存在未通过项（N 项）"）、`uiStore.lastResult.issueCount/issues`、进度百分比与 current 文案。

### 语义变更（用户已确认的方向）

正常执行后判据未通过 → **修改提交并保留**，任务/区域状态如实为 fail/uncertain。旧行为是整轮 `rolled_back`、用户看不到任何成果。

### 未覆盖 / 已知限制

- **撤销只支持栈顶**：core 的历史是数组当栈，`undoTo` 的语义是"撤销该步之后所有步"，没有选择性撤销。本轮之后用户再编辑过，一键撤销会被明确拒绝并告知"其后还有 N 次编辑"。
- `devHarness.outcomeKind` 仍由相位推导，没有 `retained_with_issues` 分支（只影响浏览器脚本）。
- R01–R10 完整测试矩阵未逐条补齐；当前由 2 条真实 core 断言覆盖核心路径。

### 浏览器复验（2026-10-27）

`w03-run.mjs` 33/33、`w08-geometry.mjs` 9/9、`w04-run.mjs` 35/35，合计 77/77（真实 Chrome + 真实场景）。证据见 [revision-2026-10-27/09 §20](../revision-2026-10-27/09-实施任务分解.md)。

## 20. W10-P4 分区长期存储（服务与 IO 完成，2026-10-27）

### 交付内容

- **文件契约** `services/partitionPersistence.ts`：`scenes/<sceneId>/coagent/partition.json`。保存区域定义（世界米制 XZ 多边形、稳定区域 ID）、归属与来源（`auto`/`agent`）、只读归属、unresolved。**不保存** objectCount / token / runState / 对话 / 证据图 / 未提交事务。
- **版本分离**：`schemaVersion`（格式，未知版本直接拒绝、不自动迁移）与 `partitionVersion`（内容变化）分开。
- **内容指纹**：按 ID 排序的规范化摘要（ref/transform/visible，scale 缺省归一 `[1,1,1]`），带算法版本。明确不用 `sceneRevision`（内存计数器）与 `meta.version`（落盘副本才递增）。
- **恢复核对**：对象已删除 → 丢弃并记录；同 ID 换资产 → unresolved 且并入 `globalReadonlyObjectIds`（可见不可写）；文件未记录的新对象 → `unassigned`，**不自动归属**；指纹不一致 → 明确标记 `fingerprintMatch: false`，不假装 exact。
- **IO**：读走静态资源（404 = 正常"无文件"）；写走 `POST /api/scene/<id>/coagent`（vite middleware，dev/preview 都注册），带 sceneId 白名单、路径穿越双保险、5MB 上限、`mkdirSync` 建目录、临时文件改名原子替换；服务端不可写时降级为下载并明确 `mode: 'download'`。
- **生命周期**：`restorePartition` / `savePartition` / `enablePartitionPersistence`；切场景作废分区后自动恢复；恢复前捕获 sceneId、await 之后再比对，过期响应丢弃。`run.committed` 后自动保存分区。

### 测试与结果

```
pnpm test:coagent   → 30 文件 / 350 用例全绿
pnpm exec tsc -b    → 通过
pnpm build          → 通过
```

### 未覆盖 / 已知限制

- 人工覆盖入口未做（`manual` 来源取值保留但不会产生）。
- 未做多窗口冲突检测。
- 写接口已在真实 dev server 上验证（POST 写入 → GET 回读，内容类型正确）；**纯静态托管下的降级只由单测覆盖**（stub fetch → download 分支）。
- **保存链已对齐（同日追加）**：`runController` 在 `save()` 前取快照，提交后经 `afterCommit` 交给 runtime；新增纯函数 `planPartitionSave` 决定是否落盘（5 种跳过理由各有测试），分区文件用**同一份快照**构造指纹；场景成功而分区失败时显示"场景已保存，但分区未保存"。跨文件原子性仍不成立（两次独立 IO），只做到如实显示。
- **自动保存会写真实文件**：`run.committed` 后自动保存分区（设计行为），实测在浏览器跑一轮就落了一个 1.7KB 的 `scenes/<id>/coagent/partition.json`——同时也证明写盘链路端到端可用。**已修**：分区现在带来源标记（`generated/restored/manual/injected`），`debugSetPartition` 注入的分区**不再自动落盘**（否则每个浏览器脚本都会往真实场景目录写文件）。验证：修后重跑 w03 33/33，`git status` 在 `scenes/` 下**零残留**。

## 21. W10-P2 观察与定位（链路完成，2026-10-27）

### 交付内容

- **有界最新图片窗口**：`CoAgentConfig.maxImagesPerRequest`（默认 4）+ `modelLoop.boundImages`。每轮请求重建窗口、**最新优先**；旧图只去图不去文字，保持 tool call/result 配对。旧实现只限制"产生"（executor 前 2 张），图一旦进了 transcript 就每轮重发——模型永远看最早两张，后拍的新图反而进不去。
- **截图点选** `scene.pick`：`rendering/pick.ts` 用 `cameraFromSnapshot` 现造观测相机（**不动主视口**），射线排序跳过编辑辅助件与不可见对象，沿父链找 `assetId`。工具层校验 observationId 存在、u/v ∈ [0,1]、`sceneRevision` 未过期（`stale_observation` 并提示复拍）。命中返回 id/命中点/ref/**当前指纹**/`readonly`；空命中是正常结果，不吸附。`RenderPort.pick?` 为可选能力，未实现时明确 `bridge_unavailable`，绝不伪装空命中。
- **区域相机数学** `services/regionCamera.ts`：`orbitOffset` 实现文档公式（azimuth 0 = +Z，正角转向 +X）；`orbitCamera` 支持方位增量、绝对俯仰、缩放、按画面跨度平移；正交基相机按等效视高换算距离；俯仰/距离夹取并在 `warnings` 报实际值；非法参数不产生 NaN。
- **一次调用完成观察**：`camera.inspect`（聚焦+截图）与 `camera.adjust`（相对调整+截图），640×480，返回相机实际状态与 warnings；before/after 仍用默认 320×240 保证可比。

### 测试与结果

```
pnpm test:coagent   → 33 文件 / 386 用例全绿（新增 33：pick 11 + pickTool 6 + regionCamera 16）
pnpm exec tsc -b    → 通过
pnpm build          → 通过
浏览器回归            → w03 33/33、w04 35/35、w08 9/9（合计 77/77）
```

### 浏览器验证（W10-P2 新增套件）

`node modules/coagent/tests/browser/w10-observe.mjs --url=http://localhost:5173/` → **14/14**（真实 Chrome + scene-02 + 真实 Bridge）。断言：

- 正交俯视与透视两种视角下，**标注框中心点选都命回同一个对象**（证明 pick 用的是观测相机，与标注同一次渲染）；
- 从全部对象的标注框反推一个真正空白的像素，点它 → `hit: null`（不吸附）；
- 移动对象后，**旧图的旧坐标不再命中它**、新图新坐标命中（每次按当前场景拾取，不是缓存）；
- 拾取前后 `renderDiagnostics().mainCamera` 完全一致（不动用户主视口）；
- 距离减半后目标在画面上的面积比 **4.71×**（拉近确实让细节变大）。

脚本端口用 9337（w03/w04/w08 用 9333、T14 用 9334、w08 用 9336），跑完自动还原 `scene-02/scene.json`。

### 未覆盖 / 已知限制

- **`camera.inspect`/`camera.adjust` 没有工具级浏览器验证**：相机数学、工作相机连续性、标注优先级都有单测；浏览器套件覆盖"拉近变大"与"观测相机拾取一致"，但两个工具本身尚未在真实 workflow 里跑过。
- `scene.pick` 未校验 run 归属（`WorkflowContext` 没有 runId），只靠 sceneRevision 过期检查兜底。
- judge 仍只送 before/after，没有"最多 2 张相关局部图"。
- 工作相机状态不跨 run 保留；`camera.restore(viewId)` 未实现。

### 追加（同日）：工作相机状态与标注优先级

- **每区一台工作相机**：`contracts.RegionViewState/RegionViews` + `runtime/regionViews.ts`，经 `WorkflowContext.regionViews` 注入（runController 每轮创建、fakeContext 同构）。`camera.adjust` 的基相机优先序：显式 camera > fromObservationId > **本区上次工作视角** > 区域总览；聚焦对象被删除时 `clearFocus` 并回报"已退回总览"。**这是"绕到侧面看"能连续完成的前提**——此前每次调整都从顶视重来。
- **标注优先级**：`services/annotation.ts::prioritizeAnnotationIds`（created → modified → targets → environment → readonly）。`regionGraph` 的 task_before/after 与 `mainGraph` 终检重判取证都改用它。旧实现把本轮新增拼在末尾再截断，区里对象一多新对象就进不了 12 个标注名额。
- **测试**：395 用例全绿（新增 4 条工作相机 + 5 条标注优先级）；w03 33/33、w10 14/14 浏览器回归通过。

### 追加（同日第二轮）：取景包含性

`tests/unit/cameraFraming.test.ts` 用视锥包含性验证 `focusCamera` 是否把目标**完整框进画面**。**发现真实缺陷**：`camera.inspect` 的 `tight` 倍数 1.5 会让目标出画——tree-1 的角点归一化坐标算到 **1.06**（出画约 6%），这正是"判定看不清新增房屋"的成因之一。改成 2.1（tight）/ 2.9（context）后两种取景都完整包含，`tight` 仍比 `context` 近；单测锁住"不出画"且"不缩到看不见"。

> 数学依据：fov 45° 时要完整包含半径 r 的物体，距离需 ≥ r/tan(22.5°) ≈ 2.41r；原公式 `r·multiplier + 2` 在 r 较小时严重不足。

## 22. W10-P5 端到端复现（fake 驱动，2026-10-27）

`tests/integration/w11-endtoend.test.ts` 把样本日志 2026-10-26 15:46:29 的失败链条编码成回归：

1. 首轮加 2 栋（`creationTarget: 2/2`），名额占满；
2. 判定连续两轮 fail；
3. 修复轮尝试第 3 次 add → **`task_creation_limit`，场景无副作用**（原链条这里是"又加两栋"）；
4. 修复上下文明确含"已创建且仍存活 2 个 / 还可新增 0 个"；
5. 终态 `retained_with_issues`：改动保留、判据如实 fail、issues 列出失败任务（原链条是整轮回滚）。

**变异验证（证明测试有效）**：把 `runState.checkWrite` 的名额分支短路后重跑 → 场景对象数 8（应为 7），用例失败。恢复后 **397 用例全绿**、`tsc`/`build` 通过。

第二条用例覆盖"同区两个任务各算各的名额"，任务结果按 taskId 分开。

### 未覆盖

- **真实模型端到端未做**：需要 baseURL / API Key / 模型名。fake 通过只证明流程与不变量，**不证明布局质量**——按 [08-测试与交付清单](../revision-2026-10-27/08-测试与交付清单.md) §6 的要求，这两类证据必须分开报告。
- 复现只覆盖"修复轮重复新增"这一条主链，未覆盖跨区依赖（东侧任务未执行）的跳过语义在真实 plan 下的表现。
