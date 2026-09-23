#!/usr/bin/env python3
# ============================================================================
# takeoff_land.py — 이륙 1.5m → 8초 → 착륙 (MAVSDK-Python)
#
# 용도    : 이륙·호버·착륙 계통을 최소 고도로 확인한다.
#
# 실행 조건 : ★★ 기체가 실제로 날아오른다. 반드시 야외 또는 충분한 실내 공간에서.
#             ★ 위치 추정(GPS/home)이 정상일 때만 진행한다 (스크립트가 먼저 확인).
#             ★ 사람·장애물과 충분히 떨어질 것. 조종기를 손에 들고 즉시 개입할 수 있을 것.
#             ★ 실행 전 "yes" 를 직접 입력해야 진행된다.
#             ★ 자동 실행(systemd·cron)에 절대 넣지 않는다.
#             drone.target 이 떠 있어 FC 링크가 살아 있을 것.
#
# 위험도  : ★★★ 매우 높음 — **기체가 이륙한다.**
#           프로펠러가 달린 상태로 실행하는 유일한 스크립트다.
#           이 파일은 "작성만" 해 둔 것이고, 사람이 판단해서 실행한다.
# ============================================================================

import argparse
import asyncio
import sys

from mavsdk import System

DEFAULT_ADDRESS = "udpin://0.0.0.0:14540"


def confirm(altitude, hold, assume_yes):
    print("=" * 64)
    print(f"  ⚠⚠  이 스크립트는 기체를 {altitude}m 까지 이륙시킵니다.")
    print("=" * 64)
    print("  · 야외이거나 충분한 공간이 확보돼 있습니까?")
    print("  · 사람·장애물과 충분히 떨어져 있습니까?")
    print("  · 조종기를 손에 들고 즉시 개입할 수 있습니까?")
    print("  · 배터리 잔량이 충분합니까?")
    print(f"  · 순서: takeoff({altitude}m) → {hold}초 호버 → land")
    print()
    if assume_yes:
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
    print(f"[확인] 위치 추정 대기 (최대 {timeout}초)...")
    try:
        async with asyncio.timeout(timeout):
            async for h in drone.telemetry.health():
                if h.is_global_position_ok and h.is_home_position_ok:
                    print("[확인] 위치 추정 정상 ✔")
                    return True
    except TimeoutError:
        pass
    print("[중단] 위치 추정이 정상이 아니다 — 이륙하지 않는다.", file=sys.stderr)
    print("       GPS 수신, home 위치 설정 상태를 확인할 것.", file=sys.stderr)
    return False


async def run(args):
    print(f"[연결] {args.address} ...")
    drone = System()
    await drone.connect(system_address=args.address)
    try:
        async with asyncio.timeout(args.connect_timeout):
            async for s in drone.core.connection_state():
                if s.is_connected:
                    break
    except TimeoutError:
        print(f"[오류] {args.connect_timeout}초 안에 연결되지 않았다.", file=sys.stderr)
        return 1
    print("[연결] 완료")

    async for armed in drone.telemetry.armed():
        if armed:
            print("[중단] 이미 ARM 상태다. 사람이 먼저 안전을 확인할 것.", file=sys.stderr)
            return 1
        break

    if not await wait_position_ok(drone, args.position_timeout):
        return 1

    print(f"[설정] 이륙 고도 {args.altitude}m")
    # 이 호출은 FC 파라미터(MIS_TAKEOFF_ALT) 쓰기라 ACK 가 없으면 ActionError 가 난다.
    # 감싸지 않으면 raw traceback 으로 죽는다 (2026-09-22 드라이런에서 확인).
    # arm 前이라 안전하지만, 이륙 고도를 모르는 채로 진행하면 안 되므로 여기서 멈춘다.
    try:
        await drone.action.set_takeoff_altitude(args.altitude)
    except Exception as e:
        print(f"[오류] 이륙 고도 설정 실패: {e}", file=sys.stderr)
        print("       arm 하지 않고 중단한다. 링크 상태를 확인할 것.", file=sys.stderr)
        return 1

    print("[명령] arm")
    try:
        await drone.action.arm()
    except Exception as e:
        print(f"[오류] arm 실패: {e}", file=sys.stderr)
        return 1

    print("[명령] takeoff")
    try:
        await drone.action.takeoff()
    except Exception as e:
        print(f"[오류] takeoff 실패: {e} — disarm 을 시도한다", file=sys.stderr)
        try:
            await drone.action.disarm()
        except Exception:
            pass
        return 1

    print(f"[대기] {args.hold}초 호버")
    try:
        await asyncio.sleep(args.hold)
    finally:
        print("[명령] land")
        try:
            await drone.action.land()
        except Exception as e:
            print(f"[오류] land 실패: {e}", file=sys.stderr)
            print("       ★ 즉시 조종기로 개입할 것 ★", file=sys.stderr)
            return 1

    print("[대기] 착륙 완료 확인...")
    try:
        async with asyncio.timeout(args.land_timeout):
            async for in_air in drone.telemetry.in_air():
                if not in_air:
                    print("[확인] 착륙 완료 ✔")
                    break
    except TimeoutError:
        print("[경고] 착륙 확인 시간 초과 — 사람이 직접 확인할 것", file=sys.stderr)
        return 1
    return 0


def main():
    ap = argparse.ArgumentParser(
        description="이륙 1.5m → 8초 호버 → 착륙. 위치 추정이 정상일 때만 진행한다.")
    ap.add_argument("--address", default=DEFAULT_ADDRESS,
                    help=f"MAVSDK 연결 주소 (기본 {DEFAULT_ADDRESS})")
    ap.add_argument("--altitude", type=float, default=1.5, help="이륙 고도(m), 기본 1.5")
    ap.add_argument("--hold", type=float, default=8.0, help="호버 시간(초), 기본 8")
    ap.add_argument("--connect-timeout", type=float, default=30.0, help="연결 대기(초), 기본 30")
    ap.add_argument("--position-timeout", type=float, default=60.0,
                    help="위치 추정 대기(초), 기본 60")
    ap.add_argument("--land-timeout", type=float, default=60.0, help="착륙 확인 대기(초), 기본 60")
    ap.add_argument("--yes", action="store_true",
                    help="확인 입력을 건너뛴다 (사람이 안전을 이미 확인한 경우에만)")
    args = ap.parse_args()

    if not confirm(args.altitude, args.hold, args.yes):
        return 1
    return asyncio.run(run(args))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n중단됨 — ★ 기체가 공중에 있다면 즉시 조종기로 개입할 것 ★")
        sys.exit(1)
