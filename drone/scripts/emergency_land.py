#!/usr/bin/env python3
# ============================================================================
# emergency_land.py — 비상 착륙(LAND)·귀환(RTL)·정지(HOLD) 명령을 **별도 연결로** 보낸다 (MAVSDK-Python)
#
# 언제    : 비행 스크립트(sar_test·test_sar 계열)로 날고 있는데
#           · 스크립트가 멈췄거나 SSH 가 끊겨 Ctrl+C 를 누를 수 없을 때
#           · 스크립트의 명령 통로(mavsdk_server/gRPC)가 죽어 rtl 도 실패했을 때
#             (2026-10-08 13:18 사고 — 18m 에서 HOLD 로 떠 있던 기체를 이 방식으로 내렸다.
#              REPORT_mavsdk_stale_server_261008.md)
#           · 미션 비행을 지금 바로 끝내고 내려야 할 때
#           ★ 조종기로 개입할 수 있으면 조종기가 먼저다. 이 스크립트는 조종기가 어려울 때 쓴다.
#
# 연결    : 기본은 mavlink-router 의 TCP 5760 (tcpout://127.0.0.1:5760).
#           비행 스크립트가 UDP 14540 을 쥐고 살아 있어도(또는 그 서버만 남아 있어도) 같이 붙을 수 있다.
#           컴포넌트 ID 를 191 로 써서 비행 스크립트(190)와 섞이지 않게 하고, gRPC 는 빈 포트를 쓴다.
#
# 동작    : 연결 → 상태 출력(arm·공중·모드·고도) → 명령 전송(실패하면 최대 3번) →
#           FC 의 미션 삭제(조종기로 Mission 모드에 들어가도 다시 날지 않게, --keep-mission 이면 생략) →
#           CAP 파일 삭제(캡처 OFF) → 착륙·disarm 까지 1초마다 상태 출력.
#           · 이미 지상·disarm 이면 아무 명령도 보내지 않고 끝낸다.
#           · 비행 스크립트는 모드가 MISSION 밖으로 바뀐 것을 보고 스스로 캡처를 끄고 명령을 멈춘다.
#             (land·rtl 은 항상 감지된다. hold 는 RTK 대기로 미션을 일시정지한 동안에는 감지되지 않으니
#              그때는 land·rtl 을 쓸 것)
#
# 사용    : cd ~/drone && ./venv/bin/python scripts/emergency_land.py          # 그 자리 착륙(기본)
#           ./venv/bin/python scripts/emergency_land.py --rtl                  # 이륙 지점으로 귀환 후 착륙
#           ./venv/bin/python scripts/emergency_land.py --hold                 # 그 자리 정지(호버)
#           확인 질문 없이 바로 보낸다 — 비상용이다.
#
# 위험도  : ★★ — 비행 중인 기체의 모드를 바꾼다. RTL 은 RTL_RETURN_ALT(30m)까지 올라간 뒤 돌아온다.
# ============================================================================

import argparse
import asyncio
import datetime
import sys
import time
from pathlib import Path

import mavsdk_guard as guard
from mavsdk import System

DEFAULT_ADDRESS = "tcpout://127.0.0.1:5760"   # mavlink-router TcpServerPort
COMPID = 191                                  # 비행 스크립트(MAVSDK 기본 190)와 다르게
CAP = Path("/home/physical/CAP_ON")
DEFAULT_LOG_DIR = "/home/physical/cansar_logs"
NAME = {"land": "LAND(그 자리 착륙)", "rtl": "RTL(귀환 후 착륙)", "hold": "HOLD(그 자리 정지)"}

_logf = None


def log(*x):
    s = f"[{time.time():.3f}] " + " ".join(str(i) for i in x)
    print(s, flush=True)
    if _logf:
        _logf.write(s + "\n")
        _logf.flush()


async def first(stream, timeout=3.0):
    """스트림 첫 값. 시간 안에 안 오면 None."""
    try:
        async with asyncio.timeout(timeout):
            async for v in stream:
                return v
    except TimeoutError:
        return None


async def status(drone):
    t = drone.telemetry
    armed, in_air, mode, pos = await asyncio.gather(first(t.armed()), first(t.in_air()),
                                                    first(t.flight_mode()), first(t.position()))
    alt = "?" if pos is None else f"{pos.relative_altitude_m:.1f}m"
    return armed, in_air, mode, alt


async def send(drone, how):
    if how == "rtl":
        await drone.action.return_to_launch()
    elif how == "land":
        await drone.action.land()
    else:
        await drone.action.hold()


