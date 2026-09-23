#!/usr/bin/env python3
# ============================================================================
# telemetry_watch.py — 드론 상태 1Hz 관찰 (MAVSDK-Python)
#
# 용도    : 연결 · 위치 · 고도 · 자세 · 배터리 · 비행 모드 · arm 상태를
#           1초에 한 번 출력한다. 상태를 보기만 한다.
#
# 실행 조건 : drone.target 이 떠 있어(= 라우터가 14540 으로 중계) FC 링크가 살아 있을 것.
#             ~/drone/venv 의 mavsdk 필요.
#               cd ~/drone && ./venv/bin/python scripts/telemetry_watch.py
#
# 위험도  : ★☆☆ 없음 — **이 파일은 실행해서 확인해도 된다.**
#           FC 로 보내는 명령이 하나도 없다. 구독(subscribe)만 한다.
#           arm / takeoff / land / 모드 변경 / offboard 호출 없음.
# ============================================================================

import argparse
import asyncio
import sys

from mavsdk import System

DEFAULT_ADDRESS = "udpin://0.0.0.0:14540"

state = {
    "connected": False, "armed": None, "mode": None,
    "lat": None, "lon": None, "abs_alt": None, "rel_alt": None,
    "roll": None, "pitch": None, "yaw": None,
    "batt_v": None, "batt_pct": None,
    "gps_ok": None, "home_ok": None,
}


async def watch_connection(drone):
    async for s in drone.core.connection_state():
        state["connected"] = s.is_connected


async def watch_armed(drone):
    async for a in drone.telemetry.armed():
        state["armed"] = a


async def watch_mode(drone):
    async for m in drone.telemetry.flight_mode():
        state["mode"] = str(m)


async def watch_position(drone):
    async for p in drone.telemetry.position():
        state["lat"] = p.latitude_deg
        state["lon"] = p.longitude_deg
        state["abs_alt"] = p.absolute_altitude_m
        state["rel_alt"] = p.relative_altitude_m


async def watch_attitude(drone):
    async for a in drone.telemetry.attitude_euler():
        state["roll"] = a.roll_deg
        state["pitch"] = a.pitch_deg
        state["yaw"] = a.yaw_deg


async def watch_battery(drone):
    async for b in drone.telemetry.battery():
        state["batt_v"] = b.voltage_v
        state["batt_pct"] = b.remaining_percent


async def watch_health(drone):
    async for h in drone.telemetry.health():
        state["gps_ok"] = h.is_global_position_ok
        state["home_ok"] = h.is_home_position_ok


def fmt(v, spec="{:.2f}", none="—"):
    return none if v is None else spec.format(v)


async def printer(interval):
    while True:
        await asyncio.sleep(interval)
        pct = state["batt_pct"]
        if pct is not None and pct <= 1.0:
            pct *= 100.0          # MAVSDK 버전에 따라 0~1 로 오는 경우가 있다
        print(
            f"연결={'O' if state['connected'] else 'X'} "
            f"arm={'ARMED' if state['armed'] else 'DISARMED' if state['armed'] is not None else '—'} "
            f"모드={state['mode'] or '—'} | "
            f"위치={fmt(state['lat'], '{:.7f}')},{fmt(state['lon'], '{:.7f}')} "
            f"고도 abs={fmt(state['abs_alt'])}m rel={fmt(state['rel_alt'])}m | "
            f"자세 r={fmt(state['roll'])} p={fmt(state['pitch'])} y={fmt(state['yaw'])} | "
            f"배터리={fmt(state['batt_v'])}V {fmt(pct, '{:.0f}')}% | "
            f"GPS={'O' if state['gps_ok'] else 'X' if state['gps_ok'] is not None else '—'} "
            f"home={'O' if state['home_ok'] else 'X' if state['home_ok'] is not None else '—'}",
            flush=True)


async def main():
    ap = argparse.ArgumentParser(description="드론 상태 1Hz 관찰 (읽기 전용)")
    ap.add_argument("--address", default=DEFAULT_ADDRESS,
                    help=f"MAVSDK 연결 주소 (기본 {DEFAULT_ADDRESS})")
    ap.add_argument("--interval", type=float, default=1.0, help="출력 주기(초), 기본 1.0")
    ap.add_argument("--connect-timeout", type=float, default=30.0,
                    help="연결 대기 시간(초), 기본 30")
    args = ap.parse_args()

    print(f"[연결] {args.address} ... (읽기 전용, 명령 없음)")
    drone = System()
    await drone.connect(system_address=args.address)

    try:
        async with asyncio.timeout(args.connect_timeout):
            async for s in drone.core.connection_state():
                if s.is_connected:
                    break
    except TimeoutError:
        print(f"[오류] {args.connect_timeout}초 안에 연결되지 않았다.", file=sys.stderr)
        print("       drone.target 이 떠 있는지 확인: systemctl status drone-mavlink-router",
              file=sys.stderr)
        return 1
    print("[연결] 완료. Ctrl-C 로 종료.\n")

    tasks = [asyncio.create_task(c(drone)) for c in (
        watch_connection, watch_armed, watch_mode, watch_position,
        watch_attitude, watch_battery, watch_health)]
    tasks.append(asyncio.create_task(printer(args.interval)))
    try:
        await asyncio.gather(*tasks)
    finally:
        for t in tasks:
            t.cancel()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\n중단됨")
        sys.exit(0)
