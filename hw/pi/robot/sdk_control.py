# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 구동 브리지(go1-sdk) 온디맨드 기동 (HW-R-06)
================================================================
평시에는 브리지를 내려 두고 **연결만 된 상태**로 있다가, 이동 명령이 올 때 띄운다.

## 왜 평시에 내려 두나

`go1_sdk_pc` 는 기동하는 순간 로봇을 force-stand 로 **일으켜 세운다.** 부팅 때
자동으로 뜨면 아무도 지켜보지 않는 자리에서 로봇이 일어선다 — 그래서 유닛의
부팅 자동시작이 꺼져 있다. 온디맨드는 그 전제를 유지하면서, 명령이 왔을 때만
사람이 의도한 시점에 일어서게 한다.

## 권한

브리지 자체는 root 가 필요 없다(유닛도 `User=physical`). root 가 필요한 것은
systemd 에 start/stop 을 시키는 행위뿐이다. 그래서 polkit 규칙으로 이 유닛
하나에 대해서만 `physical` 에게 허용한다 — sudoers 로 systemctl 전체를 여는 것보다
좁다. 규칙이 없으면 여기서 `systemctl_start_denied` 로 실패하고, 그 사유가
그대로 상위에 올라간다(조용히 실패하지 않는다).

    /etc/polkit-1/rules.d/50-go1-sdk.rules   — deploy/50-go1-sdk.rules 참조

## 기동 완료 판정

`systemctl start` 가 돌아왔다고 쓸 수 있는 게 아니다. 브리지가 UDP 를 열고
로봇이 HighState 를 올려보내기까지 시간이 걸리며, 그 전에 미션을 걸면 회전을
각으로 닫지 못해 열린 루프가 된다. 그래서 `MISSION PING` 이 `state=ok` 로
답할 때까지 기다린다 — 이것이 "쓸 수 있다"의 정의다.
"""
import subprocess
import time

from common import config
from robot import go1_mission


class SdkControlError(RuntimeError):
    """브리지를 띄우거나 내리지 못했다. 상위가 규약 코드로 번역한다."""


def _systemctl(verb, timeout=25):
    try:
        p = subprocess.run(["systemctl", verb, config.SDK_UNIT],
                           capture_output=True, text=True, timeout=timeout)
    except OSError as e:
        raise SdkControlError(f"systemctl_{verb}_failed: {e}")
    except subprocess.TimeoutExpired:
        raise SdkControlError(f"systemctl_{verb}_timeout")
    if p.returncode != 0:
        # polkit 규칙이 없으면 "Interactive authentication required" 가 여기 담긴다.
        first = ((p.stderr or p.stdout).strip().splitlines() or [str(p.returncode)])[0]
        raise SdkControlError(f"systemctl_{verb}_denied: {first[:120]}")
    return True


def unit_active():
    try:
        p = subprocess.run(["systemctl", "is-active", config.SDK_UNIT],
                           capture_output=True, text=True, timeout=5)
        return p.stdout.strip() == "active"
    except (OSError, subprocess.TimeoutExpired):
        return False


def probe():
    """(브리지 살아있음, 로봇 상태 옴). 유닛이 active 여도 둘 다 False 일 수 있다."""
    return go1_mission.MissionClient().probe(timeout=0.5)


def state():
    up, ready = probe()
    return {"unit_active": unit_active(), "bridge_up": up, "robot_state_ok": ready}


def start(timeout=None):
    """브리지를 띄우고 **로봇 상태가 실제로 올라올 때까지** 기다린다.

    ⚠ 기동하는 순간 로봇이 일어선다. 부르는 쪽이 그 사실을 상위에 알려야 한다."""
    timeout = timeout or config.SDK_START_TIMEOUT
    up, ready = probe()
    if up and ready:
        return {"already": True, "waited_s": 0.0}

    started = time.time()
    if not unit_active():
        _systemctl("start")

    while time.time() - started < timeout:
        up, ready = probe()
        if up and ready:
            return {"already": False, "waited_s": round(time.time() - started, 1)}
        time.sleep(0.5)

    # 유닛은 떴는데 로봇 상태가 안 온다 — 로봇 전원이 꺼졌거나 sport mode 가 아직이다.
    # 값을 지어내지 않고 사유를 그대로 올린다.
    raise SdkControlError("sdk_started_but_robot_state_dead"
                          if unit_active() else "sdk_start_failed")


def stop():
    """브리지를 내린다.

    프로세스만 죽이면 마지막 속도 명령이 로봇에 남을 수 있어, **먼저 구동을 멈춘 뒤**
    내린다. 로봇은 선 채로 남는다 — sport mode 가 자세를 유지하므로 주저앉지 않는다."""
    if not unit_active():
        return {"already": True, "unit_active": False}
    try:
        go1_mission.MissionClient().stop_all()
    except OSError:
        pass                                  # 이미 안 듣는 상태라면 그대로 내린다
    time.sleep(0.3)
    _systemctl("stop")
    return {"already": False, "unit_active": unit_active()}
