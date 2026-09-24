#!/usr/bin/env python3
# ============================================================================
# check_link.py — FC(코아 H743 / PX4) ↔ 라즈베리파이 MAVLink 링크 수동 확인
#
# 용도    : TELEM2(GPIO14/15) 시리얼 링크가 살아 있는지, 어떤 메시지가 어떤
#           주기로 들어오는지, FC의 MAVLink 인스턴스 설정이 예정대로인지 확인.
#           4단계 drone-detect.service 가 이 스크립트의 종료 코드를 재사용한다.
#
# 실행 조건 : FC에 전원이 들어와 있고 TELEM2 ↔ GPIO14/15 배선이 연결돼 있을 것.
#             ~/drone/venv 의 pymavlink 필요.
#             mavlink-router 가 떠 있으면 시리얼 포트를 선점하므로,
#             그때는 --device udpin:0.0.0.0:14540 으로 라우터를 거쳐 붙을 것.
#
# 위험도  : 낮음 — 읽기 전용.
#           * 보내는 것: heartbeat, PARAM_REQUEST_READ(읽기), SET_MESSAGE_INTERVAL(스트림 요청)
#           * 보내지 않는 것: arm / disarm / takeoff / land / 모드 변경 /
#                             모터 테스트 / offboard / 파라미터 쓰기
#           FC 파라미터를 절대 쓰지 않는다. 값이 예정과 다르면 출력만 한다.
#
# 종료 코드 : 0 = 성공(heartbeat + ATTITUDE 수신), 1 = 실패
# ============================================================================

import argparse
import math
import os
import struct
import sys
import time
from collections import Counter

try:
    from pymavlink import mavutil
    # 모드 어휘는 2026-09-24 에 dronelink.py 로 옮겼다. 아래 import 는 단순한 이동이
    # 아니라 **re-export 다** — 저장소 밖의 MQTT 브리지(~/hw/pi/drone/)가
    # HW_DRONE_SCRIPTS 경로로 `from check_link import decode_px4_custom_mode` 를 하고 있다.
    # 이 줄을 지우면 drone-node 가 깨진다. noqa 는 "안 쓰는 것처럼 보여도 필요하다" 는 표시다.
    from dronelink import (                                          # noqa: F401
        is_vehicle_heartbeat,
        decode_px4_custom_mode,
        PX4_MAIN_MODE,
        PX4_SUB_MODE,
    )
except ImportError:
    print("[오류] pymavlink 가 없다. ~/drone/venv/bin/python 으로 실행할 것.", file=sys.stderr)
    sys.exit(1)

DRONE_ENV = os.path.expanduser("~/drone/config/drone.env")

# 이 스크립트가 읽는 FC 파라미터 (읽기 전용).
# 이름은 FC 의 MAVLink '인스턴스' 번호를 따른다 — 어느 포트에 배정됐는지는
# MAV_x_CONFIG 값으로 정해지므로 인스턴스 번호와 TELEM 번호는 별개다.
PARAMS_INST0 = ["MAV_0_CONFIG", "MAV_0_MODE", "SER_TEL1_BAUD"]
PARAMS_INST1 = ["MAV_1_CONFIG", "MAV_1_MODE", "SER_TEL2_BAUD"]
PARAMS_OTHER = ["UXRCE_DDS_CFG"]
ALL_PARAMS = PARAMS_INST0 + PARAMS_INST1 + PARAMS_OTHER

# ── 이 장비의 실제 배선 (2026-09-21 실측 확정) ──────────────────
# 라즈베리파이 GPIO14/15  ↔  FC TELEM2 (/dev/ttyS3 @ 921600)
# 무선 Air Unit           ↔  FC TELEM1 (/dev/ttyS1 @ 57600)
# 처음 문서에는 반대로 적혀 있었다. Air Unit 이 TELEM1 에 있는 것을 확인하고 바로잡았다.
PI_PORT = 102        # 라즈베리파이가 꽂힌 FC 포트 = TELEM 2
AIR_UNIT_PORT = 101  # 무선 Air Unit 이 꽂힌 FC 포트 = TELEM 1
PORT_NAME = {101: "TELEM1", 102: "TELEM2"}
PORT_BAUD_PARAM = {101: "SER_TEL1_BAUD", 102: "SER_TEL2_BAUD"}
# MAVLink 인스턴스 번호 -> (포트 배정 파라미터, 모드 파라미터)
INSTANCE_PARAMS = {0: ("MAV_0_CONFIG", "MAV_0_MODE"),
                   1: ("MAV_1_CONFIG", "MAV_1_MODE")}

