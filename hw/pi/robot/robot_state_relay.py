#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""온보딩 라즈베리파이의 로봇 상태 릴레이.

한 대의 파이에 붙은 로봇(실물이든 가상이든)의 상태를 받아, **어느 파이가 전달했는지**
(node_id)를 찍어서 Unity 로 넘긴다. Unity 는 이 node_id 로 같은 기종 로봇이 여러 대
들어와도 서로 구분해서 배치한다.

    로봇/피더  --(15200)-->  이 릴레이(pi1/pi7)  --(15201)-->  Unity

수신 형식 (셋 다 받는다)
  1) v2      : ROBOT <node> <type> <robot_id> <seq> <tms> <x> <z> <yaw> <vx> <vy> <wz> <estop> <mode>
  2) 피더 축약: <type> <robot_id> <seq> <tms> <x> <z> <yaw> <vx> <vy> <wz> <estop> <mode>
  3) 레거시   : <seq> <tms> <x> <z> <yaw> <vx> <vy> <wz> <estop> <mode>
               (go1_sdk_pc 의 기존 15101 페이로드. type=go1, robot_id=0 으로 본다)

송신 형식은 항상 v2 이고, node 는 이 릴레이의 --node_id 로 덮어쓴다.
릴레이가 곧 "전달한 파이"이므로 발신자가 무엇을 주장하든 여기서 정한다.

좌표 규약은 HW-interface/coordinate-contract.md 와 동일하다(Unity 월드, yaw 시계+).
"""
import argparse
import socket
import sys
import time

DEFAULT_INGRESS_PORT = 15200
DEFAULT_UNITY_PORT = 15201
TAG = "ROBOT"


def parse_incoming(text, default_type, default_robot_id):
    """수신 한 줄 -> (robot_type, robot_id, payload 10필드 문자열). 실패 시 None."""
    parts = text.strip().split()
    if not parts:
        return None

    if parts[0] == TAG:
        # ROBOT node type id + 10필드
        if len(parts) < 14:
            return None
        return parts[2], parts[3], parts[4:14]

    if len(parts) >= 12 and not _is_number(parts[0]):
        # 피더 축약형: type id + 10필드
        return parts[0], parts[1], parts[2:12]

    if len(parts) >= 10:
        # 레거시 10필드
        return default_type, default_robot_id, parts[0:10]

    return None


def _is_number(tok):
    try:
        float(tok)
        return True
    except ValueError:
        return False


def main():
    ap = argparse.ArgumentParser(description="온보딩 파이 -> Unity 로봇 상태 릴레이")
    ap.add_argument("--node_id", required=True,
                    help="이 파이의 식별자. 예: pi1, pi7")
    ap.add_argument("--unity_ip", default="192.168.50.244")
    ap.add_argument("--unity_port", type=int, default=DEFAULT_UNITY_PORT)
    ap.add_argument("--ingress_port", type=int, default=DEFAULT_INGRESS_PORT)
    ap.add_argument("--default_type", default="go1",
                    help="레거시 10필드로 들어온 상태의 기종")
    ap.add_argument("--default_robot_id", default="0")
    ap.add_argument("--log_sec", type=float, default=5.0,
                    help="0 이면 주기 로그를 끈다")
    args = ap.parse_args()

    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    rx.bind(("0.0.0.0", args.ingress_port))
    rx.settimeout(1.0)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dst = (args.unity_ip, args.unity_port)

    print(f"[relay] node={args.node_id} ingress=:{args.ingress_port} "
          f"-> unity={dst[0]}:{dst[1]}", flush=True)

    seen = {}          # (type, id) -> 마지막 수신 시각
    n_in = n_out = n_bad = 0
    last_log = time.time()

    while True:
        try:
            data, src = rx.recvfrom(2048)
        except socket.timeout:
            data = None
        except KeyboardInterrupt:
            break

        if data:
            n_in += 1
            parsed = parse_incoming(data.decode("utf-8", "replace"),
                                    args.default_type, args.default_robot_id)
            if parsed is None:
                n_bad += 1
            else:
                rtype, rid, payload = parsed
                seen[(rtype, rid)] = time.time()
                msg = " ".join([TAG, args.node_id, rtype, rid] + payload)
                tx.sendto(msg.encode("ascii", "replace"), dst)
                n_out += 1

        now = time.time()
        if args.log_sec > 0 and now - last_log >= args.log_sec:
            last_log = now
            alive = sorted(k for k, t in seen.items() if now - t < 3.0)
            print(f"[relay] node={args.node_id} in={n_in} out={n_out} bad={n_bad} "
                  f"robots={len(alive)} {alive}", flush=True)

    print("[relay] 종료", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
