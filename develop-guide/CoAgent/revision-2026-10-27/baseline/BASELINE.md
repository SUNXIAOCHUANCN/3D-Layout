# 实施基线记录（采集于 2026-10-27）

本文件记录修订包 [README.md](../README.md) 要求的"实施前基线"：环境、命令、结果、未提交改动范围。**这是实施前的现状快照，不代表任何修订功能已实现。**

## 1. 环境

| 项 | 值 |
| --- | --- |
| 工作目录 | `G:\GraduateDesign\Softwares\3D-Layout\src` |
| Node | v22.14.0 |
| pnpm | 9.13.2 |
| vitest | 5.0.5 |
| vite | 8.3.4 |
| HEAD | `288a222` chore(scene): tri-biome 场景升到 v2（新增 4 个资产）并刷新模型目录 — 2026-10-26 16:40:15 +0800 |

## 2. 命令与结果

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `pnpm test:coagent` | 0 | **28/28 文件通过，298/298 用例通过**，耗时 4.41s | [test-coagent-baseline.log](test-coagent-baseline.log) |
| `pnpm build` | 0 | `tsc -b` + `vite build` 通过，1379 模块，726ms | [build-baseline.log](build-baseline.log) |

**结论：当前不存在既有失败用例。** 后续实施中任何新增失败都可归因于本轮改动，不需要预留"历史失败"豁免额度。

## 3. 测试明细（298 用例）

### 单元测试：19 文件 / 213 用例

| 文件 | 用例 | 文件 | 用例 |
| --- | --- | --- | --- |
| plannerContext | 6 | schemas | 26 |
| scheduler | 5 | modelLoop | 3 |
| tools | 23 | runLog | 4 |
| geometry | 11 | graphDerive | 6 |
| evidence | 8 | planValidation | 19 |
| fakes | 20 | hostLocks | 12 |
| w08Images | 5 | standardizedModels | 2 |
| uiProjection | 9 | graphTrace | 6 |
| modelAdapter | 16 | validation | 17 |
| partition | 15 | | |

### 集成测试：9 文件 / 85 用例

| 文件 | 用例 |
| --- | --- |
| w07-planner | 31 |
| runtimeLifecycle | 10 |
| runController | 9 |
| w05-flow | 9 |
| realCoreTx | 7 |
| workflow-graph | 6 |
| w08-validation | 6 |
| workflow-runner | 4 |
| w08-final | 3 |

## 4. 已确认的"非失败"噪声

实施后对比日志时不要把这些当成回归：

1. `tests/unit/graphTrace.test.ts` 的 `[coagent-graph] 导出图拓扑失败： boom` 是**故意注入**的错误日志，用于验证无通道环境静默通过。
2. PowerShell 会把子进程 stderr 包装成 `NativeCommandError`，属于 `pnpm.ps1` 的显示行为，退出码仍为 0。
3. `vite build` 的 `Some chunks are larger than 500 kB` 警告（`main-*.js` 2270 kB）是既有体积警告，与本次修订无关。
4. vitest 提示 `isolate: false 可提速 ~409ms` 属建议信息。

## 5. 未提交改动基线（必须保留，不得覆盖）

用户已完成的"改动 1：碰撞不默认作为失败理由"。完整补丁留档于 [user-changes.diff](user-changes.diff)（41,886 字节）。

```
 src/modules/coagent/agents/planner.ts              | 19 ++++++--
 src/modules/coagent/agents/prompts.ts              |  9 +++-
 src/modules/coagent/contracts.ts                   |  3 +-
 src/modules/coagent/schemas.ts                     | 11 ++++-
 src/modules/coagent/services/planValidation.ts     | 17 ++++++-
 .../coagent/tests/integration/w07-planner.test.ts  | 41 +++++++++++++++-
 .../tests/integration/w08-validation.test.ts       | 55 ++++++++++++++++++++--
 .../coagent/tests/unit/planValidation.test.ts      | 27 +++++++++++
 src/modules/coagent/tests/unit/schemas.test.ts     |  7 +++
 src/modules/coagent/workflow/mainGraph.ts          |  5 +-
 10 files changed, 178 insertions(+), 16 deletions(-)
```

实测语义（已核对 diff 原文）：

- `Constraint.no_collision` 增加**可选**字段 `basis?: { source: 'user_request'; quote: string }`，旧计划无需补写。
- `schemas.ts` 校验 `basis.source` 只能是 `user_request`，`quote` 必须非空。
- `planValidation.ts` 新增可选参数 `PlanPolicyContext { userRequest }`；仅新生成计划传入，要求 `basis.quote` 出现在**原始用户请求原文**中，禁止引用任务 objective 或编造。
- 该规则只在新计划校验路径生效，执行期事实校验不受影响。

## 6. 对修订包 P0 的意义

文档 [03-实施总计划.md](../03-实施总计划.md) 第 4 节要求"P0 不推翻改动 1，只补配对范围"。核对结果：

| 检查项 | 现状 |
| --- | --- |
| 改动 1 已实现且测试覆盖 | ✅ 上述 10 文件 + 4 个测试文件 |
| `geometry.ts` 仍全量配对 | ✅ 见 `rendering/geometry.ts:644-672`（`objectIds` ∪ `staticObjectIds` 全两两组合） |
| 超过 64 对象静默降级 | ⚠️ 当前返回 `{ status: 'unknown', pairs: [] }`，属"伪报覆盖不足"而非 `clear`，但**没有说明缺了哪些对象**，需要按文档改为显式覆盖不足 |
| 静态×静态排除有测试约束 | ❌ **`tests/unit/geometry.test.ts` 11 个用例中没有一条断言 static×static 被排除**，这是 P0 必须新增的测试缺口 |

## 7. 复现方式

```powershell
cd G:\GraduateDesign\Softwares\3D-Layout\src
pnpm test:coagent
pnpm build
```

浏览器套件（`test:coagent-browser*`、`build:coagent-probe`）**本次未运行**：需要先确认端口与场景依赖，且 [08-测试与交付清单.md](../08-测试与交付清单.md) 第 7 节要求不假设可直接运行。相机与截图点选的浏览器验收留待 P2 阶段单独建立启动方式。
