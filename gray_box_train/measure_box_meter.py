"""box_meter/ 실측 거리 사진으로 거리 계산식을 검증·재보정한다 (2026-11-01).

파일명 = 실측 거리(<거리>cm<번호>.jpg, 사용자가 로봇으로 직접 잼). 장마다:
- 2차 모델(yolov8n_graybox_v2)로 박스 검출 (crop 237x241 좌표)
- 기존 잠정 계수(distance_fit.json, UniDepth+보정식에 맞춘 값)의 크기 기반 거리
- UniDepth + calibrate_depth_to_cm 거리 (navigate_to_target_service와 같은 경로)
결과: box_meter_raw.json, box_meter_sheet.jpg
"""
import json
import math
import re
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SRC = REPO / "box_meter"
sys.path.insert(0, str(REPO / "demo" / "test"))

import navigate_to_target_service as nav  # noqa: E402  (ctypes 우회가 torch보다 먼저 돌아야 함)
from ultralytics import YOLO  # noqa: E402

nav.FRAME_SOURCE_DIR = SRC
CROP = (114, 80, 351, 321)
IMG_W, IMG_H = 464, 400
EDGE_PX = 2.0
fit = json.loads((HERE / "distance_fit.json").read_text(encoding="utf-8"))["with_radial_term"]
model = YOLO(str(HERE / "runs" / "yolov8n_graybox_v2" / "weights" / "best.pt"))


def main():
    navigator = nav.NavigateToTargetService()
    rows, tiles = [], []
    for p in sorted(SRC.glob("*.jpg"), key=lambda p: (int(re.match(r"(\d+)cm", p.name).group(1)), p.name)):
        gt = float(re.match(r"(\d+)cm", p.name).group(1))
        full = cv2.imread(str(p))
        assert full.shape[:2] == (IMG_H, IMG_W), (p.name, full.shape)
        im = full[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        r = model.predict(im, conf=0.10, imgsz=256, verbose=False)[0]
        dets = sorted([{"box_xyxy": [round(v, 1) for v in b.xyxy[0].tolist()], "score": round(float(b.conf[0]), 3)}
                       for b in r.boxes], key=lambda d: -d["score"])
        row = {"frame": p.name, "gt_cm": gt, "detections": dets}
        vis = cv2.resize(im, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        if dets:
            x1, y1, x2, y2 = dets[0]["box_xyxy"]
            cx, cy = (x1 + x2) / 2 + CROP[0], (y1 + y2) / 2 + CROP[1]
            rr = min(1.0, math.hypot((cx - IMG_W / 2) / (IMG_W / 2), (cy - IMG_H / 2) / (IMG_H / 2)))
            cut = y1 <= EDGE_PX or y2 >= (CROP[3] - CROP[1]) - EDGE_PX
            size_cm = None if cut else fit["k"] / (y2 - y1) * (1 + fit["a"] * rr * rr)
            rel, ud_cm, in_range = navigator._measure_depth_cm(p.name, dets[0]["box_xyxy"])
            row.update({"h_px": round(y2 - y1, 1), "w_px": round(x2 - x1, 1), "r": round(rr, 3),
                        "cut_top_or_bottom": cut,
                        "size_based_cm_old_coef": None if size_cm is None else round(size_cm, 1),
                        "unidepth_cm": None if ud_cm is None else round(ud_cm, 1),
                        "unidepth_rel_depth": rel, "unidepth_in_calibration_range": in_range})
            cv2.rectangle(vis, (int(x1 * 2), int(y1 * 2)), (int(x2 * 2), int(y2 * 2)), (0, 220, 255), 2)
        navigator._depth_cache.clear()
        lines = [f"{p.stem}  GT {gt:.0f}cm",
                 f"h={row.get('h_px')}px  det={dets[0]['score'] if dets else '-'}",
                 f"size(old) {row.get('size_based_cm_old_coef')}",
                 f"unidepth  {row.get('unidepth_cm')}"]
        for i, t in enumerate(lines):
            cv2.putText(vis, t, (5, 18 + 20 * i), 0, 0.55, (0, 0, 0), 3)
            cv2.putText(vis, t, (5, 18 + 20 * i), 0, 0.55, (255, 255, 255), 1)
        tiles.append(vis)
        rows.append(row)
        print(json.dumps({k: v for k, v in row.items() if k != "detections"}, ensure_ascii=False))
    tiles += [np.zeros_like(tiles[0])] * (-len(tiles) % 5)
    cv2.imwrite(str(HERE / "box_meter_sheet.jpg"), np.vstack([np.hstack(tiles[i:i + 5]) for i in range(0, len(tiles), 5)]))
    (HERE / "box_meter_raw.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
