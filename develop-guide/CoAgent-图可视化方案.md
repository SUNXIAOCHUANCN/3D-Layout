# CoAgent 图可视化（独立页面）设计方案

> 目标：把 LangGraph 的**拓扑**画成一张图，并在**运行时**实时标出"当前执行到哪个节点"。
> 约束：作为**独立页面**；选型要成熟；对现有源码改动最小。
> 依据：2026-10-25 对本仓库 `@langchain/langgraph@1.5.1` 的实测（见 §7 实测记录）。

---

## 1. 结论（先看这张表）

| 决策点 | 选择 | 为什么 |
|---|---|---|
| 拓扑数据来源 | `compiled.getGraphAsync()` | LangGraph 官方 API，**不执行任何节点**；Studio 画的就是同一份结构 |
| 节点边界事件 | 在 `looseGraph()` 门面里包 `addNode` | 现有 14 个 `addNode` **一行不改**；3 个调用点各传一个 opts |
| 运行时通道 | `BroadcastChannel` + `localStorage` 兜底 | 独立页面 = 独立标签页，同源直连；不占服务器、不加接口 |
| 渲染库 | `@xyflow/react` 12.12 + `@dagrejs/dagre` 3.1 | React Flow 是 Langflow / n8n / LangGraph Builder 自身在用的成熟方案；peer `react >= 17`，React 19 兼容 |
| 页面形态 | Vite 第二入口 `src/graph.html` | 不动 `index.html` / `App.tsx`；URL 干净（`/graph.html`）；可与主应用并排开两个窗口 |
| 不做什么 | 不做拖拽编辑、不接 Studio/Agent Server、不改 `RunProgress` | 官方 builder 已归档且不支持并行；Studio 需 Agent Server 且拓扑只读 |

**改动量：现有文件约 +70 行、改 5 行；节点函数体、`run()` 返回逻辑、现有 UI 全部不动。**

---

## 2. 架构

```
┌──────────────────────── 主应用标签页 (index.html) ────────────────────────┐
│  CoAgentPanel / RunProgress（保持原样）                                     │
│                                                                           │
│  mainGraph.run()                                                          │
│    looseGraph(MainState, trace?)  ──┐                                     │
│      addNode('planner', fn)         ├─→ 门面里自动包 traceNode             │
│      ...                            │      ↓                              │
│    compile() ─→ getGraphAsync() ────┼──→ graphFeed.publishTopology()      │
│    (invoke 不变)                     │      ↓                              │
│  createRuntime: recorder.subscribe ──┴──→ graphFeed.onEvents()            │
└───────────────────────────────────────┬───────────────────────────────────┘
                                        │ BroadcastChannel 'coagent-graph-v1'
                                        │ （+ localStorage 快照，供后开/离线）
┌───────────────────────────────────────▼───────────────────────────────────┐
│                    图页面标签页 (graph.html)                                │
│  useGraphFeed()  → 拓扑 + 事件流 + 运行状态                                  │
│  toFlow(topo)    → dagre 分层 → React Flow nodes/edges                     │
│  useNodeStatus() → node.started/finished → idle/running/ok/error           │
│  <GraphPage>     → 画布 + 右侧详情抽屉 + 底部时间轴                          │
└───────────────────────────────────────────────────────────────────────────┘
```

三个要点：

1. **拓扑与执行彻底解耦**：拓扑在 `compile()` 之后、`invoke()` 之前导出，所以"打开图页就能看结构"，不必等一次运行。
2. **事件不新增通道**：节点追踪复用现有 `context.emit → recorder → 订阅`，只是多了 `node.started` / `node.finished` 两个事件类型。
3. **两个标签页只靠浏览器原生通道**：不引入 WebSocket、不加 vite 中间件、生产静态托管也能用。

---

## 3. 数据契约

### 3.1 新增事件（`contracts.ts`）

```ts
// EVENT_TYPES 追加两项
'node.started',
'node.finished',

payload: {
  node: string        // 主图：'planner'；区域子图：'A/execute'
  status?: 'ok' | 'error'   // 仅 finished
  ms?: number               // 仅 finished
  message?: string          // 仅 finished(status=error)
}
```

`regionId` 走 envelope 现有字段，`taskId` 留空。**已确认** `EVENT_TYPES` 只用于推导联合类型，`recorder.append` 不做白名单校验，加类型不破坏 `schemaVersion: 1`。

### 3.2 拓扑（页面侧内部结构）

