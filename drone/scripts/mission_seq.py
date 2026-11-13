#!/usr/bin/env python3
# ============================================================================
# mission_seq.py — 복합 이동 미션: 전후·좌우·회전·대기를 섞은 단계 목록을 하나의 미션으로 (MAVSDK-Python, **미션 방식**)
#
# 예) 5m 이륙 → 오른쪽 3m → 앞 1m → 그 자리에 착륙
#       ./venv/bin/python scripts/mission_seq.py --altitude 5 --step right:3 --step forward:1
#     FC 에 올라가는 미션:
#       #0 TAKEOFF 5m → #1 WAYPOINT yaw 정렬(L) → #2 SPEED → #3 WAYPOINT 오른쪽 3m → #4 SPEED → #5 WAYPOINT 앞 1m → #6 LAND
#
# 단계 (자세한 문법은 seq_plan.py 머리말)
#   forward/back/right/left:M  그 단계 시점의 기수 기준으로 M 미터 직선 이동. 기수는 돌지 않는다(옆·뒤로 난다).
#   cw/ccw:DEG                 제자리 회전. **이후 단계의 앞·오른쪽은 회전한 뒤의 기수 기준이다.**
#   hover:SEC                  제자리 정지.
#   꼬리 @SPEED(이 단계 속도) · +cap(이 단계 동안 레이더 캡처). 한국어(앞 3, 우 3, 시계 90, 대기 5)도 받는다.
#   단계 1~20개. 이동 1~50m, 회전 1~360°, 대기 1~60초.
#   입력: --step 반복 / --mission FILE.json / (터미널에서 단계 없이 실행하면) 대화형.
#
# 착륙: --land here(기본) 마지막 단계가 끝난 자리 · --land home 이륙 지점(L)으로 돌아와 착륙.
# 캡처: 기본은 하지 않는다. +cap 단계만 CAP_ON 을 켠다(이동은 출발~목표 도달, 회전·대기는 그 단계 동안).
#       캡처 단계 뒤에 캡처 단계가 또 있으면 사이에 --gap(≥10초) 쉼 waypoint 를 넣는다.
#
# ★ 미션 방식 — test_sar.py 와 같다 (SAR_FLIGHT_SCRIPTS.md §2)
#   이륙~단계~착륙 전체를 FC 에 미션으로 올리고, 내려받아 한 항목씩 대조한 뒤에만 arm·시작한다.
#   비행 중 Pi·SSH·mavsdk_server 가 죽어도 FC 가 혼자 끝까지 날고 착륙한다.
#   · 모든 waypoint p4 에 그 시점의 yaw 를 넣는다. 회전은 ≤90° 조각으로 나눠 방향을 보장한다.
#   · 이동 waypoint 앞마다 DO_CHANGE_SPEED (PX4 가 재개 시 속도를 되돌린다).
#   · 이륙 직전 yaw 를 h0 로 기억하고 arm 직전에 ±5°·1m 안인지 다시 본다. 이륙 뒤 L 상공에서 h0 로 정렬.
#   · Ctrl+C·SIGTERM·시간 초과 → 캡처 OFF → --abort(기본 rtl). Pi 쪽 오류 → 명령 안 보냄(미션이 FC 에 있다).
#     모드가 MISSION 밖으로 바뀌면(조종기 개입·페일세이프) 캡처만 끄고 손을 뗀다.
#
# 안전 제한(arm 전에 걸리면 이륙하지 않는다)
#   · 모든 경로 점이 이륙 지점에서 --max-radius(기본 30m) 안. FC 지오펜스 GF_MAX_HOR_DIST 가 켜져 있으면 그보다 안.
#   · 총 이동 거리 300m 이하, 고도 2~30m, 속도 0.5~5m/s.
#
# RTK: --rtk-min SEC(기본 0 = 확인 안 함). >0 이면 이륙 전 Fixed 가 그만큼 연속 유지될 때까지 기다리고
#      경로 기준점(L)을 그 뒤에 잡는다. 캡처 중 Fixed 가 풀리면 CAP SUMMARY 에 rtk=LOST.
#
# 로그(가시화가 원문을 읽는다 — 문구를 바꾸면 docs/MISSION_SEQ_요청_VZ.md 도 고칠 것)
#   [계획] {json}              경로·항목 역할·좌표 (한 줄, 업로드 전)
#   [미션] 진행 #n …            FC 가 지금 수행 중인 항목
#   STEP k/N START · END       단계 시작·끝 (END 에 목표점 오차)
#   CAP k START · END · SUMMARY 캡처
#
# 실행 조건 : ★★ 기체가 실제로 날아오른다. 경로 전체·비행 고도 이상이 비어 있는 야외에서.
#             ★ 조종기를 손에 들고 즉시 개입할 수 있을 것. 비상 착륙 창(emergency_land.py)을 미리 열어 둘 것.
#             ★ 실행 전 "yes" 를 직접 입력해야 진행된다. 자동 실행(systemd·cron)에 넣지 않는다.
#             ★ 먼저 --dry-run 으로: 경로 계산 → 미션 업로드 → 대조 → 삭제 (arm 하지 않는다).
#
# 위험도  : ★★★ 매우 높음 — **기체가 이륙해 여러 방향으로 이동한다.**
#
# 출처: Telem · LandWatch · same_item · upload_verified · clear_mission · ask_yes · wait_position_ok · wait_rtk 는
#       test_sar_rtk.py 에서 그대로 복사했다(2026-11-13, 1947469). 저장소 규칙대로 서로 import 하지 않는다.
# ============================================================================

import argparse
import asyncio
import datetime
import json
import math
import signal
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import mavsdk_guard as guard
import seq_plan as sp
from mavsdk.mission_raw import MissionItem
from mavsdk.telemetry import FlightMode, FixType

DEFAULT_ADDRESS = "udpin://0.0.0.0:14540"
CAP = Path("/home/physical/CAP_ON")  # 절대경로 — root 로 실행돼도 같은 파일
DEFAULT_LOG_DIR = "/home/physical/cansar_logs"
ALIGN_TOL = 3.0      # 도 — 이륙 후 yaw 정렬 판정(로그용). PX4 자체 도달 판정은 MIS_YAW_ERR(12°)
ARM_YAW_TOL = 5.0    # 도 — 경로를 잡은 뒤 arm 직전까지 기수가 이만큼 돌았으면 이륙하지 않는다
ARM_MOVE_TOL = 1.0   # m — 같은 이유로 위치
STEP_WARN_M = 1.5    # m — 단계 끝 목표점 오차가 이보다 크면 경고
STEP_WARN_DEG = 15.0  # 도 — 단계 끝 기수 오차

_logf = None


def log(*x):
    s = f"[{time.time():.3f}] " + " ".join(str(i) for i in x)
    print(s, flush=True)
    if _logf:
        _logf.write(s + "\n")
        _logf.flush()


def cap_on():
    CAP.touch()


