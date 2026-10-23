# CoAgent 开发实施规格

日期：2026-10-20  
状态：待开发。本文的类型、文件和函数是目标设计，不代表仓库已有实现。  
适用对象：架构负责人、承担单个工作包的开发 SubAgent、集成与测试人员。

## 0. 阅读方法与执行纪律

本文是开发主入口。TECHNICAL-PLAN.md 保留选型与代码考察背景；README.md 保留产品语义；workflow.png 保留业务流程示意。发生冲突时，本文件中的实施约束优先，但不得自行改变用户确认的业务需求。

每个开发 SubAgent 必须：

1. 阅读第 1～5 节、自己负责的模块章节、对应工作包及验收表。
2. 检查当前仓库源码和已有改动，不把文档的接口名称当成现成 API。
3. 先确认输入契约，再实现；不通过改其它模块的私有结构解决集成问题。
4. 在分配的文件范围内工作。需改公共契约时先提交变更说明，由集成负责人统一修改。
5. 实现完成后运行本工作包测试，再运行类型检查/构建；提交真实结果，不能用“应该通过”代替测试。
6. 交付已完成项、修改文件、测试命令及结果、未覆盖项和下一包可以依赖的接口。
7. 发现宿主无法提供必要能力时停止相关功能并报告具体证据，不偷偷改 core 或伪造成功结果。

本文写得详细，是为了减少开发歧义，不是要求一次创建全部目录或实现所有扩展能力。严格按照工作包逐步交付可运行增量。

## 1. 目标、范围与硬约束

### 1.1 MVP 必须完成

- 作为 3D-Layout 中可开关的 CoAgent 插件运行。
- 鸟瞰 RGB 与 ID 图输入 VLM，生成地面语义分区；程序计算对象归属，允许人工修正。
- 主 Agent 接收模糊请求，必要时澄清，输出区域内的结构化目标任务。
- 判定者先取证，执行者用结构化工具编辑，判定者复拍并检查。
- 不同区域并行处理，同一区域任务顺序处理。
- 一条用户请求最多形成一条可撤销编辑历史。
- 失败/取消时撤销本轮场景修改；执行期间禁止正常 UI 和其它 Agent 抢写。
- 导出任务、工具、证据、结果和错误日志。

### 1.2 MVP 明确不做

跨区域协调；跨刷新恢复运行；持久化 LangGraph checkpoint；复杂 RAG；自动训练模型；在线生成新模型资产；动态插件市场；通用消息中间件；独立 Python 服务；多用户协同。

“不做跨区域任务”不等于无需边界校验。越权任务返回 unsupported，不能默默修改邻区对象。邻区静态几何可用于边界碰撞检查，但不交给 Agent 做跨区规划。

### 1.3 文件边界

| 范围 | 规则 |
|---|---|
| `src/modules/coagent/**` | 所有新增业务、测试、提示词、工具、渲染代码 |
| `src/App.tsx` | 仅注册、挂载、状态接线、交互互斥 |
| `src/package.json`、`src/pnpm-lock.yaml` | 必要依赖和测试脚本 |
| 其它 `src/modules/**` | 仅确有需要的旧 Agent/快捷键互斥入口 |
| `src/core/**` | 第一版零修改；无法满足时报告，不自行突破 |
| `src/components/**`、`src/ui/**` | 默认不改，优先利用现有宿主挂载与包装 |
| `develop-guide/CoAgent/**` | 文档、验收记录、开发交接 |

绝对禁止：DOM 注入实现插件、改写 core 函数、直接 setState 修改场景文档、直接设置资产 Object3D transform 替代编辑 API。

### 1.4 已核实的宿主约束

- 应用包在 `src/`，构建脚本为 `tsc -b && vite build`；使用 pnpm 锁文件，新增测试脚本需单独实现。
- App 静态装配插件，没有自动发现机制，所以 modules 外少量接入不可避免。
- SceneCanvas 提供 Canvas children，可以挂载模块自己的 R3F bridge。
- core/edit 同时只有一个 openTx；begin 会覆盖现有事务，不能嵌套。
- 场景单位为米，+Y 向上，transform 欧拉角为角度制、XYZ 顺序。
- core 的模型原点约定为底面中心，但导入资产是否实际满足需要检查。
- core 当前 EditSource 只有 human/agent；CoAgent 使用 agent，角色信息写自己的日志，不扩展 core 枚举。
- rollback 恢复资产修改，不恢复写入前的 redo 栈；删除导致的选中状态也不属于事务恢复保证。

最后一项属于已知宿主语义：MVP 的“回滚”保证场景对象恢复，不承诺历史栈和观察状态逐位恢复。若验收要求失败后 redo 栈也保持原样，需要单独讨论 core 公共事务接口扩展，不能通过访问私有变量解决。

## 2. 整体架构

### 2.1 外部系统与部署架构

```text
用户
  |
  v
3D-Layout 浏览器应用
  +-- 宿主 App：插件注册、面板、Canvas、编辑入口互斥
  +-- CoAgent 插件
  |     +-- UI / Runtime / Workflow / Agents / Tools
  |     +-- EditorAdapter --> core store/edit/现有保存接口
  |     +-- CoAgentBridge --> 共享 R3F Scene/WebGLRenderer
  |     +-- ModelAdapter --HTTPS--> 配置的模型 API
  |     +-- Recorder -----------> 浏览器下载日志包
  +-- 既有资产加载/保存通路 --> 现有模型库与场景存储
```

部署单位仍是现有 Vite 应用，不部署 CoAgent 后端。模型请求优先复用已存在的客户端/代理路径。如果供应商不允许浏览器跨域请求，必须在接入阶段明确阻塞；不得把增加服务当成无须确认的实现细节。

外部架构的责任边界：

