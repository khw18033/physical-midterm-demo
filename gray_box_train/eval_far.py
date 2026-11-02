"""먼 거리 촬영(box_2m / box_2.5m / box_3m)의 검증 구간으로 검출률과 거리를 본다 (2026-11-02).

build_dataset_far.py가 검증으로 뗀 시간 구간(10구간 중 VAL_BLOCKS)의 프레임 전부(라벨을 단 3장 간격 프레임)를 쓴다 --
GDINO 라벨이 통과한 프레임만 쓰면 GDINO가 놓친 어려운 장면(옆면·역광)이 빠져 검출률이 부풀려진다.
이 구간은 v5 학습에 들어가지 않는다. 박스가 화면 밖이거나 사람에 가린 장면도 섞여 있어 검출률 100%가 상한은 아니다.
거리: distance_fit_gt_<run>.json의 d = k/h - c(box_meter 실측으로 맞춘 값)로 계산해 폴더 거리와 비교한다.
폴더 거리는 카메라 렌즈 기준이지만 측면 이동 중 몇 cm씩 달라졌다(사용자, 2026-11-02) -- 정답이 아니라 대략값이다.
사용: python eval_far.py <run> [<run> ...]
결과: far_eval.json
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FOLDERS = {"box_2m": 200.0, "box_2.5m": 250.0, "box_3m": 300.0}
CROP = (114, 80, 351, 321)
CONF, IMGSZ = 0.25, 256
N_BLOCKS, VAL_BLOCKS = 10, {3, 8}
EDGE_PX = 2.0


def main():
    runs = sys.argv[1:] or ["yolov8n_graybox_v4"]
    out = {"conf": CONF, "imgsz": IMGSZ, "val_blocks": sorted(VAL_BLOCKS), "runs": {}}
    for run in runs:
        model = YOLO(str(HERE / "runs" / run / "weights" / "best.pt"))
        fit_p = HERE / f"distance_fit_gt_{run}.json"
        fit = json.loads(fit_p.read_text(encoding="utf-8"))["model_B_pinhole_offset"] if fit_p.exists() else None
        res = {}
        for folder, gt in FOLDERS.items():
            recs = [json.loads(l) for l in open(HERE / f"labels_{folder}.jsonl", encoding="utf-8")]
            n_max = max(r["n"] for r in recs)
            val = [r for r in recs if (r["n"] - 1) * N_BLOCKS // n_max in VAL_BLOCKS]
            det, hs, ds = 0, [], []
            for r in val:
                im = cv2.imread(str(REPO / folder / "frames" / r["frame"]))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
                p = model.predict(im, conf=CONF, imgsz=IMGSZ, verbose=False)[0]
                if not len(p.boxes):
                    continue
                det += 1
                x1, y1, x2, y2 = p.boxes[int(p.boxes.conf.argmax())].xyxy[0].tolist()
                if y1 > EDGE_PX and y2 < CROP[3] - CROP[1] - EDGE_PX:
                    hs.append(y2 - y1)
                    if fit:
                        ds.append(fit["k"] / (y2 - y1) - fit["c_cm"])
            res[folder] = {"frames": len(val), "detected": det, "rate": round(det / len(val), 3) if val else None,
                           "h_px_median": round(float(np.median(hs)), 1) if hs else None,
                           "distance_cm_median": round(float(np.median(ds)), 1) if ds else None,
                           "distance_cm_p10_p90": [round(float(v), 1) for v in np.percentile(ds, [10, 90])] if ds else None,
                           "folder_cm": gt}
        out["runs"][run] = {"distance_fit": fit and {"k": fit["k"], "c_cm": fit["c_cm"]}, "folders": res}
    (HERE / "far_eval.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    for run, v in out["runs"].items():
        for f, r in v["folders"].items():
            print(run, f, f"{r['detected']}/{r['frames']}", "h", r["h_px_median"], "d", r["distance_cm_median"])


if __name__ == "__main__":
    main()