# PX4 시리얼 포트 설정 enum (MAV_x_CONFIG, UXRCE_DDS_CFG 공용)
SERIAL_CFG = {
    0: "Disabled", 6: "GPS 1", 101: "TELEM 1", 102: "TELEM 2",
    103: "TELEM 3", 104: "GPS 2", 201: "WiFi", 300: "Radio Controller",
}
# PX4 MAV_x_MODE enum
MAV_MODE = {
    0: "Normal", 1: "Custom", 2: "Onboard", 3: "OSD", 4: "Magic", 5: "Config",
    6: "Iridium", 7: "Minimal", 8: "External Vision", 9: "Gimbal",
    10: "Onboard Low Bandwidth", 11: "uAvionix",
}
# PX4_MAIN_MODE / PX4_SUB_MODE 는 dronelink.py 로 옮겼다 (위 import 참고).
# MAV_MODE 는 여기 남는다 — 이건 비행 모드가 아니라 MAV_x_MODE 파라미터 enum 이다.


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


def is_serial(device):
    """udpin:/udpout:/udp:/tcp: 형식이면 네트워크, 아니면 시리얼 장치."""
    return not any(device.startswith(p) for p in ("udp", "tcp"))


def param_to_number(msg, is_px4):
    """PARAM_VALUE 를 사람이 읽는 숫자로.

    PX4는 정수 파라미터를 float 필드에 **bit-cast** 해서 보낸다(ArduPilot은 수치 캐스트).
    그래서 param_type 이 정수형이면 비트를 int32로 재해석해야 101 같은 값이 제대로 나온다.
    """
    raw = msg.param_value
    int_types = (
        mavutil.mavlink.MAV_PARAM_TYPE_UINT8, mavutil.mavlink.MAV_PARAM_TYPE_INT8,
        mavutil.mavlink.MAV_PARAM_TYPE_UINT16, mavutil.mavlink.MAV_PARAM_TYPE_INT16,
        mavutil.mavlink.MAV_PARAM_TYPE_UINT32, mavutil.mavlink.MAV_PARAM_TYPE_INT32,
    )
    if getattr(msg, "param_type", None) not in int_types:
        return raw, f"{raw:g}"

    bitcast = struct.unpack("<i", struct.pack("<f", raw))[0]
    # 비정규화 수(0이 아닌데 극단적으로 작음)면 bit-cast가 확실하다.
    denormal = raw != 0.0 and abs(raw) < 1e-30
    if is_px4 or denormal:
        return bitcast, str(bitcast)
    return int(round(raw)), str(int(round(raw)))


def fmt_cfg(value):
    return f"{value} ({SERIAL_CFG.get(value, '알 수 없는 값')})"


def fmt_mode(value):
    return f"{value} ({MAV_MODE.get(value, '알 수 없는 값')})"


# ---------------------------------------------------------------------------
# 1) heartbeat
# ---------------------------------------------------------------------------
def wait_heartbeat(m, timeout):
    print(f"[1/4] heartbeat 대기 (최대 {timeout}초)...")
    deadline = time.time() + timeout
    last_hb = 0.0
    while time.time() < deadline:
        # 우리 쪽 heartbeat (온보드 컴퓨터로 식별). 제어 명령이 아니다.
        if time.time() - last_hb > 1.0:
            m.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_ONBOARD_CONTROLLER,
                mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0,
                mavutil.mavlink.MAV_STATE_ACTIVE)
            last_hb = time.time()
        msg = m.recv_match(type="HEARTBEAT", blocking=True, timeout=0.5)
        # FC 의 heartbeat 만 받는다 (우리 자신·지상국 heartbeat 는 제외).
        if is_vehicle_heartbeat(msg, m.mav.srcSystem, m.mav.srcComponent):
            return msg
    return None