| 外部依赖 | CoAgent 使用的能力 | CoAgent 不承担的责任 |
|---|---|---|
| 宿主 App | UI 挂载、Canvas bridge 挂载、互斥状态 | 重写整个平台插件系统 |
| core | 读取资产、增改删、事务、历史 | 新建第二个场景数据库 |
| 现有模型库 | 合法 ref、尺寸和可加载资源 | 生成未入库资产 |
| 模型 API | 多模态推理、结构化输出/工具调用 | 相信模型负责权限、事务和几何正确性 |
| 浏览器 GPU | 离屏渲染、像素读回 | 后台相机的真实物理仿真 |
| 浏览器下载 | 导出 JSON/图片 | 云端日志服务 |

模型密钥只存在当前设置/请求适配层，不进入图状态、事件、导出文件或错误原文。浏览器端密钥对终端用户可见，这是部署限制，不承诺服务端级保密。

### 2.2 内部依赖架构

```text
Panel / Hook
     |
     v
RunController ---- Recorder / EvidenceStore / Scheduler
     |
     v
WorkflowRunner
     |
     +-- LangGraph mainGraph / regionGraph
              |
              v
     Planner / Executor / Judge
              |
              v
       Services + ToolRegistry
              |
      +-------+---------+
      v       v         v
   ModelPort EditorPort RenderPort
      ^       ^         ^
   Model    Editor    CoAgentBridge
   Adapter  Adapter   / rendering
```

依赖约束可以用源码扫描测试执行：

- LangGraph 导入只允许出现在 workflow。
- core 导入只允许出现在 adapters/editorAdapter 边界。
- Three/R3F 导入只允许出现在 rendering。
- UI 不直接调用模型、工具或 edit。
- Agent 之间不互相 import；由 workflow 传递输入输出。
- 工具不读取 Zustand UI 状态决定权限，权限来自本次调用的不可变 context。
- contracts、schemas 不导入任何宿主运行时。

### 2.3 状态所有权

| 状态 | 唯一拥有者 | 允许的副本 |
|---|---|---|
| 场景资产事实 | core document | 只读、带版本的 DTO 快照 |
| 分区、多边形、相机配置 | partition service | 当前 run 的不可变快照 |
| 活跃运行、锁、事务、取消 | runController | UI 的状态投影 |
| 任务进度与结果 | workflow state | recorder 中的事件 |
| 图片 Blob、几何缓存 | evidenceStore / rendering | 引用 ID，不复制进图 |
| UI 展开、输入框 | uiStore / React | 不作为执行依据 |
| 请求凭据 | modelAdapter 配置快照 | 不允许导出 |

不存第二份可编辑 SceneDocument，不把模型聊天记录当成场景事实。

## 3. 目录与模块职责

```text
coagent/
  index.ts
  CoAgentPanel.tsx
  useCoAgentModule.ts
  uiStore.ts
  contracts.ts
  schemas.ts
  config.ts
  runtime/
    createRuntime.ts
    runController.ts
    scheduler.ts
    evidenceStore.ts
    recorder.ts
  workflow/
    createWorkflow.ts
    state.ts
    mainGraph.ts
    regionGraph.ts
  agents/
    planner.ts
    executor.ts
    judge.ts
    modelLoop.ts
    prompts.ts
  services/
    partition.ts
    observations.ts
    validation.ts
  tools/
    registry.ts
    sceneTools.ts
    editTools.ts
    cameraTools.ts
    geometryTools.ts
  adapters/
    editorAdapter.ts
    modelAdapter.ts
  rendering/
    CoAgentBridge.tsx
    capture.ts
    markers.ts
    geometry.ts
  tests/
    fixtures/
    fakes/
    unit/
    integration/
    browser/
```

允许在同一个边界中按复杂度拆文件，但不能把文件拆分变成新增框架、事件总线或泛型仓储层。

### 3.1 宿主入口与 UI

`index.ts` 只公开面板、hook、bridge 和必要宿主类型，不公开内部 store 或事务。

`useCoAgentModule`：

- 接收 enabled 和宿主运行资格，创建唯一 runtime。
- 暴露 busy、phase、start、cancel、preprocess、requestDisable。
- 接收 bridge ready/unready 状态；未就绪不能启动观测流程。
- StrictMode mount/unmount 不能重复建立活跃 run。
- requestDisable 先取消并清理，再允许宿主卸载 bridge。

`CoAgentPanel` 第一版仅包括：

1. 启用/就绪/失败状态。
2. 预处理按钮与分区列表。
3. 分区名称、对象数、归属异常和简单人工修正入口。
4. 指令输入、开始、取消。
5. 澄清问题与用户回答。
6. 每区域任务状态、前后证据预览。
7. 本轮结果和导出日志。

不得把日志控制台、复杂节点编辑器、自由绘制分区工具作为闭环前置条件。首版用多边形顶点表和对象归属表完成修正。

`uiStore` 是投影：消费 runtime 通知后更新进度，不驱动业务跳转；截图保存 observationId/objectURL，释放时撤销 objectURL。

### 3.2 Runtime

`createRuntime` 是唯一装配点：注入 Ports、配置、workflow factory、scheduler、recorder、evidenceStore。测试可全部换成 fake。

`runController`：

- 校验宿主 idle、分区有效、模型已配置、bridge 已就绪。
- 获取合作式编辑资格；冻结分区版本与配置。
- 创建 runId、AbortController、工具运行令牌。
- 调用 WorkflowRunner；惰性打开唯一事务。
- 管理最终提交、取消、回滚、保存和清理。
- 对外最多一个活跃 run；重复 start 返回 run_busy。

`scheduler` 提供两个不同资源：

- model semaphore：全局限制正在发出的模型请求数，默认 2；不能给每个区域各建一个“全局”限制。
- scene queue：串行化写入、几何快照和离屏捕获。网络请求绝不能占据该队列。

`evidenceStore`：

- 接收图片 Blob 与元数据，生成不可变 observationId。
- 提供按 ID 取图、临时 URL、导出和释放。
- 内存有上限；接近上限时明确终止/提示，不静默删掉判定仍需的证据。

`recorder`：

