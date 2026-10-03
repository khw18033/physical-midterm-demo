"""시점 정렬 — 엣지가 늦게 준 박스를 **현재 프레임으로 옮긴다.**

implements: AI-S-06, AI-S-03, AI-C-02, AI-B-10

── 왜 RPN+ByteTrack을 걷어냈나 ─────────────────────────────────────────────
정렬이 필요로 하는 것은 **움직임**이지 정체성이 아니다. 예전에는 말단이 RPN으로
후보를 만들고 ByteTracker로 track_id를 붙여, 늦게 온 판정을 그 id에 매달았다.
그건 동작했지만 값이 너무 비쌌다 — Pi 5 실측(2026-09-21):

    RPN 896x512 + ByteTrack     ~350 ms/frame   (1.5GHz 스로틀링 상태)
    KLT 200점 @640x360             6.0 ms       ← 같은 이동량을 정확히 복원
    위상상관 @512x288              6.8 ms

합성 검증(실제 이동 37,-14 px)에서 셋 다 (37.0, -14.0)을 냈다. **58배 싸다.**
게다가 RPN이 매 프레임 만들던 후보 200개를 실제로 소비하는 쪽이 지금은 없다
(CLIP을 껐고, 엣지는 자기 YOLOE로 본다).

정렬이 필요하긴 하다. focal_px 590, 속도 5 m/s, 왕복 0.9s 기준 이동량은
거리 20m에서 133px, 50m에서 53px, 100m에서 27px이고 yaw 10°/s면 122px이다.
그냥 두면 라벨이 엉뚱한 자리에 붙는다.

── 무엇을 잃었고 어떻게 막았나 ─────────────────────────────────────────────
* **드리프트** — 플로우는 프레임마다 오차가 쌓인다. 앵커를 엣지 판정이 올 때마다
  갱신하므로 누적 창이 왕복 시간(~1s)으로 제한된다. 그보다 오래된 근거는
  `evidence_ttl_s`에서 만료된다.
* **교차 시 뒤바뀜** — 두 객체가 스칠 때 워프한 박스가 서로 바뀔 수 있다.
  track_id는 안 바뀌었다. 지금은 박스 안 플로우 점들의 **일치도**를 같이 내서
  (`quality`) 믿을 수 없는 워프를 드러낸다 — 숨기지 않는다(AI-S-03).
* **링크 단절 중 후보 생산** — RPN이 하던 일이다. 라벨을 못 받는 구간의
  class-agnostic 후보가 실제로 무슨 값어치였는지는 검증된 적이 없고, 이 경로는
  안전 판단 경로가 아니다(안전은 기체 failsafe 몫, AI-N-01). 프레임은 여전히
  스풀에 남으므로 링크가 돌아오면 엣지가 그 구간을 본다.

좌표는 로컬 영상 좌표뿐이다. 전역 변환은 백엔드 몫이다(AI-C-02).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Anchor:
    """엣지가 판정한 그 프레임. 여기서부터 현재까지 누적 변환을 쌓는다."""

    frame_seq: int
    observed_at: float
    gray: np.ndarray                      # 정렬 기준 회색조(축소본)


@dataclass
class Aligned:
    """워프 결과 하나."""

    box: tuple[float, float, float, float]
    quality: float                        # 0~1, 박스 안 플로우 점들의 일치도
    frames_late: int
    age_s: float
    scale: float                          # 배율(>1이면 다가옴)


class FlowAligner:
    """프레임마다 이전 프레임과의 상사변환(이동+배율)을 추정해 누적한다.

    **전역 변환 하나로 충분한 이유**: 드론 시야에서 지배적인 움직임은 기체
    자신의 것이다. 객체 고유 움직임은 그 위에 얹히는데, 왕복 1초 동안 대부분의
    대상은 화면에서 기체 이동만큼 움직인다. 객체별 플로우는 `refine_box`에서
    박스 안 점들로 따로 잡는다 — 전역이 틀린 경우를 그쪽이 잡아낸다.
    """

    def __init__(self, *, work_w: int = 640, max_corners: int = 200,
                 history: int = 120):
        self.work_w = work_w
        self.max_corners = max_corners
        self._lock = threading.Lock()
        # frame_seq → (gray 축소본, 직전 프레임 대비 누적 변환)
        self.frames: deque = deque(maxlen=history)
        self.prev_gray: np.ndarray | None = None
        self.prev_seq = 0
        self.scale = 1.0                  # 원본 → 작업 해상도 배율
        self.last_ms = 0.0
        self.fail = 0

    # -- 내부 ---------------------------------------------------------------
    def _prep(self, bgr) -> np.ndarray:
        h, w = bgr.shape[:2]
        self.scale = self.work_w / float(w)
        g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        if self.scale < 1.0:
            g = cv2.resize(g, (self.work_w, int(round(h * self.scale))),
                           interpolation=cv2.INTER_AREA)
        return g

    # -- 매 프레임 -----------------------------------------------------------
    def observe(self, bgr, frame_seq: int) -> dict:
        """프레임 하나를 받아 **직전 프레임 → 이 프레임** 상사변환을 기록한다.

        변환을 dx/dy/배율 세 수로 들고 다니다가 워프할 때 조합했더니 틀렸다 —
        배율을 원점 기준으로 적용해서, 원점에서 먼 박스일수록 크게 어긋났다
        (합성 검증에서 12프레임 뒤 101px). 세 수는 "어느 점을 중심으로" 잰
        것인지를 잃어버린다. 그래서 **2x3 행렬을 그대로 들고** 행렬곱으로
        누적한다 — 중심 정보가 행렬 안에 들어 있어 조합이 틀릴 곳이 없다.
        """
        t0 = time.perf_counter()
        g = self._prep(bgr)
        M = np.eye(2, 3, dtype=np.float64)
        n_ok = 0
        if self.prev_gray is not None and self.prev_gray.shape == g.shape:
            p0 = cv2.goodFeaturesToTrack(self.prev_gray, maxCorners=self.max_corners,
                                         qualityLevel=0.01, minDistance=8,
                                         blockSize=7)
            if p0 is not None and len(p0) >= 4:
                p1, st, _ = cv2.calcOpticalFlowPyrLK(
                    self.prev_gray, g, p0, None, winSize=(15, 15), maxLevel=3)
                ok = (st.ravel() == 1)
                n_ok = int(ok.sum())
                if n_ok >= 4:
                    # 회전+균일배율+이동(4자유도). full affine을 쓰지 않는 이유는
                    # 전단(shear)이 노이즈를 흡수해 배율로 새고, 그 배율이 곧
                    # 거리 보정이라 조용히 틀린 거리를 내기 때문이다.
                    est, _inl = cv2.estimateAffinePartial2D(
                        p0[ok], p1[ok], method=cv2.RANSAC,
                        ransacReprojThreshold=3.0, maxIters=200)
                    if est is not None:
                        M = est
                    else:
                        self.fail += 1
                else:
                    self.fail += 1
            else:
                self.fail += 1
        with self._lock:
            self.frames.append((frame_seq, M))
            self.prev_gray, self.prev_seq = g, frame_seq
        self.last_ms = (time.perf_counter() - t0) * 1000.0
        sc = float(np.hypot(M[0, 0], M[0, 1]))
        return {"flow_ms": round(self.last_ms, 1), "flow_points": n_ok,
                "dx": round(float(M[0, 2]), 1), "dy": round(float(M[1, 2]), 1),
                "scale": round(sc, 4)}

    # -- 정렬 ---------------------------------------------------------------
    @staticmethod
    def _to3(M) -> np.ndarray:
        return np.vstack([M, [0.0, 0.0, 1.0]])

    def accumulate(self, from_seq: int):
        """from_seq 이후 현재까지 누적 2x3 행렬과 프레임 수. 작업 해상도 기준."""
        with self._lock:
            mats = [M for seq, M in self.frames if seq > from_seq]
            known = self.prev_seq >= from_seq
        if not mats:
            return (np.eye(2, 3), 0) if known else None
        acc = np.eye(3)
        for M in mats:                      # 오래된 것부터 왼쪽에 곱해 쌓는다
            acc = self._to3(M) @ acc
        return acc[:2], len(mats)

    def warp(self, box, from_seq: int, *, observed_at: float,
             now: float | None = None) -> Aligned | None:
        """관측 프레임의 박스를 현재 프레임 좌표로 옮긴다.

        박스는 **원본 해상도** 좌표로 주고받는다. 내부 작업 해상도는 이 함수
        밖으로 새지 않는다 — 새면 호출부마다 배율을 곱하다가 한 군데를 빠뜨린다.
        """
        got = self.accumulate(from_seq)
        if got is None:
            return None
        M, nframes = got
        now = now or time.time()
        sc = self.scale or 1.0

        # 원본 → 작업 해상도 → 변환 → 원본. 좌표계 왕복을 한 곳에서만 한다.
        x1, y1, x2, y2 = (float(v) for v in box)
        pts = np.array([[[x1 * sc, y1 * sc]], [[x2 * sc, y2 * sc]],
                        [[x1 * sc, y2 * sc]], [[x2 * sc, y1 * sc]]], np.float32)
        out = cv2.transform(pts, M.astype(np.float32)).reshape(-1, 2) / sc
        nx1, ny1 = float(out[:, 0].min()), float(out[:, 1].min())
        nx2, ny2 = float(out[:, 0].max()), float(out[:, 1].max())
        # 배율은 행렬에서 직접 뽑는다 — 박스 크기 비로 재면 회전이 섞여 부푼다.
        asc = float(np.hypot(M[0, 0], M[0, 1]))
        return Aligned(box=(nx1, ny1, nx2, ny2),
                       quality=self._quality(nframes),
                       frames_late=nframes,
                       age_s=now - observed_at,
                       scale=asc)

    @staticmethod
    def _quality(nframes: int) -> float:
        """누적 프레임이 많을수록 드리프트가 쌓인다. 숨기지 않고 값으로 낸다.

        프레임당 추정 오차를 대략 1px로 보면 n프레임 뒤 오차는 sqrt(n)px 규모다.
        왕복 1초(8fps에서 ~8프레임)면 1 근처이고, 앵커가 오래 갱신되지 않으면
        떨어진다.
        """
        if nframes <= 0:
            return 1.0
        return float(max(0.0, min(1.0, 1.0 - nframes / 60.0)))

    def stats(self) -> dict:
        return {"flow_ms": round(self.last_ms, 1), "fail": self.fail,
                "history": len(self.frames), "work_w": self.work_w}
