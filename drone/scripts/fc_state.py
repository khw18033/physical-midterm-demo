#!/usr/bin/env python3
# ============================================================================
# fc_state.py — FC 가 arm 할 준비가 됐는지 한 번에 본다 (pymavlink)
#
# 용도    : system_status(UNINIT/STANDBY), arm 상태, 비행 모드, GPS fix·위성 수,
#           센서 헬스, 배터리를 한 번 찍고 끝낸다.
#           특히 **MAV_STATE_STANDBY 로 바뀌었는지** 확인하는 용도다.
#           UNINIT 인 채로는 arm 이 거부될 가능성이 높다.
#
# 실행 조건 : 드론 모드일 것. 기본값은 라우터의 QGC 포트(TCP 5760)로 붙으므로
#             **14540 을 쓰는 telemetry_watch.py 와 동시에 돌려도 된다.**
#
# 위험도  : ★☆☆ 없음 — 듣기만 한다. FC 로 1바이트도 보내지 않는다.
#           heartbeat 조차 보내지 않는다 (라우터가 이미 받고 있는 스트림을 읽을 뿐).
#
# 사용    : ./venv/bin/python scripts/fc_state.py
# ============================================================================

import argparse
import os
import sys
import time

os.environ.setdefault("MAVLINK20", "1")
from pymavlink import mavutil                      # noqa: E402
from pymavlink.dialects.v20 import common as mav   # noqa: E402

READY = "MAV_STATE_STANDBY"


def main():
    ap = argparse.ArgumentParser(description="FC 상태 한 번 확인 (읽기 전용)")
    ap.add_argument("--device", default="tcp:127.0.0.1:5760",
                    help="기본 tcp:127.0.0.1:5760 (라우터 QGC 포트). "
                         "udpin:0.0.0.0:14540 도 가능하나 다른 스크립트와 겹친다")
    ap.add_argument("--timeout", type=float, default=15.0, help="수집 시간(초), 기본 15")
    args = ap.parse_args()

    print(f"[연결] {args.device} (읽기 전용, 송신 0바이트)")
    try:
        m = mavutil.mavlink_connection(args.device)
    except Exception as e:
        print(f"[오류] 연결 실패: {e}", file=sys.stderr)
        return 1

    hb = gps = sysst = batt = None
    t0 = time.time()
    while time.time() - t0 < args.timeout:
        msg = m.recv_match(blocking=True, timeout=2)
        if msg is None:
            continue
        t = msg.get_type()
        if t == "HEARTBEAT" and msg.get_srcSystem() == 1 and msg.get_srcComponent() == 1:
            hb = msg
        elif t == "GPS_RAW_INT":
            gps = msg
        elif t == "SYS_STATUS":
            sysst = msg
        elif t == "BATTERY_STATUS":
            batt = msg
        if hb is not None and gps is not None and sysst is not None:
            break

    if hb is None:
        print("[오류] heartbeat 를 받지 못했다. drone.target 이 떠 있는지 확인할 것.",
              file=sys.stderr)
        return 1

    print("=" * 60)
    state = mavutil.mavlink.enums["MAV_STATE"][hb.system_status].name
    armed = bool(hb.base_mode & mav.MAV_MODE_FLAG_SAFETY_ARMED)
    mark = "✔" if state == READY else "⚠"
    print(f"  {mark} system_status : {state}")
    if state != READY:
        print(f"       → {READY} 가 아니다. 이 상태로는 arm 이 거부될 수 있다.")
        print("         전원 직후라면 잠시 뒤 다시 확인한다. 계속 이러면 QGC 에서 사유를 본다.")
    print(f"    arm 상태      : {'ARMED ⚠' if armed else 'DISARMED'}")

    if gps is not None:
        fix = mavutil.mavlink.enums["GPS_FIX_TYPE"][gps.fix_type].name
        ok = gps.fix_type >= 3
        eph = "—" if gps.eph == 65535 else f"{gps.eph / 100:.2f}m"
        print(f"  {'✔' if ok else '⚠'} GPS           : {fix} (fix_type={gps.fix_type}), "
              f"위성 {gps.satellites_visible}개, 수평정밀도 {eph}")
        if not ok:
            print("       → 3D fix 가 아니다. 이륙 스크립트가 거부한다. 하늘이 트인 곳에서 더 기다린다.")

    if sysst is not None:
        def h(bit):
            return "O" if sysst.onboard_control_sensors_health & bit else "X"
        print(f"    센서 헬스     : GPS={h(mav.MAV_SYS_STATUS_SENSOR_GPS)} "
              f"AHRS={h(mav.MAV_SYS_STATUS_AHRS)} "
              f"자이로={h(mav.MAV_SYS_STATUS_SENSOR_3D_GYRO)} "
              f"가속도={h(mav.MAV_SYS_STATUS_SENSOR_3D_ACCEL)} "
              f"지자기={h(mav.MAV_SYS_STATUS_SENSOR_3D_MAG)} "
              f"RC={h(mav.MAV_SYS_STATUS_SENSOR_RC_RECEIVER)}")
        print(f"    배터리        : {sysst.voltage_battery / 1000:.2f}V "
              f"{sysst.battery_remaining}%")
    if batt is not None and batt.current_consumed not in (-1, None):
        print(f"    누적 소모     : {batt.current_consumed} mAh")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n중단됨")
        sys.exit(1)
