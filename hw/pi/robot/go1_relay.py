"""
피지컬팀 mk2 — Go1 H.264 무변환 RTP 중계 (HW-R-07 운영 경로)
==============================================================
로봇 카메라의 H.264 를 **디코드도 재인코딩도 없이** 엣지로 RTP/UDP 송출한다.

    Go1 카메라(웹소켓 H.264) ──이 모듈──► RTP/UDP ──► 엣지

## 왜 무변환인가

18차에서 확정한 결론이다. 로봇이 이미 H.264 로 주는데 말단에서 풀어 다시 인코딩하면
지연·CPU·대역폭을 전부 잃는다(실측: 파이 내부 지연 37→0.1 ms, CPU 0.65→0.05 코어,
대역폭 3.6→0.58 Mbps). 말단은 **패킷화만** 하고, 디코드는 필요한 지점(엣지)에서 한 번만
한다. v8 §5-10 의 전송 계층(RTP/UDP)은 그대로이고 코덱만 JPEG 가 아니라 H.264 다 —
이 차이는 미결 O-20 으로 백엔드·AI 와 협의 중이다.

## ffmpeg 조차 쓰지 않는다

0.58 Mbps 를 옮기는 데 외부 프로세스는 과하다. RFC 6184(H.264 의 RTP 페이로드) 를
직접 구현했다 — 규칙이 짧다:

  - NAL 이 MTU 이하면 그대로 한 패킷 (Single NAL Unit)
  - 크면 FU-A 로 쪼갠다: 첫 조각 S=1, 마지막 E=1, NAL 헤더는 지시자·타입으로 분해
  - 타임스탬프는 90 kHz, 한 프레임(액세스 유닛)의 마지막 패킷에 marker=1

프로세스 관리(기동 실패·좀비·파이프 막힘)라는 실패 모드 전체가 사라지고,
`media.py` 의 ffmpeg 경로에서 겪은 함정들(-huffman, nobuffer, -threads)과도 무관해진다.

## 세션 제어는 기존 명령 그대로

`MediaSender` 인터페이스를 그대로 구현하므로 로봇 노드의 `stream` 명령
(start/stop, 4단계 승격)이 코드 수정 없이 이 송신기를 켜고 끈다. v8 이 정한
"세션 개폐는 MQTT 명령으로"가 그대로 성립한다.

## SDP

엣지가 이 스트림을 열려면 SDP 가 필요하다. `status()["sdp"]` 로 내보낸다.
SPS/PPS 는 로봇이 매 IDR(0.5초 간격)마다 인밴드로 실어 보내므로
`sprop-parameter-sets` 없이도 디코더가 곧 붙는다.
"""
import random
import socket
import struct
import threading
import time

from common import config
from robot.media import MediaSender

RTP_PT = 96                 # 동적 페이로드 타입 (H.264)
CLOCK = 90000               # RFC 6184 고정
MTU_PAYLOAD = 1400          # IP+UDP+RTP 헤더를 빼고도 이더넷 MTU 안에 들어가는 크기
FU_A = 28


def split_annexb(buf):
    """Annex-B 버퍼를 NAL 단위로 자른다(시작 코드 3·4바이트 모두 처리)."""
    nals = []
    i = 0
    n = len(buf)
    while i < n:
        j = buf.find(b"\x00\x00\x01", i)
        if j < 0:
            break
        start = j + 3
        k = buf.find(b"\x00\x00\x01", start)
        end = n if k < 0 else (k - 1 if k > 0 and buf[k - 1] == 0 else k)
        if end > start:
            nals.append(buf[start:end])
        i = start if k < 0 else k
        if k < 0:
            break
    return nals


class RtpH264Packetizer:
    """RFC 6184. NAL 들을 RTP 패킷(bytes)으로 만든다. 전송은 하지 않는다 —
    패킷화 규칙만 여기 있어야 소켓 없이 검증할 수 있다."""

    def __init__(self, ssrc=None, seq=None):
        self.ssrc = ssrc if ssrc is not None else random.getrandbits(32)
        self.seq = seq if seq is not None else random.getrandbits(16)

    def _header(self, marker, timestamp):
        b1 = 0x80                               # V=2, P=0, X=0, CC=0
        b2 = (0x80 if marker else 0) | RTP_PT
        h = struct.pack(">BBHII", b1, b2, self.seq, timestamp & 0xFFFFFFFF, self.ssrc)
        self.seq = (self.seq + 1) & 0xFFFF
        return h

    def packetize(self, nals, timestamp):
        """한 액세스 유닛(프레임)의 NAL 들 → RTP 패킷 목록.
        마지막 패킷에만 marker=1 — 수신 쪽이 프레임 경계를 아는 유일한 방법이다."""
        pkts = []
        for ni, nal in enumerate(nals):
            last_nal = ni == len(nals) - 1
            if len(nal) <= MTU_PAYLOAD:
                pkts.append(self._header(last_nal, timestamp) + nal)
                continue
            # FU-A 분할
            indicator = (nal[0] & 0xE0) | FU_A
            ntype = nal[0] & 0x1F
            body = nal[1:]
            off = 0
            while off < len(body):
                chunk = body[off:off + MTU_PAYLOAD - 2]
                first = off == 0
                off += len(chunk)
                last_frag = off >= len(body)
                fu = (0x80 if first else 0) | (0x40 if last_frag else 0) | ntype
                pkts.append(self._header(last_nal and last_frag, timestamp)
                            + bytes((indicator, fu)) + chunk)
        return pkts


