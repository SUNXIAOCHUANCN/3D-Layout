#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从任意 3D-Layout 的 scene.json 自动生成 "可机器判分（verified）" 的场景编辑用例。

灵感来自 VibeWorlding 的 Verified track（A.3.1）：每条用例只包含一个原子编辑，
并自带 ground-truth 判据，事后用 score_cases.py 对比 before/after 即可判分，不需要 LLM。

用法：
    python gen_cases.py --scene "G:/GraduateDesign/Softwares/3D-Layout/scenes/tri-biome/scene.json" \
                        --out cases.auto.jsonl --per-kind 3

    # 指定地标（可选，生成的 delete_nearest 会围绕它）
    python gen_cases.py --scene ... --anchor "森林木栈道"

生成的三类用例：
  delete_nearest  删除离 <锚点> 最近的 <同名资产>   —— 考"必须算距离，不能靠名字"（同 VibeWorlding Case B）
  translate       把 <对象> 沿 +X 方向平移 5 米     —— 考方向/坐标系（同 Fig.7a 的失败模式）
  rotate_yaw      把 <对象> 绕竖直轴旋转 90°        —— 考 yaw 与旋转方向

注意：3D-Layout 约定单位为米、+Y 向上、欧拉角 XYZ 角度制、模型原点在底面中心。
本脚本只读取 position / rotation / ref / name / id，不依赖模型尺寸。
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path


def load_scene(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def horizontal_dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[2] - b[2])


def short_name(asset: dict) -> str:
    """去掉 ' (3)' 这类重复后缀，用于生成自然的指令措辞。"""
    name = (asset.get("name") or "").strip()
    if not name:
        name = Path(asset.get("ref", "object")).name
    if name.endswith(")") and " (" in name:
        name = name.rsplit(" (", 1)[0]
    return name


# 构件类 ref（木板/栅栏/瓦片…）：删一个"栈道板"语义上说不通，出题时跳过
PART_WORDS = ("tile", "plank", "pole", "pier", "fence", "rail", "deck", "bridge",
              "road", "street", "path", "stair", "step", "ladder", "pipe")


def is_part(ref: str) -> bool:
    low = ref.lower()
    return any(w in low for w in PART_WORDS)


# 地形/水域类：旋转或平移它们没有物理意义，出题时跳过
TERRAIN_WORDS = ("山", "崖", "脊", "地形", "海", "湖", "河", "沙丘", "天空",
                 "cliff", "ridge", "terrain", "water", "sea", "dune", "hill", "sky")


def is_terrain(a: dict) -> bool:
    text = (short_name(a) + " " + a.get("ref", "")).lower()
    return any(w.lower() in text for w in TERRAIN_WORDS)


def name_counts(assets) -> dict[str, int]:
    counts: dict[str, int] = {}
    for a in assets:
        n = short_name(a)
        counts[n] = counts.get(n, 0) + 1
    return counts


def where(asset: dict, pos: list, ncount: dict[str, int]) -> str:
    """生成指代表达：名字唯一就只说名字，重名则补一个坐标提示，避免模型只能靠猜。"""
    name = short_name(asset)
    if ncount.get(name, 0) == 1:
        return f"「{name}」"
    return f"位于 x={pos[0]:.1f}、z={pos[2]:.1f} 附近的「{name}」"


def pick_delete_nearest(assets, used, rng, want_anchor: str | None, ncount: dict[str, int]):
    """挑两个同 ref 的实例 + 一个唯一命名的锚点，返回一条 delete_nearest 用例或 None。"""
    by_ref: dict[str, list[dict]] = {}
    for a in assets:
        by_ref.setdefault(a["ref"], []).append(a)

    # 候选组：同 ref、2~8 个实例（多了就是"一片"，指代不清）、两者水平距离 3~60 m
    groups = []
    for ref, items in by_ref.items():
        if not (2 <= len(items) <= 8) or is_part(ref):
            continue
        for i in range(len(items)):
            if items[i]["id"] in used:
                continue
            for j in range(i + 1, len(items)):
                if items[j]["id"] in used:
                    continue
                d = horizontal_dist(items[i]["transform"]["position"], items[j]["transform"]["position"])
                if 3.0 <= d <= 60.0:
                    groups.append((items[i], items[j]))
    rng.shuffle(groups)

    for a, b in groups:
        mid = [
            (a["transform"]["position"][0] + b["transform"]["position"][0]) / 2,
            0.0,
            (a["transform"]["position"][2] + b["transform"]["position"][2]) / 2,
        ]
        # 锚点：离两点中点最近、名字唯一（指代明确）、且与候选不同名的第三条资产
        anchors = []
        for c in assets:
            if c["id"] in (a["id"], b["id"]):
                continue
            if short_name(c) == short_name(a):
                continue
            if ncount.get(short_name(c), 0) != 1 or is_part(c["ref"]):
                continue
            d = horizontal_dist(c["transform"]["position"], mid)
            if d <= 40.0:
                anchors.append((d, c))
        if not anchors:
            continue
        if want_anchor:
            anchors = [x for x in anchors if want_anchor in short_name(x[1])] or []
            if not anchors:
                continue
        anchors.sort(key=lambda x: x[0])
        anchor = anchors[0][1]

        pos_anchor = anchor["transform"]["position"]
        d1 = horizontal_dist(a["transform"]["position"], pos_anchor)
        d2 = horizontal_dist(b["transform"]["position"], pos_anchor)
        near, far = (a, b) if d1 <= d2 else (b, a)
        dn, df = min(d1, d2), max(d1, d2)
        margin = df - dn
        # 余量太小则不是"必须算距离"，而是运气题
        if margin < 1.5:
            continue
        if near["id"] in used or far["id"] in used or anchor["id"] in used:
            continue
        return near, far, anchor, dn, df, margin
    return None


