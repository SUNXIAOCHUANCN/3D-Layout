# 3D-Layout

Web 端 3D 布局软件（毕业设计）。数据驱动的 Three.js 场景渲染，支持人工与 AI 编辑，并提供 SQLite 工作区持久化。

## 技术栈

Vite 8 · React 19 · TypeScript · three.js（WebGL2）· @react-three/fiber · @react-three/drei · zustand · pnpm

> 环境要求：Node ≥ 22.18（当前验证版本 22.23.4，见 `.nvmrc`）；npm 或 pnpm。后端使用 Node 内置 SQLite，无需安装数据库服务。

## 目录结构

主要目录：

```
3D-Layout/
├─ assets/                  # 素材库（数据，不参与构建）
│  ├─ models/               #   工作流标准资产包：<原始模型名>/layout_manifest.json + model/ + 标签/预览
│  ├─ model-catalog.json    #   编辑器生成的米单位模型目录（位于资产包外）
│  ├─ builtin-models.json   #   编辑器内置 primitive 定义
│  ├─ hdri/  decoders/  textures/
├─ server/                  # SQLite 持久化 API、独立服务、备份和测试
├─ .data/                   # 本机数据库（自动创建，不进 Git）
├─ scenes/                  # 场景库与数据库文档投影（数据，不参与构建）
│  └─ scene-01/
│     ├─ scene.json         #   中立场景描述；已接管场景由数据库同步导出
│     └─ threejs/view.json  #   ThreeJS 渲染绑定（相机/网格/环境覆盖），可选
└─ src/                     # 源码文件夹（vite 工程根，所有代码与工程文件都在这）
   ├─ package.json  vite.config.ts  tsconfig.json  index.html  .npmrc  .gitignore
   ├─ core/                  # 框架无关核心层
   │  ├─ types.ts            #   scene.json / view.json / meta.json 数据契约
   │  ├─ store.ts            #   zustand：SceneDocument 内存映像（唯一事实源）
   │  ├─ commands.ts         #   命令层（编辑器与 Agent 的统一修改入口）
   │  ├─ engine.ts           #   引擎 API：pick / captureScreenshot / attachGizmo(二期)
   │  ├─ events.ts           #   类型化事件总线
   │  └─ loader.ts           #   数据加载
   ├─ components/            # 渲染同步层（唯一允许操作 three 对象的地方）
   ├─ modules/               # 可拆卸模块：editor（人工编辑）/ history（历史侧栏）/ agent（AI 编辑）
   ├─ ui/                    # DOM 侧 UI（顶栏、加载浮层）
   ├─ App.tsx / main.tsx / style.css
   ├─ scripts/               # dev.bat / build.bat / preview.bat / gen-manifest.mjs
   └─ node_modules/ dist/    # 生成物（git 忽略）
```

数据（assets/scenes）与源码（src）彻底分离：数据目录不进 vite 工程，构建不打包它们；vite 通过自定义中间件从上一级目录伺服 `/assets/*` 与 `/scenes/*`。

## 启动

- 双击 `src\scripts\dev.bat`（首次自动安装依赖、生成 manifest，然后打开浏览器）
- 或手动：
  ```bat
  cd src
  npm.cmd install
  npm.cmd run gen-manifest
  npm.cmd run dev
  ```
- 构建：`src\scripts\build.bat`（产物 `src\dist\`；本地持久化部署使用 `npm.cmd run server`，详见下文）
- URL 参数 `?scene=scene-02` 直接打开指定场景

## 后端与刷新恢复

默认“AI 编辑”的模型请求和工具循环已移到后端。刷新后恢复任务对话、执行进度、草稿及接受/拒绝状态；浏览器视口工具等待重连，已确认工具不重复执行。详见 [AI 任务持久化与重连](develop-guide/AI任务持久化与重连.md)。

开发模式 `npm.cmd run dev` 会自动挂载持久化 API，不需要额外启动后端进程。人工操作或 AI 事务完成后自动保存；刷新、切换场景以及服务重启后恢复场景与撤销/重做历史。顶栏显示保存状态，并提供重试和冲突恢复入口。

- 数据库：`.data/layout.sqlite`；模型与贴图继续存放在 `assets/`。
- 首次读取自动接管已有场景；之后数据库为持久化依据，`scene.json` 是供旧工具使用的文件投影。
- 构建后运行：在 `src/` 执行 `npm.cmd run build`，再执行 `npm.cmd run server`，访问 `http://127.0.0.1:5173`。
- 数据库备份：`npm.cmd run backup`；完整备份还需包含模型资源和视图文件。
- 测试：`npm.cmd run test:backend`、`npm.cmd run test:backend-browser`。