- 独立于图产生单调递增 eventSeq。
- 写入事件前递归过滤凭据和请求头。
- 导出 manifest、事件、任务、判定、截图映射及图片。
- 导出失败不改变已经提交的场景结果。

### 3.3 Workflow

`createWorkflow` 返回 WorkflowRunner，是唯一替换工作流实现的入口。

`mainGraph` 节点职责：

| 节点 | 输入 | 输出 | 是否可写场景 |
|---|---|---|---|
| collectContext | 用户请求、冻结分区 | 场景摘要、必要观测引用 | 否 |
| plan | 上下文 | Plan 或澄清/不支持 | 否 |
| validatePlan | Plan | 可信执行计划或错误 | 否 |
| captureBaselines | 可信计划 | 全部初始证据 | 否 |
| dispatchRegions | 按区任务 | 区域子图结果 | 仅子图执行工具 |
| finalCheck | 区域结果、最终场景 | 通过/失败与证据 | 否 |
| summarize | 已验证结果 | 用户可读摘要 | 否 |

摘要模型失败不应掩盖已验证结果：使用程序生成的保底摘要；没有最终验证则不能提交。

`regionGraph` 为每次区域作业创建私有状态：本区任务、当前索引、当前修正次数、结果和新增 ID 映射。不共享聊天数组。按任务 DAG 排序，禁止循环和跨区依赖。

第一版不使用 checkpoint 恢复编辑，不对副作用节点设置自动重试。替换 LangGraph 时只需实现相同 WorkflowRunner，不改场景工具。

### 3.4 Agent 业务函数

`planner`：

- 看全局轻量摘要、分区图、候选区摘要；按需看区域或当前用户视口。
- 不能一次把所有资产全部图像和历史聊天塞入上下文。
- 输出目标条件、约束、对象 ID、依赖，不直接输出可执行 JavaScript。
- 对“更稀疏”等无法合理定量的要求，可以询问强度或提出保守假设，并将假设记录到计划。
- 无权执行增改删。

`executor`：

- 只接收当前任务、本区数据、必要证据和上轮判定反馈。
- 按工具调用循环执行，所有参数经过 registry 和 edit facade。
- 输出完成声明只是候选结果，不等于任务通过。

`judge`：

- before 阶段确定必要取证视角/指标，调用只读观察。
- after 阶段拿原始任务、基线、同视角新图、几何结果和实际编辑摘要。
- 输出 pass/fail/uncertain，逐项证据和修正建议。
- 不得调用编辑工具；没有证据不允许 pass。

`modelLoop`：

1. 将角色输入转成规范消息。
2. 请求 ModelPort。
3. 校验返回工具名称、参数与权限。
4. 按返回顺序执行同一任务的工具调用，回传合法工具结果。
5. 达到结构化终态或预算终止。

一次回复里的编辑工具先串行处理，不为了“并行”打乱 add 后 transform 的依赖。预算包括失败工具调用和修正轮，模型不能靠换 toolCallId 无限循环。

### 3.5 Services

`partition` 负责：

- 鸟瞰请求及图片像素坐标到地面 XZ 坐标的转换。
- schema、多边形自交/面积/有限坐标校验。
- 对象归属、异常列表、人工覆盖和版本。
- 每区默认相机配置。
- 场景修改后重算派生归属，标记原分区过时。

`observations` 负责：

- 将捕获请求、场景摘要、标签映射组织成 Observation。
- 保存不可变基线及同视角 after 配对。
- 选择提供给模型的图像与文字摘要，不负责实际 GPU 调用。

`validation` 负责：

- 计划 schema、对象/区域合法性、依赖、写范围检查。
- 工具前置条件和最终保留条件。
- 检查 Verdict 引用的证据属于当前 run/task/version。
- 汇总数值条件、几何条件和视觉判定；硬约束失败不能被 VLM pass 覆盖。

### 3.6 Tools

registry 中每个工具必须有 name、description、input schema、allowedRoles、effect、handler。effect 至少区分 read/write/render。

| 工具 | 输入要点 | 输出要点 | 权限 |
|---|---|---|---|
| scene.list_region | regionId | 对象摘要、fingerprint | 主/执行/判定 |
| scene.get_objects | objectIds | 受范围限制的对象详情 | 主/执行/判定 |
| library.search | 关键字、过滤条件 | 合法 ref 与尺寸摘要 | 主/执行 |
| camera.capture | cameraId、标记选项 | observationId 与实际图像结果 | 主/执行/判定 |
| camera.focus | objectIds、padding | 本区相机新配置 | 执行/判定 |
| camera.set | 本区 camera pose | 已校验 camera snapshot | 执行/判定 |
| edit.add | ref、完整 transform | 新 objectId、receipt | 执行 |
| edit.transform | objectId、完整 transform、expectedFingerprint | receipt | 执行 |
| edit.remove | objectId、expectedFingerprint | receipt | 执行 |
| geometry.check | objectIds、检查范围 | clear/collision/unknown + evidence | 执行/判定 |

工具不能让模型指定 txId、runId、角色或权限。调用上下文由 runtime 注入。错误使用规范错误码，不返回 HTML、堆栈中的凭据或无法解释的空对象。

### 3.7 Adapters

`editorAdapter`：

- 将 core 类型转为纯 DTO；转换角度与缺省 scale 时保留统一约定。
- 包装 begin/setTransform/addAsset/removeAsset 和现有保存通路。
- 检查 core 编辑函数 boolean 返回值；false 不得记为成功。
- 订阅 document 变化生成 plugin revision 和对象 fingerprint。
- 暴露完整能力给 runtime、受限能力给工具，不把事务句柄交给图。

`modelAdapter`：

- 优先包装现有 llmClient 普通请求函数，不复用旧 Agent session/state machine。
- 统一文本、图像、工具调用、工具结果和用量。
- 实测一种供应商的多模态工具调用后再承诺支持。
- 旧 user message 仅支持 text 时，可使用真实 observation 工具调用返回图；不得制造没有对应 assistant tool call 的 tool result。
- 如需直接图像 user message，则模块内实现该供应商适配，避免强行套不支持的旧类型。
- 解析供应商响应和超时，但不决定事务提交或工具权限。

