"""demo/test/navigate_to_target_service.py

implements: 사용자 지시 -- "이 코드도 2번과 마찬가지로 다른 기기 mac으로 보낼
예정. 나중에 그 주소만 입력하면 전송되도록 코드 구현해둠. 일단 내 저장소에
결과물 저장만. 이제 지정 클래스 앞으로 가라는 명령을 받았을 때 우선 평면도
이미지 원본 저장. 문의 위치와 단상 위치를 depth로 계산해서 로봇 위치를 점으로
찍고 단상과 문과의 거리 작성한 이미지 저장. 회전 각도와 최소 경로 계산하고
demo/test/unidepth_localization/path_overlay.jpg과 같이 오버레이해서 저장."

**2026-09-10 재구성(사용자 지시)**: "어떤 명령이 오든 로봇은 환경 탐색을 위해
한바퀴 돌며 8프레임을 찍도록 할거고... door와 pedestal는 로봇이 본인 위치
추정하기 위해 자동으로 먼저 계산하도록 하고 위치가 나오면 이제 명령을
수행하는거지. 지정 클래스가 door나 pedestal라면 자동 위치 추정에서 이미
산출이 된거고 아니면 처음에 환경 인식 때 그 클래스도 추가로 탐색하도록 하고.
그리고 전진 명령이라면 경로도 산출하도록." 이에 따라 이 서비스를 3단계로
나눴다:
  1. `localize(detections_by_class)` -- 8프레임이 끝나면 명령 종류와 무관하게
     항상 먼저 실행. pedestal 관측(class_finder_service가 CLIP 파이프라인으로
     실제 검출한 결과, 더 이상 하드코딩 bbox 아님)으로 로봇의 지도상 위치와
     현재 진행방향(회전 프레임 각도 -> 지도 방위각 오프셋)을 추정한다.
  2. `resolve_target_position(target_class, ...)` -- target_class가 door/
     pedestal이면 이미 알려진 도면상 고정 위치를 쓰고, 그 외 일반 클래스면
     그 클래스가 검출된 프레임의 회전각+depth를 1단계에서 구한 오프셋과
     결합해 지도 좌표를 추정한다(검출 실패나 depth 유효범위 밖이면 위치
     없음으로 정직하게 보고).
  3. `on_go_to_class_command(...)` -- 2단계 위치가 나오면 회전각+최소경로를
     계산해 path_overlay.jpg를 만든다("전진 명령이라면 경로도 산출").

**정직한 한계**:
- localize()의 로봇 위치 추정 자체가 "로봇이 단상을 바라보며 촬영한 시점의
  시선 방향이 곧 단상->문 방향과 일치한다"는 이번 시연 환경 특유의 기하 가정에
  기반한다(단상 표면 지점에서 단상->문 방향으로 pedestal_distance_avg_cm만큼
  나아간 지점을 로봇 위치로 본다). 일반적인 다각도 삼변측량이 아니다.
- 문의 도면상 실제 위치(스윙도어 경첩+문짝)는 카메라로 "검출"한 게 아니라
  datasets/25300_gt.png의 GT 점으로 고정한 값이다(DOOR_PX) -- 자체 depth
  추정치는 유효범위를 벗어나 위치 추정에 쓰지 않는다.
- door/pedestal이 아닌 일반 클래스의 위치는 로봇 위치+회전 오프셋+그 클래스
  자신의 depth 측정에 의존하므로, 문처럼 depth가 유효범위를 벗어나는 먼
  물체는 위치를 못 구할 수 있다(정직하게 실패로 보고, 임의 추정하지 않음).
- 회전각 계산은 문 자신의 관측값이 아니라 단상 관측값으로 교차검증한 값을
  쓴다 -- 문 자신의 관측값을 쓰면 순환 논리가 된다는 것을 실측으로 확인했다.

전송(다른 기기로 MAC 주소를 통해 보내기)은 아직 구현하지 않고 호출 지점만
주석 처리해뒀다(`_send_to_device` 참고).
"""

from __future__ import annotations

import ctypes
import json
import math
import sys
from pathlib import Path

