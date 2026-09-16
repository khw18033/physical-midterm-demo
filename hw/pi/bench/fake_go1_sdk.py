# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 구동 브리지(go1_sdk_pc) 흉내 — 로봇 없이 ACK 경로 시험
=========================================================================
로봇도 실물 SDK도 없이 **명령이 들어오면 ACK 가 나가는 전 구간**을 돌려 본다.
관제 웹의 진행률·중단 UI 를 로봇 없이 만들 수 있게 하는 것이 목적이다.

    python3 -m bench.fake_go1_sdk                (pi/ 디렉터리에서)
    python3 -m bench.fake_go1_sdk --interval 0.5 # 더 빠르게

  ⚠ **go1-sdk 서비스를 끄고 써야 한다** — 같은 UDP 포트(15100)를 쓴다.
     로봇이 붙어 있는데 이걸 켜면 명령이 실물 로봇에 가지 않고 여기서 먹힌다.

## 무엇을 흉내내는가

go1_sdk_pc 가 상위(robot-node)와 주고받는 UDP 계약 그대로다. 로봇은 없으므로
움직이는 척만 하고, 시간만 흘려보낸 뒤 ACK 를 낸다.

  받음 15100  "MISSION PING"                  -> "MISSION PONG state=ok" 로 답
              "MISSION SCAN <steps> <deg> <m> <vx> [hold_s]"   hold_s>0: 촬영 자리마다 CONTINUE 대기
              "MISSION CONTINUE <step>"        step 번 촬영 뒤 대기 해제(먼저 와도 기억)
              "MISSION FORWARD <m> [vx]"
              "MISSION TURN <deg>"             (오른쪽 +)
              "MISSION CANCEL"
              "MODE 0|1" / "<vx> <vy> <wz> <estop>"   (텔레옵 — 받아서 세기만)
  보냄 15106  ACK JSON 1건/1단계 (실물과 같은 필드)