### 3.8 Rendering

`CoAgentBridge` 在 Canvas 内获取共享 scene/renderer/user camera，仅向 runtime 注册 RenderPort。

它拥有独立相机、render target、缓存和待捕获请求，不拥有资产。模块业务代码不触碰 Three 对象。

`capture` 的临界区：等待渲染同步 → 保存 renderer 状态 → 隐藏明确的 helper → 离屏渲染 → 读像素 → finally 恢复。不得跨网络 await 保持临时 renderer 状态。

`markers` 使用同一张 RGB 派生 ID 标记图。短编号只用于显示，必须附本图 label→objectId 映射。遮挡对象不得因投影点在屏幕内就宣称可见。

`geometry` 读取世界变换后的实际几何；缓存按 geometry 版本与实例 transform 分开。不能为加速检测修改共享资产 geometry。

## 4. 数据契约

### 4.1 通用约定

所有 DTO 带 schemaVersion。ID 都由程序生成，不由模型制造。图内只放 JSON 可序列化数据，禁止 Blob、Object3D、API key、AbortController、函数、事务句柄。

SceneId/ObjectId/RegionId/TaskId/ObservationId 在 contracts 中定义语义别名；第一版可用 string，不必引入复杂品牌类型系统。

世界单位米；rotationDeg 为角度制；camera 使用 position/target/up，投影参数显式保存。像素坐标原点左上，归一化图像坐标范围 [0,1]。

### 4.2 核心 DTO 形状

```ts
type Vec3 = [number, number, number];
type PointXZ = [number, number];
type TransformDTO = {
  position: Vec3;
  rotationDeg: Vec3;
  scale: Vec3;
};

type Region = {
  schemaVersion: 1;
  id: string;
  name: string;
  polygonXZ: PointXZ[];
  objectIds: string[];
  cameraId: string;
  partitionVersion: number;
};

type UnitTask = {
  schemaVersion: 1;
  id: string;
  regionId: string;
  objective: string;
  targetObjectIds: string[];
  allowedOperations: Array<"add" | "transform" | "remove">;
  criteria: Criterion[];
  constraints: Constraint[];
  dependsOn: string[];
};

type Criterion =
  | { id: string; kind: "visual"; description: string }
  | { id: string; kind: "metric"; metric: string;
      operator: "gte" | "lte" | "eq"; value: number; unit: string };

type Constraint =
  | { kind: "preserve_objects"; objectIds: string[] }
  | { kind: "stay_in_region" }
  | { kind: "no_collision" }
  | { kind: "preserve_count" };
```

metric 不是任意代码或表达式，只允许注册的指标名称。P1 契约阶段固定第一批指标，例如对象数、指定对象间的地面最小间距；未实现指标返回 unsupported_metric。

新增对象引用采用任务结果映射：后续任务通过 `createdByTaskId + localName` 引用，先解析成真实 ID，再形成可信执行输入。若第一版不实现该引用语法，planner 必须将相关动作放入同一单元任务；不能编造还不存在的 ObjectId。

```ts
type Observation = {
  schemaVersion: 1;
  id: string;
  runId: string;
  taskId?: string;
  regionId?: string;
  phase: "preprocess" | "baseline" | "task_before" | "after" | "supplement";
  sceneRevision: number;
  partitionVersion: number;
  camera: CameraSnapshot;
  width: number;
  height: number;
  rgbImageId: string;
  markedImageId?: string;
  labels: Array<{ label: string; objectId: string; visibility: "visible" | "uncertain" }>;
  observedObjectFingerprints: Record<string, string>;
  capturedAt: string;
};

type Verdict = {
  schemaVersion: 1;
  taskId: string;
  status: "pass" | "fail" | "uncertain";
  criteria: Array<{
    criterionId: string;
    status: "pass" | "fail" | "uncertain";
    evidenceIds: string[];
    reason: string;
  }>;
  repairSuggestions: string[];
};
```

CameraSnapshot 必须包含投影类型、position、target、up、near/far、图像 aspect，以及 perspective fov 或 orthographic left/right/top/bottom。只保存 cameraId 不足以复拍。

### 4.3 错误与结果

工具统一返回：

```ts
type ToolResult<T> =
  | { ok: true; data: T; evidenceIds?: string[] }
  | { ok: false; error: {
      code: string;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    }};
```

固定首批错误码：run_busy、cancelled、bridge_unavailable、renderer_not_ready、invalid_plan、invalid_arguments、out_of_scope、stale_object、unsupported_cross_region、unsupported_metric、asset_not_found、model_timeout、model_protocol_error、budget_exceeded、geometry_unknown、capture_failed、write_failed、rollback_failed。

retryable 表示可以重新评估/观察，不授权框架自动重放写入。捕获到未知错误转换成 internal_error，并保留脱敏诊断。

### 4.4 图状态

主图 state：runId、request、partitionVersion、计划、初始证据引用、按 regionId 存储的结果、最终验证。

区域图 state：regionId、排序后的 tasks、taskIndex、当前 task 的 repairCount、结果、必要反馈。

并行合并采用按 regionId/taskId 索引的结果表。不同分支禁止写同一个结果键；重复且不同的值应报错，不能 last-write-wins。序列日志由 recorder 独立持有，不依赖图数组合并顺序。

## 5. 模块通信协议

### 5.1 选择最简单的通信方式

| 通信双方 | 方式 | 原因 |
|---|---|---|
| Panel → Controller | 显式方法调用 | 用户意图可跟踪、可返回错误 |
| Controller → UI | 只读状态订阅 | 进度投影，不让 UI 干预内部流程 |
| Workflow → Agent | async 函数 + DTO/context | 易替换、易用 fake 测试 |
| Agent → ModelPort | Promise + AbortSignal | 网络取消与结构化结果 |
| Agent → ToolRegistry | 规范 tool call + 注入权限 | 统一授权与预算 |
| Tool → Adapter/Bridge | 注入的 Port | 不依赖宿主实现 |
| Bridge → Runtime | register/unregister RenderPort | Canvas 生命周期显式 |
| 所有模块 → Recorder | append(event) | 单向记录，禁止日志反向驱动业务 |

