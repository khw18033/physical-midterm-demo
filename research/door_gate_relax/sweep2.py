"""research/door_gate_relax/sweep2.py -- rot8(필수) + robot(보조) 두 세트 격자 탐색.

합격(필수): rot8에서 frame_000113/132에만 문(각 1개, 정답 IoU>=0.5), 나머지 6장 0개.
보조 지표(다른 환경 = 리허설 로봇 카메라 8장):
  tp  = 문이 보이는 2장(225/270도) 중 정답 IoU>=0.5로 확정된 장 수
  fp  = 문이 아닌 곳에 확정된 인스턴스 수(애매한 유리 칸막이와 겹치는 것은 amb로 따로 셈)
단계 A: 게이트 격자(GroundingDINO/YOLO-World는 현재값, 라벨 매칭 방식만 2가지)
단계 B: 상위 게이트 설정마다 provider 임계값 격자
"""

from __future__ import annotations

import itertools
import json
import sys
import time
from dataclasses import asdict, replace

import relax_lib as rl
from gt import GT_BY_SET

RESULTS = rl.HERE / "results"
IOU_OK = 0.5


def eval_set(cache, cfg, gts):
    doors, amb = gts["doors"], gts["ambiguous"]
    tp = fp = n_amb = 0
    exact = True
    per_frame = []
    for fr in cache.frames:
        r = rl.run_frame(cache, fr, cfg)
        gt = doors.get(fr["frame"])
        hit = False
        for inst in r["instances"]:
            b = inst["box_xyxy"]
            if gt is not None and rl.iou(b, gt) >= IOU_OK and not hit:
                hit = True
            elif fr["frame"] in amb and rl.iou(b, amb[fr["frame"]]) >= 0.3:
                n_amb += 1
            else:
                fp += 1
        if gt is not None:
            tp += int(hit)
            exact &= hit and len(r["instances"]) == 1
        else:
            exact &= len(r["instances"]) == 0
        per_frame.append({"frame": fr["frame"], "instances": r["instances"], "clip_passed": len(r["clip_passed"]) if isinstance(r["clip_passed"], tuple) else r["clip_passed"]})
    return {"exact": exact, "tp": tp, "fp": fp, "amb": n_amb, "frames": per_frame}


def evaluate(caches, cfg):
    out = {"config": asdict(cfg), "label": cfg.short()}
    for name, cache in caches.items():
        out[name] = eval_set(cache, cfg, GT_BY_SET[name])
    return out


def instance_specific_count(c):
    return int(c["color_gate"]) + int(c["ref_sim_min"] is not None) + int(c["sat_min"] is not None) + int(c["feature_set"] == "all8")


def gates_on(c):
    return (int(c["color_gate"]) + int(c["ref_sim_min"] is not None) + int(c["sat_min"] is not None)
            + int(c["shape_gate"]) + int(c["aspect_min"] is not None))


def stage_a(caches):
    rows = []
    grid = itertools.product(
        ["all8", "generic4"], [0.0, 0.20, 0.22, 0.23, 0.24, 0.25, 0.26],
        [None, 1.0, 1.2, 1.5], [None, 0.02, 0.01, 0.005, 0.0], [True, False],
        [None, 0.70, 0.75], [None, 40.0, 60.0, 85.0], [False, True])
    for fs, sim, asp, col, shape, ref, sat, exact in grid:
        cfg = replace(rl.BASELINE, feature_set=fs, target_sim_min=sim, aspect_min=asp,
                      color_gate=col is not None, color_tol=col or 0.0, shape_gate=shape,
                      ref_sim_min=ref, sat_min=sat, gdino_label_exact=exact)
        res = evaluate(caches, cfg)
        for k in caches:  # 프레임 상세는 용량이 커서 요약 파일에서는 뺀다
            res[k] = {kk: vv for kk, vv in res[k].items() if kk != "frames"}
        rows.append(res)
    return rows


def stage_b(caches, base_cfgs):
    rows = []
    for base in base_cfgs:
        for gb, gt, yw, exact in itertools.product([0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40],
                                                   [0.10, 0.15, 0.20, 0.25, 0.30],
                                                   [0.001, 0.005, 0.02, 0.05], [False, True]):
            res = evaluate(caches, replace(base, gdino_box=gb, gdino_text=gt, yw_conf=yw, gdino_label_exact=exact))
            res["base"] = base.short()
            for k in caches:
                res[k] = {kk: vv for kk, vv in res[k].items() if kk != "frames"}
            rows.append(res)
    return rows


def stage_c(caches):
    """게이트 × provider 결합 격자. 단계 A에서 결과에 영향이 없던 모양/참조이미지 게이트는 끈다."""
    rows = []
    grid = itertools.product(
        ["all8", "generic4"], [0.0, 0.22, 0.24, 0.25, 0.26], [None, 1.2, 1.5], [None, 60.0, 85.0], [False, True],
        [0.15, 0.20, 0.25, 0.30, 0.35, 0.40], [0.15, 0.25], [False, True], [0.05, 0.005, 0.001])
    for fs, sim, asp, sat, col, gb, gt, exact, yw in grid:
        cfg = replace(rl.BASELINE, feature_set=fs, target_sim_min=sim, aspect_min=asp, sat_min=sat,
                      color_gate=col, shape_gate=False, ref_sim_min=None,
                      gdino_box=gb, gdino_text=gt, gdino_label_exact=exact, yw_conf=yw)
        res = evaluate(caches, cfg)
        for k in caches:
            res[k] = {kk: vv for kk, vv in res[k].items() if kk != "frames"}
        rows.append(res)
    return rows


def main():
    caches = {"rot8": rl.Cache("rot8"), "robot": rl.Cache("robot")}
    RESULTS.mkdir(exist_ok=True)
    b = evaluate(caches, rl.BASELINE)
    print(f"[baseline] rot8 exact={b['rot8']['exact']} | robot tp={b['robot']['tp']}/2 fp={b['robot']['fp']} amb={b['robot']['amb']}")
    stage = sys.argv[1] if len(sys.argv) > 1 else "A"
    t0 = time.time()
    rows = stage_a(caches) if stage == "A" else stage_c(caches)
    print(f"stage {stage}: {len(rows)} configs, {time.time() - t0:.0f}s")
    with open(RESULTS / f"stage{stage}.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
