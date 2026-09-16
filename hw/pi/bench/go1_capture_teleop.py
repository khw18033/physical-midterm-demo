# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — Go1 정면 촬영(10fps) + WASD/QE 조작 (HW-R-06 / HW-R-07)
========================================================================
정면 카메라를 초당 10장 JPEG 로 파이에 저장하면서, 같은 터미널에서 로봇을 몬다.

    python3 -m bench.go1_capture_teleop              (pi/ 디렉터리에서)

  W/S 전진·후진   A/D 좌·우 횡이동   Q/E 좌·우 회전   Space/X 정지   ESC 종료

## 왜 이런 구조인가

**카메라: 로봇을 건드리지 않는다.** Go1 의 `imageai` 가 이미 웹소켓으로 H.264 를
상시 내보내고 있어(정면 = 192.168.123.13:9101) 거기 클라이언트로 붙기만 한다.
`robot/go1_camera.py` 의 소스를 그대로 재사용한다 — 카메라를 직접 열면 USB 재열거로
로봇의 인식 파이프라인이 죽는다(그 파일의 경고 참조).

**디코드·저장: ffmpeg 에 맡긴다.** 받은 H.264 를 파이프로 흘려 넣고 `fps=10` 으로
솎아 JPEG 로 떨군다. 파이썬에서 프레임을 세어 직접 뽑는 것보다 정확하고(원본이
약 29fps 라 3프레임에 1장 꼴), CPU 도 덜 쓴다.

**조작: SDK 에 UDP 로 보낸다.** 실제 구동은 `go1_sdk_pc`(C++ 500Hz)가 한다.
그 프로그램에도 WASD 가 있지만 **서비스로 돌 때는 표준입력이 없어 키가 안 먹는다.**
그래서 여기서는 계약된 텔레옵 포트(15100)로 보낸다 — go1-sdk 를 서비스로 켜 둔 채
촬영과 조작을 같이 할 수 있다.

    "MODE 1"          한 번 — SDK 를 외부 명령 모드로 전환
    "<vx> <vy> <wz> <estop>"   20Hz 로 계속 — SDK 는 0.15초 안 오면 정지로 본다

## 저장물

    <out>/frame_000001.jpg ...   10fps JPEG
    <out>/session.json           시작 시각·카메라·fps·속도 상한
    <out>/teleop_log.csv         ts_unix, vx, vy, wz, estop  (명령이 바뀔 때마다)