def cap_off():
    """몇 번 불러도 안전하다. 지웠으면 True."""
    existed = CAP.exists()
    CAP.unlink(missing_ok=True)
    return existed


def distance(lat1, lon1, lat2, lon2):
    return math.hypot(*sp.ne(lat1, lon1, lat2, lon2))


def yaw_diff(a, b):
    """두 각의 차이(도), 0~180."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


# ── 아래 test_sar_rtk.py 에서 복사 (ModeLost · Telem · LandWatch) ───────────────

class ModeLost(Exception):
    """비행 모드가 스크립트 제어 밖으로 바뀌었다 (조종기 개입·RTL·페일세이프)."""


class Telem:
    """위치·속도·모드·미션 진행 최신값을 백그라운드로 받아 둔다."""

    def __init__(self, drone):
        self.drone = drone
        self.pos = self.vel = self.mode = self.hdg = None
        self.gps = None          # 최신 GpsInfo (fix_type, num_satellites)
        self.in_air = None
        self.prog = None         # mission_raw MissionProgress (current, total)
        self.rtk_since = None    # RTK Fixed 가 연속으로 시작된 시각(monotonic). 풀리면 None
        self.allowed = None      # set 이면 그 밖의 모드가 오면 ModeLost
        self.lost_mode = None
        self._tasks = []
        # ── 착륙 감시 로그 전용 (판정·제어에는 쓰지 않는다) ──
        self.landed = self.armed = None   # LAND 시작 뒤에만 구독한다
        self.lw = None                    # LandWatch. LAND 항목이 시작되면 만든다
        self._lw_land_idx = self._lw_total = None
        self._lw_below = self._lw_off = False
        self._lw_last = {}                # 속성별 마지막 수신 시각(monotonic)

    async def start(self, timeout):
        t = self.drone.telemetry
        for name, rate in (("set_rate_position", 10.0), ("set_rate_velocity_ned", 10.0)):
            try:
                await getattr(t, name)(rate)
            except Exception as e:
                log(f"[경고] {name}({rate}) 실패: {e} — FC 기본 주기로 받는다")
        self._tasks = [asyncio.create_task(self._pump(t.position(), "pos")),
                       asyncio.create_task(self._pump(t.velocity_ned(), "vel")),
                       asyncio.create_task(self._pump(t.flight_mode(), "mode")),
                       asyncio.create_task(self._pump(t.heading(), "hdg")),
                       asyncio.create_task(self._pump(t.gps_info(), "gps")),
                       asyncio.create_task(self._pump(t.in_air(), "in_air")),
                       asyncio.create_task(self._pump(self.drone.mission_raw.mission_progress(), "prog"))]
        async with asyncio.timeout(timeout):
            while self.pos is None or self.vel is None or self.mode is None or self.hdg is None:
                await asyncio.sleep(0.1)

    async def _pump(self, stream, attr):
        async for v in stream:
            setattr(self, attr, v)
            if attr == "gps":
                if v.fix_type == FixType.RTK_FIXED:
                    if self.rtk_since is None:
                        self.rtk_since = time.monotonic()
                else:
                    self.rtk_since = None
            if attr == "mode" and self.allowed is not None and v not in self.allowed and self.lost_mode is None:
                self.lost_mode = v
            self._lw_feed(attr, v)

    # ── 착륙 감시 로그: LAND 항목이 시작된 뒤부터만 [착륙감시] 줄을 찍는다 ──
    # 읽기·로그만 한다. 어떤 예외도 _pump 밖으로 내보내지 않으며, MAVLink 명령을 보내지 않는다.

    def lw_prepare(self, plan):
        """LAND 항목 번호와 항목 수를 기억한다. 출력 없음."""
        try:
            self._lw_land_idx = plan.roles.index(("land", 0))
            self._lw_total = len(plan.items)
        except Exception as e:
            self._lw_off = True
            _lw_log(f"[착륙감시] 준비 실패 {e!r} — 감시하지 않는다 (비행 제어와 무관)")

    def _lw_feed(self, attr, v):
        try:
            self._lw_last[attr] = time.monotonic()
            if self._lw_land_idx is None or self._lw_off:
                return
            if self.lw is None:
                if attr != "prog":
                    return
                if v.current < self._lw_land_idx:
                    self._lw_below = True      # 이번 미션 진행을 본 뒤에만 시작 (이전 미션의 묵은 값 무시)
                    return
                if not self._lw_below:
                    return
                self.lw = LandWatch(self, self._lw_land_idx, self._lw_total)
                t = self.drone.telemetry
                self._tasks += [asyncio.create_task(self._lw_pump(t.landed_state(), "landed")),
                                asyncio.create_task(self._lw_pump(t.armed(), "armed"))]
                return
            self.lw.on(attr)
        except Exception as e:
            self._lw_off = True
            _lw_log(f"[착륙감시] 내부 오류 {e!r} — 감시를 끈다 (비행 제어와 무관)")

    async def _lw_pump(self, stream, attr):
        """감시 전용 추가 구독. 끊겨도 한 줄만 남기고 조용히 끝난다."""
        try:
            async for v in stream:
                setattr(self, attr, v)
                self._lw_feed(attr, v)
        except Exception as e:
            _lw_log(f"[착륙감시] {attr} 수신 끊김 {e!r}")

    def lw_summary(self):
        try:
            if self.lw is not None:
                self.lw.summary()
        except Exception as e:
            _lw_log(f"[착륙감시] 요약 실패 {e!r}")

    def stop(self):
        for t in self._tasks:
            t.cancel()

    def check(self):
        if self.lost_mode is not None:
            raise ModeLost(self.lost_mode)

    def rtk_fixed_for(self):
        """RTK Fixed 가 연속으로 유지된 시간(초). Fixed 가 아니면 0."""
        return 0.0 if self.rtk_since is None else time.monotonic() - self.rtk_since

    def gps_str(self):
        return "GPS 정보 없음" if self.gps is None else f"fix {getattr(self.gps.fix_type, 'name', self.gps.fix_type)} 위성 {self.gps.num_satellites}"

    def ground_speed(self):
        return math.hypot(self.vel.north_m_s, self.vel.east_m_s)

    def current(self):
        return -1 if self.prog is None else self.prog.current


def _lw_log(s):
    """log() 가 실패해도 예외를 내지 않는다."""
    try:
        log(s)
    except Exception:
        pass


def _lw_nm(v):
    if v is None or isinstance(v, bool):
        return str(v)
    return getattr(v, "name", str(v))


class LandWatch:
    """LAND 항목 시작부터 스크립트 종료까지 착지 관련 값을 기록한다 (로그 전용).
    값이 바뀔 때마다 한 줄, 2초마다 상태 한 줄, 끝에 요약 한 줄. 시각 t 는 감시 시작부터의 초."""

    KEYS = ("prog", "in_air", "landed", "armed", "mode")

    def __init__(self, tm, land_idx, total):
        self.tm, self.land_idx, self.total = tm, land_idx, total
        self.t0 = time.monotonic()
        self.last_tick = self.t0
        self.snap = self._snap()
        self.ov_since = None                 # cur=LAND 이면서 in_air=False 가 시작된 시각
        self.ov_sum, self.ov_n = 0.0, 0
        self.t_leave = self.leave_to = None  # cur 가 LAND 를 떠난 시각·값
        self.t_air_false = self.t_ground = self.t_disarm = None
        self._update_events()
        now = time.monotonic()
        age = " ".join(f"{k}={now - tm._lw_last[k]:.1f}s" if k in tm._lw_last else f"{k}=없음"
                       for k in ("pos", "vel", "mode", "hdg", "in_air", "prog"))
        dead = sum(1 for t in tm._tasks if t.done())
        _lw_log(f"[착륙감시] 시작 land_idx={land_idx} total={total} {self._fmt()} {self._kin()} "
                f"| 마지막수신 {age} | 끝난수신태스크={dead}")

    def _t(self):
        return time.monotonic() - self.t0

    def _snap(self):
        p = self.tm.prog
        return {"prog": None if p is None else (p.current, p.total), "in_air": self.tm.in_air,
                "landed": self.tm.landed, "armed": self.tm.armed, "mode": self.tm.mode}

    def _fmt(self):
        s = self.snap
        cur = "None" if s["prog"] is None else f"{s['prog'][0]}/{s['prog'][1]}"
        return (f"cur={cur} in_air={_lw_nm(s['in_air'])} landed={_lw_nm(s['landed'])} "
                f"armed={_lw_nm(s['armed'])} mode={_lw_nm(s['mode'])}")

    def _kin(self):
        pos, vel = self.tm.pos, self.tm.vel
        alt = "None" if pos is None else f"{pos.relative_altitude_m:.2f}"
        vz = "None" if vel is None else f"{vel.down_m_s:+.2f}"
        return f"alt={alt} vz={vz}"

    def _update_events(self):
        now, t = time.monotonic(), self._t()
        s = self.snap
        cur = None if s["prog"] is None else s["prog"][0]
        if self.t_leave is None and cur is not None and cur != self.land_idx:
            self.t_leave, self.leave_to = t, cur
        if self.t_air_false is None and s["in_air"] is False:
            self.t_air_false = t
        if self.t_ground is None and _lw_nm(s["landed"]) == "ON_GROUND":
            self.t_ground = t
        if self.t_disarm is None and s["armed"] is False:
            self.t_disarm = t
        cond = cur == self.land_idx and s["in_air"] is False
        if cond and self.ov_since is None:
            self.ov_since, self.ov_n = now, self.ov_n + 1
        elif not cond and self.ov_since is not None:
            self.ov_sum += now - self.ov_since
            self.ov_since = None

    def on(self, attr):
        if attr in self.KEYS:
            new = self._snap()
            diff = [k for k in self.KEYS if new[k] != self.snap[k]]
            if diff:
                old, self.snap = self.snap, new
                self._update_events()
                ch = ", ".join(f"{k} {_lw_nm(old[k]) if k != 'prog' else old[k]}→"
                               f"{_lw_nm(new[k]) if k != 'prog' else new[k]}" for k in diff)
                _lw_log(f"[착륙감시] 변화 t=+{self._t():.3f}s {ch} | {self._fmt()}")
        elif attr == "pos" and time.monotonic() - self.last_tick >= 2.0:
            self.last_tick = time.monotonic()
            _lw_log(f"[착륙감시] 상태 t=+{self._t():.1f}s {self._fmt()} {self._kin()}")

    def summary(self):
        ov = self.ov_sum + (time.monotonic() - self.ov_since if self.ov_since is not None else 0.0)

        def ev(name, t):
            if t is None:
                return f"{name} 없음"
            rel = "" if self.t_leave is None or name.startswith("cur") else f"(cur 이탈 기준 {t - self.t_leave:+.3f}s)"
            return f"{name} t=+{t:.3f}{rel}"

        leave = "cur 이탈 없음" if self.t_leave is None else f"cur {self.land_idx}→{self.leave_to} t=+{self.t_leave:.3f}"
        _lw_log(f"[착륙감시] 요약 판정창(cur={self.land_idx}∧in_air=False) 겹침={ov:.3f}s/{self.ov_n}회 | {leave} | "
                f"{ev('in_air→False', self.t_air_false)} | {ev('landed→ON_GROUND', self.t_ground)} | "
                f"{ev('armed→False', self.t_disarm)} | 감시 {self._t():.1f}s"
                f"{' (감시 도중 꺼짐)' if self.tm._lw_off else ''} | 끝 {self._fmt()}")


# PX4 는 GLOBAL(0)·GLOBAL_RELATIVE_ALT(3) 으로 올린 항목을 _INT 짝(5·6)으로 돌려준다 — 같은 좌표계다.
FRAME_SAME = {5: 0, 6: 3}


def same_item(a, b):
    """업로드한 항목과 내려받은 항목이 같은가. 정수 좌표는 정확히, 실수는 1e-3 이내."""
    def close(x, y):
        if math.isnan(x) or math.isnan(y):
            return math.isnan(x) and math.isnan(y)
        return abs(x - y) <= 1e-3
    return (a.seq == b.seq and a.command == b.command
            and FRAME_SAME.get(a.frame, a.frame) == FRAME_SAME.get(b.frame, b.frame)
            and a.x == b.x and a.y == b.y and close(a.z, b.z)
            and all(close(getattr(a, f), getattr(b, f)) for f in ("param1", "param2", "param3", "param4"))
            and bool(a.autocontinue) == bool(b.autocontinue))


async def upload_verified(drone, plan):
    """미션을 올리고 다시 내려받아 한 항목씩 대조한다. 다르면 RuntimeError."""
    log(f"[미션] 업로드 ({len(plan.items)}개 항목)...")
    await drone.mission_raw.upload_mission(plan.items)
    log("[미션] FC 수락 ✔ — 내려받아 대조...")
    got = await drone.mission_raw.download_mission()
    if len(got) != len(plan.items):
        raise RuntimeError(f"내려받은 항목 수 {len(got)} ≠ 올린 수 {len(plan.items)}")
    for a, b in zip(plan.items, got):
        if not same_item(a, b):
            raise RuntimeError(f"#{a.seq} 이 다르다\n  올림: {a}\n  받음: {b}")
    log(f"[미션] 대조 일치 ✔ ({len(got)}개 항목 모두 같다)")


async def clear_mission(drone):
    try:
        await drone.mission_raw.clear_mission()
        log("[미션] FC 의 미션을 지웠다")
    except Exception as e:
        log(f"[경고] 미션 삭제 실패: {e} — QGC 에서 지울 것 (조종기로 Mission 모드에 들어가면 다시 날 수 있다)")




def ask_yes(args):
    if args.yes:
        print("  --yes 가 주어져 확인을 건너뜁니다.")
        return True
    if not sys.stdin.isatty():
        print("  [중단] 터미널이 아닙니다. 이 스크립트는 사람이 직접 실행해야 합니다.",
              file=sys.stderr)
        return False
    try:
        answer = input('  위 항목을 모두 확인했습니까? 진행하려면 "yes" 를 입력하세요: ')
    except (EOFError, KeyboardInterrupt):
        print("\n  [중단] 입력이 없었습니다.")
        return False
    if answer.strip().lower() != "yes":
        print("  [중단] 'yes' 가 아니므로 진행하지 않습니다.")
        return False
    return True


# ── 비행 ─────────────────────────────────────────────────────────────────

async def wait_position_ok(drone, timeout):
    """위치 추정이 정상일 때만 True. 아니면 이륙하지 않는다."""
    log(f"[확인] 위치 추정 대기 (최대 {timeout}초)...")
    try:
        async with asyncio.timeout(timeout):
            async for h in drone.telemetry.health():
                if h.is_global_position_ok and h.is_home_position_ok:
                    log("[확인] 위치 추정 정상 ✔")
                    return True
    except TimeoutError:
        pass
    log("[중단] 위치 추정이 정상이 아니다 — 이륙하지 않는다. GPS 수신, home 위치 설정 상태를 확인할 것.")
    return False


async def first(stream):
    async for v in stream:
        return v


async def wait_rtk(tm, args, where):
    """RTK Fixed 가 --rtk-min 초 이상 연속 유지될 때까지 기다린다. 시간 초과면 RuntimeError."""
    if args.rtk_min <= 0:
        return
    log(f"[RTK] {where}: Fixed {args.rtk_min:.0f}초 연속 유지 대기 (최대 {args.rtk_timeout:.0f}초) — 현재 {tm.gps_str()}, "
        f"Fixed {tm.rtk_fixed_for():.0f}초")
    end = time.monotonic() + args.rtk_timeout
    last = 0.0
    while tm.rtk_fixed_for() < args.rtk_min:
        tm.check()
        if time.monotonic() > end:
            raise RuntimeError(f"RTK Fixed {args.rtk_min:.0f}초 유지 대기 시간 초과 ({tm.gps_str()}) — "
                               f"베이스·보정 전달(cansar_rtcm_send.py) 확인")
        if time.monotonic() - last >= 5.0:
            log(f"       {tm.gps_str()}, Fixed {tm.rtk_fixed_for():.0f}초")
            last = time.monotonic()
        await asyncio.sleep(0.2)
    log(f"[RTK] {where}: Fixed {tm.rtk_fixed_for():.0f}초 유지 ✔")


# ── 여기까지 복사 ─────────────────────────────────────────────────────────


def mission_items(plan):
    """seq_plan.Item → MAVSDK MissionItem (필드 순서가 같다)."""
    return [MissionItem(*it.fields()) for it in plan.items]


# ── 입력·확인 ───────────────────────────────────────────────────────────

def ask_float(prompt, default, lo, hi):
    """터미널에서 숫자 하나를 받는다. Enter 는 기본값, 범위 밖이면 다시 묻는다."""
    while True:
        raw = input(f"  {prompt} [{lo:g}~{hi:g}, Enter={default:g}]: ").strip()
        if not raw:
            return default
        try:
            v = float(raw)
        except ValueError:
            print("    숫자로 입력하세요.")
            continue
        if lo <= v <= hi:
            return v
        print(f"    {lo:g}~{hi:g} 사이로 입력하세요.")


def ask_mission(args):
    """대화형: 고도 · 기본 속도 · 단계(한 줄에 하나) · 착륙 위치."""
    print("=" * 64)
    print("  복합 미션 입력")
    print("=" * 64)
    args.altitude = ask_float("비행 고도(m)", args.altitude, sp.MIN_ALT, sp.MAX_ALT)
    args.speed = ask_float("기본 수평 속도(m/s)", args.speed, sp.MIN_SPEED, sp.MAX_SPEED)
    print("  단계를 한 줄에 하나씩 입력합니다. 빈 줄 = 끝, '취소' = 마지막 단계 지우기.")
    print("    예) 앞 3 · 뒤 2 · 오른쪽 3 · 왼쪽 1.5 · 시계 90 · 반시계 45 · 대기 5 · 앞 3 @0.5 · 오른쪽 2 +캡처")
    print("    앞/뒤/오른쪽/왼쪽은 **그 단계 시점의 기수 기준**입니다(회전한 뒤면 돌아간 기수 기준).")
    steps = []
    while True:
        raw = input(f"  단계 {len(steps) + 1}: ").strip()
        if not raw:
            if steps:
                break
            print("    단계가 하나 이상 있어야 합니다.")
            continue
        if raw in ("취소", "undo"):
            if steps:
                print(f"    지움: {steps.pop().label()}")
            continue
        try:
            s = sp.parse_step(raw)
            sp.check_step(s, len(steps) + 1)
        except ValueError as e:
            print(f"    {e}")
            continue
        steps.append(s)
        print(f"    → {s.label()}")
        if len(steps) >= sp.MAX_STEPS:
            print(f"    단계 상한({sp.MAX_STEPS})에 닿았습니다.")
            break
    args.steps = steps
    while True:
        raw = input(f"  착륙 위치 [마지막/복귀, Enter={'마지막' if args.land == 'here' else '복귀'}]: ").strip()
        if not raw:
            break
        if raw in ("마지막", "here"):
            args.land = "here"
            break
        if raw in ("복귀", "home"):
            args.land = "home"
            break
        print("    마지막(마지막 단계 끝난 자리) 또는 복귀(이륙 지점) 로 입력하세요.")
    print()


def print_plan(plan, out=print):
    """단계 표 + 평면도 + 요약."""
    out("  단계:")
    for g in plan.geo:
        f, r = sp.body(*g.end, plan.h0)
        out(f"    {g.k:>2}. {g.step.label():<22} → 끝점 앞 {f:+6.1f}m · 오른쪽 {r:+6.1f}m, "
            f"기수 {g.turned:+.0f}° (이륙 기수 기준 누적)")
    for line in sp.render_map(plan):
        out("  " + line)
    out(f"  고도 {sp.fmt(plan.cfg.altitude)}m · 기본 속도 {sp.fmt(plan.cfg.speed)}m/s · 착륙 {sp.LAND_NAME[plan.cfg.land]} · "
        f"최대 거리 {plan.max_r:.1f}m(허용 {sp.fmt(plan.cfg.max_radius)}m) · 총 이동 {plan.path_m:.1f}m · "
        f"예상 {plan.estimate_s() / 60:.1f}분")


def confirm(plan, args):
    print("=" * 64)
    print(f"  ⚠⚠  이 스크립트는 기체를 {sp.fmt(args.altitude)}m 까지 이륙시켜 아래 {len(plan.steps)}단계를 수행하고 "
          f"{sp.LAND_NAME[args.land]}에 착륙합니다.")
    print("=" * 64)
    print_plan(plan)
    print()
    print(f"  · 이륙 지점에서 반경 {plan.max_r:.0f}m · 고도 {sp.fmt(args.altitude)}m 공간이 비어 있습니까? (평면도 위쪽 = 지금 기수 방향)")
    print("  · 사람·장애물과 충분히 떨어져 있습니까?")
    print("  · 조종기를 손에 들고 즉시 개입할 수 있습니까? 비상 착륙 창을 열어 두었습니까?")
    print("  · 배터리 잔량이 충분합니까?")
    if any(s.capture for s in plan.steps):
        print("  · cansar.service 가 떠 있습니까? (+캡처 단계에서 CAP 파일로 캡처를 켜고 끕니다)")
    print("  · 미션 방식: 전체 경로를 FC 에 올리고 대조한 뒤 시작합니다. Pi 연결이 끊겨도")
    print("    FC 가 끝까지 비행하고 착륙합니다. 조종기 모드 스위치로 언제든 멈출 수 있습니다.")
    print(f"  · Ctrl+C·시간 초과 시 {args.abort}"
          + (" (RTL 은 RTL_RETURN_ALT 까지 올라갑니다)" if args.abort == "rtl" else ""))
    print()
    return ask_yes(args)


# ── 비행 중 기록 ─────────────────────────────────────────────────────────

def local_ne(plan, pos):
    return sp.ne(plan.lat0, plan.lon0, pos.latitude_deg, pos.longitude_deg)


def seg_progress(g, n, e):
    """단계 g 의 이동선 위 (진행 거리, 옆으로 벗어난 거리)."""
    (n0, e0), (n1, e1) = g.start, g.end
    L = math.hypot(n1 - n0, e1 - e0)
    if L < 1e-9:
        return 0.0, math.hypot(n - n0, e - e0)
    un, ue = (n1 - n0) / L, (e1 - e0) / L
    dn, de = n - n0, e - e0
    return dn * un + de * ue, -dn * ue + de * un


class StepLog:
    """단계 하나의 시작·끝과 끝에서의 목표 오차."""

    def __init__(self, g, total):
        self.g, self.total = g, total
        self.t_start = self.t_end = None
        self.err_m = self.err_deg = None

    def start(self, tm):
        self.t_start = time.time()
        log(f"STEP {self.g.k}/{self.total} START t={self.t_start:.3f} {self.g.step.label()} "
            f"고도 {tm.pos.relative_altitude_m:.1f}m 헤딩 {tm.hdg.heading_deg:.1f}°")

    def end(self, tm, plan):
        self.t_end = time.time()
        n, e = local_ne(plan, tm.pos)
        self.err_m = math.dist((n, e), self.g.end)
        self.err_deg = yaw_diff(tm.hdg.heading_deg, self.g.yaw_end)
        dur = self.t_end - self.t_start if self.t_start else 0.0
        log(f"STEP {self.g.k}/{self.total} END   t={self.t_end:.3f} dur={dur:.1f}s 목표 오차 {self.err_m:.2f}m "
            f"헤딩 {tm.hdg.heading_deg:.1f}°(목표 {self.g.yaw_end:.1f}°, 오차 {self.err_deg:.1f}°) "
            f"고도 {tm.pos.relative_altitude_m:.1f}m")
        if self.err_m > STEP_WARN_M:
            log(f"[경고] 단계 {self.g.k}: 끝 위치가 목표점에서 {self.err_m:.1f}m 떨어져 있다")
        if self.err_deg > STEP_WARN_DEG:
            log(f"[경고] 단계 {self.g.k}: 끝 기수가 목표에서 {self.err_deg:.0f}° 벗어났다")


class CapLog:
    """캡처 단계 하나의 캡처 시각과 통계. 이동은 출발~목표 도달(반경 안), 회전·대기는 그 단계 항목 동안."""

    def __init__(self, g, args):
        self.g, self.args = g, args
        self.t_start = self.t_end = None
        self.speeds, self.alts, self.cross, self.yaw_err = [], [], [], []
        self.rtk_lost = False

    @property
    def open(self):
        return self.t_start is not None and self.t_end is None

    def update(self, tm, plan, kind, k):
        g = self.g
        mine = k == g.k and kind in ("move", "rot", "hover")
        if self.t_start is None and mine:
            cap_on()
            self.t_start = time.time()
            log(f"CAP {g.k} START t={self.t_start:.3f} {g.step.label()} 속도 {tm.ground_speed():.2f}m/s "
                f"고도 {tm.pos.relative_altitude_m:.1f}m 헤딩 {tm.hdg.heading_deg:.1f}°")
        if not self.open:
            return
        keep = mine
        xt = None
        if g.step.group == "move" and mine:
            along, xt = seg_progress(g, *local_ne(plan, tm.pos))
            keep = along < g.length - self.args.accept_radius     # 목표 도달(반경 안) 전까지
        if keep:
            self.speeds.append(tm.ground_speed())
            self.alts.append(tm.pos.relative_altitude_m)
            if xt is not None:
                self.cross.append(abs(xt))
                self.yaw_err.append(yaw_diff(tm.hdg.heading_deg, g.yaw_end))
            if self.args.rtk_min > 0 and tm.rtk_since is None and not self.rtk_lost:
                self.rtk_lost = True
                log(f"[경고] 캡처 {g.k}: RTK Fixed 풀림 ({tm.gps_str()})")
        else:
            self.end(tm)

    def end(self, tm=None):
        cap_off()
        self.t_end = time.time()
        what = "" if tm is None or tm.pos is None else \
            f" 속도 {tm.ground_speed():.2f}m/s 고도 {tm.pos.relative_altitude_m:.1f}m 헤딩 {tm.hdg.heading_deg:.1f}°"
        log(f"CAP {self.g.k} END   t={self.t_end:.3f}{what}")
        self.summary()

    def summary(self):
        if not self.alts:
            log(f"[경고] 캡처 {self.g.k}: 표본이 없다 (시작 {self.t_start}, 끝 {self.t_end})")
            return
        s = (f"CAP {self.g.k} SUMMARY start={self.t_start:.3f} end={self.t_end:.3f} "
             f"dur={self.t_end - self.t_start:.2f}s alt min/max={min(self.alts):.1f}/{max(self.alts):.1f}m ")
        sp_ = self.speeds
        s += f"speed min/mean/max={min(sp_):.2f}/{sum(sp_) / len(sp_):.2f}/{max(sp_):.2f}m/s "
        if self.cross:
            s += f"cross-track max={max(self.cross):.1f}m yaw-err max={max(self.yaw_err):.1f}° "
        rtk = "OFF" if self.args.rtk_min <= 0 else "LOST" if self.rtk_lost else "OK"
        log(s + f"rtk={rtk}")


async def monitor(drone, tm, plan, args):
    """미션을 따라가며 단계 시작·끝을 기록하고 캡처를 켜고 끄고, 착륙까지 기다린다.
    StepLog 목록을 돌려준다. 미션 자체는 FC 가 진행한다."""
    total = len(plan.steps)
    steps = {g.k: StepLog(g, total) for g in plan.geo}
    caps = [CapLog(g, args) for g in plan.geo if g.step.capture]
    align_seen = align_ok = align_done = False
    deadline = time.monotonic() + plan.timeout_s()
    last_log = 0.0
    last_cur = None
    active = 0
    land_idx = plan.land_seq
    seen_below = False   # 이번 미션에서 LAND 앞 항목을 본 뒤에만 착륙 판정 (이전 미션의 묵은 진행 번호 무시)
    try:
        while True:
            cur = tm.current()
            kind, k = plan.role_at(cur)
            if 0 <= cur < land_idx:
                seen_below = True

            # 착륙 완료 — 모드 확인보다 먼저 본다(착지 뒤 PX4 가 모드를 바꿀 수 있다)
            if seen_below and cur >= 0 and plan.role_at(min(cur, len(plan.roles) - 1))[0] == "land" \
                    and tm.in_air is False:
                if active:
                    steps[active].end(tm, plan)
                    active = 0
                log("[확인] 착륙 완료 ✔")
                break
            tm.check()
            if time.monotonic() > deadline:
                raise TimeoutError

            if cur != last_cur:
                if 0 <= cur < len(plan.items):
                    log(f"[미션] 진행 {plan.describe(cur)}")
                last_cur = cur

            # 이륙 후 yaw 정렬: 정렬 항목 동안 오차를 보고, 항목을 떠날 때 결과를 남긴다
            err = yaw_diff(tm.hdg.heading_deg, plan.h0)
            if kind == "align":
                align_seen = True
                if not align_ok and err <= ALIGN_TOL:
                    align_ok = True
                    log(f"[정렬] 이륙 yaw {plan.h0:.1f}° 로 정렬 ✔ (현재 {tm.hdg.heading_deg:.1f}°, 오차 {err:.1f}°)")
            elif align_seen and not align_done:
                align_done = True
                if align_ok:
                    log(f"[정렬] 정렬 단계 끝 — 오차 {err:.1f}°")
                else:
                    log(f"[경고] 정렬 단계가 끝났는데 기수 오차가 {err:.1f}° 다 (목표 {plan.h0:.1f}°, "
                        f"현재 {tm.hdg.heading_deg:.1f}°, 판정 {ALIGN_TOL:g}°) — --align-hold 를 늘릴 것")

            # 단계 시작·끝
            sk = plan.step_of(cur)
            if sk != active:
                if active:
                    steps[active].end(tm, plan)
                if sk:
                    steps[sk].start(tm)
                active = sk

            # 캡처
            for c in caps:
                c.update(tm, plan, kind, k)

            if time.monotonic() - last_log >= 2.0:
                where = kind
                if active:
                    g = plan.geo[active - 1]
                    where = f"단계 {active}/{total} {g.step.label()}"
                    if g.step.group == "move":
                        along, _ = seg_progress(g, *local_ne(plan, tm.pos))
                        where += f" 진행 {along:4.1f}/{g.length:.1f}m"
                cap = "CAP" if CAP.exists() else ""
                log(f"       #{cur} {where}  속도 {tm.ground_speed():4.1f}m/s  "
                    f"고도 {tm.pos.relative_altitude_m:5.1f}m  헤딩 {tm.hdg.heading_deg:5.1f}°  {cap}")
                last_log = time.monotonic()
            await asyncio.sleep(0.05)
    finally:
        for c in caps:
            if c.open:
                c.end(tm)
    return list(steps.values())


def log_results(step_logs):
    for s in step_logs:
        if s.err_m is None:
            log(f"[결과] 단계 {s.g.k} {s.g.step.label()}: 끝나지 않았다")
        else:
            log(f"[결과] 단계 {s.g.k} {s.g.step.label()}: 목표 오차 {s.err_m:.2f}m · 기수 오차 {s.err_deg:.1f}°")


# ── 비행 ─────────────────────────────────────────────────────────────────

async def read_geofence(drone):
    """FC 지오펜스 수평 거리(GF_MAX_HOR_DIST). 못 읽으면 None. 읽기만 한다."""
    try:
        async with asyncio.timeout(5):
            return await drone.param.get_param_float("GF_MAX_HOR_DIST")
    except Exception as e:  # noqa: BLE001
        log(f"[경고] GF_MAX_HOR_DIST 를 못 읽었다 ({e!r}) — --max-radius 만 본다")
        return None


async def run(args):
    # SIGTERM 도 Ctrl+C 처럼 이 태스크를 취소 → 캡처 끄고 abort
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, asyncio.current_task().cancel)

    log(f"[연결] {args.address} ...")
    try:
        drone = await guard.connect(args.address, log)
    except guard.StaleServer as e:
        log(f"[중단] {e} — 기체에 아무 명령도 보내지 않았다.")
        return 1
    # 어떤 경로로 끝나든 mavsdk_server 를 내린다(안 내리면 다음 실행이 남은 서버에 붙는다).
    try:
        return await _run(drone, args)
    finally:
        guard.stop(drone)


async def _run(drone, args):
    try:
        async with asyncio.timeout(args.connect_timeout):
            async for s in drone.core.connection_state():
                if s.is_connected:
                    break
    except TimeoutError:
        log(f"[오류] {args.connect_timeout}초 안에 연결되지 않았다.")
        return 1
    log("[연결] 완료")

    if await first(drone.telemetry.armed()):
        log("[중단] 이미 ARM 상태다. 사람이 먼저 안전을 확인할 것.")
        return 1

    if not await wait_position_ok(drone, args.position_timeout):
        return 1

    tm = Telem(drone)
    try:
        await tm.start(10)
    except TimeoutError:
        log("[오류] 텔레메트리(위치·속도·모드·헤딩)를 받지 못했다.")
        tm.stop()
        return 1
    try:
        return await fly(drone, tm, args)
    finally:
        tm.stop()


async def fly(drone, tm, args):
    # ── RTK 먼저(요구할 때만): Fixed 직후 위치가 움직이므로 L 은 그 뒤에 잡는다. dry-run 은 기다리지 않는다 ──
    if not args.dry_run and args.rtk_min > 0:
        try:
            await wait_rtk(tm, args, "이륙 전")
        except RuntimeError as e:
            log(f"[중단] {e} — arm 하지 않는다")
            return 1

    # ── 경로 계산: 지금 서 있는 자리가 L, 지금 기수가 h0 ──
    h0 = (args.heading if args.heading is not None else tm.hdg.heading_deg) % 360.0
    try:
        plan = sp.build(args.steps, args.cfg, tm.pos.latitude_deg, tm.pos.longitude_deg, h0)
    except ValueError as e:
        log(f"[중단] 경로 계산 실패: {e} — arm 하지 않는다")
        return 1
    log(f"[경로] L {plan.lat0:.7f}, {plan.lon0:.7f}  이륙 기수(h0) {h0:.1f}°  단계 {len(plan.steps)}개  "
        f"착륙 {sp.LAND_NAME[plan.cfg.land]}")
    log(f"[경로] 고도 {sp.fmt(plan.cfg.altitude)}m (home 기준), 지면 AMSL {tm.pos.absolute_altitude_m:.1f}m, "
        f"최대 거리 {plan.max_r:.1f}m, 총 이동 {plan.path_m:.1f}m")
    print_plan(plan, out=lambda s: log("[경로]" + s))
    rtk_note = "RTK 확인 안 함 (--rtk-min 0)" if args.rtk_min <= 0 else f"RTK Fixed {tm.rtk_fixed_for():.0f}초 연속"
    log(f"[GPS] 현재 {tm.gps_str()} — {rtk_note}")

    gf = await read_geofence(drone)
    if gf is not None:
        if gf > 0 and plan.max_r >= gf:
            log(f"[중단] 경로 최대 거리 {plan.max_r:.1f}m 가 FC 지오펜스 GF_MAX_HOR_DIST {gf:g}m 이상이다 — arm 하지 않는다")
            return 1
        log(f"[확인] 지오펜스 GF_MAX_HOR_DIST {gf:g}m" + (" (꺼짐)" if gf <= 0 else f" > 경로 최대 {plan.max_r:.1f}m ✔"))

    # ── 미션: 올리고 → 내려받아 대조 ──
    for seq in range(len(plan.items)):
        log(f"[미션] {plan.describe(seq)}")
    log(f"[미션] 예상 비행 시간 {plan.estimate_s():.0f}초, 시간 초과 판정 {plan.timeout_s():.0f}초")
    log("[계획] " + json.dumps(plan.to_json(), ensure_ascii=False, separators=(",", ":")))
    try:
        await upload_verified(drone, SimpleNamespace(items=mission_items(plan)))
    except Exception as e:
        log(f"[중단] 미션 업로드/대조 실패: {e} — arm 하지 않는다")
        await clear_mission(drone)
        return 1
    if args.dry_run:
        await clear_mission(drone)
        log("[dry-run] 여기서 끝낸다. arm 하지 않았다.")
        return 0

    # 이륙 직전 yaw·위치를 다시 읽어 미션에 넣은 값과 맞는지 본다
    yaw_now = tm.hdg.heading_deg
    moved = distance(tm.pos.latitude_deg, tm.pos.longitude_deg, plan.lat0, plan.lon0)
    log(f"[정렬] 이륙 직전 yaw {yaw_now:.1f}° (미션 h0 {h0:.1f}°, 차이 {yaw_diff(yaw_now, h0):.1f}°, L 에서 {moved:.2f}m)")
    if yaw_diff(yaw_now, h0) > ARM_YAW_TOL or moved > ARM_MOVE_TOL:
        log(f"[중단] 경로를 잡은 뒤 기체가 돌았거나 움직였다 (허용 {ARM_YAW_TOL:g}°·{ARM_MOVE_TOL:g}m) — "
            f"arm 하지 않는다. 다시 실행할 것.")
        await clear_mission(drone)
        return 1

    log("[명령] arm")
    try:
        await drone.action.arm()
    except Exception as e:
        log(f"[오류] arm 실패: {e}")
        await clear_mission(drone)
        return 1

    log("[명령] 미션 시작 — 이제부터 FC 가 이륙·단계·착륙을 스스로 진행한다")
    try:
        await drone.mission_raw.start_mission()
    except Exception as e:
        log(f"[오류] 미션 시작 실패: {e} — disarm 을 시도한다")
        try:
            await drone.action.disarm()
        except Exception:
            pass
        await clear_mission(drone)
        return 1

    # ── 비행 구간 ──
    step_logs = []
    try:
        # start_mission ACK 직후 모드 스트림에 이전 모드가 한 번 더 올 수 있어, MISSION 이 보인 뒤부터 감시한다.
        async with asyncio.timeout(10):
            while tm.mode != FlightMode.MISSION:
                await asyncio.sleep(0.1)
        tm.allowed = {FlightMode.MISSION}
        tm.lw_prepare(plan)          # 착륙 감시 로그 준비 (출력·제어 없음)
        step_logs = await monitor(drone, tm, plan, args)
    except asyncio.CancelledError:
        cap_off()
        log("[중단] 사용자 중단 (Ctrl+C/SIGTERM) — 캡처 OFF")
        await guard.abort(drone, args.abort, args.address, log)
        raise
    except ModeLost as e:
        cap_off()
        log(f"[중단] 비행 모드가 {e} 로 바뀌었다 — 캡처 OFF. 조종기/FC 가 제어 중이므로 더 명령하지 않는다.")
        return 1
    except TimeoutError:
        cap_off()
        log("[오류] 시간 초과 — 미션이 예상보다 오래 걸린다 — 캡처 OFF")
        await guard.abort(drone, args.abort, args.address, log)
        return 1
    except Exception as e:
        # 통신 끊김 등 Pi 쪽 이상. 미션은 FC 에 있으므로 건드리지 않는다.
        cap_off()
        log(f"[오류] 감시 중 이상: {e!r} — 캡처 OFF")
        log("[오류] 미션은 FC 에 있어 FC 가 계속 비행하고 착륙한다. 명령은 보내지 않는다.")
        log("       ★ 착륙까지 눈으로 확인하고, 이상하면 즉시 조종기로 개입할 것 ★")
        return 1
    finally:
        cap_off()
        tm.lw_summary()              # LAND 를 시작했을 때만 [착륙감시] 요약 한 줄
        tm.allowed = None

    log_results(step_logs)
    await clear_mission(drone)
    log("[비행 후] QGC 에서 .ulg 로그를 받을 것 (Analyze Tools → Log Download)")
    return 0


# ── 명령줄 ───────────────────────────────────────────────────────────────

def load_mission_file(path):
    """{"altitude":5, "speed":1, "land":"here", "steps":["right:3", {"kind":"forward","value":1,"speed":0.5,"capture":true}]}"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    steps = []
    for i, s in enumerate(data.get("steps") or [], 1):
        if isinstance(s, str):
            steps.append(sp.parse_step(s))
        elif isinstance(s, dict):
            kind = sp.ALIASES.get(str(s.get("kind")), s.get("kind"))
            steps.append(sp.Step(kind, float(s["value"]),
                                 None if s.get("speed") is None else float(s["speed"]), bool(s.get("capture", False))))
        else:
            raise ValueError(f"steps[{i}] 를 못 읽었다: {s!r}")
    return data, steps


