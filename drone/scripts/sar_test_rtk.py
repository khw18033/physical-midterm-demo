#!/usr/bin/env python3
# ============================================================================
# sar_test_rtk.py — SAR 레이더 캡처용 고정 경로 반복 비행, RTK 확인판 (MAVSDK-Python, **미션 방식**)
#
# ★ 미션 방식 (2026-10-08 13:18 사고 이후, REPORT_mavsdk_stale_server_261008.md)
#   예전에는 Pi 가 지점마다 goto 를 보냈다. 비행 중 명령 통로(mavsdk_server/gRPC)가 죽으면
#   FC 는 마지막 goto 를 끝내고 공중에서 HOLD 로 떠 있고, rtl 도 같은 통로라 못 보낸다.
#   이제는 **이륙~왕복~착륙 전체를 FC 에 미션으로 올리고**, 다시 내려받아 한 항목씩 대조한 뒤에만
#   arm·시작한다. 비행 중 Pi·SSH·mavsdk_server 가 죽어도 **FC 가 혼자 끝까지 날고 L 에 착륙한다.**
#   (test_sar_rtk.py 와 같은 구조. 다른 점은 가속·감속 구간(S·E)을 두고 S~E 만 캡처한다는 것)
#   · 미션 항목: NAV_TAKEOFF → yaw 정렬 → [DO_CHANGE_SPEED → NAV_WAYPOINT] … → NAV_LAND
#     (frame = GLOBAL_RELATIVE_ALT, 고도는 home=이륙 지점 기준. PX4 는 arm 할 때 home 을 다시 잡는다)
#   · 기수: 모든 waypoint 의 param4 에 고정 헤딩을 넣는다. PX4 1.16 은 ROI 가 없으면 이 값을 그대로
#     쓰고(MPC_YAW_MODE 무시), 헤딩이 MIS_YAW_ERR 안에 들어와야 지점 도달로 친다.
#   · 속도: PX4 는 미션을 멈췄다 다시 시작하면 순항 속도를 기본값으로 되돌리므로 waypoint 마다 앞에
#     DO_CHANGE_SPEED 를 둔다.
#   · 이륙 yaw 정렬: PX4 는 이륙 중 헤딩을 무시해 상승하면서 기수가 돌 수 있으므로, 목표 고도 도달 직후
#     L 상공에서 'yaw 정렬' 항목으로 고정 헤딩으로 돌린 뒤 --align-hold 초 머문다.
#     경로를 잡은 뒤 arm 직전까지 기체가 ARM_YAW_TOL° · ARM_MOVE_TOL m 넘게 돌거나 움직였으면 이륙하지 않는다.
#   · 패스 간격: 패스 사이 L 에서 max(settle, gap) 초 머문다(hold time). 이동 시간을 빼지 않아 넉넉하다.
#
#   Pi 에 남는 일 (Pi 가 죽으면 이것만 멈추고 비행은 계속된다):
#   · 캡처 켜고 끄기 — 미션 진행(현재 항목)과 위치로 S·E 통과를 판정해 CAP 파일을 만들고 지운다.
#   · 패스 전 RTK 확인 — 패스 앞 L 대기 항목에 들어설 때 Fixed 가 --rtk-min 초 미만이면 미션을
#     일시정지(HOLD)하고 기다렸다가 다시 시작한다. --rtk-timeout 을 넘으면 --abort.
#   · 비행 중 Pi 쪽 예외(통신 끊김 포함)는 **abort 하지 않는다** — 미션이 FC 에 있으므로 그대로 두는
#     편이 안전하다(rtl 은 RTL_RETURN_ALT 까지 올라간다). Ctrl+C·SIGTERM·시간 초과만 --abort 를 보낸다.
#   · 착륙 확인 뒤(그리고 dry-run·실패 시) FC 의 미션을 지운다 — 조종기로 Mission 모드에 들어가도
#     다시 날지 않게.
#
# sar_test.py 에 RTK 확인을 더했다. 나머지 동작은 sar_test.py 와 같다.
#   · 이륙 전 RTK Fixed 가 --rtk-min 초(기본 30) 연속 유지될 때까지 기다린다
#     (--rtk-timeout 초(기본 120) 안에 안 되면 이륙하지 않는다). 패스 전 확인은 위 참고.
#   · 경로 기준점(L)은 RTK 가 안정된 뒤에 잡는다.
#   · 캡처 구간 중 Fixed 가 풀리면 경고 + SUMMARY rtk=LOST (그 패스는 재비행 대상).
#   · 보정은 지상 노트북 cansar_rtcm_send.py → cansar.service(UDP 14660) → FC. 비행 내내 켜 둘 것.
#   · RTK 없이 시험: --rtk-min 0
#
# 경로    : 이륙 지점을 L 로 두고 고정 헤딩 방향 한 직선 위에 네 점을 잡는다.
#
#             L ──가속── S ════ 등속 직선(캡처) ════ E ──감속── X
#             (이륙)     ←lead-in→  ←── length ──→   ←lead-out→
#
#           이륙(20m) → yaw 정렬 → L → [L→X 패스, S~E 구간만 캡처] → L 복귀 → (gap 초 이상 대기)
#           → 다음 패스 → 마지막 패스 후 L 에 착륙
#           · 고도 20m 일정(home 기준 상대), 수평 속도 3~5m/s
#           · 헤딩은 처음부터 끝까지 진행 방향(L→X)으로 고정. 복귀(X→L)는 기수를 돌리지 않고 후진.
#           · 같은 선을 같은 방향으로 --passes 회(기본 2) 지난다.
#           · 가속은 L~S, 감속은 E~X 에서 끝나도록 lead-in/lead-out 을 둔다.
#
# 레이더 캡처 : cansar.service 가 CAP 파일(/home/physical/CAP_ON)이 있는 동안 캡처한다.
#           · 패스 항목 진행 중 S 통과(가속 끝, 등속 진입) 시 touch, E 통과(감속 시작 전) 시 unlink.
#           · 예외·Ctrl+C·SIGTERM·모드 이탈(RTL·조종기 개입 등) 시에도 반드시 unlink 한다.
#             (안 지워지면 계속 캡처된다)
#
# 로그    : 패스 번호와 시작/끝 시각(time.time())을 화면과 --log-dir 의 파일에 남긴다.
# 비행 후 : QGC 에서 .ulg 로그를 받을 것 (Analyze Tools → Log Download).
#
# 실행 조건 : ★★ 기체가 실제로 날아오른다. 이륙 지점에서 헤딩 방향으로 lead-in+length+lead-out
#                (기본 100m) 이상, 고도 20m 이상이 비어 있는 야외에서.
#             ★ 위치 추정(GPS/home)이 정상일 때만 진행한다 (스크립트가 먼저 확인).
#             ★ 조종기를 손에 들고 즉시 개입할 수 있을 것. 모드 스위치를 바꾸면 미션은 즉시 멈춘다.
#             ★ 실행 전 "yes" 를 직접 입력해야 진행된다.
#             ★ 자동 실행(systemd·cron)에 절대 넣지 않는다.
#             ★ 지오펜스(GF_MAX_HOR_DIST·GF_MAX_VER_DIST)가 경로 길이/고도보다 넉넉한지 먼저 확인할 것.
#             ★ tmux 안에서 실행할 것 — SSH 가 끊겨도 캡처·감시가 계속된다.
#             drone.target 이 떠 있어 FC 링크가 살아 있을 것.
#
# 비행 중 모드가 MISSION 밖으로 바뀌면(조종기 개입·FC 페일세이프) 캡처만 끄고 더는 명령하지 않는다.
#
# 먼저 --dry-run 으로 확인할 것: 경로 계산 → 미션 업로드 → 내려받아 대조 → 미션 삭제 (arm 하지 않는다).
#
# 위험도  : ★★★ 매우 높음 — **기체가 이륙해 100m 를 여러 번 왕복한다.**
# ============================================================================

