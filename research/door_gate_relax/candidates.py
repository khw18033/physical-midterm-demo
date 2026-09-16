"""후보 설정별 상세 결과 + 국소 안정성(문턱을 한 칸씩 흔들어도 합격이 유지되나)."""

from __future__ import annotations

from dataclasses import replace

import relax_lib as rl
from gt import GT_BY_SET
from sweep2 import evaluate

B = rl.BASELINE
OFF3 = dict(color_gate=False, shape_gate=False, ref_sim_min=None)
CANDIDATES = {
    "baseline": B,
    "R0 게이트만 완화(provider 현재값)": replace(B, **OFF3, target_sim_min=0.22),
    "R1 게이트 완화 + GDINO 라벨 정리": replace(B, **OFF3, target_sim_min=0.22, gdino_text=0.25, gdino_label_exact=True),
    "R2 R1 + GDINO box 0.25": replace(B, **OFF3, target_sim_min=0.22, gdino_box=0.25, gdino_text=0.25, gdino_label_exact=True),
    "R3 R2 + 종횡비 1.2": replace(B, **OFF3, target_sim_min=0.22, aspect_min=1.2, gdino_box=0.25, gdino_text=0.25,
                                 gdino_label_exact=True),
    "R4 R2 + 채도 80": replace(B, **OFF3, target_sim_min=0.22, sat_min=80.0, gdino_box=0.25, gdino_text=0.25,
                             gdino_label_exact=True),
}
NEIGHBORS = {
    "sat_min": [70.0, 75.0, 80.0, 85.0, 90.0],
    "target_sim_min": [0.0, 0.20, 0.22, 0.23, 0.24],
    "aspect_min": [None, 1.0, 1.2, 1.5, 1.8],
    "gdino_box": [0.15, 0.20, 0.25, 0.30, 0.35],
    "gdino_text": [0.15, 0.20, 0.25, 0.30],
    "yw_conf": [0.001, 0.005, 0.02, 0.05],
}


def brief(res):
    out = []
    for name in ("rot8", "robot"):
        s = res[name]
        out.append(f"{name}: exact={s['exact']} tp={s['tp']}/2 fp={s['fp']} amb={s['amb']}")
    return " | ".join(out)


def main():
    caches = {"rot8": rl.Cache("rot8"), "robot": rl.Cache("robot")}
    for name, cfg in CANDIDATES.items():
        res = evaluate(caches, cfg)
        print(f"\n### {name}\n   {cfg.short()}\n   {brief(res)}")
        for set_name in ("rot8", "robot"):
            gts = GT_BY_SET[set_name]["doors"]
            for f in res[set_name]["frames"]:
                if not f["instances"]:
                    continue
                gt = gts.get(f["frame"])
                desc = []
                for inst in f["instances"]:
                    iou = rl.iou(inst["box_xyxy"], gt) if gt else 0.0
                    desc.append(f"{[round(v) for v in inst['box_xyxy']]} IoU={iou:.2f} {'+'.join(inst['supporting'])}")
                print(f"     {set_name}/{f['frame']}: " + " ; ".join(desc))
        if name.startswith("baseline"):
            continue
        stable = []
        for key, values in NEIGHBORS.items():
            marks = []
            for v in values:
                r = evaluate(caches, replace(cfg, **{key: v}))
                good = r["rot8"]["exact"]
                rob = r["robot"]
                marks.append(f"{v}:{'O' if good else 'X'}{rob['tp']}/{rob['fp']}")
            stable.append(f"{key}=[{' '.join(marks)}]")
        print("   안정성(O=rot8 합격, 뒤 숫자=robot tp/fp): ")
        for s in stable:
            print("     ", s)


if __name__ == "__main__":
    main()
