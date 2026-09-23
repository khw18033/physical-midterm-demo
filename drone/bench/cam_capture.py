#!/usr/bin/env python3
"""
라즈베리파이 카메라 모듈 — 15fps 프레임 추출기.

CPU 사용량 측정용 부하 발생기 겸, 이후 가시화/영상 전송의 바탕으로 쓸 수 있는
최소 구현이다. 두 가지 경로를 지원한다.

  backend=picamera2  : python3-picamera2 가 있으면 이걸 쓴다 (권장).
                       ISP 출력을 그대로 numpy 배열로 받는다.
  backend=rpicam     : rpicam-vid 를 MJPEG 로 돌려 stdout 에서 프레임을 잘라 쓴다.
                       picamera2 설치 없이 rpicam-apps-lite 만으로 동작한다.

쓰는 법:
  python3 cam_capture.py --fps 15 --width 1280 --height 720 --seconds 60
  python3 cam_capture.py --fps 15 --save-every 15 --outdir /tmp/frames
"""
import argparse, os, signal, sys, time

_stop = False


def _on_sig(signum, frame):
    global _stop
    _stop = True


class Stats:
    """프레임 수와 실제 fps 를 센다."""

    def __init__(self, label):
        self.label = label
        self.n = 0
        self.bytes = 0
        # t0 는 '첫 프레임이 나온 시각'으로 잡는다. 카메라 워밍업(첫 프레임까지 0.5~1초)을
        # fps 에 섞으면 실제보다 낮게 나온다.
        self.t0 = None
        self.t_last_report = time.monotonic()

    def tick(self, nbytes=0):
        now = time.monotonic()
        if self.t0 is None:          # 첫 프레임 = 기준점. 카운트에는 넣지 않는다.
            self.t0 = now
            self.t_last_report = now
            return
        self.n += 1
        self.bytes += nbytes
        if now - self.t_last_report >= 5.0:
            el = now - self.t0
            print(f"[카메라] {self.label} {self.n}프레임 / {el:.1f}초 "
                  f"= {self.n / el:.2f} fps, 누적 {self.bytes / 1e6:.1f} MB",
                  flush=True)
            self.t_last_report = now

    def summary(self):
        if self.t0 is None:
            print(f"[카메라] 종료 — {self.label}: 프레임 0개", flush=True)
            return {"frames": 0, "elapsed": 0, "fps": 0}
        el = time.monotonic() - self.t0
        fps = self.n / el if el > 0 else 0
        print(f"[카메라] 종료 — {self.label}: {self.n}프레임 / {el:.1f}초 "
              f"= 평균 {fps:.2f} fps", flush=True)
        return {"frames": self.n, "elapsed": el, "fps": fps}


def run_picamera2(a):
    from picamera2 import Picamera2

    picam = Picamera2()
    # main 스트림을 그대로 쓴다. FrameDurationLimits 로 15fps 를 고정한다.
    dur = int(1_000_000 / a.fps)          # 마이크로초
    cfg = picam.create_video_configuration(
        main={"size": (a.width, a.height), "format": a.format},
        controls={"FrameDurationLimits": (dur, dur)},
        buffer_count=4,
    )
    picam.configure(cfg)
    picam.start()
    print(f"[카메라] picamera2 시작 — {a.width}x{a.height} {a.format} @ {a.fps}fps",
          flush=True)

    st = Stats("picamera2")
    deadline = time.monotonic() + a.seconds if a.seconds else None
    try:
        while not _stop and (deadline is None or time.monotonic() < deadline):
            arr = picam.capture_array("main")   # 여기서 15fps 로 블록된다
            st.tick(arr.nbytes)
            if a.save_every and st.n % a.save_every == 0:
                _save(a, st.n, arr)
    finally:
        picam.stop()
        picam.close()
    return st.summary()


def _save(a, idx, arr):
    """--save-every 가 켜져 있을 때만 쓴다. 기본은 디스크를 건드리지 않는다."""
    os.makedirs(a.outdir, exist_ok=True)
    path = os.path.join(a.outdir, f"frame_{idx:06d}.npy")
    import numpy as np
    np.save(path, arr)


def run_rpicam(a):
    """rpicam-vid --codec mjpeg 의 stdout 에서 JPEG 프레임을 잘라 낸다."""
    import subprocess

    cmd = [
        "rpicam-vid",
        "--codec", "mjpeg",
        "--width", str(a.width), "--height", str(a.height),
        "--framerate", str(a.fps),
        "--timeout", str(int(a.seconds * 1000) if a.seconds else 0),
        "--nopreview",
        "--flush",
        "--quality", str(a.quality),
        "-o", "-",
    ]
    print("[카메라] rpicam-vid 시작 — " + " ".join(cmd), flush=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, bufsize=0)

    SOI, EOI = b"\xff\xd8", b"\xff\xd9"
    buf = bytearray()
    st = Stats("rpicam-vid/mjpeg")
    try:
        while not _stop:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            buf.extend(chunk)
            # 버퍼 안에 완결된 JPEG 이 있으면 꺼낸다.
            while True:
                s = buf.find(SOI)
                if s < 0:
                    buf.clear()
                    break
                e = buf.find(EOI, s + 2)
                if e < 0:
                    if s > 0:
                        del buf[:s]      # 앞쪽 쓰레기 버림
                    break
                frame = bytes(buf[s:e + 2])
                del buf[:e + 2]
                st.tick(len(frame))
                if a.save_every and st.n % a.save_every == 0:
                    os.makedirs(a.outdir, exist_ok=True)
                    with open(os.path.join(a.outdir, f"frame_{st.n:06d}.jpg"), "wb") as f:
                        f.write(frame)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
    return st.summary()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", type=float, default=15.0)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--format", default="RGB888", help="picamera2 전용")
    ap.add_argument("--quality", type=int, default=80, help="rpicam MJPEG 품질")
    ap.add_argument("--seconds", type=float, default=0, help="0 이면 무한")
    ap.add_argument("--save-every", type=int, default=0,
                    help="N 프레임마다 저장. 0 이면 저장 안 함(기본)")
    ap.add_argument("--outdir", default="/tmp/frames")
    ap.add_argument("--backend", choices=["auto", "picamera2", "rpicam"], default="auto")
    a = ap.parse_args()

    signal.signal(signal.SIGINT, _on_sig)
    signal.signal(signal.SIGTERM, _on_sig)

    backend = a.backend
    if backend == "auto":
        try:
            import picamera2  # noqa: F401
            backend = "picamera2"
        except ImportError:
            backend = "rpicam"
            print("[카메라] picamera2 없음 → rpicam-vid 경로로 돈다", flush=True)

    return 0 if (run_picamera2(a) if backend == "picamera2" else run_rpicam(a)) else 1


if __name__ == "__main__":
    sys.exit(main())
