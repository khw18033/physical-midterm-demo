#!/usr/bin/env python3
# ============================================================================
# attitude_watch.py — 기체를 기울였을 때 ATTITUDE 가 따라 바뀌는지 확인
#
# 용도    : roll/pitch/yaw 의 현재값과 누적 최소·최대·변화폭을 기록한다.
#           사람이 기체를 기울이는 동안 띄워 두고, 끝나면 로그를 본다.
#
# 실행 조건 : 드론 모드일 것 (mavlink-router 가 udp/14540 으로 중계한다).
#             mavlink-router 가 없으면 --device 로 시리얼을 직접 줄 것.
#
# 위험도  : 없음 — **완전 읽기 전용. FC 로 한 바이트도 보내지 않는다.**
#           heartbeat 조차 보내지 않는다 (라우터가 이미 스트림을 받고 있다).
# ============================================================================

import argparse
import math
import os
import sys
import time

from pymavlink import mavutil

LOG = os.path.expanduser("~/drone/logs/attitude_watch.log")
# 이만큼(도) 움직이면 자세 추정이 살아 있다고 본다
MOVED_DEG = 5.0


def main():
    ap = argparse.ArgumentParser(description="기체 기울임 반응 확인 (읽기 전용)")
    ap.add_argument("--device", default="udpin:0.0.0.0:14540")
    ap.add_argument("--seconds", type=float, default=600.0, help="감시 시간 (기본 600초)")
    ap.add_argument("--interval", type=float, default=2.0, help="기록 간격 (기본 2초)")
    args = ap.parse_args()

    m = mavutil.mavlink_connection(args.device)

    lo = {"roll": 9e9, "pitch": 9e9, "yaw": 9e9}
    hi = {"roll": -9e9, "pitch": -9e9, "yaw": -9e9}
    cur = {"roll": 0.0, "pitch": 0.0, "yaw": 0.0}
    n = 0
    announced = False
    start = time.time()
    last_log = 0.0

    def rng(k):
        return hi[k] - lo[k] if n else 0.0

    with open(LOG, "a", buffering=1) as f:
        def say(s):
            line = f"{time.strftime('%FT%T')} {s}"
            print(line, flush=True)
            f.write(line + "\n")

        say("═" * 60)
        say(f"attitude_watch 시작 — {args.device} (읽기 전용, 송신 0바이트)")
        say(f"  기울임 판정 기준: roll 또는 pitch 변화폭 {MOVED_DEG}도 이상")

        while time.time() - start < args.seconds:
            msg = m.recv_match(type="ATTITUDE", blocking=True, timeout=2.0)
            if msg is None:
                continue
            cur["roll"] = math.degrees(msg.roll)
            cur["pitch"] = math.degrees(msg.pitch)
            cur["yaw"] = math.degrees(msg.yaw)
            for k in cur:
                lo[k] = min(lo[k], cur[k])
                hi[k] = max(hi[k], cur[k])
            n += 1

            if not announced and max(rng("roll"), rng("pitch")) >= MOVED_DEG:
                announced = True
                say(f"✔ 반응 확인 — roll 변화폭 {rng('roll'):.1f}도, "
                    f"pitch 변화폭 {rng('pitch'):.1f}도 "
                    f"(시작 후 {time.time() - start:.0f}초)")

            now = time.time()
            if now - last_log >= args.interval:
                last_log = now
                say(f"현재 roll={cur['roll']:7.2f} pitch={cur['pitch']:7.2f} yaw={cur['yaw']:8.2f} "
                    f"| 변화폭 roll={rng('roll'):6.2f} pitch={rng('pitch'):6.2f} yaw={rng('yaw'):7.2f}"
                    f" | {n}건")

        say(f"종료 — 총 {n}건. 최종 변화폭: roll={rng('roll'):.2f}도, "
            f"pitch={rng('pitch'):.2f}도, yaw={rng('yaw'):.2f}도")
        if announced:
            say("판정: ✔ 기울임에 ATTITUDE 가 따라 바뀌었다 — 자세 추정 정상")
        else:
            say(f"판정: — 움직임이 {MOVED_DEG}도 미만이었다 (기울이지 않았다면 정상)")
    m.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n중단됨")
        sys.exit(1)
