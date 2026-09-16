"""R2b(추천안) 국소 안정성: 문턱 하나씩 넓게 흔들어 rot8 합격(O/X)과 robot tp/fp를 본다."""

from dataclasses import replace

import relax_lib as rl
from sweep2 import evaluate

R2B = replace(rl.BASELINE, color_gate=False, shape_gate=False, ref_sim_min=None, target_sim_min=0.22,
              gdino_box=0.25, gdino_text=0.15, gdino_label_exact=True)
NEIGHBORS = {
    "sat_min": [75.0, 80.0, 85.0, 90.0, 95.0, 100.0, 105.0],
    "target_sim_min": [0.0, 0.20, 0.22, 0.23, 0.24, 0.25],
    "aspect_min": [None, 1.0, 1.2, 1.5, 1.8, 2.0],
    "gdino_box": [0.15, 0.20, 0.25, 0.30, 0.35, 0.38, 0.40],
    "yw_conf": [0.005, 0.02, 0.05, 0.10],
    "gdino_label_exact": [False, True],
}

if __name__ == "__main__":
    caches = {"rot8": rl.Cache("rot8"), "robot": rl.Cache("robot")}
    r = evaluate(caches, R2B)
    print("R2b", R2B.short(), "| rot8", r["rot8"]["exact"], "| robot tp/fp/amb", r["robot"]["tp"], r["robot"]["fp"], r["robot"]["amb"])
    for key, values in NEIGHBORS.items():
        marks = []
        for v in values:
            x = evaluate(caches, replace(R2B, **{key: v}))
            marks.append(f"{v}:{'O' if x['rot8']['exact'] else 'X'}{x['robot']['tp']}/{x['robot']['fp']}")
        print(f"  {key:18} " + "  ".join(marks))
