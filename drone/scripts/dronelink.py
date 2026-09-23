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
