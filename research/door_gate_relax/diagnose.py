"""설정 하나에 대해 프레임별로 CLIP 게이트 통과 후보(측정값 전부)와 확정 인스턴스를 지지한
provider 증거를 출력한다 -- 어떤 오탐이 어떤 게이트/증거로 살아남는지 보기 위함."""

from __future__ import annotations

import sys
from dataclasses import replace

import relax_lib as rl

FEATS = None


def show(cache, cfg, only=None):
    print(f"\n=== {cfg.short()}")
    for fr in cache.frames:
        if only and fr["frame"] not in only:
            continue
        r = rl.run_frame(cache, fr, cfg)
        print(f"[{fr['frame']} {fr['rotation_deg']}] confirmed={r['instances']}")
        for m in fr["_measures"]:
            if rl.gate_pass(m, cfg):
                print(f"   pass box={[round(v) for v in m['box']]} sim8={m['sim_all8']:.4f} sim4={m['sim_generic4']:.4f} "
                      f"feat={cache.feature_names[m['best_feature']]} colorgap={m['color_gap']:+.4f} "
                      f"shape={m['shape_ok']}({m['shape_gap']:+.4f}) ref={m['ref_sim']:.3f} sat={m['sat']:.0f} "
                      f"asp={m['aspect']:.2f}")
        for inst in r["instances"]:
            for d in fr["grounding_dino_by_text_thr"][str(cfg.gdino_text)]:
                if d["score"] >= cfg.gdino_box and rl.iou(d["box_xyxy"], inst["box_xyxy"]) > 0.2:
                    print(f"   gdino {d}")
            for d in fr["yolo_world"]:
                if d["score"] >= cfg.yw_conf and d["label"] == "door" and rl.iou(d["box_xyxy"], inst["box_xyxy"]) > 0.2:
                    print(f"   yw {d}")


if __name__ == "__main__":
    cache = rl.Cache()
    generic = replace(rl.BASELINE, color_gate=False, ref_sim_min=None, sat_min=None)
    show(cache, generic)
    show(cache, replace(generic, feature_set="generic4", target_sim_min=0.20))
    # 실제 문 후보들의 측정값(정답 IoU>=0.5 RPN 후보 전부)
    GT = {"frame_000113.jpg": [139.6, 87.8, 161.4, 144.0], "frame_000132.jpg": [31.9, 87.4, 52.5, 142.3]}
    print("\n=== 정답 문과 겹치는 RPN 후보(IoU>=0.4)")
    for fr in cache.frames:
        if fr["frame"] not in GT:
            continue
        for m in fr["_measures"]:
            v = rl.iou(m["box"], GT[fr["frame"]])
            if v >= 0.4:
                print(f"   {fr['frame']} IoU={v:.2f} box={[round(x) for x in m['box']]} sim8={m['sim_all8']:.4f} "
                      f"sim4={m['sim_generic4']:.4f} colorgap={m['color_gap']:+.4f} shape={m['shape_ok']}({m['shape_gap']:+.4f}) "
                      f"ref={m['ref_sim']:.3f} sat={m['sat']:.0f} asp={m['aspect']:.2f}")
