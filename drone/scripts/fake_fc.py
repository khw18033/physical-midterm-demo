#!/usr/bin/env python3
# ============================================================================
# fake_fc.py — FC 없이 MAVSDK 경로를 시험하기 위한 가짜 기체 (pymavlink)
#
# 용도    : 실물 FC 가 없을 때 udp 로 heartbeat + 텔레메트리를 흘려보내
#           telemetry_watch.py / MAVSDK 연결 계층이 동작하는지 확인한다.
#           비행 전에 "MAVSDK 가 이 라즈베리파이에서 되는가" 만 떼어내 검증하는 용도다.
#
# 실행 조건 : ★ FC 가 연결돼 있지 않을 때만 쓴다. mode=drone 이면 스스로 거부한다.
#             ★ 이건 시험 도구다. 자동 실행에 절대 넣지 않는다.
#
# 위험도  : ★☆☆ 없음 — 127.0.0.1 로만 보낸다. 실물 FC 로 가는 경로가 없다.
#           (라우터가 떠 있으면 14540 은 라우터 것이므로 애초에 충돌해서 못 뜬다)
#
# 사용    : ./venv/bin/python scripts/fake_fc.py            # 기본: 좋은 GPS 상태
#           ./venv/bin/python scripts/fake_fc.py --no-gps   # GPS 없는 상태 모사
# ============================================================================

import argparse
import math
import os
import pathlib
import struct
import sys
import time

os.environ.setdefault("MAVLINK20", "1")
from pymavlink import mavutil          # noqa: E402
from pymavlink.dialects.v20 import common as mav  # noqa: E402

MODE_FILE = pathlib.Path("/home/physical/drone/state/mode")

# PARAM_REQUEST_READ 에 답해 주기 위한 가짜 파라미터 표.
# 값은 PX4 와 같은 규칙으로 싣는다 — INT 계열은 float32 비트에 그대로(bytewise).
# failsafe_audit.py 의 디코딩을 실물 없이 검증하기 위한 것이다.
FAKE_PARAMS = {
    "NAV_RCL_ACT":     (2,    "INT32"),
    "COM_RC_LOSS_T":   (0.5,  "REAL32"),
    "NAV_DLL_ACT":     (0,    "INT32"),
    "COM_DL_LOSS_T":   (10.0, "REAL32"),
    "COM_LOW_BAT_ACT": (3,    "INT32"),
    "BAT_LOW_THR":     (0.15, "REAL32"),
    "BAT_CRIT_THR":    (0.07, "REAL32"),
    "BAT_EMERGEN_THR": (0.05, "REAL32"),
    "BAT1_N_CELLS":    (4,    "INT32"),
    "GF_ACTION":       (2,    "INT32"),
    "RTL_RETURN_ALT":  (30.0, "REAL32"),
    "COM_OBL_ACT":     (0,    "INT32"),
    "COM_POSCTL_NAVL": (0,    "INT32"),
}


def _encode(value, tname):
    """PX4 규칙: INT 계열은 비트 그대로 float32 자리에 싣는다."""
    if tname == "INT32":
        return struct.unpack("<f", struct.pack("<i", int(value)))[0]
    return float(value)


def serve_params(m):
    """PARAM_REQUEST_READ 가 오면 답한다. 없으면 바로 돌아온다."""
    while True:
        req = m.recv_match(type="PARAM_REQUEST_READ", blocking=False)
        if req is None:
            return
        pid = req.param_id
        if not isinstance(pid, str):
            pid = pid.decode(errors="replace")
        pid = pid.strip("\x00")
        if pid not in FAKE_PARAMS:
            continue
        value, tname = FAKE_PARAMS[pid]
        ptype = (mav.MAV_PARAM_TYPE_INT32 if tname == "INT32"
                 else mav.MAV_PARAM_TYPE_REAL32)
        m.mav.param_value_send(pid.encode("ascii"), _encode(value, tname),
                               ptype, len(FAKE_PARAMS), 0)

# PX4 custom mode: main=4 (AUTO), sub=3 (LOITER) → (main<<16)|(sub<<24)
PX4_AUTO_LOITER = (4 << 16) | (3 << 24)


def guard():
    """실물 FC 가 붙어 있으면 실행하지 않는다."""
    try:
        if MODE_FILE.read_text().strip() == "drone":
            print("[중단] state/mode = drone — 실물 FC 가 붙어 있다. 가짜 FC 를 띄우지 않는다.",
                  file=sys.stderr)
            return False
    except FileNotFoundError:
        pass
    return True


