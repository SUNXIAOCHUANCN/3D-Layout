#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
对 gen_cases.py / cases.jsonl 产出的用例做机器判分（verified track），不需要 LLM。

判分逻辑对齐 VibeWorlding A.3.1 的四类结构化判据 + "未授权编辑整条归零"：

  delete_exact   目标对象必须消失
  translate      目标对象最终位置落在期望位置 0.5 m 内（高度不变）
  rotate_yaw     目标对象 yaw 落在期望角 5° 内（模 360）
  add_count      指定 ref 在场景中的新增实例数落在 [min,max] 内（可选）

overEdit="reject"（默认）时，任何未被判据授权的改动 —— 多删、多移、多转、
多增、顺手删了别的树 —— 都会把该条 reward 直接置 0，部分正确不给分。
这正是 VibeWorlding 用来防"过度编辑"的机制（Fig.7b）。

用法：
    # 场景在编辑器里跑完并「保存」后，把 scene.json 复制成 after.json，
    # 再从跑之前的版本留一份 before.json
    python score_cases.py --cases cases.jsonl \
                          --before before.json --after after.json

    # 只跑某一条
    python score_cases.py --cases cases.jsonl --before ... --after ... --id auto-tri-biome-del-1

    # 输出机器可读结果
    python score_cases.py ... --json result.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

EPS_MOVE = 0.02       # 位置变化判定阈值（米）
EPS_ROT = 0.5         # 旋转变化判定阈值（度）