不为内部模块引入 WebSocket、HTTP、通用发布订阅消息总线。浏览器内函数调用已足够；现有 core bus 只在 adapter 中订阅。

### 5.2 依赖注入接口

```ts
interface WorkflowRunner {
  run(input: RunInput, context: WorkflowContext): Promise<RunOutcome>;
}
interface ModelPort {
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
interface RenderPort {
  ready(objectIds: string[], signal: AbortSignal): Promise<void>;
  capture(request: CaptureRequest, signal: AbortSignal): Promise<Observation>;
  geometry(request: GeometryRequest, signal: AbortSignal): Promise<GeometryResult>;
}
interface EditorReadPort {
  snapshot(scope: ReadScope): SceneSnapshot;
  subscribe(listener: (change: SceneChange) => void): () => void;
}
```

Editor 的事务能力只给 runtime。工具获得的是 `applyAuthorized(command, callContext)`，该 facade 在内部完成授权、版本检查、串行调度和事务注入。

所有接口都有 fake。生产实现和 fake 必须通过同一组 contract tests，避免假实现比真实 core 更宽松。

### 5.3 正常编辑时序

```text
Panel.start(request)
  -> Controller：检查就绪、互斥，冻结配置，创建 run
  -> Workflow.collectContext
     -> EditorRead.snapshot
     -> RenderPort.capture（按需）
  -> Planner -> ModelPort -> Plan
  -> Validation：可信计划
  -> JudgeBefore -> Observations -> RenderPort
  -> BaselineBarrier：全部初始证据完成
  -> Dispatch：每区一个私有 region job
     -> Executor -> ModelPort
     -> Registry -> applyAuthorized
        -> SceneQueue -> 检查 scope/fingerprint -> 首次 begin -> core edit
     -> JudgeAfter -> 同视角 capture -> 指标/几何 -> ModelPort -> Verdict
     -> 通过或有限修正
  -> FinalCheck
  -> Controller：等队列清空，commit
  -> 现有保存通路
  -> UI 结果；Recorder 可导出
```

同区第二项任务之前额外取 task_before 证据；它不能替换整轮 baseline。所有区域第一轮 baseline 必须在任何编辑前完成。

### 5.4 失败与取消通信

任何分支终止失败通知 controller，controller 使写令牌失效并取消其它分支。必须等待已开始的临界区退出才能 rollback。远端请求即使晚到，其回调也没有有效写令牌。

取消不是“只 abort fetch”。必须同时覆盖：

- 等待 semaphore 的模型请求；
- 等待场景队列的工具；
- 正在等待资产加载的捕获；
- 已完成网络但尚未执行的工具调用；
- 被 React 卸载触发的异步回调。

rollback 失败时进入 error_locked，保留错误和日志、禁止新 run，不把 UI 恢复 idle 后让用户继续积累不可信修改。

### 5.5 事件格式与顺序

每条事件包括 schemaVersion、eventSeq、time、runId、可选 regionId/taskId、type、payload。

首批事件：run.started、plan.ready、baseline.ready、task.started、tool.started、tool.finished、verdict.ready、task.finished、run.cancelling、run.committed、run.rolled_back、run.failed、save.failed。

eventSeq 由单个 recorder 分配；并行事件只有发生顺序，不暗示因果依赖。工具事件用 toolCallId 关联开始和完成。

## 6. 关键算法与行为规格

### 6.1 分区与对象归属

1. 读取场景资产与世界范围，排除明确的 editor helper。
2. 创建向下鸟瞰正交相机，保存投影和世界范围；near/far 根据实际场景设置。
3. VLM 返回图片归一化多边形、区域名、语义描述；输出不能直接成为最终 Region。
4. 用保存的相机射线与指定地面参考平面求交转成 polygonXZ。非平坦地形的高度不由该 2D 分区隐式推断。
5. 校验至少三个不同顶点、无自交、面积大于数值容差、坐标有限。
6. 用对象地面锚点决定主归属；多命中/零命中均显式列出。
7. 用户解决异常并确认版本；存在未解决的可编辑对象时不启动该范围内任务。
8. 人工覆盖只用于消除分区歧义，不等于授权对象越界移动。

地形、道路等覆盖多个区域的共享大对象可标记 global_readonly；这是显式分类，不把它们静默漏掉。首版禁止编辑这些对象。

多边形重叠不直接失败，但重叠内每个可编辑对象必须有唯一主归属。边界点使用数值容差并进入歧义处理，不靠数组顺序选择。

分区配置固定于 run 开始；执行时冻结写权限集合，不能因为对象刚移动就重新归属并扩大权限。运行结束/撤销后再重算派生归属。

### 6.2 区域边界与新增对象

目标位置必须在本区；对具有体积的对象，还需检查其地面投影范围。第一版使用保守世界 AABB 投影包含检查，可能拒绝靠边但实际合法的位置，必须说明这种保守性。

新增对象必须使用合法库 ref，程序生成唯一 ID，成功后加入本 run 的本区写集合并登记 receipt；rollback 后该集合清理。

不能只检查 position 而让建筑大半跨出分区。碰撞检查可读取其它区域静态物体，禁止修改它们。

### 6.3 相机与证据

区域默认相机根据本区对象的世界 bounds 取斜俯视；参数可由工具调整，但不保证单个视角看到所有被遮挡表面。全体对象落入视锥与全体对象可见是两回事。

before/after 使用同一个完整 CameraSnapshot 和输出尺寸。补充视角单独记 supplement，不冒充严格配对。

捕获前确认本次相关 edit 已同步至 R3F 资产对象，不能只等待固定毫秒数。检测 document transform 与渲染矩阵是否一致，超时明确失败。

