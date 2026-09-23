#!/usr/bin/env python3
# ============================================================================
# failsafe_audit.py — 페일세이프 설정 감사 (읽기 전용)
#
# 용도    : "비행 중 라즈베리파이가 죽으면 / 조종기가 끊기면 / 배터리가 바닥나면
#           기체가 어떻게 되는가" 를 FC 의 실제 설정값으로 답한다.
#
# 실행 조건 : 드론 모드일 것. 라우터의 QGC 포트(TCP 5760)로 붙으므로
#             telemetry_watch.py 와 동시에 돌려도 된다.
#
# 위험도  : ★☆☆ 없음 — 파라미터를 **읽기만** 한다. 하나도 쓰지 않는다.
#           (PARAM_REQUEST_READ 는 조회 요청이다. 제어 명령이 아니다)
#
# 사용    : ./venv/bin/python scripts/failsafe_audit.py
# ============================================================================

import argparse
import os
import struct
import sys
import time

os.environ.setdefault("MAVLINK20", "1")
from pymavlink import mavutil   # noqa: E402

# PX4 는 INT 계열 파라미터를 float32 비트에 그대로 실어 보낸다(bytewise).
# int(param_value) 로 읽으면 denormal 이라 전부 0 으로 보인다 — 2026-09-22 에 실제로 겪었다.
_FMT = {"INT8": "<b", "UINT8": "<B", "INT16": "<h",
        "UINT16": "<H", "INT32": "<i", "UINT32": "<I"}


def decode(value, ptype):
    name = mavutil.mavlink.enums["MAV_PARAM_TYPE"][ptype].name.replace("MAV_PARAM_TYPE_", "")
    fmt = _FMT.get(name)
    if fmt:
        raw = struct.pack("<f", value)
        return struct.unpack(fmt, raw[:struct.calcsize(fmt)])[0]
    return round(value, 3)


# 행동 enum — PX4 버전에 따라 다를 수 있으므로 원값도 같이 보여 준다
ACT = {0: "Disabled (아무것도 안 함)", 1: "Hold (그 자리에 호버)",
       2: "Return (RTL — 이륙 지점으로 귀환)", 3: "Land (그 자리에 착륙)",
       4: "Disarm", 5: "Terminate (비상 종료)", 6: "Lockdown (모터 정지)"}
LOWBAT = {0: "경고만", 1: "Return (RTL)", 2: "Land (착륙)",
          3: "위험=RTL, 비상=착륙"}

SPEC = [
    ("── 조종기(RC) 상실 ──", None, None),
    ("NAV_RCL_ACT", ACT, "조종기 신호가 끊겼을 때의 동작"),
    ("COM_RC_LOSS_T", None, "조종기 상실로 판정하기까지의 시간(초)"),
    ("── 데이터 링크(라즈베리파이·지상국) 상실 ──", None, None),
    ("NAV_DLL_ACT", ACT, "★ 라즈베리파이가 죽었을 때 기체의 동작"),
    ("COM_DL_LOSS_T", None, "링크 상실로 판정하기까지의 시간(초)"),
    ("── 배터리 ──", None, None),
    ("COM_LOW_BAT_ACT", LOWBAT, "배터리 부족 시 동작"),
    ("BAT_LOW_THR", None, "부족 경보 임계 (0.15 = 15%)"),
    ("BAT_CRIT_THR", None, "위험 임계"),
    ("BAT_EMERGEN_THR", None, "비상 임계"),
    ("BAT1_N_CELLS", None, "셀 수 (4 = 4S)"),
    ("── 기타 ──", None, None),
    ("GF_ACTION", ACT, "지오펜스 이탈 시 동작"),
    ("RTL_RETURN_ALT", None, "RTL 귀환 고도(m)"),
    ("COM_OBL_ACT", ACT, "OFFBOARD 상실 시 (우리는 OFFBOARD 를 안 쓴다)"),
    ("COM_POSCTL_NAVL", None, "위치 추정 상실 시 동작"),
]


def read_param(m, name, tries=4):
    for _ in range(tries):
        m.mav.param_request_read_send(1, 1, name.encode("ascii"), -1)
        t0 = time.time()
        while time.time() - t0 < 2.0:
            r = m.recv_match(type="PARAM_VALUE", blocking=True, timeout=1.0)
            if r is None:
                continue
            pid = r.param_id
            if not isinstance(pid, str):
                pid = pid.decode(errors="replace")
            if pid.strip("\x00") == name:
                return decode(r.param_value, r.param_type)
    return None


