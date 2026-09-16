# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 온디바이스→Unity 상태전달 격리 테스트 (HW-R-06 디버깅)
======================================================================
실 로봇을 건드리지 않고, 파이가 Unity 로 보내는 상태(위치·각도) 경로만 검증한다.
go1_sdk_pc 의 send_unity_state 와 **완전히 같은 형식**으로 "움직이는 가짜 상태"를
15101 로 Unity 에 보낸다. Unity 게임뷰의 가상 GO1 이 이 값을 따라 원을 그리며 돌면
상태전달·좌표매핑이 정상이고, 안 돌면 (a)방화벽 인바운드 차단 또는 (b)좌표 불일치다.

상태 형식 (Unity ParseStatePacket, 10토큰):
    seq tms world_x world_z yaw(rad) vx vy wz estop mode

사용:
    HW_UNITY_IP=192.168.50.244 python3 -m bench.unity_state_test [초]
"""
import math
import os
import socket
import sys
import time

UNITY_IP = os.environ.get("HW_UNITY_IP", "192.168.50.244")
STATE_PORT = int(os.environ.get("HW_UNITY_STATE_PORT", 15101))
MODE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].replace(".","").isdigit() else "circle"
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else (float(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].replace(".","").isdigit() else 60.0)
R = 1.0            # 원 반경 (m)
W = 0.3           # 각속도 (rad/s) — 천천히
YAW_FLIP = os.environ.get("HW_YAW_FLIP", "0") == "1"   # 머리 180 반전 보정


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    print(f"[테스트] 원운동 상태 → {UNITY_IP}:{STATE_PORT}  ({DUR:.0f}초, 20Hz)")
    t0 = time.time()
    seq = 0
    while time.time() - t0 < DUR:
        t = time.time() - t0
        if MODE == "forward":
            # 로봇이 앞으로 걸을 때 send_unity_state 가 만드는 패턴과 동일:
            # yaw0 리셋 후 yaw_unity=pi/2 고정, 전방은 world_z 증가.
            SPEED = 0.15
            x = 0.0
            z = SPEED * t
            yaw = math.pi / 2
            vx = SPEED
        else:                               # circle
            x = R * (math.cos(W * t) - 1.0)   # 시작 (0,0)
            z = R * math.sin(W * t)
            yaw = W * t + math.pi / 2          # 접선 방향 (진행방향)
            vx = R * W
        if YAW_FLIP:
            yaw += math.pi
        seq += 1
        msg = (f"{seq} {time.time()*1000:.1f} {x:.6f} {z:.6f} {yaw:.6f} "
               f"{vx:.3f} 0.000 {W:.3f} 0 2")
        s.sendto(msg.encode(), (UNITY_IP, STATE_PORT))
        if seq % 40 == 0:
            print(f"  t={t:4.1f}s  pos=({x:+.2f},{z:+.2f})  yaw={math.degrees(yaw)%360:5.0f}deg", flush=True)
        time.sleep(0.05)
    print("[테스트] 종료")


if __name__ == "__main__":
    main()