具体接口、离线恢复限制及备份步骤见 [后端 README](server/README.md)，架构说明见 [后端持久化技术设计](develop-guide/后端持久化技术设计.md)。本版本面向本地单用户；多个标签页遇到版本冲突时会拒绝覆盖，尚不提供多人实时合并。

## 视口操作

| 操作 | 手势 |
|---|---|
| 选中资产 | 左键点击资产（**纯 mesh 精确拾取，Blender 式**，无包围盒代理；点模型可见轮廓才命中）；点击空白处取消选中 |
| 旋转视角 | 右键拖拽 |
| 平移相机 | 中键拖拽 |
| 缩放 | 滚轮 |

## 编辑器模块（modules/editor，可拆卸）

**左侧插件侧边栏**是插件的装配中心（常驻显示）：每个插件一行开关，启用时其面板 UI 展开在下方（人工编辑 = 变换工具 + 操作按钮 + 数值面板）。插件全部关闭后侧边栏仍在，随时可以重新开启。

开关优先级：URL `?editor=0/1` > 场景 `threejs/view.json` 的 `editor.enabled` > 默认开启。**关闭后点击资产无任何反应，等同纯渲染器**——因为渲染层只上报 `asset:clicked` 事件，选中行为由模块订阅产生。

选中高亮 = **橙色倒角壳描边**（沿模型轮廓，Blender 风）。glb 加载时做一次性规范化（`normalizeGltf`）：蒙皮网格烘焙成普通 Mesh（three 的射线拾取不计算蒙皮形变）+ 重算几何包围球/包围盒缓存（部分 glb 的缓存包围球与顶点数据单位不一致，会导致"看得见点不中"）。代价是模型按静态展示处理（播放动画需另走原始 glb 实例）。

| 快捷键 | 功能 |
|---|---|
| W / E / R / T | 移动 / 旋转 / 缩放 / 复合 gizmo |
| X | 局部/全局坐标系切换 |
| 按住 Ctrl | 临时反转吸附（移动 0.5m / 旋转 15° / 缩放 0.1） |
| F | 聚焦选中资产 |
| Delete / Backspace | 删除选中资产 |
| Ctrl+D | 复制选中资产 |
| Ctrl+Z / Ctrl+Shift+Z(或 Ctrl+Y) | 撤销 / 重做 |

数值面板支持直接输入位置/旋转(°)/缩放（回车或失焦提交）；gizmo 拖拽时数值实时反向同步。「保存」把当前场景写回 `scenes/<id>/scene.json`（version+1；dev/preview 经 Vite 接口落盘，生产环境自动降级为下载文件）。

## 历史记录侧栏（modules/history，右侧，可收起）

消费 `edit.historyUnits()/redoUnits()` 的统一历史谱系（每条 = 一个事务：一次拖拽/一次数值输入/Agent 一项任务；带 人工/Agent 标签、步数、时间，最新在下、高亮当前步）：

- 点击某条 → 确认框 → **撤回到该步完成时的状态**（撤销其后所有步骤）
- 灰色"已撤销"条目 → 点击 → 确认框 → 重做到该步
- 左右两侧边栏均可收起成细条（标题行 « / »），点细条展开；**边缘拖拽可调宽**（宽度记忆在 localStorage）

## 编辑引擎（core/edit.ts）

场景变更的唯一入口：编辑接口 + 历史记录 + 撤销回滚一体化（命令期刊记 before/after + source + 事务；不用全量快照）。事务把 gizmo 一次拖拽、Agent 一项任务合并为一条可撤销记录；`source: 'human' | 'agent'` 让人和 AI 的操作进同一本账，供历史面板展示与整体回滚（三期）。selection/相机等观察状态不进历史。

## 核心概念

### 场景 = 数据（scene.json 是唯一事实源）

