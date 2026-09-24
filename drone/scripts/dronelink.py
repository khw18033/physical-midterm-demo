#!/usr/bin/env python3
# ============================================================================
# dronelink.py — drone 스크립트 공용 헬퍼 (실행 파일이 아니다)
#
# 위험도 : 없음 — 판별 함수와 설정 로더만 들어 있다. 아무것도 보내지 않는다.
# ============================================================================

import os

from pymavlink import mavutil

ENV_FILE = "/etc/drone-node.env"


def load_env(path=ENV_FILE):
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


def make_cfg(env):
    """환경변수 → env 파일 → 기본값 순서로 설정을 읽는 함수를 만든다."""
    def cfg(key, default, cast=str):
        try:
            return cast(os.environ.get(key, env.get(key, default)))
        except (TypeError, ValueError):
            return cast(default)
    return cfg


def is_vehicle_heartbeat(msg, me_sys=None, me_comp=None):
    """이 HEARTBEAT 가 '비행 컨트롤러'의 것인지 판정한다.

    왜 단순히 srcSystem 비교로는 안 되는가:

    1) PX4 의 기본 MAV_SYS_ID 는 1 이고, 컴패니언 컴퓨터도 관례상 같은 sysid 1 에
       compid 191 을 쓴다. sysid 만 비교하면 FC heartbeat 를 '내가 보낸 것'으로
       오인해 버린다 (실제로 이 버그로 감지가 통째로 실패했다).
       → sysid 와 compid 를 **함께** 비교해야 한다.

    2) 라우터를 거치면 QGroundControl · MAVSDK 등 다른 엔드포인트의 heartbeat 도
       같이 들어온다. 그것들을 링크 생존 신호로 세면 FC 가 없는데도 링크가
       살아 있다고 오판한다.
       → autopilot 필드가 MAV_AUTOPILOT_INVALID(8) 가 아닌 것만 FC 로 인정한다.
         지상국·컴패니언은 INVALID 을 쓰고, PX4 는 MAV_AUTOPILOT_PX4(12) 를 쓴다.
    """
    if msg is None or msg.get_type() != "HEARTBEAT":
        return False
    if me_sys is not None and me_comp is not None:
        if (msg.get_srcSystem(), msg.get_srcComponent()) == (me_sys, me_comp):
            return False
    return getattr(msg, "autopilot", mavutil.mavlink.MAV_AUTOPILOT_INVALID) \
        != mavutil.mavlink.MAV_AUTOPILOT_INVALID


# ===========================================================================
# 비행 모드 어휘 (2026-09-24 추가)
#
# 왜 여기로 옮겼나 — 원래 decode_px4_custom_mode() 는 check_link.py 안에 있었다.
# 그런데 check_link.py 는 '실행 스크립트'이고, 저장소 밖의 MQTT 브리지
# (~/hw/pi/drone/, HW_DRONE_SCRIPTS 경로로 import)가 그걸 라이브러리처럼 쓰고 있었다.
# 실행 파일을 고치면 브리지가 깨지는 구조라, 공용 헬퍼인 이 파일로 올린다.
# check_link.py 에는 re-export 를 남겨 기존 import 경로를 유지한다.
#
# 이 블록은 순수 추가다. 위의 load_env / make_cfg / is_vehicle_heartbeat 는
# 한 글자도 건드리지 않았다 — drone-detect / drone-linkmon / drone-node 세 서비스가
# 전부 is_vehicle_heartbeat 하나에만 의존하기 때문이다.
# ===========================================================================

# PX4 는 HEARTBEAT.custom_mode 에 main/sub 모드를 바이트로 나눠 싣는다.
PX4_MAIN_MODE = {
    1: "MANUAL", 2: "ALTCTL", 3: "POSCTL", 4: "AUTO", 5: "ACRO",
    6: "OFFBOARD", 7: "STABILIZED", 8: "RATTITUDE", 9: "SIMPLE",
}
PX4_SUB_MODE = {
    1: "READY", 2: "TAKEOFF", 3: "LOITER", 4: "MISSION", 5: "RTL",
    6: "LAND", 7: "RTGS", 8: "FOLLOW_TARGET", 9: "PRECLAND",
}