def main():
    ap = argparse.ArgumentParser(description="FC 없이 MAVSDK 를 시험하기 위한 가짜 기체")
    ap.add_argument("--target", default="127.0.0.1:14540",
                    help="보낼 곳 (기본 127.0.0.1:14540)")
    ap.add_argument("--no-gps", action="store_true",
                    help="GPS fix 없는 상태를 모사한다 (takeoff 거부 경로 확인용)")
    ap.add_argument("--duration", type=float, default=0,
                    help="이 시간(초) 뒤 종료. 0 이면 Ctrl-C 까지")
    args = ap.parse_args()

    if not guard():
        return 1

    m = mavutil.mavlink_connection(f"udpout:{args.target}",
                                   source_system=1, source_component=1)
    print(f"[가짜 FC] {args.target} 로 송신 시작 "
          f"(GPS {'없음' if args.no_gps else '정상'}). Ctrl-C 로 종료.")

    t0 = time.time()
    boot0 = t0
    n = 0
    try:
        while True:
            now = time.time()
            if args.duration and now - t0 >= args.duration:
                break
            ms = int((now - boot0) * 1000)
            us = int(now * 1e6)

            # ── 1Hz: heartbeat ────────────────────────────────────────────
            m.mav.heartbeat_send(
                mav.MAV_TYPE_QUADROTOR, mav.MAV_AUTOPILOT_PX4,
                mav.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,   # DISARMED
                PX4_AUTO_LOITER, mav.MAV_STATE_STANDBY)

            # ── 센서 헬스 + 배터리 ────────────────────────────────────────
            # MAVSDK 의 health(is_global_position_ok 등)는 이 비트를 본다.
            # 비워 두면 GPS 정상인데도 GPS=X 로 나온다 (2026-09-22 드라이런에서 확인).
            sensors = (mav.MAV_SYS_STATUS_SENSOR_3D_GYRO
                       | mav.MAV_SYS_STATUS_SENSOR_3D_ACCEL
                       | mav.MAV_SYS_STATUS_SENSOR_3D_MAG
                       | mav.MAV_SYS_STATUS_SENSOR_ABSOLUTE_PRESSURE
                       | mav.MAV_SYS_STATUS_AHRS
                       | mav.MAV_SYS_STATUS_SENSOR_BATTERY
                       | mav.MAV_SYS_STATUS_SENSOR_RC_RECEIVER)
            if not args.no_gps:
                sensors |= mav.MAV_SYS_STATUS_SENSOR_GPS
            m.mav.sys_status_send(
                sensors, sensors, sensors, 500, 16000, 12000, 87,
                0, 0, 0, 0, 0, 0)
            m.mav.battery_status_send(
                0, mav.MAV_BATTERY_FUNCTION_ALL, mav.MAV_BATTERY_TYPE_LIPO,
                2500, [4000, 4000, 4000, 4000] + [65535] * 6,
                12000, -1, -1, 87, 0, 0)

            # ── 10Hz 구간: 자세 · 위치 · GPS ───────────────────────────────
            for i in range(10):
                tms = ms + i * 100
                ph = (now - boot0) + i * 0.1
                m.mav.attitude_send(
                    tms,
                    math.radians(2.0 * math.sin(ph)),
                    math.radians(1.5 * math.cos(ph)),
                    math.radians(45.0), 0.0, 0.0, 0.0)

                if args.no_gps:
                    m.mav.gps_raw_int_send(
                        us, mav.GPS_FIX_TYPE_NO_FIX, 0, 0, 0,
                        65535, 65535, 65535, 65535, 0)
                else:
                    m.mav.gps_raw_int_send(
                        us, mav.GPS_FIX_TYPE_RTK_FIXED,
                        363500000, 1273000000, 50000,
                        80, 80, 0, 0, 14)
                    m.mav.global_position_int_send(
                        tms, 363500000, 1273000000, 50000, 1500, 0, 0, 0, 4500)
                    m.mav.home_position_send(
                        363500000, 1273000000, 50000,
                        0, 0, 0, [1, 0, 0, 0], 0, 0, 0)
                    # EKF 정상 — MAVSDK health 가 이걸 본다
                    m.mav.estimator_status_send(
                        us,
                        (mav.ESTIMATOR_ATTITUDE | mav.ESTIMATOR_VELOCITY_HORIZ
                         | mav.ESTIMATOR_VELOCITY_VERT | mav.ESTIMATOR_POS_HORIZ_REL
                         | mav.ESTIMATOR_POS_HORIZ_ABS | mav.ESTIMATOR_POS_VERT_ABS
                         | mav.ESTIMATOR_POS_VERT_AGL | mav.ESTIMATOR_PRED_POS_HORIZ_REL
                         | mav.ESTIMATOR_PRED_POS_HORIZ_ABS),
                        0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.5, 0.5)
                m.mav.extended_sys_state_send(
                    mav.MAV_VTOL_STATE_UNDEFINED, mav.MAV_LANDED_STATE_ON_GROUND)
                serve_params(m)
                time.sleep(0.1)

            n += 1
            if n % 5 == 0:
                print(f"  ... {n}초 송신 중")
    except KeyboardInterrupt:
        print("\n[가짜 FC] 종료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