`scenes/<id>/scene.json` 中立地描述场景（资产列表 + transform + 相机 + 环境）。渲染器是通用引擎，读任何 scene.json 都能渲染。同一场景以后可并列增加其他语言的表示目录（如 `python/`），它们读的是同一份 scene.json。`threejs/view.json` 只放渲染器专属配置，可选。

约定：单位米；+Y 向上；欧拉角角度制；模型原点在底面中心；场景资产用 `ref: "models/<id>"` 引用模型库，**不复制模型文件**。

### 解耦三规则

1. 只有 `src/components/`（渲染同步层）允许直接操作 three 对象，其余代码只读写 store 里的 SceneDocument；
2. 对场景的修改一律走 store action / `commandBus`；
3. 修改 → 数据变化 → 渲染幂等同步（数据驱动渲染）。

### 命令层（Agent 的预留接口）

`src/core/commands.ts`：`set_transform / add_asset / remove_asset / select / load_scene`。一期由 UI 触发；二期编辑器、三期 Agent 只是新的触发方，undo/重做、审计日志、WebSocket 远端命令都在这一层叠加。Agent 工具集即本层子集。

### 引擎 API 与事件

`src/core/engine.ts`：`pick(clientX, clientY)`（屏幕坐标拾取资产 id）、`captureScreenshot()`（导出视口 PNG，后期 VLM 布局校验用）、`attachGizmo`（二期）。事件总线 `src/core/events.ts`：`scene:changed / asset:selected / asset:loaded / command:dispatched`。

## 日常操作

- **加模型**：将工作流输出的完整资产包目录放入 `assets/models/`，在 `src/` 下跑 `pnpm gen-manifest`。入口为各包的 `layout_manifest.json`；生成的目录写入 `assets/model-catalog.json`，不改写资产包。旧 `meta.json` 模型仍支持导入。
- **标准尺寸**：编辑器将厘米模型和元数据统一换算成米；新增模型默认 `scale=[1,1,1]`。Agent 可读取名称、类别、检索描述、标签、尺寸可信状态和朝向状态。内置占位模型定义在 `assets/builtin-models.json`。
- **目录命名**：当前目录采用原始模型名，如 `models/tree1`；包内 `asset_id` 和 GLB 文件名仍是工作流的稳定编号，模型加载路径从清单读取。目录重命名程序为 `src/scripts/rename_model_directories.py`，完整映射和备份位置见 `assets/model-directory-renames.json`。
- **历史场景迁移**：现有场景已迁移到标准资产引用，实例变换保留原布局；备份位置记录在 `assets/model-migration.json`。程序和验收说明见 `src/scripts/MODEL_MIGRATION.md`。
- **加场景**：顶栏下拉旁的「新建」按钮一键创建空场景（自动分配 `scene-NN` 编号并登记索引）；「删除」按钮删除当前场景（至少保留一个，不可恢复）。也可手工新建 `scenes/<new-id>/scene.json`（可复制现有场景改），跑 `pnpm gen-manifest`。
- **换 HDRI**：文件放 `assets/hdri/`，场景 `environment.hdri` 引用；不配则用程序化环境（离线可用）。

## Agent 模块（modules/agent，提案式场景编辑）

**权限模型**（回答「编辑器给 Agent 开放什么」）：权限 = 工具白名单（`modules/agent/tools.ts` 注册表，注册即授权、未注册即拒绝）+ 调用时机约束 + 人工裁决。面板里直接展示开放/不开放清单。

| 工具 | 权限 | 说明 |
|---|---|---|
| `scene.get_state` | 只读·免确认 | 场景中立快照：资产/变换/世界 AABB/模型目录；来源是内存文档（含未保存编辑），不是磁盘文件 |
| `viewport.screenshot` | 只读·免确认 | **无 UI 截图**：与视口同相机同构图，自动隐藏选中描边与 gizmo（`userData.editorHelper` 标记），非离线渲染；任务中可调（能看到提案中的状态） |
| `asset.set_transform` | 写·仅任务内 | 提案式生效 |
| `asset.add` | 写·仅任务内 | ref 必须在模型库 manifest 中；id 由前端铸造并回传 |
| `asset.remove` | 写·仅任务内 | 拒绝时自动恢复 |

明确不开放：直接操作 three 对象、保存/落盘、切场景/相机/改选中、任务事务外的写操作、白名单外的任何工具。

