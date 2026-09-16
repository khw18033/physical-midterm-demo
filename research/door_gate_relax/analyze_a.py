import json
from collections import Counter, defaultdict

import relax_lib as rl  # noqa: F401  (경로 설정)
from sweep2 import RESULTS, gates_on

rows = json.load(open(RESULTS / "stageA_gates.json", encoding="utf-8"))
ok = [r for r in rows if r["rot8"]["exact"]]
print(f"전체 {len(rows)} / rot8 합격 {len(ok)}")
print("rot8 합격 중 robot (tp,fp) 분포:", Counter((r["robot"]["tp"], r["robot"]["fp"]) for r in ok).most_common())

best = [r for r in ok if r["robot"]["tp"] == 2 and r["robot"]["fp"] == 0]
print(f"\nrot8 합격 + robot 2/2·오탐0: {len(best)}개")

# 손잡이(knob)별 값마다 '둘 다 만족하는 설정이 존재하나' + 몇 개인가
knobs = ["feature_set", "target_sim_min", "aspect_min", "color_gate", "color_tol", "shape_gate", "ref_sim_min",
         "sat_min", "gdino_label_exact"]
print("\n값별 (rot8 합격 수 / 그중 robot 2·0 수)")
for k in knobs:
    tot, good = Counter(), Counter()
    for r in ok:
        tot[str(r["config"][k])] += 1
    for r in best:
        good[str(r["config"][k])] += 1
    allv = sorted({str(r["config"][k]) for r in rows})
    print(f"  {k:18} " + "  ".join(f"{v}:{tot[v]}/{good[v]}" for v in allv))

print("\n인스턴스 전용 게이트(색/채도/참조이미지) 전부 끈 설정 중 rot8 합격:",
      sum(1 for r in ok if not r["config"]["color_gate"] and r["config"]["sat_min"] is None and r["config"]["ref_sim_min"] is None))
for name, cond in [("색만 켬", lambda c: c["color_gate"] and c["sat_min"] is None and c["ref_sim_min"] is None),
                   ("채도만 켬", lambda c: not c["color_gate"] and c["sat_min"] is not None and c["ref_sim_min"] is None),
                   ("참조만 켬", lambda c: not c["color_gate"] and c["sat_min"] is None and c["ref_sim_min"] is not None)]:
    sub = [r for r in ok if cond(r["config"])]
    print(f"  {name}: rot8 합격 {len(sub)}, robot 분포 {Counter((r['robot']['tp'], r['robot']['fp']) for r in sub).most_common(5)}")

print("\n가장 관대한 순(켜진 게이트 수 → sim 문턱 → 종횡비 → 채도 → 색 허용폭 큰 순), rot8 합격 + robot 2·0 상위 25")
best.sort(key=lambda r: (gates_on(r["config"]), r["config"]["target_sim_min"], r["config"]["aspect_min"] or 0,
                         r["config"]["sat_min"] or 0, -(r["config"]["color_tol"] if r["config"]["color_gate"] else 1),
                         r["config"]["feature_set"] != "generic4"))
for r in best[:25]:
    print("  ", r["label"])

print("\nrot8 합격인데 robot 오탐>0인 대표(게이트 수 적은 순 10)")
bad = sorted([r for r in ok if r["robot"]["fp"] > 0], key=lambda r: gates_on(r["config"]))
for r in bad[:10]:
    print("  ", r["label"], r["robot"])
