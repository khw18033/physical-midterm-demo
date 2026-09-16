#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""가상 로봇 상태 송출기.

실물 로봇 없이 디지털트윈 경로를 검증하기 위해, 가상 로봇(기본 Unitree Go1)의
상태를 만들어 **온보딩 라즈베리파이의 릴레이**(robot_state_relay.py)로 보낸다.
릴레이가 node_id 를 찍어 Unity 로 넘기므로, Unity 입장에서는 실제 로봇이
그 파이에 붙어 있는 것과 동일하게 보인다.

    이 피더 --(15200)--> 릴레이(pi1/pi7) --(15201)--> Unity

좌표 규약은 HW-interface/coordinate-contract.md 와 동일하다.
  전진 = (sin yaw, cos yaw), yaw 는 시계방향 +, +Z 기준.
따라서 dead-reckoning 도 실제 go1_sdk_pc 와 같은 식을 쓴다.
"""
import argparse
import math
import socket
import sys
import time

DEFAULT_RELAY_PORT = 15200


class VirtualRobot:
    """원 궤도를 도는 가상 로봇. 반지름·속도·시작 위상을 개체마다 다르게 준다."""

    def __init__(self, robot_id, index, speed=0.35, radius=1.6):
        self.robot_id = robot_id
        self.seq = 0
        self.speed = speed
        self.radius = radius * (1.0 + 0.35 * index)
        # 개체마다 다른 시작 위상 -> 겹쳐 보이지 않는다
        self.phase = (2.0 * math.pi / 3.0) * index
        self.x = 0.0
        self.z = 0.0
        self.yaw = 0.0
        self.vx = 0.0
        self.wz = 0.0
        self._t0 = time.time()

    def step(self, now):
        t = now - self._t0
        omega = self.speed / self.radius          # rad/s
        a = self.phase + omega * t
        # 원 궤도 위의 위치. 시작점이 원점이 되도록 평행이동한다.
        self.x = self.radius * (math.sin(a) - math.sin(self.phase))
        self.z = self.radius * (math.cos(self.phase) - math.cos(a))
        # 진행 방향 = 접선. Unity 규약(시계+, +Z 기준)이므로 atan2(dx, dz).
        dx, dz = math.cos(a), math.sin(a)
        self.yaw = math.atan2(dx, dz)
        self.vx = self.speed
        self.wz = -omega        # 로봇 yawSpeed 는 반시계+ 라 부호 반대

    def payload(self):
        self.seq += 1
        tms = time.time() * 1000.0
        return (f"{self.seq} {tms:.1f} {self.x:.6f} {self.z:.6f} {self.yaw:.6f} "
                f"{self.vx:.3f} 0.000 {self.wz:.3f} 0 2")


def main():
    ap = argparse.ArgumentParser(description="가상 로봇 -> 온보딩 파이 릴레이 송출")
    ap.add_argument("--relay", required=True,
                    help="릴레이 주소. 예: 192.168.50.172 또는 192.168.50.172:15200")
    ap.add_argument("--type", default="go1",
                    help="로봇 기종. go1 / robomaster_ep 등")
    ap.add_argument("--count", type=int, default=1, help="가상 로봇 대수")
    ap.add_argument("--id_prefix", default=None,
                    help="robot_id 접두사. 기본은 기종명")
    ap.add_argument("--hz", type=float, default=20.0)
    ap.add_argument("--speed", type=float, default=0.35, help="m/s")
    ap.add_argument("--radius", type=float, default=1.6, help="원 궤도 반지름(m)")
    ap.add_argument("--duration", type=float, default=0.0,
                    help="초. 0 이면 무한")
    args = ap.parse_args()

    if ":" in args.relay:
        host, port_s = args.relay.rsplit(":", 1)
        port = int(port_s)
    else:
        host, port = args.relay, DEFAULT_RELAY_PORT

    prefix = args.id_prefix or args.type
    robots = [VirtualRobot(f"{prefix}-{i + 1}", i, args.speed, args.radius)
              for i in range(args.count)]

    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dst = (host, port)
    period = 1.0 / max(1.0, args.hz)
    t_end = time.time() + args.duration if args.duration > 0 else None

    print(f"[feeder] type={args.type} count={args.count} -> {dst[0]}:{dst[1]} "
          f"@{args.hz:g}Hz ids={[r.robot_id for r in robots]}", flush=True)

    sent = 0
    try:
        while True:
            now = time.time()
            if t_end and now >= t_end:
                break
            for r in robots:
                r.step(now)
                # 축약형: <type> <robot_id> + 10필드. node 는 릴레이가 찍는다.
                msg = f"{args.type} {r.robot_id} {r.payload()}"
                tx.sendto(msg.encode("ascii"), dst)
                sent += 1
            time.sleep(period)
    except KeyboardInterrupt:
        pass

    print(f"[feeder] 종료. 보낸 패킷 {sent}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