import argparse
import asyncio
import datetime
import math
import signal
import sys
import time
from pathlib import Path

import mavsdk_guard as guard
from mavsdk.mission_raw import MissionItem
from mavsdk.telemetry import FlightMode, FixType

DEFAULT_ADDRESS = "udpin://0.0.0.0:14540"
EARTH_R = 6378137.0  # WGS84 장반경(m). 100m 규모라 평면 근사로 충분하다.
CAP = Path("/home/physical/CAP_ON")  # 절대경로 — root 로 실행돼도 같은 파일
DEFAULT_LOG_DIR = "/home/physical/cansar_logs"
ALIGN_TOL = 3.0      # 도 — 이륙 후 yaw 정렬 판정(로그용). PX4 자체 도달 판정은 MIS_YAW_ERR(12°)
ARM_YAW_TOL = 5.0    # 도 — 경로를 잡은 뒤 arm 직전까지 기수가 이만큼 돌았으면 이륙하지 않는다
ARM_MOVE_TOL = 1.0   # m — 같은 이유로 위치

# MAVLink 상수
FRAME_MISSION = 2            # MAV_FRAME_MISSION (DO_* 명령)
FRAME_GLOBAL_REL_ALT = 3     # MAV_FRAME_GLOBAL_RELATIVE_ALT (MISSION_ITEM_INT 이므로 x·y 는 1e7 정수)
NAV_WAYPOINT, NAV_LAND, NAV_TAKEOFF, DO_CHANGE_SPEED = 16, 21, 22, 178
CMD_NAME = {NAV_WAYPOINT: "WAYPOINT", NAV_LAND: "LAND", NAV_TAKEOFF: "TAKEOFF",
            DO_CHANGE_SPEED: "SPEED"}

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


