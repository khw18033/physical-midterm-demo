"""2차 모델(yolov8n_graybox_v2) 검출 + 박스 크기 기반 거리를 한 장에 그린다 (2026-10-27).

거리 = k / h_px * (1 + a * r^2), k·a는 distance_fit.json의 with_radial_term(UniDepth+보정식에 맞춘 값이라
절대 cm는 그 보정식 수준이다). 박스가 crop 위/아래 끝에 닿으면 높이를 못 재므로 거리를 내지 않는다
(navigate_to_target_service의 "못 구하면 정직하게 실패" 원칙과 같다).
"""
import json
import math
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "20261026_211320" / "frames"
CROP = (114, 80, 351, 321)
IMG_W, IMG_H = 464, 400
EDGE_PX = 2.0
fit = json.loads((HERE / "distance_fit.json").read_text(encoding="utf-8"))["with_radial_term"]
K, A = fit["k"], fit["a"]
model = YOLO(str(HERE / "runs" / "yolov8n_graybox_v2" / "weights" / "best.pt"))


def size_based_distance_cm(box):
    """(distance_cm 또는 None, reason)"""
    x1, y1, x2, y2 = box
    H = CROP[3] - CROP[1]
    if y1 <= EDGE_PX or y2 >= H - EDGE_PX:
        return None, "박스가 화면 위/아래 끝에 닿아 높이를 잴 수 없음"
    cx, cy = (x1 + x2) / 2 + CROP[0], (y1 + y2) / 2 + CROP[1]
    r = min(1.0, math.hypot((cx - IMG_W / 2) / (IMG_W / 2), (cy - IMG_H / 2) / (IMG_H / 2)))
    return K / (y2 - y1) * (1 + A * r * r), None


def main():
    frames = sorted(SRC.glob("*.jpg"))
    pick = [frames[i] for i in np.linspace(0, len(frames) - 1, 32).astype(int)]
    tiles, rows = [], []
    for p in pick:
        im = cv2.imread(str(p))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        r = model.predict(im, conf=0.25, imgsz=256, verbose=False)[0]
        vis = cv2.resize(im, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        rec = {"frame": p.name, "detections": []}
        for b in r.boxes:
            box = b.xyxy[0].tolist()
            d, why = size_based_distance_cm(box)
            rec["detections"].append({"box_xyxy": [round(v, 1) for v in box], "score": round(float(b.conf[0]), 3),
                                      "distance_cm": None if d is None else round(d, 1), "reason": why})
            x1, y1, x2, y2 = [int(v * 2) for v in box]
            color = (0, 220, 255) if d is not None else (0, 140, 255)
            cv2.rectangle(vis, (x1, y1), (x2, y2), color, 2)
            label = f"{d:.0f}cm" if d is not None else "n/a (cut)"
            cv2.rectangle(vis, (x1, max(0, y1 - 22)), (x1 + 12 * len(label), y1), (0, 0, 0), -1)
            cv2.putText(vis, label, (x1 + 3, max(16, y1 - 5)), 0, 0.6, color, 2)
        cv2.putText(vis, p.stem, (4, 474), 0, 0.5, (255, 255, 255), 1)
        tiles.append(vis)
        rows.append(rec)
    sheet = np.vstack([np.hstack(tiles[i:i + 8]) for i in range(0, len(tiles), 8)])
    cv2.imwrite(str(HERE / "demo_distance.jpg"), sheet)
    (HERE / "demo_distance.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