async def run(args):
    log(f"[연결] {args.address} (compid {COMPID}) ...")
    drone = System(port=guard._free_tcp_port(), compid=COMPID)
    await drone.connect(system_address=args.address)
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
        log(f"[오류] {args.connect_timeout}초 안에 FC 와 연결되지 않았다 — mavlink-router 가 죽었을 수 있다.")
        log("       ★ 즉시 조종기로 개입할 것 ★  (확인: systemctl status mavlink-router)")
        return 1
    log("[연결] 완료")

    armed, in_air, mode, alt = await status(drone)
    log(f"[상태] armed={armed} 공중={in_air} 모드={mode} 고도={alt}")
    if armed is False and in_air is False and not args.force:
        log("[확인] 이미 지상·disarm 상태다 — 아무 명령도 보내지 않는다. (그래도 보내려면 --force)")
        return 0

    how = args.how
    log(f"[명령] {NAME[how]} 전송")
    for attempt in range(1, 4):
        try:
            async with asyncio.timeout(5):
                await send(drone, how)
            log(f"[명령] {how} FC 수락 ✔")
            break
        except Exception as e:
            log(f"[오류] {how} 실패 ({attempt}/3): {e!r}")
            await asyncio.sleep(1.0)
    else:
        log("[오류] 명령을 보내지 못했다 — ★ 즉시 조종기로 개입할 것 ★")
        return 1

    if CAP.exists():
        CAP.unlink(missing_ok=True)
        log(f"[정리] {CAP} 삭제 (캡처 OFF)")
    if not args.keep_mission:
        try:
            await drone.mission_raw.clear_mission()
            log("[미션] FC 의 미션을 지웠다 (조종기로 Mission 모드에 들어가도 다시 날지 않는다)")
        except Exception as e:
            log(f"[경고] 미션 삭제 실패: {e} — 착륙 뒤 QGC 에서 지울 것")

    if how == "hold":
        armed, in_air, mode, alt = await status(drone)
        log(f"[상태] 모드={mode} 고도={alt} — 그 자리에 떠 있다. 조종기로 넘겨받거나 다시 실행해 --rtl / 기본(land) 으로 내릴 것")
        return 0

    log(f"[대기] 착륙·disarm 확인 (최대 {args.watch:.0f}초, Ctrl+C 로 감시만 멈출 수 있다 — 명령은 이미 FC 에 있다)")
    end = time.monotonic() + args.watch
    while time.monotonic() < end:
        armed, in_air, mode, alt = await status(drone)
        log(f"       모드={mode} 고도={alt} 공중={in_air} armed={armed}")
        if in_air is False and armed is False:
            log("[확인] 착륙·disarm 완료 ✔")
            return 0
        await asyncio.sleep(1.0)
    log("[경고] 감시 시간 안에 착륙·disarm 을 확인하지 못했다 — 눈으로 확인하고, 이상하면 조종기로 개입할 것")
    return 1


def main():
    global _logf
    ap = argparse.ArgumentParser(
        description="비상 착륙: 별도 연결(mavlink-router TCP 5760)로 LAND(기본)·RTL·HOLD 를 보내고 착륙까지 지켜본다.")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--rtl", dest="how", action="store_const", const="rtl",
                   help="그 자리 착륙 대신 이륙 지점으로 귀환(RTL_RETURN_ALT 까지 상승 후)")
    g.add_argument("--hold", dest="how", action="store_const", const="hold",
                   help="그 자리 정지(호버). 내리지는 않는다")
    ap.set_defaults(how="land")
    ap.add_argument("--address", default=DEFAULT_ADDRESS, help=f"MAVSDK 연결 주소 (기본 {DEFAULT_ADDRESS})")
    ap.add_argument("--keep-mission", action="store_true", help="FC 의 미션을 지우지 않는다")
    ap.add_argument("--force", action="store_true", help="지상·disarm 상태여도 명령을 보낸다")
    ap.add_argument("--watch", type=float, default=120.0, help="착륙·disarm 감시 시간(초), 기본 120")
    ap.add_argument("--connect-timeout", type=float, default=10.0, help="연결 대기(초), 기본 10")
    ap.add_argument("--log-dir", default=DEFAULT_LOG_DIR, help=f"로그 폴더, 기본 {DEFAULT_LOG_DIR}")
    args = ap.parse_args()

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"emergency_land_{datetime.datetime.now():%Y%m%d_%H%M%S}.log"
    _logf = open(log_path, "a")
    log(f"[로그] {log_path}")
    try:
        return asyncio.run(run(args))
    finally:
        log("[종료]")
        _logf.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n감시 중단 — 이미 보낸 명령은 FC 에 남아 있다. ★ 착륙까지 눈으로 확인할 것 ★")
        sys.exit(1)