def build_parser():
    ap = argparse.ArgumentParser(
        description="복합 이동 미션(미션 방식): 앞·뒤·오른쪽·왼쪽 이동, 시계·반시계 회전, 대기를 섞은 단계를 한 미션으로 날린다. "
                    "방향은 그 단계 시점의 기수 기준.",
        epilog="예) mission_seq.py --altitude 5 --step right:3 --step forward:1   "
               "단계: forward/back/right/left:M · cw/ccw:DEG · hover:SEC, 꼬리 @SPEED · +cap")
    ap.add_argument("--address", default=DEFAULT_ADDRESS, help=f"MAVSDK 연결 주소 (기본 {DEFAULT_ADDRESS})")
    ap.add_argument("--step", action="append", default=[], metavar="KIND:VALUE",
                    help="단계 하나(반복). 예) right:3, forward:1@0.5, cw:90, hover:5, left:2+cap")
    ap.add_argument("--mission", metavar="FILE", help="단계를 JSON 파일에서 읽는다 (--step 과 함께 못 쓴다)")
    ap.add_argument("--altitude", type=float, default=None, help="비행 고도(m, home 기준, 2~30), 기본 5")
    ap.add_argument("--speed", type=float, default=None, help="기본 수평 속도(m/s, 0.5~5), 기본 1")
    ap.add_argument("--land", choices=sp.LAND_MODES, default=None,
                    help="착륙 위치: here=마지막 단계 끝난 자리(기본), home=이륙 지점으로 돌아와 착륙")
    ap.add_argument("--max-radius", type=float, default=30.0,
                    help=f"이륙 지점에서 경로가 갈 수 있는 최대 거리(m, ≤{sp.MAX_RADIUS_LIMIT:g}), 기본 30")
    ap.add_argument("--heading", type=float, default=None,
                    help="이륙 기수 h0(도, 0=북, 시계방향). 기본: 이륙 직전 기수 방향 (다르게 주면 arm 직전 확인에 걸린다)")
    ap.add_argument("--accept-radius", type=float, default=0.5, help="waypoint 도달 반경(m), 기본 0.5")
    ap.add_argument("--align-hold", type=float, default=3.0, help="이륙 후 h0 로 정렬하고 머무는 시간(초), 기본 3")
    ap.add_argument("--settle", type=float, default=2.0, help="이동·회전 단계 끝에서 정지(초), 기본 2")
    ap.add_argument("--gap", type=float, default=10.0, help="캡처 단계 사이 최소 쉼(초, ≥10), 기본 10")
    ap.add_argument("--rtk-min", type=float, default=0.0,
                    help="이륙 전 RTK Fixed 연속 유지 시간(초). 0 = 확인 안 함(기본)")
    ap.add_argument("--rtk-timeout", type=float, default=120.0, help="RTK 대기 최대 시간(초), 기본 120")
    ap.add_argument("--abort", choices=["rtl", "hold", "land"], default="rtl",
                    help="Ctrl+C·시간 초과 시 동작, 기본 rtl")
    ap.add_argument("--log-dir", default=DEFAULT_LOG_DIR, help=f"로그 폴더, 기본 {DEFAULT_LOG_DIR}")
    ap.add_argument("--connect-timeout", type=float, default=30.0, help="연결 대기(초), 기본 30")
    ap.add_argument("--position-timeout", type=float, default=60.0, help="위치 추정 대기(초), 기본 60")
    ap.add_argument("--dry-run", action="store_true",
                    help="연결·위치 확인 → 경로 계산 → 미션 업로드·대조 → 미션 삭제까지만 한다 (arm·캡처 안 함)")
    ap.add_argument("--yes", action="store_true",
                    help="확인 입력을 건너뛴다 (사람이 안전을 이미 확인한 경우에만). 터미널이 아닌 곳에서는 필수")
    return ap


