#!/usr/bin/env python3
# ============================================================================
# sar_test.py — SAR 레이더 캡처용 고정 경로 반복 비행 (MAVSDK-Python)
#
# 경로    : 이륙 지점을 L 로 두고 고정 헤딩 방향 한 직선 위에 네 점을 잡는다.
#
#             L ──가속── S ════ 등속 직선(캡처) ════ E ──감속── X
#             (이륙)     ←lead-in→  ←── length ──→   ←lead-out→
#
#           이륙(20m) → L → [L→X 패스, S~E 구간만 캡처] → L 복귀 → (10초 이상 간격) → 다음 패스
#           → 마지막 패스 후 L 복귀 → 착륙
#           · 고도 20m 일정(home 기준 상대), 수평 속도 3~5m/s
#           · 헤딩은 처음부터 끝까지 진행 방향(L→X)으로 고정. 복귀(X→L)는 기수를 돌리지 않고 후진.
#           · 같은 선을 같은 방향으로 --passes 회(기본 2) 지난다.
#           · 가속은 L~S, 감속은 E~X 에서 끝나도록 lead-in/lead-out 을 둔다.
#
# 레이더 캡처 : cansar.service 가 CAP 파일(/home/physical/CAP_ON)이 있는 동안 캡처한다.
#           · S 통과(가속 끝, 등속 진입) 시 touch, E 통과(감속 시작 전) 시 unlink.
#           · 예외·Ctrl+C·SIGTERM·모드 이탈(RTL·조종기 개입 등) 시에도 반드시 unlink 한다.
#             (안 지워지면 계속 캡처된다)
#           · 한 패스 끝(unlink) → 다음 패스 시작(touch) 사이 최소 --gap 초(기본 10, 데이터 이동용).
#
# 로그    : 패스 번호와 시작/끝 시각(time.time())을 화면과 --log-dir 의 파일에 남긴다.
# 비행 후 : QGC 에서 .ulg 로그를 받을 것 (Analyze Tools → Log Download).
#
# 실행 조건 : takeoff_land.py 와 같다.
#             ★★ 기체가 실제로 날아오른다. 이륙 지점에서 헤딩 방향으로 lead-in+length+lead-out
#                (기본 100m) 이상, 고도 20m 이상이 비어 있는 야외에서.
#             ★ 위치 추정(GPS/home)이 정상일 때만 진행한다 (스크립트가 먼저 확인).
#             ★ 조종기를 손에 들고 즉시 개입할 수 있을 것.
#             ★ 실행 전 "yes" 를 직접 입력해야 진행된다.
#             ★ 자동 실행(systemd·cron)에 절대 넣지 않는다.
#             ★ 지오펜스(GF_MAX_HOR_DIST·GF_MAX_VER_DIST)가 경로 길이/고도보다 넉넉한지 먼저 확인할 것.
#             drone.target 이 떠 있어 FC 링크가 살아 있을 것.
#
# 비행 중 이상(명령 실패·시간 초과·Ctrl+C·SIGTERM) 시 : 캡처를 끄고 --abort 동작(기본 rtl)을 보낸다.
# 비행 모드가 HOLD 밖으로 바뀌면(조종기 개입·FC 페일세이프) 캡처만 끄고 더는 명령하지 않는다.
#
# 먼저 --dry-run 으로 계산된 L·S·E·X 좌표와 헤딩을 확인하고 실행할 것 (arm 하지 않는다).
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
from mavsdk.telemetry import FlightMode

DEFAULT_ADDRESS = "udpin://0.0.0.0:14540"
EARTH_R = 6378137.0  # WGS84 장반경(m). 100m 규모라 평면 근사로 충분하다.
CAP = Path("/home/physical/CAP_ON")  # 절대경로 — root 로 실행돼도 같은 파일
DEFAULT_LOG_DIR = "/home/physical/cansar_logs"
AUTO_MODES = {FlightMode.TAKEOFF, FlightMode.HOLD}  # goto(reposition) 는 HOLD 로 보인다

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


class ModeLost(Exception):
    """비행 모드가 스크립트 제어 밖으로 바뀌었다 (조종기 개입·RTL·페일세이프)."""