yaw 는 실제로 도는 것처럼 45도씩 누적해서 넣는다. 웹에서 방위 표시를 만들 때
값이 변하지 않으면 만들 수가 없기 때문이다.
"""
import argparse
import json
import socket
import threading
import time

DEFAULT_CMD_PORT = 15100
DEFAULT_ACK_PORT = 15106


class FakeSdk:
    def __init__(self, cmd_port=DEFAULT_CMD_PORT, ack_host="127.0.0.1",
                 ack_port=DEFAULT_ACK_PORT, interval=1.0, robot_id="go1-fake"):
        self.cmd_port = cmd_port
        self.ack_addr = (ack_host, ack_port)
        self.interval = interval
        self.robot_id = robot_id
        self.tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.rx.bind(("0.0.0.0", cmd_port))
        self.cancel = threading.Event()
        self.running = False
        self.ack_seq = 0
        self.yaw = 0.0
        self.teleop_count = 0
        self.continue_upto = -1

    # ---------- ACK ----------
    def emit(self, event, step, total, note="ok"):
        self.ack_seq += 1
        msg = {
            "ack_seq": self.ack_seq, "robot_id": self.robot_id,
            "mission": "door_scan", "event": event,
            "step": step, "total": total,
            "yaw_deg": round(self.yaw, 2),
            "x": 0.0, "z": 0.0,
            "t_ms": round(time.time() * 1000, 1), "note": note,
        }
        self.tx.sendto(json.dumps(msg).encode(), self.ack_addr)
        print(f"  -> ACK #{self.ack_seq} {event} {step}/{total} "
              f"yaw={self.yaw:.1f} ({note})", flush=True)

    # ---------- 미션 ----------
    def _hold(self, captured, hold_s):
        """실물 SCAN_HOLD 와 같다 — CONTINUE(captured) 가 오거나 최후 시한까지 서 있는다.
        True 면 취소됐다."""
        if hold_s <= 0:
            return self.cancel.wait(self.interval)
        print(f"[미션] 촬영 {captured} 뒤 대기 (최후 시한 {hold_s:.0f}s)", flush=True)
        end = time.time() + hold_s
        while self.continue_upto < captured and time.time() < end:
            if self.cancel.wait(0.05):
                return True
        print(f"[미션] 촬영 {captured} 대기 해제 "
              f"({'CONTINUE' if self.continue_upto >= captured else '최후 시한'})", flush=True)
        # 실물은 해제 뒤 회전하는 시간이 있다.
        return self.cancel.wait(self.interval)

    def run_scan(self, steps, step_deg, forward_m, hold_s=0.0):
        self.running = True
        self.cancel.clear()
        total_ack = steps + (1 if forward_m > 0 else 0)
        print(f"[미션] 스캔 {step_deg:.0f}도 x{steps}"
              f"{f' + 전진 {forward_m}m' if forward_m > 0 else ' (전진 없음)'}"
              f" — ACK {total_ack}건 예정", flush=True)
        try:
            for i in range(1, steps + 1):
                if self._hold(i - 1, hold_s):
                    print("[미션] 취소됨", flush=True)
                    return
                self.yaw = (self.yaw - step_deg) % 360.0     # 오른쪽 = 시계방향
                self.emit("scan_turn", i, steps)
            if forward_m > 0:
                # 실제로는 거리/속도만큼 걸린다. 흉내에서는 한 박자만 쉰다.
                if self.cancel.wait(self.interval):
                    print("[미션] 취소됨", flush=True)
                    return
                self.emit("forward", 1, 1,
                          f"ok odo={forward_m:.2f}m cmd={forward_m * 2:.2f}m")
        finally:
            self.running = False

    def run_turn(self, deg):
        self.running = True
        self.cancel.clear()
        print(f"[미션] 회전 {deg:+.0f}도 — ACK 1건 예정", flush=True)
        try:
            if self.cancel.wait(self.interval):
                print("[미션] 취소됨", flush=True)
                return
            # 실물과 같은 규약 — 오른쪽(시계)이 + 이고 yaw 는 그만큼 줄어든다.
            self.yaw = (self.yaw - deg) % 360.0
            self.emit("turn", 1, 1)
        finally:
            self.running = False

    def run_forward(self, distance_m):
        self.running = True
        self.cancel.clear()
        print(f"[미션] 전진만 {distance_m}m — ACK 1건 예정", flush=True)
        try:
            if self.cancel.wait(self.interval):
                print("[미션] 취소됨", flush=True)
                return
            self.emit("forward", 1, 1,
                      f"ok odo={distance_m:.2f}m cmd={distance_m * 2:.2f}m")
        finally:
            self.running = False

    # ---------- 수신 루프 ----------
    def serve(self):
        print(f"[fake-sdk] udp/{self.cmd_port} 대기 — ACK 는 "
              f"{self.ack_addr[0]}:{self.ack_addr[1]} 로. 단계 간격 {self.interval}초")
        print("           (로봇 없이 ACK 경로만 시험한다. go1-sdk 는 꺼져 있어야 한다)")
        while True:
            data, frm = self.rx.recvfrom(512)
            text = data.decode("utf-8", "replace").strip()

            if text.startswith("MISSION PING"):
                # 상위는 이 응답으로 "구동 브리지가 살아 있고 로봇 상태도 온다"를 판정한다.
                self.rx.sendto(b"MISSION PONG state=ok", frm)
                continue

            if text.startswith("MISSION CONTINUE"):
                parts = text.split()
                step = int(parts[2]) if len(parts) > 2 else -1
                self.continue_upto = max(self.continue_upto, step)
                print(f"[명령] CONTINUE {step}", flush=True)
                continue

            if text.startswith("MISSION CANCEL"):
                print("[명령] CANCEL", flush=True)
                self.cancel.set()
                continue

            if text.startswith("MISSION FORWARD"):
                if self.running:
                    print("[명령] FORWARD 무시 — 이미 진행 중", flush=True)
                    continue
                parts = text.split()
                d = float(parts[2]) if len(parts) > 2 else 1.0
                threading.Thread(target=self.run_forward, args=(d,),
                                 daemon=True).start()
                continue

            if text.startswith("MISSION TURN"):
                if self.running:
                    print("[명령] TURN 무시 — 이미 진행 중", flush=True)
                    continue
                parts = text.split()
                deg = float(parts[2]) if len(parts) > 2 else 45.0
                threading.Thread(target=self.run_turn, args=(deg,),
                                 daemon=True).start()
                continue

            if text.startswith("MISSION"):
                if self.running:
                    print("[명령] SCAN 무시 — 이미 진행 중", flush=True)
                    continue
                parts = text.split()
                steps = int(float(parts[2])) if len(parts) > 2 else 8
                deg = float(parts[3]) if len(parts) > 3 else 45.0
                fwd = float(parts[4]) if len(parts) > 4 else 1.0
                hold_s = float(parts[6]) if len(parts) > 6 else 0.0
                self.continue_upto = -1
                threading.Thread(target=self.run_scan, args=(steps, deg, fwd, hold_s),
                                 daemon=True).start()
                continue

            if text.startswith("MODE"):
                print(f"[명령] {text}", flush=True)
                continue

            # 텔레옵 스트림 — 개수만 센다(초당 20건이라 다 찍으면 로그가 묻힌다)
            self.teleop_count += 1
            if self.teleop_count % 100 == 1:
                print(f"[텔레옵] 수신 {self.teleop_count}건 (마지막: {text})", flush=True)


def main():
    ap = argparse.ArgumentParser(description="구동 브리지 흉내 (로봇 없이 ACK 시험)")
    ap.add_argument("--cmd-port", type=int, default=DEFAULT_CMD_PORT)
    ap.add_argument("--ack-host", default="127.0.0.1")
    ap.add_argument("--ack-port", type=int, default=DEFAULT_ACK_PORT)
    ap.add_argument("--interval", type=float, default=1.0,
                    help="단계 사이 간격(초). 실물은 회전 4초·직진 20초쯤 걸린다")
    ap.add_argument("--robot-id", default="go1-fake")
    args = ap.parse_args()

    sdk = FakeSdk(args.cmd_port, args.ack_host, args.ack_port,
                  args.interval, args.robot_id)
    try:
        sdk.serve()
    except KeyboardInterrupt:
        print("\n종료")


if __name__ == "__main__":
    main()
