"""
피지컬팀 mk2 — go1_relay 로컬 검증 (HW-R-07)
==============================================
로봇·파이 없이 중계 경로 전체를 검증한다. 실물이 없어도 **패킷화 규칙의 정확성**은
전부 로컬에서 판정할 수 있다 — RTP 는 규격이고, 규격 준수는 바이트로 확인된다.

    가짜 wssink(웹소켓, 합성 Annex-B) ──► Go1RtpRelaySender ──► UDP 수신 ──► 재조립 비교

검증 항목:
  1. 재조립한 NAL == 보낸 NAL (바이트 일치) — Single NAL·FU-A 양쪽 모두
  2. FU-A: S/E 비트, NAL 헤더 복원, 조각 크기 ≤ MTU
  3. marker 비트가 프레임(액세스 유닛)당 정확히 1개, 마지막 패킷에
  4. 시퀀스 번호 연속(16비트 랩 포함), 타임스탬프 90 kHz 단조 증가
  5. MediaSender 생애주기: start→status→stop, 이중 start 거부, 기동 실패 감지

합성 NAL 을 쓰는 이유: 패킷화기는 NAL 내용을 해석하지 않는다(타입 바이트만 본다).
디코드 가능한 실영상은 필요 없고, 크기·타입이 다양한 바이트열이면 충분하다.
실기 확인(엣지 수신·디코드)은 파이·로봇이 있을 때 별도로 한다.

사용:
    python -m bench.go1_relay_test        (pi/ 디렉터리에서, 어느 OS 든)
"""
import base64
import hashlib
import os
import random
import socket
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from robot.go1_relay import (CLOCK, FU_A, MTU_PAYLOAD, RTP_PT,
                             Go1RtpRelaySender, RtpH264Packetizer, split_annexb)

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
FPS = 30.0


# ---------------------------------------------------------------- 합성 스트림
def make_frames(n_frames, seed=7):
    """로봇 출력을 본뜬 Annex-B 프레임열. IDR 프레임은 SPS+PPS+IDR(큰 NAL → FU-A 경로),
    나머지는 non-IDR(작은 NAL → Single NAL 경로). 0.5초마다 IDR — 실측과 같은 구조다."""
    rng = random.Random(seed)
    sps = bytes([0x67]) + bytes(rng.randrange(256) for _ in range(15))
    pps = bytes([0x68]) + bytes(rng.randrange(256) for _ in range(4))
    frames = []
    for i in range(n_frames):
        if i % 15 == 0:
            idr = bytes([0x65]) + bytes(rng.randrange(256) for _ in range(rng.randrange(3000, 9000)))
            frames.append(b"\x00\x00\x00\x01" + sps + b"\x00\x00\x00\x01" + pps
                          + b"\x00\x00\x00\x01" + idr)
        else:
            p = bytes([0x41]) + bytes(rng.randrange(256) for _ in range(rng.randrange(300, 2200)))
            frames.append(b"\x00\x00\x00\x01" + p)
    return frames


# ---------------------------------------------------------------- 가짜 wssink
class FakeWssink(threading.Thread):
    """로봇의 GStreamer wssink 흉내 — 웹소켓으로 프레임을 30fps 로 흘린다."""

    def __init__(self, frames):
        super().__init__(daemon=True)
        self.frames = frames
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]

    def run(self):
        conn, _ = self.srv.accept()
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += conn.recv(4096)
        key = [l.split(":", 1)[1].strip() for l in buf.decode().split("\r\n")
               if l.lower().startswith("sec-websocket-key")][0]
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                      f"Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        try:
            for f in self.frames:
                n = len(f)
                if n < 126:
                    hdr = bytes((0x82, n))
                elif n < 65536:
                    hdr = bytes((0x82, 126)) + n.to_bytes(2, "big")
                else:
                    hdr = bytes((0x82, 127)) + n.to_bytes(8, "big")
                conn.sendall(hdr + f)
                time.sleep(1.0 / FPS)
        except OSError:
            pass
        finally:
            conn.close()
            self.srv.close()