像素读回检查上下翻转、颜色、透明背景、宽高、空白图；测试场景放不对称标识和不同颜色对象。finally 恢复 target、viewport、scissor、clear 状态和临时 visibility。

### 6.4 版本、幂等与竞争

plugin sceneRevision 随 document 变化增长，作为观测版本；对象 fingerprint 从规范化 ref/transform/visible 等实际相关字段计算。

写入前检查目标对象及依赖参照对象的 fingerprint。不能因区域 A 修改导致全局 revision 增长就拒绝区域 B 的所有操作。

幂等键为 runId + taskId + toolCallId；相同键相同参数返回原 receipt，不再执行；相同键不同参数报错。不同调用 ID 的相似操作不做模糊去重。

写入前检查和 core edit 在同一个同步临界区执行，不在中间 await。

### 6.5 几何碰撞

碰撞接口返回 clear/collision/unknown，并注明算法级别与对象对，不只给 boolean。

实现顺序：真实世界 AABB 宽阶段 → 候选 mesh 三角检测 → 完全包含处理 → 接触容差与地面接触分类。

仅三角面相交检测不足以识别“一个闭合实体完全包在另一个里面”。没有包含测试时不得宣称完整 mesh 碰撞已实现。非闭合、蒙皮、缺失几何等不支持情况返回 unknown。

接触是否允许写入配置；地面支撑接触不能一律当作碰撞。对地形没有可靠接触分类时返回 unknown，不用模型口头判断覆盖几何状态。

如果使用 BVH 库，先验证与当前 Three 版本、实例矩阵和共享 geometry 的兼容性。算法包选择不影响 GeometryResult 接口。

### 6.6 判定与最终检查

每项 task 必须所有 criteria 有结果。无证据、证据过期或几何 unknown 均不能当作硬约束通过。

最终检查至少重新确认：

- 所有区域有终态结果，没有遗漏分支。
- 所有任务通过且没有取消令牌失效。
- 保留对象未被误删，作用域外资产没有被本轮工具修改。
- 最终场景满足计数/区域/几何硬约束。
- 同区后续任务没有破坏前面任务的目标；受后续编辑影响的早期条件需重新评估。

执行顺序正确不代表最终状态正确。后续移动可能破坏先前已经“摆正”的对象，因此不能只汇总历史 pass。

## 7. 生命周期、预算与资源

### 7.1 状态机

```text
disabled -> initializing -> idle
idle -> preprocessing -> idle / error
idle -> planning -> awaiting_clarification -> idle
planning -> baselining -> executing -> validating -> committing -> completed
任意活跃阶段 -> cancelling -> rolled_back / failed
清理失败 -> error_locked
```

completed/rolled_back/failed 是上一轮结果，清理完成后才允许新 run。澄清不保留活跃事务；用户答复作为新输入重新观察。

### 7.2 默认配置

| 配置 | 默认值/策略 |
|---|---|
| 全局模型并发 | 2 |
| 每任务额外修正 | 1 次，不含首次执行 |
| 每任务工具预算 | 30 次，含失败与修正 |
| 单次模型超时 | 120 秒 |
| 场景就绪超时 | 初始 15 秒，可配置并记录 |
| schema 修复请求 | 最多 1 次 |
| 自动恢复编辑 | 禁用 |
| 导出凭据/完整请求头 | 禁止 |

运行总时限、图片总内存和日志大小必须在 config 中有明确上限，由 P2/P4 实测后给默认值；不得留成无穷。超限状态纳入测试。

### 7.3 资源清理

每轮 finally 清理订阅、取消等待任务、解除临时 UI busy；证据保留到用户清除/下一轮替换或导出完成，不能提前销毁仍在预览的 Blob URL。

插件卸载释放 render targets、私有材质、私有几何和 objectURLs；不得 dispose 共享模型资产、宿主 renderer 或环境贴图。

关闭标签页/刷新不保证 rollback 执行成功；活跃时提供浏览器允许范围内的离开提示。第一版不承诺崩溃恢复。

## 8. 开发计划与工作包

### 8.1 依赖图

```text
W00 现状核查
  -> W01 契约与假实现
  -> W02 LangGraph 浏览器验证
  -> W03 Runtime/事务/宿主接入
  -> W04 相机与证据
  -> W05 假模型全闭环
  -> W06 真实模型与预处理
  -> W07 Planner
  -> W08 Executor/Judge/几何闭环
  -> W09 导出、综合验收
```

不要跳过 W05 直接调真实模型。公共契约冻结后，rendering、modelAdapter、纯 partition 算法可分派并行开发；合并顺序仍按上述验收门执行。

### W00：仓库现状与能力清单

负责范围：只读源码与文档。

操作：

1. 检查仓库指令、工作树、包管理器、App/SceneCanvas、旧 Agent、edit/store/types。
2. 查明旧 llmClient 实际导出、图片输入方式、取消行为。
3. 列出所有能修改场景的 UI、快捷键、旧 Agent、异步导入入口。
4. 在 `develop-guide/CoAgent/IMPLEMENTATION-STATUS.md` 建立状态表。

测试：运行现有 build，记录基线结果；已有失败单独列出。

完成条件：实际 API 映射和最小外部改动清单明确；不因文档示例而调用不存在的函数。

### W01：公共契约与假实现

负责文件：contracts、schemas、config、tests/fakes、tests/fixtures。

操作：

1. 固定任务、证据、错误、Ports、事件类型。
2. 选定与实际依赖兼容的运行时 schema 校验方式。
3. 创建 FakeEditor/FakeRender/FakeModel 和两区域测试场景。
4. FakeEditor 模拟单事务和实际 rollback 限制，不实现不存在的嵌套事务。
5. 增加测试脚本；测试源码/配置尽量留在模块内。

测试：非法数字、缺失 ID、错误 schemaVersion、任务循环、越权、假模型取消；构建。