def report_heartbeat(msg):
    armed = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
    ap = mavutil.mavlink.enums["MAV_AUTOPILOT"].get(msg.autopilot)
    ty = mavutil.mavlink.enums["MAV_TYPE"].get(msg.type)
    st = mavutil.mavlink.enums["MAV_STATE"].get(msg.system_status)
    is_px4 = msg.autopilot == mavutil.mavlink.MAV_AUTOPILOT_PX4

    print("      heartbeat 수신 ✔")
    print(f"      system id / component id : {msg.get_srcSystem()} / {msg.get_srcComponent()}")
    print(f"      autopilot                : {ap.name if ap else msg.autopilot}")
    print(f"      기체 타입                : {ty.name if ty else msg.type}")
    print(f"      system status            : {st.name if st else msg.system_status}")
    print(f"      arm 상태                 : {'ARMED ⚠' if armed else 'DISARMED'}")
    cm = f"0x{msg.custom_mode:08x}"
    if is_px4:
        cm += f" = {decode_px4_custom_mode(msg.custom_mode)}"
    print(f"      custom mode              : {cm}")
    return is_px4


# ---------------------------------------------------------------------------
# 2) 메시지 종류별 개수와 주기
# ---------------------------------------------------------------------------
def survey_messages(m, seconds):
    print(f"\n[2/4] {seconds}초간 메시지 종류별 개수와 주기 측정...")
    counts = Counter()
    start = time.time()
    last_hb = 0.0
    while time.time() - start < seconds:
        if time.time() - last_hb > 1.0:
            m.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_ONBOARD_CONTROLLER,
                mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0,
                mavutil.mavlink.MAV_STATE_ACTIVE)
            last_hb = time.time()
        msg = m.recv_match(blocking=True, timeout=0.2)
        if msg and msg.get_type() != "BAD_DATA":
            counts[msg.get_type()] += 1
    elapsed = time.time() - start

    if not counts:
        print("      (한 건도 받지 못했다)")
        return counts

    print(f"      측정 시간 {elapsed:.1f}초, 총 {sum(counts.values())}건, {len(counts)}종")
    print(f"      {'메시지':<28}{'개수':>6}{'Hz':>9}")
    print(f"      {'-' * 43}")
    for name, n in counts.most_common():
        print(f"      {name:<28}{n:>6}{n / elapsed:>9.1f}")
    return counts


def request_attitude(m, target_system, target_component, hz=10):
    """ATTITUDE 가 안 들어올 때 스트림을 요청한다 (조회 요청 — 제어 명령 아님)."""
    print(f"      ATTITUDE 가 없다 → SET_MESSAGE_INTERVAL 로 {hz}Hz 요청 (스트림 요청)")
    m.mav.command_long_send(
        target_system, target_component,
        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0,
        mavutil.mavlink.MAVLINK_MSG_ID_ATTITUDE,  # param1: 메시지 ID
        int(1e6 / hz),                            # param2: 주기(us)
        0, 0, 0, 0, 0)


# ---------------------------------------------------------------------------
# 3) ATTITUDE
# ---------------------------------------------------------------------------
def show_attitude(m, lines, timeout):
    print(f"\n[3/4] ATTITUDE roll/pitch/yaw (도 단위) {lines}줄...")
    got = 0
    deadline = time.time() + timeout
    print(f"      {'시각(s)':>9}{'roll':>9}{'pitch':>9}{'yaw':>9}")
    print(f"      {'-' * 36}")
    while got < lines and time.time() < deadline:
        msg = m.recv_match(type="ATTITUDE", blocking=True, timeout=1.0)
        if not msg:
            continue
        print(f"      {msg.time_boot_ms / 1000.0:>9.1f}"
              f"{math.degrees(msg.roll):>9.2f}"
              f"{math.degrees(msg.pitch):>9.2f}"
              f"{math.degrees(msg.yaw):>9.2f}")
        got += 1
        time.sleep(0.3)
    if got == 0:
        print("      (ATTITUDE 를 받지 못했다)")
    return got


# ---------------------------------------------------------------------------
# 4) 파라미터 읽기 (읽기 전용) + 인스턴스 판정
# ---------------------------------------------------------------------------
def read_params(m, target_system, target_component, is_px4, timeout=3.0, retries=3):
    """FC 파라미터를 읽는다. PARAM_REQUEST_READ 는 읽기 요청이며 값을 쓰지 않는다.

    링크에 300Hz 넘게 텔레메트리가 흐르면 PARAM_VALUE 응답이 타임아웃 뒤로 밀려
    한두 개를 놓칠 수 있다. 놓친 것만 골라 최대 `retries` 회 다시 요청한다.
    (한 번만 요청했을 때 MAV_0_CONFIG 를 놓쳐 인스턴스 판정이 틀리게 나온 적이 있다.)
    """
    print("\n[4/4] FC 파라미터 읽기 (읽기 전용 — 쓰지 않는다)...")
    values = {}
    for attempt in range(retries):
        missing = [n for n in ALL_PARAMS if n not in values]
        if not missing:
            break
        if attempt:
            print(f"      (응답이 없어 재요청 {attempt}회차: {', '.join(missing)})")
        for name in missing:
            m.mav.param_request_read_send(
                target_system, target_component, name.encode("ascii"), -1)
            deadline = time.time() + timeout
            while time.time() < deadline:
                msg = m.recv_match(type="PARAM_VALUE", blocking=True, timeout=0.5)
                if not msg:
                    continue
                pid = msg.param_id
                if isinstance(pid, bytes):
                    pid = pid.decode("ascii", "ignore")
                pid = pid.rstrip("\x00").strip()
                num, _ = param_to_number(msg, is_px4)
                values[pid] = num
                if pid == name:
                    break
    return values


