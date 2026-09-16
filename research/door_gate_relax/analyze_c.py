import json
from collections import Counter

import relax_lib as rl  # noqa: F401
from sweep2 import RESULTS

rows = json.load(open(RESULTS / "stageC.json", encoding="utf-8"))
ok = [r for r in rows if r["rot8"]["exact"]]
best = [r for r in ok if r["robot"]["tp"] == 2 and r["robot"]["fp"] == 0]
print(f"전체 {len(rows)} / rot8 합격 {len(ok)} / + robot 2·0 {len(best)}")
print("rot8 합격 robot 분포:", Counter((r["robot"]["tp"], r["robot"]["fp"], r["robot"]["amb"]) for r in ok).most_common())

knobs = ["feature_set", "target_sim_min", "aspect_min", "sat_min", "color_gate", "gdino_box", "gdino_text",
         "gdino_label_exact", "yw_conf"]
print("\n값별 (rot8 합격 수 / 그중 robot 2·0 수)")
for k in knobs:
    tot, good = Counter(), Counter()
    for r in ok:
        tot[str(r["config"][k])] += 1
    for r in best:
        good[str(r["config"][k])] += 1
    allv = sorted({str(r["config"][k]) for r in rows})
    print(f"  {k:18} " + "  ".join(f"{v}:{tot[v]}/{good[v]}" for v in allv))


def agnostic(c):
    return not c["color_gate"] and c["sat_min"] is None


ag = [r for r in ok if agnostic(r["config"])]
print(f"\n[인스턴스 무관: 색·채도·참조 전부 끔] rot8 합격 {len(ag)}개, robot 분포 "
      f"{Counter((r['robot']['tp'], r['robot']['fp'], r['robot']['amb']) for r in ag).most_common()}")
ag.sort(key=lambda r: (-r["robot"]["tp"], r["robot"]["fp"], r["config"]["gdino_box"], r["config"]["target_sim_min"]))
for r in ag[:30]:
    print("  ", r["label"], "robot", (r["robot"]["tp"], r["robot"]["fp"], r["robot"]["amb"]))

for name, cond in [("색만", lambda c: c["color_gate"] and c["sat_min"] is None),
                   ("채도만", lambda c: not c["color_gate"] and c["sat_min"] is not None)]:
    sub = [r for r in best if cond(r["config"])]
    print(f"\n[{name}] rot8 합격 + robot 2·0: {len(sub)}개 -- 관대한 순 15")
    sub.sort(key=lambda r: (r["config"]["target_sim_min"], r["config"]["sat_min"] or 0, r["config"]["aspect_min"] or 0,
                            r["config"]["gdino_box"]))
    for r in sub[:15]:
        print("  ", r["label"])
