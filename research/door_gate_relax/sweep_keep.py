"""research/door_gate_relax/sweep_keep.py

2026-09-14 사용자 지시(방향 수정): "조명, 촬영 각도 등이 달라지는 상황을 고려해 색, 채도, 종횡비 등의
게이트는 유지한 채 통과 기준만을 완화. 특히 참조 이미지 게이트를 필수에서 제외."

  - 참조이미지 게이트: 끔(필수 제외)
  - 색/채도/종횡비/모양/target_sim 게이트: 켠 채로 판정 기준만 느슨하게
      색   : light blue가 1등(현재) -> 1등과 차이 tol 이내 또는 상위 k등 이내
      모양 : positive가 1등(현재) -> 최고 negative보다 tol 이내
      채도·종횡비·target_sim : 문턱 낮춤
  - provider: P0 = 현재값(GDINO 0.15/0.15 부분일치, YOLO-World 0.05)
              P1 = door 증거만 GDINO '라벨 정확히 door + 점수>=0.25'(앞 실험 R2b, 단상 판정은 그대로)
각 축의 '완화 단계'는 리스트 앞(현재값)에서 뒤로 갈수록 느슨하다.
"""

from __future__ import annotations

import itertools
import json
import time
from dataclasses import replace

import relax_lib as rl
from sweep2 import evaluate, RESULTS

AXES = {
    "target_sim_min": [0.26, 0.25, 0.24, 0.23, 0.22, 0.20],
    "aspect_min": [1.5, 1.4, 1.3, 1.2, 1.1, 1.0],
    "sat_min": [85.0, 80.0, 75.0, 70.0, 65.0, 60.0, 50.0],
    "color": [(0.0, 1), (0.005, 1), (0.01, 1), (0.015, 1), (0.02, 1), (0.0, 2), (0.0, 3)],
    "shape_tol": [0.0, 0.002, 0.005, 0.01],
}
PROVIDERS = {
    "P0": dict(gdino_box=0.15, gdino_text=0.15, gdino_label_exact=False),
    "P1": dict(gdino_box=0.25, gdino_text=0.15, gdino_label_exact=True),
}
KEEP_BASE = replace(rl.BASELINE, ref_sim_min=None)


def make(levels: dict, prov: str) -> rl.Config:
    tol, k = AXES["color"][levels["color"]]
    return replace(KEEP_BASE, target_sim_min=AXES["target_sim_min"][levels["target_sim_min"]],
                   aspect_min=AXES["aspect_min"][levels["aspect_min"]], sat_min=AXES["sat_min"][levels["sat_min"]],
                   color_tol=tol, color_rank_k=k, shape_tol=AXES["shape_tol"][levels["shape_tol"]],
                   **PROVIDERS[prov])


def main():
    caches = {"rot8": rl.Cache("rot8"), "robot": rl.Cache("robot")}
    rows = []
    t0 = time.time()
    names = list(AXES)
    for prov in PROVIDERS:
        for idx in itertools.product(*(range(len(AXES[n])) for n in names)):
            levels = dict(zip(names, idx))
            res = evaluate(caches, make(levels, prov))
            for k in caches:
                res[k] = {kk: vv for kk, vv in res[k].items() if kk != "frames"}
            res["levels"], res["provider"] = levels, prov
            rows.append(res)
    print(f"{len(rows)} configs, {time.time() - t0:.0f}s")
    with open(RESULTS / "keep_gates.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
