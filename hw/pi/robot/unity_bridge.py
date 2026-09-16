# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — Unity 디지털트윈 브리지 (HW-R-06 명령 경로의 첫 실체)
=====================================================================
Unity 가상환경(My project1)이 계산한 경로·텔레옵을 받아 실제 Go1 을 구동하고,
로봇 상태를 Unity 로 되돌려 보낸다. 기존에 "SDK PC(pygui/C++ path follower)"가
하던 역할을 라즈베리파이가 대신한다. **Unity 쪽 코드는 건드리지 않는다** —
와이어 프로토콜을 유니티 소스에서 그대로 역추출해 맞췄다.

## 와이어 계약 (Unity 소스 기준)

    Unity ──UDP 15110──►  경로: JSON {"type":"go1_path","frame":"go1_local_start",...}
                          큰 경로: "CHUNK <path_id>/<total>/<idx> " 접두 분할
                          취소: "PATH_CANCEL" (텍스트)
    Unity ──UDP 15100──►  텔레옵: "vx vy wz estop" (ASCII, SDK 좌표계·클램프 적용됨)
                          "MODE 0|1", "YAW_CALIB <deg> 1 <inv> <legacy>"
    파이  ──UDP 15101──►  상태: "seq tms x z yaw vx vy wz estop mode"
                          yaw 는 **라디안** (Unity ParseStatePacket 이 그대로 저장)
                          mode 99 = 경로 완료 통지, 98 = PATH_CANCEL 처리 ACK
    파이  ──UDP 15102──►  명령 미러 "vx vy wz estop" (가상 Go1 동기화용, 선택)

상태·미러의 목적지 IP 는 마지막으로 패킷을 보낸 Unity 호스트로 자동 설정된다
(유니티에서 파이 IP 만 바꾸면 되고, 파이는 설정할 것이 없다).

## 좌표계

경로 프레임(go1_local_start): 경로 수신 순간의 로봇 위치가 원점, z=전방, x=우측,
yaw 0°=+z·90°=+x (시계방향 양수). Go1 오도메트리(x=전방, y=좌측, yaw 반시계 양수,
2026-09-01 실주행으로 필드 확정)와의 변환은 이 파일 안에서만 한다:

    go1_전방 = path_z ,  go1_좌측 = -path_x ,  go1_yaw = -path_yaw

## 구동 백엔드 — 교체형 (HW_UNITY_DRIVE)

    sim   기본. 속도 명령을 적분하는 가상 로봇 — 프로토콜·추종 로직을 실물 없이 검증
    go1   실로봇. Go1 내부 MQTT 의 조종 채널로 속도 명령 발행 + go1_link 오도메트리
          ⚠ 로봇이 실제로 움직인다. 기립 상태·주변 확보·사람 입회에서만 쓸 것.

## 안전장치 (백엔드와 무관하게 브리지 층에서 강제)

  - estop=1 즉시 정지·경로 폐기
  - 텔레옵 침묵 타임아웃(0.5s): 마지막 명령 후 무소식이면 0 속도 유지 명령
  - 속도 상한 재클램프 (Unity 도 하지만 신뢰하지 않는다)
  - 경로 추종 중 오도메트리 정지(링크 두절) 시 즉시 정지
