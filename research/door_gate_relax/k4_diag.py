"""K4(추천안)의 변형 조건별 오탐·미탐 원인: 오탐 박스, 놓친 문 후보가 걸린 게이트."""

from dataclasses import replace

import relax_lib as rl
from aug_eval import CONDITIONS, P1
from gt import gt_for

K4 = replace(rl.BASELINE, ref_sim_min=None, target_sim_min=0.25, aspect_min=1.5, sat_min=75.0, color_tol=0.012,
             shape_tol=0.005, **P1)


def fails(m, cfg):
    out = []
    if m["sim_all8"] < cfg.target_sim_min: out.append(f"sim {m['sim_all8']:.4f}")
    if m["aspect"] < cfg.aspect_min: out.append(f"asp {m['aspect']:.2f}")
    if m["color_gap"] < -cfg.color_tol: out.append(f"color {m['color_gap']:+.4f}")
    if m["shape_gap"] < -cfg.shape_tol: out.append(f"shape {m['shape_gap']:+.4f}")
    if m["sat"] < cfg.sat_min: out.append(f"sat {m['sat']:.0f}")
    return out


for cfg_name, cfg in [("K4", K4), ("K4 sim0.24", replace(K4, target_sim_min=0.24))]:
    print(f"\n===== {cfg_name}: {cfg.short()}")
    for cond in CONDITIONS:
        for base in ("rot8", "robot"):
            name = base if cond == "orig" else f"{base}@{cond}"
            cache = rl.Cache(name)
            gts = gt_for(name)
            for fr in cache.frames:
                r = rl.run_frame(cache, fr, cfg)
                gt = gts["doors"].get(fr["frame"])
                amb = gts["ambiguous"].get(fr["frame"])
                hit = False
                for inst in r["instances"]:
                    b = inst["box_xyxy"]
                    if gt and not hit and rl.iou(b, gt) >= 0.5:
                        hit = True
                    elif amb and rl.iou(b, amb) >= 0.3:
                        continue
                    else:
                        print(f"  오탐 {name}/{fr['frame']} {[round(v) for v in b]}")
                if gt and not hit and cfg_name == "K4":
                    cands = [(rl.iou(m["box"], gt), m) for m in fr["_measures"] if rl.iou(m["box"], gt) >= 0.5]
                    gd = max([d["score"] for d in fr["grounding_dino_by_text_thr"]["0.15"]
                              if d["label"].strip() == "door" and rl.iou(d["box_xyxy"], gt) >= 0.5] or [0])
                    desc = "; ".join(f"IoU{i:.2f}:{','.join(fails(m, cfg)) or 'PASS'}" for i, m in cands) or "RPN 후보 없음"
                    print(f"  미탐 {name}/{fr['frame']} GDINO door 최고={gd:.3f} | {desc}")