```ts
type TopoGraph = {
  nodes: Array<{ id: string; name: string }>   // 含 '__start__' / '__end__'
  edges: Array<{ source: string; target: string; conditional?: boolean }>
  meta?: { regions?: string[]; compiledAt?: number }
}
```

就是 `getGraphAsync()` 的 `nodes` / `edges` 精简版（去掉 `data` 里的 Runnable 对象，无法结构化克隆）。

### 3.3 通道消息

```ts
type FeedMsg =
  | { kind: 'topology'; graphId: string; topo: TopoGraph }          // graphId: 'main' | 'region-A'
  | { kind: 'events';   runId: string; events: CoAgentEventEnvelope[] } // 增量
  | { kind: 'run.end';  runId: string; outcome: string }
  | { kind: 'hello' }                                               // 图页 → 主应用：要快照
  | { kind: 'snapshot'; runId: string | null; topologies: ...; events: ...; outcome?: string }
```

- 主应用侧保留 **1 份拓扑表 + 最近 800 条事件** 的环形缓冲，收到 `hello` 直接回 `snapshot`（图页后开也能立刻补全）。
- 同时把 `{runId, topologies, 最近 300 条事件}` 写 `localStorage['coagent.graph.v1.last']`（去重、防抖 500ms），浏览器关了再开也能看上一轮。
- 无 `BroadcastChannel` 时（老 Safari）降级：监听 `storage` 事件，只是延迟略高。

---

## 4. 源码改动清单（逐文件）

### 4.1 需要改的现有文件

| # | 文件 | 位置 | 改什么 | 量 |
|---|---|---|---|---|
| 1 | `modules/coagent/workflow/state.ts` | `looseGraph` (L34-36) | 加第二参数 `TraceOptions`；`addNode` 自动包 `withTrace(name, action)`；`LooseCompiled` 补 `getGraphAsync` 声明 | +45 |
| 2 | `modules/coagent/workflow/mainGraph.ts` | L99、L451 | L99 传 `{ runId, emit: context.emit }`；L451 `compile()` 后 `void publishCompiled('main', compiled)` | +4 |
| 3 | `modules/coagent/workflow/regionGraph.ts` | L97、L128 | 两处 `looseGraph(RegionState)` 传 `{ runId, regionId: region.id, emit: deps.context.emit }` | +2 |
| 4 | `modules/coagent/contracts.ts` | L666-686 | `EVENT_TYPES` 加 2 项 | +2 |
| 5 | `modules/coagent/runtime/createRuntime.ts` | L141 附近 | `const feed = createGraphFeed()`；`recorder.subscribe(() => feed.onEvents(recorder.events()))` | +5 |
| 6 | `vite.config.ts` | L188-191 | `build.rollupOptions.input = { main, graph }` | +3 |
| 7（可选）| `modules/coagent/CoAgentPanel.tsx` | 工具按钮区 | 一个「图视图」按钮 → `window.open('/graph.html')` | +3 |

**不动**：14 个 `addNode` 的节点函数体、`run()` 的 `invoke` 与返回分支、`uiProjection` / `uiStore` / `CoAgentProgress`、`App.tsx`、`index.html`。

### 4.2 新增文件（实际落地版本）

```
src/graph.html                                    ← MPA 入口（深色底 + Controls 深色覆盖）
src/modules/coagent/graph/
  main.tsx                 React 19 挂载点（不加载主应用）
  GraphPage.tsx            画布 + 详情抽屉 + 时间轴 + 跟随/适应窗口
  useGraphFeed.ts          BroadcastChannel 订阅 + hello/snapshot + localStorage 兜底
  derive.ts                事件 → 节点状态/阶段/时间轴文案（纯函数，可单测）
  toFlow.ts                TopologyGraph → dagre 布局 → React Flow nodes/edges
src/modules/coagent/graphFeed.ts                     ← 主应用侧发布端
src/modules/coagent/tests/unit/graphTrace.test.ts    ← 追踪 + 拓扑导出（6 例）
src/modules/coagent/tests/unit/graphDerive.test.ts   ← 投影逻辑（6 例）
```

> 设计稿里的 `useNodeStatus.ts` / `theme.ts` 合并进了 `derive.ts` 与 `GraphPage.tsx`（颜色表就 4 行，不值得单开文件）。

### 4.3 关键实现（骨架）

**① `state.ts` 的门面拦截 —— 全部追踪逻辑就这一个函数**

