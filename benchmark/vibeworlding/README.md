# VibeWorlding 测试包（for 3D-Layout）

把 VibeWorlding 论文里的**提示词**与**场景编辑问题**搬到 3D-Layout 上跑的一套现成物料。
不是论文翻译，是**改装件**：坐标、工具名、尺度、视角都换成本项目的约定。

> 论文出处：`VibeWorlding.pdf`（Technical Report，VWE-Bench / VibeWorlding-Gym）。
> 全部原文整理见 [`prompts/00-原文全文.md`](prompts/00-原文全文.md)。

---

## 0. 一句话结论：能直接用的有 3 类，不能直接用的有 1 类

| VibeWorlding 的东西 | 3D-Layout 能用吗 | 怎么用 |
|---|---|---|
| **7 条完整提示词**（2 条 agent + 5 条 judge） | ✅ 改了工具名/坐标就能用 | 见 §2 映射表 |
| **5 个具体场景的原题** | ⚠️ 场景不存在，跑不了原题 | 用 `gen_cases.py` 在现有场景造**同构题** |
| **10 个子类型的问题模板** | ✅ 立刻能跑 | [`cases/cases.jsonl`](cases/cases.jsonl) 已按本项目场景写好 |
| **6 条数据合成提示词**（D1–D6） | ⭕ 不需要 | 本项目已有人工场景/分区，不必反向合成 query |

---

## 1. 三种跑法，按投入从低到高

### 跑法 A · 只跑 verified 自动判分（今天就能出数，不需要 LLM 判官）

```bash
cd benchmark/vibeworlding

# 1) 从任意场景自动出题（删除最近/平移/旋转三类，自带 ground truth）
python tools/gen_cases.py \
  --scene ../../scenes/tri-biome/scene.json \
  --out cases/auto/tri-biome.verified.jsonl --per-kind 3

# 2) 在编辑器里逐条照做（关闭「自动编辑」，看完提案再接受），保存场景

# 3) 把跑之前的 scene.json 存成 before.json、跑完的存成 after.json，判分
python tools/score_cases.py \
  --cases cases/auto/tri-biome.verified.jsonl \
  --before cases/_runs/before.json --after cases/_runs/after.json
```

输出形如：

```
auto-tri-biome-del-1   PASS  目标对象已不存在
auto-tri-biome-mov-2   FAIL  落点误差 10.00 m（容差 0.5 m）
合计 1/2 通过，Pass@1 = 50.0%
```

判分逻辑照抄论文 A.3.1：四类结构化判据 + **未授权编辑整条归零**（多删一棵树 = 0 分，不是部分分）。
项目里已有 `cases/auto/tri-biome.verified.jsonl` 等 3 个场景的现成题库。

### 跑法 B · 跑 app 内的聊天 Agent + 判官打分（考"理解与推理"）

1. 把 [`prompts/10-agent-refine.zh.md`](prompts/10-agent-refine.zh.md) 的正文追加进
   `src/modules/llm-agent/llmChatTransport.ts` 的 `SYSTEM_PROMPT`（这是当前在用的那版）；
   从零建造的会话换 [`prompts/11-agent-generate.zh.md`](prompts/11-agent-generate.zh.md)。
2. 打开对应场景，逐条粘 `cases/cases.jsonl` 里的 `instruction`。
3. 用 [`score-sheet.md`](score-sheet.md) 人工盲评，或把 `prompts/20-judge-inputs.md` 里的
   拼装模板 + 截图丢给另一个模型当判官。

### 跑法 C · 接 CoAgent（planner / executor / judge 三段式）

不建议直接替换：CoAgent 的契约是**结构化任务 + 白名单 criterion**（`region.object_count`、
`region.min_pair_distance_xz`），而 VibeWorlding 的 agent 是**自由 tool-calling**。
只借它的判据设计，见 [`prompts/30-coagent-mapping.md`](prompts/30-coagent-mapping.md)。

---

## 2. 提示词映射表（13 条 → 本项目落点）

| # | VibeWorlding 提示词 | 本项目落点 | 处理 |
|---|---|---|---|
| P1 | 高度+生态 judge（编辑） | 外部判官 | 输入换成 `scene.get_state` + 截图 → [`20-judge-inputs.md`](prompts/20-judge-inputs.md) |
| P2 | 理解+推理 judge（编辑） | 外部判官 | 同上，**这条最值得用** |
| P3 | 高度+生态 judge（建造） | 外部判官 | 同上 |
| P4 | 理解+推理+澄清 judge（建造） | 外部判官 | distractor 检测直接对应 §`cases.jsonl` A6–A9 |
| P5 | 检索合理性 judge（H5） | 外部判官 | 本项目对应 `catalog.search` / `library.search` |
| P6 | Agent 系统提示（refine） | `modules/llm-agent` `SYSTEM_PROMPT` | **已改编** → `10-agent-refine.zh.md` |
| P7 | Agent 系统提示（generate） | 同上（按场景切换） | **已改编** → `11-agent-generate.zh.md` |
| D1 | seed world 批评 → 编辑指令 | 暂不用 | 已有人工场景 |
| D2 | seed world → 建造 query | 暂不用 | 同上 |
| D3 | 资产卡片 → 10 别名 | `catalog.search` 可借思路 | 本项目 `retrievalTerms` 已是同类做法 |
| D4 | 属性翻转 → 负例 | 暂不用 | 检索评估时再说 |
| D5 | 二维打分（实体/属性） | 暂不用 | 同上 |
| D6 | 轨迹反写（SFT） | 暂不用 | |

