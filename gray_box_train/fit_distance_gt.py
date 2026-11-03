"""box_meter/ 실측 거리로 크기 기반 거리 계산식을 맞춘다 (2026-11-01).

distance_fit.json의 계수는 정답 없이 UniDepth+보정식에 맞춘 잠정치였다. 사용자가 박스 정면 50/100/150/200cm에서
로봇으로 찍은 10장(파일명 = 실측 거리)으로 다시 맞춘다.
- 높이 h_px = 박스 앞면(39cm). 카메라가 바닥보다 높고 박스 윗면보다 낮아(시연 로봇) 윗면·아랫면이 안 보이므로
  세로 박스 = 앞면이다.
- 모델 A(핀홀): d = k / h            -- k = f_px * 39
- 모델 B(핀홀 + 기준점 차이): d = k / h - c  -- c = 실측 기준점(로봇 앞 등)과 카메라 광학 중심의 거리 차
- 어안 보정항(a*r^2)은 맞추지 않는다: 10장 모두 박스가 화면 중앙 근처(r 0.19~0.26)라 a를 정할 수 없다.
- 정확도는 leave-one-distance-out으로 잰다: 한 거리의 사진을 통째로 빼고 나머지로 맞춰 그 거리를 예측.
  (사진이 4개 거리 10장뿐이라 전체로 맞춘 오차는 낙관적이다.)
2026-11-02 밤: 줄자로 잰 먼 거리 영상(box_*·sidebox_* 2/2.5/3m)을 폴더마다 점 하나(가운데 프레임 h_px 중앙값)로 더한다
(video_points). 그래서 검증 범위(lodo_detail의 gt_cm 최소~최대)가 50~300cm가 된다.
사용: python fit_distance_gt.py <run이름> <imgsz>
결과: distance_fit_gt_<run>.json
"""
import json
import math
import re
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "box_meter"
RUN = sys.argv[1] if len(sys.argv) > 1 else "yolov8n_graybox_v3"
IMGSZ = int(sys.argv[2]) if len(sys.argv) > 2 else 256
CONF = 0.25
CROP = (114, 80, 351, 321)
IMG_W, IMG_H = 464, 400
BOX_H_CM = 39.0
EDGE_PX = 2.0
# 줄자로 잰 먼 거리 영상(video_points): build_dataset_far.py와 같은 폴더·검증 구간. 폴더 이름 = 줄자 거리(사용자, 2026-11-02)
VIDEO_FOLDERS = {"box_2m": 200.0, "box_2.5m": 250.0, "box_3m": 300.0,
                 "sidebox_2m": 200.0, "sidebox_2.5m": 250.0, "sidebox_3m": 300.0}
VIDEO_BLOCKS, VIDEO_VAL_BLOCKS = 10, {3, 8}
CENTER_PX = 25.0  # 원본 프레임 가로 중앙에서 ±25px ≈ ±10° (f ≈ 135px)
VIDEO_MIN_FRAMES = 10
GROUND_A, GROUND_B, GROUND_TOL = 0.803, 135.7, 12.0
old = json.loads((HERE / "distance_fit.json").read_text(encoding="utf-8"))["with_radial_term"]


def fit_a(h, d):  # d = k/h, 로그 오차 최소 -> k = exp(mean(log(d*h)))
    return float(np.exp(np.mean(np.log(d * h))))


def fit_b(h, d):  # d = k/h - c, 최소제곱
    X = np.stack([1 / h, -np.ones_like(h)], axis=1)
    (k, c), *_ = np.linalg.lstsq(X, d, rcond=None)
    return float(k), float(c)