_VENV_SITE = Path(sys.prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
for _lib_dir in [_VENV_SITE / "nvidia" / "cu13" / "lib", _VENV_SITE / "nvidia" / "cudnn" / "lib"]:
    if _lib_dir.is_dir():
        for _so in sorted(_lib_dir.glob("*.so*")):
            try:
                ctypes.CDLL(str(_so), mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass

import cv2
import numpy as np
import torch
from unidepth.models import UniDepthV2

REPO_ROOT = Path(__file__).resolve().parents[2]
# 2026-09-11 사용자 지시: 실행 폴더(try1) 밑에 프레임별 결과 + localization/ +
# navigation/을 함께 둔다 -- class_finder_service.RUN_DIR과 동일 경로.
RUN_DIR = Path(__file__).resolve().parent / "try1"
OUT_DIR = RUN_DIR / "localization"  # 자기 위치 추정 전용(클래스 무관)
NAV_DIR = RUN_DIR / "navigation"    # 경로 계획 전용
MAP_PATH = REPO_ROOT / "datasets" / "25300.png"
DATASET_ROT8_DIR = REPO_ROOT / "datasets" / "20260910-134818_rot8"

ROOM_CM = (757.0, 689.0)
INFER_SIZE = (320, 240)  # UniDepth 464x400 직접입력 버그 우회(실측 발견, 아래 _run_unidepth 참고)

MAP_ROOM_TOPLEFT_PX = (156.0, 149.25)
MAP_ROOM_BOTTOMRIGHT_PX = (1094.5, 961.75)

# 단상의 도면상 고정 위치(실측 확정값, 그대로 유지) -- 단상 자체를 "검출"하는
# 것은 이제 class_finder_service의 CLIP 파이프라인이 담당하고, 이 값은 그
# 검출된 단상의 depth 측정을 지도 좌표로 환산할 때 쓰는 고정 기준점이다.
PEDESTAL_CENTER_CM = (178.5, 110.0)
PEDESTAL_BOX_CM = (150.0, 80.0, 207.0, 140.0)

BORDER_CROP_BOX = (114, 80, 351, 321)
# class_finder_service.py와 동일한 값 -- 원본이 정확히 이 크기일 때만 테두리를
# 잘라낸다. 2026-09-14 MQTT 실시간 수신 통합으로 추가: 로봇 카메라 프레임은
# 해상도가 다를 수 있는데, 그때 class_finder는 자르지 않으므로 검출 박스를 원본
# 좌표로 되돌릴 때도 같은 조건에서만 오프셋을 더해야 한다(무조건 더하면 박스가
# 통째로 어긋나 depth와 방위각이 전부 틀어진다).
BORDER_CROP_SOURCE_SIZE = (464, 400)

# 문의 실제 도면상 위치. 2026-09-10 재확인: datasets/25300_gt.png의 파란 점(문
# GT)을 색상 임계값으로 다시 추출한 결과 px=(1300.1, 535.8) -- 사용자가 "문
# 위치가 너무 멀게 잡힘. gt 다시 확인하고 문을 그 위치로 고정"이라고 지시해
# GT 점 자체를 authoritative 문 위치로 고정해서 쓴다.
DOOR_PX = (1300.1, 535.8)

# door/pedestal은 도면상 고정 위치가 이미 알려진 랜드마크라 class_finder의
# depth 측정으로 위치를 다시 구하지 않는다(class_finder_service.py의
# LOCALIZATION_CLASSES와 동일 목록이어야 함).
LANDMARK_MAP_POSITIONS_CM = {
    "door": None,  # px_to_cm(*DOOR_PX)로 런타임에 계산(아래 참고)
    "pedestal": PEDESTAL_CENTER_CM,
}

# 목적지 정지 거리: 타겟 클래스별로 다르게 둔다(사용자 지시 "목적지는 타겟
# 클래스가 문이라면 문 80cm 앞이 목적지로"). 다른 클래스는 아직 정해진 값이
# 없어 기존 30cm를 기본값으로 유지.
STANDOFF_CM_BY_CLASS = {"door": 100.0}
STANDOFF_CM_DEFAULT = 30.0

# 로봇 `move_forward { distance_m }` 이 받는 범위(detection-protocol_0914.md §4).
ROBOT_FORWARD_M_MIN = 0.05
ROBOT_FORWARD_M_MAX = 10.0

CALIBRATION_VALID_REL_DEPTH_MAX = 4.0

# ── 문 겉보기 크기 -> 거리 (2026-09-14 리허설 반영, 대체 경로 B·C) ──────────────
# 리허설에서 로봇 실물 프레임 8장 중 단상이 한 장에도 안 잡혀 A(단상 기반 위치 추정)가
# 실패했고 경로가 안 나왔다. 문 depth는 보정식 유효범위 밖(rel_depth≈10 -> 0.0cm)이라
# 거리로 못 쓴다. 그래서 이관메모의 C안 -- **문의 겉보기 크기로 거리**를 쓴다.
#   distance_cm ≈ K / box_px   (핀홀: 크기가 거리에 반비례)
# K는 A가 성공한 판(door_example 시료 = 데이터셋 8장, 로봇->문 715.4cm)에서 역산했다.
#   폭:  270도 20.17px · 315도 19.90px -> 715.4 × 평균 20.035 = 14333
#   높이: 270도 54.06px -> 715.4 × 54.06 = 38674  (315도는 박스가 문 일부만 잡아 38.6px라 뺐다)
# 폭은 비스듬히 보면 줄고 높이는 박스가 일부만 잡히면 준다 -- 둘 다 구해 중앙값을 쓴다.
# **프레임 가장자리에 닿아 잘린 치수는 쓰지 않는다**(리허설 315도가 왼쪽 끝에 잘렸다).
# 상수는 464x400 프레임(테두리 자르기 237x241)에서 잰 값이라 다른 해상도에는 쓰지 않는다.
DOOR_SIZE_K_WIDTH = 14333.0
DOOR_SIZE_K_HEIGHT = 38674.0
DOOR_SIZE_EDGE_PX = 1.5
DOOR_DISTANCE_PLAUSIBLE_CM = (150.0, 1500.0)
# B(문만으로 위치 추정)가 낸 로봇 위치를 믿을 범위 -- 방(ROOM_CM) 밖으로 이만큼까지.
ROOM_MARGIN_CM = 60.0


def _send_to_device(payload: dict, tag: str, target_mac: str | None = None) -> None:
    """class_finder_service.py와 동일한 자리 -- 지금은 저장만, 전송은 주석 처리."""
    # TODO(추후 통합): target_mac만 채우면 활성화.
    # import some_transport_provider
    # some_transport_provider.send(target_mac=target_mac, tag=tag, payload=payload)
    pass


# 2026-09-14 사용자 지시("역추적인걸 시연 때 굳이 언급할 필요는 없으니 일단은 언급하지 말고"): C 역추적 그림도
# 지도 모드와 같은 모양으로 그린다. True 로 두면 주황 · 속 빈 출발점 · 「가정 위치」 글씨로 구별해 그린다.
# 역추적이라는 사실은 evidence.json 의 path_overlay_kind / backtrace 에는 그대로 남는다.
BACKTRACE_OVERLAY_MARKED = False


def _draw_path_overlay(map_original, robot_position_cm, goal_cm, current_heading_map_deg, arc_target_bearing_deg,
                       turn_amount_deg, forward_distance_cm, backtraced: bool = False):
    """도면 위에 「출발 자리 · 출발 방위(회색) · 회전 호 · 직진 화살표 · 도착점」을 그린다.

    지도 모드(A 단상 · B 문만 위치)와 C의 역추적 그림이 같은 도우미를 쓴다 -- 그림 문법이 같아야
    둘을 나란히 볼 때 헷갈리지 않는다. 역추적(backtraced)이면 색을 주황으로 바꾸고 출발 자리를
    속 빈 원으로 그린 뒤 「가정 위치」라고 적는다 -- 측정한 자리가 아니라는 사실이 그림에 남는다.
    (OpenCV 기본 글꼴은 한글을 못 그려 영문으로 적는다.)"""
    backtraced = backtraced and BACKTRACE_OVERLAY_MARKED
    color = (0, 140, 255) if backtraced else (0, 0, 255)
    overlay = map_original.copy()
    p0 = cm_to_map_px(*robot_position_cm)
    p1 = cm_to_map_px(*goal_cm)
    cv2.arrowedLine(overlay, (int(p0[0]), int(p0[1])), (int(p1[0]), int(p1[1])), color, 3, tipLength=0.04)
    if backtraced:
        cv2.circle(overlay, (int(p0[0]), int(p0[1])), 12, color, 3)
    else:
        cv2.circle(overlay, (int(p0[0]), int(p0[1])), 8, color, -1)
    cv2.drawMarker(overlay, (int(p1[0]), int(p1[1])), color,
                   markerType=cv2.MARKER_TILTED_CROSS, markerSize=18, thickness=3)
    mid_px = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    cv2.putText(overlay, f"{forward_distance_cm:.1f} cm", (int(mid_px[0]) - 90, int(mid_px[1]) - 22),
                cv2.FONT_HERSHEY_SIMPLEX, 1.4, color, 3)
    ref_end = (p0[0] + 130.0 * math.cos(math.radians(current_heading_map_deg)),
               p0[1] + 130.0 * math.sin(math.radians(current_heading_map_deg)))
    cv2.arrowedLine(overlay, (int(p0[0]), int(p0[1])), (int(ref_end[0]), int(ref_end[1])),
                    (120, 120, 120), 2, tipLength=0.1)
    cv2.ellipse(overlay, (int(p0[0]), int(p0[1])), (70, 70), 0,
                arc_target_bearing_deg, current_heading_map_deg, color, 2)
    cv2.putText(overlay, f"{turn_amount_deg:.1f} deg", (int(p0[0]) - 30, int(p0[1]) + 130),
                cv2.FONT_HERSHEY_SIMPLEX, 1.3, color, 3)
    if backtraced:
        cv2.putText(overlay, "start = ASSUMED (back-traced from door)", (int(p0[0]) - 150, int(p0[1]) + 180),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, color, 3)
    return overlay


def px_to_cm(px_x, px_y):
    x0, y0 = MAP_ROOM_TOPLEFT_PX
    x1, y1 = MAP_ROOM_BOTTOMRIGHT_PX
    w_cm, h_cm = ROOM_CM
    return (px_x - x0) / (x1 - x0) * w_cm, (px_y - y0) / (y1 - y0) * h_cm


def cm_to_map_px(cm_x, cm_y):
    x0, y0 = MAP_ROOM_TOPLEFT_PX
    x1, y1 = MAP_ROOM_BOTTOMRIGHT_PX
    w_cm, h_cm = ROOM_CM
    return x0 + (cm_x / w_cm) * (x1 - x0), y0 + (cm_y / h_cm) * (y1 - y0)


def calibrate_depth_to_cm(rel_depth, bbox=None, image_w=464, image_h=400):
    """사용자가 로봇으로 직접 거리를 재서 만든 보정식(docs/obsidian/ideas/unidepth_dual_yolo.py 원본)."""
    if rel_depth is None or not np.isfinite(rel_depth):
        return None
    distance_cm = (
        -4.61006769 * (rel_depth ** 3) + 28.91334586 * (rel_depth ** 2)
        - 11.16168081 * rel_depth + 15.20770323
    )
    if bbox is not None:
        x1, y1, x2, y2 = bbox
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        nx, ny = (cx - image_w / 2.0) / (image_w / 2.0), (cy - image_h / 2.0) / (image_h / 2.0)
        r = min(1.0, max(0.0, (nx ** 2 + ny ** 2) ** 0.5))
        if r < 0.55:
            distance_cm *= 1.0 - 0.16 * (1.0 - r / 0.55)
        if r > 0.42:
            er = min(1.0, max(0.0, (r - 0.42) / 0.58))
            distance_cm *= min(1.0 + 0.45 * (er ** 1.35), 1.35)
    return max(0.0, float(distance_cm))


def get_object_depth(depth, x1, y1, x2, y2):
    w, h = int(x2 - x1), int(y2 - y1)
    if w <= 0 or h <= 0:
        return None
    mx, my = int(w * 0.18), int(h * 0.18)
    rx1, ry1, rx2, ry2 = int(x1 + mx), int(y1 + my), int(x2 - mx), int(y2 - my)
    if rx2 <= rx1 or ry2 <= ry1 or (rx2 - rx1) * (ry2 - ry1) < 20:
        rx1, ry1, rx2, ry2 = int(x1), int(y1), int(x2), int(y2)
    roi = depth[ry1:ry2, rx1:rx2]
    valid = roi[np.isfinite(roi) & (roi > 0)]
    return float(np.percentile(valid, 40)) if valid.size else None


def segment_intersects_box(p0, p1, box) -> bool:
    x0, y0 = p0
    x1, y1 = p1
    bx1, by1, bx2, by2 = box
    dx, dy = x1 - x0, y1 - y0
    t_min, t_max = 0.0, 1.0
    for p, q in [(-dx, x0 - bx1), (dx, bx2 - x0), (-dy, y0 - by1), (dy, by2 - y0)]:
        if p == 0:
            if q < 0:
                return False
        else:
            t = q / p
            if p < 0:
                t_min = max(t_min, t)
            else:
                t_max = min(t_max, t)
    return t_min <= t_max


# 프레임 원본이 있는 폴더. 기본은 데이터셋 재생 경로 그대로이고, 로봇 실시간
# 수신(mqtt_stream_receiver.py)이 시작할 때 자기가 프레임을 받아 두는 폴더로
# 바꿔 준다. **추측하지 않고 명시로 두는 이유**: 실시간 프레임 이름이
# frame_000001.jpg처럼 데이터셋 파일명과 겹칠 수 있어서, 폴더를 자동으로 고르면
# 엉뚱한 이미지의 depth를 재게 된다.
FRAME_SOURCE_DIR: Path | None = None


def _resolve_frame_path(frame_name: str) -> Path:
    """depth를 다시 재야 하는 프레임의 **자르지 않은 원본** 경로.

    2026-09-14 MQTT 실시간 수신 통합으로 추가: 예전에는 DATASET_ROT8_DIR에서만
    찾아서 로봇이 보낸 프레임을 열 수 없었다. class_finder_service가 저장해 둔
    try1/<stem>/original.jpg를 마지막 대비책으로 두되 **먼저 쓰지는 않는다** --
    그건 JPEG 재인코딩본이라 원본과 픽셀이 미세하게 달라 depth 값이 흔들린다."""
    for base in (FRAME_SOURCE_DIR, DATASET_ROT8_DIR):
        if base is None:
            continue
        candidate = base / frame_name
        if candidate.is_file():
            return candidate
    saved_original = RUN_DIR / Path(frame_name).stem / "original.jpg"
    if saved_original.is_file():
        return saved_original
    return DATASET_ROT8_DIR / frame_name


def _border_crop_offset(frame_wh):
    """(cl, ct, 검출이 이뤄진 이미지의 가로폭) -- class_finder_service.on_frame()의
    자르기 조건과 반드시 같아야 한다(위 BORDER_CROP_SOURCE_SIZE 주석 참고)."""
    if tuple(frame_wh) == BORDER_CROP_SOURCE_SIZE:
        return float(BORDER_CROP_BOX[0]), float(BORDER_CROP_BOX[1]), \
            float(BORDER_CROP_BOX[2] - BORDER_CROP_BOX[0])
    return 0.0, 0.0, float(frame_wh[0])


def _best_instance(det: dict) -> dict | None:
    """class_finder_service.py가 2026-09-11부터 프레임당 여러 인스턴스를 허용하도록
    바뀌었다("찾으려는 클래스는 프레임마다 하나가 아니라 여러개 존재할 수도
    있어") -- det["instances"]는 이미 점수 내림차순으로 정렬돼 있으므로 첫 번째가
    가장 강한 근거를 가진 인스턴스다. 위치 추정처럼 "이 프레임에서 이 클래스가
    어디 있었나"를 대표값 하나로 알아야 하는 계산에는 이 함수로 대표 인스턴스를
    골라 쓴다(box_xyxy/score 키로 이전 단일-인스턴스 시절과 동일한 형태를 유지)."""
    instances = det.get("instances") or []
    if not instances:
        return None
    best = instances[0]
    return {"box_xyxy": best["box_xyxy"], "score": best["final_score"]}


class NavigateToTargetService:
    def __init__(self) -> None:
        self.model: UniDepthV2 | None = None
        # 2026-09-14 추가: 같은 프레임에 대해 localize() -> 관측요약 -> 경로계산이
        # 각각 UniDepth를 다시 돌리고 있었다(프레임당 3회 이상). 관제 웹이 1.5초
        # 주기로 폴링하는 실시간 연동에서는 이 중복이 그대로 지연이 되므로
        # 경로 단위로 결과를 재사용한다(320x240 depth 1장 ~300KB, 8프레임이면 3MB 미만).
        self._depth_cache: dict[str, tuple] = {}

    def _run_unidepth(self, image_path: Path):
        cached = self._depth_cache.get(str(image_path))
        if cached is not None:
            return cached
        if self.model is None:
            self.model = UniDepthV2.from_pretrained("lpiccinelli/unidepth-v2-vitb14").to("cuda").eval()
        bgr_full = cv2.imread(str(image_path))
        h0, w0 = bgr_full.shape[:2]
        r = cv2.resize(bgr_full, INFER_SIZE, interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(r, cv2.COLOR_BGR2RGB)
        t = torch.from_numpy(rgb.copy()).permute(2, 0, 1)
        with torch.inference_mode():
            out = self.model.infer(t, camera=None, normalize=True)
        # 2026-09-11 사용자 지적("270도에서 문이 중앙보다 살짝 오른쪽, 315도에서
        # 왼쪽이니 그 사이로 보간하면 되지 않나")에 따라 회전 보정에 카메라
        # 내부파라미터(fx, cx)도 함께 쓴다 -- UniDepth가 camera=None으로 매
        # 프레임마다 스스로 추정하는 값이며 INFER_SIZE 픽셀 좌표계 기준이다.
        intr = out["intrinsics"][0].cpu().numpy()
        fx, cx = float(intr[0, 0]), float(intr[0, 2])
        result = (out["depth"][0, 0].cpu().numpy(), (w0, h0), (fx, cx))
        self._depth_cache[str(image_path)] = result
        return result

    def _measure_depth_cm(self, frame_name: str, box_border_cropped):
        """class_finder가 검출한 box(border-cropped 좌표)를 원본 좌표로
        되돌려 UniDepth로 depth를 측정하고 cm로 환산한다. door/pedestal/일반
        클래스 모두 이 한 함수를 공유한다."""
        depth, wh, _intr = self._run_unidepth(_resolve_frame_path(frame_name))
        cl, ct, _crop_w = _border_crop_offset(wh)
        box_orig = (box_border_cropped[0] + cl, box_border_cropped[1] + ct,
                    box_border_cropped[2] + cl, box_border_cropped[3] + ct)
        sx, sy = INFER_SIZE[0] / wh[0], INFER_SIZE[1] / wh[1]
        box_infer = (box_orig[0] * sx, box_orig[1] * sy, box_orig[2] * sx, box_orig[3] * sy)
        rel_depth = get_object_depth(depth, *box_infer)
        distance_cm = calibrate_depth_to_cm(rel_depth, bbox=box_orig, image_w=wh[0], image_h=wh[1])
        in_range = rel_depth is not None and rel_depth <= CALIBRATION_VALID_REL_DEPTH_MAX
        return rel_depth, distance_cm, in_range

    def _bearing_offset_deg(self, frame_name: str, box_border_cropped):
        """탐지 박스가 그 프레임 안에서 화면 중앙으로부터 좌우로 얼마나
        치우쳐 있는지를 pinhole 카메라 모델(atan2(x_offset, fx))로 각도로
        환산한다.

        **왜 필요한가(2026-09-11 사용자 지적으로 발견된 근본 원인)**: 회전
        스캔은 8단계(45도 간격)만 있어서, "그 프레임에서 탐지된 물체가 화면
        정중앙에 있다"고 가정해버리면 절대 방위각 계산이 rotation_deg 값
        자체(0/45/90/.../315)에만 의존하게 되고, 그 결과 회전 지시각이 항상
        45의 배수로만 나온다(수식으로 검증됨: turn = f(rotation_deg들) 형태로
        환원되어 실제 물리적 위치·거리와 무관해짐 -- 로그 참고).
        박스가 실제로는 화면 중앙에서 벗어나 있을 수 있으므로 그 벗어난
        정도를 각도로 보정하면 45도 배수라는 인위적 제약이 없는 연속값을
        얻을 수 있다. 박스가 화면 폭의 상당 부분을 채우는 경우(예: 초근접
        촬영된 단상)는 중심점 자체가 신뢰할 수 없어 보정하지 않고 None을
        반환한다."""
        _depth, wh, (fx, cx) = self._run_unidepth(_resolve_frame_path(frame_name))
        x1, y1, x2, y2 = box_border_cropped
        cl, _ct, crop_w = _border_crop_offset(wh)
        box_w_frac = (x2 - x1) / crop_w
        if box_w_frac > 0.6:
            return None
        sx = INFER_SIZE[0] / wh[0]
        center_x_infer = ((x1 + cl) + (x2 + cl)) / 2.0 * sx
        return math.degrees(math.atan2(center_x_infer - cx, fx))

    @staticmethod
    def _frame_image_paths(class_name: str, frame_name: str) -> dict:
        """class_finder_service.py가 원본/RPN/전체확정 오버레이는 프레임 폴더
        (try1/<frame_stem>/)에, 클래스 전용 오버레이+크롭은 그 안의 클래스
        폴더(try1/<frame_stem>/<class_name>/)에 저장하므로 여기서도 같은
        경로를 만든다(2026-09-11 재구성)."""
        stem = Path(frame_name).stem
        frame_dir = RUN_DIR / stem
        class_dir = frame_dir / class_name
        return {
            "original_image": str(frame_dir / "original.jpg"),
            "rpn_overlay_image": str(frame_dir / "rpn_overlay.jpg"),
            "confirmed_overlay_image": str(frame_dir / "confirmed_overlay.jpg"),
            "target_overlay_image": str(class_dir / "target_overlay.jpg"),
        }

    # ── 1단계: 자기 위치 추정 -- 명령 종류와 무관하게 8프레임 후 항상 먼저 실행 ──
    def localize(self, detections_by_class: dict[str, dict[float, dict]], target_class: str | None = None) -> dict:
        out_dir = OUT_DIR
        out_dir.mkdir(parents=True, exist_ok=True)

        map_original = cv2.imread(str(MAP_PATH))
        cv2.imwrite(str(out_dir / "map_original.jpg"), map_original)

        door_map_cm = px_to_cm(*DOOR_PX)

        # 단상은 이제 class_finder_service가 CLIP 파이프라인으로 실제 검출한
        # 결과를 쓴다(더 이상 하드코딩 bbox 아님) -- found=True인 프레임 전부
        # 사용해 depth를 각각 측정하고 평균낸다(1개든 여러 개든 대응).
        pedestal_dets = detections_by_class.get("pedestal", {})
        pedestal_measurements = []
        for rot, det in sorted(pedestal_dets.items()):
            best = _best_instance(det)
            if best is None:
                continue
            rel_depth, distance_cm, in_range = self._measure_depth_cm(det["frame"], best["box_xyxy"])
            pedestal_measurements.append({
                "frame": det["frame"], "rotation_deg": rot, "clip_score": best["score"],
                "rel_depth": rel_depth, "distance_cm": distance_cm, "in_valid_calibration_range": in_range,
                "instance_count_this_frame": len(det.get("instances") or []),
                **self._frame_image_paths("pedestal", det["frame"]),
            })
            print(f"[navigate] {det['frame']}(회전 {rot}도) 단상: rel_depth={rel_depth:.3f} -> {distance_cm:.1f}cm")

        # door/pedestal뿐 아니라 이번 명령이 요청한 target_class(둘과 다르면)까지
        # 포함해 8프레임 전체에서 어떤 클래스가 몇 도 프레임에서 검출됐는지 전부
        # 남긴다(사용자 지시: "target class를 검출한 프레임의 각도는 몇인지도
        # 작성되어야 함").
        classes_to_report = list(dict.fromkeys(["door", "pedestal"] + ([target_class] if target_class else [])))
        observations_by_class = {}
        for class_name in classes_to_report:
            dets = detections_by_class.get(class_name, {})
            observations_by_class[class_name] = [
                {"frame": det["frame"], "rotation_deg": rot, "instance_count": len(det["instances"]),
                 "clip_score": det["instances"][0]["final_score"],
                 **self._frame_image_paths(class_name, det["frame"])}
                for rot, det in sorted(dets.items()) if det.get("found")
            ]
        # pedestal 관측에는 depth 측정까지 포함된 상세 버전을 쓴다.
        observations_by_class["pedestal"] = pedestal_measurements

        # 사용자 지시: "어떤 각도에서 찍은 프레임인지도. 45도씩 오른쪽으로 돈
        # 이미지 8개임을 참고해서" -- door/pedestal은 매 프레임 항상 탐색하는
        # LOCALIZATION_CLASSES라 그 검출 결과 dict의 key(rotation_deg)를 모으면
        # 검출 성공 여부와 무관하게 8프레임 전체의 회전각 목록을 얻을 수 있다.
        all_rotation_degs = sorted(set(detections_by_class.get("door", {}).keys())
                                    | set(detections_by_class.get("pedestal", {}).keys()))
        frame_by_rotation = {}
        for dets in detections_by_class.values():
            for rot, det in dets.items():
                frame_by_rotation.setdefault(rot, det["frame"])
        rotation_sequence = {
            "description": "로봇이 오른쪽(시계) 방향으로 정확히 45도씩 회전하며 촬영한 8개 프레임"
                            "(0/45/90/135/180/225/270/315도).",
            "rotation_direction": "clockwise (오른쪽)",
            "nominal_step_deg": 45.0,
            "frames": [{"frame": frame_by_rotation[rot], "rotation_deg": rot} for rot in all_rotation_degs],
        }

        localized = len(pedestal_measurements) > 0
        result = {"ok": localized}
        if not localized:
            # 2026-09-14 리허설 반영: 단상이 안 잡히면 여기서 끝내지 않고 **문만으로** 위치를
            # 추정한다(B). 그것도 안 되면 실패를 적되, 경로 단계가 문 관측만으로 이어 갈 수 있게
            # 문 거리·방위 근거를 결과에 실어 둔다(C, on_go_to_class_command).
            pedestal_reason = "pedestal이 어느 프레임에서도 검출되지 않아 로봇 위치를 추정할 수 없음"
            print(f"[navigate] A(단상) 실패: {pedestal_reason} -- B(문만으로 위치 추정) 시도")
            return self._localize_from_door(
                detections_by_class, out_dir, map_original, door_map_cm, rotation_sequence,
                observations_by_class, pedestal_reason)

        pedestal_distance_avg_cm = sum(m["distance_cm"] for m in pedestal_measurements) / len(pedestal_measurements)
        pedestal_bearing_deg = sum(m["rotation_deg"] for m in pedestal_measurements) / len(pedestal_measurements)

        # 단상 표면 지점(ray-box exit point) + 단상->문 방향으로 실측 거리만큼
        # 나아간 지점을 로봇 위치로 본다(이 시연 환경의 기하 가정 -- 모듈
        # docstring "정직한 한계" 참고).
        dx = door_map_cm[0] - PEDESTAL_CENTER_CM[0]
        dy = door_map_cm[1] - PEDESTAL_CENTER_CM[1]
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length

        px1, py1, px2, py2 = PEDESTAL_BOX_CM
        cx, cy = PEDESTAL_CENTER_CM
        t_x = ((px2 if ux > 0 else px1) - cx) / ux if ux != 0 else float("inf")
        t_y = ((py2 if uy > 0 else py1) - cy) / uy if uy != 0 else float("inf")
        t_exit = min(t_x, t_y)
        pedestal_surface_point_cm = (cx + t_exit * ux, cy + t_exit * uy)
        robot_position_cm = (
            pedestal_surface_point_cm[0] + pedestal_distance_avg_cm * ux,
            pedestal_surface_point_cm[1] + pedestal_distance_avg_cm * uy,
        )

        # 회전 프레임 각도 -> 지도 방위각 오프셋: 문 자신의 관측각으로 구하면
        # 순환 논리가 되므로(실측으로 확인) 단상 관측각으로 교차검증한다.
        map_bearing_to_pedestal_deg = math.degrees(math.atan2(
            pedestal_surface_point_cm[1] - robot_position_cm[1], pedestal_surface_point_cm[0] - robot_position_cm[0]
        )) % 360.0
        current_heading_map_deg = (map_bearing_to_pedestal_deg - pedestal_bearing_deg) % 360.0

        # map_overlay: 로봇 위치 + 단상/문까지 거리 단서
        overlay = map_original.copy()
        pos_px = cm_to_map_px(*robot_position_cm)
        ped_px = cm_to_map_px(*pedestal_surface_point_cm)
        door_px_map = cm_to_map_px(*door_map_cm)
        dist_to_door = math.hypot(robot_position_cm[0] - door_map_cm[0], robot_position_cm[1] - door_map_cm[1])
        cv2.line(overlay, (int(pos_px[0]), int(pos_px[1])), (int(ped_px[0]), int(ped_px[1])), (0, 128, 0), 2)
        cv2.line(overlay, (int(pos_px[0]), int(pos_px[1])), (int(door_px_map[0]), int(door_px_map[1])), (255, 0, 0), 2)
        ped_mid = ((pos_px[0] + ped_px[0]) / 2, (pos_px[1] + ped_px[1]) / 2)
        door_mid = ((pos_px[0] + door_px_map[0]) / 2, (pos_px[1] + door_px_map[1]) / 2)
        cv2.putText(overlay, f"{pedestal_distance_avg_cm:.1f} cm", (int(ped_mid[0]) - 55, int(ped_mid[1]) - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 128, 0), 3)
        cv2.putText(overlay, f"{dist_to_door:.1f} cm", (int(door_mid[0]) - 75, int(door_mid[1]) - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 0, 0), 3)
        cv2.circle(overlay, (int(pos_px[0]), int(pos_px[1])), 8, (0, 0, 255), -1)
        cv2.imwrite(str(out_dir / "map_overlay.jpg"), overlay)

        # rotation_deg(프레임 촬영 시점의 로봇 회전각)와 구분해, 각 관측이 맵
        # 좌표계 기준으로 어느 절대 방위각에 있었는지도 계산한다(사용자 지시:
        # "맵 중심 처음 로봇이 돌기 전 기준으로 어느 절대 각도에 검출한
        # 타겟이 있는지 계산"). 수식은 순수 식으로만 쓰고 한국어 설명은 별도
        # note 필드로 분리한다.
        absolute_bearing_formula = "absolute_bearing_deg = (rotation_deg + current_heading_map_deg) mod 360"
        for class_name, obs_list in observations_by_class.items():
            for o in obs_list:
                o["absolute_bearing_deg"] = round((o["rotation_deg"] + current_heading_map_deg) % 360.0, 1)
                o["absolute_bearing_formula"] = absolute_bearing_formula

        pedestal_distance_avg_formula = {
            "formula": "pedestal_distance_avg_cm = mean(distance_cm_i for i in pedestal_observations)",
            "substituted": f"mean({', '.join(f'{m['distance_cm']:.1f}' for m in pedestal_measurements)}) "
                           f"= {pedestal_distance_avg_cm:.1f}",
        }
        pedestal_bearing_formula = {
            "formula": "pedestal_bearing_rotation_frame_deg = mean(rotation_deg_i for i in pedestal_observations)",
            "substituted": f"mean({', '.join(f'{m['rotation_deg']:.1f}' for m in pedestal_measurements)}) "
                           f"= {pedestal_bearing_deg:.1f}",
        }

        localization_evidence = {
            "ok": True,
            "method": "pedestal",
            "method_words": "A -- 단상 관측(거리·방위)으로 위치와 방위를 추정",
            "fallback_chain": [{"step": "A_pedestal", "ok": True, "detail": f"단상 관측 {len(pedestal_measurements)}프레임"}],
            "rotation_sequence": rotation_sequence,
            "observations": observations_by_class,
            "pedestal_distance_avg_cm": round(pedestal_distance_avg_cm, 1),
            "pedestal_distance_avg_formula": pedestal_distance_avg_formula,
            "pedestal_bearing_rotation_frame_deg": pedestal_bearing_deg,
            "pedestal_bearing_formula": pedestal_bearing_formula,
            "pedestal_surface_point_cm": [round(v, 1) for v in pedestal_surface_point_cm],
            "door_position_cm_fixed_from_gt": [round(v, 1) for v in door_map_cm],
            "robot_position_cm": [round(v, 1) for v in robot_position_cm],
            "map_bearing_to_pedestal_deg": round(map_bearing_to_pedestal_deg, 1),
            "current_heading_map_deg": round(current_heading_map_deg, 1),
            "rotation_calculation": {
                "step1_map_bearing_to_pedestal": {
                    "formula": "atan2(pedestal_surface_point_cm.y - robot_position_cm.y, "
                               "pedestal_surface_point_cm.x - robot_position_cm.x) mod 360",
                    "substituted": f"atan2({pedestal_surface_point_cm[1]:.1f} - {robot_position_cm[1]:.1f}, "
                                   f"{pedestal_surface_point_cm[0]:.1f} - {robot_position_cm[0]:.1f}) mod 360 "
                                   f"= {map_bearing_to_pedestal_deg:.1f}",
                },
                "step2_pedestal_bearing_rotation_frame": pedestal_bearing_formula,
                "step3_current_heading_map_deg": {
                    "formula": "current_heading_map_deg = (map_bearing_to_pedestal_deg - "
                               "pedestal_bearing_rotation_frame_deg) mod 360",
                    "substituted": f"({map_bearing_to_pedestal_deg:.1f} - {pedestal_bearing_deg:.1f}) mod 360 "
                                   f"= {current_heading_map_deg:.1f}",
                    "note": "문 자신의 관측각으로 오프셋을 구하면 순환 논리가 되므로(실측으로 확인됨) "
                            "단상 관측각으로 교차검증한다.",
                },
                "step4_absolute_bearing_per_observation": {"formula": absolute_bearing_formula},
            },
        }
        with open(out_dir / "localization_evidence.json", "w", encoding="utf-8") as f:
            json.dump(localization_evidence, f, ensure_ascii=False, indent=2)
        _send_to_device(localization_evidence, tag="localization")  # 주석 처리된 실제 전송, 지금은 저장만

        print(f"[navigate] 로봇 위치(cm): {[round(v,1) for v in robot_position_cm]}, "
              f"현재 방위각 오프셋: {current_heading_map_deg:.1f}도")

        result.update({
            "method": "pedestal",
            "fallback_chain": localization_evidence["fallback_chain"],
            "robot_position_cm": robot_position_cm,
            "current_heading_map_deg": current_heading_map_deg,
            "pedestal_surface_point_cm": pedestal_surface_point_cm,
            "door_map_cm": door_map_cm,
            "map_original": map_original,
        })
        return result

    # ── 대체 경로 공용: 문 거리(겉보기 크기)와 문 방위 ──────────────────────
    def _door_distance_from_size(self, detections_by_class: dict):
        """문의 겉보기 크기로 로봇->문 거리를 어림한다. 반환: (거리cm 또는 None, 근거 dict).

        depth(UniDepth)는 문이 멀어 보정식 유효범위를 벗어나므로(rel_depth≈10) 쓰지 않는다.
        상수와 그 출처는 모듈 상단 DOOR_SIZE_K_* 주석. 잘린 치수는 버리고, 남은 추정치의
        **중앙값**을 쓴다 -- 한 치수가 틀려도(비스듬한 폭·일부만 잡힌 높이) 끌려가지 않게."""
        dets = detections_by_class.get("door", {})
        per_frame, estimates = [], []
        for rot, det in sorted(dets.items()):
            if not det.get("found"):
                continue
            best = _best_instance(det)
            x1, y1, x2, y2 = best["box_xyxy"]
            entry = {"frame": det["frame"], "rotation_deg": rot, "box_xyxy": [round(v, 1) for v in best["box_xyxy"]],
                     "box_w_px": round(x2 - x1, 1), "box_h_px": round(y2 - y1, 1)}
            img = cv2.imread(str(_resolve_frame_path(det["frame"])))
            if img is None:
                entry["skipped_reason"] = "프레임 원본을 못 열었다"
                per_frame.append(entry)
                continue
            h0, w0 = img.shape[:2]
            if (w0, h0) != BORDER_CROP_SOURCE_SIZE:
                entry["skipped_reason"] = f"보정 상수는 {BORDER_CROP_SOURCE_SIZE[0]}x{BORDER_CROP_SOURCE_SIZE[1]} 프레임에서 잰 값 -- 이 프레임은 {w0}x{h0}"
                per_frame.append(entry)
                continue
            crop_w = BORDER_CROP_BOX[2] - BORDER_CROP_BOX[0]
            crop_h = BORDER_CROP_BOX[3] - BORDER_CROP_BOX[1]
            width_clipped = x1 <= DOOR_SIZE_EDGE_PX or x2 >= crop_w - DOOR_SIZE_EDGE_PX
            height_clipped = y1 <= DOOR_SIZE_EDGE_PX or y2 >= crop_h - DOOR_SIZE_EDGE_PX
            entry["width_clipped"], entry["height_clipped"] = width_clipped, height_clipped
            if not width_clipped and (x2 - x1) > 2:
                d = DOOR_SIZE_K_WIDTH / (x2 - x1)
                entry["distance_from_width_cm"] = round(d, 1)
                estimates.append(d)
            if not height_clipped and (y2 - y1) > 2:
                d = DOOR_SIZE_K_HEIGHT / (y2 - y1)
                entry["distance_from_height_cm"] = round(d, 1)
                estimates.append(d)
            per_frame.append(entry)
        evidence = {
            "method": "문 박스 겉보기 크기 -- distance_cm = K / box_px (잘린 치수 제외, 중앙값)",
            "formula": f"distance_cm = median(K_width / box_w_px, K_height / box_h_px)  [K_width={DOOR_SIZE_K_WIDTH:.0f}, K_height={DOOR_SIZE_K_HEIGHT:.0f}]",
            "constants_source": "door_example 시료(A 성공, 로봇->문 715.4cm)의 문 박스로 역산",
            "per_frame": per_frame,
        }
        if not estimates:
            evidence["reason"] = "문이 검출된 프레임이 없거나, 모든 치수가 프레임 가장자리에 잘려 거리를 못 구함"
            return None, evidence
        estimates.sort()
        mid = len(estimates) // 2
        distance = estimates[mid] if len(estimates) % 2 else (estimates[mid - 1] + estimates[mid]) / 2.0
        evidence["estimates_cm"] = [round(v, 1) for v in estimates]
        evidence["distance_cm"] = round(distance, 1)
        evidence["substituted"] = f"median({', '.join(f'{v:.1f}' for v in estimates)}) = {distance:.1f}"
        low, high = DOOR_DISTANCE_PLAUSIBLE_CM
        if not (low <= distance <= high):
            evidence["reason"] = f"어림 거리 {distance:.1f}cm가 믿을 범위({low:.0f}~{high:.0f}cm) 밖"
            return None, evidence
        return distance, evidence

    def _door_rotation(self, detections_by_class: dict):
        """시작 방향 기준 문 방위(시계 +). 반환: (방위도 0~360 또는 None, 근거 dict 또는 None).

        박스 오프셋 보정(_bearing_refinement)이 되면 그 연속값, 안 되면(박스가 너무 커 중심을
        못 믿음) 문이 검출된 프레임들의 rotation_deg 원형평균으로 물러난다 -- 이때는 45도 단위라는
        한계를 근거에 적는다."""
        turn, refinement = self._bearing_refinement("door", detections_by_class)
        if refinement is not None:
            return refinement["refined_target_rotation_deg"], {"source": "bearing_refinement", **refinement}
        found = [rot for rot, det in sorted(detections_by_class.get("door", {}).items()) if det.get("found")]
        if not found:
            return None, None
        s = sum(math.sin(math.radians(r)) for r in found)
        c = sum(math.cos(math.radians(r)) for r in found)
        rot = math.degrees(math.atan2(s, c)) % 360.0
        return rot, {"source": "rotation_deg_mean", "rotation_degs": found, "refined_target_rotation_deg": round(rot, 2),
                     "note": "박스 오프셋 보정을 못 해 촬영 각도(45도 단위)의 원형평균을 썼다 -- 회전각이 거칠다"}

    # ── B: 단상 없이 문만으로 위치 추정 (2026-09-14 리허설 반영, 사용자 지시 2-1) ──
    def _localize_from_door(self, detections_by_class, out_dir, map_original, door_map_cm,
                            rotation_sequence, observations_by_class, pedestal_reason) -> dict:
        """**A와 같은 기하 가정**을 쓴다 -- 로봇은 단상->문 직선 위에 있다. A는 그 선 위에서
        단상까지의 거리로 자리를 잡고, B는 **문까지의 거리**(겉보기 크기)로 잡는다. 방위는 문
        자신의 관측각으로 역산한다(A가 피한 순환이 여기서는 남는다 -- 교차검증 상대인 단상이
        없기 때문이며, 그 사실을 근거에 적는다).

        추정한 자리가 방 밖이거나 단상 안이면 **위치 추정 자체가 틀린 것**으로 보고 실패를 낸다.
        그때 경로 단계는 C(문 관측만으로 경로)로 넘어간다."""
        chain = [{"step": "A_pedestal", "ok": False, "detail": pedestal_reason}]
        distance, distance_ev = self._door_distance_from_size(detections_by_class)
        door_rot, rotation_ev = self._door_rotation(detections_by_class)
        base = {"rotation_sequence": rotation_sequence, "observations": observations_by_class,
                "door_position_cm_fixed_from_gt": [round(v, 1) for v in door_map_cm],
                "door_distance_estimate": distance_ev, "door_rotation_estimate": rotation_ev}

        def fail(reason: str) -> dict:
            chain.append({"step": "B_door_only", "ok": False, "detail": reason})
            print(f"[navigate] B(문만) 실패: {reason} -- 경로 단계가 C(문 관측만으로 경로)를 시도한다")
            evidence = {"ok": False, "method": None, "reason": f"{pedestal_reason} / 문만으로도 위치를 못 잡음: {reason}",
                        "fallback_chain": chain, **base}
            with open(out_dir / "localization_evidence.json", "w", encoding="utf-8") as f:
                json.dump(evidence, f, ensure_ascii=False, indent=2)
            return {"ok": False, "reason": evidence["reason"], "fallback_chain": chain, "door_map_cm": door_map_cm,
                    "door_distance_cm": distance, "door_distance_estimate": distance_ev,
                    "door_rotation_deg": door_rot, "door_rotation_estimate": rotation_ev, "map_original": map_original}

        if door_rot is None:
            return fail("문이 어느 프레임에서도 검출되지 않음")
        if distance is None:
            return fail(distance_ev.get("reason", "문 거리를 못 구함"))

        dx, dy = door_map_cm[0] - PEDESTAL_CENTER_CM[0], door_map_cm[1] - PEDESTAL_CENTER_CM[1]
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length
        robot_position_cm = (door_map_cm[0] - distance * ux, door_map_cm[1] - distance * uy)
        inside_room = (-ROOM_MARGIN_CM <= robot_position_cm[0] <= ROOM_CM[0] + ROOM_MARGIN_CM
                       and -ROOM_MARGIN_CM <= robot_position_cm[1] <= ROOM_CM[1] + ROOM_MARGIN_CM)
        px1, py1, px2, py2 = PEDESTAL_BOX_CM
        in_pedestal = px1 <= robot_position_cm[0] <= px2 and py1 <= robot_position_cm[1] <= py2
        if not inside_room:
            return fail(f"추정 위치 ({robot_position_cm[0]:.1f}, {robot_position_cm[1]:.1f})cm가 방(0~{ROOM_CM[0]:.0f}, 0~{ROOM_CM[1]:.0f}) 밖")
        if in_pedestal:
            return fail(f"추정 위치 ({robot_position_cm[0]:.1f}, {robot_position_cm[1]:.1f})cm가 단상 안")

        map_bearing_to_door_deg = math.degrees(math.atan2(uy, ux)) % 360.0
        current_heading_map_deg = (map_bearing_to_door_deg - door_rot) % 360.0
        chain.append({"step": "B_door_only", "ok": True,
                      "detail": f"문 거리 {distance:.1f}cm(겉보기 크기) · 문 방위 {door_rot:.1f}도({rotation_ev['source']})"})

        overlay = map_original.copy()
        pos_px = cm_to_map_px(*robot_position_cm)
        door_px_map = cm_to_map_px(*door_map_cm)
        cv2.line(overlay, (int(pos_px[0]), int(pos_px[1])), (int(door_px_map[0]), int(door_px_map[1])), (255, 0, 0), 2)
        door_mid = ((pos_px[0] + door_px_map[0]) / 2, (pos_px[1] + door_px_map[1]) / 2)
        cv2.putText(overlay, f"{distance:.1f} cm (door size)", (int(door_mid[0]) - 140, int(door_mid[1]) - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 0, 0), 3)
        cv2.circle(overlay, (int(pos_px[0]), int(pos_px[1])), 8, (0, 0, 255), -1)
        cv2.imwrite(str(out_dir / "map_overlay.jpg"), overlay)

        evidence = {
            "ok": True,
            "method": "door_only",
            "method_words": "B -- 단상이 안 보여 문의 겉보기 크기(거리)와 문 방위만으로 위치와 방위를 추정",
            "fallback_chain": chain,
            **base,
            "robot_position_cm": [round(v, 1) for v in robot_position_cm],
            "current_heading_map_deg": round(current_heading_map_deg, 1),
            "map_bearing_to_door_deg": round(map_bearing_to_door_deg, 1),
            "rotation_calculation": {
                "step1_door_distance": {"formula": distance_ev["formula"], "substituted": distance_ev["substituted"]},
                "step2_robot_position": {
                    "formula": "robot_position_cm = door_position_cm - door_distance_cm * unit_vector(pedestal_center -> door)",
                    "substituted": f"({door_map_cm[0]:.1f}, {door_map_cm[1]:.1f}) - {distance:.1f} * ({ux:.3f}, {uy:.3f}) "
                                   f"= ({robot_position_cm[0]:.1f}, {robot_position_cm[1]:.1f})",
                    "note": "A와 같은 기하 가정(로봇은 단상->문 직선 위) -- 단상까지 대신 문까지의 거리로 자리를 잡는다",
                },
                "step3_current_heading_map_deg": {
                    "formula": "current_heading_map_deg = (map_bearing_to_door_deg - door_rotation_deg) mod 360",
                    "substituted": f"({map_bearing_to_door_deg:.1f} - {door_rot:.1f}) mod 360 = {current_heading_map_deg:.1f}",
                    "note": "교차검증할 단상이 없어 문 자신의 관측각으로 역산했다 -- 회전각과 서로 기대는 값이다",
                },
            },
        }
        with open(out_dir / "localization_evidence.json", "w", encoding="utf-8") as f:
            json.dump(evidence, f, ensure_ascii=False, indent=2)
        print(f"[navigate] B(문만) 위치(cm): {[round(v, 1) for v in robot_position_cm]}, 방위 오프셋 {current_heading_map_deg:.1f}도")
        return {"ok": True, "method": "door_only", "fallback_chain": chain, "robot_position_cm": robot_position_cm,
                "current_heading_map_deg": current_heading_map_deg, "door_map_cm": door_map_cm,
                "map_original": map_original, "door_distance_cm": distance, "door_distance_estimate": distance_ev}

    # ── 2단계: 지정 클래스의 지도 위치 결정 ──────────────────────────────
    def resolve_target_position(self, target_class: str, detections_by_class: dict, loc: dict) -> dict:
        """target_class가 door/pedestal이면 도면상 고정 위치를 쓰고, 그 외
        일반 클래스면 검출된 프레임의 회전각+depth를 로봇 위치/방위각 오프셋과
        결합해 지도 좌표를 추정한다. 못 구하면 position=None + reason으로
        정직하게 보고한다(임의 추정 금지)."""
        if target_class == "door":
            return {"target_class": target_class, "position_cm": loc["door_map_cm"], "source": "gt_fixed",
                    "detail": "datasets/25300_gt.png GT 점으로 고정된 도면상 위치"}
        if target_class == "pedestal":
            return {"target_class": target_class, "position_cm": PEDESTAL_CENTER_CM, "source": "floorplan_fixed",
                    "detail": "실측 확정된 도면상 고정 위치(PEDESTAL_CENTER_CM)"}

        dets = detections_by_class.get(target_class, {})
        found = [(rot, det) for rot, det in sorted(dets.items()) if det.get("found")]
        if not found:
            return {"target_class": target_class, "position_cm": None, "source": "not_found",
                    "detail": f"8프레임 중 '{target_class}'가 검출된 프레임이 없음"}

        rot, det = found[0]
        best = _best_instance(det)
        rel_depth, distance_cm, in_range = self._measure_depth_cm(det["frame"], best["box_xyxy"])
        if not in_range:
            return {"target_class": target_class, "position_cm": None, "source": "depth_out_of_range",
                    "detail": f"{det['frame']}(회전 {rot}도)에서 검출됐으나 depth 추정치(rel_depth={rel_depth})가 "
                              f"보정식 유효범위(<= {CALIBRATION_VALID_REL_DEPTH_MAX})를 벗어남 -- 위치 추정 불가",
                    "frame": det["frame"], "rotation_deg": rot, "rel_depth": rel_depth}

        bearing_deg = (rot + loc["current_heading_map_deg"]) % 360.0
        rx, ry = loc["robot_position_cm"]
        position_cm = (rx + distance_cm * math.cos(math.radians(bearing_deg)),
                       ry + distance_cm * math.sin(math.radians(bearing_deg)))
        return {
            "target_class": target_class, "position_cm": position_cm, "source": "bearing_and_depth",
            "detail": f"{det['frame']}(회전 {rot}도)에서 검출, depth={distance_cm:.1f}cm, "
                      f"지도 방위각={bearing_deg:.1f}도(=회전 {rot}도 + 오프셋 {loc['current_heading_map_deg']:.1f}도)",
            "frame": det["frame"], "rotation_deg": rot, "rel_depth": rel_depth, "distance_cm": distance_cm,
            "bearing_deg": bearing_deg,
        }

    def save_target_observation_summary(self, target_class: str, detections_by_class: dict, loc: dict) -> None:
        """사용자 지시: "target이 몇도 회전한 어느 프레임에 어느 각도 어느
        거리에 있었는지 정보를 담은 json 생성". try1/navigation/에 8프레임
        전체를 훑어 저장한다(2026-09-11: 경로+위치추정 산출물과 함께 try1
        밑에 각자 폴더로) -- go-to-class 명령 여부와 무관하게, 위치 추정(loc)이
        성공했으면 항상 호출 가능."""
        out_dir = NAV_DIR
        out_dir.mkdir(parents=True, exist_ok=True)

        dets = detections_by_class.get(target_class, {})
        frames = []
        for rot, det in sorted(dets.items()):
            instances = det.get("instances") or []
            entry = {"frame": det["frame"], "rotation_deg": rot, "found": det.get("found", False),
                      "instance_count": len(instances)}
            if instances and loc.get("ok"):
                # 2026-09-11: 프레임당 여러 인스턴스를 허용하므로(예: person 2명)
                # 각 인스턴스마다 절대 방위각·거리를 따로 계산해 리스트로 남긴다.
                bearing_deg = round((rot + loc["current_heading_map_deg"]) % 360.0, 1)
                inst_entries = []
                for inst in instances:
                    rel_depth, distance_cm, in_range = self._measure_depth_cm(det["frame"], inst["box_xyxy"])
                    inst_entries.append({
                        "box_xyxy": inst["box_xyxy"], "final_score": inst["final_score"],
                        "absolute_bearing_deg": bearing_deg, "rel_depth": rel_depth,
                        "distance_cm": round(distance_cm, 1) if distance_cm is not None else None,
                        "in_valid_calibration_range": in_range,
                    })
                entry["instances"] = inst_entries
            frames.append(entry)

        summary = {
            "target_class": target_class,
            "localization_ok": loc.get("ok", False),
            "absolute_bearing_formula": "absolute_bearing_deg = (rotation_deg + current_heading_map_deg) mod 360",
            "distance_formula": "distance_cm = calibrate_depth_to_cm(rel_depth, bbox)",
            "distance_note": "이 distance_cm은 target_class 자신의 depth 추정치다 -- door/pedestal처럼 "
                              "도면상 고정 위치가 따로 있는 랜드마크는 실제 경로 계산에는 이 값 대신 고정 "
                              "위치까지의 거리를 쓴다(해당 클래스 디렉터리의 evidence.json 참고).",
            "frames": frames,
        }
        with open(out_dir / "target_summary.json", "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
        _send_to_device(summary, tag=f"{target_class}:summary")  # 주석 처리된 실제 전송, 지금은 저장만
        print(f"[navigate] Saved {out_dir / 'target_summary.json'}")

    def _bearing_refinement(self, target_class: str, detections_by_class: dict):
        """랜드마크 **자신의 관측만으로** "시작 방향 기준 몇 도 돌아야 그것을 보나"를
        구한다. 반환: (회전각(부호 있음) 또는 None, 근거 dict 또는 None).

        2026-09-11 사용자 지적으로 발견된 근본 원인 수정: door/pedestal처럼 도면상
        위치가 GT로 고정된 랜드마크는 원래 map_bearing_to_target_deg(로봇 추정위치
        -> 고정위치)와 current_heading_map_deg(단상 관측으로 교차검증한 오프셋)를
        빼서 회전각을 구했는데, 이 둘 다 결국 rotation_deg(0/45/.../315 8단계뿐)에만
        의존하게 되어 있어 회전 지시각이 항상 45의 배수로만 나오는 구조적 결함이
        있었다(수식 전개로 확인: turn = rotation_deg들의 선형결합 -> 45의 배수).
        이 랜드마크 자신이 검출된 프레임(들)의 박스가 화면 중앙에서 얼마나 벗어났는지를
        _bearing_offset_deg로 각도 보정해 연속값을 얻는다 -- 도면상 위치가 이미
        알려져 있으므로 map 좌표를 거칠 필요가 없다(오히려 map 좌표 경로는 로봇
        위치 자체가 이 랜드마크 위치에 종속적으로 유도된 값이라 부정확).

        2026-09-14 별도 메서드로 분리: **로봇의 지도상 위치를 몰라도** 이 계산은
        성립한다(타겟 자신의 관측만 쓴다). 단상이 안 보여 자기 위치 추정이 실패한
        경우에도 회전각만은 내놓을 수 있게 하려고 호출부에서 떼어 냈다."""
        dets_own = detections_by_class.get(target_class, {})
        found_own = [(rot, det) for rot, det in sorted(dets_own.items()) if det.get("found")]
        refined_rotations = []
        per_frame = []
        for rot, det in found_own:
            best = _best_instance(det)
            offset_deg = self._bearing_offset_deg(det["frame"], best["box_xyxy"])
            entry = {"frame": det["frame"], "rotation_deg": rot, "pixel_offset_angle_deg":
                     round(offset_deg, 2) if offset_deg is not None else None}
            if offset_deg is not None:
                refined = (rot + offset_deg) % 360.0
                refined_rotations.append(refined)
                entry["refined_rotation_deg"] = round(refined, 2)
            else:
                entry["skipped_reason"] = "박스가 프레임 폭의 60% 이상을 채워 중심점을 신뢰할 수 없음"
            per_frame.append(entry)
        if not refined_rotations:
            return None, None

        # 원형 평균(circular mean) -- 값들이 0/360 경계를 넘나들 수 있으므로
        # 단순 산술평균 대신 sin/cos 평균으로 wrap-around를 피한다.
        sin_sum = sum(math.sin(math.radians(r)) for r in refined_rotations)
        cos_sum = sum(math.cos(math.radians(r)) for r in refined_rotations)
        refined_target_rotation_deg = math.degrees(math.atan2(sin_sum, cos_sum)) % 360.0
        turn_amount_signed = (refined_target_rotation_deg + 180.0) % 360.0 - 180.0
        refinement = {
            "method": "각 관측 프레임에서 검출 박스의 화면 중심 대비 픽셀 오프셋을 "
                      "UniDepth가 그 프레임에서 추정한 카메라 내부파라미터(fx, cx)로 "
                      "각도 환산해 rotation_deg(45도 단위)에 더한 연속값을 구하고, "
                      "복수 관측이면 원형평균(circular mean)한다.",
            "formula": "refined_rotation_i = (rotation_deg_i + degrees(atan2(box_center_x_infer - cx, fx))) mod 360; "
                       "refined_target_rotation_deg = degrees(atan2(mean(sin(refined_rotation_i)), mean(cos(refined_rotation_i))))",
            "per_frame": per_frame,
            "refined_target_rotation_deg": round(refined_target_rotation_deg, 2),
            "spread_deg": round(max(refined_rotations) - min(refined_rotations), 2) if len(refined_rotations) > 1 else None,
            "note": "회전 지시각이 항상 45의 배수로만 나오던 문제(로봇/단상/문 위치가 "
                    "map 좌표상 서로 종속적으로 유도되어 rotation_deg 8단계에만 의존하던 "
                    "구조적 결함)를 이 랜드마크 자신의 관측만으로 직접 구한 연속값으로 대체해 해결.",
        }
        return turn_amount_signed, refinement

    # ── 3단계: go-to-class -- 위치가 나오면 회전각+최소경로 산출 ──────────
    def on_go_to_class_command(self, target_class: str, detections_by_class: dict, loc: dict) -> None:
        # 2026-09-11 사용자 지시: 경로(path) 산출물은 try1/navigation/에 독립
        # 폴더로 모은다(localization/과 대칭 구조).
        out_dir = NAV_DIR
        out_dir.mkdir(parents=True, exist_ok=True)

        if not loc.get("ok"):
            # 2026-09-14 리허설 반영(사용자 지시 2-2): 위치 추정 자체가 안 되면 **문 관측만으로**
            # 경로(회전각 + 직진 거리)를 낸다. 도면 위 자리가 없으니 도면 경로 그림은 못 그린다.
            print(f"[navigate] 위치 추정 실패 -- {loc.get('reason')} -- C(문 관측만으로 경로) 시도")
            self._door_relative_path(target_class, detections_by_class, loc, out_dir)
            return

        target = self.resolve_target_position(target_class, detections_by_class, loc)
        if target["position_cm"] is None:
            print(f"[navigate] go_to_class({target_class}) 처리 불가: {target['detail']}")
            with open(out_dir / "evidence.json", "w", encoding="utf-8") as f:
                json.dump({"target_class": target_class, "ok": False, "target_resolution": target},
                          f, ensure_ascii=False, indent=2)
            return

        robot_position_cm = loc["robot_position_cm"]
        current_heading_map_deg = loc["current_heading_map_deg"]
        target_position_cm = target["position_cm"]

        dx = target_position_cm[0] - robot_position_cm[0]
        dy = target_position_cm[1] - robot_position_cm[1]
        distance_to_target_cm = math.hypot(dx, dy)
        ux, uy = (dx / distance_to_target_cm, dy / distance_to_target_cm) if distance_to_target_cm > 0 else (1.0, 0.0)

        map_bearing_to_target_deg = math.degrees(math.atan2(dy, dx)) % 360.0
        turn_amount_signed = (map_bearing_to_target_deg - current_heading_map_deg + 180.0) % 360.0 - 180.0

        # 2026-09-11 사용자 지적으로 발견된 근본 원인 수정: door/pedestal처럼
        # 도면상 위치가 GT로 고정된 랜드마크는 원래 map_bearing_to_target_deg
        # (로봇 추정위치 -> 고정위치)와 current_heading_map_deg(단상 관측으로
        # 교차검증한 오프셋)를 빼서 회전각을 구했는데, 이 둘 다 결국
        # rotation_deg(0/45/.../315 8단계뿐)에만 의존하게 되어 있어 회전
        # 지시각이 항상 45의 배수로만 나오는 구조적 결함이 있었다(수식 전개로
        # 확인: turn = rotation_deg들의 선형결합 -> 45의 배수). 이 랜드마크
        # 자신이 검출된 프레임(들)의 박스가 화면 중앙에서 얼마나 벗어났는지를
        # _bearing_offset_deg로 각도 보정해 얻은 연속값 회전각이 있으면 그것을
        # 우선 사용한다 -- door/pedestal은 도면상 위치가 이미 알려져 있으므로
        # "그 위치를 보려면 시작 방향 기준 몇 도를 돌아야 하는가"를 그 자신의
        # 관측만으로 직접 구할 수 있고, map 좌표를 거칠 필요가 없다(오히려
        # map 좌표 경로는 로봇 위치 자체가 이 랜드마크 위치에 종속적으로
        # 유도된 값이라 부정확).
        bearing_refinement = None
        if target_class in LANDMARK_MAP_POSITIONS_CM:
            refined_turn, bearing_refinement = self._bearing_refinement(target_class, detections_by_class)
            if refined_turn is not None:
                turn_amount_signed = refined_turn

        turn_direction = "왼쪽(반시계)" if turn_amount_signed < 0 else "오른쪽(시계)"
        turn_amount_deg = abs(turn_amount_signed)

        standoff_cm = STANDOFF_CM_BY_CLASS.get(target_class, STANDOFF_CM_DEFAULT)
        forward_distance_cm = distance_to_target_cm - standoff_cm
        goal_cm = (robot_position_cm[0] + forward_distance_cm * ux, robot_position_cm[1] + forward_distance_cm * uy)
        pedestal_clear = not segment_intersects_box(robot_position_cm, goal_cm, PEDESTAL_BOX_CM)

        map_original = loc.get("map_original")
        if map_original is None:
            map_original = cv2.imread(str(MAP_PATH))
        # bearing_refinement가 적용된 경우 turn_amount_deg가 더 이상
        # map_bearing_to_target_deg - current_heading_map_deg와 정확히 일치하지
        # 않으므로(랜드마크 자신의 관측으로 직접 재보정했기 때문), 호(arc)
        # 그림도 실제로 표시되는 각도(turn_amount_deg)와 일치하도록 도착
        # 방위각을 current_heading_map_deg + turn_amount_signed로 다시 잡는다.
        arc_target_bearing_deg = (current_heading_map_deg + turn_amount_signed) % 360.0 \
            if bearing_refinement is not None else map_bearing_to_target_deg
        path_overlay = _draw_path_overlay(map_original, robot_position_cm, goal_cm, current_heading_map_deg,
                                          arc_target_bearing_deg, turn_amount_deg, forward_distance_cm)
        cv2.imwrite(str(out_dir / "path_overlay.jpg"), path_overlay)

        path_calculation = {
            "step1_map_bearing_to_target": {
                "formula": "atan2(target_position_cm.y - robot_position_cm.y, "
                           "target_position_cm.x - robot_position_cm.x) mod 360",
                "substituted": f"atan2({dy:.1f}, {dx:.1f}) mod 360 = {map_bearing_to_target_deg:.1f}",
            },
            "step2_turn_amount": (
                {
                    "formula": "turn_amount_deg = |((refined_target_rotation_deg + 180) mod 360) - 180| "
                               "(bearing_refinement 참고 -- 랜드마크 자신의 관측을 각도 보정해 직접 구함)",
                    "substituted": f"|(({bearing_refinement['refined_target_rotation_deg']:.1f} + 180) mod 360) - 180| "
                                   f"= {turn_amount_deg:.1f} ({turn_direction})",
                } if bearing_refinement is not None else {
                    "formula": "turn_amount_deg = |((map_bearing_to_target_deg - current_heading_map_deg + 180) mod 360) - 180|",
                    "substituted": f"|(({map_bearing_to_target_deg:.1f} - {current_heading_map_deg:.1f} + 180) mod 360) - 180| "
                                   f"= {turn_amount_deg:.1f} ({turn_direction})",
                }
            ),
            "step3_distance_to_target": {
                "formula": "distance_to_target_cm = hypot(target_position_cm.x - robot_position_cm.x, "
                           "target_position_cm.y - robot_position_cm.y)",
                "substituted": f"hypot({dx:.1f}, {dy:.1f}) = {distance_to_target_cm:.1f}",
            },
            "step4_forward_distance": {
                "formula": "forward_distance_cm = distance_to_target_cm - standoff_cm(target_class)",
                "substituted": f"{distance_to_target_cm:.1f} - {standoff_cm:.1f} = {forward_distance_cm:.1f}",
            },
            "step5_goal_position": {
                "formula": "goal_cm = robot_position_cm + forward_distance_cm * unit_vector(robot->target)",
                "substituted": f"({robot_position_cm[0]:.1f}, {robot_position_cm[1]:.1f}) + {forward_distance_cm:.1f} * "
                               f"({ux:.3f}, {uy:.3f}) = ({goal_cm[0]:.1f}, {goal_cm[1]:.1f})",
            },
        }
        # 2026-09-14 로봇 규약(detection-protocol_0914.md §4) 반영: 로봇 명령은
        # `turn { deg }` + `move_forward { distance_m }` 두 개다. 저쪽 부호 규약이
        # **오른쪽이 +**라 우리 turn_amount_signed와 그대로 같고(왼쪽이 음수),
        # standoff_cm은 이미 forward_distance_cm에 빼져 있으므로 로봇이 또 빼면 안 된다.
        # 전진 거리는 0.05~10m만 받으므로 범위를 넘으면 숨기지 않고 표시해 둔다.
        forward_distance_m = forward_distance_cm / 100.0
        distance_in_range = ROBOT_FORWARD_M_MIN <= forward_distance_m <= ROBOT_FORWARD_M_MAX
        robot_command = {
            "turn": {"deg": round(turn_amount_signed, 1)},
            "move_forward": {"distance_m": round(forward_distance_m, 3)},
            "distance_m_in_range": distance_in_range,
            "accepted_range_m": [ROBOT_FORWARD_M_MIN, ROBOT_FORWARD_M_MAX],
            "note": "turn.deg는 오른쪽이 +(왼쪽이 음수). "
                    "move_forward.distance_m에는 standoff가 이미 반영돼 있다 -- 또 빼지 말 것.",
        }
        if not distance_in_range:
            robot_command["warning"] = (
                f"전진 거리 {forward_distance_m:.3f}m가 로봇이 받는 범위"
                f"({ROBOT_FORWARD_M_MIN}~{ROBOT_FORWARD_M_MAX}m)를 벗어난다 -- 그대로 보내면 안 된다")
            print(f"[navigate] 경고: {robot_command['warning']}")

        nav_evidence = {
            "target_class": target_class,
            "ok": True,
            # 2026-09-14: 어느 경로로 나온 경로인가 -- 관제 웹 액션 아이템이 그대로 적는다.
            "path_mode": "map",
            "path_mode_words": "도면 위 로봇 자리에서 목표까지 산출" + (
                " (A -- 단상 기반 위치)" if loc.get("method") == "pedestal" else " (B -- 문만으로 추정한 위치)"),
            "localization_method": loc.get("method"),
            "fallback_chain": list(loc.get("fallback_chain") or []) + [{"step": "path_map", "ok": True, "detail": "도면 기반 경로 산출"}],
            "path_overlay_available": True,
            "path_overlay_kind": "map",
            "target_resolution": target,
            "robot_position_cm": [round(v, 1) for v in robot_position_cm],
            "current_heading_map_deg": round(current_heading_map_deg, 1),
            "target_position_cm": [round(v, 1) for v in target_position_cm],
            "map_bearing_to_target_deg": round(map_bearing_to_target_deg, 1),
            "turn_instruction": f"{turn_direction}으로 {turn_amount_deg:.1f}도 회전",
            "turn_deg": round(turn_amount_signed, 1),
            "distance_to_target_cm": round(distance_to_target_cm, 1),
            "standoff_cm": standoff_cm,
            "forward_distance_cm": round(forward_distance_cm, 1),
            "forward_distance_m": round(forward_distance_m, 3),
            "robot_command": robot_command,
            "goal_cm": [round(v, 1) for v in goal_cm],
            "path_calculation": path_calculation,
            "bearing_refinement": bearing_refinement,
            "pedestal_obstacle_clear": pedestal_clear,
        }
        with open(out_dir / "evidence.json", "w", encoding="utf-8") as f:
            json.dump(nav_evidence, f, ensure_ascii=False, indent=2)
        _send_to_device(nav_evidence, tag=f"{target_class}:navigate")  # 주석 처리된 실제 전송, 지금은 저장만

        print(f"[navigate] 지시: {turn_direction}으로 {turn_amount_deg:.1f}도 회전 -> "
              f"{forward_distance_cm:.1f}cm 직진 ({target_class} {standoff_cm:.0f}cm 앞 정지)")
        print(f"[navigate] Saved to {out_dir}: path_overlay.jpg, evidence.json")

    # ── C: 위치 없이 문 관측만으로 경로 (2026-09-14 리허설 반영, 사용자 지시 2-2) ──
    def _door_relative_path(self, target_class: str, detections_by_class: dict, loc: dict, out_dir: Path) -> None:
        """로봇의 도면상 자리를 모를 때 **문 자신의 관측**만으로 「얼마나 돌고 얼마나 가나」를 낸다.

          회전각   문 방위(박스 오프셋 보정 연속값, 안 되면 촬영 각도 원형평균) -- 시작 방향 기준
          직진     문 거리(겉보기 크기) - standoff

        문이 아닌 클래스는 겉보기 크기 상수가 없어 여기서 멈추고 정직하게 실패를 적는다.

        2026-09-14 사용자 지시("C로 나와도 산출된 경로를 역추적해서 2D 맵에 그리는 게 나아 보여"):
        로봇의 도면 자리는 모르지만 **문의 도면 자리는 안다.** 산출된 경로(문 방위 · 문 거리)를 문에서
        거꾸로 따라가 출발 자리를 **가정**해 그림을 그린다. 방향 가정은 B와 같다(로봇은 단상->문 선 위).

          가정 출발 자리   = 문 자리 - 문 거리 x 단위벡터(단상 중심 -> 문)
          가정 출발 방위   = (그 선의 도면 방위 - 문 방위) mod 360
          도착점           = 문 자리 - standoff x 같은 단위벡터

        B가 「방 밖 · 단상 안」으로 버린 자리도 **그림에는 그대로 그린다** -- 위치 추정으로 쓰는 값이 아니라
        명령(회전·직진)을 도면에 옮긴 것이기 때문이다. 로봇 명령은 그림과 무관하게 문 관측값 그대로다.
        근거에 `path_overlay_kind: backtraced` 와 가정·식을 남기고, robot_position_cm 은 여전히 null 이다."""
        chain = list(loc.get("fallback_chain") or [])

        def fail(reason: str) -> None:
            chain.append({"step": "C_door_relative", "ok": False, "detail": reason})
            print(f"[navigate] C(문 관측만) 실패: {reason} -- 경로를 내지 않는다")
            with open(out_dir / "evidence.json", "w", encoding="utf-8") as f:
                json.dump({"target_class": target_class, "ok": False, "path_mode": None,
                           "reason": f"경로 산출 실패 -- {reason} (위치 추정: {loc.get('reason')})",
                           "fallback_chain": chain,
                           "door_distance_estimate": loc.get("door_distance_estimate"),
                           "door_rotation_estimate": loc.get("door_rotation_estimate")},
                          f, ensure_ascii=False, indent=2)

        if target_class != "door":
            return fail(f"'{target_class}'는 겉보기 크기 상수가 없어 위치 없이 거리를 못 구함")
        door_rot = loc.get("door_rotation_deg")
        rotation_ev = loc.get("door_rotation_estimate")
        if door_rot is None:
            door_rot, rotation_ev = self._door_rotation(detections_by_class)
        if door_rot is None:
            return fail("문이 어느 프레임에서도 검출되지 않음 -- 갈 방향이 없다")
        distance = loc.get("door_distance_cm")
        distance_ev = loc.get("door_distance_estimate")
        if distance is None:
            distance, distance_ev = self._door_distance_from_size(detections_by_class)
        if distance is None:
            return fail((distance_ev or {}).get("reason", "문 거리를 못 구함") + " -- 방향은 알지만 얼마나 갈지 모른다")

        turn_amount_signed = (door_rot + 180.0) % 360.0 - 180.0
        turn_direction = "왼쪽(반시계)" if turn_amount_signed < 0 else "오른쪽(시계)"
        turn_amount_deg = abs(turn_amount_signed)
        standoff_cm = STANDOFF_CM_BY_CLASS.get(target_class, STANDOFF_CM_DEFAULT)
        forward_distance_cm = distance - standoff_cm
        forward_distance_m = forward_distance_cm / 100.0
        distance_in_range = ROBOT_FORWARD_M_MIN <= forward_distance_m <= ROBOT_FORWARD_M_MAX
        robot_command = {
            "turn": {"deg": round(turn_amount_signed, 1)},
            "move_forward": {"distance_m": round(forward_distance_m, 3)},
            "distance_m_in_range": distance_in_range,
            "accepted_range_m": [ROBOT_FORWARD_M_MIN, ROBOT_FORWARD_M_MAX],
            "note": "turn.deg는 오른쪽이 +(왼쪽이 음수), 스캔 시작 방향 기준. "
                    "move_forward.distance_m에는 standoff가 이미 반영돼 있다 -- 또 빼지 말 것.",
        }
        if not distance_in_range:
            robot_command["warning"] = (f"전진 거리 {forward_distance_m:.3f}m가 로봇이 받는 범위"
                                        f"({ROBOT_FORWARD_M_MIN}~{ROBOT_FORWARD_M_MAX}m)를 벗어난다 -- 그대로 보내면 안 된다")
        chain.append({"step": "C_door_relative", "ok": True,
                      "detail": f"문 방위 {door_rot:.1f}도 · 문 거리 {distance:.1f}cm -- 도면 위치 없이 산출"})
        path_calculation = {
            "step1_door_rotation": {
                "formula": (rotation_ev or {}).get("formula", "door_rotation_deg = circular_mean(rotation_deg_i for door frames)"),
                "substituted": f"door_rotation_deg = {door_rot:.1f} ({(rotation_ev or {}).get('source', '?')})",
            },
            "step2_turn_amount": {
                "formula": "turn_amount_signed = ((door_rotation_deg + 180) mod 360) - 180",
                "substituted": f"(({door_rot:.1f} + 180) mod 360) - 180 = {turn_amount_signed:.1f} ({turn_direction})",
            },
            "step3_door_distance": {
                "formula": (distance_ev or {}).get("formula", "door_distance_cm = K / box_px"),
                "substituted": (distance_ev or {}).get("substituted", f"{distance:.1f}"),
            },
            "step4_forward_distance": {
                "formula": "forward_distance_cm = door_distance_cm - standoff_cm(target_class)",
                "substituted": f"{distance:.1f} - {standoff_cm:.1f} = {forward_distance_cm:.1f}",
            },
        }
        # ── 역추적 그림 -- 명령을 문에서 거꾸로 도면에 옮긴다(가정 출발 자리) ──
        door_map_cm = loc.get("door_map_cm") or px_to_cm(*DOOR_PX)
        backtrace = None
        backtrace_error = None
        try:
            bx, by = door_map_cm[0] - PEDESTAL_CENTER_CM[0], door_map_cm[1] - PEDESTAL_CENTER_CM[1]
            blen = math.hypot(bx, by)
            ux, uy = bx / blen, by / blen
            start_cm = (door_map_cm[0] - distance * ux, door_map_cm[1] - distance * uy)
            goal_cm = (door_map_cm[0] - standoff_cm * ux, door_map_cm[1] - standoff_cm * uy)
            line_bearing_deg = math.degrees(math.atan2(uy, ux)) % 360.0
            start_heading_deg = (line_bearing_deg - door_rot) % 360.0
            map_original = loc.get("map_original")
            if map_original is None:
                map_original = cv2.imread(str(MAP_PATH))
            overlay = _draw_path_overlay(map_original, start_cm, goal_cm, start_heading_deg,
                                         (start_heading_deg + turn_amount_signed) % 360.0,
                                         turn_amount_deg, forward_distance_cm, backtraced=True)
            cv2.imwrite(str(out_dir / "path_overlay.jpg"), overlay)
            px1, py1, px2, py2 = PEDESTAL_BOX_CM
            backtrace = {
                "assumption": "로봇은 단상 중심 -> 문 직선 위에 있다(B와 같은 가정) -- 문 자리에서 문 거리만큼 거꾸로",
                "start_position_cm": [round(v, 1) for v in start_cm],
                "start_heading_map_deg": round(start_heading_deg, 1),
                "goal_cm": [round(v, 1) for v in goal_cm],
                "start_inside_pedestal": px1 <= start_cm[0] <= px2 and py1 <= start_cm[1] <= py2,
                "calculation": {
                    "step1_start_position": {
                        "formula": "start_cm = door_position_cm - door_distance_cm * unit_vector(pedestal_center -> door)",
                        "substituted": f"({door_map_cm[0]:.1f}, {door_map_cm[1]:.1f}) - {distance:.1f} * ({ux:.3f}, {uy:.3f}) "
                                       f"= ({start_cm[0]:.1f}, {start_cm[1]:.1f})",
                    },
                    "step2_start_heading": {
                        "formula": "start_heading_map_deg = (line_bearing_deg - door_rotation_deg) mod 360",
                        "substituted": f"({line_bearing_deg:.1f} - {door_rot:.1f}) mod 360 = {start_heading_deg:.1f}",
                    },
                    "step3_goal": {
                        "formula": "goal_cm = door_position_cm - standoff_cm * unit_vector(pedestal_center -> door)",
                        "substituted": f"({door_map_cm[0]:.1f}, {door_map_cm[1]:.1f}) - {standoff_cm:.1f} * ({ux:.3f}, {uy:.3f}) "
                                       f"= ({goal_cm[0]:.1f}, {goal_cm[1]:.1f})",
                    },
                },
                "note": "도면 그림용 가정이다 -- 로봇 명령(회전·직진)은 이 값과 무관하게 문 관측값 그대로다",
            }
        except Exception as exc:  # 그림 실패가 경로(명령)를 막으면 안 된다
            # 화면에 보이는 대체 경로 사슬에는 넣지 않는다(시연에서 역추적을 언급하지 않는다) -- 콘솔과 근거 필드에만.
            backtrace = None
            backtrace_error = f"역추적 그림 실패: {exc}"
            print(f"[navigate] C 역추적 그림 실패(명령은 그대로): {exc}")

        nav_evidence = {
            "target_class": target_class,
            "ok": True,
            "path_mode": "door_relative",
            "path_mode_words": "C -- 로봇 위치를 못 잡아 문 관측(방위·겉보기 크기)만으로 산출"
                               + ("" if backtrace is not None else ". 도면 위 경로 그림 없음"),
            "localization_method": None,
            "localization_reason": loc.get("reason"),
            "fallback_chain": chain,
            "path_overlay_available": backtrace is not None,
            "path_overlay_kind": "backtraced" if backtrace is not None else None,
            "backtrace": backtrace,
            "backtrace_error": backtrace_error,
            "target_resolution": {"target_class": target_class, "position_cm": None, "source": "door_relative",
                                  "detail": "도면 좌표 없이 로봇 기준 방위·거리로만 산출"},
            "robot_position_cm": None,
            "current_heading_map_deg": None,
            "target_position_cm": [round(v, 1) for v in loc.get("door_map_cm") or px_to_cm(*DOOR_PX)],
            "turn_instruction": f"{turn_direction}으로 {turn_amount_deg:.1f}도 회전",
            "turn_deg": round(turn_amount_signed, 1),
            "distance_to_target_cm": round(distance, 1),
            "standoff_cm": standoff_cm,
            "forward_distance_cm": round(forward_distance_cm, 1),
            "forward_distance_m": round(forward_distance_m, 3),
            "robot_command": robot_command,
            "goal_cm": None,
            "path_calculation": path_calculation,
            "bearing_refinement": rotation_ev,
            "door_distance_estimate": distance_ev,
        }
        with open(out_dir / "evidence.json", "w", encoding="utf-8") as f:
            json.dump(nav_evidence, f, ensure_ascii=False, indent=2)
        _send_to_device(nav_evidence, tag=f"{target_class}:navigate")
        print(f"[navigate] C 지시: {turn_direction}으로 {turn_amount_deg:.1f}도 회전 -> {forward_distance_cm:.1f}cm 직진 "
              f"(문 관측만 -- 도면 위치 없음" + (", 역추적 그림 저장" if backtrace is not None else "") + ")")
