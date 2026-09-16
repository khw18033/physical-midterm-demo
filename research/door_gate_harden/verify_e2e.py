"""2026-09-15 door 강화(hue_gate + confirm_pair_iou_min) 반영 후 운영 코드 그대로 끝까지 돌려 검증한다.

- 입력: datasets/260915 기록 14건(로봇 원본 프레임) + 09-14 회귀 세트(rot8 원본, robot 무손실 crop PNG)
- 출력: research/door_gate_harden/e2e/<세트>/ (cfs.RUN_DIR 만 돌린다 -- try1/ 무관, 코드 패치 없음)
- 판정: 확정된 door 가 있는 회전각 == 정답 회전각, 정답 문 박스와 IoU>=0.5
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(REPO_ROOT / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402

DS = REPO_ROOT / "datasets" / "260915"
RELAX = REPO_ROOT / "research" / "door_gate_relax"

# 정답(육안, border-crop 237x241 좌표). ambiguous = 가려지거나 화면 끝에 잘린 문, 멀리 작은 복도 문.
EDGE = [205, 70, 237, 150]
GT = {
    "144522": {"doors": {90: [90.0, 23.9, 154.1, 159.0], 135: [1.1, 20.9, 70.3, 161.4]},
               "ambiguous": {0: [110, 30, 170, 160], 45: [170, 0, 237, 241], 180: [135, 0, 185, 210], 315: [140, 0, 237, 200]}},
    "161113": {"doors": {}, "ambiguous": {}},
    "161605": {"doors": {270: [148.1, 86.5, 172.4, 142.1], 315: [59.8, 89.8, 81.6, 142.3]}, "ambiguous": {}},
    "161822": {"doors": {270: [143.8, 90.3, 169.2, 142.0]}, "ambiguous": {315: [50, 80, 85, 146]}},
    "164044": {"doors": {315: [120.1, 89.5, 141.5, 140.5]}, "ambiguous": {270: EDGE}},
    "164242": {"doors": {315: [102.9, 91.9, 124.3, 142.5]}, "ambiguous": {270: EDGE}},
    "164814": {"doors": {270: [188.5, 82.5, 209.0, 141.6], 315: [61.1, 89.3, 83.3, 142.4]}, "ambiguous": {}},
    "164923": {"doors": {270: [172.7, 85.5, 191.7, 140.3], 315: [61.9, 90.7, 79.0, 142.2]}, "ambiguous": {}},
    "165143": {"doors": {270: [154.0, 90.3, 174.0, 141.8], 315: [73.1, 91.1, 91.0, 141.7]}, "ambiguous": {}},
    "165313": {"doors": {270: [139.2, 88.9, 158.6, 142.1], 315: [51.9, 91.5, 70.8, 142.3]}, "ambiguous": {}},
    "165734": {"doors": {}, "ambiguous": {270: EDGE, 315: EDGE}},
    "170547": {"doors": {270: [164.5, 86.7, 186.6, 141.8], 315: [72.7, 89.3, 92.8, 142.2]}, "ambiguous": {}},
    "170907": {"doors": {270: [161.6, 86.9, 185.8, 144.8], 315: [57.1, 86.9, 79.3, 143.8]}, "ambiguous": {}},
    "171015": {"doors": {270: [138.7, 83.4, 162.9, 142.5], 315: [56.7, 85.1, 78.7, 142.1]}, "ambiguous": {}},
    "rot8": {"doors": {270: [139.6, 87.8, 161.4, 144.0], 315: [31.9, 87.4, 52.5, 142.3]}, "ambiguous": {}},
    "robot": {"doors": {225: [188.5, 82.0, 215.5, 146.7], 270: [93.0, 88.5, 114.0, 144.1]},
              "ambiguous": {90: [147.1, 11.1, 204.2, 165.4], 135: [48.6, 22.2, 87.3, 158.0]}},
}
ONLY_ROTS = {"161113": {0, 45, 90}}  # 카메라가 얼어 90도 이후가 같은 그림


def frames_of(name):
    if name == "rot8":
        d = REPO_ROOT / "datasets" / "20260910-134818_rot8"
        return [(d / f, 45.0 * i) for i, f in enumerate(
            ["frame_000001.jpg", "frame_000020.jpg", "frame_000039.jpg", "frame_000057.jpg",
             "frame_000076.jpg", "frame_000095.jpg", "frame_000113.jpg", "frame_000132.jpg"])]
    if name == "robot":
        return [(RELAX / "aug_frames" / "robot" / f"frame_{i:06d}.png", 45.0 * i) for i in range(8)]
    rec = next(p for p in DS.iterdir() if p.name.startswith(name))
    out = []
    for p in sorted((rec / "images" / "robot").glob("rot_*.jpg")):
        rot = int(p.stem.split("_")[1])
        if name in ONLY_ROTS and rot not in ONLY_ROTS[name]:
            continue
        out.append((p, float(rot)))
    return out


def main():
    names = sys.argv[1:] or list(GT)
    finder = cfs.ClassFinderService()
    summary, ok_all = {}, True
    for name in names:
        cfs.RUN_DIR = HERE / "e2e" / name
        finder.on_class_discovery_command("door")
        frames = frames_of(name)
        for i, (path, rot) in enumerate(frames):
            finder.on_frame(path, rot, i)
        dets = finder.get_detections("door")
        g = GT[name]
        rows, found = [], []
        for _, rot in frames:
            d = dets[rot]
            gt = g["doors"].get(int(rot))
            amb = g["ambiguous"].get(int(rot))
            insts = []
            for inst in d["instances"]:
                last = inst["evidence_trail"][-1]
                insts.append({"box": inst["box_xyxy"], "sources": sorted(inst["supporting_sources"]),
                              "iou_gt": round(cfs._iou_xyxy(inst["box_xyxy"], gt), 3) if gt else None,
                              "iou_amb": round(cfs._iou_xyxy(inst["box_xyxy"], amb), 3) if amb else None,
                              "dictionary_ovd_iou": last.get("dictionary_ovd_iou")})
            if insts:
                found.append(int(rot))
            rows.append({"rotation_deg": rot, "gt": gt, "instances": insts})
        tp = sum(1 for r in rows if r["gt"] and any(x["iou_gt"] >= 0.5 for x in r["instances"]))
        fp = sum(1 for r in rows for x in r["instances"]
                 if not (x["iou_gt"] is not None and x["iou_gt"] >= 0.5) and not (x["iou_amb"] is not None and x["iou_amb"] >= 0.3))
        ok = tp == len(g["doors"]) and fp == 0
        ok_all &= ok
        summary[name] = {"ok": ok, "doors": f"{tp}/{len(g['doors'])}", "fp": fp, "found_rotations": found,
                         "gt_rotations": sorted(g["doors"]), "rows": rows}
        print(f"[verify] {name}: {'OK ' if ok else 'XX '} 문 {tp}/{len(g['doors'])} 오탐 {fp} "
              f"found={found} gt={sorted(g['doors'])}", flush=True)
    (HERE / "e2e" / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[verify] 전체 {'통과' if ok_all else '실패'}")


if __name__ == "__main__":
    main()