```ts
export interface TraceOptions {
  runId?: string
  regionId?: string
  emit?: (e: WorkflowEventInput) => void
}

function withTrace(name: string, action: unknown, opts?: TraceOptions) {
  if (!opts?.emit) return action
  const label = opts.regionId ? `${opts.regionId}/${name}` : name
  return async (...args: unknown[]) => {
    const t0 = Date.now()
    const base = { runId: opts.runId!, type: 'node.started' as const, payload: { node: label } }
    opts.emit({ ...base, ...(opts.regionId ? { regionId: opts.regionId } : {}) })
    try {
      const out = await (action as (...a: unknown[]) => unknown)(...args)
      opts.emit({ ...base, type: 'node.finished', payload: { node: label, status: 'ok', ms: Date.now() - t0 } })
      return out
    } catch (e) {
      opts.emit({ ...base, type: 'node.finished',
        payload: { node: label, status: 'error', ms: Date.now() - t0, message: String(e) } })
      throw e   // 失败语义不变：仍由 failureCode/failureStage 上报 rollback
    }
  }
}

export function looseGraph<S>(schema: unknown, trace?: TraceOptions): LooseGraphApi<S> {
  const g = new StateGraph(schema as never) as unknown as LooseGraphApi<S>
  return {
    addNode: (name, action) => { g.addNode(name, withTrace(name, action, trace)); return wrapped },
    addEdge: (...a) => { g.addEdge(...a); return wrapped },
    addConditionalEdges: (...a) => { g.addConditionalEdges(...a); return wrapped },
    compile: () => g.compile(),
  }
}
```

> 只在 `trace.emit` 存在时才包一层；不给 opts 时行为与现在完全一致（单测/假 workflow 不受影响）。

**② 顺带修一个实测出来的坑**：`mainGraph.ts:439` 的两参 `addConditionalEdges` 会让 `getGraphAsync()` 把**所有节点**都当候选画成虚线（实测见 §7.2）。加第三个参数即可：

```ts
graph.addConditionalEdges(
  'validatePlan',
  (s: MainStateType) => (s.plan?.kind === 'tasks' && !s.failureCode ? 'captureBaselines' : '__end__'),
  ['captureBaselines', '__end__'],   // ← 新增
)
```

**③ 页面侧布局**

```ts
const g = new dagre.graphlib.Graph().setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 56 })
// 节点固定 176×44；'__start__'/'__end__' 单独 96×28 胶囊
// 返回 { nodes: Node[], edges: Edge[] }，edge.animated = !!conditional
```

---

## 5. 页面设计

### 5.1 布局

