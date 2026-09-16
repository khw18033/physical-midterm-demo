import json
from collections import Counter

import relax_lib as rl  # noqa: F401
from sweep2 import RESULTS
from sweep_keep import AXES

rows = json.load(open(RESULTS / "keep_gates.json", encoding="utf-8"))
names = list(AXES)
MAXL = {n: len(AXES[n]) - 1 for n in names}


def val(n, lv):
    return AXES[n][lv]


def lvstr(levels):
    return " ".join(f"{n}={val(n, levels[n])}" for n in names)


for prov in ("P0", "P1"):
    sub = [r for r in rows if r["provider"] == prov]
    ok = [r for r in sub if r["rot8"]["exact"]]
    print(f"\n==== {prov}: rot8 합격 {len(ok)}/{len(sub)}  robot 분포 {Counter((r['robot']['tp'], r['robot']['fp']) for r in ok).most_common()}")
    base = next(r for r in sub if all(v == 0 for v in r["levels"].values()))
    print(f"  참조이미지만 끈 상태(나머지 현재값): rot8={base['rot8']['exact']} robot tp/fp={base['robot']['tp']}/{base['robot']['fp']}")
    print("  [단독 완화] 다른 축은 현재값일 때, 이 축만 풀어서 rot8 합격하는 값들 (robot tp/fp)")
    for n in names:
        marks = []
        for lv in range(MAXL[n] + 1):
            r = next(x for x in sub if x["levels"][n] == lv and all(x["levels"][m] == 0 for m in names if m != n))
            marks.append(f"{val(n, lv)}:{'O' if r['rot8']['exact'] else 'X'}{r['robot']['tp']}/{r['robot']['fp']}")
        print(f"    {n:15} " + "  ".join(marks))
    print("  [축별 최대 완화] 어떤 조합으로든 rot8 합격하는 가장 느슨한 값")
    for n in names:
        print(f"    {n:15} {val(n, max(r['levels'][n] for r in ok))}")
    # 균형 완화: 각 축 정규화 단계의 최솟값을 최대화 -> 합 최대화 -> robot tp 큰 순 -> fp 작은 순
    def key(r):
        norm = [r["levels"][n] / MAXL[n] for n in names]
        return (min(norm), sum(norm), r["robot"]["tp"], -r["robot"]["fp"])
    ok.sort(key=key, reverse=True)
    print("  [균형 완화 상위 12] (모든 축을 고르게 가장 많이 푼 순)")
    for r in ok[:12]:
        print(f"    {lvstr(r['levels'])}  robot tp/fp={r['robot']['tp']}/{r['robot']['fp']}")
    good = [r for r in ok if r["robot"]["tp"] == 2 and r["robot"]["fp"] == 0]
    good.sort(key=key, reverse=True)
    print(f"  [robot 2/2·오탐0 중 균형 완화 상위 12] ({len(good)}개)")
    for r in good[:12]:
        print(f"    {lvstr(r['levels'])}")