def build(scene_path: Path, per_kind: int, seed: int, want_anchor: str | None):
    scene = load_scene(scene_path)
    assets = [a for a in scene.get("assets", []) if a.get("transform", {}).get("position")]
    scene_id = scene.get("meta", {}).get("id") or scene_path.parent.name
    rng = random.Random(seed)
    ncount = name_counts(assets)

    cases = []
    used: set[str] = set()

    # ---------- delete_nearest ----------
    made = 0
    for _ in range(per_kind * 40):
        if made >= per_kind:
            break
        got = pick_delete_nearest(assets, used, rng, want_anchor, ncount)
        if not got:
            break
        near, far, anchor, dn, df, margin = got
        used.update({near["id"], far["id"], anchor["id"]})
        name = short_name(near)
        anchor_name = short_name(anchor)
        cases.append({
            "id": f"auto-{scene_id}-del-{made + 1}",
            "scene": scene_id,
            "family": "refinement",
            "subtype": "asset_level_edit_precise",
            "mode": "verified",
            "instruction": f"删除离「{anchor_name}」最近的那一个「{name}」（只删这一个，其余都不要动）",
            "criteria": [{"kind": "delete_exact", "targetId": near["id"]}],
            "overEdit": "reject",
            "meta": {
                "candidateIds": [near["id"], far["id"]],
                "anchorId": anchor["id"],
                "distNear": round(dn, 3),
                "distFar": round(df, 3),
                "marginM": round(margin, 3),
            },
        })
        made += 1

    # ---------- translate ----------
    def scalable(a) -> bool:
        sc = a["transform"].get("scale") or [1, 1, 1]
        return max(abs(v) for v in sc) <= 20.0

    movable = [
        a for a in assets
        if a["id"] not in used
        and scalable(a)
        and not any(k in a["ref"].lower() for k in ("water", "scene", "dunes", "terrain", "main-", "sky"))
        and not is_part(a["ref"])
        and not is_terrain(a)
    ]
    # 名字唯一的优先；重名的靠"位置描述"补足指代
    movable.sort(key=lambda a: (ncount.get(short_name(a), 0) != 1, rng.random()))
    made = 0
    for a in movable:
        if made >= per_kind:
            break
        p = a["transform"]["position"]
        target = [p[0] + 5.0, p[1], p[2]]
        used.add(a["id"])
        hint = where(a, p, ncount)
        cases.append({
            "id": f"auto-{scene_id}-mov-{made + 1}",
            "scene": scene_id,
            "family": "refinement",
            "subtype": "asset_level_edit_precise",
            "mode": "verified",
            "instruction": f"把{hint}沿 +X 方向平移 5 米，高度和朝向保持不变（只动这一个）",
            "criteria": [{"kind": "translate", "targetId": a["id"],
                          "from": [round(v, 4) for v in p], "to": [round(v, 4) for v in target],
                          "tolM": 0.5}],
            "overEdit": "reject",
            "meta": {"fromRef": a["ref"]},
        })
        made += 1

    # ---------- rotate_yaw ----------
    rotatable = [
        a for a in assets
        if a["id"] not in used
        and scalable(a)
        and not any(k in a["ref"].lower() for k in ("water", "scene", "dunes", "terrain", "main-", "sky"))
        and not is_part(a["ref"])
        and not is_terrain(a)
    ]
    rotatable.sort(key=lambda a: (ncount.get(short_name(a), 0) != 1, rng.random()))
    made = 0
    for a in rotatable:
        if made >= per_kind:
            break
        rot = a["transform"].get("rotation") or [0, 0, 0]
        p = a["transform"]["position"]
        used.add(a["id"])
        hint = where(a, p, ncount)
        cases.append({
            "id": f"auto-{scene_id}-rot-{made + 1}",
            "scene": scene_id,
            "family": "refinement",
            "subtype": "asset_level_edit_precise",
            "mode": "verified",
            "instruction": f"把{hint}绕竖直轴（Y 轴）旋转 +90 度（右手法则；从上往下看是逆时针），位置不变（只动这一个）",
            "criteria": [{"kind": "rotate_yaw", "targetId": a["id"],
                          "fromYaw": round(float(rot[1]), 3), "deltaDeg": 90.0, "tolDeg": 5.0}],
            "overEdit": "reject",
            "meta": {"fromRef": a["ref"]},
        })
        made += 1

    return cases


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True, help="scenes/<id>/scene.json")
    ap.add_argument("--out", required=True, help="输出 .jsonl 路径")
    ap.add_argument("--per-kind", type=int, default=3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--anchor", default=None, help="可选：delete_nearest 用例围绕的名字片段")
    args = ap.parse_args()

    scene_path = Path(args.scene)
    if not scene_path.is_file():
        print(f"找不到场景文件：{scene_path}", file=sys.stderr)
        return 2

    cases = build(scene_path, args.per_kind, args.seed, args.anchor)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    kinds = {}
    for c in cases:
        k = c["criteria"][0]["kind"]
        kinds[k] = kinds.get(k, 0) + 1
    print(f"生成 {len(cases)} 条 -> {out}")
    print("分类：", kinds)
    for c in cases:
        print(f"  [{c['id']}] {c['instruction']}")
        if c["criteria"][0]["kind"] == "delete_nearest" or "marginM" in c.get("meta", {}):
            print(f"      距离 {c['meta']['distNear']} vs {c['meta']['distFar']} m，余量 {c['meta']['marginM']} m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