```
┌──────────────────────────────────────────────────────────────┬──────────────┐
│ 顶栏：runId · 状态徽标(运行中/已完成/已回滚) · 节点 5 个并行 · 18.3s │ 详情抽屉      │
├──────────────────────────────────────────────────────────────┤ （点节点才出现）│
│                                                              │ 节点：region-A/ │
│      ○__start__                                              │   execute       │
│          │                                                   │ 开始 +4.2s      │
│      [collectContext ✓ 0.3s]                                 │ 耗时 1.8s       │
│          │                                                   │ payload: …      │
│      [planner ✓ 6.1s]                                        │ ─────────────  │
│          │                                                   │ 关联事件：       │
│      [validatePlan ✓]                                        │ #31 task.started│
│          │                                                   │ #32 tool.finished│
│   ┌──────┼────────┬─────────┐   ← 虚线 = 条件边（可加动画）      │ #33 verdict…    │
│ [region-A ●][region-B ●][region-C ✓]                          │                │
│   │  A/execute  B/judge   C/done                              │                │
│   └──────┴────────┴─────────┘                                 │                │
│      [finalCheck] → [summarizer] → ○__end__                   │                │
├──────────────────────────────────────────────────────────────┴──────────────┤
│ 时间轴  +0.0s collectContext ▸ +0.3s planner ▸ +6.4s validatePlan ▸ …        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 状态映射

| 事件 | 画布表现 |
|---|---|
| `run.started` | 顶栏转「运行中」，清空上一轮 |
| `node.started` | 节点描边脉冲 + 计时器；进入 `activeNodes` 集合 |
| `node.finished(ok)` | 绿色对勾 + 耗时徽标；从集合移除；该节点的出边高亮 |
| `node.finished(error)` | 红色描边 + 悬停显示 message |
| `run.rolled_back` | 按 `payload.stage`（如 `region-A`、`finalCheck`）把对应节点标红，顶栏显示原因 |
| `task.started` / `verdict.ready` / `tool.finished` | 只进时间轴与详情抽屉（已有事件，不额外加工） |

`region-*` 节点额外显示**子步骤徽标**：从 `A/prepare → A/execute → A/judge` 里取当前最新的一个（`A/execute` 这样折叠显示），这样主图一眼能看出"每个区卡在哪一步"。

### 5.3 交互

- 自动跟随（默认开）：`activeNodes` 变化时 `fitView({ nodes: active, padding: 0.4, duration: 300 })`；
- 点击节点 → 右侧抽屉：节点时间、payload、以及**同 regionId 时间窗内的业务事件**（复用 `formatEvent` 口径）；
- 断线提示：未收到 `hello/snapshot` 时显示"等待 CoAgent 运行…"，收到 `run.end` 后显示"上一轮结果"；
- 不做编辑：画布只读（官方 drag-drop builder 已归档，且我们的 `region-*` 节点是运行时按分区生成的，静态画布表达不了）。

---

## 6. 分期与验收

| 期 | 内容 | 工期 | 验收标准 |
|---|---|---|---|
| **P0** | MPA 入口 + `graphFeed` 发布端 + 空页面显示"已连接 / runId / 节点数" | 0.5 天 | 跑一次 CoAgent，图页打印出 `8 + N` 个节点名；换标签页后开仍能收到快照 |
| **P1** | React Flow + dagre 静态图（含 start/end 胶囊、条件边虚线） | 0.5 天 | 节点/边与 `getGraphAsync()` 输出逐个一致；缩放拖拽不卡 |
| **P2** | 运行时高亮：`node.started/finished` + 并行集合 + 耗时 + 失败染色 + 时间轴 | 0.5 天 | 5 区场景下三条分支同时亮、各自子步骤独立推进；kill 中途能看出死在哪 |
| P3（可选） | region 下钻（点区域展开 `prepare→execute→judge` 修正环）、点击看证据截图 | 1 天 | 展开图与 `buildRegionGraph` 结构一致；证据缩略图能显示 |
| P4（可选） | 时间旅行：`MemorySaver` + `getStateHistory` 拖时间轴看每步 state | 0.5 天 | 能回到任意检查点查看 `regionResults`/`verdicts` |

**P0-P2 = 1.5 天**，即可交付"运行时查看进度"的完整闭环。

---

## 7. 实测记录（本方案的事实依据）

### 7.1 静态拓扑不需要运行

对同构图（含 `for` 循环动态 `addNode` 的 `region-A/B/C`）在 `invoke()` **之前**调用 `getGraphAsync()`，返回 11 个节点（含 `__start__` / `__end__`）与完整边集，`drawMermaid()` 直接给出可渲染文本。结论：动态建的节点也能画，只要 `compile()` 之后再导出。

### 7.2 两参条件边会退化成"连到所有节点"

```
validatePlan -.-> collectContext / planner / dispatch / region-A / region-B /
                  region-C / finalCheck / summarizer / __end__
