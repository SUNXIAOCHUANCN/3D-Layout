# 30 · 如果要接 CoAgent（planner / executor / judge）

结论先说：**不要把 VibeWorlding 的 agent 提示词替换进 CoAgent**。两者契约不同，硬换会直接违反
CoAgent 的写权限模型与 verdict 格式。能借的是**判据设计**和**防过度编辑的思路**。

---

## 1. 两套东西的差别

| | VibeWorlding agent（P6/P7） | 3D-Layout CoAgent |
|---|---|---|
| 形态 | 自由 tool-calling，多轮，模型自己决定下一步 | 固定三段：planner 出结构化任务 → executor 执行 → judge 出 Verdict |
| 输出 | 工具调用（无 schema 约束） | planner 输出 `{schemaVersion,kind:"tasks",tasks:[{regionId,objective,criteria,constraints,…}]}` |
| 判据 | 外部 judge（看完再说） | **任务内声明** criterion：`region.object_count` / `region.min_pair_distance_xz` / `visual` |
| 写权限 | 工具白名单 | 区域作用域 + fingerprint + 证据 id |
| 提示词位置 | `modules/llm-agent/llmChatTransport.ts` | `modules/coagent/agents/prompts.ts`（SYSTEM_PLANNER / SYSTEM_EXECUTOR / SYSTEM_JUDGE） |

CoAgent 的 `SYSTEM_PLANNER` 已经写死了"criteria 只能用白名单指标""constraints 只能四种"
"add 必须写 creationTarget"等规则，这些是**代码会校验**的，改提示词没用。

---

## 2. 值得借的三件事

### 2.1 判据形状（对应论文 A.3.1）

论文的四类结构化判据，在 CoAgent 里可以这样落：

| 论文判据 | CoAgent 表达 | 说明 |
|---|---|---|
| `proximity(add)`：新增对象落在期望位置半径内 | `{"kind":"metric","metric":"region.object_count","operator":"gte","value":N,"unit":"count"}` + `visual` | CoAgent 没有"某个对象必须出现在某坐标"的指标，只能用计数 + 视觉 |
| `exact match(delete)` | `region.object_count` 的 `lte` | 同样只能近似 |
| `position delta(translate)` | 无对应指标 | 需要先给 `metrics` 加一个 `region.object_position` 之类 |
| `rotation z(rotate)` | 无对应指标 | 同上 |

如果要真做，建议在 `modules/coagent/services/validation.ts` 里加两个 metric（对象位移、yaw），
而不是塞进提示词——CoAgent 的设计原则（§3.6）就是"规则必须在代码里"。

### 2.2 未授权编辑归零（论文 A.3.1 后半段）

论文的硬校验：`translate` 只允许"原位置删一个 + 目标位置加一个"，`rotate` 不允许任何结构变化，
超出配额整条 reward 置 0。CoAgent 现在靠 `preserve_objects` / `preserve_count` 约束近似表达，
但**没有"配额 diff"这一步**。这条最容易移植：在 `validation.ts` 里对 before/after 做 id 级 diff，
按 criteria 推出允许集合，多余改动直接 fail。`tools/score_cases.py` 里的 `find_residual()` 就是
这个逻辑的独立实现，可以直接搬。

### 2.3 distractor 三类判据（论文 P4 的 H3-Response）

CoAgent 的 `clarify.ts` 只有"问一句"的机制，没有"这条 query 本身不可行"的判定。
论文把它拆成：文本矛盾 / 违反物理 / 库中不存在（靠"反复检索都返回错类别"的行为证据判断）。
后者很适合移植：executor 的检索日志已经记录了"搜了什么、返回了什么"，加一条规则即可
（同一 entity 检索 ≥2 次且 top1 类别都不同 → 判为库缺，走 clarify/unsupported）。

---

## 3. 一句话建议

- **想测"模型理解 + 空间推理"** → 用跑法 B（聊天 Agent + 外部判官），这是 VibeWorlding 的原意。
- **想测"工程可靠性/事务/权限"** → 用 CoAgent，别指望它测出论文那种能力分布。
- **两条路都别改 CoAgent 的 SYSTEM_PLANNER 去"自由发挥"**，那会把代码里的校验和提示词里的规则撕开。
