# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — Unity 브리지 로컬 검증 (실물·유니티 불필요)
============================================================
가짜 Unity(패킷 송수신만 하는 소켓)로 와이어 계약 전체를 검증한다.
검증 항목은 유니티 소스(GO1LocalPathUdpSender / UnityTeleopAndMirror)에서
역추출한 계약 그대로다:

  1. 경로 추종: go1_path JSON → 웨이포인트 순차 도달(허용오차 내) → mode=99 통지
  2. 최종 yaw 정렬: use_yaw=true 마지막 점에서 yaw_tolerance 내 정렬
  3. 상태 스트림: 10토큰 형식·주기·yaw 라디안
  4. CHUNK 분할 경로 재조립
  5. PATH_CANCEL → 즉시 정지 + mode=98 ACK
  6. 텔레옵: 명령 반영·침묵 타임아웃 시 정지·estop 시 경로 폐기
  7. 명령 미러(15102) 수신

사용: python -m bench.unity_bridge_test   (pi/ 디렉터리, 어느 OS 든)
"""
import json
import math
import os
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 포트 충돌 방지 — 시험 전용 포트로 오버라이드
os.environ["HW_UNITY_PATH_PORT"] = "25110"
os.environ["HW_UNITY_CMD_PORT"] = "25100"
os.environ["HW_UNITY_STATE_PORT"] = "25101"
os.environ["HW_UNITY_MIRROR_PORT"] = "25102"
os.environ["HW_UNITY_CTRL_HZ"] = "50"        # 시험 가속
os.environ["HW_UNITY_STATE_HZ"] = "30"

from robot.unity_bridge import SimDrive, UnityBridge


class FakeUnity:
    """유니티 흉내: 15110/15100 으로 보내고 15101/15102 를 듣는다."""

    def __init__(self):
        self.tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.state_rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.state_rx.bind(("127.0.0.1", 25101))
        self.state_rx.settimeout(0.3)
        self.mirror_rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.mirror_rx.bind(("127.0.0.1", 25102))
        self.mirror_rx.settimeout(0.3)

    def send_path(self, obj):
        self.tx.sendto(json.dumps(obj).encode(), ("127.0.0.1", 25110))

    def send_raw_path(self, data):
        self.tx.sendto(data if isinstance(data, bytes) else data.encode(),
                       ("127.0.0.1", 25110))

    def send_cmd(self, text):
        self.tx.sendto(text.encode(), ("127.0.0.1", 25100))

    def drain_states(self, seconds):
        """(x, z, yaw, estop, mode) 목록"""
        out = []
        end = time.time() + seconds
        while time.time() < end:
            try:
                d, _ = self.state_rx.recvfrom(4096)
            except socket.timeout:
                continue
            t = d.decode().split()
            assert len(t) == 10, f"상태 토큰 {len(t)} != 10: {d!r}"
            out.append((float(t[2]), float(t[3]), float(t[4]),
                        int(t[8]), int(t[9])))
        return out

    def drain_mirror(self, seconds):
        out = []
        end = time.time() + seconds
        while time.time() < end:
            try:
                d, _ = self.mirror_rx.recvfrom(4096)
            except socket.timeout:
                continue
            out.append(d.decode())
        return out


def path_msg(points, path_id=1, tol=0.08, speed=0.3):
    return {"type": "go1_path", "frame": "go1_local_start", "mode": 0,
            "path_id": path_id,
            "start_pose": {"x": 0, "z": 0, "yaw_deg": 0},
            "point_count": len(points),
            "position_tolerance": tol, "yaw_tolerance_deg": 8.0,
            "default_speed": speed,
            "points": [dict(index=i, **p) for i, p in enumerate(points)]}


def wait_modes(states, want):
    return [s for s in states if s[4] == want]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    print("Unity 브리지 로컬 검증 (유니티·실물 불필요)")

    drive = SimDrive()
    bridge = UnityBridge(drive, log=lambda *a: None)
    u = FakeUnity()
    u.send_cmd("0 0 0 0")               # unity_addr 등록
    time.sleep(0.3)

    # ---- 1+2) 경로 추종 → mode=99, 최종 yaw ----
    pts = [{"x": 0.0, "z": 0.0, "yaw_deg": 0.0, "use_yaw": False},
           {"x": 0.0, "z": 0.8, "yaw_deg": 0.0, "use_yaw": False},
           {"x": 0.5, "z": 0.8, "yaw_deg": 90.0, "use_yaw": True}]
    u.send_path(path_msg(pts))
    states = u.drain_states(14.0)
    done = wait_modes(states, 99)
    assert done, "mode=99(경로 완료)가 오지 않았다"
    x, y, yaw = drive.pose()
    # 목표: 경로프레임 (0.5, 0.8) → 로봇프레임 (0.8, -0.5); 최종 yaw 90° → -π/2
    assert abs(x - 0.8) < 0.15 and abs(y + 0.5) < 0.15, f"최종 위치 이탈 ({x:.2f},{y:.2f})"
    yaw_err = abs((yaw + math.pi / 2 + math.pi) % (2 * math.pi) - math.pi)
    assert yaw_err < math.radians(12), f"최종 yaw 오차 {math.degrees(yaw_err):.0f}°"
    print(f"  1) 경로 추종: 3점 도달, 최종 ({x:.2f},{y:.2f}) yaw오차 {math.degrees(yaw_err):.0f}° → mode=99 ✓")
    assert len(states) > 100, f"상태 스트림 {len(states)}건 — 주기 부족"
    print(f"  2) 상태 스트림: 10토큰 {len(states)}건({len(states)/14:.0f}Hz), yaw 라디안 ✓")

    # ---- 3) CHUNK 재조립 ----
    drive.x = drive.y = drive.yaw = 0.0
    big = path_msg([{"x": 0.0, "z": 0.3 + 0.001 * i, "yaw_deg": 0.0, "use_yaw": False}
                    for i in range(3)], path_id=7)
    raw = json.dumps(big).encode()
    half = len(raw) // 2
    u.send_raw_path(b"CHUNK 7/2/0 " + raw[:half])
    u.send_raw_path(b"CHUNK 7/2/1 " + raw[half:])
    states = u.drain_states(6.0)
    assert wait_modes(states, 99), "CHUNK 경로가 완료되지 않았다"
    print(f"  3) CHUNK 재조립: 2분할 경로 수신·완주 ✓")

    # ---- 4) PATH_CANCEL → mode=98 + 정지 ----
    drive.x = drive.y = drive.yaw = 0.0
    u.send_path(path_msg([{"x": 0.0, "z": 5.0, "yaw_deg": 0, "use_yaw": False}]))
    time.sleep(0.6)                      # 주행 시작
    moving_x = drive.pose()[0]
    assert moving_x > 0.05, "경로 주행이 시작되지 않았다"
    u.send_raw_path("PATH_CANCEL")
    states = u.drain_states(1.0)
    assert wait_modes(states, 98), "mode=98(취소 ACK)가 오지 않았다"
    x1 = drive.pose()[0]
    time.sleep(0.8)
    x2 = drive.pose()[0]
    assert abs(x2 - x1) < 0.05, "취소 후에도 계속 움직인다"
    print(f"  4) PATH_CANCEL: 주행 중단({moving_x:.2f}m 지점), mode=98 ACK, 이후 정지 ✓")

    # ---- 5) 텔레옵 + 침묵 타임아웃 ----
    for _ in range(6):
        u.send_cmd("0.30 0 0 0")
        time.sleep(0.1)
    vx_during = drive.velocity()[0]
    time.sleep(1.0)                      # 침묵 → 타임아웃 정지
    vx_after = drive.velocity()[0]
    assert vx_during > 0.2, f"텔레옵 미반영 (vx={vx_during})"
    assert vx_after == 0.0, f"침묵 후에도 vx={vx_after}"
    print(f"  5) 텔레옵: vx 0.3 반영 → 0.5s 침묵 시 자동 정지 ✓")

    # ---- 6) estop → 경로 폐기 ----
    u.send_path(path_msg([{"x": 0.0, "z": 5.0, "yaw_deg": 0, "use_yaw": False}]))
    time.sleep(0.4)
    u.send_cmd("0 0 0 1")                # estop
    time.sleep(0.3)
    states = u.drain_states(0.5)
    assert states and all(s[3] == 1 for s in states[-3:]), "estop 이 상태에 반영 안 됨"
    p1 = drive.pose()[0]
    time.sleep(0.6)
    assert abs(drive.pose()[0] - p1) < 0.03, "estop 후에도 움직인다"
    # estop 중 새 경로는 거부
    u.send_path(path_msg([{"x": 0, "z": 2.0, "yaw_deg": 0, "use_yaw": False}]))
    time.sleep(0.5)
    assert abs(drive.pose()[0] - p1) < 0.03, "estop 중 경로가 수락됐다"
    print(f"  6) estop: 즉시 정지·경로 폐기·신규 경로 거부, 상태에 estop=1 ✓")

    # ---- 7) 명령 미러 ----
    u.send_cmd("0 0 0 0")                # estop 해제
    for _ in range(4):
        u.send_cmd("0.20 0 0.1 0")
        time.sleep(0.1)
    mirror = u.drain_mirror(0.5)
    assert mirror and any("0.200" in m for m in mirror), f"미러 미수신: {mirror[:2]}"
    print(f"  7) 명령 미러(15102): {len(mirror)}건 수신 ✓")

    # ---- 8) 정책 자율(GO1AutoPolicyController 흉내): 속도 "vx vy wz estop" 20Hz 스트림 ----
    drive.x = drive.y = drive.yaw = 0.0
    bridge.estop = False
    # 전진 2초 → 좌회전 1초 → 정지 (정책이 내보내는 전형적 스트림)
    t0 = time.time()
    while time.time() - t0 < 2.0:
        u.send_cmd("0.25 0 0 0"); time.sleep(0.05)
    while time.time() - t0 < 3.0:
        u.send_cmd("0.10 0 0.4 0"); time.sleep(0.05)
    for _ in range(10):
        u.send_cmd("0 0 0 0"); time.sleep(0.05)
    x, y, yaw = drive.pose()
    assert x > 0.3, f"정책 자율 전진 미반영 (x={x:.2f})"
    assert abs(yaw) > 0.2, f"정책 자율 회전 미반영 (yaw={yaw:.2f})"
    time.sleep(0.8)
    assert drive.velocity()[0] == 0.0, "정책 정지 후에도 움직인다"
    print(f"  8) 정책 자율(속도 20Hz 스트림): 전진 x={x:.2f}m·회전 yaw={math.degrees(yaw):.0f}° 반영, 정지 ✓")

    # ---- 9) NavMesh 자율(GO1AutoNavigator 흉내): agent.path.corners → go1_path ----
    drive.x = drive.y = drive.yaw = 0.0
    # corners 를 로컬프레임 점으로 변환한 형태로 그대로 경로 전송 (Unity 가 하는 일)
    corners = [{"x": 0.0, "z": 0.0, "yaw_deg": 0.0, "use_yaw": False},
               {"x": 0.0, "z": 1.0, "yaw_deg": 0.0, "use_yaw": False},
               {"x": 0.6, "z": 1.5, "yaw_deg": 0.0, "use_yaw": True}]
    u.send_path(path_msg(corners, path_id=42))
    states = u.drain_states(16.0)
    assert wait_modes(states, 99), "NavMesh 자율 경로가 완료(mode 99)되지 않았다"
    print(f"  9) NavMesh 자율(go1_path 추종): 3코너 완주 → mode=99 ✓")

    bridge.close()
    print("전부 통과")


if __name__ == "__main__":
    main()