"""
import json
import math
import os
import socket
import struct
import threading
import time

# ---------------- 설정 (환경변수로 덮어쓰기) ----------------
def _f(name, default):
    try:
        return float(os.environ.get("HW_" + name, default))
    except ValueError:
        return default

PORT_PATH = int(os.environ.get("HW_UNITY_PATH_PORT", 15110))
PORT_CMD = int(os.environ.get("HW_UNITY_CMD_PORT", 15100))
PORT_STATE = int(os.environ.get("HW_UNITY_STATE_PORT", 15101))
PORT_MIRROR = int(os.environ.get("HW_UNITY_MIRROR_PORT", 15102))
DRIVE = os.environ.get("HW_UNITY_DRIVE", "sim")          # sim | go1

MAX_VX = _f("UNITY_MAX_VX", 0.4)
MAX_VY = _f("UNITY_MAX_VY", 0.3)
MAX_WZ = _f("UNITY_MAX_WZ", 1.2)
TELEOP_TIMEOUT = _f("UNITY_TELEOP_TIMEOUT", 0.5)
STATE_HZ = _f("UNITY_STATE_HZ", 20.0)
CTRL_HZ = _f("UNITY_CTRL_HZ", 20.0)
# 추종 제어 이득 — 회전 우선(사족은 제자리 회전이 정확), 전진은 정면일 때만 가속
K_YAW = _f("UNITY_K_YAW", 1.8)
HEAD_GATE_DEG = _f("UNITY_HEAD_GATE", 35.0)   # 목표 방위 오차가 이보다 크면 전진 억제


# ---------------- 구동 백엔드 ----------------
class SimDrive:
    """속도 명령을 적분하는 가상 로봇. 프로토콜·추종 검증용."""

    def __init__(self):
        self.x = 0.0        # 전방(+)
        self.y = 0.0        # 좌측(+)
        self.yaw = 0.0      # 라디안, 반시계(+)
        self._t = time.time()
        self._vx = self._vy = self._wz = 0.0

    def command(self, vx, vy, wz):
        now = time.time()
        dt = min(now - self._t, 0.2)
        self._t = now
        # 이전 명령으로 적분 후 새 명령 저장 (1스텝 지연 — 실물의 반응 지연 흉내)
        c, s = math.cos(self.yaw), math.sin(self.yaw)
        self.x += (self._vx * c - self._vy * s) * dt
        self.y += (self._vx * s + self._vy * c) * dt
        self.yaw += self._wz * dt
        self._vx, self._vy, self._wz = vx, vy, wz

    def pose(self):
        return self.x, self.y, self.yaw

    def velocity(self):
        return self._vx, self._vy, self._wz

    def healthy(self):
        return True

    def close(self):
        pass


class Go1Drive:
    """실 Go1. 속도 명령은 Unitree Legged SDK HighCmd 로(로봇에서 도는 hw_highcmd_daemon
    에 stdin 스트리밍), 오도메트리는 go1_link 로 읽는다.

    ⚠ HighCmd 는 HIGHLEVEL 로 sport mode 를 제어한다 — 로봇이 실제로 움직인다.
    기립·주변 확보·입회 조건에서만 쓸 것. 데몬은 무입력 0.4초에 자동 정지한다.

    배율(2026-09-01 실측): 명령 vx 0.2→실제 0.256 m/s(×1.28), wz 0.3→0.244 rad/s(×0.81).
    브리지는 '원하는 실제 m/s' 로 지령하므로 데몬에 보낼 값은 원하는값÷배율이다.
    """

    def __init__(self):
        from robot.go1_link import Go1Link
        self.link = Go1Link()
        # 원하는 실제속도 → HighCmd 지령값 환산 (실측 역배율)
        self.vx_gain = _f("GO1_VX_GAIN", 1.0 / 1.28)
        self.vy_gain = _f("GO1_VY_GAIN", 1.0 / 1.28)   # 횡이동 미측정 — 전진값 잠정 사용
        self.wz_gain = _f("GO1_WZ_GAIN", 1.0 / 0.81)
        self._vx = self._vy = self._wz = 0.0
        self._proc = None                     # 지연 개시 — 첫 command 전까지 로봇 무개입

    def _start_daemon(self):
        """로봇 위 hw_highcmd_daemon 에 ssh 로 stdin 파이프를 연다.
        파이는 이미 로봇에 무암호 ssh 키가 있다(워치독용). 로봇 IP 는 go1_link 호스트."""
        import subprocess
        host = os.environ.get("HW_GO1_SSH", "pi@192.168.123.161")
        remote = os.environ.get("HW_GO1_DAEMON", "/home/pi/hw_highcmd_daemon")
        return subprocess.Popen(
            ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
             "-o", "ServerAliveInterval=2", host, remote],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL)

    def command(self, vx, vy, wz):
        self._vx, self._vy, self._wz = vx, vy, wz
        if self._proc is None:
            # 첫 명령이 오는 순간에만 HighCmd 데몬을 연다(= 제어권 인수).
            # 그 전까지 로봇은 자기 sport mode 그대로 — 브리지를 띄워도 무개입.
            self._proc = self._start_daemon()
            time.sleep(0.3)
        gvx = vx * self.vx_gain
        gvy = vy * self.vy_gain
        gwz = wz * self.wz_gain
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.stdin.write(f"{gvx:.4f} {gvy:.4f} {gwz:.4f}\n".encode())
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

    def pose(self):
        st = self.link.read_state()          # 실주행 검증된 오도메트리 (x, y, m)
        return st.x, st.y, math.radians(st.heading_deg)

    def velocity(self):
        return self._vx, self._vy, self._wz

    def healthy(self):
        # 아직 데몬 안 열림(무개입 대기)도 정상으로 본다 — 경로 추종 게이트는 별도
        if self._proc is not None and self._proc.poll() is not None:
            return False
        return self.link.link_health() != "fault"

    def close(self):
        try:
            self.command(0, 0, 0)            # 마지막 정지 (데몬 워치독도 있지만 명시적으로)
            time.sleep(0.3)
        except Exception:
            pass
        try:
            if self._proc:
                self._proc.stdin.close()
                self._proc.terminate()
        except Exception:
            pass


def make_drive(kind):
    if kind == "sim":
        return SimDrive()
    if kind == "go1":
        return Go1Drive()
    raise SystemExit(f"HW_UNITY_DRIVE '{kind}' 미구현")


# ---------------- 브리지 본체 ----------------
class UnityBridge:
    def __init__(self, drive, log=print):
        self.drive = drive
        self.log = log
        self.seq = 0
        self.estop = False
        self.mode_flag = 0                    # "MODE n" 저장 (해석은 유니티 몫)
        self.pending_ack = 0                  # 98/99 를 상태 스트림에 실을 횟수
        self.unity_addr = None                # 마지막 송신자 IP — 상태 회신 목적지
        self._lock = threading.Lock()
        self._teleop = (0.0, 0.0, 0.0)
        self._teleop_at = 0.0
        self._path = None                     # 추종 중 경로 (dict)
        self._path_idx = 0
        self._armed = False                   # 첫 경로/텔레옵 전까지 로봇 무개입
        self._frame = None                    # (x0, y0, yaw0) — 경로 수신 순간 로봇 자세
        self._chunks = {}                     # path_id -> {idx: bytes}
        self._running = True

        self._tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._threads = [
            threading.Thread(target=self._serve, args=(PORT_PATH, self._on_path), daemon=True),
            threading.Thread(target=self._serve, args=(PORT_CMD, self._on_cmd), daemon=True),
            threading.Thread(target=self._control_loop, daemon=True),
            threading.Thread(target=self._state_loop, daemon=True),
        ]
        for t in self._threads:
            t.start()

    # ---------- 수신 ----------
    def _serve(self, port, handler):
        sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sk.bind(("0.0.0.0", port))
        sk.settimeout(0.5)
        self.log(f"[브리지] UDP {port} 대기")
        while self._running:
            try:
                data, addr = sk.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            self.unity_addr = addr[0]
            try:
                handler(data)
            except Exception as e:
                self.log(f"[브리지] {port} 처리 오류: {type(e).__name__}: {e}")
        sk.close()

    def _on_path(self, data):
        text = data.decode("utf-8", "replace").strip()
        if text == "PATH_CANCEL":
            with self._lock:
                self._path = None
            self.drive.command(0, 0, 0)
            self.pending_ack = max(self.pending_ack, 1)
            self._ack_mode = 98
            self.log("[브리지] PATH_CANCEL → 정지, mode=98 ACK 예약")
            return
        if text.startswith("CHUNK "):
            # "CHUNK <path_id>/<total>/<idx> <payload>"
            head, _, payload = text[6:].partition(" ")
            pid, total, idx = (int(v) for v in head.split("/"))
            buf = self._chunks.setdefault(pid, {})
            buf[idx] = payload
            if len(buf) == total:
                full = "".join(buf[i] for i in range(total))
                del self._chunks[pid]
                self._accept_path(full)
            return
        if text.startswith("{"):
            self._accept_path(text)

    def _accept_path(self, text):
        msg = json.loads(text)
        if msg.get("type") != "go1_path":
            return
        if self.estop:
            self.log("[브리지] estop 중 — 경로 거부")
            return
        x0, y0, yaw0 = self.drive.pose()
        with self._lock:
            self._frame = (x0, y0, yaw0)      # go1_local_start 원점 = 지금 자세
            self._path = msg
            self._path_idx = 0
        self._armed = True
        pts = msg.get("points", [])
        self.log(f"[브리지] 경로 수신 id={msg.get('path_id')} {len(pts)}점 "
                 f"tol={msg.get('position_tolerance')}m v={msg.get('default_speed')}m/s")

    def _on_cmd(self, data):
        text = data.decode("utf-8", "replace").strip()
        if text.startswith("MODE "):
            self.mode_flag = int(text.split()[1])
            self.log(f"[브리지] MODE {self.mode_flag}")
            return
        if text.startswith("YAW_CALIB"):
            self.log(f"[브리지] {text} (기록만 — 좌표 보정은 Unity Mapper 몫)")
            return
        parts = text.split()
        if len(parts) < 4:
            return
        vx, vy, wz = (float(v) for v in parts[:3])
        estop = int(parts[3])
        if estop:
            self._do_estop("unity_estop")
            return
        self.estop = False
        with self._lock:
            self._teleop = (self._clamp(vx, MAX_VX), self._clamp(vy, MAX_VY),
                            self._clamp(wz, MAX_WZ))
            self._teleop_at = time.time()
            if any(self._teleop):
                self._armed = True

    @staticmethod
    def _clamp(v, m):
        return max(-m, min(m, v))

    def _do_estop(self, why):
        self.estop = True
        with self._lock:
            self._path = None
            self._teleop = (0.0, 0.0, 0.0)
        self.drive.command(0, 0, 0)
        self.log(f"[브리지] ESTOP ({why}) — 정지·경로 폐기")

    # ---------- 좌표 변환 ----------
    def _path_to_robot(self, px, pz):
        """경로 프레임(z전방·x우측) 점 → 로봇 오도메트리 프레임(월드) 점."""
        fx, fy, fyaw = self._frame
        gx, gy = pz, -px                      # go1 로컬(전방, 좌측)
        c, s = math.cos(fyaw), math.sin(fyaw)
        return fx + gx * c - gy * s, fy + gx * s + gy * c

    # ---------- 제어 루프 ----------
    def _control_loop(self):
        period = 1.0 / CTRL_HZ
        while self._running:
            time.sleep(period)
            if self.estop:
                continue
            try:
                self._control_step()
            except Exception as e:
                self.log(f"[브리지] 제어 오류: {type(e).__name__}: {e} — 정지")
                self.drive.command(0, 0, 0)

    def _control_step(self):
        with self._lock:
            path = self._path
            teleop, teleop_at = self._teleop, self._teleop_at

        # 무장 전(첫 경로/텔레옵 도착 전)에는 로봇을 건드리지 않는다 —
        # 브리지가 떠 있어도 로봇은 자기 제어 그대로. "가"의 실체가 이 첫 입력이다.
        if not self._armed:
            return

        # 텔레옵이 최근이면 텔레옵 우선 (경로 추종보다 사람이 우선)
        if time.time() - teleop_at < TELEOP_TIMEOUT and any(teleop):
            self.drive.command(*teleop)
            self._mirror(*teleop)
            return

        if path is None:
            self.drive.command(0, 0, 0)      # 침묵 = 정지 유지 (안전 기본값)
            return

        if not self.drive.healthy():
            self.log("[브리지] 오도메트리 두절 — 경로 정지")
            self._do_estop("odometry_lost")
            return

        pts = path["points"]
        if self._path_idx >= len(pts):
            return
        pt = pts[self._path_idx]
        tx, ty = self._path_to_robot(pt["x"], pt["z"])
        rx, ry, ryaw = self.drive.pose()
        dx, dy = tx - rx, ty - ry
        dist = math.hypot(dx, dy)
        tol = float(path.get("position_tolerance", 0.10))
        speed = self._clamp(float(path.get("default_speed", 0.15)), MAX_VX)

        if dist <= tol:
            # 도달 — 마지막 점이면 최종 yaw 정렬(요청 시) 후 완료
            if self._path_idx == len(pts) - 1:
                if pt.get("use_yaw") and not self._final_yaw_ok(pt, path):
                    self._turn_to_final_yaw(pt)
                    return
                self.drive.command(0, 0, 0)
                with self._lock:
                    self._path = None
                self._ack_mode = 99
                self.pending_ack = max(self.pending_ack, 3)
                self.log(f"[브리지] 경로 완료 (id={path.get('path_id')}) → mode=99")
            else:
                self._path_idx += 1
            return

        # 방위 오차 → 회전 우선, 정면 근처에서만 전진
        bearing = math.atan2(dy, dx)
        err = self._norm(bearing - ryaw)
        wz = self._clamp(K_YAW * err, MAX_WZ)
        vx = speed if abs(err) < math.radians(HEAD_GATE_DEG) else 0.0
        self.drive.command(vx, 0.0, wz)
        self._mirror(vx, 0.0, wz)

    def _final_yaw_ok(self, pt, path):
        _, _, ryaw = self.drive.pose()
        target = self._frame[2] - math.radians(pt["yaw_deg"])
        tol = math.radians(float(path.get("yaw_tolerance_deg", 8.0)))
        return abs(self._norm(target - ryaw)) <= tol

    def _turn_to_final_yaw(self, pt):
        _, _, ryaw = self.drive.pose()
        target = self._frame[2] - math.radians(pt["yaw_deg"])
        err = self._norm(target - ryaw)
        self.drive.command(0, 0, self._clamp(K_YAW * err, MAX_WZ))

    @staticmethod
    def _norm(a):
        while a > math.pi:
            a -= 2 * math.pi
        while a < -math.pi:
            a += 2 * math.pi
        return a

    # ---------- 송신 ----------
    _ack_mode = 0

    def _state_loop(self):
        period = 1.0 / STATE_HZ
        while self._running:
            time.sleep(period)
            if self.unity_addr is None:
                continue
            try:
                x, y, yaw = self.drive.pose()
            except Exception:
                continue
            vx, vy, wz = self.drive.velocity()
            mode = 0
            if self.pending_ack > 0:
                mode = self._ack_mode
                self.pending_ack -= 1
            self.seq += 1
            # Unity ParseStatePacket: seq tms x z yaw(rad) vx vy wz estop mode
            # x=전방축, z=좌표계 두 번째 축 — Unity Mapper 가 축 방향을 보정하므로
            # 파이는 오도메트리를 가공 없이 일관되게만 보낸다.
            msg = (f"{self.seq} {time.time()*1000:.0f} {x:.4f} {y:.4f} {yaw:.5f} "
                   f"{vx:.3f} {vy:.3f} {wz:.3f} {1 if self.estop else 0} {mode}")
            try:
                self._tx.sendto(msg.encode(), (self.unity_addr, PORT_STATE))
            except OSError:
                pass

    def _mirror(self, vx, vy, wz):
        if self.unity_addr is None:
            return
        try:
            self._tx.sendto(f"{vx:.3f} {vy:.3f} {wz:.3f} {1 if self.estop else 0}".encode(),
                            (self.unity_addr, PORT_MIRROR))
        except OSError:
            pass

    def close(self):
        self._running = False
        self.drive.close()


def main():
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    drive = make_drive(DRIVE)
    print(f"[브리지] 구동 백엔드: {DRIVE}"
          + (" ⚠ 실로봇 — 기립·주변 확보·입회 확인" if DRIVE == "go1" else " (가상)"))
    b = UnityBridge(drive)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        b.close()


if __name__ == "__main__":
    main()
