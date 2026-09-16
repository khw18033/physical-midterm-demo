"""조명·촬영 각도 변화 흉내(2026-09-14 사용자 지시 "조명, 촬영 각도 등이 달라지는 상황을 고려").

모두 테두리 자르기 후(237x241) crop에 적용하고 크기는 유지한다. 기하 변형(가로 압축/확장)은 정답 박스도
같은 식으로 옮긴다 -- 비스듬한 시야에서 문 폭이 줄거나(압축) 렌즈/거리 차로 넓어지는(확장) 경우.
"""

from __future__ import annotations

import cv2
import numpy as np


def _lut(bgr, fn):
    x = np.arange(256, dtype=np.float32) / 255.0
    table = np.clip(fn(x) * 255.0, 0, 255).astype(np.uint8)
    return cv2.LUT(bgr, table)


def _sat_scale(bgr, s):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * s, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


def _wb(bgr, r, b):
    out = bgr.astype(np.float32)
    out[..., 2] *= r
    out[..., 0] *= b
    return np.clip(out, 0, 255).astype(np.uint8)


def _hscale(bgr, s):
    h, w = bgr.shape[:2]
    nw = int(round(w * s))
    r = cv2.resize(bgr, (nw, h), interpolation=cv2.INTER_LINEAR)
    if s < 1:  # 압축: 가운데 두고 양옆은 가장자리 픽셀로 채움
        pad = w - nw
        return cv2.copyMakeBorder(r, 0, 0, pad // 2, pad - pad // 2, cv2.BORDER_REPLICATE)
    off = (nw - w) // 2
    return r[:, off:off + w]


def _hscale_box(box, s, w):
    nw = int(round(w * s))
    off = (w - nw) // 2 if s < 1 else -((nw - w) // 2)
    x1, y1, x2, y2 = box
    return [min(max(x1 * s + off, 0), w), y1, min(max(x2 * s + off, 0), w), y2]


AUGS = {
    "dim": lambda im: _lut(im, lambda x: x * 0.6),
    "bright": lambda im: _lut(im, lambda x: x * 1.35),
    "gamma_dark": lambda im: _lut(im, lambda x: x ** 1.6),
    "gamma_light": lambda im: _lut(im, lambda x: x ** 0.65),
    "low_contrast": lambda im: _lut(im, lambda x: 0.5 + (x - 0.5) * 0.7),
    "desat": lambda im: _sat_scale(im, 0.7),
    "warm": lambda im: _wb(im, 1.12, 0.88),
    "cool": lambda im: _wb(im, 0.88, 1.12),
    "squash": lambda im: _hscale(im, 0.8),
    "stretch": lambda im: _hscale(im, 1.2),
}
GEOM = {"squash": 0.8, "stretch": 1.2}


def transform_box(aug: str, box, crop_w: int = 237):
    if aug in GEOM:
        return _hscale_box(box, GEOM[aug], crop_w)
    return box