def main():
    ap = argparse.ArgumentParser(description="페일세이프 설정 감사 (읽기 전용)")
    ap.add_argument("--device", default="tcp:127.0.0.1:5760")
    args = ap.parse_args()

    print(f"[연결] {args.device} — 파라미터를 읽기만 한다 (쓰기 없음)")
    m = mavutil.mavlink_connection(args.device, source_system=255, source_component=190)
    if m.wait_heartbeat(timeout=15) is None:
        print("[오류] heartbeat 없음. drone.target 이 떠 있는지 확인할 것.", file=sys.stderr)
        return 1

    vals = {}
    print()
    for name, enum, desc in SPEC:
        if enum is None and desc is None:
            print(f"\n{name}")
            continue
        v = read_param(m, name)
        vals[name] = v
        if v is None:
            print(f"  {name:<16} = (이 FC 에 없음)")
            continue
        shown = f"{v}"
        if enum and isinstance(v, int) and v in enum:
            shown = f"{v} = {enum[v]}"
        print(f"  {name:<16} = {shown}")
        if desc:
            print(f"  {'':<16}   {desc}")

    # ── 사람 말로 정리 ────────────────────────────────────────────────
    print("\n" + "=" * 68)
    print("  비행 중 이런 일이 일어나면")
    print("=" * 68)

    dll = vals.get("NAV_DLL_ACT")
    dlt = vals.get("COM_DL_LOSS_T")
    print("\n▸ 라즈베리파이가 죽는다 (전원 차단·브라운아웃·SSH 끊김)")
    print("  비행 제어는 FC 가 한다. 라즈베리파이는 명령을 '시작'만 시킬 뿐이라")
    print("  기체는 하던 동작을 계속한다. OFFBOARD 가 아니므로 즉시 추락하지 않는다.")
    if dll is None:
        print("  ⚠ NAV_DLL_ACT 를 읽지 못했다 — QGC 에서 직접 확인할 것.")
    elif dll == 0:
        print(f"  → 링크 상실 페일세이프가 **꺼져 있다**(NAV_DLL_ACT=0).")
        print("     기체는 아무 일도 없었다는 듯 그대로 있는다.")
        print("     ★ takeoff_land.py 로 이륙한 직후였다면 land 명령이 영영 오지 않는다.")
        print("       → 기체가 그 고도에서 계속 호버한다. **조종기로 내려야 한다.**")
    else:
        act = ACT.get(dll, f"값 {dll}")
        t = f"{dlt}초 뒤" if dlt is not None else "설정된 시간 뒤"
        print(f"  → {t} 자동으로 **{act}** 를 수행한다 (NAV_DLL_ACT={dll}).")
        print("     ★ 사람이 개입하지 않아도 기체가 스스로 움직인다는 뜻이다. 놀라지 말 것.")

    rcl = vals.get("NAV_RCL_ACT")
    print("\n▸ 조종기가 끊긴다")
    if rcl is None:
        print("  ⚠ NAV_RCL_ACT 를 읽지 못했다 — QGC 에서 직접 확인할 것.")
    elif rcl == 0:
        print("  → ⚠⚠ 페일세이프가 **꺼져 있다**(NAV_RCL_ACT=0). 기체가 그대로 있는다.")
        print("     첫 비행 전에 QGC 에서 켜는 것을 강력히 권한다.")
    else:
        print(f"  → 자동으로 **{ACT.get(rcl, rcl)}** 를 수행한다 (NAV_RCL_ACT={rcl}).")

    lba = vals.get("COM_LOW_BAT_ACT")
    print("\n▸ 배터리가 바닥난다")
    if lba is None:
        print("  ⚠ COM_LOW_BAT_ACT 를 읽지 못했다 — QGC 에서 직접 확인할 것.")
    elif lba == 0:
        print("  → ⚠⚠ **경고만 하고 아무 동작도 하지 않는다**(COM_LOW_BAT_ACT=0).")
        print("     사람이 계속 배터리를 보고 있어야 한다.")
    else:
        print(f"  → **{LOWBAT.get(lba, lba)}** (COM_LOW_BAT_ACT={lba}).")
    print("\n  ※ 이건 **FC** 의 배터리 페일세이프다. 라즈베리파이의 전원 부족과는 별개다.")
    print("    라즈베리파이가 드론 BEC 에서 전원을 먹는다면, 비행 중 전압 강하로")
    print("    라즈베리파이만 먼저 꺼질 수 있다 — 그때는 위의 '라즈베리파이가 죽는다' 항목이 된다.")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n중단됨")
        sys.exit(1)
