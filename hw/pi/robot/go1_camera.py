"""
피지컬팀 mk2 — Unitree Go1 카메라 소스 (HW-R-07)
===================================================
Go1 의 5개 어안 카메라에서 **H.264 바이트스트림을 그대로 받아오는** 소스.

## 왜 이 경로인가 — 로봇을 건드리지 않는다

Go1 카메라를 쓰는 방법은 셋인데 앞의 둘은 대가가 크다.

| 방법 | 대가 |
|---|---|
| UnitreeCameraSDK 로 직접 열기 | `camerarosnode` 가 카메라를 점유 중이라 **죽여야 한다.** 그러면 로봇의 장애물 인식이 멈춘다 |
| camerarosnode 의 UDP 송출 설정 변경 | 설정 파일을 고치고 재기동 — 위와 같은 정지가 필요하고 로봇 상태도 바뀐다 |
| **imageai 의 웹소켓에 붙기** | **없다.** 이미 떠 있는 서버에 클라이언트로 붙기만 한다 |

Go1 의 `imageai/mLComSystemFrame` 은 카메라마다 `mqttControlNode` 를 띄워 두고
GStreamer `wssink` 로 **웹소켓에서 H.264 byte-stream 을 상시 제공한다.** 유니트리 앱이
영상을 보는 통로가 이것이다. 우리는 같은 통로에 붙는다 — 로봇 설정도, 프로세스도,
카메라 점유도 그대로다.

    카메라 → omxh264enc(600kbps, IDR 15) → wssink → ws://192.168.123.<노드>:<포트>

| ID | 위치 | 노드 | 포트 |
|---|---|---|---|
| 1 | 정면 | 192.168.123.13 | 9101 |
| 2 | 턱(하방) | 192.168.123.13 | 9102 |
| 3 | 좌측 | 192.168.123.14 | 9103 |
| 4 | 우측 | 192.168.123.14 | 9104 |
| 5 | 복부(하방) | 192.168.123.15 | 9105 |

**실측 (pi7, 2026-08-31):** 464x400, H.264 baseline, 약 29 fps, 카메라당 약 0.55 Mbps.
5대 동시 수신·디코드가 pi7 CPU 0.65코어(4코어 중 17%). 로봇 쪽 부하 변화는 없다 —
어차피 항상 인코딩하고 있던 스트림이다.

## 의존성을 두지 않는다

웹소켓 라이브러리를 쓰지 않고 핸드셰이크와 프레이밍을 직접 처리한다. 말단 노드에
파이썬 패키지를 하나라도 덜 얹기 위해서다(서버→클라이언트 프레임은 마스킹이 없어
파싱이 짧다). 실패하면 원시 TCP 로 폴백해 최소한 바이트는 흘린다.

## ⚠ UnitreeCameraSDK 예제를 로봇 카메라에 직접 돌리지 말 것

`example_putImagetrans` 같은 SDK 예제로 카메라를 직접 열면 **USB 재열거가 일어나
장치 번호가 밀린다**(`/dev/video1` → `/dev/video2`). 로봇의 `camerarosnode` 설정은
`DeviceNode` 를 번호로 박아 두므로, 그 순간부터 해당 카메라 파이프라인이 죽는다.

증상이 고약하다. **영상은 30 fps 로 계속 나오는데 그림만 정지한다** — 인코더가 마지막
버퍼를 계속 압축하기 때문이다. 프레임률·비트레이트·디코드 어디에도 이상이 없어서
전송 문제로 오해하기 쉽다. 실제로 정면 카메라가 이 상태로 몇 시간 방치됐다.

심볼릭 링크로 경로를 되살려도 안 된다. SDK 가 카메라 내부 캘리브레이션을 못 읽어
(`This camera cannot get internal parameters!`) `remap` 에서 죽는다.
**해당 나노를 재부팅**해야 USB 가 처음부터 다시 열거되고 원상 복구된다.

정지 여부는 프레임 수가 아니라 **그림의 변화량**으로 판정해야 한다
(`bench/go1_cam_probe.py`).

## 읽기 전용이다

이 소스는 웹소켓에 **아무것도 쓰지 않는다.** `go1_link.py` 와 같은 원칙 —
로봇을 움직일 수 있는 경로는 열지 않는다.
"""
import base64
import os
import socket

# (호스트, 포트, 이름)
CAMS = {
    1: ("192.168.123.13", 9101, "정면"),
    2: ("192.168.123.13", 9102, "턱(하방)"),
    3: ("192.168.123.14", 9103, "좌측"),
    4: ("192.168.123.14", 9104, "우측"),
    5: ("192.168.123.15", 9105, "복부(하방)"),
}