完成条件：各开发包能仅依赖契约和 fake 编译，不需要 import 对方私有实现。

### W02：LangGraph 可行性验证

负责文件：workflow 和对应测试；依赖变更由集成负责人合并。

操作：

1. 安装并锁定实际可用的 LangGraph JS 版本。
2. 在 Vite 浏览器跑最小图，不只在 Node 测试。
3. 实现两个不同耗时分支，一个带修正循环。
4. 验证结果 reducer、汇合和 AbortSignal 的实际行为。
5. 实现 WorkflowRunner 外壳，不连接真实写工具。

测试：分支乱序完成、某支失败、等待取消、构建产物无意外 Node-only 依赖。

完成条件：最后检查恰好一次且等待全部分支；若不通过，先解决运行时兼容，不继续业务堆叠。

### W03：运行控制、事务与宿主接入

负责文件：runtime/controller/scheduler、editorAdapter、hook、最小 panel、App 接线。

操作：

1. 实现 start/cancel/requestDisable、合作式编辑资格。
2. 接入假 workflow，对两个区域做已知 transform。
3. baseline 放行后首次写入 begin，整轮只 commit 一次。
4. 接入旧 Agent、gizmo、快捷键、历史面板与场景切换禁用。
5. 注册所有清理路径；捕获 core boolean 失败。

测试：

- 两区域多次写入只新增一个 undo 单元。
- undo 恢复初始资产，redo 重现成功结果。
- 执行中失败/取消恢复资产集合和 transform。
- 模型迟到、工具排队、重复 start、关闭插件不能继续写。
- 回滚不恢复已有 redo 栈的宿主限制有明确记录。

完成条件：真实 core 上事务和互斥通过，不只 FakeEditor 通过。

### W04：独立相机与证据

负责文件：rendering/capture/markers/bridge、evidenceStore、observations。

操作：

1. bridge 挂载和 RenderPort 注册。
2. 单区域 RGB 捕获、像素方向和颜色校验。
3. 同帧派生 ID 标记和映射；加入聚焦相机。
4. before/after 完整相机快照复用。
5. GPU 状态恢复、超时、卸载和资源释放。

测试：非对称场景；移动资产后立即捕获；被遮挡/画外对象；用户相机姿态不变；异常捕获后主视口继续正常显示。

完成条件：浏览器实际图片可检查且非空，ID 对应正确；不能只 mock capture 就宣称完成。

### W05：假模型端到端闭环

负责文件：mainGraph、regionGraph、agents 外壳、工具 registry 和验证。

固定脚本场景：

1. 两区各两个对象，指令生成每区任务。
2. 所有初始基线在第一次写入前完成。
3. A 区首次失败后修正成功，B 区较慢但成功。
4. 同区第二任务取得即时基线。
5. 整轮检查后一次 commit。
6. 另一用例模拟 B 区终止失败，A 区已完成修改也回滚。

测试：检查 recorder 事件顺序和场景结果；schema 错误、越权工具、错误证据 ID 必须阻止通过。

完成条件：以上用例自动化通过。此时尚未连接真实模型，但整个工程流程已经可靠。

### W06：真实模型与分区预处理

负责文件：modelAdapter、partition、预处理 UI。

操作：

1. 只选一种供应商协议实测文本、图片、工具和取消。
2. 鸟瞰 VLM 输出多边形，程序转世界坐标。
3. 校验归属异常并实现人工修正。
4. 记录 partitionVersion、相机和库配置。
5. 密钥脱敏与错误可读化。

测试：模型输出乱 JSON、多边形自交、全部对象未归属、多区重叠、无网络/401/超时、图片真正进入请求。

完成条件：可重复得到用户确认的分区；不能以“VLM 返回了一段文字”算完成。

### W07：真实 Planner

负责文件：planner/prompt、计划 validation、澄清 UI。

操作：构造精简上下文，输出目标条件、约束与任务依赖；主 Agent 按需观察用户视口；建立支持的 metric 白名单。

测试输入：

- “把村落分布得更稀疏”：输出可执行区域任务或必要澄清。
- “把这个房子移到另一片区域”：返回不支持/澄清，不越权执行。
- 不存在的对象、含糊“那个”、无法量化的程度：不能编造 ID 或阈值事实。

完成条件：所有真实输出均通过同一 schema/作用域校验，不设置“真实模型免校验”分支。

### W08：真实执行、判定与几何

负责文件：executor、judge、modelLoop、editTools、geometryTools/geometry、finalCheck。

建议内部顺序：

1. 只开 transform，跑通一任务前后比较。
2. 加 add，核对 ref/ID/加载等待/rollback。
3. 加 remove，核对保留对象与撤销。
4. 实现宽阶段检测；未完成窄阶段时返回 unknown。
5. 增加窄阶段、包含与接触策略测试，再允许声明 clear。
6. 加入有限修正和最终重检。

测试：目标未达成、判定无证据、碰撞、完全包含、几何未知、后续任务破坏前任务、超预算。

完成条件：不是只展示一次成功；必须同时演示失败后修正和不可修正时整轮回滚。

### W09：日志、综合验收与交接

负责文件：recorder/export、panel 收尾、全部集成测试和交接文档。

操作：

1. 导出可离线阅读的 JSON 与图片包；如选择 ZIP，依赖必须显式声明，不能假设浏览器原生 ZIP API。
2. 输出 run summary、工具 timeline、相机/ID 映射、模型/提示词版本。
3. 实际场景演示完整流程。
4. 构建、浏览器检查、资源清理和泄露扫描。
5. 更新 IMPLEMENTATION-STATUS，记录偏差和已知限制。

完成条件：第 9 节必测项都有通过证据或明确未完成项；不能把未完成标成“后续优化”后宣称 MVP 完成。

## 9. 测试矩阵与验收定义