def report_params(values):
    print(f"      {'파라미터':<16}{'값':<28}{'예정값'}")
    print(f"      {'-' * 62}")
    expect = {
        "MAV_0_CONFIG": "(현재 값 유지 — Air Unit)",
        "MAV_0_MODE": "(현재 값 유지 — Air Unit)",
        "SER_TEL1_BAUD": "(현재 값 유지 — Air Unit)",
        "MAV_1_CONFIG": "102 (TELEM 2)",
        "MAV_1_MODE": "2 (Onboard)",
        "SER_TEL2_BAUD": "921600",
        "UXRCE_DDS_CFG": "0 (Disabled)",
    }
    for name in ALL_PARAMS:
        if name not in values:
            print(f"      {name:<16}{'읽지 못함':<28}{expect[name]}")
            continue
        v = values[name]
        if name.endswith("_CONFIG") or name == "UXRCE_DDS_CFG":
            shown = fmt_cfg(v)
        elif name.endswith("_MODE"):
            shown = fmt_mode(v)
        else:
            shown = str(v)
        print(f"      {name:<16}{shown:<28}{expect[name]}")


def find_instance(values, port):
    """해당 FC 시리얼 포트(101=TELEM1, 102=TELEM2)에 배정된 MAVLink 인스턴스 번호.

    인스턴스 번호를 고정하지 않고 MAV_x_CONFIG 값으로 찾는다.
    사람이 QGC 에서 인스턴스를 바꿔 잡아도 판정이 따라간다.
    """
    for idx, (cfg_name, _mode_name) in INSTANCE_PARAMS.items():
        if values.get(cfg_name) == port:
            return idx
    return None


def judge_instances(values, hb_sysid):
    print("\n      ── 인스턴스 판정 ──")
    print(f"      배선 기준: 라즈베리파이 = {PORT_NAME[PI_PORT]}, "
          f"Air Unit = {PORT_NAME[AIR_UNIT_PORT]}")
    ok = True

    # ── 라즈베리파이 링크 = TELEM2 에 배정된 인스턴스 ──────────
    pi_idx = find_instance(values, PI_PORT)
    if pi_idx is None:
        ok = False
        shown = ", ".join(
            f"{cfg}={fmt_cfg(values[cfg]) if values.get(cfg) is not None else '?'}"
            for cfg, _m in INSTANCE_PARAMS.values())
        print(f"      ✗ {PORT_NAME[PI_PORT]}({PI_PORT}) 에 배정된 MAVLink 인스턴스가 없다: {shown}")
        print(f"        → QGroundControl 에서 어느 한 인스턴스를 "
              f"MAV_x_CONFIG={PORT_NAME[PI_PORT]}, MAV_x_MODE=Onboard 로 설정할 것 "
              f"(설정 후 FC 재부팅)")
    else:
        mode_param = INSTANCE_PARAMS[pi_idx][1]
        mode = values.get(mode_param)
        if mode == 2:
            print(f"      ✔ 라즈베리파이 링크 = MAVLink 인스턴스 {pi_idx} on "
                  f"{PORT_NAME[PI_PORT]}, Onboard 모드")
        else:
            ok = False
            print(f"      ✗ 라즈베리파이 링크(인스턴스 {pi_idx} on {PORT_NAME[PI_PORT]}) 의 "
                  f"모드가 예정과 다르다: "
                  f"{mode_param}={fmt_mode(mode) if mode is not None else '?'}")
            print(f"        → QGroundControl 에서 {mode_param}=Onboard 로 설정할 것")

    pi_baud_param = PORT_BAUD_PARAM[PI_PORT]
    pi_baud = values.get(pi_baud_param)
    if pi_baud is not None and pi_baud != 921600:
        ok = False
        print(f"      ✗ {pi_baud_param}={pi_baud} (예정 921600)")

    # ── Air Unit 링크 = TELEM1 에 배정된 인스턴스 (건드리지 않음) ──
    air_idx = find_instance(values, AIR_UNIT_PORT)
    air_baud = values.get(PORT_BAUD_PARAM[AIR_UNIT_PORT])
    if air_idx is not None:
        air_mode = values.get(INSTANCE_PARAMS[air_idx][1])
        print(f"      ✔ Air Unit 링크 = MAVLink 인스턴스 {air_idx} on "
              f"{PORT_NAME[AIR_UNIT_PORT]} "
              f"(모드 {fmt_mode(air_mode) if air_mode is not None else '?'}, "
              f"보드레이트 {air_baud if air_baud is not None else '?'}) — 건드리지 않음")
    else:
        print(f"      ⚠ {PORT_NAME[AIR_UNIT_PORT]}({AIR_UNIT_PORT}) 에 배정된 인스턴스가 없다 "
              f"— 무선 Air Unit 이 MAVLink 로 살아 있지 않다.")
        print(f"        → 무선 텔레메트리를 쓸 예정이면 사람이 QGC 에서 확인할 것 "
              f"(규칙 2 에 따라 값을 쓰지 않았다)")

    dds = values.get("UXRCE_DDS_CFG")
    if dds == 0:
        print(f"      ✔ UXRCE_DDS_CFG = 0 (Disabled) — 예정대로")
    elif dds is not None:
        print(f"      ⚠ UXRCE_DDS_CFG = {fmt_cfg(dds)} (예정 0). 시리얼 포트를 물고 있으면 충돌 가능")

    print(f"\n      heartbeat 를 보낸 FC system id = {hb_sysid}")
    return ok


