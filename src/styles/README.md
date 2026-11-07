# 界面样式：设计语言「制图台 / ATELIER」

这套界面的比喻是**制图台**：暖色桌面上一张图纸，墨线是边框，图签是标签，朱砂只用来标"当前"。
刻意避开的做法：深色玻璃、大圆角卡片、霓虹高亮、大面积模糊阴影、纯黑纯白。

## 文件分工

| 文件 | 管什么 | 谁在用 |
| --- | --- | --- |
| `tokens.css` | 两套色系、排印、动效、基础控件（按钮/字段/开关/分段/键值行） | 全部 |
| `shell.css` | 应用外壳：顶栏、左右侧栏、视口、历史、浮层、弹窗 | 主应用 |
| `modules.css` | 各插件面板（编辑器 / Agent / API 设置 / 导入导出 / CoAgent） | 主应用 |
| `graph.css` | CoAgent 图视图独立页 | `graph.html` |

模块自己的 `panel.css`（例如 `modules/partition-agent/panel.css`）**只引用变量，不写死色值**。

## 两个色系

`<html data-theme="dark|light">` 决定用哪套，键名 `ui-theme-v1`（localStorage）。

- **暗房**：桌面 `#100f0d` / 纸面 `#1a1815` / 墨色字 `#ece5d7` / 朱砂 `#e1744e`
- **纸面**：桌面 `#e2dccf` / 纸面 `#f7f4ec` / 墨色字 `#1b1a16` / 朱砂 `#b03a20`

结构色（`--paper`、`--paper-2`、`--paper-3`、`--field`、`--rule`、`--rule-2`）在两套里含义一致：
数字越大越"离桌面远"。状态色只有四个：`--sage`（通过）、`--steel`（信息）、`--ochre`（待确认）、`--danger`（失败）。

## 层次怎么来

不靠阴影，靠三样东西：

1. `--bevel` = `inset 0 1px 0`，一层极淡的内高光，纸面像压过一层卡纸；
2. 1px 墨线（`--rule` / `--rule-2`），所有分隔、边框用它；
3. `--shadow-1` 只有 1px，`--shadow-2` 用负扩散（`0 24px 48px -36px`）——只有浮层才真的"浮"起来。

圆角一律 **2–3px**。不做渐变（只有进度条一条）。

## 排印三档

- `--font-display`（Bahnschrift/DIN）：**图签小字**，9px、`letter-spacing: .16em`、全大写，如 `PLUG-INS / 06`、`SCENE`；
- `--font-ui`（Noto Sans SC）：正文，10–12px；
- `--font-mono`（Cascadia Mono）：**读数**，`tabular-nums`，保证数字不抖。

## 控件语汇

| 控件 | 对应的实物 |
| --- | --- |
| `.field` | 仪表铭牌：左边 `SCENE` 标签、右边内容、右上小三角 |
| `.switch` | 机械销钉，不用"开/关"两个字 |
| `.btn-grid` 里的 `.hint` | 键帽 `W / E / R / T / Del` |
| `.modal` / `.agent-task` | 印刷品版心：外层 1px 框 + 内层 1px 细框 |
| `.sheet-head` / `.micro` | 图签：标题 + 英文角标 + 延伸细线 |
| `.viewport::before` | 视口四角裁切记号 |

## 动效

- 缓动统一 `--ease: cubic-bezier(.22,.8,.24,1)`，时长 `--dur-1/2/3` = 110/170/240ms；
- **只动 `transform` 和 `opacity`**：按下 `translateY(1px)`、折叠箭头旋转、呼吸环 `scale+opacity`、进度条 `width`；
- 主题切换走 **View Transitions**（`ui/theme.ts`）：整页交叉淡化一次，不是几百个元素各自动画，3D 视口不受影响；
- 全部在 `prefers-reduced-motion: reduce` 下降级。

## 加新样式时

1. 先找现成变量，别写 `#hex`；
2. 需要新颜色 → 在 `tokens.css` 的两套色系里**同时**加，命名按"结构色 / 状态色"归类；
3. 面板层只写布局与尺寸，颜色一律 `var(--…)`；
4. 动效只碰 `transform` / `opacity`。
