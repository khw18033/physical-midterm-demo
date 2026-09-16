"""research/door_gate_relax/sweep.py

합격 기준(2026-09-14 사용자 지시): rot8 8프레임 중 **frame_000113/132에서만** 문이 제대로 검출.
  - 113/132: 확정(CONFIRMED) door 인스턴스가 정확히 1개이고 정답 박스와 IoU >= 0.5
  - 나머지 6프레임: 확정 door 0개
정답 박스는 오버레이 격자 이미지를 육안으로 확인한 파란 문 영역(= GroundingDINO 최고점 박스와 일치).

단계
  1) 게이트 조합: 5개 게이트(종횡비/색/모양/참조이미지/채도) on/off 32조합 × target_sim 문턱 × 특징세트
  2) 게이트 문턱 곡선: 켜 둔 게이트의 문턱을 풀어가며 어디까지 합격이 유지되나
  3) provider 임계값: GroundingDINO box/text, YOLO-World conf 격자
결과는 results/*.json에 전부 남기고 요약만 출력한다.
"""

from __future__ import annotations

import itertools
import json
from dataclasses import asdict, replace

import relax_lib as rl

GT = {
    "frame_000113.jpg": [139.6, 87.8, 161.4, 144.0],
    "frame_000132.jpg": [31.9, 87.4, 52.5, 142.3],
}
IOU_OK = 0.5
RESULTS = rl.HERE / "results"


def evaluate(cache: rl.Cache, cfg: rl.Config) -> dict:
    frames, ok_all, fp, tp = [], True, 0, 0
    for fr in cache.frames:
        r = rl.run_frame(cache, fr, cfg)
        gt = GT.get(fr["frame"])
        if gt is None:
            ok = len(r["instances"]) == 0
            fp += len(r["instances"])
        else:
            ious = [rl.iou(i["box_xyxy"], gt) for i in r["instances"]]
            ok = len(ious) == 1 and ious[0] >= IOU_OK
            tp += int(any(v >= IOU_OK for v in ious))
            fp += sum(1 for v in ious if v < IOU_OK)
            r["iou_to_gt"] = [round(v, 3) for v in ious]
        r["ok"] = ok
        ok_all &= ok
        frames.append(r)
    return {"config": asdict(cfg), "label": cfg.short(), "ok": ok_all, "tp": tp, "fp": fp, "frames": frames}


def _dump(name, rows):
    RESULTS.mkdir(exist_ok=True)
    with open(RESULTS / f"{name}.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)


def stage1_gate_subsets(cache):
    rows = []
    gates = ["aspect", "color", "shape", "ref", "sat"]
    for on in itertools.product([True, False], repeat=5):
        flags = dict(zip(gates, on))
        for fs in ["all8", "generic4"]:
            for sim in [0.26, 0.25, 0.24, 0.23, 0.22, 0.20, 0.18, 0.0]:
                cfg = replace(rl.BASELINE, feature_set=fs, target_sim_min=sim,
                              aspect_min=1.5 if flags["aspect"] else None, color_gate=flags["color"],
                              shape_gate=flags["shape"], ref_sim_min=0.75 if flags["ref"] else None,
                              sat_min=85.0 if flags["sat"] else None)
                res = evaluate(cache, cfg)
                res["gates_on"] = [g for g in gates if flags[g]]
                rows.append(res)
    _dump("stage1_gate_subsets", rows)
    return rows


def stage2_threshold_curves(cache, base: rl.Config, tag: str):
    """base에서 게이트 하나씩 문턱을 풀어 합격 유지 범위를 본다(나머지는 base 그대로)."""
    rows = []
    axes = {
        "target_sim_min": [0.30, 0.28, 0.26, 0.25, 0.24, 0.23, 0.22, 0.21, 0.20, 0.18, 0.15, 0.0],
        "aspect_min": [2.5, 2.0, 1.8, 1.5, 1.3, 1.2, 1.0, 0.8, None],
        "ref_sim_min": [0.80, 0.78, 0.75, 0.72, 0.70, 0.65, 0.60, None],
        "sat_min": [100.0, 85.0, 70.0, 60.0, 50.0, 40.0, 20.0, None],
        "color_tol": [0.0, 0.002, 0.005, 0.01, 0.02],
    }
    for key, values in axes.items():
        for v in values:
            cfg = replace(base, **{key: v})
            if key == "color_tol" and not base.color_gate:
                continue
            res = evaluate(cache, cfg)
            res["axis"], res["value"] = key, v
            rows.append(res)
    _dump(f"stage2_curves_{tag}", rows)
    return rows


def stage3_providers(cache, base: rl.Config, tag: str):
    rows = []
    for gb in [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45]:
        for gt in [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]:
            for yw in [0.001, 0.002, 0.005, 0.01, 0.02, 0.05]:
                res = evaluate(cache, replace(base, gdino_box=gb, gdino_text=gt, yw_conf=yw))
                rows.append(res)
    _dump(f"stage3_providers_{tag}", rows)
    return rows


def _fail_reason(res):
    out = []
    for f in res["frames"]:
        if not f["ok"]:
            out.append(f"{f['frame'][6:12]}:{len(f['instances'])}개" + (f"(IoU {f.get('iou_to_gt')})" if f['frame'] in GT else ""))
    return " ".join(out)


if __name__ == "__main__":
    import sys
    cache = rl.Cache()
    base = evaluate(cache, rl.BASELINE)
    print("[baseline]", base["ok"], _fail_reason(base))
    stage = sys.argv[1] if len(sys.argv) > 1 else "1"
    if stage == "1":
        rows = stage1_gate_subsets(cache)
        print(f"stage1: {sum(r['ok'] for r in rows)}/{len(rows)} 합격")
        for fs in ["all8", "generic4"]:
            for r in rows:
                if r["config"]["feature_set"] != fs:
                    continue
            ok_rows = [r for r in rows if r["ok"] and r["config"]["feature_set"] == fs]
            # 게이트가 적을수록, 문턱이 낮을수록 관대한 설정
            ok_rows.sort(key=lambda r: (len(r["gates_on"]), r["config"]["target_sim_min"]))
            print(f"-- {fs}: 합격 {len(ok_rows)}개, 가장 관대한 순 15개")
            for r in ok_rows[:15]:
                print(f"   gates={r['gates_on']} sim>={r['config']['target_sim_min']}")
        # 게이트 조합별: 합격하는 가장 낮은 sim 문턱
        print("-- 게이트 조합별 합격 sim 문턱(all8 / generic4), 실패 이유는 sim=0.26 기준")
        combos = {}
        for r in rows:
            key = tuple(r["gates_on"])
            combos.setdefault(key, {"all8": [], "generic4": [], "fail26": {}})
            if r["ok"]:
                combos[key][r["config"]["feature_set"]].append(r["config"]["target_sim_min"])
            if r["config"]["target_sim_min"] == 0.26:
                combos[key]["fail26"][r["config"]["feature_set"]] = _fail_reason(r)
        for key, v in sorted(combos.items(), key=lambda kv: len(kv[0])):
            print(f"   {list(key)!s:42} all8={sorted(v['all8'])} generic4={sorted(v['generic4'])} "
                  f"| 0.26 실패: all8[{v['fail26'].get('all8')}] generic4[{v['fail26'].get('generic4')}]")