# ---------------------------------------------------------------------------
def print_failure_hints(device, tried_bauds):
    print("\n" + "=" * 68)
    print("링크 실패 — 원인 후보")
    print("=" * 68)
    print(f"  시도한 장치      : {device}")
    print(f"  시도한 보드레이트: {', '.join(str(b) for b in tried_bauds) if tried_bauds else '(해당 없음)'}")
    print("""
  1. TX/RX 반대
     FC TELEM2 TX → 라즈베리파이 10번 핀(GPIO15, RXD)
     FC TELEM2 RX → 라즈베리파이  8번 핀(GPIO14, TXD)
     GND          → 6번 핀
     (TX↔TX, RX↔RX 로 꽂으면 아무것도 안 들어온다)
     ※ TELEM1 은 무선 Air Unit 자리다. 거기 꽂으면 안 된다.

  2. 보드레이트 불일치
     FC 의 SER_TEL2_BAUD 와 --baud 가 같아야 한다.

  3. FC 파라미터 미설정
     QGroundControl 에서 MAV_1_CONFIG=TELEM2, MAV_1_MODE=Onboard,
     SER_TEL2_BAUD=921600, UXRCE_DDS_CFG=0. 설정 후 FC 재부팅 필요.

  4. 콘솔/다른 프로세스가 포트를 점유
     sudo fuser -v /dev/ttyAMA0
     systemctl list-units 'serial-getty@*'     # ttyAMA0 에 떠 있으면 안 된다
     systemctl status drone-mavlink-router     # 4단계 라우터가 떠 있으면 포트를 선점한다
       → 그 경우 --device udpin:0.0.0.0:14540 으로 라우터를 거쳐 붙을 것

  5. 장치 경로
     이 장비의 FC 포트는 /dev/ttyAMA0 이다 (GPIO14/15).
     /dev/serial0 은 디버그 커넥터(ttyAMA10)를 가리키므로 쓰면 안 된다.
     ls -l /dev/serial* /dev/ttyAMA*
     pinctrl get 14,15      # GPIO14=TXD0, GPIO15=RXD0 여야 한다

  6. FC 전원
     FC 에 전원이 들어와 있는지, TELEM2 커넥터가 제대로 꽂혔는지 확인.
""")