def decode_px4_custom_mode(custom_mode):
    """PX4 custom_mode 정수를 'AUTO.LOITER' 같은 이름으로 푼다.

    실측 예: 0x03040000 -> main=4(AUTO), sub=3(LOITER) -> "AUTO.LOITER"
    모르는 값은 숫자를 그대로 드러낸다 (지어내지 않는다).
    """
    main = (custom_mode >> 16) & 0xFF
    sub = (custom_mode >> 24) & 0xFF
    name = PX4_MAIN_MODE.get(main, f"main={main}")
    if main == 4 and sub:
        name += "." + PX4_SUB_MODE.get(sub, f"sub={sub}")
    return name


# MAVSDK 는 같은 상태를 다른 이름으로 부른다 — AUTO.LOITER 를 'HOLD' 라고 한다.
# 그래서 pymavlink 경로(브리지·linkmon·CONTRACT)와 MAVSDK 경로(제어 스크립트)가
# 서로 다른 단어를 쓰고 있었다. 사람이 눈으로 볼 때는 넘어갔지만, 코드가 모드로
# 분기하기 시작하면 곧장 버그가 된다. CONTRACT_x500.md 가 PX4 표기로 고정했으므로
# 그쪽에 맞춘다.
#
# ✔ 2026-09-24 실물 확인 — mavsdk 3.17.4 의 FlightMode 멤버는 정확히 15개이고
#   (UNKNOWN READY TAKEOFF HOLD MISSION RETURN_TO_LAUNCH LAND OFFBOARD FOLLOW_ME
#    MANUAL ALTCTL POSCTL ACRO STABILIZED RATTITUDE) 아래 표가 전부를 덮는다.
#   표에만 있고 enum 에 없는 이름도 없다. 추측이 아니라 찍어서 확인한 값이다.
#   str(FlightMode.HOLD) 가 "FlightMode.HOLD" 가 아니라 "HOLD" 를 준다는 것도 같이 확인했다
#   — normalize_mode() 가 str() 에 의존하므로 이게 깨지면 매핑이 통째로 실패한다.
#   mavsdk 를 올리면(4.x 는 API 가 다른 별개 패키지다) 이 확인을 다시 해야 한다.
MAVSDK_TO_PX4 = {
    "TAKEOFF": "AUTO.TAKEOFF",
    "HOLD": "AUTO.LOITER",
    "LAND": "AUTO.LAND",
    "RETURN_TO_LAUNCH": "AUTO.RTL",
    "MISSION": "AUTO.MISSION",
    "READY": "AUTO.READY",
    "FOLLOW_ME": "AUTO.FOLLOW_TARGET",
    "POSCTL": "POSCTL",
    "ALTCTL": "ALTCTL",
    "MANUAL": "MANUAL",
    "STABILIZED": "STABILIZED",
    "OFFBOARD": "OFFBOARD",
    "ACRO": "ACRO",
    "RATTITUDE": "RATTITUDE",
    "UNKNOWN": "UNKNOWN",
}


def normalize_mode(flight_mode):
    """MAVSDK FlightMode 를 PX4 표기 문자열로 맞춘다.

    MAVSDK 의 'HOLD' 와 pymavlink 의 'AUTO.LOITER' 는 같은 상태다.
    표에 없는 이름이 오면 **원문을 그대로 돌려준다** — 모르는 값을 지어내지 않는다.
    그래야 새 MAVSDK 버전이 이름을 바꿔도 조용히 틀린 모드로 분기하지 않고,
    로그에 낯선 이름이 그대로 드러나 사람이 알아챌 수 있다.
    """
    name = str(flight_mode).strip().upper()
    return MAVSDK_TO_PX4.get(name, name)


# 자동 이륙·착륙 중 '정상' 으로 보는 모드. 이 밖으로 나가면 사람 또는 FC 가
# 기체를 잡은 것이므로, 제어 스크립트는 명령을 더 보내지 않고 물러난다.
EXPECTED_AUTO_MODES = frozenset({"AUTO.TAKEOFF", "AUTO.LOITER", "AUTO.LAND"})