# 실험용 추가 소스 — 저지연 A/B 시험처럼 임시 스트림을 같은 뷰어·중계로 보고 싶을 때.
# 형식: HW_GO1_EXTRA_CAM="6:127.0.0.1:9106:실험(저지연)"
_extra = os.environ.get("HW_GO1_EXTRA_CAM", "")
if _extra:
    try:
        _id, _host, _port, _label = _extra.split(":", 3)
        CAMS[int(_id)] = (_host, int(_port), _label)
    except ValueError:
        pass                                    # 형식이 틀리면 조용히 무시하지 않는다



def ws_connect(host, port, timeout=8):
    """웹소켓 핸드셰이크. (소켓, 핸드셰이크 뒤에 딸려온 잔여 바이트) 를 돌려준다."""
    sk = socket.create_connection((host, port), timeout=timeout)
    # Nagle 을 끈다. 프레임이 평균 2.4KB 라 MSS 에 못 미치는 조각이 매번 남는데,
    # Nagle 은 그 조각을 다음 데이터나 ACK 가 올 때까지 붙들어 둔다. 지연 ACK 와
    # 겹치면 프레임당 수십 ms 가 조용히 붙는다 — 실시간 영상에서는 치명적이다.
    sk.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    key = base64.b64encode(os.urandom(16)).decode()
    sk.sendall((f"GET / HTTP/1.1\r\nHost: {host}:{port}\r\n"
                f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = sk.recv(4096)
        if not d:
            sk.close()
            raise IOError("핸드셰이크 도중 끊김")
        buf += d
        if len(buf) > 8192:
            sk.close()
            raise IOError("핸드셰이크 응답이 비정상적으로 김")
    head, _, rest = buf.partition(b"\r\n\r\n")
    if b"101" not in head.split(b"\r\n")[0]:
        sk.close()
        raise IOError(f"웹소켓 업그레이드 거부: {head.split(chr(13).encode())[0][:80]!r}")
    return sk, rest


class WSReader:
    """서버→클라이언트 프레임만 파싱한다. RFC 6455 상 서버 프레임은 마스킹이 없지만,
    구현체가 마스킹을 걸어 보내는 경우도 있어 마스크 비트는 존중한다."""

    def __init__(self, sk, seed=b""):
        self.sk = sk
        self.buf = seed

    def _need(self, n):
        while len(self.buf) < n:
            d = self.sk.recv(65536)
            if not d:
                raise EOFError("웹소켓 종료")
            self.buf += d

    def frame(self):
        """(opcode, payload). 0x1/0x2/0x0 이 데이터, 0x8 이 close."""
        self._need(2)
        op = self.buf[0] & 0x0F
        masked, ln, off = self.buf[1] & 0x80, self.buf[1] & 0x7F, 2
        if ln == 126:
            self._need(4)
            ln = int.from_bytes(self.buf[2:4], "big")
            off = 4
        elif ln == 127:
            self._need(10)
            ln = int.from_bytes(self.buf[2:10], "big")
            off = 10
        mask = b""
        if masked:
            self._need(off + 4)
            mask = self.buf[off:off + 4]
            off += 4
        self._need(off + ln)
        payload, self.buf = self.buf[off:off + ln], self.buf[off + ln:]
        if masked:
            payload = bytes(ch ^ mask[i % 4] for i, ch in enumerate(payload))
        return op, payload


class Go1CameraSource:
    """카메라 하나의 H.264 바이트스트림. 반복하면 조각이 나온다.

        for chunk in Go1CameraSource(1):
            ffmpeg_stdin.write(chunk)

    한 조각이 한 프레임에 대응한다(실측 29 fps). SPS/PPS 는 스트림 선두와
    IDR 앞에 계속 실려 오므로 중간에 붙어도 디코드가 시작된다.
    """

    def __init__(self, cam_id, host=None, port=None, recv_timeout=5.0):
        if cam_id not in CAMS and (host is None or port is None):
            raise ValueError(f"카메라 {cam_id} 를 모른다. host·port 를 직접 주거나 1~5 를 쓸 것")
        h, p, label = CAMS.get(cam_id, (host, port, f"cam{cam_id}"))
        self.cam_id = cam_id
        self.host = host or h
        self.port = port or p
        self.label = label
        self.recv_timeout = recv_timeout
        self._sk = None
        self._closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def __iter__(self):
        sk, rest = ws_connect(self.host, self.port)
        self._sk = sk
        sk.settimeout(self.recv_timeout)
        ws = WSReader(sk, rest)
        try:
            while not self._closed:
                op, payload = ws.frame()
                if op == 0x8:
                    break
                if payload:
                    yield payload
        except (EOFError, socket.timeout, OSError):
            return
        finally:
            self.close()

    def close(self):
        self._closed = True
        if self._sk is not None:
            try:
                self._sk.close()
            except OSError:
                pass
            self._sk = None