class Telem:
    """위치·속도·모드 최신값을 백그라운드로 받아 둔다."""

    def __init__(self, drone):
        self.drone = drone
        self.pos = self.vel = self.mode = None
        self.watch_mode = False  # True 인 동안 AUTO_MODES 밖이면 ModeLost
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
                       asyncio.create_task(self._pump(t.flight_mode(), "mode"))]
        async with asyncio.timeout(timeout):
            while self.pos is None or self.vel is None or self.mode is None:
                await asyncio.sleep(0.1)

    async def _pump(self, stream, attr):
        async for v in stream:
            setattr(self, attr, v)
            if attr == "mode" and self.watch_mode and v not in AUTO_MODES and self.lost_mode is None:
                self.lost_mode = v

    def stop(self):
        for t in self._tasks:
            t.cancel()

    def check(self):
        if self.lost_mode is not None:
            raise ModeLost(self.lost_mode)

    def ground_speed(self):
        return math.hypot(self.vel.north_m_s, self.vel.east_m_s)

    async def sleep(self, seconds):
        """모드를 감시하면서 잔다."""
        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            self.check()
            await asyncio.sleep(min(0.1, left))


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
    print(f"  · 순서: takeoff({args.altitude}m) → [L → S~E 캡처({args.length}m) → X → L] × "
          f"{args.passes} → land")
    print(f"  · 속도 {args.speed}m/s, 헤딩 고정, 패스 간격 ≥{args.gap}초, 이상 시 {args.abort}")
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


async def wait_altitude(tm, target, tol, timeout):
    log(f"[대기] 고도 {target}m 도달 (최대 {timeout:.0f}초)...")
    async with asyncio.timeout(timeout):
        while tm.pos.relative_altitude_m < target - tol:
            tm.check()
            await asyncio.sleep(0.1)
    log(f"[확인] 고도 {tm.pos.relative_altitude_m:.1f}m ✔")


async def goto(drone, tm, lat, lon, abs_alt, args):
    await drone.action.goto_location(lat, lon, abs_alt, args.heading_fixed)
    # reposition 이 속도를 기본값(MPC_XY_CRUISE)으로 되돌릴 수 있어 goto 다음에 매번 보낸다.
    try:
        await drone.action.set_current_speed(args.speed)
    except Exception as e:
        log(f"[경고] 속도 설정 실패: {e} — FC 기본 순항 속도로 비행한다")


async def fly_to(drone, tm, line, name, abs_alt, args):
    """이동만 하는 구간(캡처 없음). 도달 확인 후 settle 초 정지."""
    lat, lon = line.pts[name]
    d0 = distance(tm.pos.latitude_deg, tm.pos.longitude_deg, lat, lon)
    log(f"[명령] → {name} 거리 {d0:.1f}m")
    await goto(drone, tm, lat, lon, abs_alt, args)
    last = 0.0
    async with asyncio.timeout(d0 / args.speed * 2 + 30):
        while (d := distance(tm.pos.latitude_deg, tm.pos.longitude_deg, lat, lon)) > args.accept_radius:
            tm.check()
            if time.monotonic() - last >= 2.0:
                log(f"       남은 거리 {d:5.1f}m  속도 {tm.ground_speed():4.1f}m/s  "
                    f"고도 {tm.pos.relative_altitude_m:5.1f}m")
                last = time.monotonic()
            await asyncio.sleep(0.1)
    log(f"[확인] {name} 도달 ✔ — {args.settle}초 정지")
    await tm.sleep(args.settle)


