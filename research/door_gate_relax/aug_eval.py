"""조명·각도 변형 프레임에서 후보 설정 비교.

지표(조건 11개 = 원본 + 변형 10개, 세트 2개):
  rot8 합격 수(/11)  : 해당 조건에서 rot8이 113/132에만 문(각 1개, IoU>=0.5)
  문 검출(/44)       : 조건마다 rot8 2장 + robot 2장
  오탐(개)           : 문이 아닌 곳에 확정된 인스턴스(robot 애매 구조물 제외)
  box IoU 평균       : 맞게 잡은 문 박스와 정답의 IoU(거리 추정이 박스 폭을 쓰므로 박스가 부풀면 안 됨)
"""

from __future__ import annotations

import json
import statistics
from dataclasses import replace

import relax_lib as rl
from aug import AUGS
from gt import gt_for

B = rl.BASELINE
P0 = dict(gdino_box=0.15, gdino_text=0.15, gdino_label_exact=False)
P1 = dict(gdino_box=0.25, gdino_text=0.15, gdino_label_exact=True)
CANDIDATES = {
    "BASE 현재 운영값": B,
    "K0 참조이미지만 제외": replace(B, ref_sim_min=None),
    "K1 게이트 유지·기준 완화": replace(B, ref_sim_min=None, target_sim_min=0.24, aspect_min=1.3, sat_min=75.0,
                                   color_tol=0.012, shape_tol=0.005, **P0),
    "K1b K1인데 sim 0.26 유지(provider 현재값)": replace(B, ref_sim_min=None, target_sim_min=0.26, aspect_min=1.3,
                                                   sat_min=75.0, color_tol=0.012, shape_tol=0.005, **P0),
    "K2 K1 + door 전용 GDINO": replace(B, ref_sim_min=None, target_sim_min=0.24, aspect_min=1.3, sat_min=75.0,
                                   color_tol=0.012, shape_tol=0.005, **P1),
    "K2a K2인데 종횡비 1.5 유지": replace(B, ref_sim_min=None, target_sim_min=0.24, aspect_min=1.5, sat_min=75.0,
                                   color_tol=0.012, shape_tol=0.005, **P1),
    "K4 추천: K2a인데 sim 0.25": replace(B, ref_sim_min=None, target_sim_min=0.25, aspect_min=1.5, sat_min=75.0,
                                    color_tol=0.012, shape_tol=0.005, **P1),
    "K3 더 완화 + door 전용 GDINO": replace(B, ref_sim_min=None, target_sim_min=0.22, aspect_min=1.2, sat_min=65.0,
                                     color_tol=0.012, shape_tol=0.01, **P1),
    "R2b 색·모양·참조 끔(앞 실험)": replace(B, color_gate=False, shape_gate=False, ref_sim_min=None, target_sim_min=0.22,
                                   **P1),
}
CONDITIONS = ["orig"] + list(AUGS)


def eval_set(cache, cfg, gts):
    tp = fp = 0
    exact = True
    ious, missed = [], []
    for fr in cache.frames:
        r = rl.run_frame(cache, fr, cfg)
        gt = gts["doors"].get(fr["frame"])
        amb = gts["ambiguous"].get(fr["frame"])
        hit = False
        for inst in r["instances"]:
            b = inst["box_xyxy"]
            if gt is not None and not hit and rl.iou(b, gt) >= 0.5:
                hit = True
                ious.append(rl.iou(b, gt))
            elif amb is not None and rl.iou(b, amb) >= 0.3:
                pass
            else:
                fp += 1
        if gt is not None:
            tp += int(hit)
            if not hit:
                missed.append(fr["frame"][6:12])
            exact &= hit and len(r["instances"]) == 1
        else:
            exact &= len(r["instances"]) == 0
    return {"exact": exact, "tp": tp, "fp": fp, "ious": ious, "missed": missed}


def main():
    caches = {}
    for cond in CONDITIONS:
        for base in ("rot8", "robot"):
            name = base if cond == "orig" else f"{base}@{cond}"
            caches[name] = rl.Cache(name)
    summary = {}
    for cname, cfg in CANDIDATES.items():
        rot8_ok = tp = fp = 0
        ious, detail = [], {}
        for cond in CONDITIONS:
            row = {}
            for base in ("rot8", "robot"):
                name = base if cond == "orig" else f"{base}@{cond}"
                res = eval_set(caches[name], cfg, gt_for(name))
                tp += res["tp"]
                fp += res["fp"]
                ious += res["ious"]
                row[base] = res
            rot8_ok += int(row["rot8"]["exact"])
            detail[cond] = row
        summary[cname] = {"config": cfg.short(), "rot8_exact": rot8_ok, "door_tp": tp, "fp": fp,
                          "mean_iou": round(statistics.mean(ious), 3) if ious else None, "detail": detail}
        print(f"\n### {cname}\n   {cfg.short()}\n   rot8 합격 {rot8_ok}/{len(CONDITIONS)} | 문 검출 {tp}/{4 * len(CONDITIONS)} | "
              f"오탐 {fp} | 박스 IoU 평균 {summary[cname]['mean_iou']}")
        line = []
        for cond in CONDITIONS:
            r8, rb = detail[cond]["rot8"], detail[cond]["robot"]
            line.append(f"{cond}:{'O' if r8['exact'] else 'X'}{r8['tp'] + rb['tp']}/{r8['fp'] + rb['fp']}")
        print("   조건별(O=rot8 합격, 문검출/오탐): " + "  ".join(line))
        misses = [f"{cond}:{','.join(detail[cond]['rot8']['missed'] + ['r' + m for m in detail[cond]['robot']['missed']])}"
                  for cond in CONDITIONS if detail[cond]["rot8"]["missed"] or detail[cond]["robot"]["missed"]]
        print("   놓친 문(r=robot): " + ("  ".join(misses) or "없음"))
    for v in summary.values():
        for d in v["detail"].values():
            for s in d.values():
                s["ious"] = [round(x, 3) for x in s["ious"]]
    with open(rl.HERE / "results" / "aug_eval.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