def resolve_args(ap, args):
    """단계 · 기본값을 정하고 범위를 본다(어기면 ap.error → 종료 코드 2). 미리보기 Plan 을 돌려준다."""
    file_data, steps = {}, []
    if args.mission and args.step:
        ap.error("--mission 과 --step 은 함께 쓸 수 없다")
    if args.mission:
        try:
            file_data, steps = load_mission_file(args.mission)
        except (OSError, ValueError, KeyError, TypeError) as e:
            ap.error(f"--mission {args.mission}: {e}")
    else:
        try:
            steps = [sp.parse_step(s) for s in args.step]
        except ValueError as e:
            ap.error(f"--step: {e}")
    args.altitude = args.altitude if args.altitude is not None else float(file_data.get("altitude", 5.0))
    args.speed = args.speed if args.speed is not None else float(file_data.get("speed", 1.0))
    args.land = args.land or file_data.get("land", "here")
    args.steps = steps

    if not args.steps and not args.yes and sys.stdin.isatty():
        ask_mission(args)
    if not args.steps:
        ap.error("단계가 없다 — --step 또는 --mission 을 줄 것 (터미널에서 그냥 실행하면 묻는다)")

    args.cfg = sp.Config(altitude=args.altitude, speed=args.speed, accept_radius=args.accept_radius,
                         align_hold=args.align_hold, settle=args.settle, gap=args.gap, land=args.land,
                         max_radius=args.max_radius)
    if args.rtk_min < 0 or args.rtk_timeout <= 0:
        ap.error("--rtk-min 은 0 이상, --rtk-timeout 은 0 보다 커야 한다")
    try:
        # 거리 제한은 h0 · 위치와 무관하다 — 원점 · 북쪽으로 미리 계산해 본다
        preview = sp.build(args.steps, args.cfg, 0.0, 0.0, 0.0)
    except ValueError as e:
        ap.error(str(e))
    preview.preview = True
    return preview


def main():
    global _logf
    ap = build_parser()
    args = ap.parse_args()
    try:
        preview = resolve_args(ap, args)
    except (EOFError, KeyboardInterrupt):
        print("\n  [중단] 입력이 없었습니다.")
        return 1

    if args.dry_run:
        print_plan(preview)
    elif not confirm(preview, args):
        return 1

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"mission_seq_{datetime.datetime.now():%Y%m%d_%H%M%S}.log"
    _logf = open(log_path, "a")
    log(f"[로그] {log_path}")
    log(f"[설정] {({k: v for k, v in vars(args).items() if k not in ('steps', 'cfg', 'step')})}")
    log(f"[설정] 단계 {' '.join(s.text() for s in args.steps)}")
    if cap_off():
        log(f"[경고] 시작 시 {CAP} 가 남아 있어 지웠다 (이전 실행 잔여)")
    try:
        return asyncio.run(run(args))
    finally:
        if cap_off():
            log(f"[정리] {CAP} 삭제")
        log("[종료]")
        _logf.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (KeyboardInterrupt, asyncio.CancelledError):
        CAP.unlink(missing_ok=True)
        print("\n중단됨 — ★ 기체가 공중에 있다면 즉시 조종기로 개입할 것 ★")
        sys.exit(1)