async def capture_pass(drone, tm, line, n, abs_alt, args):
    """L → X 직진. S 통과 시 캡처 ON, E 통과 시 OFF. (시작, 끝) time.time() 을 돌려준다."""
    x_lat, x_lon = line.pts["X"]
    log(f"[패스 {n}] L → X 출발 ({line.x_at:.0f}m), 캡처 구간 {line.s_at:.0f}~{line.e_at:.0f}m")
    await goto(drone, tm, x_lat, x_lon, abs_alt, args)

    t_start = t_end = None
    speeds, alts, cross = [], [], []
    last = 0.0
    async with asyncio.timeout(line.x_at / args.speed * 2 + 30):
        while True:
            tm.check()
            along, xt = line.along_cross(tm.pos)
            gs = tm.ground_speed()
            if t_start is None and along >= line.s_at:
                cap_on()
                t_start = time.time()
                log(f"PASS {n} START t={t_start:.3f} 속도 {gs:.2f}m/s 고도 {tm.pos.relative_altitude_m:.1f}m")
                if abs(gs - args.speed) > args.speed_tol:
                    log(f"[경고] 패스 {n}: S 진입 속도 {gs:.2f}m/s 가 목표 {args.speed}m/s 와 다르다 "
                        f"— 가속이 덜 끝났을 수 있다 (--lead-in 을 늘릴 것)")
            if t_start is not None and t_end is None:
                if along >= line.e_at:
                    cap_off()
                    t_end = time.time()
                    log(f"PASS {n} END   t={t_end:.3f} 속도 {gs:.2f}m/s 고도 {tm.pos.relative_altitude_m:.1f}m")
                else:
                    speeds.append(gs)
                    alts.append(tm.pos.relative_altitude_m)
                    cross.append(abs(xt))
            if t_end is not None and distance(tm.pos.latitude_deg, tm.pos.longitude_deg,
                                              x_lat, x_lon) <= args.accept_radius:
                break
            if time.monotonic() - last >= 2.0:
                log(f"       진행 {along:5.1f}m  속도 {gs:4.1f}m/s  고도 {tm.pos.relative_altitude_m:5.1f}m"
                    f"  {'CAP' if t_start and not t_end else ''}")
                last = time.monotonic()
            await asyncio.sleep(0.05)

    if speeds:
        log(f"PASS {n} SUMMARY start={t_start:.3f} end={t_end:.3f} dur={t_end - t_start:.2f}s "
            f"speed min/mean/max={min(speeds):.2f}/{sum(speeds) / len(speeds):.2f}/{max(speeds):.2f}m/s "
            f"alt min/max={min(alts):.1f}/{max(alts):.1f}m cross-track max={max(cross):.1f}m")
        if min(speeds) < args.speed - args.speed_tol or max(speeds) > args.speed + args.speed_tol:
            log(f"[경고] 패스 {n}: 캡처 구간 속도가 {args.speed}±{args.speed_tol}m/s 를 벗어났다")
    log(f"[확인] X 도달 ✔ — {args.settle}초 정지")
    await tm.sleep(args.settle)
    return t_start, t_end


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
        log("[오류] 텔레메트리(위치·속도·모드)를 받지 못했다.")
        tm.stop()
        return 1
    try:
        return await fly(drone, tm, args)
    finally:
        tm.stop()


