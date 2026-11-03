"""demo/test/mqtt_box_receiver.py

implements: 로봇 실연동 -- **학습한 gray box 전용 YOLO**로 박스를 찾고, 박스 높이로 거리를 낸다 (2026-11-01).

`mqtt_stream_receiver.py`(문 탐지)와 받는 쪽은 같다 -- 같은 브로커·토픽·판(scan round) 규약
(`detection-protocol_0914.md`)이고, 파싱·접속 함수는 그 파일에서 그대로 가져다 쓴다.
다른 것은 프레임을 넘기는 곳이다.

- **4-provider 파이프라인(class_finder_service)과 위치 추정·경로(navigate_to_target_service)는
  부르지 않는다.** 학습 모델은 아직 그 파이프라인에 연결돼 있지 않고(gray_box_train/RESULT.md 한계 4),
  그 사전(CLIP) 항목으로 돌리면 대표 박스가 맞는 장이 69%뿐이었다(class_features.json
  `gray box`.eval_2026-10-27). 그래서 "지금까지 학습된 것"을 로봇 프레임에 바로 돌려 보는
  별도 진입점으로 둔다. 파이프라인 본체는 건드리지 않는다.
- 산출물은 `try1/`이 아니라 `try_box/`에 쓴다. try1은 문 탐지 결과라 섞이면 안 된다.
  관제 웹은 `detect_api_server.py`가 `target=box`일 때 try_box/를 읽어 문 편과 같은 모양으로
  가져간다(2026-11-02) -- 그 어댑터가 이 파일의 evidence.json·scan_summary.json 모양과
  `_clear_previous_run()`(새 판에 폴더 비움 = 웹의 「지난 판」 판정 기준)에 기대므로 바꿀 때 같이 본다.

거리 계산 (gray_box_train/RESULT.md 4절, distance_fit_gt_<run>.json의 model_B_pinhole_offset):

    distance_cm = k / h_px − c

h_px는 테두리 crop(237×241) 좌표에서 잰 박스 높이(앞면 39cm)다. k·c는 box_meter/의 실측 사진(v5: 50~200cm
정면·옆면 14장)으로 맞춘 값이라 **그 run·그 imgsz로 검출할 때만** 맞는다 -- 그래서 run 이름을 주면 가중치와
계수, imgsz를 같은 run의 파일에서 함께 읽는다. 박스가 crop 위/아래 끝에 닿으면 높이를 못 재므로
거리를 내지 않고 사유를 적는다(navigate_to_target_service의 "못 구하면 정직하게 실패" 원칙).

판단 근거 (2026-11-02, 박스판단근거_가시화계획_261102.md -- 관제 웹이 문 편처럼 「왜」를 그리게):
- 검출마다 `gates`: score_gate(박스 판정, score ≥ conf) · ground_gate(박스 판정, 바닥에 놓인 박스의 아랫변 위치인가,
  2026-11-02~) · height_gate(높이를 잴 수 있나) · calibration_range(거리가 실측 검증 범위 안인가, 참고).
  각 관문에 값·식·대입·화면 문장(`words`).
- 프레임마다 `rejected_candidates`: conf 아래로 버린 후보(CANDIDATE_CONF 이상, 상위 MAX_REJECTED개) -- 못 찾은 이유.
- 프레임마다 `rejected_by_gates`(2026-11-02~): score는 넘었지만 required 관문(지금은 ground_gate)에 떨어져 버린 검출,
  `gates` 전부와 함께. rejected_candidates와 섞지 않는다 -- 그쪽은 「conf 아래」라는 뜻으로 API·웹이 이미 쓴다.
- 그림: overlay.jpg에 버린 후보(회색 점선)·관문에 떨어진 검출(빨간 점선)과 관문 판정 띠, found면 crop.jpg(대표 박스).
- 판 끝에 `navigation/evidence.json`: 경로 근거(detect_api_server.box_path_from_summary와 같은 계산).

방위각은 참고값이다: rotation_deg + atan((박스 중심x − 화면 중심x) / f), f = k / 39(계수에 함의된
초점거리 px). 어안 보정을 못 정했고(RESULT.md 4절 -- 실측 14장이 모두 화면 중앙) 가장자리 정확도는
미검증이다.

규약에서 지키는 것(mqtt_stream_receiver.py와 같다 -- 완화하지 말 것):
- `duplicate_of_prev`가 붙었거나 판 안에서 sha1이 겹친 프레임이 있으면 그 판의 요약은 "버림"으로 낸다.
- 각도는 `rotation_deg`만 쓴다(`yaw_deg`는 판마다 기준점이 옮겨진다).

실행:
    python mqtt_box_receiver.py                              # 로봇 실연동 (기본 run = yolov8n_graybox_v9)
    python mqtt_box_receiver.py --replay ..\\..\\box_meter      # 로봇 없이 폴더의 jpg를 한 판으로 재생
    python mqtt_box_receiver.py --run yolov8n_graybox_v2     # 다른 학습 결과로
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import queue
import shutil
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from detect_api_server import box_path_from_summary
from mqtt_stream_receiver import (BROKER_WS_URL, EXPECTED_FRAME_COUNT, FRAME_TOPIC, SCAN_TOPIC,
                                  SUBSCRIBE_QOS, ParsedFrame, ScanEvent, _connect_or_explain,
                                  _make_client, parse_frame_message, parse_scan_message)

REPO_ROOT = Path(__file__).resolve().parents[2]
TRAIN_DIR = REPO_ROOT / "gray_box_train"
RUN_DIR = Path(__file__).resolve().parent / "try_box"
INCOMING_DIR = RUN_DIR / "incoming"
SUMMARY_PATH = RUN_DIR / "scan_summary.json"
NAV_DIR = RUN_DIR / "navigation"   # 판이 끝나면 경로 근거(detect_api_server.box_path_from_summary)를 여기 남긴다

# class_finder_service / navigate_to_target_service의 BORDER_CROP_BOX, 학습·계수 맞춤(fit_distance_gt.py)과 같은 값.
BORDER_CROP_BOX = (114, 80, 351, 321)
IMAGE_W = 464                 # 로봇 카메라 464×400 (CLAUDE.md)
BOX_HEIGHT_CM = 39.0          # 회색 천 박스 앞면 높이 (RESULT.md)
EDGE_PX = 2.0                 # crop 끝에서 이만큼 안이면 "잘렸다"로 본다 (fit_distance_gt.py와 같다)
# 2026-11-02 v3 -> v5(gray_box_train/학습보고서_261102.md): 실연동 고정 세트 4/8 -> 8/8, 복도 2~3m 검출 0~3% -> 100%,
# box_meter 14장 전부 검출(v3는 200cm·옆면 100cm 이상을 놓쳤다). 대신 사람 등·책상 다리 오탐이 생겼다
# (박스 없는 장면 학습 필요). 이전 동작이 필요하면 --run yolov8n_graybox_v3.
# 2026-11-02 v5 -> v7(같은 보고서 8절): 박스 없는 연구실 영상 2개를 음성으로 더해 책상 다리·검은 백팩 오탐을 줄였다.
# 실연동 고정 세트 박스 10/10 + 엉뚱한 검출 0(v5는 2), 2~3m 검출·거리 유지. 거리식 k 5266.8 / c 6.3(box_meter 평균 오차 3.0cm).
# 2026-11-02 v7 -> v8(같은 보고서 9절): 다른 배경에 붙인 박스(먼 박스 포함)·장소 색감 증강 2,500장 추가. 실연동 10/10·오탐 0 유지,
# crop 가장자리 박스 검출 279 -> 308/348, box_meter 오차 평균 3.0 -> 2.4cm(최대 10.4 -> 7.5), 색감 변환 오탐 3 -> 0/85.
# 2026-11-03 v8 -> v9(같은 보고서 10·11절): 복도 왕복 영상(sidebox 2/2.5/3m)을 더 학습. 실내 시험은 v8과 비슷했지만, 하얗게
# 날아간 야외 옥상(2026-11-03 임무 4건)에서 박스(높이 14~20px, 계산 거리 2.6~3.7m)를 v8은 1/8, v9는 7/8 잡았다. 대신 연구실 검은 백팩
# 0.40 같은 오탐이 조금 늘었다(경로는 가장 높은 점수 방향이라 진짜 박스가 보이면 영향 없음). 이전 동작은 --run yolov8n_graybox_v8.
DEFAULT_RUN = "yolov8n_graybox_v9"
DEFAULT_CONF = 0.25           # 계수를 맞출 때 쓴 값
# 2026-11-02 판단 근거(박스판단근거_가시화계획_261102.md 6절): 「왜 못 찾았나」를 남기려고 conf 아래 후보도
# 이 값까지 내려 받아 score 상위 몇 개만 기록한다. 판정은 여전히 conf(0.25)로만 한다 -- 후보는 버린 근거일 뿐이다.
# ultralytics는 conf로 먼저 거르고 NMS를 하므로 conf 이상 검출은 그대로다(2026-11-02 box_meter 14장 +
# 실로봇 두 판 11장으로 전후 detections가 같은 것을 확인).
CANDIDATE_CONF = 0.05
MAX_REJECTED = 3
# 2026-11-02 바닥 관계(gray_box_train/학습보고서_261102.md 5절): 이 카메라 높이에서 바닥에 놓인 박스는 겉보기 높이 h_px에 따라
# 아랫변 y2가 정해진다. 학습 라벨 2,915개로 맞춘 y2 = A·h + B(잔차 5~95% −3.5~4.5px). v5 검출의 잔차는 진짜 박스에서
# box_meter −4.8~−1.4, 원래 영상 −4.1~7.3, 2.5m·3m −5.9~1.3, 2m −11.7~0.5(1~99%)이고 오탐은 사람 등 −66, 책상 상판 −117,
# 공중 물체 −131px였다 -> 허용 ±12px. 로봇 자세(머리 숙임)가 바뀌면 B가 움직이므로 실측 사진이 바뀌면 다시 잰다.
# 책상 다리·백팩처럼 바닥에 선 오탐은 이 관문으로 못 거른다(학습으로 막는다 -- v6·v7).
GROUND_A, GROUND_B, GROUND_TOL_PX = 0.803, 135.7, 12.0
# 2026-11-03 모양 관문(shape_gate): 실연동 판 270°에서 crop 왼쪽 끝 검은 가방(너비 17 × 높이 114px, 폭/높이 0.15)이 0.46점으로
# 박스가 됐다. 박스는 앞면 59.3×39cm(1.52), 좁은 옆면만 보여도 21/39 = 0.54라, 화면 안에 다 들어온 박스는 이보다 가늘 수 없다.
# 학습 라벨에서 끝에 안 닿은 박스의 폭/높이는 최소 0.44(증강), 실제 영상 0.49 -> ASPECT_MIN 0.40.
# 끝에 잘린 박스는 학습 라벨에도 0.09까지 있다(연구실 영상에서 박스를 카메라 좌우 끝에 둔 장면) -- 가방과 모양이 같아 검출기로는 못
# 가른다. 그래서 끝에 걸친 가는 조각은 박스든 아니든 버린다: crop이 보는 가로 약 80°가 회전 간격 45°보다 넓어 끝에 걸친 박스는
# 옆 각도 사진에 온전히 들어오고, 조각의 중심은 박스 중심이 아니라 방위도 틀린다. 0.35 = 옆면(0.54)의 약 2/3가 보이는 정도.
ASPECT_MIN, ASPECT_MIN_EDGE_CUT = 0.40, 0.35


# ────────────────────────── 검출기 + 거리 ──────────────────────────

class BoxDetector:
    """학습 run 하나 = 가중치 + 그 가중치로 실측에 맞춘 거리 계수 + 그때의 imgsz."""

    def __init__(self, run: str, conf: float):
        weights = TRAIN_DIR / "runs" / run / "weights" / "best.pt"
        fit_path = TRAIN_DIR / f"distance_fit_gt_{run}.json"
        if not weights.is_file():
            raise SystemExit(f"[box] 가중치가 없다: {weights}")
        if not fit_path.is_file():
            raise SystemExit(f"[box] 실측 거리 계수가 없다: {fit_path}\n"
                             f"      gray_box_train/fit_distance_gt.py {run} <imgsz> 로 먼저 맞춘다.")
        fit = json.loads(fit_path.read_text(encoding="utf-8"))
        model_b = fit["model_B_pinhole_offset"]
        self.run = run
        self.conf = conf
        self.imgsz = int(fit["imgsz"])
        self.k = float(model_b["k"])
        self.c = float(model_b["c_cm"])
        self.focal_px = self.k / BOX_HEIGHT_CM
        # 거리식이 실측으로 검증된 범위 = 계수를 맞춘 사진의 실제 거리 최소~최대(상수로 적지 않는다 -- run마다 다르다).
        gt = [row["gt_cm"] for row in model_b.get("lodo_detail") or []]
        self.validated_cm = [min(gt), max(gt)] if gt else None
        # 2026-11-02 밤: v8까지는 box_meter(50~200cm)만 맞춤 점이라 2·2.5·3m 영상으로 학습했는데도 3m가 「범위 밖」이었다(사용자 지적).
        # 같은 날 fit_distance_gt.py가 줄자로 잰 먼 거리 영상(box_*·sidebox_*)을 맞춤 점으로 넣도록 바꾸고 v8·v9를 다시 맞춰
        # 이 범위가 50~300cm가 됐다(v8 k 5278.8/c 6.4 -> 5221.6/5.3, 학습보고서 10절).
        self.fit_source = {
            "file": str(fit_path.relative_to(REPO_ROOT)).replace("\\", "/"),
            "formula": model_b["formula"], "k": self.k, "c_cm": self.c, "imgsz": self.imgsz,
            "leave_one_distance_out": model_b.get("leave_one_distance_out"),
        }

        from ultralytics import YOLO  # 무거운 import는 여기서
        self.model = YOLO(str(weights))
        # 첫 프레임에서 CUDA 초기화로 지연되지 않게 미리 한 번 돌린다 -- 로봇은 기다려 주지 않는다.
        w = BORDER_CROP_BOX[2] - BORDER_CROP_BOX[0]
        h = BORDER_CROP_BOX[3] - BORDER_CROP_BOX[1]
        self.model.predict(np.zeros((h, w, 3), np.uint8), imgsz=self.imgsz, conf=self.conf, verbose=False)
        print(f"[box] 검출기 준비: {run} (imgsz {self.imgsz}, conf {conf}) "
              f"거리 d = {self.k:.1f} / h_px − {self.c:.1f}, 실측 검증 범위 {self.validated_cm} cm")

    def distance(self, box: list[float]) -> dict:
        x1, y1, x2, y2 = box
        crop_h = BORDER_CROP_BOX[3] - BORDER_CROP_BOX[1]
        h_px = y2 - y1
        if y1 <= EDGE_PX or y2 >= crop_h - EDGE_PX:
            return {"distance_cm": None, "h_px": round(h_px, 2),
                    "reason": "박스가 화면 위/아래 끝에 닿아 높이(39cm 앞면)를 잴 수 없음"}
        d = self.k / h_px - self.c
        return {"distance_cm": round(d, 1), "h_px": round(h_px, 2), "reason": None,
                "formula": "distance_cm = k / h_px − c",
                "substituted": f"{self.k:.1f} / {h_px:.2f} − {self.c:.1f} = {d:.1f}"}

    def bearing(self, box: list[float], rotation_deg: float) -> dict:
        cx_orig = (box[0] + box[2]) / 2 + BORDER_CROP_BOX[0]
        offset = math.degrees(math.atan((cx_orig - IMAGE_W / 2) / self.focal_px))
        bearing = (rotation_deg + offset) % 360.0
        return {"bearing_deg": round(bearing, 1), "offset_deg": round(offset, 1),
                "formula": "bearing = rotation_deg + atan((cx − W/2) / f),  f = k / 39",
                "substituted": f"{rotation_deg:g} + atan(({cx_orig:.1f} − {IMAGE_W / 2:g}) / {self.focal_px:.1f})"
                               f" = {bearing:.1f}",
                "note": "참고값 -- 어안 보정 미정, 화면 가장자리 정확도 미검증"}

    def gates(self, box: list[float], score: float, distance: dict) -> dict:
        """검출 하나의 판정 근거(2026-11-02, 박스판단근거_가시화계획_261102.md 2-1).

        처음엔 기존 비교만 적었고, 2026-11-02 바닥 관계(ground_gate)를 판정에 더했다.
          score_gate         (required)  박스라는 판정 자체: score ≥ conf
          ground_gate        (required)  바닥에 놓인 박스의 아랫변인가: |y2 − (A·h + B)| ≤ tol. 아랫변이 crop 아래 끝에
                                         닿으면 판정할 수 없어 applicable=false·통과로 두고 words에 그렇게 적는다
          shape_gate         (required)  박스 모양인가: w/h ≥ ASPECT_MIN(좌우 끝에 걸치면 ASPECT_MIN_EDGE_CUT) -- 2026-11-03
          height_gate        (조건)      높이를 잴 수 있나: 박스가 crop 위/아래 끝 EDGE_PX 안에 닿지 않았나
          calibration_range  (조건·참고) 잰 거리가 거리식의 실측 검증 범위 안인가 -- 밖이어도 거리는 쓴다(6절 2)
        `required: false`는 「박스냐」가 아니라 「거리를 믿어도 되냐」의 조건이라는 뜻이다. `words`는 관제 웹이
        그대로 찍는 문장이다. 거리를 못 쟀으면 calibration_range는 판정할 것이 없어 넣지 않는다(height_gate ✕가 이유다)."""
        crop_h = BORDER_CROP_BOX[3] - BORDER_CROP_BOX[1]
        y1, y2 = box[1], box[3]
        h_px = y2 - y1
        gates = {
            "score_gate": {
                "required": True, "passed": score >= self.conf, "score": round(score, 3), "threshold_min": self.conf,
                "formula": "passed = score ≥ conf",
                "substituted": f"{score:.3f} ≥ {self.conf:g}",
                "words": f"YOLO 점수 {score:.2f}/{self.conf:g}",
            },
        }
        cut_top, cut_bottom = y1 <= EDGE_PX, y2 >= crop_h - EDGE_PX
        expected_y2 = GROUND_A * h_px + GROUND_B
        residual = y2 - expected_y2
        if cut_bottom:
            ground = {"applicable": False, "passed": True,
                      "words": "아랫변이 화면 아래 끝에 닿아 바닥 관계를 볼 수 없음 → 판정 보류(통과로 둠)"}
        else:
            ok = abs(residual) <= GROUND_TOL_PX
            ground = {"applicable": True, "passed": ok,
                      "words": (f"바닥 위 박스 위치(아랫변 {y2:.0f}px, 기대 {expected_y2:.0f}±{GROUND_TOL_PX:g})" if ok else
                                f"바닥에 놓인 박스 위치가 아님(아랫변 {y2:.0f}px, 기대 {expected_y2:.0f}±{GROUND_TOL_PX:g}, "
                                f"{'위로' if residual < 0 else '아래로'} {abs(residual):.0f}px 벗어남)")}
        gates["ground_gate"] = {
            "required": True, **ground, "y2": round(y2, 1), "h_px": round(h_px, 2),
            "expected_y2": round(expected_y2, 1), "residual_px": round(residual, 1), "tol_px": GROUND_TOL_PX,
            "a": GROUND_A, "b": GROUND_B,
            "formula": "passed = |y2 − (a·h_px + b)| ≤ tol  (아랫변이 crop 아래 끝이면 판정 보류)",
            "substituted": (f"y2 {y2:.1f} = crop 아래 끝 → 판정 보류" if cut_bottom else
                            f"|{y2:.1f} − ({GROUND_A:g}·{h_px:.1f} + {GROUND_B:g})| = {abs(residual):.1f} "
                            f"{'≤' if abs(residual) <= GROUND_TOL_PX else '>'} {GROUND_TOL_PX:g}"),
        }
        crop_w = BORDER_CROP_BOX[2] - BORDER_CROP_BOX[0]
        w_px = box[2] - box[0]
        aspect = w_px / h_px if h_px > 0 else 0.0
        cut_lr = box[0] <= EDGE_PX or box[2] >= crop_w - EDGE_PX
        aspect_min = ASPECT_MIN_EDGE_CUT if cut_lr else ASPECT_MIN
        shape_ok = aspect >= aspect_min
        if shape_ok:
            shape_words = f"박스 모양(폭/높이 {aspect:.2f} ≥ {aspect_min:g})"
        elif cut_lr:
            shape_words = (f"화면 {'왼' if box[0] <= EDGE_PX else '오른'}쪽 끝에 걸친 가는 조각(폭/높이 {aspect:.2f} < {aspect_min:g}) "
                           f"— 박스라면 옆 각도 사진에 온전히 보인다")
        else:
            shape_words = f"박스로 보기엔 너무 가늚(폭/높이 {aspect:.2f} < {aspect_min:g}, 옆면만 보여도 0.54)"
        gates["shape_gate"] = {
            "required": True, "passed": shape_ok, "w_px": round(w_px, 2), "h_px": round(h_px, 2),
            "aspect": round(aspect, 3), "edge_cut_lr": cut_lr, "aspect_min": aspect_min,
            "formula": "passed = w_px / h_px ≥ aspect_min  (좌우 끝에 걸치면 aspect_min_edge_cut)",
            "substituted": f"{w_px:.1f} / {h_px:.1f} = {aspect:.2f} {'≥' if shape_ok else '<'} {aspect_min:g}",
            "words": shape_words,
        }
        if cut_top or cut_bottom:
            where = "위·아래" if cut_top and cut_bottom else ("위" if cut_top else "아래")
            height_words = f"높이 측정 불가 — 박스가 화면 {where} 끝에 닿음"
        else:
            height_words = f"높이 {h_px:.1f}px 측정 가능(위·아래 끝에 안 닿음)"
        gates["height_gate"] = {
            "required": False, "passed": not (cut_top or cut_bottom),
            "y1": round(y1, 1), "y2": round(y2, 1), "h_px": round(h_px, 2), "crop_h": crop_h, "edge_px": EDGE_PX,
            "formula": "passed = (y1 > edge_px) and (y2 < crop_h − edge_px)",
            "substituted": f"({y1:.1f} > {EDGE_PX:g}) and ({y2:.1f} < {crop_h} − {EDGE_PX:g})",
            "words": height_words,
        }
        d = distance.get("distance_cm")
        if d is not None and self.validated_cm is not None:
            lo, hi = self.validated_cm
            inside = lo <= d <= hi
            gates["calibration_range"] = {
                "required": False, "passed": inside, "distance_cm": d, "validated_cm": [lo, hi],
                "source": self.fit_source["file"],
                "formula": "passed = validated_min ≤ distance_cm ≤ validated_max",
                "substituted": f"{lo:g} ≤ {d:.1f} ≤ {hi:g}",
                "words": (f"실측 검증 범위 {lo:g}~{hi:g}cm 안({d:.1f}cm)" if inside
                          else f"실측 검증 범위 {lo:g}~{hi:g}cm 밖({d:.1f}cm) — 참고값"),
            }
        return gates

    def on_frame(self, frame_path: Path, rotation_deg: float) -> dict:
        image = cv2.imread(str(frame_path))
        if image is None:
            raise FileNotFoundError(frame_path)
        x0, y0, x1, y1 = BORDER_CROP_BOX
        crop = image[y0:y1, x0:x1]
        t0 = time.perf_counter()
        # conf 아래 후보까지 받고(CANDIDATE_CONF) 판정은 아래에서 self.conf로 한다.
        result = self.model.predict(crop, imgsz=self.imgsz, conf=CANDIDATE_CONF, verbose=False)[0]
        elapsed_ms = (time.perf_counter() - t0) * 1000

        detections, rejected, rejected_by_gates = [], [], []
        for b in sorted(result.boxes, key=lambda b: -float(b.conf[0])):
            box = [float(v) for v in b.xyxy[0].tolist()]
            score = float(b.conf[0])
            if score < self.conf:
                if len(rejected) < MAX_REJECTED:
                    rejected.append({"box_xyxy": [round(v, 1) for v in box], "score": round(score, 3),
                                     "threshold_min": self.conf,
                                     "words": f"후보 {score:.2f} < {self.conf:g} → 버림"})
                continue
            det = {"box_xyxy": [round(v, 1) for v in box], "score": round(score, 3)}
            det.update(self.distance(box))
            det["bearing"] = self.bearing(box, rotation_deg)
            det["gates"] = self.gates(box, score, det)
            failed = [name for name, g in det["gates"].items() if g.get("required") and not g["passed"]]
            if failed:
                det["failed_gates"] = failed
                det["words"] = " · ".join(det["gates"][name]["words"] for name in failed) + " → 버림"
                rejected_by_gates.append(det)
                continue
            detections.append(det)

        out_dir = RUN_DIR / frame_path.stem
        out_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_dir / "original.jpg"), image)
        cv2.imwrite(str(out_dir / "overlay.jpg"),
                    self._overlay(crop, detections, rejected, rejected_by_gates, rotation_deg))
        if detections:
            # 관제 웹 확대 화면의 target_crop -- 대표 박스를 테두리 crop에서 그대로 잘라 둔다(가공 없음).
            bx1, by1, bx2, by2 = detections[0]["box_xyxy"]
            ch, cw = crop.shape[:2]
            ix1, iy1 = max(0, int(bx1)), max(0, int(by1))
            ix2, iy2 = min(cw, int(math.ceil(bx2))), min(ch, int(math.ceil(by2)))
            if ix2 > ix1 and iy2 > iy1:
                cv2.imwrite(str(out_dir / "crop.jpg"), crop[iy1:iy2, ix1:ix2])
        evidence = {"frame": frame_path.name, "rotation_deg": rotation_deg, "found": bool(detections),
                    "detections": detections,
                    # 판정(conf) 아래로 버린 후보, score 내림차순 최대 MAX_REJECTED개. 비어 있으면 CANDIDATE_CONF 이상인 것조차 없었다.
                    "rejected_candidates": rejected,
                    # score는 conf 이상이지만 required 관문(ground_gate·shape_gate)에 떨어진 검출 -- gates 전부를 함께 남긴다.
                    "rejected_by_gates": rejected_by_gates,
                    "inference_ms": round(elapsed_ms, 1),
                    "detector": {"run": self.run, "conf": self.conf, "candidate_conf": CANDIDATE_CONF,
                                 "max_rejected": MAX_REJECTED, "crop_box": list(BORDER_CROP_BOX)},
                    "distance_fit": self.fit_source}
        (out_dir / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2),
                                               encoding="utf-8")
        return evidence

    def _overlay(self, crop, detections, rejected, rejected_by_gates, rotation_deg):
        """근거를 그린 그림(2026-11-02). 그림 위에는 박스·후보만 그리고, 판정 근거 문장은 아래 띠에 적어
        장면을 가리지 않는다. cv2.putText는 한글을 못 그려서 띠 문장은 영어다(같은 값이 evidence.json에 한글로 있다)."""
        scale = 2
        vis = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        for cand in rejected:  # 버린 후보: 회색 점선
            x1, y1, x2, y2 = [int(v * scale) for v in cand["box_xyxy"]]
            _dashed_rect(vis, (x1, y1), (x2, y2), (150, 150, 150))
            cv2.putText(vis, f"x {cand['score']:.2f}", (x1 + 3, min(vis.shape[0] - 4, y2 - 5)), 0, 0.45, (170, 170, 170), 1)
        for det in rejected_by_gates:  # 관문에 떨어진 검출: 빨간 점선
            x1, y1, x2, y2 = [int(v * scale) for v in det["box_xyxy"]]
            _dashed_rect(vis, (x1, y1), (x2, y2), (0, 0, 255))
            why = "/".join(n.replace("_gate", "") for n in det.get("failed_gates", []))
            cv2.putText(vis, f"x {det['score']:.2f} {why}", (x1 + 3, min(vis.shape[0] - 4, y2 - 5)), 0, 0.45,
                        (0, 0, 255), 1)
        for i, det in enumerate(detections):
            x1, y1, x2, y2 = [int(v * scale) for v in det["box_xyxy"]]
            color = (0, 220, 255) if i == 0 else (160, 160, 160)
            cv2.rectangle(vis, (x1, y1), (x2, y2), color, 2)
            dist = f"{det['distance_cm']:.0f}cm" if det["distance_cm"] is not None else "n/a(cut)"
            label = f"{det['score']:.2f} {dist}"
            cv2.rectangle(vis, (x1, max(0, y1 - 22)), (x1 + 11 * len(label), y1), (0, 0, 0), -1)
            cv2.putText(vis, label, (x1 + 3, max(16, y1 - 5)), 0, 0.55, color, 2)
        if detections and not detections[0]["gates"]["height_gate"]["passed"]:
            # 높이 관문 실패: 판정에 쓴 crop 위/아래 경계(EDGE_PX)를 빨갛게
            h = vis.shape[0]
            for y in (int(EDGE_PX * scale), h - 1 - int(EDGE_PX * scale)):
                cv2.line(vis, (0, y), (vis.shape[1] - 1, y), (0, 0, 255), 1)

        lines = [f"rot {rotation_deg:g}  (decide: score >= {self.conf:g})"]
        if detections:
            best = detections[0]
            g = best["gates"]
            mark = lambda gate: "[OK]" if gate["passed"] else "[X] "
            lines.append(f"{mark(g['score_gate'])} score {best['score']:.3f} >= {self.conf:g}")
            gg = g["ground_gate"]
            lines.append(f"{mark(gg)} ground |y2 {gg['y2']:.0f} - exp {gg['expected_y2']:.0f}| = {abs(gg['residual_px']):.0f} <= {GROUND_TOL_PX:g}"
                         if gg["applicable"] else "[OK] ground n/a (bottom at crop edge)")
            sg = g["shape_gate"]
            lines.append(f"{mark(sg)} shape w/h {sg['aspect']:.2f} >= {sg['aspect_min']:g}"
                         + (" (edge cut)" if sg["edge_cut_lr"] else ""))
            hg = g["height_gate"]
            lines.append(f"{mark(hg)} height {hg['h_px']:.1f}px  y {hg['y1']:.1f}~{hg['y2']:.1f} in ({EDGE_PX:g}, {hg['crop_h'] - EDGE_PX:g})")
            if "calibration_range" in g:
                cr = g["calibration_range"]
                lines.append(f"{mark(cr)} range {cr['validated_cm'][0]:g}~{cr['validated_cm'][1]:g}cm: {cr['distance_cm']:.1f}cm (ref)")
            if best["distance_cm"] is not None:
                lines.append(f"d = {self.k:.1f} / {best['h_px']:.2f} - {self.c:.1f} = {best['distance_cm']:.1f}cm")
            else:
                lines.append("d = n/a (box touches crop edge)")
            lines.append(f"bearing {best['bearing']['bearing_deg']:.1f} deg (ref)")
        elif rejected_by_gates:
            rj = rejected_by_gates[0]
            gg, sg = rj["gates"]["ground_gate"], rj["gates"]["shape_gate"]
            if not gg["passed"]:
                lines.append(f"[X]  {rj['score']:.2f} rejected: ground |y2 {gg['y2']:.0f} - exp "
                             f"{gg['expected_y2']:.0f}| = {abs(gg['residual_px']):.0f} > {GROUND_TOL_PX:g}")
            if not sg["passed"]:
                lines.append(f"[X]  {rj['score']:.2f} rejected: shape w/h {sg['aspect']:.2f} < {sg['aspect_min']:g}"
                             + (" (thin sliver at edge)" if sg["edge_cut_lr"] else ""))
        elif rejected:
            lines.append(f"no box >= {self.conf:g}  (best candidate {rejected[0]['score']:.2f})")
        else:
            lines.append(f"no box, no candidate >= {CANDIDATE_CONF:g}")
        band = np.zeros((10 + 20 * len(lines), vis.shape[1], 3), np.uint8)
        for i, text in enumerate(lines):
            color = (0, 0, 255) if text.startswith("[X]") else (255, 255, 255)
            cv2.putText(band, text, (6, 20 + 20 * i), 0, 0.48, color, 1)
        return np.vstack([vis, band])


def _dashed_rect(img, p1, p2, color, dash: int = 6) -> None:
    """cv2에는 점선이 없어서 짧은 선분으로 그린다(버린 후보 표시용)."""
    (x1, y1), (x2, y2) = p1, p2
    for xa in range(x1, x2, dash * 2):
        xb = min(xa + dash, x2)
        cv2.line(img, (xa, y1), (xb, y1), color, 1)
        cv2.line(img, (xa, y2), (xb, y2), color, 1)
    for ya in range(y1, y2, dash * 2):
        yb = min(ya + dash, y2)
        cv2.line(img, (x1, ya), (x1, yb), color, 1)
        cv2.line(img, (x2, ya), (x2, yb), color, 1)


# ────────────────────────── 판(scan round) 관리 ──────────────────────────

def _clear_previous_run() -> list[str]:
    """새 판이 시작되면 try_box/의 이전 판 산출물을 지운다. 프레임 폴더는 evidence.json이 든 것만 고른다.
    navigation/(경로 근거)도 지운다 -- 남기면 지난 판의 경로가 새 판 화면에 그대로 뜬다."""
    removed = []
    if not RUN_DIR.is_dir():
        return removed
    for child in sorted(RUN_DIR.iterdir()):
        if child.is_dir() and (child / "evidence.json").is_file():
            shutil.rmtree(child)
            removed.append(child.name)
    if NAV_DIR.is_dir():
        shutil.rmtree(NAV_DIR)
        removed.append(NAV_DIR.name)
    if SUMMARY_PATH.is_file():
        SUMMARY_PATH.unlink()
        removed.append(SUMMARY_PATH.name)
    if INCOMING_DIR.is_dir():
        for f in INCOMING_DIR.iterdir():
            if f.is_file():
                f.unlink()
    return removed


class BoxScanSession:
    """mqtt_stream_receiver.ScanSession과 같은 판 규칙(시작·중복·장수·종료)에 박스 검출을 붙인 것."""

    def __init__(self, detector: BoxDetector, expected_frames: int):
        self.detector = detector
        self.default_expected = expected_frames
        self.mission_id = None
        self.expected = expected_frames
        self.results: list[dict] = []
        self.rejected: list[str] = []
        self.digests: set[str] = set()
        self.active = False
        self.finished = False

    def start(self, mission_id: str | None, expected: int | None) -> None:
        self.mission_id = mission_id
        self.expected = expected or self.default_expected
        self.results = []
        self.rejected = []
        self.digests = set()
        self.active = True
        self.finished = False
        removed = _clear_previous_run()
        if removed:
            print(f"[scan] 이전 판 산출물 정리: {', '.join(removed)}")
        INCOMING_DIR.mkdir(parents=True, exist_ok=True)
        print(f"[scan] 새 판 시작 mission_id={mission_id} 예상 프레임={self.expected}장")

    def add_frame(self, parsed: ParsedFrame) -> None:
        if not self.active:
            self.start(parsed.mission_id, None)
        elif parsed.mission_id and self.mission_id and parsed.mission_id != self.mission_id:
            print(f"[scan] mission_id가 바뀌었다({self.mission_id} -> {parsed.mission_id}) -- 새 판으로 본다")
            self.start(parsed.mission_id, None)

        # ── 중복 그림 검사 (detection-protocol_0914.md §2) -- mqtt_stream_receiver와 같은 규칙 ──
        digest = hashlib.sha1(parsed.image).hexdigest()
        if parsed.duplicate_of_prev:
            reason = f"seq={parsed.index} 로봇이 duplicate_of_prev로 표시(sha1={parsed.sha1}) -- 카메라 정지 의심"
            self.rejected.append(reason)
            print(f"[scan] ✗ 프레임 버림: {reason}")
            return
        if digest in self.digests:
            reason = f"seq={parsed.index} 이 판에서 이미 나온 그림(sha1={digest[:16]})"
            self.rejected.append(reason)
            print(f"[scan] ✗ 프레임 버림: {reason}")
            return
        self.digests.add(digest)

        if len(self.results) >= self.expected:
            print(f"[scan] 이번 판에 필요한 {self.expected}장을 이미 채웠다 -- 추가 프레임 무시(seq={parsed.index})")
            return

        path = _materialize(parsed)
        ev = self.detector.on_frame(path, parsed.rotation_deg)
        self.results.append(ev)
        if ev["detections"]:
            best = ev["detections"][0]
            dist = f"{best['distance_cm']}cm" if best["distance_cm"] is not None else f"거리 없음({best['reason']})"
            print(f"[box] seq={parsed.index} 회전 {parsed.rotation_deg:g}도: 박스 {len(ev['detections'])}개, "
                  f"최고 {best['score']} {dist} 방위 {best['bearing']['bearing_deg']}도 ({ev['inference_ms']}ms)")
        else:
            print(f"[box] seq={parsed.index} 회전 {parsed.rotation_deg:g}도: 박스 없음 ({ev['inference_ms']}ms)")

        if len(self.results) >= self.expected and not self.finished:
            self.finish(outcome="SUCCEEDED", frames_sent=len(self.results), by="프레임 수 충족")

    def finish(self, outcome: str | None, frames_sent: int | None, by: str) -> None:
        if self.finished:
            return
        self.finished = True
        self.active = False

        problems = []
        if outcome and outcome.upper() != "SUCCEEDED":
            problems.append(f"로봇이 보고한 결과가 {outcome}")
        if self.rejected:
            problems.append(f"버린 프레임 {len(self.rejected)}장(중복 그림)")
        if frames_sent is not None and frames_sent != self.expected:
            problems.append(f"로봇이 보낸 장수 {frames_sent} != 예상 {self.expected}")
        if len(self.results) != self.expected:
            problems.append(f"처리한 장수 {len(self.results)} != 예상 {self.expected}")

        summary = {"mission_id": self.mission_id, "ended_by": by, "accepted": not problems,
                   "problems": problems, "rejected_frames": self.rejected,
                   "detector": {"run": self.detector.run, "conf": self.detector.conf},
                   "distance_fit": self.detector.fit_source,
                   "per_rotation": [{"rotation_deg": ev["rotation_deg"], "frame": ev["frame"],
                                     "found": ev["found"],
                                     "best": ev["detections"][0] if ev["detections"] else None}
                                    for ev in self.results]}
        if problems:
            summary["best_overall"] = None
            summary["reason"] = "판이 온전하지 않아 대표 방향을 내지 않는다(같은 그림을 여러 방향으로 오해할 수 있음)"
            print(f"\n[scan] ✗ 이 판은 버린다 ({by}) -- " + " / ".join(problems))
        else:
            found = [p for p in summary["per_rotation"] if p["best"] is not None]
            if found:
                top = max(found, key=lambda p: p["best"]["score"])
                summary["best_overall"] = top
                b = top["best"]
                dist = f"{b['distance_cm']}cm" if b["distance_cm"] is not None else f"거리 없음({b['reason']})"
                print(f"\n[scan] ✓ {len(self.results)}프레임 정상 종료 ({by}) -- 박스가 보인 방향 "
                      f"{len(found)}/{len(self.results)}, 가장 확실한 것: 회전 {top['rotation_deg']:g}도 "
                      f"점수 {b['score']} {dist} 방위 {b['bearing']['bearing_deg']}도")
            else:
                summary["best_overall"] = None
                summary["reason"] = "모든 방향에서 박스를 못 찾았다"
                print(f"\n[scan] ✓ {len(self.results)}프레임 정상 종료 ({by}) -- 박스를 못 찾았다")
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[scan] 저장: {SUMMARY_PATH}")

        # 2026-11-02: 경로 근거를 파일로 남긴다(성공·ok:false 모두). 계산은 관제 웹 창구와 **같은 함수**다 --
        # 따로 두면 화면의 경로와 파일의 경로가 갈린다. detect_api_server는 표준 라이브러리만 써서 import가 가볍다.
        nav = box_path_from_summary(summary)
        NAV_DIR.mkdir(parents=True, exist_ok=True)
        (NAV_DIR / "evidence.json").write_text(json.dumps(nav, ensure_ascii=False, indent=2), encoding="utf-8")
        if nav["ok"]:
            warn = f" ⚠ {nav['robot_command']['warning']}" if "warning" in nav["robot_command"] else ""
            print(f"[path] {nav['turn_instruction']} -> {nav['forward_distance_cm']}cm 직진 "
                  f"(standoff {nav['standoff_cm']:g}cm){warn}")
        else:
            print(f"[path] 경로 없음 -- {nav['reason']}")
        print(f"[path] 저장: {NAV_DIR / 'evidence.json'}\n")


def _materialize(parsed: ParsedFrame) -> Path:
    """메인 스레드에서 incoming/에 쓴다(판 정리 뒤에 써야 정리가 새 프레임을 지우지 않는다 --
    mqtt_stream_receiver._materialize_frame 주석의 2026-09-14 실측 버그)."""
    INCOMING_DIR.mkdir(parents=True, exist_ok=True)
    path = INCOMING_DIR / parsed.name
    if path.exists():
        stem, n = Path(parsed.name).stem, 2
        while (INCOMING_DIR / f"{stem}_{n:02d}.jpg").exists():
            n += 1
        path = INCOMING_DIR / f"{stem}_{n:02d}.jpg"
    path.write_bytes(parsed.image)
    return path


# ────────────────────────── 실행 ──────────────────────────

def run_replay(session: BoxScanSession, folder: Path) -> None:
    """로봇 없이 폴더의 jpg를 앞에서부터 예상 장수만큼 한 판으로 흘려 본다(회전 0/45/...도로 가정)."""
    files = sorted(folder.glob("*.jpg"))[:session.expected]
    if not files:
        raise SystemExit(f"[replay] jpg가 없다: {folder}")
    session.start("replay", len(files))
    for i, f in enumerate(files):
        session.add_frame(ParsedFrame(image=f.read_bytes(), rotation_deg=(i * 45.0) % 360.0,
                                      rotation_source="replay 가정", index=i, name=f.name))


def main() -> None:
    parser = argparse.ArgumentParser(description="로봇 MQTT 프레임 수신 -> 학습한 gray box YOLO 탐지 + 거리")
    parser.add_argument("--broker", default=BROKER_WS_URL)
    parser.add_argument("--frame-topic", default=FRAME_TOPIC)
    parser.add_argument("--scan-topic", default=SCAN_TOPIC)
    parser.add_argument("--frames", type=int, default=EXPECTED_FRAME_COUNT,
                        help="scan_start의 plan이 없을 때 쓸 예상 장수")
    parser.add_argument("--run", default=DEFAULT_RUN, help="gray_box_train/runs/ 아래 학습 결과 이름")
    parser.add_argument("--conf", type=float, default=DEFAULT_CONF)
    parser.add_argument("--replay", type=Path, default=None, help="로봇 대신 이 폴더의 jpg를 한 판으로 재생")
    args = parser.parse_args()

    detector = BoxDetector(args.run, args.conf)
    session = BoxScanSession(detector, args.frames)

    if args.replay is not None:
        run_replay(session, args.replay)
        return

    inbox: queue.Queue = queue.Queue()
    arrival = {"count": 0}
    client, host, port = _make_client(args.broker, f"physical-demo-box-{int(time.time())}")

    def on_connect(_c, _u, _f, rc):
        if rc == 0:
            client.subscribe([(args.frame_topic, SUBSCRIBE_QOS), (args.scan_topic, SUBSCRIBE_QOS)])
            print(f"[mqtt_box] 브로커 연결됨 {host}:{port}")
            print(f"[mqtt_box] 구독: {args.frame_topic} , {args.scan_topic} (QoS {SUBSCRIBE_QOS})")
        else:
            print(f"[mqtt_box] 연결 실패 rc={rc}")

    def on_disconnect(_c, _u, rc):
        print(f"[mqtt_box] 연결 끊김 rc={rc} -- 자동 재연결 시도")

    def on_message(_c, _u, msg):
        # 파일은 여기서 쓰지 않고 메인 스레드로 넘긴다(mqtt_stream_receiver.on_message 주석 참고).
        scan_event = parse_scan_message(msg.topic, msg.payload)
        if scan_event is not None:
            inbox.put(scan_event)
            return
        parsed = parse_frame_message(msg.topic, msg.payload, arrival["count"])
        if parsed is None:
            return
        arrival["count"] += 1
        inbox.put(parsed)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=10)

    print(f"[mqtt_box] 접속 시도: {args.broker}")
    _connect_or_explain(client, host, port)
    client.loop_start()
    print(f"[mqtt_box] 로봇이 스캔을 시작하기를 기다린다. 결과는 {RUN_DIR} (Ctrl-C로 종료)")

    try:
        while True:
            try:
                item = inbox.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                if isinstance(item, ScanEvent):
                    if item.event == "scan_start":
                        session.start(item.mission_id, item.expected_frames)
                    else:
                        session.finish(outcome=item.outcome, frames_sent=item.frames_sent, by="scan_end 수신")
                    continue
                session.add_frame(item)
            except Exception as exc:  # noqa: BLE001 -- 한 건의 실패가 수신기를 끝내면 안 된다
                import traceback
                print(f"[mqtt_box] ✗ 한 건 처리 중 오류 -- 수신기는 계속 돈다: {type(exc).__name__}: {exc}",
                      file=sys.stderr)
                traceback.print_exc()
    except KeyboardInterrupt:
        print("\n[mqtt_box] 종료")
    finally:
        client.loop_stop()
        client.disconnect()

    if session.active and not session.finished:
        print(f"[mqtt_box] 경고: 판이 끝나기 전에 종료됐다 ({len(session.results)}/{session.expected} 프레임)",
              file=sys.stderr)


if __name__ == "__main__":
    main()