**聊天式编辑 + API 设置**：面板是对话框（流式输出、工具调用过程行、可停止/清空）；⚙ 设置 打开 API 设置窗口——**接入方式三选一**（OpenAI Chat `/chat/completions`、OpenAI Response `/responses`、Anthropic `/v1/messages`），**预设 10 家服务商**（OpenAI / Anthropic / Gemini / Grok / DeepSeek / Qwen / GLM / Kimi / Xiaomi MiMo / OpenCode Go，另加自定义），含 Base URL、API Key（仅存本浏览器 localStorage）、模型名（建议值可自由输入）与**测试连接**。所有服务商的浏览器请求都优先经本机 /api/llm/request 转发（规避智谱等不对 localhost 开放 CORS 的厂商；Anthropic 自动附带浏览器直连声明头），纯静态托管时回退浏览器直连。

**权限模式与提案式事务**：默认采用原版模型循环和连续上下文。**变更前确认**模式在每批写工具后等待裁决：接受保存本批并继续，拒绝只回滚本批，已接受批次保留；也可保留当前提案并填写意见继续局部调整。**自动编辑**模式自动提交批次。提案预览期间暂停人工写操作，仍可选择和审查物体。保存由 SQLite 后端确认，成功后进入统一撤销历史；关闭面板或刷新页面保留任务，明确“停止生成”才取消并撤销未提交草稿。模型检索与疑似重叠检查可单独开启，默认关闭。

**传输层可换**（消息协议：`modules/agent/protocol.ts`；LLM 循环见 `llmChatTransport.ts`）：
- 缺省 = **浏览器直连 LLM**：本地 Harness——用户指令 → LLM function calling（工具 schema 由权限注册表生成）→ 工具调用走统一协议 → 提案裁决回流续跑；
- `?agent=loopback` = **演示回环**：本进程扮演 Harness，跑「读场景 → 无UI截图 → 提案改场景」固定脚本，无 Key 可演示权限流程；
- `?agent=1` = WebSocket `ws://localhost:5174`，`?agent=ws://host:port` 指定地址——三期远端 Node Harness 实现同一 JSON 协议即可接管，前端零改动。

## 路线图

- **二期 · 编辑器**：TransformControls gizmo、属性面板、多选、撤销/重做（命令事务化）
- **三期 · Agent**：前端全链路已就绪（modules/agent：权限白名单 + 提案式事务 + 无UI截图 + 浏览器直连聊天编辑[OpenAI Chat/Response/Anthropic 三协议、9 厂商预设] + loopback/WS 双传输）；待办：`validate_layout` 布局校验、VLM 截图校验闭环、远端 Node Harness（可选，WS 协议已留）


## 模型接入与本地转发

浏览器侧所有 LLM 请求（设置测试、聊天编辑、CoAgent）统一先走本机转发 `/api/llm/request`，用于规避厂商 CORS 差异（智谱 open.bigmodel.cn 只对自家域名开放跨域，DeepSeek/月之暗面/阿里等则对 localhost 放行）。
OpenCode Go 档案填写 Go 密钥即可；默认 Base URL `https://opencode.ai/inference/go/openai/v1`，协议 **OpenAI Chat**，会话标识与应用标识由转发自动附带。

- 开发启动与 `pnpm preview` 共用 `/api/llm/request`，无需额外启动服务。修改后须重启原有服务。
- 本地转发仅接受回环地址上的同源请求；上游限 https 接口与本机 http 服务（如 Ollama 的 11434），不支持任意代理目标或局域网访问。
- 密钥仍保存在浏览器 localStorage，调用时经本机服务转发，不在服务端落盘或记入日志。
- 上游收到真实应用标识 `3d-layout/0.1.0` 和稳定会话 ID；清空聊天会更新 ID，CoAgent 每次运行使用自己的 ID。
- Go 面向编码 Agent。3D 布局任务是否可用由服务商决定；连接成功不代表工具调用、图片输入及实际任务均受支持。
- 纯静态部署没有转发接口：请求自动回退浏览器直连，是否可用取决于各厂商 CORS 策略（智谱等不支持，需另配服务端）。浏览器的代理扩展也不一定作用于 Node 本地服务，网络问题需检查服务进程的网络环境。
- 验证：在 `src` 中运行 `pnpm test:llm`、`pnpm test:coagent` 和 `pnpm build`。真实密钥在设置中输入，不写入测试脚本。
