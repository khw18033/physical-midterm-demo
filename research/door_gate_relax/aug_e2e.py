"""운영 반영 후 검증: 조명·각도 변형 22세트를 **운영 코드 그대로**(패치 없음) 돌려 오프라인 재현(aug_eval K4)과 비교.

변형 crop은 무손실 PNG로 써서 넣는다(237x241이라 서비스의 테두리 자르기는 건너뛰고 그대로 쓴다) --
JPEG로 쓰면 재압축으로 픽셀이 바뀌어 캐시와 같은 입력이 아니게 된다.
출력은 research/door_gate_relax/aug_e2e/<세트@변형>/ (try1 무관).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(REPO_ROOT / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402

import cv2  # noqa: E402
import numpy as np  # noqa: E402

import relax_lib as rl  # noqa: E402
from aug import AUGS  # noqa: E402
from cache_raw import SETS, _crop_border  # noqa: E402
from gt import gt_for  # noqa: E402

K4_KEY = "K4 추천: K2a인데 sim 0.25"


def main():
    finder = cfs.ClassFinderService()
    offline = json.loads((HERE / "results" / "aug_eval.json").read_text(encoding="utf-8"))[K4_KEY]["detail"]
    total_tp = total_fp = 0
    mismatches = []
    for cond in ["orig"] + list(AUGS):
        for base in ("rot8", "robot"):
            name = base if cond == "orig" else f"{base}@{cond}"
            frame_dir, frames = SETS[base]
            in_dir = HERE / "aug_frames" / name
            in_dir.mkdir(parents=True, exist_ok=True)
            cfs.RUN_DIR = HERE / "aug_e2e" / name
            finder.on_class_discovery_command("door")
            for i, (fname, rot) in enumerate(frames):
                bgr = _crop_border(cv2.imread(str(frame_dir / fname)))
                if cond != "orig":
                    bgr = np.ascontiguousarray(AUGS[cond](bgr))
                png = in_dir / (Path(fname).stem + ".png")
                cv2.imwrite(str(png), bgr)
                finder.on_frame(png, rot, i)
            dets = finder.get_detections("door")
            gts = gt_for(name)
            tp = fp = 0
            for fname, rot in frames:
                gt = gts["doors"].get(fname)
                amb = gts["ambiguous"].get(fname)
                hit = False
                for inst in dets[rot]["instances"]:
                    b = inst["box_xyxy"]
                    if gt and not hit and rl.iou(b, gt) >= 0.5:
                        hit = True
                    elif amb and rl.iou(b, amb) >= 0.3:
                        continue
                    else:
                        fp += 1
                tp += int(bool(gt) and hit)
            off = offline[cond][base]
            same = (tp, fp) == (off["tp"], off["fp"])
            if not same:
                mismatches.append(f"{name}: 운영 {tp}/{fp} vs 오프라인 {off['tp']}/{off['fp']}")
            total_tp += tp
            total_fp += fp
            print(f"[aug_e2e] {name}: 문 {tp} 오탐 {fp} (오프라인 {off['tp']}/{off['fp']}) {'일치' if same else '불일치'}", flush=True)
    print(f"\n[aug_e2e] 합계: 문 검출 {total_tp}/44, 오탐 {total_fp} | 불일치 {len(mismatches)}건")
    for m in mismatches:
        print("   ", m)


if __name__ == "__main__":
    main()
