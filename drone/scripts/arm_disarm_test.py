#!/usr/bin/env python3
# ============================================================================
# arm_disarm_test.py — arm → 3초 → disarm 시험 (MAVSDK-Python)
#
# 용도    : 모터 회전 계통이 정상인지 최소한으로 확인한다.
#           arm 하고 3초 뒤 disarm 한다. 이륙하지 않는다.
#
# 실행 조건 : ★ 반드시 프로펠러를 제거한 상태에서만 실행한다.
#             ★ 기체를 단단히 고정하고, 주변에 사람이 없을 것.
#             ★ 실행 전 "yes" 를 직접 입력해야 진행된다.
#             ★ 자동 실행(systemd·cron)에 절대 넣지 않는다.
#             drone.target 이 떠 있어 FC 링크가 살아 있을 것.
#
# 위험도  : ★★☆ 높음 — **모터가 실제로 돈다.**
#           arm 상태에서는 프로펠러가 달려 있으면 부상 위험이 있다.
#           이 파일은 "작성만" 해 둔 것이고, 사람이 판단해서 실행한다.
# ============================================================================

import argparse
import asyncio
import sys

from mavsdk import System

DEFAULT_ADDRESS = "udpin://0.0.0.0:14540"


def confirm(assume_yes):
    print("=" * 64)
    print("  ⚠  이 스크립트는 기체를 ARM 합니다. 모터가 실제로 회전합니다.")
    print("=" * 64)
    print("  · 프로펠러를 전부 제거했습니까?")
    print("  · 기체가 단단히 고정돼 있습니까?")
    print("  · 주변에 사람이 없습니까?")
    print()
    if assume_yes:
        print("  --yes 가 주어져 확인을 건너뜁니다.")
        return True
    if not sys.stdin.isatty():
        print("  [중단] 터미널이 아닙니다. 이 스크립트는 사람이 직접 실행해야 합니다.",
              file=sys.stderr)
        return False
    try:
        answer = input('  프로펠러를 제거했습니까? 진행하려면 "yes" 를 입력하세요: ')
    except (EOFError, KeyboardInterrupt):
        print("\n  [중단] 입력이 없었습니다.")
        return False
    if answer.strip().lower() != "yes":
        print("  [중단] 'yes' 가 아니므로 진행하지 않습니다.")
        return False
    return True


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

    print(f"[명령] arm")
    try:
        await drone.action.arm()
    except Exception as e:
        print(f"[오류] arm 실패: {e}", file=sys.stderr)
        print("       FC 의 arm 전 검사(preflight check)에 걸렸을 가능성이 높다.",
              file=sys.stderr)
        return 1

    print(f"[대기] {args.hold}초 — 모터 회전 확인")
    try:
        await asyncio.sleep(args.hold)
    finally:
        print("[명령] disarm")
        try:
            await drone.action.disarm()
        except Exception as e:
            print(f"[오류] disarm 실패: {e}", file=sys.stderr)
            print("       ★ 즉시 배터리를 분리하고 사람이 확인할 것 ★", file=sys.stderr)
            return 1

    async for armed in drone.telemetry.armed():
        print(f"[확인] arm 상태 = {'ARMED ⚠' if armed else 'DISARMED ✔'}")
        return 0 if not armed else 1
    return 0


def main():
    ap = argparse.ArgumentParser(
        description="arm → 3초 → disarm 시험. 프로펠러를 제거하고 실행할 것.")
    ap.add_argument("--address", default=DEFAULT_ADDRESS,
                    help=f"MAVSDK 연결 주소 (기본 {DEFAULT_ADDRESS})")
    ap.add_argument("--hold", type=float, default=3.0, help="arm 유지 시간(초), 기본 3")
    ap.add_argument("--connect-timeout", type=float, default=30.0, help="연결 대기(초), 기본 30")
    ap.add_argument("--yes", action="store_true",
                    help="확인 입력을 건너뛴다 (사람이 안전을 이미 확인한 경우에만)")
    args = ap.parse_args()

    if not confirm(args.yes):
        return 1
    return asyncio.run(run(args))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n중단됨 — 기체 상태를 사람이 직접 확인할 것")
        sys.exit(1)
