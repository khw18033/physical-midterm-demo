"""게이트 값 분포 비교 -- 격자 경계값을 고르지 않도록 '여유 폭'을 직접 잰다.

양성: 정답 문과 IoU>=0.5인 RPN 후보.
위험 음성: 정답과 겹치지 않으면서(IoU<0.1) GroundingDINO door 박스(점수>=0.15)와 서비스 연계 규칙
(IoU>=0.30 또는 containment>=0.7)으로 묶이는 RPN 후보 -- CLIP 게이트만 통과하면 곧바로 오탐으로
확정될 수 있는 후보들이다(GDINO가 이미 동의하고 있으므로).
"""

from __future__ import annotations

import relax_lib as rl
from gt import GT_BY_SET

FEATS = ["sat", "sim_all8", "sim_generic4", "color_gap", "shape_gap", "ref_sim", "aspect"]


def main(text_thr="0.25", exact=True):
    pos, neg = [], []
    for set_name, gts in GT_BY_SET.items():
        cache = rl.Cache(set_name)
        for fr in cache.frames:
            rl.run_frame(cache, fr, rl.BASELINE)  # _measures 채우기
            gt = gts["doors"].get(fr["frame"])
            amb = gts["ambiguous"].get(fr["frame"])
            gd = [d for d in fr["grounding_dino_by_text_thr"][text_thr]
                  if d["score"] >= 0.15 and ((d["label"].strip() == "door") if exact else ("door" in d["label"]))]
            for m in fr["_measures"]:
                tag = f"{set_name}/{fr['frame'][6:12]} {[round(v) for v in m['box']]}"
                if gt is not None and rl.iou(m["box"], gt) >= 0.5:
                    pos.append((tag, m, None))
                    continue
                if gt is not None and rl.iou(m["box"], gt) >= 0.1:
                    continue
                if amb is not None and rl.iou(m["box"], amb) >= 0.3:
                    continue
                best = 0.0
                for d in gd:
                    iou, cont = rl.cfs._iou_and_containment(m["box"], d["box_xyxy"])
                    if iou >= rl.cfs.ASSOCIATION_IOU_THR or cont >= rl.cfs.ASSOCIATION_CONTAINMENT_THR:
                        best = max(best, d["score"])
                if best > 0:
                    neg.append((tag, m, best))
    print(f"양성 {len(pos)}개 / 위험 음성 {len(neg)}개 (GDINO text={text_thr}, exact={exact})")
    for f in FEATS:
        pv = sorted(m[f] for _, m, _ in pos)
        nv = sorted(m[f] for _, m, _ in neg)
        print(f"\n[{f}] 양성: {[round(v, 4) for v in pv]}")
        print(f"   음성 분위(최소/25/50/75/최대): {[round(nv[int(q * (len(nv) - 1))], 4) for q in (0, .25, .5, .75, 1)]}")
    print("\n양성 상세")
    for tag, m, _ in pos:
        print(f"   {tag} sat={m['sat']:.0f} sim8={m['sim_all8']:.4f} sim4={m['sim_generic4']:.4f} color={m['color_gap']:+.4f} "
              f"ref={m['ref_sim']:.3f} asp={m['aspect']:.2f}")
    print("\n위험 음성 중 채도 상위 15 (GDINO 점수 함께)")
    for tag, m, g in sorted(neg, key=lambda t: -t[1]["sat"])[:15]:
        print(f"   {tag} sat={m['sat']:.0f} gdino={g:.3f} sim8={m['sim_all8']:.4f} sim4={m['sim_generic4']:.4f} "
              f"color={m['color_gap']:+.4f} asp={m['aspect']:.2f}")


if __name__ == "__main__":
    import sys
    main(*(sys.argv[1:2] or ["0.25"]), exact=(sys.argv[2] != "substr") if len(sys.argv) > 2 else True)