def offset(lat, lon, dist_m, bearing_deg):
    """(lat, lon) 에서 bearing 방향으로 dist_m 만큼 떨어진 점."""
    b = math.radians(bearing_deg)
    dlat = dist_m * math.cos(b) / EARTH_R
    dlon = dist_m * math.sin(b) / (EARTH_R * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lon + math.degrees(dlon)


def ne(lat0, lon0, lat, lon):
    """(lat0, lon0) 기준 (lat, lon) 의 북·동 거리(m), 평면 근사."""
    n = math.radians(lat - lat0) * EARTH_R
    e = math.radians(lon - lon0) * EARTH_R * math.cos(math.radians((lat0 + lat) / 2))
    return n, e


def distance(lat1, lon1, lat2, lon2):
    return math.hypot(*ne(lat1, lon1, lat2, lon2))


def yaw_diff(a, b):
    """두 각의 차이(도), 0~180."""
    return abs((a - b + 180.0) % 360.0 - 180.0)


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


class Line:
    """L 을 원점, 헤딩을 +축으로 하는 직선 좌표."""

    def __init__(self, lat, lon, heading, lead_in, length, lead_out):
        self.lat, self.lon, self.heading = lat, lon, heading
        self.s_at = lead_in
        self.e_at = lead_in + length
        self.x_at = lead_in + length + lead_out
        self.pts = {"L": (lat, lon)}
        for name, d in (("S", self.s_at), ("E", self.e_at), ("X", self.x_at)):
            self.pts[name] = offset(lat, lon, d, heading)

    def along_cross(self, p):
        n, e = ne(self.lat, self.lon, p.latitude_deg, p.longitude_deg)
        h = math.radians(self.heading)
        return n * math.cos(h) + e * math.sin(h), -n * math.sin(h) + e * math.cos(h)


# ── 미션 ─────────────────────────────────────────────────────────────────

class Plan:
    """FC 에 올릴 미션 항목과 항목별 역할. roles[seq] = (종류, 패스 번호).

    종류: takeoff · align(이륙 후 yaw 정렬) · speed · hold(L 대기, n = 방금 끝난 패스, 0 = 첫 패스 전) ·
          pass(L→X) · land
    """

    def __init__(self):
        self.items, self.roles = [], []

    def add(self, role, command, frame, p1=0.0, p2=0.0, p3=0.0, p4=0.0, lat=0.0, lon=0.0, z=0.0):
        seq = len(self.items)
        self.items.append(MissionItem(seq, frame, command, 1 if seq == 0 else 0, 1,
                                      float(p1), float(p2), float(p3), float(p4),
                                      int(round(lat * 1e7)), int(round(lon * 1e7)), float(z), 0))
        self.roles.append(role)

    def wp(self, role, lat, lon, alt, yaw, hold, accept):
        # NAV_WAYPOINT: p1 머무는 시간(s), p2 도달 반경(m), p3 통과 반경, p4 헤딩(도)
        self.add(role, NAV_WAYPOINT, FRAME_GLOBAL_REL_ALT, hold, accept, 0.0, yaw, lat, lon, alt)

    def speed(self, v):
        # DO_CHANGE_SPEED: p1 1 = 대지속도, p2 속도(m/s), p3 -1 = 스로틀 변경 없음
        self.add(("speed", 0), DO_CHANGE_SPEED, FRAME_MISSION, 1.0, v, -1.0, 0.0)


def build_plan(line, args):
    p = Plan()
    lat, lon = line.pts["L"]
    x_lat, x_lon = line.pts["X"]
    alt, yaw, acc = args.altitude, args.heading_fixed, args.accept_radius
    # NAV_TAKEOFF: p4 헤딩(PX4 는 이륙 중 무시), z 이륙 고도
    p.add(("takeoff", 0), NAV_TAKEOFF, FRAME_GLOBAL_REL_ALT, 0.0, 0.0, 0.0, yaw, lat, lon, alt)
    # 목표 고도 도달 후 L 상공에서 고정 헤딩으로 돌린다. PX4 는 헤딩이 MIS_YAW_ERR 안에 들어와야
    # 도달로 치고, 그 뒤 align_hold 초 머무는 동안에도 같은 yaw 를 계속 맞춘다.
    p.wp(("align", 0), lat, lon, alt, yaw, args.align_hold, acc)
    p.speed(args.speed)
    p.wp(("hold", 0), lat, lon, alt, yaw, args.settle, acc)
    for n in range(1, args.passes + 1):
        last = n == args.passes
        rest = args.settle if last else max(args.settle, args.gap)
        p.speed(args.speed)
        p.wp(("pass", n), x_lat, x_lon, alt, yaw, args.settle, acc)
        p.speed(args.speed)
        p.wp(("hold", n), lat, lon, alt, yaw, rest, acc)
    # NAV_LAND: L 에 착륙. p4 헤딩
    p.add(("land", 0), NAV_LAND, FRAME_GLOBAL_REL_ALT, 0.0, 0.0, 0.0, yaw, lat, lon, 0.0)
    return p


def describe(item, role):
    name = CMD_NAME.get(item.command, str(item.command))
    kind, n = role
    tag = {"takeoff": "이륙", "align": "yaw 정렬", "speed": "속도", "hold": f"L 대기(패스 {n} 뒤)" if n else "L 대기",
           "pass": f"패스 {n} L→X", "land": "착륙"}[kind]
    if item.command == DO_CHANGE_SPEED:
        return f"#{item.seq:<2} {name:<8} {tag:<14} {item.param2:g}m/s"
    s = f"#{item.seq:<2} {name:<8} {tag:<14} {item.x / 1e7:.7f}, {item.y / 1e7:.7f}  고도 {item.z:g}m  헤딩 {item.param4:.1f}°"
    if item.command == NAV_WAYPOINT:
        s += f"  대기 {item.param1:g}s  반경 {item.param2:g}m"
    return s


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


# ── 확인 ─────────────────────────────────────────────────────────────────

def estimate_s(args):
    """미션 예상 시간(초) — 시간 초과 판정의 기준. 대략값이다."""
    t = args.altitude / 1.0 + 6 + args.align_hold + args.settle + args.altitude / 0.7 + 10  # 이륙·정렬·첫 대기·착륙·여유
    total = args.lead_in + args.length + args.lead_out
    per = 2 * (total / args.speed + 4) + args.settle + max(args.settle, args.gap)   # 왕복(가감속 여유 4s씩)
    return t + per * args.passes


def confirm(args):
    total = args.lead_in + args.length + args.lead_out
    print("=" * 64)
    print(f"  ⚠⚠  이 스크립트는 기체를 {args.altitude}m 까지 이륙시켜 {total:.0f}m 직선을 "
          f"{args.passes}회 왕복합니다.")
    print("=" * 64)
    print(f"  · 이륙 지점에서 헤딩 방향으로 {total:.0f}m, 고도 {args.altitude}m 공간이 비어 있습니까?")
    print("  · 사람·장애물과 충분히 떨어져 있습니까?")
    print("  · 조종기를 손에 들고 즉시 개입할 수 있습니까?")
    print("  · 배터리 잔량이 충분합니까?")
    print("  · cansar.service 가 떠 있습니까? (CAP 파일로 캡처를 켜고 끕니다)")
    print(f"  · 순서: takeoff({args.altitude}m) → yaw 정렬 → [L → S~E 캡처({args.length}m) → X → L] × "
          f"{args.passes} → land")
    print(f"  · 속도 {args.speed}m/s, 헤딩 고정, 패스 간격 ≥{args.gap}초, 예상 {estimate_s(args) / 60:.1f}분")
    print("  · 미션 방식: 전체 경로를 FC 에 올리고 대조한 뒤 시작합니다. Pi 연결이 끊겨도")
    print("    FC 가 끝까지 비행하고 L 에 착륙합니다. 조종기 모드 스위치로 언제든 멈출 수 있습니다.")
    print(f"  · Ctrl+C·시간 초과·RTK 대기 초과 시 {args.abort}"
          + (" (RTL 은 RTL_RETURN_ALT 까지 올라갑니다)" if args.abort == "rtl" else ""))
    print()
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


class PassLog:
    """한 패스의 캡처 시각과 통계."""

    def __init__(self, n):
        self.n = n
        self.t_start = self.t_end = None
        self.speeds, self.alts, self.cross = [], [], []
        self.rtk_lost = False

    def start(self, tm, args):
        cap_on()
        self.t_start = time.time()
        gs = tm.ground_speed()
        log(f"PASS {self.n} START t={self.t_start:.3f} 속도 {gs:.2f}m/s 고도 {tm.pos.relative_altitude_m:.1f}m")
        if abs(gs - args.speed) > args.speed_tol:
            log(f"[경고] 패스 {self.n}: S 진입 속도 {gs:.2f}m/s 가 목표 {args.speed}m/s 와 다르다 "
                f"— 가속이 덜 끝났을 수 있다 (--lead-in 을 늘릴 것)")

    def end(self, tm):
        cap_off()
        self.t_end = time.time()
        log(f"PASS {self.n} END   t={self.t_end:.3f} 속도 {tm.ground_speed():.2f}m/s "
            f"고도 {tm.pos.relative_altitude_m:.1f}m")

    def sample(self, tm, args, xt):
        if args.rtk_min > 0 and tm.rtk_since is None and not self.rtk_lost:
            self.rtk_lost = True
            log(f"[경고] 패스 {self.n}: 캡처 구간 중 RTK Fixed 풀림 ({tm.gps_str()}) — 이 패스는 재비행 대상")
        self.speeds.append(tm.ground_speed())
        self.alts.append(tm.pos.relative_altitude_m)
        self.cross.append(abs(xt))

    def summary(self, args):
        if self.t_start is None or self.t_end is None or not self.speeds:
            log(f"[경고] 패스 {self.n}: 캡처 구간을 다 지나지 못했다 (시작 {self.t_start}, 끝 {self.t_end})")
            return
        sp = self.speeds
        log(f"PASS {self.n} SUMMARY start={self.t_start:.3f} end={self.t_end:.3f} "
            f"dur={self.t_end - self.t_start:.2f}s "
            f"speed min/mean/max={min(sp):.2f}/{sum(sp) / len(sp):.2f}/{max(sp):.2f}m/s "
            f"alt min/max={min(self.alts):.1f}/{max(self.alts):.1f}m cross-track max={max(self.cross):.1f}m "
            f"rtk={'LOST' if self.rtk_lost else 'OK'}")
        if min(sp) < args.speed - args.speed_tol or max(sp) > args.speed + args.speed_tol:
            log(f"[경고] 패스 {self.n}: 캡처 구간 속도가 {args.speed}±{args.speed_tol}m/s 를 벗어났다")


async def rtk_gate(drone, tm, args, n):
    """패스 n 앞 L 대기 중 RTK 확인. 모자라면 미션을 멈추고 기다렸다 다시 시작한다. 기다린 초를 돌려준다."""
    if args.rtk_min <= 0 or tm.rtk_fixed_for() >= args.rtk_min:
        if args.rtk_min > 0:
            log(f"[RTK] 패스 {n} 전: Fixed {tm.rtk_fixed_for():.0f}초 유지 ✔")
        return 0.0
    t0 = time.monotonic()
    log(f"[RTK] 패스 {n} 전: Fixed {tm.rtk_fixed_for():.0f}초 < {args.rtk_min:.0f}초 — 미션 일시정지(HOLD)")
    tm.allowed = {FlightMode.MISSION, FlightMode.HOLD}
    await drone.mission_raw.pause_mission()
    await wait_rtk(tm, args, f"패스 {n} 전")       # 시간 초과면 RuntimeError → abort
    log("[미션] 다시 시작")
    await drone.mission_raw.start_mission()
    async with asyncio.timeout(10):
        while tm.mode != FlightMode.MISSION:
            await asyncio.sleep(0.1)
    tm.allowed = {FlightMode.MISSION}
    return time.monotonic() - t0


async def monitor(drone, tm, plan, line, args):
    """미션을 따라가며 S·E 에서 캡처를 켜고 끄고, 패스 전 RTK 를 확인하고, 착륙까지 기다린다.
    PassLog 목록을 돌려준다. 미션 자체는 FC 가 진행한다."""
    passes = {n: PassLog(n) for n in range(1, args.passes + 1)}
    gated = set()
    align_seen = align_ok = align_done = False
    deadline = time.monotonic() + estimate_s(args) * 2 + 60
    last_log = 0.0
    last_cur = None
    while True:
        cur = tm.current()
        kind, n = plan.roles[cur] if 0 <= cur < len(plan.roles) else ("?", 0)

        # 착륙 완료 — 모드 확인보다 먼저 본다(착지 뒤 PX4 가 모드를 바꿀 수 있다)
        if kind == "land" and tm.in_air is False:
            log("[확인] 착륙 완료 ✔")
            break
        tm.check()
        if time.monotonic() > deadline:
            raise TimeoutError

        if cur != last_cur:
            if 0 <= cur < len(plan.items):
                log(f"[미션] 진행 {describe(plan.items[cur], plan.roles[cur])}")
            last_cur = cur

        # 이륙 후 yaw 정렬: 정렬 항목 동안 오차를 보고, 항목을 떠날 때 결과를 남긴다
        err = yaw_diff(tm.hdg.heading_deg, args.heading_fixed)
        if kind == "align":
            align_seen = True
            if not align_ok and err <= ALIGN_TOL:
                align_ok = True
                log(f"[정렬] 헤딩 {args.heading_fixed:.1f}° 로 정렬 ✔ (현재 {tm.hdg.heading_deg:.1f}°, 오차 {err:.1f}°)")
        elif align_seen and not align_done:
            align_done = True
            if not align_ok:
                log(f"[경고] 정렬 단계가 끝났는데 기수 오차가 {err:.1f}° 다 (목표 {args.heading_fixed:.1f}°, "
                    f"판정 {ALIGN_TOL:g}°) — --align-hold 를 늘릴 것")

        # 패스 앞 L 대기: L 에 돌아와 머무는 동안 다음 패스 전 RTK 확인 (한 번만).
        # hold 항목은 X→L 복귀 중에도 현재 항목이므로 L 근처에 온 뒤에 본다.
        near_l = distance(tm.pos.latitude_deg, tm.pos.longitude_deg, *line.pts["L"]) <= max(1.0, 2 * args.accept_radius)
        if kind == "hold" and n < args.passes and (n + 1) not in gated and near_l:
            gated.add(n + 1)
            deadline += await rtk_gate(drone, tm, args, n + 1)
            continue

        # 캡처: 패스 항목(L→X) 진행 중 S 통과에서 켜고 E 통과에서 끈다
        along, xt = line.along_cross(tm.pos)
        for p in passes.values():
            active = kind == "pass" and n == p.n
            if active and p.t_start is None and along >= line.s_at:
                p.start(tm, args)
            if p.t_start is not None and p.t_end is None:
                if active and along < line.e_at:
                    p.sample(tm, args, xt)
                else:
                    # E 통과, 또는 그 전에 미션 항목이 넘어갔다 — 어느 쪽이든 끈다
                    p.end(tm)
                    p.summary(args)

        if time.monotonic() - last_log >= 2.0:
            cap = "CAP" if CAP.exists() else ""
            log(f"       #{cur} 진행 {along:5.1f}m  속도 {tm.ground_speed():4.1f}m/s  "
                f"고도 {tm.pos.relative_altitude_m:5.1f}m  헤딩 {tm.hdg.heading_deg:5.1f}°  {cap}")
            last_log = time.monotonic()
        await asyncio.sleep(0.05)
    return list(passes.values())


async def run(args):
    # SIGTERM 도 Ctrl+C 처럼 이 태스크를 취소 → 캡처 끄고 abort
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, asyncio.current_task().cancel)

    log(f"[연결] {args.address} ...")
    try:
        drone = await guard.connect(args.address, log)
    except guard.StaleServer as e:
        log(f"[중단] {e} — 기체에 아무 명령도 보내지 않았다.")
        return 1
    # 어떤 경로로 끝나든 mavsdk_server 를 내린다 — 안 내리면 [종료] 뒤에도 프로세스가 안 끝나고
    # 서버가 기체 연결·포트를 쥔 채 남는다(다음 실행이 여기에 붙는다).
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
    # ── RTK 먼저: Fixed 직후 EKF 위치가 수십 cm~1 m 움직이므로, 경로 기준점(L)은
    #    Fixed 가 안정된 뒤에 잡는다. dry-run 은 기다리지 않고 현재 상태만 보인다.
    if not args.dry_run:
        try:
            await wait_rtk(tm, args, "이륙 전")
        except RuntimeError as e:
            log(f"[중단] {e} — arm 하지 않는다")
            return 1

    # ── 경로 계산: 지금 서 있는 자리가 L ──
    yaw_plan = tm.hdg.heading_deg
    heading = args.heading if args.heading is not None else yaw_plan
    args.heading_fixed = heading % 360.0
    line = Line(tm.pos.latitude_deg, tm.pos.longitude_deg, args.heading_fixed,
                args.lead_in, args.length, args.lead_out)
    log(f"[경로] 헤딩(고정) {args.heading_fixed:.1f}°, {args.passes}회")
    for name, d in (("L", 0.0), ("S", line.s_at), ("E", line.e_at), ("X", line.x_at)):
        lat, lon = line.pts[name]
        log(f"[경로] {name}  {lat:.7f}, {lon:.7f}  ({d:.0f}m)")
    log(f"[경로] 고도 {args.altitude}m (home 기준 — PX4 가 arm 할 때 home 을 이 자리로 다시 잡는다), "
        f"지면 AMSL {tm.pos.absolute_altitude_m:.1f}m")
    log(f"[경로] 속도 {args.speed:g}m/s")
    log(f"[RTK] 현재 {tm.gps_str()}, Fixed {tm.rtk_fixed_for():.0f}초 연속 (요구 {args.rtk_min:.0f}초, 0=확인 안 함)")

    # ── 미션: 올리고 → 내려받아 대조 ──
    plan = build_plan(line, args)
    for item, role in zip(plan.items, plan.roles):
        log(f"[미션] {describe(item, role)}")
    log(f"[미션] 예상 비행 시간 {estimate_s(args):.0f}초, 시간 초과 판정 {estimate_s(args) * 2 + 60:.0f}초")
    try:
        await upload_verified(drone, plan)
    except Exception as e:
        log(f"[중단] 미션 업로드/대조 실패: {e} — arm 하지 않는다")
        await clear_mission(drone)
        return 1
    if args.dry_run:
        await clear_mission(drone)
        log("[dry-run] 여기서 끝낸다. arm 하지 않았다.")
        return 0

    # 이륙 직전 yaw·위치를 다시 읽어 경로를 잡을 때와 같은지 본다 (업로드하는 동안 누가 기체를 돌리거나 옮겼으면 중단)
    turned = yaw_diff(tm.hdg.heading_deg, yaw_plan)
    moved = distance(tm.pos.latitude_deg, tm.pos.longitude_deg, *line.pts["L"])
    log(f"[확인] 경로를 잡은 뒤 기수 {turned:.1f}° 돎, L 에서 {moved:.2f}m")
    if turned > ARM_YAW_TOL or moved > ARM_MOVE_TOL:
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

    log("[명령] 미션 시작 — 이제부터 FC 가 이륙·왕복·착륙을 스스로 진행한다")
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
    passes = []
    try:
        # start_mission ACK 직후 모드 스트림에 이전 모드가 한 번 더 올 수 있어,
        # MISSION 이 실제로 보인 뒤부터 모드 이탈을 감시한다.
        async with asyncio.timeout(10):
            while tm.mode != FlightMode.MISSION:
                await asyncio.sleep(0.1)
        tm.allowed = {FlightMode.MISSION}
        passes = await monitor(drone, tm, plan, line, args)
    except asyncio.CancelledError:
        # Ctrl+C·SIGTERM — 사람이 멈추라고 했다.
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
    except RuntimeError as e:
        # 패스 전 RTK 대기 시간 초과 (미션은 일시정지 상태)
        cap_off()
        log(f"[중단] {e} — 캡처 OFF")
        await guard.abort(drone, args.abort, args.address, log)
        return 1
    except Exception as e:
        # 통신 끊김 등 Pi 쪽 이상. 미션은 FC 에 있으므로 건드리지 않는다.
        cap_off()
        log(f"[오류] 감시 중 이상: {e!r} — 캡처 OFF")
        log("[오류] 미션은 FC 에 있어 FC 가 계속 비행하고 L 에 착륙한다. 명령은 보내지 않는다.")
        log("       ★ 착륙까지 눈으로 확인하고, 이상하면 즉시 조종기로 개입할 것 ★")
        return 1
    finally:
        cap_off()
        tm.allowed = None
        for p in passes:
            log(f"PASS {p.n} start={p.t_start} end={p.t_end}")

    await clear_mission(drone)
    log("[비행 후] QGC 에서 .ulg 로그를 받을 것 (Analyze Tools → Log Download)")
    return 0


