"""말단 전처리 — 경로 해석과 입력 crop. 그게 전부다.

implements: AI-C-01, AI-C-02, AI-B-10

**예전에 여기 있던 것**: RPN(ONNX 세션), 크기 구간별 NMS, ByteTracker, 후보
필터. 2026-09-21에 전부 걷어냈다 — 정렬이 필요로 하는 것은 움직임이지 정체성
이고, 그건 KLT 플로우가 6ms에 한다(RPN+ByteTrack은 350ms였다). 근거와 잃은
것은 `alignment.py` 첫머리에 있다.

검출·추적·의미 해석은 전부 엣지 몫이다(AI-B-10 말단 경량 실행 경계).
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def resolve(cfg: dict, rel: str) -> Path:
    """설정 안의 상대경로를 config.json 위치 기준으로 푼다."""
    p = Path(rel)
    return p if p.is_absolute() else (Path(cfg["_root"]) / p).resolve()


def apply_input_crop(cfg: dict, bgr):
    """센서 유효 영역만 남긴다. 어안 비네팅 같은 무효 영역을 미리 자른다.

    **왜 말단에서 자르나**: 자르지 않으면 RPN이 검은 비네팅 경계에 후보를 대량으로
    내고, 화면 전체를 감싼 박스가 객체로 잡힌다(2026-09-21 실내 어안 실측: `person`
    박스가 실제 사람보다 훨씬 크게 잡혔다). 이건 인지 이후에 걸러낼 문제가 아니라
    **입력 조건**이므로 센서에 가장 가까운 곳에서 처리한다.

    crop 값은 source_size가 일치할 때만 적용한다 — 다른 해상도의 프레임에 남의
    좌표를 들이대면 조용히 엉뚱한 데를 자른다. `demo/test/class_finder_service.py`의
    BORDER_CROP_SOURCE_SIZE/BORDER_CROP_BOX가 같은 규약을 쓰며 값도 거기서 왔다.

    **crop은 실행 구성의 일부다**(AI-E-02/AI-B-01) — crop이 다르면 같은 모델이라도
    다른 구성이고, 성능 프로파일을 그대로 옮겨 쓸 수 없다.
    """
    c = cfg["pi"].get("input_crop")
    if not c or not c.get("enabled", True):
        return bgr, None
    h, w = bgr.shape[:2]
    src = c.get("source_size")
    if src and [w, h] != list(src):
        return bgr, None                  # 해상도가 다르면 적용하지 않는다
    x1, y1, x2, y2 = c["box"]
    x1, y1 = max(0, int(x1)), max(0, int(y1))
    x2, y2 = min(w, int(x2)), min(h, int(y2))
    if x2 <= x1 or y2 <= y1:
        return bgr, None
    return bgr[y1:y2, x1:x2], [x1, y1, x2, y2]




