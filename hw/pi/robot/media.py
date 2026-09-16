"""
피지컬팀 mk2 — 말단 영상 송출 (HW-R-07 / HW-S-06)
===================================================
아키텍처 v8 §5-10이 홉1(말단→엣지)의 미디어 경로를 확정했다.

    카메라 ──► JPEG 인코딩 ──► RTP over UDP ──► 엣지(수신·디코드)

| 결정 | v8 근거 |
|---|---|
| RTP over UDP | 영상은 프레임 유실을 허용한다. TCP 재전송을 기다리면 화면이 밀린다 |
| JPEG 코덱 | 프레임이 독립이라 유실이 다음 프레임에 전파되지 않고, 프레임 단위 오버레이 정합이 단순하다 |
| RTSP 서버 불필요 | "로봇 온보드는 우리가 코드를 통제하므로 RTP를 직접 송출하면 된다" |
| 온디맨드 | 세션 개폐는 MQTT 명령으로. 무선 대역폭을 아끼기 위해 요청 시에만 연다 |

**frame_ref 는 여기서 만들지 않는다.** v8 §6-9가 "frame_ref 는 엣지가 디코드 시점에
한 번 발급하고 전파하며 재생성 금지"로 확정했다. 말단은 RTP 순번·타임스탬프만 실어
보내고(그것이 엣지가 frame_ref 를 만드는 재료다), 자체 식별자를 붙이지 않는다.

**실측 (pi7, 4코어, 다른 워크로드 가동 중):**

| 해상도 | 품질 | 코어 | 대역폭 |
|---|---|---|---|
| 640x480@15 | q=5 | 0.09 (2%) | 2.6 Mbps |
| 1280x720@15 | q=5 | 0.24 (6%) | 5.8 Mbps |
| 1920x1080@15 | q=5 | 0.48 (12%) | 9.7 Mbps |
| 1920x1080@15 | q=12 | 0.46 (12%) | **5.5 Mbps** |

품질(q)이 대역폭의 지렛대이고 CPU 는 거의 변하지 않는다. 로봇은 홉1이 무선이므로
해상도를 낮추기 전에 **q 를 먼저 올려 대역폭을 줄이는 것이 손해가 적다.**
"""
import os
import shlex
import socket
import signal
import subprocess
import time
from abc import ABC, abstractmethod

from common import config


class MediaSender(ABC):
    """구현체를 갈아끼울 수 있게 인터페이스만 고정한다
    (ControllerLink·ActuatorLink 와 같은 방식)."""

    @abstractmethod
    def start(self, dest_host: str, dest_port: int, session_id: str) -> None:
        """송출 시작. 이미 열려 있으면 RuntimeError."""

    @abstractmethod
    def stop(self) -> None:
        """송출 중지. 열려 있지 않으면 아무 일도 하지 않는다."""

    @abstractmethod
    def is_running(self) -> bool:
        """실제로 송출 중인가. 프로세스가 죽었는지까지 확인한다."""

    @abstractmethod
    def status(self) -> dict:
        """상태 요약에 실을 정보."""