```

因为 router 是函数，静态分析不可能知道返回值。加 `pathMap`（第三个参数，类型 `Record<string, N|END> | (N|END)[]`）后候选就收敛为两条。

### 7.3 各 stream 模式的时机（决定"为什么不用 `updates`"）

| streamMode | 事件形态 | 触发时机 | 能否标"正在执行" |
|---|---|---|---|
| `updates` | `{ nodeName: update }` | 节点**跑完之后** | ❌ |
| `tasks` | 开始 `{id,name,input,triggers,…}`；结束 `{id,name,result,…}` | 开始/结束各一条 | ✅ 判据：有无 `result` |
| `debug` | `type: 'task'` / `'task_result'` | 同上 | ✅ |

实测时间戳（B 节点内部 `setTimeout` 300ms）：`node B start +344ms` ↔ `tasks` 的 start 事件 `+344ms`；`B end +647ms` ↔ 结束事件 `+649ms`。**延迟 <5ms**。

### 7.4 为什么不直接用 `stream` 替代 `invoke`

`streamMode: ['tasks','values']` 的 chunk 是 `["tasks", {...}]` / `["values", {...}]` 元组，最后一个 `values` 就是最终 state，理论上可替代 `invoke` 返回值。但那样要改 `run()` 后半段 40 行（读 `final.plan` / `final.failureCode` 的分支），且**救不了区域子图**——你的 `region-*` 是节点内手动 `sub.invoke()`，对父图不透明，`subgraphs: true` 也不会展开它（那要求 `addNode(name, compiledSubgraph)` 注册原生子图）。

所以：**追踪放在 `looseGraph` 门面里**，一处拦截同时覆盖主图 8 个节点与子图 6 个节点，比换 `stream` 改动更小、粒度更细。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 条件边静态退化（§7.2） | 图上虚线杂乱 | P1 顺手加 `pathMap`（2 行） |
| `region-*` 子图对父图不透明 | 父图只看到 `region-A` 一个大节点 | 子图 builder 也走 `looseGraph`，节点名带区域前缀 `A/execute` |
| 并行时"当前节点"是集合 | 单值 `current` 会来回跳 | 图页用 `activeNodes: Set`，不碰现有 `deriveRunProgress` |
| 新开标签页错过事件 | 图页空白 | `hello → snapshot` + `localStorage` 兜底 |
| `BroadcastChannel` 需同源 | 跨端口/跨 device 不通 | dev/preview 均同源；文档注明"同一浏览器、同一地址" |
| 事件只有节点边界，没有 state | 排查"judge 为什么 fail"不够 | P3 用 evidence id + 业务事件补；P4 才上 checkpointer |
| React Flow 体积（~1.2MB 未压缩） | 只影响图页 | 独立入口天然隔离，主应用 bundle 不变 |

**明确不做**：拖拽建图（官方 `langgraph-builder` 已归档、且不支持并行）、接 LangSmith Studio / Agent Server（需外部 Python 服务且拓扑只读）、替换现有 `RunProgress`（图页是补充而非替代）。

---

## 9. 依赖增量

```jsonc
"dependencies": {
  "@xyflow/react": "^12.12.0",   // peer react >=17，React 19.3 已核对
  "@dagrejs/dagre": "^3.1.2"
}
```

两者都只被 `graph.html` 这个入口 import，主应用 bundle 不受影响（Vite MPA 分别打包）。

---

## 10. 实现状态（2026-10-26）

**P0 / P1 / P2 已落地**（P3 region 下钻、P4 时间旅行未做）。

### 怎么用

```bash
cd src
pnpm dev                 # 主应用 http://localhost:5173/
# 另开一个窗口/显示器：
#   http://localhost:5173/graph.html
```

主应用里点开始跑一轮 CoAgent，图页会自动出现拓扑并逐节点点亮；一轮结束后仍保留（`localStorage` 快照），关掉页面再开也能看上一轮。

### 实测结果

| 项 | 结果 |
|---|---|
| `tsc -b` | 通过（strict + noUnusedLocals） |
| `pnpm test:coagent` | **277 例全通过**（含原有 27 个文件，说明门面改造对既有行为零影响） |
| 新增用例 | `graphTrace` 6 例（追踪/前缀/异常/无 emit/拓扑导出/发布不抛错）、`graphDerive` 6 例（并行/折叠/终态/文案） |
| `pnpm build` | 通过，产物 `dist/index.html` + `dist/graph.html` |
| 产物体积 | 图页 `graph-*.js` 231 kB（gzip 77 kB）+ `graphFeed-*.js` 218 kB（gzip 70 kB，与主应用共享）；主应用 `main-*.js` 2.27 MB 未变 |
| 无头浏览器验证 | CDP 注入一份"假运行"（12 节点 / 14 边 / 3 个并行区）→ 渲染 12 节点 14 边、`region-A · execute`、`region-B · judge` 正确、控制台 0 error（截图：`artifacts/graph-page-demo.png`） |

### 与设计稿的差异

1. `looseGraph` 门面除了包 `addNode`，还加了 `addConditionalEdges` 的第三参 `pathMap`（否则条件边会连到所有节点，见 §7.2）。
2. `withNodeTrace` 只包**函数**节点；非函数（原生子图 `addNode(name, compiledGraph)`）原样透传，避免破坏 `verificationGraph` 的用法。
3. 跟随模式默认**关**：默认给整图全景，需要盯当前节点时再点右上角开关（开启时 `padding: 0.6, maxZoom: 1`，避免并行时把上下文裁掉）。
4. 图页顶栏的"运行中/已完成/已回滚"来自 `run.*` 事件；失败时按 `run.rolled_back.payload.stage` 把对应节点标红（复用已有字段，零额外埋点）。
