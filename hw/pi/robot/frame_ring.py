# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 카메라 프레임 링 버퍼 (HW-R-07)
=================================================
Go1 의 H.264 스트림에서 **원하는 순간의 한 장**을 꺼내기 위한 장치.

H.264 는 프레임이 앞뒤에 의존하므로 임의 시점의 한 장을 바로 뽑을 수 없다(디코드가
필요하다). 그래서 낮은 fps 로 계속 디코드해 링 디렉터리에 JPEG 를 떨어뜨려 두고,
필요한 순간에 그 시점의 최신 파일을 집는다.

쓰는 중인 파일을 집으면 반쯤 쓰인 JPEG 이 된다 — 그래서 **마지막이 아니라 그 앞의 것**을
고른다. 그건 쓰기가 끝났음이 보장된다.

원래 `bench/go1_scan_capture.py` 안에 있었는데 탐지 연동(`detect_bridge`)도 같은 것을
필요로 해서 이리로 옮겼다. 구현은 그대로다.
"""
import glob
import os
import shutil
import subprocess
import threading
import time

from robot.go1_camera import Go1CameraSource


RING_FPS = 5.0        # 링 버퍼에 떨어뜨리는 속도. ACK 시점 근처 프레임을 확보할 정도면 된다
RING_KEEP = 40        # 링에 유지하는 파일 수(오래된 것부터 지운다)


def _by_mtime(paths):
    """수정시각 순으로 정렬한다(오래된 것 먼저). 지워진 파일은 건너뛴다.

    **이름순으로 고르면 안 된다.** ffmpeg 는 기동할 때마다 번호를 r_000001 부터 다시
    매긴다. 디렉터리에 이전 링의 r_006559 가 남아 있으면 이름순 마지막은 영원히 그
    옛 파일이다. 실측 2026-09-14: 서비스 재시작 뒤 50분 전(14:31) 사진 한 장이 스캔
    다섯 방향에 똑같이 나갔고, 청소 스레드는 오히려 **새** 프레임을 지우고 있었다."""
    out = []
    for f in paths:
        try:
            out.append((os.path.getmtime(f), f))
        except OSError:
            pass
    out.sort()
    return [f for _, f in out]


class FrameRing:
    """Go1 정면 H.264 -> ffmpeg -> 링 디렉터리에 JPEG 를 계속 떨어뜨린다."""

    def __init__(self, ring_dir, cam_id=1, fps=RING_FPS, quality=2):
        self.dir = ring_dir
        self.cam_id = cam_id
        self.fps = fps
        self.quality = quality
        self.stop_flag = threading.Event()
        self.error = None
        self.bytes_in = 0

    def start(self):
        os.makedirs(self.dir, exist_ok=True)
        # 이전 링이 남긴 프레임을 비운다. 남겨 두면 새 ffmpeg 의 번호와 섞이고,
        # wait_ready 가 옛 파일만 보고 "준비됐다"고 착각한다.
        for f in glob.glob(os.path.join(self.dir, "r_*.jpg")):
            try:
                os.remove(f)
            except OSError:
                pass
        self.ff = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-f", "h264", "-use_wallclock_as_timestamps", "1", "-i", "pipe:0",
             "-vf", f"fps={self.fps}", "-q:v", str(self.quality),
             "-f", "image2", os.path.join(self.dir, "r_%06d.jpg")],
            stdin=subprocess.PIPE)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.sweeper = threading.Thread(target=self._sweep, daemon=True)
        self.sweeper.start()

    def _read(self):
        try:
            with Go1CameraSource(self.cam_id) as src:
                for chunk in src:
                    if self.stop_flag.is_set():
                        break
                    self.bytes_in += len(chunk)
                    try:
                        self.ff.stdin.write(chunk)
                    except (BrokenPipeError, ValueError):
                        self.error = "ffmpeg_pipe_closed"
                        break
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"
            return
        # 스트림이 **예외 없이 끝난** 경우. 로봇이나 나노가 재시작하면 웹소켓이 조용히
        # 닫힌다. 여기서 error 를 세우지 않으면 ffmpeg 는 stdin 을 기다리며 살아 있고,
        # 링은 마지막 프레임에서 멈춘 채 "살아 있다"고 보고한다. 실측 2026-09-14:
        # 14:31 에 끊겼는데 43분 동안 아무도 몰랐고, 그 사이 집을 사진은 전부 14:31 것이었다.
        if not self.stop_flag.is_set() and self.error is None:
            self.error = "stream_ended"

    def _sweep(self):
        """오래된 프레임을 지운다. 안 지우면 5fps x 촬영시간만큼 쌓인다."""
        while not self.stop_flag.wait(2.0):
            files = _by_mtime(glob.glob(os.path.join(self.dir, "r_*.jpg")))
            for f in files[:-RING_KEEP]:
                try:
                    os.remove(f)
                except OSError:
                    pass

    def wait_ready(self, timeout=10.0):
        """첫 프레임이 나올 때까지. 카메라가 없으면 여기서 걸러진다."""
        end = time.time() + timeout
        while time.time() < end:
            if self.error:
                return False
            if len(glob.glob(os.path.join(self.dir, "r_*.jpg"))) >= 2:
                return True
            time.sleep(0.2)
        return False

    def last_frame_age(self):
        """가장 최근 프레임이 몇 초 전 것인가. 없으면 None.

        `error` 만으로는 부족하다 — 스트림이 끊기지 않고 **멈추기만** 해도(데이터가 안 오는
        웹소켓, 막힌 ffmpeg) 오류는 안 난다. 결과물의 나이를 보는 것이 가장 확실하다."""
        files = glob.glob(os.path.join(self.dir, "r_*.jpg"))
        if not files:
            return None
        try:
            return time.time() - max(os.path.getmtime(f) for f in files)
        except OSError:
            return None

    def grab(self, dest):
        """지금 시점의 **완성된** 최신 프레임을 dest 로 복사한다.
        마지막 파일은 ffmpeg 가 쓰는 중일 수 있어 그 앞의 것을 고른다."""
        files = _by_mtime(glob.glob(os.path.join(self.dir, "r_*.jpg")))
        if len(files) < 2:
            return None
        src = files[-2]
        shutil.copy2(src, dest)
        return os.path.getsize(dest)

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
