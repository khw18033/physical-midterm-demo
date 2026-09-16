"""aug_sweep 결과에서 sim/색 tol/채도 이웃 표(종횡비 1.5, 모양 tol 0.005 고정)."""

import json

from aug_sweep import AXES_AUG
import relax_lib as rl

rows = json.load(open(rl.HERE / "results" / "aug_sweep.json", encoding="utf-8"))


def v(r, k):
    return AXES_AUG[k][r["levels"][k]]


print("sim   colorTol sat | 문검출/44 오탐 rot8합격 | 조건별 문검출/오탐")
for sim in (0.26, 0.25, 0.24):
    for col in (0.008, 0.01, 0.012, 0.015):
        for sat in (85.0, 80.0, 75.0, 70.0):
            m = [r for r in rows if v(r, "target_sim_min") == sim and v(r, "color")[0] == col and v(r, "sat_min") == sat
                 and v(r, "aspect_min") == 1.5 and v(r, "shape_tol") == 0.005]
            if not m:
                print(f"{sim:<5} {col:<8} {sat:<4} | 원본 rot8 불합격")
                continue
            r = m[0]
            per = " ".join(f"{c}:{t}/{f}" for c, (t, f) in r["per"].items())
            print(f"{sim:<5} {col:<8} {sat:<4} | {r['tp']:>2} {r['fp']:>3} {r['rot8_ok']:>3}/11 | {per}")