def main():
    global _logf
    ap = argparse.ArgumentParser(
        description="SAR 캡처용(미션 방식): 고도 20m, 헤딩 고정, 같은 직선을 같은 방향으로 반복 비행. "
                    "RTK Fixed 확인. 경로 전체를 FC 에 올리고 대조한 뒤 시작하며, 등속 직선 구간에서만 CAP 파일을 만든다.")
    ap.add_argument("--address", default=DEFAULT_ADDRESS,
                    help=f"MAVSDK 연결 주소 (기본 {DEFAULT_ADDRESS})")
    ap.add_argument("--altitude", type=float, default=20.0, help="비행 고도(m, home 기준), 기본 20")
    ap.add_argument("--speed", type=float, default=5.0, help="수평 속도(m/s, 3~5), 기본 5")
    ap.add_argument("--speed-tol", type=float, default=0.5,
                    help="등속 판정 허용 오차(m/s), 로그 경고용, 기본 0.5")
    ap.add_argument("--length", type=float, default=60.0, help="등속 직선(캡처) 길이(m, ≥60), 기본 60")
    ap.add_argument("--lead-in", type=float, default=20.0, help="가속 구간 L→S(m), 기본 20")
    ap.add_argument("--lead-out", type=float, default=20.0, help="감속 구간 E→X(m), 기본 20")
    ap.add_argument("--passes", type=int, default=2, help="같은 방향 패스 횟수(≥2), 기본 2")
    ap.add_argument("--gap", type=float, default=10.0,
                    help="패스 사이 L 에서 머무는 최소 시간(초, ≥10), 기본 10")
    ap.add_argument("--heading", type=float, default=None,
                    help="고정 헤딩·진행 방향(도, 0=북, 시계방향). 기본: 이륙 직전 기수 방향")
    ap.add_argument("--rtk-min", type=float, default=30.0,
                    help="이륙 전·매 패스 전 RTK Fixed 연속 유지 최소 시간(초), 0=확인 안 함, 기본 30")
    ap.add_argument("--rtk-timeout", type=float, default=120.0,
                    help="RTK 대기 최대 시간(초). 넘으면 이륙 전이면 중단, 비행 중이면 --abort, 기본 120")
    ap.add_argument("--accept-radius", type=float, default=1.0, help="waypoint 도달 반경(m), 기본 1")
    ap.add_argument("--align-hold", type=float, default=3.0,
                    help="이륙 후 고정 헤딩으로 정렬하고 머무는 시간(초), 기본 3")
    ap.add_argument("--settle", type=float, default=2.0, help="각 지점 도달 후 정지(초), 기본 2")
    ap.add_argument("--abort", choices=["rtl", "hold", "land"], default="rtl",
                    help="Ctrl+C·시간 초과·RTK 대기 초과 시 동작, 기본 rtl")
    ap.add_argument("--log-dir", default=DEFAULT_LOG_DIR, help=f"로그 폴더, 기본 {DEFAULT_LOG_DIR}")
    ap.add_argument("--connect-timeout", type=float, default=30.0, help="연결 대기(초), 기본 30")
    ap.add_argument("--position-timeout", type=float, default=60.0,
                    help="위치 추정 대기(초), 기본 60")
    ap.add_argument("--dry-run", action="store_true",
                    help="연결·위치 확인 → 경로 계산 → 미션 업로드·대조 → 미션 삭제까지만 한다 (arm·캡처 안 함)")
    ap.add_argument("--yes", action="store_true",
                    help="확인 입력을 건너뛴다 (사람이 안전을 이미 확인한 경우에만)")
    args = ap.parse_args()

    if not 3.0 <= args.speed <= 5.0:
        ap.error("--speed 는 3~5 m/s 여야 한다")
    if args.length < 60.0:
        ap.error("--length 는 60m 이상이어야 한다")
    if args.passes < 2:
        ap.error("--passes 는 2 이상이어야 한다")
    if args.gap < 10.0:
        ap.error("--gap 은 10초 이상이어야 한다")
    if args.altitude <= 0 or args.lead_in <= 0 or args.lead_out <= 0:
        ap.error("--altitude, --lead-in, --lead-out 은 0 보다 커야 한다")
    if args.align_hold < 0:
        ap.error("--align-hold 는 0 이상이어야 한다")

    if not args.dry_run and not confirm(args):
        return 1

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"sar_test_rtk_{datetime.datetime.now():%Y%m%d_%H%M%S}.log"
    _logf = open(log_path, "a")
    log(f"[로그] {log_path}")
    log(f"[설정] {vars(args)}")
    if cap_off():
        log(f"[경고] 시작 시 {CAP} 가 남아 있어 지웠다 (이전 실행 잔여)")
    try:
        return asyncio.run(run(args))
    finally:
        # 어떤 경로로 끝나든 캡처는 꺼 둔다.
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