class RtpJpegSender(MediaSender):
    """ffmpeg 로 JPEG/RTP 송출. 카메라가 없으면 테스트 패턴으로 대체해
    경로 자체를 검증할 수 있다(`HW_MEDIA_SOURCE=test`)."""

    SDP_PATH = "/tmp/hw-media.sdp"
    ERR_PATH = "/tmp/hw-media.err"

    def __init__(self):
        self.proc = None
        self.session_id = None
        self.dest = None
        self.started_at = None
        self.last_error = None
        self.sdp = None
        self._out = None
        self._err = None

    # ---------- 명령줄 구성 ----------
    def _input_args(self):
        src = config.MEDIA_SOURCE
        if src == "test":
            # 카메라 미확보 상태에서 경로를 검증하기 위한 소스.
            # -re: 실시간 속도로 흘린다. 없으면 인코더가 최대 속도로 돌아
            # 실제 운용 부하·대역폭과 다른 값이 나온다.
            return ["-re", "-f", "lavfi", "-i",
                    f"testsrc2=size={config.MEDIA_SIZE}:rate={config.MEDIA_FPS}"]
        # 실제 카메라 (V4L2). 카메라 입고 시 HW_MEDIA_SOURCE 를 장치 경로로 바꾼다.
        return ["-f", "v4l2", "-framerate", str(config.MEDIA_FPS),
                "-video_size", config.MEDIA_SIZE, "-i", src]

    def _cmd(self, dest_host, dest_port):
        return (["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin"]
                + self._input_args()
                + ["-c:v", "mjpeg",
                   # RFC 2435(RTP JPEG)는 **표준 허프만 테이블**만 허용한다.
                   # ffmpeg 의 mjpeg 인코더는 기본이 최적화 테이블이라 이 옵션이 없으면
                   # RTP 먹서가 "RFC 2435 requires standard Huffman tables" 로 매 프레임을
                   # 버린다 — 프로세스는 살아 있고 CPU 도 쓰는데 네트워크로는 한 바이트도
                   # 나가지 않는다. 실기에서 이 상태를 만나 찾아낸 옵션이다.
                   "-huffman", "default",
                   "-q:v", str(config.MEDIA_QUALITY),
                   "-f", "rtp", f"rtp://{dest_host}:{dest_port}"])

    # ---------- 생애주기 ----------
    def start(self, dest_host, dest_port, session_id):
        if self.is_running():
            raise RuntimeError("stream_already_open")
        cmd = self._cmd(dest_host, dest_port)
        # 출력을 파이프가 아니라 파일로 받는다. 파이프로 받아 놓고 읽지 않으면
        # 버퍼가 차는 순간 ffmpeg 가 멈춘다. stdout 에는 **SDP** 가 나오는데,
        # 엣지가 이 스트림을 여는 데 필요한 정보라 버리지 않고 회신에 실어 보낸다.
        try:
            self._out = open(self.SDP_PATH, "w+b")
            self._err = open(self.ERR_PATH, "w+b")
            self.proc = subprocess.Popen(
                cmd, stdout=self._out, stderr=self._err, start_new_session=True)
        except FileNotFoundError:
            self.last_error = "ffmpeg_not_installed"
            self._close_files()
            raise RuntimeError(self.last_error)
        self.session_id = session_id
        self.dest = f"{dest_host}:{dest_port}"
        self.started_at = time.time()
        self.last_error = None

        # 기동 직후 죽는 경우(장치 없음·주소 오류)를 여기서 잡는다. 살아 있다고
        # 보고해 놓고 실제로는 아무것도 안 나가는 상태가 가장 나쁘다.
        time.sleep(1.5)
        if self.proc.poll() is not None:
            self.last_error = self._tail_err() or "ffmpeg_exited"
            self._reset()
            raise RuntimeError(f"stream_start_failed:{self.last_error[:120]}")

        # 살아 있는 것만으로는 부족하다. 실제로 바이트가 나가는지 확인한다 —
        # 살아서 인코딩만 하고 네트워크로는 아무것도 안 보내는 실패 모드가 있다.
        if not self._is_transmitting():
            err = self._tail_err() or "no_output"
            self.stop()
            self.last_error = err
            raise RuntimeError(f"stream_not_transmitting:{err[:120]}")
        self.sdp = self._read_sdp()

    def stop(self):
        if self.proc is None:
            return
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            self.proc.wait(timeout=5)
        except Exception:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except Exception:
                pass
        self._reset()

    def _tx_bytes(self):
        """목적지로 나가는 인터페이스의 누적 송신 바이트. 특정하지 못하면 None."""
        try:
            host, port = self.dest.split(":")
            sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sk.connect((host, int(port)))          # 실제 패킷은 보내지 않는다
            local = sk.getsockname()[0]
            sk.close()
            out = subprocess.run(["ip", "-4", "-o", "addr", "show"],
                                 capture_output=True, text=True).stdout
            for line in out.splitlines():
                if f"inet {local}/" in line:
                    iface = line.split()[1]
                    with open(f"/sys/class/net/{iface}/statistics/tx_bytes") as f:
                        return int(f.read().strip())
        except Exception:
            return None
        return None

    def _is_transmitting(self, window=1.5, min_kb=20):
        a = self._tx_bytes()
        if a is None:
            return True          # 측정할 수 없으면 막지 않는다
        time.sleep(window)
        b = self._tx_bytes()
        return b is not None and (b - a) >= min_kb * 1024

    def _tail_err(self):
        try:
            with open(self.ERR_PATH, encoding="utf-8", errors="replace") as f:
                lines = [l.strip() for l in f if l.strip()]
            return lines[-1][:200] if lines else ""
        except OSError:
            return ""

    def _read_sdp(self):
        """엣지가 이 스트림을 여는 데 필요한 SDP. 명령 결과에 실어 보낸다."""
        try:
            with open(self.SDP_PATH, encoding="utf-8", errors="replace") as f:
                return f.read().strip() or None
        except OSError:
            return None

    def _close_files(self):
        for f in (self._out, self._err):
            try:
                if f: f.close()
            except Exception:
                pass
        self._out = self._err = None

    def _reset(self):
        self._close_files()
        self.proc = None
        self.session_id = None
        self.dest = None
        self.started_at = None
        self.sdp = None

    def is_running(self):
        return self.proc is not None and self.proc.poll() is None

    def status(self):
        d = {"streaming": self.is_running(),
             "source": config.MEDIA_SOURCE,
             "size": config.MEDIA_SIZE,
             "fps": config.MEDIA_FPS,
             "codec": "mjpeg/rtp"}
        if self.is_running():
            d.update({"session_id": self.session_id, "dest": self.dest,
                      "quality": config.MEDIA_QUALITY,
                      "uptime_s": round(time.time() - self.started_at, 1)})
            if self.sdp:
                d["sdp"] = self.sdp
        if self.last_error:
            d["last_error"] = self.last_error
        return d

    def describe(self):
        """현재 설정으로 실제 실행될 명령줄. 현장에서 재현·디버깅용."""
        return " ".join(shlex.quote(a) for a in self._cmd("<엣지IP>", config.MEDIA_DEST_PORT))


class NoMediaSender(MediaSender):
    """카메라도 ffmpeg 도 없는 노드(센서노드 등). 명령을 받으면 명확히 거부한다."""

    def start(self, dest_host, dest_port, session_id):
        raise RuntimeError("media_not_available")

    def stop(self):
        pass

    def is_running(self):
        return False

    def status(self):
        return {"streaming": False, "source": "none"}


def create(kind=None):
    kind = kind or config.MEDIA_SENDER
    if kind == "rtp_jpeg":
        return RtpJpegSender()
    if kind == "go1_relay":
        # Go1 실기용: H.264 를 디코드·재인코딩 없이 RTP 로 중계한다 (HW-R-07)
        from robot.go1_relay import Go1RtpRelaySender
        return Go1RtpRelaySender()
    if kind == "none":
        return NoMediaSender()
    raise NotImplementedError(f"MediaSender '{kind}' 미구현")
