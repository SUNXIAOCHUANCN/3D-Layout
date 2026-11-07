# 题库说明（cases）

三档题，按"能不能立刻跑"分。

- **A 档**：现有场景直接能跑，考理解 / 推理 / 澄清，用判官或人工打分（`mode: rubric`）。
- **B 档**：VibeWorlding 论文原题，**场景不存在，跑不了原题**；留作对照，真正的替代是 A 档 + C 档。
- **C 档**：`tools/gen_cases.py` 从任意 `scene.json` 自动生成，自带 ground truth，**可机器判分**。

机器可读版：[`cases.jsonl`](cases.jsonl)（20 条）。自动题库：`cases/auto/<scene>.verified.jsonl`（当前 tri-biome 9 / tundra 7 / desert 9 / forest 9 条）。

---

## A 档 · 立即可跑（12 条）

| id | 场景 | 子类型 | 指令 | 考什么 | 判官 |
|---|---|---|---|---|---|
| `a1-fuzzy-tidy` | tri-biome | fuzzy | 森林里那一片树看着有点乱，帮我稍微整理一下（雪村和沙漠那边不要动） | 模糊指令下改动幅度是否克制；有没有越界改别的区块 | P1+P2 |
| `a2-critique-empty` | desert | critique | 这个场景看起来太空了，想办法让它充实一点 | 能不能把"空"翻译成具体可执行的改动 | P1+P2 |
| `a3-guidance-lively` | tundra | guidance | 让这个场景更有生气一些 | 方向性引导 vs 具体操作 | P1+P2 |
| `a4-restatement` | tundra | restatement | 我希望整体看起来像一个安静的雪村清晨 | 复述终态、自己反推操作 | P1+P2 |
| `a5-complex` | tri-biome | complex | 把沙漠这一侧改成一个小型补给站：两顶帐篷、一圈木栅栏、两个木箱；森林的栈道和雪村都不要动 | 多意图分解 + 三个数量都对 + 零越界 | P1+P2 |
| `a6-distractor-missing` | tundra | distractor | 在雪地里加一只恐龙 | 库缺识别 + 替代说明 | P4 |
| `a7-distractor-physics` | tri-biome | distractor | 在湖面上方悬空建一栋房子 | 违反物理 → 指出并给替代 | P4 |
| `a8-distractor-contradiction` | tri-biome | distractor | 做一个极其安静的热闹夜市 | 自相矛盾 → 二选一或追问 | P4 |
| `a9-distractor-vague` | tri-biome | distractor | 随便弄点东西 | 信息不足 → 追问 | P4 |
| `a10-retrieval-gap` | forest | theme only | 在森林里加几棵樱花树 | 检索两轮无果后是否停下说明（论文 P7 约束 3） | P4+P5 |
| `a11-ambiguity` | tri-biome | fuzzy | 把那个木桶挪一下 | 重名/指代不清 → 应先追问 | P2 |
| `a12-overedit-trap` | tri-biome | precise | 在雪村水井旁边加一个木桶（别的地方都不要动） | 只加不改；专抓 Fig.7b 那种"顺手删了别的" | P1+P2 |

> `a12` 也可以改成机器判分：把 `criteria` 换成 `{"kind":"add_count","ref":"models/<木桶的 ref>","min":1,"max":1}` 即可，
> 但需要先确认模型目录里木桶的 ref。

## B 档 · 论文原题（8 条，`needs_scene: true`）

| id | 出处 | 指令 | 缺什么场景 |
|---|---|---|---|
| `b1-paper-caseA` | A.1.1 / p.17 | 现代城市商业街（英文全文，四段式：中央沥青路 / 一侧两层商铺挂红灯笼 / 对面高楼 / 远端电子广告柱） | 城市场景 |
| `b2-paper-caseB` | A.1.2 / p.21 | `Scene theme: snow` + `delete the one statue closest to the altar` | 雪地祭坛 + 两座同款雕像 |
| `b3-paper-rock-forward` | Fig.7a / p.12 | 把 rock 18 向前移动 7 米 | 含 rock 18 的雪地场景 |
| `b4-paper-tree-chest` | Fig.7b / p.12 | `add tree 20 to the right of the chest` | 含宝箱与大树的营地 |
| `b5-paper-cli-urban` | Fig.8 / p.13 | 把路中间那辆车删掉，再删掉那两栋绿色建筑 | 城市街道（车 + 绿色建筑） |
| `b6-paper-theme-only` | 3.3 / p.5 | 一座阴森的荒原神庙 | 不需要（任意空场景可跑，属建造） |
| `b7-paper-tidy-trees` | 3.3 / p.6 | 把树整理一下 | 不需要（forest 可跑） |
| `b8-paper-lively` | 3.3 / p.6 | 让场景更有生气一点 | 不需要（tundra 可跑，与 a3 是措辞变体） |

**为什么不建议为了 b1–b5 去搭场景**：搭一个城市/祭坛场景的成本 ≫ 收益，而这几条真正考的能力
（"必须算距离的指代""只删一个""只加不删"）用 C 档在现有场景上就能等价考到，且自带 GT。

## C 档 · 自动生成（可判分）

```bash
python tools/gen_cases.py --scene ../../scenes/tundra/scene.json \
  --out cases/auto/tundra.verified.jsonl --per-kind 3
```

生成的题长这样（真实输出）：

```
删除离「雪村水井」最近的那一个「雪村木屋·西二排」（只删这一个，其余都不要动）
把「雪村篝火」沿 +X 方向平移 5 米，高度和朝向保持不变（只动这一个）
把「雪村钟楼」绕竖直轴（Y 轴）旋转 +90 度（右手法则；从上往下看是逆时针），位置不变（只动这一个）
```

每条都带 `criteria`（目标 id、期望位置/角度、容差）和 `meta`（候选对、两段距离、余量），
判分用：

```bash
python tools/score_cases.py --cases cases/auto/tundra.verified.jsonl \
  --before run/before.json --after run/after.json
```

退出码：全通过 = 0，有未通过 = 1（方便脚本判断）。`mode: rubric` 的题会打印 `MANUAL` 并跳过。

---

## 出题时的三条经验（踩过的坑）

1. **必须保证"最近"有足够余量**：`gen_cases.py` 默认要求两个候选到锚点的距离差 ≥ 1.5 m，
   否则模型蒙对也算对。论文 Case B 的余量只有 0.29 m，是刻意做难的，日常测试别学。
2. **目标名字要唯一**：本项目大量重名（`森林灌木` 24 个），指令里出现重名 = 模型只能靠猜。
   生成器已经强制"锚点与被移动/旋转的目标名字唯一"，删除题则刻意用同款实例（这才是考点）。
3. **别出"旋转地形/平移海面"这种题**：几何上可判，但物理上讲不通，模型会合理地反问，
   结果测的是它的谨慎而不是能力。生成器已过滤地形/构件类 ref。
