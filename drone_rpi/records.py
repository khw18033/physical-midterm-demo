"""엣지가 늦게 준 판정을 **현재 프레임에 실시간으로 얹는** 레코드 계층.

implements: AI-S-06, AI-S-03, AI-C-03, AI-C-02, AI-L-01

풀려는 문제:
  말단이 프레임 N을 내주고 판정을 받기까지 왕복이 걸린다(실측 수백 ms~1s).
  그 사이 기체가 움직였고 화면은 이미 프레임 N+k다. **판정이 가리키는 박스
  좌표는 도착하는 순간 이미 낡았다.** focal_px 590·속도 5 m/s·왕복 0.9s 기준
  이동량이 거리 20m에서 133px, 50m에서 53px이다. 그냥 두면 라벨이 엉뚱한
  자리에 붙는다.

해법 — **옵티컬 플로우로 좌표를 옮긴다**(alignment.FlowAligner):
  * 말단은 프레임마다 직전 프레임 대비 (이동, 배율)을 KLT로 추정해 쌓는다.
    Pi 5 실측 6.0 ms/frame.
  * 판정이 오면 `frame_seq`(= 어느 프레임을 보고 낸 판정인가)부터 지금까지의
    누적 변환으로 박스를 옮긴다.
  * 옮긴 결과에는 `quality`(누적 드리프트)와 `age_s`가 붙는다.

**예전에는 RPN+ByteTrack의 track_id에 매달았다.** 그것도 동작했지만
프레임당 350ms였고, 같은 일을 플로우가 6ms에 한다(58배). 정렬이 필요로 하는
것은 움직임이지 정체성이기 때문이다. 걷어낸 대가와 완화책은
`alignment.py` 첫머리에 적어 두었다.

낡음을 숨기지 않는다 (AI-S-03):
  항목마다 `observed_at`·`applied_at`·`age_s`·`frames_late`·`quality`를 남긴다.
  근거 충분도는 최신성을 봐야 하는데 나이를 지우면 소비자가 그 판단을 못 한다.

좌표는 로컬 영상 좌표뿐이다. 전역 변환은 백엔드 몫이다(AI-C-02).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Range:
    """엣지 depth가 낸 **거리 근거**. 의미 근거와 성질이 다르다.

    라벨은 시간이 지나도 낡지 않는다 — 450ms 전에 사람이었으면 지금도 사람이다.
    **거리는 그렇지 않다.** 속도 5 m/s면 그 사이 기체가 2.25 m 움직이고,
    "그때 32 m였다"는 지금 32 m라는 뜻이 아니다.

    그래서 따로 둔다. 같은 dict에 섞으면 "낡아도 되는 근거"와 "낡으면 틀린
    근거"가 구분되지 않는다(AI-S-03).

    ── 낡음을 줄이는 방법: 플로우 배율 ────────────────────────────────────────
    depth는 엣지에서만 돌 수 있다(Pi 5 실측 75 GFLOPS 대비 MoGe2-Aerial ViT-L이
    1.04 TFLOPs라 프레임당 ~35초). 핀홀에서 겉보기 크기는 거리에 반비례하므로
    (h_px ∝ 1/Z), 관측 이후 누적 배율 s를 알면:

        Z_now ≈ Z_observed / s

    그 s는 정렬이 이미 계산해 둔 값이다(`Aligned.scale`) — 추가 비용이 0이다.

    `ego_compensated`는 여전히 False다. 이건 배율 보정이지 pose 보정이 아니다.
    옆으로만 지나가는 움직임은 잡지 못하고, 회전이나 가림으로 겉보기 크기가
    변하면 그걸 거리 변화로 착각한다. MAVLink로 고도·자세가 들어와 제대로 빼기
    전까지는 그렇게 부르지 않는다 — 없는 것을 있는 척하지 않는다.
    """

    meters: float
    source: str        # "moge2_aerial" | "class_prior" | "stereo" | "ground_plane"
    confidence: float | None = None
    ego_compensated: bool = False

    def at_scale(self, scale: float) -> tuple[float, float | None]:
        """누적 배율로 당긴 거리와 그 배율. 배율이 터무니없으면 원값을 돌려준다."""
        if not scale or not (0.33 <= scale <= 3.0):
            return self.meters, None
        return self.meters / scale, scale

    def to_dict(self, scale: float | None = None) -> dict:
        d = {"meters": round(self.meters, 2), "source": self.source,
             "confidence": self.confidence,
             "ego_compensated": self.ego_compensated}
        if scale is not None:
            m, s = self.at_scale(scale)
            d["meters_now"] = round(m, 2)
            d["scale_ratio"] = round(s, 3) if s else None
        return d


@dataclass
class Obstacle:
    """엣지가 판정한 장애물 하나. 좌표는 **관측 당시** 것이고 표시할 때 옮긴다.

    정체성을 말단이 만들지 않는다 — 엣지가 자기 검출에 붙인 id를 그대로 쓴다.
    말단이 따로 추적기를 돌리면 정체성 공간이 둘이 되고, 그 매칭이 틀리면
    근거가 엉뚱한 객체에 붙는다(예전 구조의 실제 위험이었다).
    """

    obs_id: str                                   # 엣지가 준 식별자
    label: str | None
    conf: float | None
    observed_box: tuple[float, float, float, float]
    observed_seq: int                             # 어느 프레임을 보고 낸 판정인가
    observed_at: float
    applied_at: float
    source: str = "ovd"
    range: Range | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    @property
    def age_s(self) -> float:
        return time.time() - self.observed_at


class ObstacleStore:
    """엣지 판정을 담아 두고, 매 프레임 현재 좌표로 옮겨 내보낸다.

    말단이 소유하는 상태는 이것뿐이다 — 후보도, 트랙도, 추적기도 없다.
    """

    def __init__(self, aligner, *, ttl_s: float = 6.0, max_items: int = 200):
        self.aligner = aligner
        self.ttl_s = ttl_s
        self.max_items = max_items
        self._lock = threading.Lock()
        self.items: dict[str, Obstacle] = {}
        self.applied = self.dropped_stale = 0

    # -- 수신 ---------------------------------------------------------------
    def apply_verdict(self, verdict: dict, now: float | None = None) -> dict:
        """엣지 판정을 담는다. 좌표는 옮기지 않는다 — 내보낼 때 옮긴다.

        여기서 옮기면 그 순간의 좌표로 굳어서, 다음 프레임에는 다시 낡는다.
        **표시 시점에 옮겨야** 매 프레임 최신이 된다.
        """
        now = now or time.time()
        observed_at = float(verdict.get("observed_at") or now)
        seq = int(verdict.get("frame_seq", 0))
        n = 0
        with self._lock:
            for item in verdict.get("per_track") or verdict.get("obstacles") or []:
                box = item.get("box") or (item.get("ovd") or {}).get("box")
                oid = str(item.get("obs_id") or item.get("track_id") or "")
                if not box or not oid:
                    continue
                ev = item.get("ovd") or {}
                rng = item.get("range")
                self.items[oid] = Obstacle(
                    obs_id=oid,
                    label=ev.get("label"),
                    conf=ev.get("conf"),
                    observed_box=tuple(float(v) for v in box),
                    observed_seq=seq,
                    observed_at=observed_at,
                    applied_at=now,
                    source=item.get("source", "ovd"),
                    range=(Range(meters=float(rng["meters"]),
                                 source=str(rng.get("source", "unknown")),
                                 confidence=rng.get("confidence"))
                           if rng and rng.get("meters") is not None else None),
                    payload=ev)
                n += 1
            # 상한은 오래된 것부터. 화면과 메모리 둘 다의 마지막 방어선이다.
            if len(self.items) > self.max_items:
                for k in sorted(self.items,
                                key=lambda k: self.items[k].observed_at
                                )[:len(self.items) - self.max_items]:
                    self.items.pop(k, None)
        self.applied += n
        return {"applied": n, "frame_seq": seq,
                "age_s": round(now - observed_at, 3),
                "held": len(self.items)}

    # -- 내보내기 -------------------------------------------------------------
    def current(self, now: float | None = None) -> list[dict]:
        """**지금 프레임 좌표로 옮긴** 장애물 목록.

        이것이 말단이 하는 일의 전부다 — 엣지가 준 것을 현재 시점에 얹는다.
        """
        now = now or time.time()
        out = []
        with self._lock:
            stale = [k for k, o in self.items.items()
                     if now - o.observed_at > self.ttl_s]
            for k in stale:
                self.items.pop(k, None)
            self.dropped_stale += len(stale)
            items = list(self.items.values())

        for o in items:
            al = self.aligner.warp(o.observed_box, o.observed_seq,
                                   observed_at=o.observed_at, now=now)
            if al is None:
                continue
            d = {"obs_id": o.obs_id, "label": o.label, "conf": o.conf,
                 "box": [round(v, 1) for v in al.box],
                 "observed_box": [round(v, 1) for v in o.observed_box],
                 # 얼마나 옮겼는지 — 0이면 그 사이 화면이 안 움직였다는 뜻이고,
                 # 그때는 "정렬했다"와 "안 했다"를 화면에서 구분할 수 없다.
                 # 구분 불가를 정렬 성공으로 보고하지 않는다.
                 "moved_px": round(
                     ((al.box[0] + al.box[2]) / 2 - (o.observed_box[0] + o.observed_box[2]) / 2) ** 2
                     + ((al.box[1] + al.box[3]) / 2 - (o.observed_box[1] + o.observed_box[3]) / 2) ** 2, 1) ** 0.5,
                 "age_s": round(al.age_s, 2),
                 "frames_late": al.frames_late,
                 "quality": round(al.quality, 2),
                 "source": o.source}
            d["moved_px"] = round(d["moved_px"], 1)
            if o.range is not None:
                d["range"] = o.range.to_dict(al.scale)
                # 배율 보정은 pose 보정이 아니다 — 소비자가 그 사실을 보게 한다.
                d["range"]["stale_warning"] = (not o.range.ego_compensated
                                               and al.age_s > 0.2)
            out.append(d)
        out.sort(key=lambda d: (-(d["label"] is not None), -d["age_s"]))
        return out

    def snapshot(self) -> dict:
        with self._lock:
            return {"held": len(self.items), "applied_total": self.applied,
                    "dropped_stale": self.dropped_stale,
                    "obstacles": [{"obs_id": o.obs_id, "label": o.label,
                                   "conf": o.conf, "age_s": round(o.age_s, 2),
                                   "range": o.range.to_dict() if o.range else None}
                                  for o in self.items.values()]}
