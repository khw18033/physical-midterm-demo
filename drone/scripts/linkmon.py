#!/usr/bin/env python3
# ============================================================================
# linkmon.py — 링크 상태 감시 (drone-linkmon.service 본체)
#
# 용도    : 라우터를 거쳐 들어오는 FC heartbeat 를 계속 지켜보다가
#           끊김 / 복구 순간을 ~/drone/logs/linkmon.log 와 journal 에 기록한다.
#           주기적으로 링크 요약(수신율, 메시지 종류 수)도 남긴다.
#
# 실행 조건 : drone.target 소속. 라우터(drone-mavlink-router)가 떠 있어야 한다.
#             설정은 /etc/drone-node.env 에서 읽는다.
#
# 위험도  : 없음 — **완전 읽기 전용**.
#           heartbeat 조차 보내지 않는다. 소켓을 열고 받기만 한다.
#           FC 로 나가는 바이트가 0 이다.
# ============================================================================

import os
import signal
import sys
import time
from collections import Counter
from datetime import datetime

from pymavlink import mavutil

from dronelink import is_vehicle_heartbeat

ENV_FILE = "/etc/drone-node.env"

_running = True


def load_env(path):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


CFG = load_env(ENV_FILE)


def cfg(key, default, cast=str):
    try:
        return cast(os.environ.get(key, CFG.get(key, default)))
    except (TypeError, ValueError):
        return cast(default)


LINKMON_UDP_PORT = cfg("LINKMON_UDP_PORT", 14541, int)
LINK_TIMEOUT = cfg("LINK_TIMEOUT", 15, float)
DRONE_HOME = cfg("DRONE_HOME", "/home/physical/drone")
DEVICE_ID = cfg("DRONE_DEVICE_ID", "x500-001")
SUMMARY_INTERVAL = cfg("LINKMON_SUMMARY_INTERVAL", 60, float)

LOG_DIR = os.path.join(DRONE_HOME, "logs")
LOG_FILE = os.path.join(LOG_DIR, "linkmon.log")


def on_signal(signum, _frame):
    global _running
    _running = False


def log(msg):
    """journal(stdout) 과 파일에 동시에 남긴다."""
    line = f"{datetime.now().isoformat(timespec='seconds')} [{DEVICE_ID}] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError as e:
        print(f"{datetime.now().isoformat(timespec='seconds')} "
              f"[경고] 로그 파일 기록 실패: {e}", flush=True)


def main():
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    addr = f"udpin:127.0.0.1:{LINKMON_UDP_PORT}"
    log(f"linkmon 시작 — {addr} 감시 (읽기 전용, 송신 0바이트). "
        f"끊김 판정 {LINK_TIMEOUT}초")

    try:
        m = mavutil.mavlink_connection(addr)
    except Exception as e:
        log(f"[오류] {addr} 열기 실패: {e}")
        return 1

    link_up = False          # 아직 한 번도 못 받은 상태로 시작
    last_seen = None
    counts = Counter()
    window_start = time.time()
    down_since = time.time()

    try:
        while _running:
            msg = m.recv_match(blocking=True, timeout=1.0)
            now = time.time()

            if msg and msg.get_type() != "BAD_DATA":
                counts[msg.get_type()] += 1
                # FC heartbeat 만 링크 생존 신호로 센다.
                # QGC·MAVSDK 도 heartbeat 를 보내므로 그것까지 세면
                # FC 가 없는데 링크가 살아 있다고 오판한다.
                if is_vehicle_heartbeat(msg):
                    last_seen = now
                    if not link_up:
                        link_up = True
                        log(f"링크 복구 — FC heartbeat 수신 "
                            f"(sysid={msg.get_srcSystem()} compid={msg.get_srcComponent()}, "
                            f"끊겨 있던 시간 {now - down_since:.1f}초)")

            if link_up and last_seen is not None and now - last_seen > LINK_TIMEOUT:
                link_up = False
                down_since = now
                log(f"링크 끊김 — heartbeat 가 {LINK_TIMEOUT}초 이상 없다")

            if now - window_start >= SUMMARY_INTERVAL:
                elapsed = now - window_start
                if counts:
                    total = sum(counts.values())
                    top = ", ".join(f"{n}={c}({c / elapsed:.1f}Hz)"
                                    for n, c in counts.most_common(5))
                    log(f"요약 {elapsed:.0f}초 — 상태={'UP' if link_up else 'DOWN'}, "
                        f"총 {total}건 / {len(counts)}종, 상위: {top}")
                else:
                    log(f"요약 {elapsed:.0f}초 — 상태=DOWN, 수신 0건")
                counts.clear()
                window_start = now
    finally:
        try:
            m.close()
        except Exception:
            pass
        log("linkmon 종료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
