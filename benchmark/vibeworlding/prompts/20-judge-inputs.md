# 20 · 判官输入拼装（把论文的 5 条 judge 接到本项目）

论文的 judge 提示词本身不用改（英文原文见 [`00-原文全文.md`](00-原文全文.md) 的 P1–P5），
**要改的是喂给它的材料**：论文喂 `map_json + 5 张固定视角图`，本项目只有 `scene.json` 快照 +
你要自己截的视口图。这一页给出拼装模板。

---

## 1. 材料对照

| 论文里的占位 | 本项目从哪来 | 备注 |
|---|---|---|
| component list / `map_json` | `scene.get_state` 的工具返回，或直接读 `scenes/<id>/scene.json` | 保留 `id / name / ref / transform`，并按组（地形/建筑/植被…）粗分 |
| 初始世界 map | 跑之前的 scene.json | **必须留底**，否则 H3-VR 判不了"改动是否发生" |
| 最终世界 map | 跑完保存的 scene.json | 同上 |
| 5 视图渲染（左右前后俯） | 2–4 张 `viewport.screenshot` | 单视口产品截不出 5 张固定视角；俯视图最有用（能看布局与间距） |
| component whitelist | `assets/model-catalog.json` 的 ref 列表 | 建造任务用；编辑任务可省 |
| 预检结果（height pre-check） | **没有** | 提示词里那段"参考规则预检结果"删掉或写"本次未执行预检" |
| 碰撞结果（H4） | **没有** | 提示词里"H4 独立检测"改成"本次无碰撞检测，请从截图上自行判断穿模" |
| per-turn reasoning + tool calls | 聊天面板的对话记录 / 运行日志 | H3-VR 的"edit hallucination"检测靠它 |

---

## 2. 拼装模板（直接填空后发给判官模型）

### 2.1 H1/H2（高度 + 生态）—— 用 P1（编辑）/ P3（建造）

```text
[system] <粘贴 00-原文全文.md 里 P1 或 P3 的英文全文>

[user]
## Scene
theme: {场景主题，如 snow village / forest / desert camp}
query: {用户的原始指令}
task: {refine | generate}

## Initial component list (only for refine)
{跑之前的 scene.json 精简版：只留 id, name, ref, position}

## Final component list
{跑之后的精简版}

## Views
图1 = 俯视（判断布局/间距/悬空）
图2 = 主视角
（可选 图3 = 另一侧）

## 预检
本次未执行规则预检；H4 碰撞检测不可用，请仅按截图中可见的悬空与明显穿模判断。
```

### 2.2 H3（理解 + 推理 + 澄清）—— 用 P2（编辑）/ P4（建造）

```text
[system] <粘贴 P2 或 P4 全文>

[user]
## Query
{用户指令原文}

## Initial map
{before.json 精简}

## Final map
{after.json 精简}

## Tool calls (in order)
{turn 1: scene.get_state(); turn 2: asset.remove({"assetId":"forest-deck-2-8"}); …}

## Agent final response
{模型的最后一段自然语言总结}

## Views
图1 = 初始（before 截图）  图2 = 最终（after 截图）

## 备注
- 资产库 ref 列表：{catalog 里的 ref/name 摘要}（判断"库里到底有没有"时用）
- 若指令含不可行部分，请按 H3-Response 单独判：模型有没有指出并给替代。
```

### 2.3 H5（检索合理性）—— 用 P5，只用于建造任务

```text
[system] <粘贴 P5 全文>

[user]
## Retrieval intents
1. entity: "雪松"  → recalled: [{ref, name, category, 相似度}]  → used: {ref 或 null}
2. entity: "木屋"  → recalled: [...]  → used: ...
（每个检索意图一行，used 必须是最终场景里真实出现的 ref）
```

---

## 3. 哪类题用哪个判官

| 用例 `subtype` | 需要判的维度 | 判官 |
|---|---|---|
| `asset_level_edit_precise`（verified） | 不用判官 | `tools/score_cases.py` 直接算 |
| `asset_level_edit_fuzzy` | H1/H2 + H3-VU/VR | P1 + P2 |
| `scene_critique` / `scene_guidance` / `scene_restatement` / `complex_description` | H1/H2 + H3-VU/VR（P2 里 VU 的"是否识别出隐含意图"是关键） | P1 + P2 |
| `construction_theme_only` / `theme_elements` / `full_blueprint` | H1/H2 + H3 + H5 | P3 + P4 + P5 |
| `construction_distractor` | H3-Response（P4 里那一段）为主 | P4 |

---

## 4. 三个坑

1. **别把 before 丢了**。H3-VR 的核心判据是"初始→最终的 map diff"，没有 before 就只能判"最终像不像"，会把"什么都没改"判成通过。
2. **判官也会看错图**。论文自己做过盲评校准（κ≈0.54，p.8），所以别把判官分当真理；关键结论用 `score-sheet.md` 人工复核几条。
3. **一次只判一个维度**。把 P1 和 P2 合成一次调用会让模型互相"补偿"（看到意图满足就放过悬空），论文分开就是为避免这个。
