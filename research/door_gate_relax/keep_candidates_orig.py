"""aug_eval의 후보들을 원본 프레임에서 상세 확인 + 국소 안정성(게이트 유지안 K1/K2 기준)."""

from dataclasses import replace

import relax_lib as rl
from aug_eval import CANDIDATES
from gt import GT_BY_SET
from sweep2 import evaluate

caches = {"rot8": rl.Cache("rot8"), "robot": rl.Cache("robot")}
for name, cfg in CANDIDATES.items():
    res = evaluate(caches, cfg)
    print(f"\n### {name}: rot8 exact={res['rot8']['exact']} robot tp/fp={res['robot']['tp']}/{res['robot']['fp']}")
    for s in ("rot8", "robot"):
        for f in res[s]["frames"]:
            gt = GT_BY_SET[s]["doors"].get(f["frame"])
            for inst in f["instances"]:
                print(f"   {s}/{f['frame']} {[round(v) for v in inst['box_xyxy']]} "
                      f"IoU={rl.iou(inst['box_xyxy'], gt) if gt else 0:.2f} w={inst['box_xyxy'][2] - inst['box_xyxy'][0]:.1f}px")

NEI = {
    "target_sim_min": [0.26, 0.25, 0.24, 0.23, 0.22, 0.20],
    "aspect_min": [1.5, 1.4, 1.3, 1.2, 1.1, 1.0],
    "sat_min": [85.0, 80.0, 75.0, 70.0, 65.0, 60.0],
    "color_tol": [0.0, 0.005, 0.008, 0.01, 0.012, 0.015, 0.02],
    "shape_tol": [0.0, 0.002, 0.005, 0.01],
}
for name in ("K1 게이트 유지·기준 완화", "K2 K1 + door 전용 GDINO"):
    base = CANDIDATES[name]
    print(f"\n안정성 [{name}] (O=rot8 합격, robot tp/fp)")
    for key, values in NEI.items():
        marks = []
        for v in values:
            x = evaluate(caches, replace(base, **{key: v}))
            marks.append(f"{v}:{'O' if x['rot8']['exact'] else 'X'}{x['robot']['tp']}/{x['robot']['fp']}")
        print(f"  {key:15} " + "  ".join(marks))
