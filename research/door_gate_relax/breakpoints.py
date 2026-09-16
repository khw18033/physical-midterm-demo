"""게이트 유지 + 기준 완화(P1 provider)에서 각 축을 어디까지 풀면 깨지나(안전 여유) +
로봇 오탐을 만드는 완화가 무엇인지 + 정답 문 후보의 색 순위."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import replace

import relax_lib as rl
from gt import GT_BY_SET
from sweep2 import RESULTS, evaluate
from sweep_keep import AXES, KEEP_BASE, PROVIDERS

caches = {"rot8": rl.Cache("rot8"), "robot": rl.Cache("robot")}

print("== 정답 문 후보(IoU>=0.5)의 색 판정")
for set_name, cache in caches.items():
    for fr in cache.frames:
        gt = GT_BY_SET[set_name]["doors"].get(fr["frame"])
        if gt is None:
            continue
        rl.run_frame(cache, fr, KEEP_BASE)
        for m in fr["_measures"]:
            if rl.iou(m["box"], gt) >= 0.4:
                cs = fr["_color_sim"][fr["_measures"].index(m)]
                order = sorted(zip(rl.COLOR_PROMPTS, cs), key=lambda t: -t[1])
                print(f"  {set_name}/{fr['frame']} IoU={rl.iou(m['box'], gt):.2f} rank={m['color_rank'] + 1} gap={m['color_gap']:+.4f} "
                      f"sat={m['sat']:.0f} sim8={m['sim_all8']:.4f} asp={m['aspect']:.2f} shape_gap={m['shape_gap']:+.4f} | "
                      + ", ".join(f"{p.split()[2]}={v:.4f}" for p, v in order[:4]))

rows = json.load(open(RESULTS / "keep_gates.json", encoding="utf-8"))
p1 = [r for r in rows if r["provider"] == "P1"]
fp = [r for r in p1 if r["robot"]["fp"] > 0]
print(f"\n== P1 로봇 오탐 발생 {len(fp)}개 설정의 축별 값 분포 (전체 대비)")
for n in AXES:
    c_fp = Counter(str(AXES[n][r["levels"][n]]) for r in fp)
    c_all = Counter(str(AXES[n][r["levels"][n]]) for r in p1)
    print(f"  {n:15} " + "  ".join(f"{v}:{c_fp[v]}/{c_all[v]}" for v in (str(x) for x in AXES[n])))

# 어느 오탐인지 대표 1개 상세
worst = min(fp, key=lambda r: sum(r["levels"].values()))
cfg = rl.Config(**worst["config"])
res = evaluate(caches, cfg)
print(f"\n  가장 덜 푼 오탐 설정: {cfg.short()}")
for f in res["robot"]["frames"]:
    if f["instances"]:
        print("    ", f["frame"], f["instances"])

print("\n== 초광역 단독 완화(P1, 다른 축은 현재값): O=rot8 합격, 뒤=robot tp/fp")
WIDE = {
    "target_sim_min": [0.20, 0.18, 0.15, 0.10, 0.0],
    "aspect_min": [1.0, 0.8, 0.6, 0.4, 0.0],
    "sat_min": [50.0, 40.0, 30.0, 20.0, 10.0, 0.0],
    "color_tol": [0.02, 0.03, 0.05, 1.0],
    "shape_tol": [0.01, 0.02, 0.05, 1.0],
}
P1BASE = replace(KEEP_BASE, **PROVIDERS["P1"])
for key, values in WIDE.items():
    marks = []
    for v in values:
        x = evaluate(caches, replace(P1BASE, **{key: v}))
        marks.append(f"{v}:{'O' if x['rot8']['exact'] else 'X'}{x['robot']['tp']}/{x['robot']['fp']}")
    print(f"  {key:15} " + "  ".join(marks))