| 编号 | 测试 | 层级 | 必须断言 |
|---|---|---|---|
| T01 | schema/有限值/依赖图 | 单元 | 非法输入不能进入执行 |
| T02 | 分区边界/重叠/未分配 | 单元 | 异常显式，不静默归属 |
| T03 | 作用域与角色 | 单元/集成 | judge 无写权限，邻区不可写 |
| T04 | 幂等与冲突 | 集成 | 重复调用不重复新增；过期对象拒绝 |
| T05 | 全局初始基线 | 集成 | 首次写入晚于所有 baseline 完成 |
| T06 | 区内多任务 | 集成 | 即时基线不覆盖整轮基线 |
| T07 | 并行与汇合 | 集成 | 不早提交，不丢结果，并发不超限 |
| T08 | 事务与 undo/redo | 真实宿主 | 成功只一条历史；undo/redo 场景正确 |
| T09 | 取消与迟到请求 | 集成/浏览器 | rollback 后无后续写入 |
| T10 | renderer 恢复 | 浏览器 | 出错后用户视口与状态仍正常 |
| T11 | 相机复拍/ID/像素 | 浏览器 | 非空、方向正确、同视角、映射正确 |
| T12 | 几何边界案例 | 单元/浏览器 | 接触、包含、旋转缩放、未知正确分类 |
| T13 | 旧 Agent/UI 抢写 | 浏览器 | 快捷键、历史、导入、切换入口受控 |
| T14 | 模型协议 | 实际供应商 | 图像和工具确实到达，取消/错误有效 |
| T15 | 导出与脱敏 | 集成 | 图像引用可解析，无密钥 |
| T16 | 生命周期 | 浏览器 | StrictMode、重复启停不重复订阅/泄露 |
| T17 | 最终一致性 | 集成 | 后任务破坏前条件时整轮不能通过 |

测试原则：

- fake 用于确定性故障注入；真实 core/GPU/API 检查不能由 fake 替代。
- 日志断言业务事件，不断言不稳定的自然语言原文。
- 真实模型测试记录模型标识、配置、提示词版本和运行日期，不要求逐字复现。
- 每包执行针对性测试，集成后执行全部自动化测试与 build。
- 项目当前没有 CoAgent 测试脚本；W01 创建后才可在交接中引用具体命令，不编造已存在命令。

## 10. SubAgent 分工与协作协议

### 10.1 推荐角色

| 开发角色 | 文件所有权 | 依赖 |
|---|---|---|
| 集成负责人 | contracts/schemas/config、App、package/lock、最终合并 | 全局 |
| Runtime 开发者 | runtime、editorAdapter、事务测试 | 契约冻结 |
| Rendering 开发者 | rendering、observations、视觉测试 | RenderPort 冻结 |
| Workflow 开发者 | workflow、agents、registry 组织 | 假 Ports、预算契约 |
| Model/Partition 开发者 | modelAdapter、partition、对应测试 | ModelPort、坐标契约 |
| 验收开发者 | 综合 tests、复现记录 | 分阶段可运行产物 |

这是未来实施分工，不要求同时启动六个 Agent。人手少时同一个 Agent 顺序承担多个角色。

不能并行修改 contracts、App、package.json、锁文件。模块开发者提交所需变更，由负责人统一落地后再继续。

### 10.2 可复制的开发任务模板

```text
任务：实现 CoAgent 工作包 Wxx
必读：DEVELOPMENT-SPEC 第 ... 节；当前 contracts.ts；相关宿主源码
前置：Wxx 已通过，接口版本 ...
允许修改：明确文件/目录列表
禁止修改：core、其他模块私有实现、公共契约（未经协调）
输入契约：...
输出契约：...
必须行为：...
失败行为：...
测试编号：Txx ...
完成证据：测试命令/结果、关键截图或日志、构建结果
交接：变更列表、已知限制、下个工作包可用入口
不得实现：本任务之外的扩展功能
```

### 10.3 接口变更流程

提出变更原因 → 说明受影响调用方 → 更新契约与 fake → 全部调用方编译 → 合同测试 → 合并实现。

禁止在某个模块偷偷增加可选字段并期望其它 Agent 自动理解。重要语义变化需要更新 schemaVersion 或明确仅限尚未发布的开发版本同步修改。

### 10.4 每包交付格式

```text
工作包：Wxx
状态：完成 / 部分完成 / 阻塞
实现：...
变更文件：...
接口差异：无 / 具体内容
测试：命令、通过数量或结果、运行环境
未验证：...
已知限制：...
下一步：哪个工作包现在可以开始
```

## 11. 关键架构决策与扩展方式

| 后续变更 | 修改位置 | 不应修改 |
|---|---|---|
| 改任务分配或判定顺序 | workflow + 必要 Agent 输入构造 | core、截图算法、事务控制 |
| 换模型供应商 | modelAdapter | 工具权限和几何 |
| 增加深度/轮廓图 | RenderPort、rendering、observations | 编辑事务 |
| 改分区算法 | partition | Agent 工具协议 |
| 增加工具 | registry + handler + schema + 测试 | 重写所有 Agent |
| 引入检索 | 新检索 service/port | 直接把数据库塞进图 state |
| 增加独立后端 | 新 ModelPort/WorkflowRunner 适配 | 绕过宿主授权直接远程改场景 |
| 更换 LangGraph | WorkflowRunner 的另一实现 | editorAdapter、Rendering |

不为这些未来功能现在创建空实现。只保留稳定的接口边界。

## 12. 开发启动清单

- [ ] 阅读当前源码与所有仓库指令。
- [ ] 接受 modules 外仅少量宿主装配/依赖变更。
- [ ] 明确 core 零修改及 rollback/redo 限制。
- [ ] W00 建立当前构建基线。
- [ ] W01 冻结 DTO、Ports、错误与预算。
- [ ] W02 验证浏览器 LangGraph，再推进真实业务。
- [ ] W03～W05 完成假模型闭环。
- [ ] W06～W08 接真实模型与几何。
- [ ] W09 全部验收并交接。

真正的完成标准是：一个新开发者按工作包依次执行，能复现成功、失败、取消、回滚与撤销，而不是仅理解一张架构图。