> 另有 `modules/agent/llmChatTransport.ts` 里的旧版 `SYSTEM_PROMPT`（工具名 `scene_get_state` /
> `asset_adjust_transform` 下划线形式），如果还在用那版，把改编稿里的点号工具名整体换成下划线即可。

---

## 3. 必须知道的 6 个适配点（不处理会直接跑歪）

| # | VibeWorlding | 3D-Layout | 影响 |
|---|---|---|---|
| 1 | **Z 轴向上**，`z >= 0` 贴地 | **Y 轴向上**，`position` 是底面中心，贴地是 `y = 0` | 提示词里所有 `z>=0` 必须改 `y>=0`；yaw 是 `rotation[1]` 不是 `rotation[2]` |
| 2 | 世界 **10×10 m**，坐标范围 `[0,3]` | 真实尺度：tri-biome ±130 m、tundra 1000 m、forest 2500 m | 禁止写死坐标区间，必须先 `scene.get_state` 读包围盒 |
| 3 | 每轮给 **5 张固定视角图**（前/后/左/右/俯） | `viewport.screenshot` **只给当前视口一张** | 判官的"5 视图"要拼；要么截 2–4 张，要么在 CoAgent 用 `camera.capture` |
| 4 | `asset_retrieve` 语义检索 + `asset_add(id)` | `catalog.search` / `library.search` + `asset.add(ref)`，**ref 必须来自模型目录** | 检索合理性（H5）判的是"选了哪个候选"，本项目同样成立 |
| 5 | 每轮后自动重渲染 5 图 | `viewport.screenshot` 需显式调用 | 提示词里必须写"改完必须截图复核"，否则模型不截图 |
| 6 | 有碰撞/悬空检测器（10 m³ / 0.5 m slack） | **没有**（README 路线图里 `validate_layout` 待办） | H1/碰撞只能人工或外部判官判，别假装有自动分 |

附加一条：**对象 id ≠ 名字**。本项目允许重名（`TreeGroup (7)` 出现两次，`森林灌木` 24 个），
所以"删除离 X 最近的 Y"这类题**必须靠 `position` 算距离**——这恰好是 VibeWorlding 想要考的能力，
但提示词里要明确写"名字可能重复，必须用坐标判断"，否则模型会按名字乱选。

---

## 4. 目录

```
benchmark/vibeworlding/
├─ README.md                     ← 本文件
├─ prompts/
│  ├─ 00-原文全文.md             ← 论文 7 条完整提示词 + 6 条数据合成提示词（逐字）
│  ├─ 10-agent-refine.zh.md      ← 【可直接贴】编辑任务系统提示（3D-Layout 版）
│  ├─ 11-agent-generate.zh.md    ← 【可直接贴】从零建造系统提示（3D-Layout 版）
│  ├─ 20-judge-inputs.md         ← 判官输入拼装模板（截图/map/白名单怎么喂）
│  └─ 30-coagent-mapping.md      ← 想接 CoAgent 时的映射与取舍
├─ cases/
│  ├─ cases.md                   ← 人读版题目表（A 立即可跑 / B 论文原题 / C 自动生成）
│  ├─ cases.jsonl                ← 机器可读题目（rubric 判分）
│  └─ auto/*.verified.jsonl      ← 自动生成的 verified 题库（可直接判分）
├─ tools/
│  ├─ gen_cases.py               ← 从 scene.json 自动出"必须算距离"的题
│  └─ score_cases.py             ← before/after 对比判分（含过度编辑归零）
└─ score-sheet.md                ← 人工盲评表（对应论文 A.4 五项判断）
```

---

## 5. 五分钟上手

```bash
cd G:/GraduateDesign/Softwares/3D-Layout/benchmark/vibeworlding

# 出题（每个场景 9 条：3 删除最近 + 3 平移 + 3 旋转）
for s in tri-biome tundra desert; do
  python tools/gen_cases.py --scene ../../scenes/$s/scene.json \
    --out cases/auto/$s.verified.jsonl --per-kind 3
done

# 看题
cat cases/auto/tri-biome.verified.jsonl
```

然后开编辑器 → 关掉「自动编辑」→ 粘一条题 → 接受提案 → 保存 → 判分。

---

## 6. 这套东西测不出什么（诚实说明）

- **测不出论文的 Pass@1 绝对值**：场景、资产库、尺度、视角全不一样，只能测**相对差异**（同一模型不同提示词、不同模型同一提示词）。
- **测不出碰撞/悬空**：本项目没有几何检测器，H1 只能人看截图。
- **测不出检索质量**：本项目的 `catalog.search` 与论文里 4B 嵌入检索器不是一回事，H5 只能判"模型有没有乱用候选"。
- **论文那 5 个原题跑不了**：`现代城市商业街` / `雪地祭坛` / `rock 18 前移 7 m` / `宝箱右侧加树` / `城市场景删车` 都需要先有对应场景；等价做法是用 `gen_cases.py` 造同构题。