async def fly(drone, tm, args):
    # ── 경로 계산: 지금 서 있는 자리가 L ──
    home = await first(drone.telemetry.home())
    heading = args.heading if args.heading is not None else (await first(drone.telemetry.heading())).heading_deg
    args.heading_fixed = heading % 360.0
    line = Line(tm.pos.latitude_deg, tm.pos.longitude_deg, args.heading_fixed,
                args.lead_in, args.length, args.lead_out)
    abs_alt = home.absolute_altitude_m + args.altitude
    log(f"[경로] 헤딩(고정) {args.heading_fixed:.1f}°")
    for name, d in (("L", 0.0), ("S", line.s_at), ("E", line.e_at), ("X", line.x_at)):
        lat, lon = line.pts[name]
        log(f"[경로] {name}  {lat:.7f}, {lon:.7f}  ({d:.0f}m)")
    log(f"[경로] 고도 AMSL {abs_alt:.1f}m (home {home.absolute_altitude_m:.1f}m + {args.altitude}m)")
    if args.dry_run:
        log("[dry-run] 여기서 끝낸다. arm 하지 않았다.")
        return 0

    log(f"[설정] 이륙 고도 {args.altitude}m")
    try:
        await drone.action.set_takeoff_altitude(args.altitude)
    except Exception as e:
        log(f"[오류] 이륙 고도 설정 실패: {e} — arm 하지 않고 중단한다. 링크 상태를 확인할 것.")
        return 1

    log("[명령] arm")
    try:
        await drone.action.arm()
    except Exception as e:
        log(f"[오류] arm 실패: {e}")
        return 1

    log("[명령] takeoff")
    try:
        await drone.action.takeoff()
    except Exception as e:
        log(f"[오류] takeoff 실패: {e} — disarm 을 시도한다")
        try:
            await drone.action.disarm()
        except Exception:
            pass
        return 1

    # ── 비행 구간: 여기서부터 이상이 생기면 캡처 OFF + abort(기본 rtl) ──
    passes = []
    try:
        # takeoff ACK 직후 모드 스트림에 이전 모드가 한 번 더 올 수 있어,
        # TAKEOFF/HOLD 가 실제로 보인 뒤부터 모드 이탈을 감시한다.
        async with asyncio.timeout(10):
            while tm.mode not in AUTO_MODES:
                await asyncio.sleep(0.1)
        tm.watch_mode = True
        await wait_altitude(tm, args.altitude, 1.0, args.altitude / 1.0 + 30)
        await fly_to(drone, tm, line, "L", abs_alt, args)
        t_off = None
        for n in range(1, args.passes + 1):
            if t_off is not None:
                # 이전 패스 끝(unlink) → 이번 패스 시작(touch) 사이 최소 gap 초.
                # 가속 구간에서 걸리는 시간은 넉넉잡아 빼지 않는다.
                wait = t_off + args.gap - time.time()
                if wait > 0:
                    log(f"[대기] 패스 간격 확보 {wait:.1f}초 (데이터 이동)")
                    await tm.sleep(wait)
            t_on, t_off = await capture_pass(drone, tm, line, n, abs_alt, args)
            passes.append((n, t_on, t_off))
            await fly_to(drone, tm, line, "L", abs_alt, args)
        tm.watch_mode = False
        log("[명령] land")
        await drone.action.land()
    except asyncio.CancelledError:
        # Ctrl+C·SIGTERM — 공중에 둔 채 끝내지 않는다.
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
        log("[오류] 시간 초과 — 목표에 도달하지 못했다 — 캡처 OFF")
        await guard.abort(drone, args.abort, args.address, log)
        return 1
    except Exception as e:
        cap_off()
        log(f"[오류] 비행 중 명령 실패: {e} — 캡처 OFF")
        await guard.abort(drone, args.abort, args.address, log)
        return 1
    finally:
        cap_off()
        tm.watch_mode = False
        for n, t_on, t_off in passes:
            log(f"PASS {n} start={t_on:.3f} end={t_off:.3f}")

    log("[대기] 착륙 완료 확인...")
    try:
        async with asyncio.timeout(args.land_timeout):
            async for in_air in drone.telemetry.in_air():
                if not in_air:
                    log("[확인] 착륙 완료 ✔")
                    break
    except TimeoutError:
        log("[경고] 착륙 확인 시간 초과 — 사람이 직접 확인할 것")
        return 1
    log("[비행 후] QGC 에서 .ulg 로그를 받을 것 (Analyze Tools → Log Download)")
    return 0


def main():
    global _logf
    ap = argparse.ArgumentParser(
        description="SAR 캡처용: 고도 20m, 헤딩 고정, 같은 직선을 같은 방향으로 반복 비행. "
                    "등속 직선 구간에서만 CAP 파일을 만든다.")
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
                    help="패스 끝 → 다음 패스 시작 최소 간격(초, ≥10), 기본 10")
    ap.add_argument("--heading", type=float, default=None,
                    help="고정 헤딩·진행 방향(도, 0=북, 시계방향). 기본: 이륙 직전 기수 방향")
    ap.add_argument("--accept-radius", type=float, default=1.0, help="도달 판정 반경(m), 기본 1")
    ap.add_argument("--settle", type=float, default=2.0, help="각 지점 도달 후 정지(초), 기본 2")
    ap.add_argument("--abort", choices=["rtl", "hold", "land"], default="rtl",
                    help="비행 중 이상 시 동작, 기본 rtl")
    ap.add_argument("--log-dir", default=DEFAULT_LOG_DIR, help=f"로그 폴더, 기본 {DEFAULT_LOG_DIR}")
    ap.add_argument("--connect-timeout", type=float, default=30.0, help="연결 대기(초), 기본 30")
    ap.add_argument("--position-timeout", type=float, default=60.0,
                    help="위치 추정 대기(초), 기본 60")
    ap.add_argument("--land-timeout", type=float, default=90.0, help="착륙 확인 대기(초), 기본 90")
    ap.add_argument("--dry-run", action="store_true",
                    help="연결·위치 확인 후 계산된 경로만 출력하고 끝낸다 (arm·캡처 안 함)")
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

    if not args.dry_run and not confirm(args):
        return 1

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"sar_test_{datetime.datetime.now():%Y%m%d_%H%M%S}.log"
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