프레임의 절대 시각은 `session.json` 의 started_at + (n-1)/fps 로 본다. ffmpeg 가
일정 간격으로 솎기 때문에 이 근사가 맞고, 조작 로그는 절대 시각이라 둘을 맞출 수 있다.
"""
import argparse
import json
import os
import select
import signal
import socket
import subprocess
import sys
import termios
import threading
import time
import tty

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from robot.go1_camera import Go1CameraSource       # noqa: E402

# 속도 하드 상한 — 인자로 뭘 주든 이 이상은 안 나간다. 사람이 옆에서 키로 모는
# 상황이라 실수 한 번이 로봇을 벽으로 보낸다.
VX_LIMIT, VY_LIMIT, WZ_LIMIT = 0.35, 0.25, 1.00

HELP = """W/S 전진·후진   A/D 좌·우 횡이동   Q/E 좌·우 회전   Space/X 정지   ESC 종료"""


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


class Teleop:
    """키 입력을 go1_sdk_pc 의 텔레옵 포트로 흘린다.

    키를 누르고 있으면 터미널이 자동 반복을 보내준다. 그 반복이 끊긴 뒤 hold 초가
    지나면 정지로 돌린다 — SDK 쪽도 같은 방식(0.15초 무입력이면 정지)이라 서로 맞는다.
    """

    def __init__(self, host="127.0.0.1", port=15100, vx=0.20, vy=0.15, wz=0.60,
                 hold=0.30, rate=20.0, log_path=None):
        self.addr = (host, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.vx_cmd = clamp(vx, 0, VX_LIMIT)
        self.vy_cmd = clamp(vy, 0, VY_LIMIT)
        self.wz_cmd = clamp(wz, 0, WZ_LIMIT)
        self.hold = hold
        self.interval = 1.0 / rate
        self.cur = (0.0, 0.0, 0.0, 0)
        self.last_key_at = 0.0
        self.lock = threading.Lock()
        self.stop_flag = threading.Event()
        self.log = open(log_path, "w", encoding="utf-8") if log_path else None
        if self.log:
            self.log.write("ts_unix,vx,vy,wz,estop\n")
        self.sent = 0

    def start(self):
        # SDK 를 외부 명령 모드로. 이걸 안 보내면 우리가 보낸 속도가 무시된다.
        self.sock.sendto(b"MODE 1", self.addr)
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        while not self.stop_flag.is_set():
            with self.lock:
                vx, vy, wz, es = self.cur
                if vx or vy or wz:
                    if time.time() - self.last_key_at > self.hold:
                        self.cur = (0.0, 0.0, 0.0, 0)
                        vx = vy = wz = 0.0
                        self._note(0, 0, 0, 0)
            self.sock.sendto(f"{vx:.3f} {vy:.3f} {wz:.3f} {es}".encode(), self.addr)
            self.sent += 1
            time.sleep(self.interval)

    def _note(self, vx, vy, wz, es):
        if self.log:
            self.log.write(f"{time.time():.3f},{vx:.3f},{vy:.3f},{wz:.3f},{es}\n")
            self.log.flush()

    def key(self, c):
        """키 하나를 명령으로. 알 수 없는 키는 무시한다(무시가 정지보다 안전하다 —
        오타 한 번에 로봇이 멈칫거리면 조작감이 무너진다)."""
        vx = vy = wz = 0.0
        es = 0
        if   c in "wW": vx = +self.vx_cmd
        elif c in "sS": vx = -self.vx_cmd
        elif c in "aA": vy = +self.vy_cmd          # 좌(+) — C++ WASD 와 같은 부호
        elif c in "dD": vy = -self.vy_cmd
        elif c in "qQ": wz = +self.wz_cmd          # 좌회전(반시계+)
        elif c in "eE": wz = -self.wz_cmd
        elif c in (" ", "x", "X"): es = 1          # 즉시 정지
        else: return None
        with self.lock:
            self.cur = (vx, vy, wz, es)
            self.last_key_at = time.time()
        self._note(vx, vy, wz, es)
        return (vx, vy, wz, es)

    def close(self):
        self.stop_flag.set()
        time.sleep(0.1)
        # 정지 프레임을 여러 번 보내고 SDK 를 원래(키보드) 모드로 돌려놓는다.
        for _ in range(10):
            self.sock.sendto(b"0.000 0.000 0.000 0", self.addr)
            time.sleep(0.02)
        self.sock.sendto(b"MODE 0", self.addr)
        if self.log:
            self.log.close()

    def sdk_alive(self, timeout=1.0):
        """go1_sdk_pc 가 떠 있는지. 없으면 키를 눌러도 아무 일도 안 일어난다."""
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(timeout)
            s.sendto(b"MISSION PING", self.addr)
            return s.recvfrom(64)[0].startswith(b"MISSION PONG")
        except OSError:
            return False
        finally:
            s.close()


class Capture:
    """Go1 정면 H.264 -> ffmpeg -> 10fps JPEG."""

    def __init__(self, out_dir, cam_id=1, fps=10, quality=3, host=None, port=None):
        self.out_dir = out_dir
        self.cam_id = cam_id
        self.fps = fps
        self.quality = quality
        self.host, self.port = host, port
        self.stop_flag = threading.Event()
        self.bytes_in = 0
        self.error = None

    def start(self):
        os.makedirs(self.out_dir, exist_ok=True)
        self.ff = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             # 원시 H.264 에는 타임스탬프가 없다. 그대로 두면 ffmpeg 가 입력을 25fps 로
             # 가정하는데 실제 스트림은 약 29fps 라, fps=10 이 실제로는 11.8fps 가 된다
             # (실측 2026-09-10). 도착 시각을 타임스탬프로 삼으면 원본 fps 가 흔들려도
             # 결과가 실시간 기준 10fps 로 맞는다.
             "-f", "h264", "-use_wallclock_as_timestamps", "1", "-i", "pipe:0",
             "-vf", f"fps={self.fps}",
             "-q:v", str(self.quality),
             "-f", "image2", os.path.join(self.out_dir, "frame_%06d.jpg")],
            stdin=subprocess.PIPE)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        try:
            with Go1CameraSource(self.cam_id, host=self.host, port=self.port) as src:
                for chunk in src:
                    if self.stop_flag.is_set():
                        break
                    self.bytes_in += len(chunk)
                    try:
                        self.ff.stdin.write(chunk)
                    except (BrokenPipeError, ValueError):
                        break
        except Exception as e:                     # 카메라가 없거나 중간에 끊긴 경우
            self.error = f"{type(e).__name__}: {e}"

    def frame_count(self):
        try:
            return sum(1 for f in os.listdir(self.out_dir) if f.endswith(".jpg"))
        except OSError:
            return 0

    def close(self):
        self.stop_flag.set()
        try:
            self.ff.stdin.close()
        except Exception:
            pass
        try:
            self.ff.wait(timeout=5)
        except Exception:
            self.ff.kill()


def main():
    ap = argparse.ArgumentParser(description="Go1 정면 10fps 촬영 + WASD/QE 조작")
    ap.add_argument("--out", default=None,
                    help="저장 디렉터리 (기본 ~/captures/<날짜시각>)")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--cam", type=int, default=1, help="1=정면 2=턱 3=좌 4=우 5=복부")
    ap.add_argument("--quality", type=int, default=3, help="JPEG 품질 2(최고)~31(최저)")
    ap.add_argument("--vx", type=float, default=0.20, help=f"전진 속도 m/s (상한 {VX_LIMIT})")
    ap.add_argument("--vy", type=float, default=0.15, help=f"횡이동 m/s (상한 {VY_LIMIT})")
    ap.add_argument("--wz", type=float, default=0.60, help=f"회전 rad/s (상한 {WZ_LIMIT})")
    ap.add_argument("--sdk-host", default="127.0.0.1")
    ap.add_argument("--sdk-port", type=int, default=15100)
    ap.add_argument("--no-teleop", action="store_true", help="촬영만 한다")
    ap.add_argument("--no-capture", action="store_true", help="조작만 한다")
    args = ap.parse_args()

    out = args.out or os.path.expanduser(
        time.strftime("~/captures/%Y%m%d-%H%M%S"))
    out = os.path.expanduser(out)

    cap = tel = None
    started = time.time()
    # 촬영을 끄고 조작만 해도 조작 로그는 남는다 — 디렉터리를 먼저 만든다.
    os.makedirs(out, exist_ok=True)

    if not args.no_capture:
        cap = Capture(out, cam_id=args.cam, fps=args.fps, quality=args.quality)
        cap.start()
        with open(os.path.join(out, "session.json"), "w", encoding="utf-8") as f:
            json.dump({"started_at": started,
                       "started_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S",
                                                       time.localtime(started)),
                       "camera": args.cam, "fps": args.fps,
                       "jpeg_quality": args.quality,
                       "speed": {"vx": args.vx, "vy": args.vy, "wz": args.wz},
                       "note": "프레임 n 의 시각 = started_at + (n-1)/fps (근사)"},
                      f, ensure_ascii=False, indent=2)

    if not args.no_teleop:
        tel = Teleop(args.sdk_host, args.sdk_port, args.vx, args.vy, args.wz,
                     log_path=os.path.join(out, "teleop_log.csv"))
        if not tel.sdk_alive():
            print("[경고] go1_sdk_pc 응답 없음 — 키를 눌러도 로봇은 움직이지 않는다.")
            print("       sudo systemctl start go1-sdk  로 켤 것.")
        tel.start()

    print(f"저장 위치: {out}")
    print(HELP)
    print("(촬영은 계속되고, 키를 놓으면 로봇은 멈춘다)")

    stop = threading.Event()
    # SIGTERM 도 받는다 — timeout/systemctl 로 끊길 때도 정지 프레임과 MODE 0 을
    # 보내고 나가야 SDK 가 외부 명령 모드에 남지 않는다.
    signal.signal(signal.SIGINT, lambda *a: stop.set())
    signal.signal(signal.SIGTERM, lambda *a: stop.set())

    fd = sys.stdin.fileno()
    old = None
    try:
        if sys.stdin.isatty():
            old = termios.tcgetattr(fd)
            tty.setcbreak(fd)
        last_report = 0.0
        while not stop.is_set():
            if sys.stdin.isatty() and select.select([sys.stdin], [], [], 0.1)[0]:
                c = sys.stdin.read(1)
                if c == "\x1b":                      # ESC
                    break
                if tel:
                    got = tel.key(c)
                    if got:
                        print(f"\r  cmd vx={got[0]:+.2f} vy={got[1]:+.2f} "
                              f"wz={got[2]:+.2f} estop={got[3]}   ", end="", flush=True)
            else:
                time.sleep(0.05)

            now = time.time()
            if cap and now - last_report >= 5.0:
                last_report = now
                if cap.error:
                    print(f"\n[카메라 오류] {cap.error}")
                    break
                print(f"\n  [{int(now - started):4d}s] 프레임 {cap.frame_count()}장  "
                      f"수신 {cap.bytes_in/1e6:.1f}MB", flush=True)
    finally:
        if old is not None:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        if tel:
            tel.close()
        if cap:
            cap.close()

    if cap:
        n = cap.frame_count()
        dur = time.time() - started
        size = sum(os.path.getsize(os.path.join(out, f))
                   for f in os.listdir(out) if f.endswith(".jpg")) if n else 0
        print(f"\n종료 — {dur:.0f}초, 프레임 {n}장 "
              f"({n/dur if dur else 0:.1f} fps 실측), {size/1e6:.1f}MB")
        print(f"저장 위치: {out}")


if __name__ == "__main__":
    main()