class Go1RtpRelaySender(MediaSender):
    """Go1 웹소켓 H.264 → RTP/UDP 무변환 중계. `MediaSender` 구현체."""

    def __init__(self, cam_id=None, cam_host=None, cam_port=None):
        self.cam_id = cam_id if cam_id is not None else config.GO1_CAM_ID
        self.cam_host = cam_host
        self.cam_port = cam_port
        self.session_id = None
        self.dest = None
        self.started_at = None
        self.last_error = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._frames = 0
        self._packets = 0
        self._bytes = 0
        self._last_frame_at = 0.0

    # ---------- 생애주기 ----------
    def start(self, dest_host, dest_port, session_id):
        if self.is_running():
            raise RuntimeError("stream_already_open")
        self._stop.clear()
        self._frames = self._packets = self._bytes = 0
        self.last_error = None
        started = threading.Event()
        self._thread = threading.Thread(
            target=self._run, args=(dest_host, int(dest_port), started), daemon=True)
        self._thread.start()
        # 기동 직후 죽는 경우(카메라 웹소켓 거부 등)를 여기서 잡는다.
        # 살아 있다고 보고해 놓고 아무것도 안 나가는 상태가 가장 나쁘다.
        if not started.wait(timeout=8.0) or self.last_error:
            err = self.last_error or "no_frames"
            self.stop()
            raise RuntimeError(f"stream_start_failed:{err[:120]}")
        self.session_id = session_id
        self.dest = f"{dest_host}:{dest_port}"
        self.started_at = time.time()

    def _run(self, dest_host, dest_port, started):
        # 순환 의존을 피해 여기서 임포트한다 (go1_camera 는 독립 모듈)
        from robot.go1_camera import Go1CameraSource
        sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        pkt = RtpH264Packetizer()
        t0 = time.time()
        try:
            src = Go1CameraSource(self.cam_id, host=self.cam_host, port=self.cam_port)
            for chunk in src:
                if self._stop.is_set():
                    break
                nals = split_annexb(chunk)
                if not nals:
                    continue
                ts = int((time.time() - t0) * CLOCK)
                for p in pkt.packetize(nals, ts):
                    sk.sendto(p, (dest_host, dest_port))
                    with self._lock:
                        self._packets += 1
                        self._bytes += len(p)
                with self._lock:
                    self._frames += 1
                    self._last_frame_at = time.time()
                if self._frames == 1:
                    started.set()
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            started.set()                       # start() 가 무한정 기다리지 않도록
        finally:
            sk.close()

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        self.session_id = None
        self.dest = None
        self.started_at = None

    def is_running(self):
        return self._thread is not None and self._thread.is_alive()

    # ---------- 상태 ----------
    def status(self):
        with self._lock:
            frames, packets, nbytes = self._frames, self._packets, self._bytes
            last = self._last_frame_at
        d = {"streaming": self.is_running(),
             "source": f"go1_cam{self.cam_id}",
             "codec": "h264/rtp(passthrough)"}
        if self.is_running():
            up = time.time() - self.started_at
            d.update({"session_id": self.session_id, "dest": self.dest,
                      "uptime_s": round(up, 1), "frames": frames,
                      "packets": packets,
                      "kbps": round(nbytes * 8 / max(up, 0.1) / 1000, 1),
                      "stale_s": round(time.time() - last, 1) if last else None,
                      "sdp": self._sdp()})
        if self.last_error:
            d["last_error"] = self.last_error
        return d

    def _sdp(self):
        host, port = self.dest.split(":")
        return ("v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=go1\r\n"
                f"c=IN IP4 {host}\r\nt=0 0\r\n"
                f"m=video {port} RTP/AVP {RTP_PT}\r\n"
                f"a=rtpmap:{RTP_PT} H264/{CLOCK}\r\n"
                f"a=fmtp:{RTP_PT} packetization-mode=1\r\n")