def try_connect(device, baud, hb_timeout):
    if is_serial(device):
        print(f"\n─── 접속 시도: {device} @ {baud} ───")
        m = mavutil.mavlink_connection(
            device, baud=baud, source_system=1,
            source_component=mavutil.mavlink.MAV_COMP_ID_ONBOARD_COMPUTER)
    else:
        print(f"\n─── 접속 시도: {device} ───")
        m = mavutil.mavlink_connection(
            device, source_system=1,
            source_component=mavutil.mavlink.MAV_COMP_ID_ONBOARD_COMPUTER)
    hb = wait_heartbeat(m, hb_timeout)
    if hb is None:
        m.close()
        return None, None
    return m, hb


def main():
    env = load_env(DRONE_ENV)
    ap = argparse.ArgumentParser(
        description="FC MAVLink 링크 확인 (읽기 전용). 제어 명령을 보내지 않는다.")
    ap.add_argument("--device", default=env.get("FC_DEVICE", "/dev/ttyAMA0"),
                    help="시리얼 장치 또는 udpin:0.0.0.0:14540 형식 "
                         f"(기본: drone.env 의 FC_DEVICE = {env.get('FC_DEVICE', '/dev/ttyAMA0')})")
    ap.add_argument("--baud", type=int, default=int(env.get("FC_BAUD", 921600)),
                    help="시리얼 보드레이트 (기본 921600)")
    ap.add_argument("--fallback-baud", type=int, default=int(env.get("FC_BAUD_FALLBACK", 57600)),
                    help="첫 시도 실패 시 재시도할 보드레이트 (기본 57600)")
    ap.add_argument("--no-fallback", action="store_true", help="대체 보드레이트를 시도하지 않는다")
    ap.add_argument("--hb-timeout", type=float, default=10.0, help="heartbeat 대기 시간 (기본 10초)")
    ap.add_argument("--survey-seconds", type=float, default=5.0, help="메시지 주기 측정 시간 (기본 5초)")
    ap.add_argument("--attitude-lines", type=int, default=6, help="ATTITUDE 출력 줄 수 (기본 6)")
    ap.add_argument("--quiet", action="store_true", help="요약만 출력 (자동 실행용)")
    args = ap.parse_args()

    print("=" * 68)
    print("FC MAVLink 링크 확인 — 읽기 전용 (제어 명령 없음)")
    print("=" * 68)

    tried = []
    m = hb = None
    if is_serial(args.device):
        bauds = [args.baud] if args.no_fallback else [args.baud, args.fallback_baud]
        bauds = list(dict.fromkeys(bauds))  # 중복 제거
        for b in bauds:
            tried.append(b)
            m, hb = try_connect(args.device, b, args.hb_timeout)
            if m:
                used_baud = b
                break
    else:
        m, hb = try_connect(args.device, None, args.hb_timeout)
        used_baud = None

    if m is None:
        print("\n      heartbeat 없음 ✗")
        print_failure_hints(args.device, tried)
        return 1

    if used_baud and used_baud != args.baud:
        print(f"\n      ⚠ 기본 {args.baud} 에서는 실패했고 {used_baud} 에서 붙었다.")
        print(f"        drone.env 의 FC_BAUD 와 FC 의 SER_TEL2_BAUD 를 맞출 것.")

    is_px4 = report_heartbeat(hb)
    sysid, compid = hb.get_srcSystem(), hb.get_srcComponent()

    counts = survey_messages(m, args.survey_seconds)
    if "ATTITUDE" not in counts:
        request_attitude(m, sysid, compid)
        time.sleep(0.5)

    n_att = show_attitude(m, args.attitude_lines, timeout=10.0)

    values = read_params(m, sysid, compid, is_px4)
    report_params(values)
    params_ok = judge_instances(values, sysid)

    m.close()

    print("\n" + "=" * 68)
    ok = n_att > 0
    print(f"통과 기준: heartbeat 수신 ✔ / ATTITUDE 수신 {'✔' if ok else '✗'}")
    if not params_ok:
        print("FC 파라미터가 예정과 다르다 — 위 판정 참고 (값은 쓰지 않았다)")
    if ok:
        print("결과: 성공 (종료 코드 0)")
        print("\n※ 기체를 살짝 기울였을 때 위 roll/pitch 값이 따라 바뀌는지는")
        print("  사람이 직접 확인해 주세요. 그래야 자세 추정까지 정상입니다.")
    else:
        print("결과: 실패 (종료 코드 1) — heartbeat 는 왔지만 ATTITUDE 가 없다")
        print("      FC 가 부팅 중이거나 스트림 설정이 다를 수 있다.")
    print("=" * 68)
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n중단됨")
        sys.exit(1)
