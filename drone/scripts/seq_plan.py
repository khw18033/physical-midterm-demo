"""seq_plan.py — 복합 이동 미션(전후·좌우·회전·대기를 섞은 단계 목록)의 해석 · 좌표 · 미션 항목.

mission_seq.py 전용 부품이다(mavsdk_guard 와 같은 위상). **순수 함수만** 있고 MAVSDK 없이 import 된다
— 그래서 FC 없이 시험할 수 있고(test_seq_plan.py), 가시화 미리보기가 같은 식을 따라 하는 기준이 된다.

단계(step) 문법:  KIND:VALUE[@SPEED][+cap]
    forward/back/right/left : VALUE m 직선 이동. **그 단계 시점의 기수** 기준(회전 뒤면 바뀐 기수 기준).
                              기수는 돌지 않는다(옆·뒤로 난다).
    cw/ccw                  : 제자리에서 VALUE° 시계/반시계 회전. 이후 단계의 「앞」이 바뀐다.
    hover                   : 그 자리에서 VALUE 초 정지.
    @SPEED                  : 이 이동 단계만의 수평 속도(m/s).
    +cap                    : 이 단계 동안 레이더 캡처(CAP_ON).
    한국어도 받는다: 앞 3, 우 3, 오른쪽:3, 시계 90, 반시계 45, 대기 5, 앞 3 @0.5 +캡처

좌표: L(이륙 지점)이 원점인 북(n)·동(e) 평면(m). 상태 (n, e, yaw) 를 단계마다 굴린다.
    이동  bearing = yaw + {forward 0, right 90, back 180, left 270};  n += d·cos(bearing), e += d·sin(bearing)
    회전  yaw += ±θ  — waypoint 는 ≤90° 조각마다 하나(PX4 는 최단 방향으로 돈다 → 방향 보장)
    대기  같은 자리 · 같은 yaw
가시화용 기체 기준 좌표(fwd, right)는 이륙 직전 기수 h0 를 위(+fwd)로 놓은 좌표다.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field

EARTH_R = 6378137.0  # WGS84 장반경(m) — test_sar 와 같은 평면 근사

# MAVLink
FRAME_MISSION = 2            # MAV_FRAME_MISSION (DO_* 명령)
FRAME_GLOBAL_REL_ALT = 3     # MAV_FRAME_GLOBAL_RELATIVE_ALT (MISSION_ITEM_INT — x·y 는 1e7 정수)
NAV_WAYPOINT, NAV_LAND, NAV_TAKEOFF, DO_CHANGE_SPEED = 16, 21, 22, 178
CMD_NAME = {NAV_WAYPOINT: "WAYPOINT", NAV_LAND: "LAND", NAV_TAKEOFF: "TAKEOFF", DO_CHANGE_SPEED: "SPEED"}

# 단계 종류
MOVE_DEG = {"forward": 0.0, "right": 90.0, "back": 180.0, "left": 270.0}
ROT_SIGN = {"cw": 1.0, "ccw": -1.0}
KINDS = (*MOVE_DEG, *ROT_SIGN, "hover")
# 실행기 파라미터 s{k}_kind 의 숫자 → 종류 (가시화 규약)
KIND_CODE = {0: "forward", 1: "back", 2: "right", 3: "left", 4: "cw", 5: "ccw", 6: "hover"}
KIND_NAME = {"forward": "앞", "back": "뒤", "right": "오른쪽", "left": "왼쪽", "cw": "시계", "ccw": "반시계",
             "hover": "대기"}
ALIASES = {
    "앞": "forward", "전진": "forward", "f": "forward", "fwd": "forward",
    "뒤": "back", "후진": "back", "b": "back",
    "오른쪽": "right", "우": "right", "r": "right",
    "왼쪽": "left", "좌": "left", "l": "left",
    "시계": "cw", "우회전": "cw",
    "반시계": "ccw", "좌회전": "ccw",
    "대기": "hover", "정지": "hover", "h": "hover",
}
LAND_MODES = ("here", "home")         # here: 마지막 단계가 끝난 자리 · home: L 로 돌아와 착륙
LAND_NAME = {"here": "마지막 지점", "home": "이륙 지점(L) 복귀 후"}

# 범위
LIMITS = {"move": (1.0, 50.0), "rot": (1.0, 360.0), "hover": (1.0, 60.0)}
UNIT = {"move": "m", "rot": "°", "hover": "초"}
MIN_STEPS, MAX_STEPS = 1, 20
MIN_ALT, MAX_ALT = 2.0, 30.0
MIN_SPEED, MAX_SPEED = 0.5, 5.0
MAX_RADIUS_LIMIT = 100.0              # --max-radius 상한
MAX_PATH = 300.0                      # 총 수평 이동 거리 상한(m, 복귀 포함)
ROTATE_STEP = 90.0                    # 회전 조각 최대 크기(도)
MIN_GAP = 10.0                        # 캡처 사이 최소 간격(초) — cansar 가 데이터를 옮길 시간

# 예상 시간 계산 상수 (test_sar.estimate_s 와 같은 대략값)
TAKEOFF_MPS, LAND_MPS, YAW_DPS, ACC_PAD_S, MARGIN_S = 1.0, 0.7, 30.0, 4.0, 10.0


def group(kind: str) -> str:
    return "move" if kind in MOVE_DEG else "rot" if kind in ROT_SIGN else "hover"


def fmt(x: float) -> str:
    """숫자를 짧게: 3.0 → '3', 0.50 → '0.5'. 소수 셋째 자리까지. (가시화의 Number(x.toFixed(3)).toString() 과 같다)"""
    s = f"{float(x):.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


@dataclass(frozen=True)
class Step:
    kind: str
    value: float
    speed: float | None = None        # 이동 단계만. None 이면 미션 기본 속도
    capture: bool = False

    @property
    def group(self) -> str:
        return group(self.kind)

    def text(self) -> str:
        """정규형 — 명령줄 --step 과 미션 키에 쓰인다."""
        s = f"{self.kind}:{fmt(self.value)}"
        if self.speed is not None:
            s += f"@{fmt(self.speed)}"
        return s + ("+cap" if self.capture else "")

    def label(self) -> str:
        s = f"{KIND_NAME[self.kind]} {fmt(self.value)}{UNIT[self.group]}"
        if self.speed is not None:
            s += f" @{fmt(self.speed)}m/s"
        return s + (" +캡처" if self.capture else "")


_STEP_RE = re.compile(r"^\s*([^\s:@+\d.]+)\s*:?\s*(\d+(?:\.\d+)?|\.\d+)\s*(?:@\s*(\d+(?:\.\d+)?|\.\d+))?\s*(\+\s*(?:cap|캡처))?\s*$",
                      re.IGNORECASE)


def parse_step(text: str) -> Step:
    """'right:3', '우 3', '앞 2 @0.5 +캡처' → Step. 범위는 check_step 이 본다."""
    m = _STEP_RE.match(text)
    if not m:
        raise ValueError(f"단계를 못 읽었다: {text!r} — 예) right:3, 앞 2, 시계 90, 대기 5, forward:2@0.5+cap")
    word = m.group(1).lower()
    kind = word if word in KINDS else ALIASES.get(word)
    if kind is None:
        raise ValueError(f"모르는 단계 종류 {m.group(1)!r} — {', '.join(KINDS)} (또는 앞/뒤/오른쪽/왼쪽/시계/반시계/대기)")
    speed = float(m.group(3)) if m.group(3) is not None else None
    return Step(kind, float(m.group(2)), speed, m.group(4) is not None)


def check_step(step: Step, k: int | None = None) -> None:
    where = f"단계 {k} " if k is not None else ""
    if step.kind not in KINDS:
        raise ValueError(f"{where}종류 {step.kind!r} 를 모른다")
    if not math.isfinite(step.value):
        raise ValueError(f"{where}값이 숫자가 아니다")
    lo, hi = LIMITS[step.group]
    if not lo <= step.value <= hi:
        raise ValueError(f"{where}{KIND_NAME[step.kind]} 값은 {fmt(lo)}~{fmt(hi)}{UNIT[step.group]} 여야 한다 "
                         f"(받은 값 {fmt(step.value)})")
    if step.speed is not None:
        if step.group != "move":
            raise ValueError(f"{where}속도(@)는 이동 단계에만 줄 수 있다")
        if not MIN_SPEED <= step.speed <= MAX_SPEED:
            raise ValueError(f"{where}속도는 {fmt(MIN_SPEED)}~{fmt(MAX_SPEED)} m/s 여야 한다")


@dataclass
class Config:
    altitude: float = 5.0
    speed: float = 1.0
    accept_radius: float = 0.5
    align_hold: float = 3.0
    settle: float = 2.0
    gap: float = MIN_GAP
    land: str = "here"
    max_radius: float = 30.0


def check_config(cfg: Config) -> None:
    if not MIN_ALT <= cfg.altitude <= MAX_ALT:
        raise ValueError(f"고도는 {fmt(MIN_ALT)}~{fmt(MAX_ALT)} m 여야 한다")
    if not MIN_SPEED <= cfg.speed <= MAX_SPEED:
        raise ValueError(f"속도는 {fmt(MIN_SPEED)}~{fmt(MAX_SPEED)} m/s 여야 한다")
    if not 0.1 <= cfg.accept_radius <= 5.0:
        raise ValueError("도달 반경은 0.1~5 m 여야 한다")
    if cfg.align_hold < 0 or cfg.settle < 0:
        raise ValueError("--align-hold · --settle 은 0 이상이어야 한다")
    if cfg.gap < MIN_GAP:
        raise ValueError(f"--gap 은 {fmt(MIN_GAP)}초 이상이어야 한다")
    if cfg.land not in LAND_MODES:
        raise ValueError(f"착륙 위치는 {'/'.join(LAND_MODES)} 중 하나여야 한다")
    if not 1.0 <= cfg.max_radius <= MAX_RADIUS_LIMIT:
        raise ValueError(f"--max-radius 는 1~{fmt(MAX_RADIUS_LIMIT)} m 여야 한다")


def check_steps(steps: list[Step], cfg: Config) -> None:
    """단계 수 · 각 단계 범위 · 이동이 도달 반경보다 긴지. 거리 제한은 build 가 본다."""
    if not MIN_STEPS <= len(steps) <= MAX_STEPS:
        raise ValueError(f"단계 수는 {MIN_STEPS}~{MAX_STEPS} 여야 한다 (받은 수 {len(steps)})")
    for k, s in enumerate(steps, 1):
        check_step(s, k)
        if s.group == "move" and s.value <= cfg.accept_radius:
            raise ValueError(f"단계 {k} 이동 {fmt(s.value)} m 가 도달 반경 {fmt(cfg.accept_radius)} m 이하다 "
                             f"— 출발 즉시 도달로 친다")


# ── 좌표 ────────────────────────────────────────────────────────────────

def wrap360(a: float) -> float:
    a = a % 360.0
    return 0.0 if abs(a - 360.0) < 1e-9 else a


def latlon(lat0: float, lon0: float, n: float, e: float) -> tuple[float, float]:
    """L(lat0, lon0) 기준 북 n · 동 e (m) 인 점의 위경도. 평면 근사."""
    return (lat0 + math.degrees(n / EARTH_R),
            lon0 + math.degrees(e / (EARTH_R * math.cos(math.radians(lat0)))))


def ne(lat0: float, lon0: float, lat: float, lon: float) -> tuple[float, float]:
    """(lat0, lon0) 기준 (lat, lon) 의 북·동 거리(m). test_sar.ne 와 같은 식."""
    n = math.radians(lat - lat0) * EARTH_R
    e = math.radians(lon - lon0) * EARTH_R * math.cos(math.radians((lat0 + lat) / 2))
    return n, e


def body(n: float, e: float, h0: float) -> tuple[float, float]:
    """북·동 → 이륙 직전 기수 h0 기준 (앞 fwd, 오른쪽 right)."""
    h = math.radians(h0)
    return n * math.cos(h) + e * math.sin(h), -n * math.sin(h) + e * math.cos(h)


def rot_pieces(angle: float) -> list[float]:
    """회전 θ 를 ≤ROTATE_STEP 의 같은 조각으로. 270 → [90, 90, 90], 100 → [50, 50]."""
    n = max(1, math.ceil(angle / ROTATE_STEP - 1e-9))
    return [angle / n] * n


@dataclass
class StepGeo:
    """단계 하나의 기하. 좌표는 L 원점 북·동(m)."""
    k: int
    step: Step
    start: tuple[float, float]
    end: tuple[float, float]
    yaw_start: float
    yaw_end: float
    first_seq: int = -1               # 이 단계 항목들의 미션 seq 범위(속도 항목 포함)
    last_seq: int = -1
    turned: float = 0.0               # 이 단계 끝까지 누적 회전(도, +시계). 360 을 넘어도 그대로 센다

    @property
    def length(self) -> float:
        return math.dist(self.start, self.end)


def geometry(steps: list[Step], h0: float) -> list[StepGeo]:
    """단계마다 시작·끝 위치와 yaw. 방향은 그 단계 시점의 기수(회전 누적) 기준."""
    n = e = turned = 0.0
    yaw = wrap360(h0)
    out = []
    for k, s in enumerate(steps, 1):
        start, y0 = (n, e), yaw
        if s.group == "move":
            b = math.radians(yaw + MOVE_DEG[s.kind])
            n, e = n + s.value * math.cos(b), e + s.value * math.sin(b)
        elif s.group == "rot":
            yaw = wrap360(yaw + ROT_SIGN[s.kind] * s.value)
            turned += ROT_SIGN[s.kind] * s.value
        out.append(StepGeo(k, s, start, (n, e), y0, yaw, turned=turned))
    return out


# ── 미션 ────────────────────────────────────────────────────────────────

@dataclass
class Item:
    """MAVSDK mission_raw.MissionItem 과 같은 필드(순서도 같다). mission_seq 가 MissionItem 으로 바꿔 올린다."""
    seq: int
    frame: int
    command: int
    current: int
    autocontinue: int
    param1: float
    param2: float
    param3: float
    param4: float
    x: int
    y: int
    z: float
    mission_type: int = 0

    def fields(self) -> tuple:
        return (self.seq, self.frame, self.command, self.current, self.autocontinue, self.param1, self.param2,
                self.param3, self.param4, self.x, self.y, self.z, self.mission_type)


# 역할 종류: takeoff · align · speed(k=단계, 0=복귀) · move · rot · hover · rest(캡처 사이 쉼, k=앞 단계) · return · land
STEP_KINDS = ("speed", "move", "rot", "hover")     # k ≥ 1 이면 단계 k 의 항목


@dataclass
class Plan:
    steps: list[Step]
    cfg: Config
    lat0: float
    lon0: float
    h0: float
    geo: list[StepGeo] = field(default_factory=list)
    items: list[Item] = field(default_factory=list)
    roles: list[tuple[str, int]] = field(default_factory=list)
    land_ne: tuple[float, float] = (0.0, 0.0)
    land_yaw: float = 0.0
    preview: bool = False             # 연결 전 미리보기(h0 · L 을 아직 모른다)

    # ── 만들기 ──
    def _add(self, role, command, frame, p1=0.0, p2=0.0, p3=0.0, p4=0.0, n=0.0, e=0.0, z=0.0, local=True):
        seq = len(self.items)
        lat, lon = latlon(self.lat0, self.lon0, n, e) if local else (0.0, 0.0)
        self.items.append(Item(seq, frame, command, 1 if seq == 0 else 0, 1, float(p1), float(p2), float(p3), float(p4),
                               int(round(lat * 1e7)), int(round(lon * 1e7)), float(z)))
        self.roles.append(role)
        return seq

    def _wp(self, role, n, e, yaw, hold):
        # NAV_WAYPOINT: p1 머무는 시간(s), p2 도달 반경(m), p3 통과 반경, p4 헤딩(도)
        return self._add(role, NAV_WAYPOINT, FRAME_GLOBAL_REL_ALT, hold, self.cfg.accept_radius, 0.0, wrap360(yaw),
                         n, e, self.cfg.altitude)

    def _speed(self, role, v):
        # DO_CHANGE_SPEED: p1 1 = 대지속도, p2 속도(m/s), p3 -1 = 스로틀 변경 없음
        return self._add(role, DO_CHANGE_SPEED, FRAME_MISSION, 1.0, v, -1.0, 0.0, local=False)

    # ── 읽기 ──
    def role_at(self, seq: int) -> tuple[str, int]:
        return self.roles[seq] if 0 <= seq < len(self.roles) else ("?", 0)

    def step_of(self, seq: int) -> int:
        """seq 가 속한 단계 번호. 단계 밖(이륙·정렬·쉼·복귀·착륙)이면 0."""
        kind, k = self.role_at(seq)
        return k if kind in STEP_KINDS and k >= 1 else 0

    @property
    def land_seq(self) -> int:
        return self.roles.index(("land", 0))

    def points_ne(self) -> list[tuple[float, float]]:
        """비행 경로의 꼭짓점: L, 각 단계 끝, (home 이면) L."""
        pts = [(0.0, 0.0)] + [g.end for g in self.geo]
        if self.cfg.land == "home":
            pts.append((0.0, 0.0))
        return pts

    @property
    def max_r(self) -> float:
        return max(math.hypot(n, e) for n, e in self.points_ne())

    @property
    def path_m(self) -> float:
        p = self.points_ne()
        return sum(math.dist(a, b) for a, b in zip(p, p[1:]))

    def estimate_s(self) -> float:
        """미션 예상 시간(초) — 시간 초과 판정 기준. 대략값."""
        c = self.cfg
        t = c.altitude / TAKEOFF_MPS + 6 + c.align_hold + c.altitude / LAND_MPS + MARGIN_S
        for g in self.geo:
            s = g.step
            if s.group == "move":
                t += s.value / (s.speed or c.speed) + ACC_PAD_S + c.settle
            elif s.group == "rot":
                t += s.value / YAW_DPS + len(rot_pieces(s.value)) + c.settle
            else:
                t += s.value
        t += c.gap * sum(1 for kind, _ in self.roles if kind == "rest")
        if c.land == "home":
            t += math.hypot(*self.land_from) / c.speed + ACC_PAD_S + c.settle
        return t

    @property
    def land_from(self) -> tuple[float, float]:
        return self.geo[-1].end if self.geo else (0.0, 0.0)

    def timeout_s(self) -> float:
        return self.estimate_s() * 2 + 60

    def key(self) -> str:
        """미션의 정규형 문자열 — 같은 키면 같은 비행이다(가시화가 dry-run 과 실비행을 맞춰 본다).
        고도 · 기본 속도 · 착륙 위치 · 단계만 넣는다(현장 기수 · 위치는 비행마다 다르므로 뺀다)."""
        return (f"v1|alt={fmt(self.cfg.altitude)}|spd={fmt(self.cfg.speed)}|land={self.cfg.land}|"
                + ";".join(s.text() for s in self.steps))

    def hash(self) -> str:
        return mission_hash(self.key())

    def describe(self, seq: int) -> str:
        item, (kind, k) = self.items[seq], self.roles[seq]
        name = CMD_NAME.get(item.command, str(item.command))
        tag = {"takeoff": "이륙", "align": "yaw 정렬", "rest": f"캡처 간격(단계 {k} 뒤)", "return": "L 복귀",
               "land": "착륙", "speed": f"속도(단계 {k})" if k else "속도(복귀)"}.get(kind)
        if tag is None:
            tag = f"단계 {k} {self.steps[k - 1].label()}"
            if kind == "rot":
                tag += f" [{self.items[seq].param4:.0f}°]"
        if item.command == DO_CHANGE_SPEED:
            return f"#{seq:<2} {name:<8} {tag} {item.param2:g}m/s"
        s = f"#{seq:<2} {name:<8} {tag}  {item.x / 1e7:.7f}, {item.y / 1e7:.7f}  고도 {item.z:g}m  헤딩 {item.param4:.1f}°"
        if item.command == NAV_WAYPOINT:
            s += f"  대기 {item.param1:g}s  반경 {item.param2:g}m"
        return s

    def to_json(self) -> dict:
        """[계획] 줄의 본문 — 가시화가 지도 · 진행 표시에 쓴다(MISSION_SEQ_요청_VZ.md)."""
        def pt(n, e):
            f, r = body(n, e, self.h0)
            lat, lon = latlon(self.lat0, self.lon0, n, e)
            return {"n": round(n, 3), "e": round(e, 3), "fwd": round(f, 3), "right": round(r, 3),
                    "lat": round(lat, 8), "lon": round(lon, 8)}
        land = (0.0, 0.0) if self.cfg.land == "home" else self.land_from
        return {
            "v": 1, "key": self.key(), "hash": self.hash(),
            "L": [round(self.lat0, 8), round(self.lon0, 8)], "h0": round(self.h0, 2),
            "alt": self.cfg.altitude, "speed": self.cfg.speed, "land": self.cfg.land,
            "est_s": round(self.estimate_s()), "timeout_s": round(self.timeout_s()),
            "max_r": round(self.max_r, 2), "path_m": round(self.path_m, 2), "n_items": len(self.items),
            "roles": [[kind, k] for kind, k in self.roles],
            "steps": [{"k": g.k, "kind": g.step.kind, "value": g.step.value, "speed": g.step.speed,
                       "cap": g.step.capture, "label": g.step.label(), "text": g.step.text(),
                       "seq": [g.first_seq, g.last_seq], "yaw": round(g.yaw_end, 2),
                       "from": pt(*g.start), "to": pt(*g.end)} for g in self.geo],
            "land_pt": pt(*land),
        }


def mission_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def build(steps: list[Step], cfg: Config, lat0: float, lon0: float, h0: float) -> Plan:
    """단계 목록 → FC 에 올릴 미션. 범위 · 거리 제한을 어기면 ValueError.

    TAKEOFF(L) → WAYPOINT yaw 정렬(L, h0, align_hold)
    → 이동: SPEED → WAYPOINT(끝점, yaw, settle)
      회전: WAYPOINT(같은 자리, yaw+조각) × 조각 수 (마지막 조각만 settle)
      대기: WAYPOINT(같은 자리, yaw, hold=값)
      +cap 단계 뒤에 캡처 단계가 또 있으면: WAYPOINT 쉼(같은 자리, hold=max(settle, gap))
    → here: LAND(마지막 지점) / home: SPEED → WAYPOINT(L) → LAND(L)
    """
    check_config(cfg)
    check_steps(steps, cfg)
    p = Plan(list(steps), cfg, lat0, lon0, wrap360(h0))
    p.geo = geometry(p.steps, p.h0)
    if p.max_r > cfg.max_radius + 1e-6:
        raise ValueError(f"경로가 이륙 지점에서 최대 {p.max_r:.1f} m 까지 간다 — 허용 반경 {fmt(cfg.max_radius)} m "
                         f"(--max-radius)를 넘는다")
    if p.path_m > MAX_PATH:
        raise ValueError(f"총 이동 거리 {p.path_m:.0f} m 가 상한 {fmt(MAX_PATH)} m 를 넘는다")

    # NAV_TAKEOFF: p4 헤딩(PX4 는 이륙 중 무시), z 이륙 고도
    p._add(("takeoff", 0), NAV_TAKEOFF, FRAME_GLOBAL_REL_ALT, 0.0, 0.0, 0.0, p.h0, 0.0, 0.0, cfg.altitude)
    # 목표 고도 도달 후 L 상공에서 이륙 직전 yaw 로 돌린다(test_sar 와 같다)
    p._wp(("align", 0), 0.0, 0.0, p.h0, cfg.align_hold)
    cap_ks = [g.k for g in p.geo if g.step.capture]
    for g in p.geo:
        s, k = g.step, g.k
        n, e = g.end
        if s.group == "move":
            g.first_seq = p._speed(("speed", k), s.speed or cfg.speed)
            g.last_seq = p._wp(("move", k), n, e, g.yaw_end, cfg.settle)
        elif s.group == "rot":
            yaw = g.yaw_start
            pieces = rot_pieces(s.value)
            for i, piece in enumerate(pieces):
                yaw += ROT_SIGN[s.kind] * piece
                seq = p._wp(("rot", k), n, e, yaw, cfg.settle if i == len(pieces) - 1 else 0.0)
                g.first_seq = seq if i == 0 else g.first_seq
                g.last_seq = seq
        else:
            g.first_seq = g.last_seq = p._wp(("hover", k), n, e, g.yaw_end, s.value)
        if s.capture and any(c > k for c in cap_ks):
            p._wp(("rest", k), n, e, g.yaw_end, max(cfg.settle, cfg.gap))
    last = p.geo[-1]
    p.land_yaw = last.yaw_end
    if cfg.land == "home":
        p._speed(("speed", 0), cfg.speed)
        p._wp(("return", 0), 0.0, 0.0, last.yaw_end, cfg.settle)
        p.land_ne = (0.0, 0.0)
    else:
        p.land_ne = last.end
    # NAV_LAND: p4 헤딩
    p._add(("land", 0), NAV_LAND, FRAME_GLOBAL_REL_ALT, 0.0, 0.0, 0.0, wrap360(last.yaw_end), *p.land_ne, 0.0)
    return p


# ── 확인 화면용 평면도 ─────────────────────────────────────────────────

def _label(k: int) -> str:
    return str(k) if k < 10 else chr(ord("A") + k - 10)


def render_map(plan: Plan, width: int = 41, height: int = 17) -> list[str]:
    """글자 평면도. 위 = 이륙 직전 기수(h0) 방향, 오른쪽 = 기체 오른쪽. L 이륙 지점, 숫자 = 단계 끝, # = 착륙."""
    pts = [(0.0, 0.0, "L")]
    for g in plan.geo:
        if g.step.group == "move":
            f, r = body(*g.end, plan.h0)
            pts.append((f, r, _label(g.k)))
    land_f, land_r = body(*plan.land_ne, plan.h0)
    ext = max([1.0] + [max(abs(f), abs(r)) for f, r, _ in pts])
    cx, cy = (width - 1) // 2, (height - 1) // 2
    sx, sy = cx / ext, cy / ext

    def cell(f, r):
        return cy - int(round(f * sy)), cx + int(round(r * sx))

    grid = [[" "] * width for _ in range(height)]
    for (f0, r0, _), (f1, r1, _) in zip(pts, pts[1:]):
        steps = max(2, int(math.dist((f0, r0), (f1, r1)) * max(sx, sy) * 2))
        for i in range(steps + 1):
            y, x = cell(f0 + (f1 - f0) * i / steps, r0 + (r1 - r0) * i / steps)
            grid[y][x] = "·"
    if plan.cfg.land == "home" and plan.geo:
        f0, r0 = body(*plan.land_from, plan.h0)
        steps = max(2, int(math.hypot(f0, r0) * max(sx, sy) * 2))
        for i in range(steps + 1):
            y, x = cell(f0 * (1 - i / steps), r0 * (1 - i / steps))
            if grid[y][x] == " ":
                grid[y][x] = ":"
    for f, r, lab in pts:
        y, x = cell(f, r)
        grid[y][x] = lab if grid[y][x] in (" ", "·", ":") else "*"
    y, x = cell(land_f, land_r)
    grid[y][x] = "*" if grid[y][x] == "L" else "#"      # 착륙이 L 과 겹치면(home) 겹침 표시
    border = "+" + "-" * width + "+"
    out = [border] + ["|" + "".join(row) + "|" for row in grid] + [border]
    h0 = "" if plan.preview else f"({plan.h0:.0f}°)"
    out.append(f"  ↑ 위 = 이륙 직전 기수{h0}. L 이륙 · 숫자 단계 끝 · # 착륙 · * 겹침  "
               f"(한 칸 가로 ≈{ext / cx:.2f} m, 세로 ≈{ext / cy:.2f} m)")
    return out
