"""게이트 유지 + 기준 완화 격자(P1)를 조명·각도 변형 22세트 전체에서 평가한다.

필수: 원본 rot8 합격(사용자 기준). 그 위에서 변형 조건 전체의 문 검출 수↑, 오탐↓, rot8 합격 조건 수↑.
원본 1장씩으로 맞춘 문턱이 합성 변형에 과적합되지 않게, 격자 값은 sweep_keep과 같은 거친 간격만 쓴다.
"""

from __future__ import annotations

import itertools
import json
import time

import relax_lib as rl
from aug import AUGS
from aug_eval import CONDITIONS, eval_set
from gt import gt_for
from sweep_keep import AXES, make

AXES_AUG = dict(AXES)
AXES_AUG["color"] = [(0.0, 1), (0.008, 1), (0.01, 1), (0.012, 1), (0.015, 1)]


def main():
    caches = {}
    for cond in CONDITIONS:
        for base in ("rot8", "robot"):
            name = base if cond == "orig" else f"{base}@{cond}"
            caches[name] = rl.Cache(name)
    gts = {n: gt_for(n) for n in caches}
    import sweep_keep
    sweep_keep.AXES["color"] = AXES_AUG["color"]
    names = list(AXES_AUG)
    rows = []
    t0 = time.time()
    for idx in itertools.product(*(range(len(AXES_AUG[n])) for n in names)):
        levels = dict(zip(names, idx))
        cfg = make(levels, "P1")
        orig = eval_set(caches["rot8"], cfg, gts["rot8"])
        if not orig["exact"]:
            continue
        tp = fp = rot8_ok = 0
        per = {}
        for cond in CONDITIONS:
            r8 = eval_set(caches["rot8" if cond == "orig" else f"rot8@{cond}"], cfg, gts["rot8" if cond == "orig" else f"rot8@{cond}"])
            rb = eval_set(caches["robot" if cond == "orig" else f"robot@{cond}"], cfg, gts["robot" if cond == "orig" else f"robot@{cond}"])
            tp += r8["tp"] + rb["tp"]
            fp += r8["fp"] + rb["fp"]
            rot8_ok += int(r8["exact"])
            per[cond] = (r8["tp"] + rb["tp"], r8["fp"] + rb["fp"])
        rows.append({"levels": levels, "label": cfg.short(), "tp": tp, "fp": fp, "rot8_ok": rot8_ok, "per": per})
    print(f"{len(rows)} configs(원본 rot8 합격), {time.time() - t0:.0f}s")
    json.dump(rows, open(rl.HERE / "results" / "aug_sweep.json", "w", encoding="utf-8"), ensure_ascii=False)
    # 파레토(문 검출↑, 오탐↓) + 요약
    rows.sort(key=lambda r: (-r["tp"], r["fp"]))
    pareto, best_fp = [], 10 ** 9
    for r in rows:
        if r["fp"] < best_fp:
            pareto.append(r)
            best_fp = r["fp"]
    print("\n[파레토: 문 검출 최대 -> 오탐 최소] tp/44 fp rot8합격조건")
    for r in pareto:
        print(f"  tp={r['tp']} fp={r['fp']} rot8={r['rot8_ok']}/11  {r['label']}")
    print("\n[오탐 0~3 중 문 검출 상위 15]")
    for r in [x for x in rows if x["fp"] <= 3][:15]:
        print(f"  tp={r['tp']} fp={r['fp']} rot8={r['rot8_ok']}/11  {r['label']}")


if __name__ == "__main__":
    main()