def load(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def index(scene: dict) -> dict[str, dict]:
    return {a["id"]: a for a in scene.get("assets", []) if a.get("id")}


def pos(a: dict) -> list[float]:
    p = a.get("transform", {}).get("position") or [0, 0, 0]
    return [float(p[0]), float(p[1]), float(p[2])]


def yaw(a: dict) -> float:
    r = a.get("transform", {}).get("rotation") or [0, 0, 0]
    return float(r[1])


def dist(a: list[float], b: list[float]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def horiz(a: list[float], b: list[float]) -> float:
    return math.hypot(a[0] - b[0], a[2] - b[2])


def ang_delta(a: float, b: float) -> float:
    """a 到 b 的最短角差，度，范围 [-180, 180]。"""
    d = (b - a + 180.0) % 360.0 - 180.0
    return d


def near(a: list[float], b: list[float], tol: float) -> bool:
    return dist(a, b) <= tol


def same_ref_at(assets: dict[str, dict], ref: str, target: list[float], tol: float):
    """按 ref + 位置兜底匹配（agent 若删后重建导致 id 变化时用）。"""
    for a in assets.values():
        if a.get("ref") == ref and near(pos(a), target, tol):
            return a
    return None


# ---------------------------------------------------------------- 判据

def check_criterion(c: dict, before: dict, after: dict) -> tuple[bool, str]:
    kind = c.get("kind")
    tid = c.get("targetId")

    if kind == "delete_exact":
        if tid not in after:
            return True, "目标对象已不存在"
        return False, "目标对象仍在场景中"

    if kind == "translate":
        tol = float(c.get("tolM", 0.5))
        want = [float(v) for v in c["to"]]
        a = after.get(tid)
        if a is not None:
            d = dist(pos(a), want)
            return (d <= tol, f"落点误差 {d:.2f} m（容差 {tol} m）")
        # id 变了：按 ref 在目标位置找
        ref = (before.get(tid) or {}).get("ref")
        if ref and same_ref_at(after, ref, want, tol) is not None:
            return True, "对象被重建，但同 ref 落在目标位置（id 已变）"
        return False, "目标对象丢失或未落到目标位置"

    if kind == "rotate_yaw":
        tol = float(c.get("tolDeg", 5.0))
        base = float(c.get("fromYaw", yaw(before.get(tid, {})) if tid in before else 0.0))
        delta = float(c.get("deltaDeg", 90.0))
        want = (base + delta) % 360.0
        a = after.get(tid)
        if a is not None:
            d = abs(ang_delta(yaw(a), want))
            return (d <= tol, f"yaw={yaw(a):.1f}°，期望 {want:.1f}°，偏差 {d:.1f}°（容差 {tol}°）")
        return False, "目标对象丢失"

    if kind == "add_count":
        ref = c["ref"]
        lo, hi = int(c.get("min", 1)), int(c.get("max", 10 ** 6))
        n_before = sum(1 for a in before.values() if a.get("ref") == ref)
        n_after = sum(1 for a in after.values() if a.get("ref") == ref)
        n = n_after - n_before
        return (lo <= n <= hi, f"新增 {n} 个（要求 {lo}–{hi}）")

    if kind == "exists":
        return (tid in after, "对象存在" if tid in after else "对象不存在")

    return False, f"未知判据 {kind}"


# ---------------------------------------------------------------- 未授权编辑

def licensed_edits(cases_criteria: list[dict]) -> tuple[set[str], set[str], set[str], bool]:
    """返回 (允许删除的 id, 允许移动的 id, 允许旋转的 id, 是否允许新增任意对象)。"""
    removed, moved, rotated, allow_add = set(), set(), set(), False
    for c in cases_criteria:
        k = c.get("kind")
        if k == "delete_exact":
            removed.add(c["targetId"])
        elif k == "translate":
            moved.add(c["targetId"])
        elif k == "rotate_yaw":
            rotated.add(c["targetId"])
        elif k in ("add_count", "exists"):
            allow_add = allow_add or k == "add_count"
    return removed, moved, rotated, allow_add


def find_residual(before: dict, after: dict, lic: tuple) -> list[str]:
    removed_l, moved_l, rotated_l, allow_add = lic
    problems: list[str] = []

    gone = set(before) - set(after)
    added = set(after) - set(before)
    if added and not allow_add:
        problems.append(f"未授权新增 {len(added)} 个对象：{sorted(added)[:5]}")

    for aid in gone:
        if aid not in removed_l and aid not in moved_l:
            nm = before[aid].get("name") or before[aid].get("ref")
            problems.append(f"未授权删除「{nm}」({aid})")

    for aid, a in after.items():
        b = before.get(aid)
        if b is None:
            continue
        if dist(pos(a), pos(b)) > EPS_MOVE and aid not in moved_l and aid not in removed_l:
            nm = a.get("name") or a.get("ref")
            problems.append(f"未授权移动「{nm}」({aid}) {dist(pos(a), pos(b)):.2f} m")
        if abs(ang_delta(yaw(b), yaw(a))) > EPS_ROT and aid not in rotated_l:
            nm = a.get("name") or a.get("ref")
            problems.append(f"未授权旋转「{nm}」({aid}) {ang_delta(yaw(b), yaw(a)):.1f}°")

    return problems


# ---------------------------------------------------------------- 主流程

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", required=True)
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    ap.add_argument("--id", default=None, help="只判某一条")
    ap.add_argument("--json", default=None, help="把结果写成 JSON")
    ap.add_argument("--allow-over-edit", action="store_true", help="关掉 overEdit 归零（不推荐）")
    args = ap.parse_args()

    before = index(load(Path(args.before)))
    after = index(load(Path(args.after)))

    cases = []
    for line in Path(args.cases).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        cases.append(json.loads(line))
    if args.id:
        cases = [c for c in cases if c.get("id") == args.id]
        if not cases:
            print(f"没有 id={args.id} 的用例", file=sys.stderr)
            return 2

    results = []
    skipped = 0
    print(f"{'用例':<34} {'结果':<6} 说明")
    print("-" * 100)
    for c in cases:
        crit = c.get("criteria", [])
        if not crit:
            # rubric 类用例（模糊编辑、distractor、场景批评…）没有机器判据
            skipped += 1
            print(f"{c.get('id', ''):<34} {'MANUAL':<6} 无机器判据，请用 score-sheet.md 人工评"
                  f"（judge: {','.join(c.get('judges', [])) or '—'}）")
            continue
        oks, notes = [], []
        for k in crit:
            ok, why = check_criterion(k, before, after)
            oks.append(ok)
            notes.append(why)

        residual = []
        if c.get("overEdit", "reject") == "reject" and not args.allow_over_edit:
            residual = find_residual(before, after, licensed_edits(crit))

        passed = all(oks) and not residual
        reward = 1.0 if passed else 0.0
        detail = "；".join(notes)
        if residual:
            detail += "；" + "；".join(residual[:3])

        results.append({
            "id": c.get("id"), "scene": c.get("scene"), "subtype": c.get("subtype"),
            "criteria": [{"kind": k.get("kind"), "ok": ok} for k, ok in zip(crit, oks)],
            "residual": residual, "passed": passed, "reward": reward,
            "detail": detail,
        })
        print(f"{c.get('id', ''):<34} {'PASS' if passed else 'FAIL':<6} {detail}")

    n = len(results)
    p = sum(1 for r in results if r["passed"])
    print("-" * 100)
    if skipped:
        print(f"（跳过 {skipped} 条 rubric 用例：无机器判据，请人工/判官评）")
    if n:
        print(f"合计 {p}/{n} 通过，Pass@1 = {(p / n * 100):.1f}%")
    else:
        print("本批没有可机器判分的用例")

    by_kind: dict[str, list[bool]] = {}
    for c, r in zip(cases, results):
        for k in c.get("criteria", []):
            by_kind.setdefault(k.get("kind", "?"), []).append(r["passed"])
    for k, v in by_kind.items():
        print(f"  {k:<14} {sum(v)}/{len(v)}")

    if args.json:
        Path(args.json).write_text(
            json.dumps({"pass1": p / n if n else 0.0, "n": n, "results": results},
                       ensure_ascii=False, indent=2),
            encoding="utf-8")
        print(f"结果已写入 {args.json}")
    return 0 if p == n else 1


if __name__ == "__main__":
    raise SystemExit(main())