# ---------------------------------------------------------------- RTP 수신·검사
class RtpCollector(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sk.bind(("127.0.0.1", 0))
        self.port = self.sk.getsockname()[1]
        self.sk.settimeout(0.5)
        self.packets = []
        # 이름 주의: threading.Thread 는 내부적으로 self._stop() 메서드를 쓴다.
        # Event 로 덮으면 join() 이 "'Event' object is not callable" 로 죽는다.
        self._halt = threading.Event()

    def run(self):
        while not self._halt.is_set():
            try:
                d, _ = self.sk.recvfrom(65535)
                self.packets.append(d)
            except socket.timeout:
                continue
        self.sk.close()

    def stop(self):
        self._halt.set()


def reassemble(packets):
    """RTP 패킷 → 프레임별 NAL 목록. 검사하면서 재조립한다."""
    frames, cur = [], []
    fu_buf = None
    prev_seq = None
    prev_ts = None
    errors = []
    for p in packets:
        b1, b2, seq, ts, _ = struct.unpack(">BBHII", p[:12])
        if b1 != 0x80:
            errors.append(f"RTP 버전 바이트 {b1:#x}")
        if (b2 & 0x7F) != RTP_PT:
            errors.append(f"PT {(b2 & 0x7F)}")
        marker = bool(b2 & 0x80)
        if prev_seq is not None and seq != ((prev_seq + 1) & 0xFFFF):
            errors.append(f"시퀀스 불연속 {prev_seq}→{seq}")
        prev_seq = seq
        if prev_ts is not None and (ts - prev_ts) & 0xFFFFFFFF > 0x7FFFFFFF:
            errors.append(f"타임스탬프 역행 {prev_ts}→{ts}")
        prev_ts = ts
        pay = p[12:]
        if (pay[0] & 0x1F) == FU_A:
            if len(pay) - 2 > MTU_PAYLOAD:
                errors.append(f"FU-A 조각 {len(pay)-2}B > MTU")
            start, end = pay[1] & 0x80, pay[1] & 0x40
            if start:
                nal_hdr = (pay[0] & 0xE0) | (pay[1] & 0x1F)
                fu_buf = bytearray([nal_hdr])
            if fu_buf is None:
                errors.append("FU-A 시작 없이 조각")
                continue
            fu_buf += pay[2:]
            if end:
                cur.append(bytes(fu_buf))
                fu_buf = None
        else:
            if len(pay) > MTU_PAYLOAD:
                errors.append(f"Single NAL {len(pay)}B > MTU")
            cur.append(pay)
        if marker:
            frames.append(cur)
            cur = []
    if cur:
        errors.append("marker 없이 끝난 프레임")
    return frames, errors


# ---------------------------------------------------------------- 시험
def test_packetizer_pure():
    """소켓 없이 패킷화 규칙만. 시퀀스 랩(65535→0)도 여기서 본다."""
    pk = RtpH264Packetizer(ssrc=1, seq=65534)
    small = bytes([0x41]) + b"x" * 100
    big = bytes([0x65]) + b"y" * (MTU_PAYLOAD * 2 + 123)
    pkts = pk.packetize([small, big], timestamp=90000)
    seqs = [struct.unpack(">H", p[2:4])[0] for p in pkts]
    assert seqs[0] == 65534 and 0 in seqs, f"시퀀스 랩 실패: {seqs}"
    frames, errs = reassemble(pkts)
    assert not errs, errs
    assert frames == [[small, big]], "재조립 불일치"
    markers = [bool(p[1] & 0x80) for p in pkts]
    assert markers.count(True) == 1 and markers[-1], "marker 는 마지막 패킷에만"
    print(f"  1) 패킷화 단독: {len(pkts)}패킷, 시퀀스 랩 {seqs[0]}→{seqs[-1]}, 재조립 일치 ✓")


def test_split_annexb():
    frames = make_frames(2)
    nals = split_annexb(frames[0])
    assert len(nals) == 3 and nals[0][0] == 0x67 and nals[2][0] == 0x65
    # 3바이트 시작 코드 혼용도 처리해야 한다
    mixed = b"\x00\x00\x01" + b"\x41abc" + b"\x00\x00\x00\x01" + b"\x41def"
    assert split_annexb(mixed) == [b"\x41abc", b"\x41def"]
    print(f"  2) Annex-B 분할: IDR 프레임 3 NAL, 3·4바이트 시작 코드 혼용 ✓")


def test_end_to_end():
    n_frames = 45                                # IDR 3개 포함, 1.5초 분량
    frames = make_frames(n_frames)
    sent_nals = [split_annexb(f) for f in frames]

    ws = FakeWssink(frames); ws.start()
    rx = RtpCollector(); rx.start()

    sender = Go1RtpRelaySender(cam_id=1, cam_host="127.0.0.1", cam_port=ws.port)
    sender.start("127.0.0.1", rx.port, "sess-test")
    assert sender.is_running()
    # SDP 는 송출 중에 떠 놓는다 — 가짜 소스는 다 보내면 끝나서 status 가 줄어든다
    sdp = sender.status()["sdp"]

    # 이중 start 는 거부해야 한다
    try:
        sender.start("127.0.0.1", rx.port, "sess-2")
        raise AssertionError("이중 start 가 통과했다")
    except RuntimeError as e:
        assert "already" in str(e)

    # 수신 패킷 수가 안정될 때까지 기다린다 (소스 소진 = 전송 완료)
    deadline = time.time() + n_frames / FPS + 5
    last_n = -1
    while time.time() < deadline:
        time.sleep(0.4)
        n = len(rx.packets)
        if n == last_n and n > 0 and not sender.is_running():
            break
        last_n = n
    sender.stop()
    rx.stop(); rx.join(timeout=3)

    got, errs = reassemble(rx.packets)
    assert not errs, f"RTP 규격 위반: {errs[:5]}"
    assert len(got) == n_frames, f"프레임 수 {len(got)} != {n_frames}"
    assert got == sent_nals, "재조립 바이트 불일치"
    assert not sender.is_running()
    assert f"H264/{CLOCK}" in sdp and "packetization-mode=1" in sdp
    fu = sum(1 for p in rx.packets if (p[12] & 0x1F) == FU_A)
    total = sum(len(p) for p in rx.packets)
    print(f"  3) 종단: {n_frames}프레임 {len(rx.packets)}패킷(FU-A {fu}) "
          f"{total*8/(n_frames/FPS)/1000:.0f}kbps — 전 프레임 바이트 일치 ✓")


def test_start_failure():
    """카메라가 없으면 start 가 명확히 실패해야 한다 — 살아 있다고 보고해 놓고
    아무것도 안 나가는 상태가 가장 나쁘다."""
    dead = socket.socket(); dead.bind(("127.0.0.1", 0))
    port = dead.getsockname()[1]; dead.close()   # 아무도 안 듣는 포트
    sender = Go1RtpRelaySender(cam_id=1, cam_host="127.0.0.1", cam_port=port)
    try:
        sender.start("127.0.0.1", 50000, "sess-fail")
        raise AssertionError("죽은 카메라로 start 가 통과했다")
    except RuntimeError as e:
        assert "stream_start_failed" in str(e)
    assert not sender.is_running()
    print(f"  4) 기동 실패 감지: 죽은 웹소켓 → RuntimeError, 스레드 정리 ✓")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    print("go1_relay 로컬 검증 (실물 불필요)")
    test_packetizer_pure()
    test_split_annexb()
    test_end_to_end()
    test_start_failure()
    print("전부 통과")


if __name__ == "__main__":
    main()