def video_points(model):
    """줄자로 잰 먼 거리 영상을 거리식 맞춤 점으로 쓴다 -- 폴더 하나 = 점 하나 (2026-11-02 밤).

    왜: 수신기의 calibration_range가 box_meter 최대 200cm만 보고 있어, 2·2.5·3m 영상을 학습에 넣었는데도 3m가 「검증 범위 밖」으로
    나왔다(사용자 지적). 사용자 확인으로 폴더 이름의 거리는 전부 줄자 실측이다(box_*·sidebox_*). 그래서 확인용이 아니라 맞춤 점으로 넣는다.
    - 옆으로 다니는 동안 정면 거리가 몇 cm씩 변하고(사용자), 옆으로 비켜서면 직선거리가 늘어난다 -> 박스가 화면 가운데
      (|cx − W/2| ≤ CENTER_PX, 약 ±10°)인 프레임만 쓰고, 프레임 하나하나가 아니라 폴더의 h_px 중앙값 하나를 점으로 둔다
      (프레임 수천 장이 box_meter 14장을 묻어 버리지 않게, 한 거리 빼기 검증이 거리 단위로 돌게).
    - 프레임은 build_dataset_far.py가 검증으로 뗀 구간(VAL_BLOCKS)만 -- 학습에 안 들어간 그림이다.
    - 바닥 관계(±12px)를 못 넘는 검출(사람이 박스를 들고 있는 장면 등)은 뺀다."""
    rows = []
    for folder, gt in VIDEO_FOLDERS.items():
        lp = HERE / f"labels_{folder}.jsonl"
        if not lp.is_file():
            continue
        recs = [json.loads(line) for line in open(lp, encoding="utf-8")]
        n_max = max(r["n"] for r in recs)
        hs, rs = _center_heights(model, folder, recs, n_max, VIDEO_VAL_BLOCKS)
        blocks = "val"
        if len(hs) < VIDEO_MIN_FRAMES:
            # sidebox_*는 검증 구간(3·8)이 마침 박스가 가장자리에 있는 때라 가운데 프레임이 거의 없다(2026-11-02 밤: 0·0·3장).
            # 그때만 전 구간(학습 구간 포함)의 가운데 프레임을 쓰고 blocks="all"로 적는다. 거리식은 박스 높이만 쓰고, 높이는
            # 학습 구간이라고 크게 치우치지 않는다(box_*에서 v8(sidebox 미학습)과 v9 점 차이 0.1~0.3px).
            hs, rs = _center_heights(model, folder, recs, n_max, set(range(VIDEO_BLOCKS)))
            blocks = "all"
        if len(hs) < VIDEO_MIN_FRAMES:
            continue
        rows.append({"frame": f"{folder} (가운데 {len(hs)}프레임 h_px 중앙값)", "gt_cm": gt, "detected": True,
                     "kind": "video_median", "frames_used": len(hs), "blocks": blocks,
                     "h_px": round(float(np.median(hs)), 2),
                     "h_px_p10_p90": [round(float(v), 2) for v in np.percentile(hs, [10, 90])],
                     "r": round(float(np.median(rs)), 3), "cut": False})
    return rows


def _center_heights(model, folder, recs, n_max, blocks):
    hs, rs = [], []
    for r in recs:
        if (r["n"] - 1) * VIDEO_BLOCKS // n_max not in blocks:
            continue
        im = cv2.imread(str(HERE.parent / folder / "frames" / r["frame"]))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        p = model.predict(im, conf=CONF, imgsz=IMGSZ, verbose=False)[0]
        if not len(p.boxes):
            continue
        x1, y1, x2, y2 = p.boxes[int(p.boxes.conf.argmax())].xyxy[0].tolist()
        cx, cy = (x1 + x2) / 2 + CROP[0], (y1 + y2) / 2 + CROP[1]
        if y1 <= EDGE_PX or y2 >= (CROP[3] - CROP[1]) - EDGE_PX or abs(cx - IMG_W / 2) > CENTER_PX:
            continue
        if abs(y2 - (GROUND_A * (y2 - y1) + GROUND_B)) > GROUND_TOL:
            continue
        hs.append(y2 - y1)
        rs.append(min(1.0, math.hypot((cx - IMG_W / 2) / (IMG_W / 2), (cy - IMG_H / 2) / (IMG_H / 2))))
    return hs, rs


