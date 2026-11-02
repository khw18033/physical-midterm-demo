"""summary.json으로 태그별 비교 이미지(comparison.jpg)를 그린다.
노랑=파이프라인 확정 박스, 초록=GroundingDINO에서 태그가 라벨에 들어간 최고점 박스,
분홍=YOLO-World 최고점 박스, 회색=CLIP 사전 통과 후보."""
import json
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
UP = 2
CROP = (114, 80, 351, 321)  # class_finder_service.BORDER_CROP_BOX


def _box(img, b, color, text=None, thick=2):
    x1, y1, x2, y2 = [int(round(v * UP)) for v in b]
    cv2.rectangle(img, (x1, y1), (x2, y2), color, thick)
    if text:
        cv2.putText(img, text, (x1 + 3, max(14, y1 + 16)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)


def main():
    s = json.loads((HERE / "summary.json").read_text(encoding="utf-8"))
    full = cv2.imread(str(HERE.parent / s["frame"]))
    cl, ct, cr, cb = CROP
    base = cv2.resize(full[ct:cb, cl:cr], None, fx=UP, fy=UP, interpolation=cv2.INTER_CUBIC)
    panels = []
    for tag, v in s["tags"].items():
        img = base.copy()
        raw = v["raw_provider_outputs"]
        for d in raw["dictionary"]:
            _box(img, d["box_xyxy"], (170, 170, 170), None, 1)
        gd = [d for d in raw["grounding_dino"] if tag in d["label"]]
        if gd:
            b = max(gd, key=lambda d: d["score"])
            _box(img, b["box_xyxy"], (0, 200, 0), f"GDINO {b['score']:.2f}")
        if raw["yolo_world"]:
            b = max(raw["yolo_world"], key=lambda d: d["score"])
            _box(img, b["box_xyxy"], (200, 0, 200), f"YW {b['score']:.2f}")
        for inst in v["instances"]:
            _box(img, inst["box_xyxy"], (0, 220, 255), "confirmed", 2)
        cv2.rectangle(img, (0, 0), (img.shape[1], 26), (0, 0, 0), -1)
        cv2.putText(img, tag, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 1, cv2.LINE_AA)
        panels.append(img)
    rows = [np.hstack(panels[i:i + 3]) for i in range(0, len(panels), 3)]
    cv2.imwrite(str(HERE / "comparison.jpg"), np.vstack(rows))


if __name__ == "__main__":
    main()
