"""정답 문과 겹치는 RPN 후보 전부의 게이트 측정값과 GroundingDINO/YOLO-World 점수를 출력한다 --
실제 문이 어느 게이트에서 몇 만큼 모자라 떨어지는지 보기 위함."""

from __future__ import annotations

import relax_lib as rl
from gt import GT_BY_SET

cfg = rl.BASELINE
for set_name, gts in GT_BY_SET.items():
    cache = rl.Cache(set_name)
    for fr in cache.frames:
        gt = gts["doors"].get(fr["frame"])
        if gt is None:
            continue
        r = rl.run_frame(cache, fr, cfg)
        print(f"\n[{set_name} {fr['frame']} {fr['rotation_deg']}] GT={gt} baseline confirmed={r['instances']}")
        for m in fr["_measures"]:
            v = rl.iou(m["box"], gt)
            if v < 0.3:
                continue
            fails = []
            if m["sim_all8"] < cfg.target_sim_min: fails.append(f"sim {m['sim_all8']:.4f}<{cfg.target_sim_min}")
            if m["aspect"] < cfg.aspect_min: fails.append(f"asp {m['aspect']:.2f}<{cfg.aspect_min}")
            if m["color_gap"] < 0: fails.append(f"color {m['color_gap']:+.4f}")
            if not m["shape_ok"]: fails.append(f"shape {m['shape_gap']:+.4f}")
            if m["ref_sim"] < cfg.ref_sim_min: fails.append(f"ref {m['ref_sim']:.3f}<{cfg.ref_sim_min}")
            if m["sat"] < cfg.sat_min: fails.append(f"sat {m['sat']:.0f}<{cfg.sat_min}")
            print(f"   RPN IoU={v:.2f} box={[round(x) for x in m['box']]} sim8={m['sim_all8']:.4f} sim4={m['sim_generic4']:.4f} "
                  f"colorgap={m['color_gap']:+.4f} shape={m['shape_gap']:+.4f} ref={m['ref_sim']:.3f} sat={m['sat']:.0f} "
                  f"asp={m['aspect']:.2f}  => {'PASS' if not fails else 'FAIL: ' + ', '.join(fails)}")
        for d in fr["grounding_dino_by_text_thr"]["0.15"]:
            if rl.iou(d["box_xyxy"], gt) >= 0.3:
                print(f"   GDINO IoU={rl.iou(d['box_xyxy'], gt):.2f} {d}")
        for d in fr["yolo_world"]:
            if rl.iou(d["box_xyxy"], gt) >= 0.3:
                print(f"   YW IoU={rl.iou(d['box_xyxy'], gt):.2f} {d}")