def main():
    model = YOLO(str(HERE / "runs" / RUN / "weights" / "best.pt"))
    rows = []
    for p in sorted(SRC.glob("*.jpg")):
        gt = float(re.match(r"(\d+)cm", p.name).group(1))
        im = cv2.imread(str(p))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        r = model.predict(im, conf=CONF, imgsz=IMGSZ, verbose=False)[0]
        b = max(r.boxes, key=lambda b: float(b.conf[0]), default=None)
        row = {"frame": p.name, "gt_cm": gt, "detected": b is not None}
        if b is not None:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            cx, cy = (x1 + x2) / 2 + CROP[0], (y1 + y2) / 2 + CROP[1]
            row.update({"score": round(float(b.conf[0]), 3), "box_xyxy": [round(v, 1) for v in (x1, y1, x2, y2)],
                        "h_px": round(y2 - y1, 2),
                        "r": round(min(1.0, math.hypot((cx - IMG_W / 2) / (IMG_W / 2), (cy - IMG_H / 2) / (IMG_H / 2))), 3),
                        "cut": y1 <= EDGE_PX or y2 >= (CROP[3] - CROP[1]) - EDGE_PX})
        rows.append(row)
    rows += video_points(model)
    use = [x for x in rows if x["detected"] and not x["cut"]]
    h = np.array([x["h_px"] for x in use])
    d = np.array([x["gt_cm"] for x in use])

    k_a = fit_a(h, d)
    k_b, c_b = fit_b(h, d)
    for x in use:
        x["pred_A_cm"] = round(k_a / x["h_px"], 1)
        x["pred_B_cm"] = round(k_b / x["h_px"] - c_b, 1)
        x["pred_old_coef_cm"] = round(old["k"] / x["h_px"] * (1 + old["a"] * x["r"] ** 2), 1)

    # leave-one-distance-out
    lodo = {"A": [], "B": []}
    for g in sorted(set(d)):
        tr, te = d != g, d == g
        if len(set(d[tr])) < 2:
            continue
        ka = fit_a(h[tr], d[tr])
        kb, cb = fit_b(h[tr], d[tr])
        for hh in h[te]:
            lodo["A"].append({"gt_cm": g, "pred_cm": round(ka / hh, 1)})
            lodo["B"].append({"gt_cm": g, "pred_cm": round(kb / hh - cb, 1)})

    def err(items):
        if not items:  # 검출된 거리가 2개 이하면 한 거리를 빼고 맞출 수 없다
            return None
        e = np.array([abs(i["pred_cm"] - i["gt_cm"]) for i in items])
        pe = np.array([abs(i["pred_cm"] - i["gt_cm"]) / i["gt_cm"] for i in items])
        return {"mean_abs_cm": round(float(e.mean()), 1), "max_abs_cm": round(float(e.max()), 1),
                "mean_abs_pct": round(float(pe.mean()) * 100, 1)}

    old_items = [{"gt_cm": x["gt_cm"], "pred_cm": x["pred_old_coef_cm"]} for x in use]
    out = {
        "run": RUN, "imgsz": IMGSZ, "conf": CONF,
        "frames": len(rows), "detected": sum(x["detected"] for x in rows), "used": len(use),
        "model_A_pinhole": {"formula": "d = k / h_px", "k": round(k_a, 1),
                            "implied_focal_px": round(k_a / BOX_H_CM, 1),
                            "leave_one_distance_out": err(lodo["A"]), "lodo_detail": lodo["A"]},
        "model_B_pinhole_offset": {"formula": "d = k / h_px - c", "k": round(k_b, 1), "c_cm": round(c_b, 1),
                                   "implied_focal_px": round(k_b / BOX_H_CM, 1),
                                   "leave_one_distance_out": err(lodo["B"]), "lodo_detail": lodo["B"]},
        "points": {"box_meter_photos": sum(1 for x in use if x.get("kind") is None),
                   "video_medians": sum(1 for x in use if x.get("kind") == "video_median"),
                   "video_center_px": CENTER_PX, "video_val_blocks": sorted(VIDEO_VAL_BLOCKS)},
        "old_coef_vs_gt": err(old_items),
        "per_frame": rows,
    }
    (HERE / f"distance_fit_gt_{RUN}.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in out.items() if k not in ("per_frame",)}, ensure_ascii=False, indent=1))
    for x in rows:
        print(x["frame"], x.get("h_px"), x.get("pred_B_cm"), x.get("pred_old_coef_cm"))


if __name__ == "__main__":
    main()
