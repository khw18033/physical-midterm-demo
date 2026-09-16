"""
피지컬팀 mk2 — Go1 카메라 라이브 뷰어 (HW-R-07 검증용)
=========================================================
`robot/go1_camera.py` 가 받아오는 H.264 를 브라우저에서 눈으로 확인하기 위한 도구다.
운영 구성요소가 아니다 — 운영 경로는 엣지가 받는 것이고, 이건 **말단에서 영상이 실제로
나오는가**를 사람이 확인하기 위한 것이다.

## 두 가지 경로 — 기본은 무변환 통과

    [기본]  카메라 ──ws H.264──► pi7 ──그대로 중계──► 브라우저 WebCodecs 디코드
    [대비]  카메라 ──ws H.264──► pi7 ──ffmpeg──► MJPEG ──HTTP multipart──► <img>

**기본 경로는 파이에서 디코드도 인코드도 하지 않는다.** 로봇이 이미 H.264 로 주므로
바이트를 그대로 넘기고 브라우저가 하드웨어로 푼다. 처음에는 MJPEG 로 변환했는데,
그 변환이 지연과 대역폭을 함께 잡아먹었다.

| | MJPEG 변환 | **무변환 통과** |
|---|---|---|
| 파이 내부 지연 | 37 ms | **0 ms** (중계만) |
| 파이 CPU (5대) | 0.65 코어 | **0.02 코어** |
| 대역폭 | 3.6 Mbps | **0.58 Mbps** |
| 브라우저 요구 | 없음 | WebCodecs (Chrome/Edge 94+) |

MJPEG 경로는 WebCodecs 가 없는 브라우저를 위해 남겨 둔다. 자동으로 갈라진다.

## 지연을 화면에 띄운다

추측하지 않으려고 페이지가 스스로 측정해 표시한다. 브라우저와 파이의 시계가 다르므로
NTP 와 같은 방식으로 왕복 측정해 시계 차이를 빼낸 뒤, **파이가 프레임을 받은 시각부터
화면에 그린 시각까지**를 보여 준다. 로봇 내부(촬영→인코딩→송신) 지연은 기준 시각이
없어 여기에 포함되지 않는다 — 표시값은 하한이다.

사용:
    ssh physical@pi7.local
    cd ~/hw/pi && python3 -m bench.go1_cam_view 8090
    # 브라우저에서 http://pi7.local:8090/

**실측 (pi7, 2026-08-31):** 464x400 H.264 baseline, 도착 간격 33.3 ms(30 fps, p90 34.1 —
버스트 없음), 프레임 평균 2.4 KB, 키프레임 약 0.48 초 간격.
"""
import base64
import hashlib
import json
import os
import queue
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from robot.go1_camera import CAMS, Go1CameraSource, WSReader

HTTPS_PORT = 0              # main() 에서 정해져 페이지에 주입된다
IDLE_STOP_S = 20.0          # 보는 사람이 없으면 이만큼 뒤 상류 연결을 끊는다
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
QUEUE_MAX = 8               # 느린 뷰어 때문에 지연이 쌓이지 않도록 얕게 둔다


# ---------------------------------------------------------------- NAL 파싱
def nal_types(chunk):
    """Annex-B 조각 안의 NAL 종류 집합. 5=IDR, 7=SPS, 8=PPS."""
    out, i = set(), 0
    while True:
        j = chunk.find(b"\x00\x00\x01", i)
        if j < 0 or j + 3 >= len(chunk):
            return out
        out.add(chunk[j + 3] & 0x1F)
        i = j + 3


def codec_string(chunk):
    """SPS 에서 WebCodecs 코덱 문자열(avc1.PPCCLL)을 만든다. 없으면 None.
    프로파일·레벨을 박아 두면 로봇 펌웨어가 바뀔 때 조용히 어긋나므로 매번 읽는다."""
    i = 0
    while True:
        j = chunk.find(b"\x00\x00\x01", i)
        if j < 0 or j + 3 >= len(chunk):
            return None
        if (chunk[j + 3] & 0x1F) == 7 and j + 7 <= len(chunk):
            return "avc1." + chunk[j + 4:j + 7].hex()
        i = j + 3


# ---------------------------------------------------------------- 상류 허브
class Hub:
    """카메라 하나에 상류 연결 하나. 뷰어가 몇이든 로봇에는 연결 하나만 간다."""

    def __init__(self, cam_id):
        self.cam_id = cam_id
        self.label = CAMS[cam_id][2]
        self.lock = threading.Lock()
        self.subs = set()
        self.codec = None
        self.err = None
        self.running = False
        self.last_want = 0.0
        self.fps = 0.0

    def subscribe(self):
        q = queue.Queue(maxsize=QUEUE_MAX)
        with self.lock:
            self.subs.add(q)
            self.last_want = time.time()
            if not self.running:
                self.running = True
                threading.Thread(target=self._run, daemon=True).start()
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.subs.discard(q)

    def _fanout(self, item):
        with self.lock:
            subs = list(self.subs)
        for q in subs:
            try:
                q.put_nowait(item)
            except queue.Full:
                # 뒤처진 뷰어의 오래된 프레임을 버린다. 쌓아 두면 그 뷰어는
                # 몇 초 전 장면을 보게 된다 — 늦은 프레임은 버리는 편이 맞다.
                try:
                    q.get_nowait()
                    q.put_nowait(item)
                except queue.Empty:
                    pass

    def _run(self):
        n, t0 = 0, time.time()
        try:
            for chunk in Go1CameraSource(self.cam_id):
                types = nal_types(chunk)
                if self.codec is None and 7 in types:
                    self.codec = codec_string(chunk)
                self._fanout((time.time(), 5 in types, chunk))
                n += 1
                dt = time.time() - t0
                if dt >= 2.0:
                    self.fps, n, t0 = round(n / dt, 1), 0, time.time()
                with self.lock:
                    if not self.subs and time.time() - self.last_want > IDLE_STOP_S:
                        break
                    if self.subs:
                        self.last_want = time.time()
        except Exception as e:
            self.err = f"{type(e).__name__}: {e}"
        finally:
            # 여기에 경합이 있었다. 유휴로 빠져나오는 중에 새 구독자가 들어오면
            # `running` 이 아직 True 라 새 스레드를 띄우지 않고, 곧바로 여기서
            # running=False + None 을 뿌려 **막 붙은 뷰어의 스트림이 즉시 끝났다.**
            # 화면은 마지막 프레임에서 얼어붙고 오류는 아무 데도 안 남는다.
            # 빠져나가기 직전에 구독자가 남아 있으면 상류를 다시 연다.
            with self.lock:
                self.running = False
                restart = bool(self.subs)
                if restart:
                    self.running = True
            if restart:
                time.sleep(0.5)          # 상류가 계속 실패할 때 스핀하지 않도록
                threading.Thread(target=self._run, daemon=True).start()
            else:
                self._fanout(None)


HUBS = {cid: Hub(cid) for cid in CAMS}


# ---------------------------------------------------------------- MJPEG 대비 경로
class MjpegWorker:
    """WebCodecs 가 없는 브라우저용. 허브를 구독해 ffmpeg 로 MJPEG 를 만든다."""

    def __init__(self, cam_id):
        self.cam_id = cam_id
        self.cond = threading.Condition()
        self.jpeg = None
        self.seq = 0
        self.last_want = 0.0
        self.running = False
        self.proc = None

    def want(self):
        self.last_want = time.time()
        if not self.running:
            self.running = True
            threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        self.proc = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             # `-fflags nobuffer` 는 **넣으면 안 된다.** 출력이 파이프일 때 두어 프레임만
             # 내보내고 나머지를 통째로 버린다 — 같은 입력이 파일 출력에서는 3.4MB,
             # 파이프 출력에서는 29KB 였다. 오류도 남기지 않아 찾기 어렵다.
             #
             # `-threads 1` 은 지연 때문이다. ffmpeg 기본은 프레임 단위 멀티스레딩이라
             # 스레드 수만큼 프레임을 쥐고 있다가 내보낸다. 입출력 양쪽을 1스레드로 묶어
             # 실측 301ms → 37ms 로 줄였다(디코더 −134, 인코더 −131).
             "-threads", "1",
             "-probesize", "32k", "-analyzeduration", "0",
             "-f", "h264", "-i", "pipe:0",
             "-f", "mjpeg", "-q:v", "5", "-threads", "1", "pipe:1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        threading.Thread(target=self._pump, daemon=True).start()
        self._collect()

    def _pump(self):
        q = HUBS[self.cam_id].subscribe()
        try:
            while self.running:
                item = q.get()
                if item is None:
                    break
                # flush 를 빠뜨리면 파이썬 버퍼에 갇혀 ffmpeg 이 한 바이트도 못 받는다.
                self.proc.stdin.write(item[2])
                self.proc.stdin.flush()
        except Exception:
            pass
        finally:
            HUBS[self.cam_id].unsubscribe(q)
            try:
                self.proc.stdin.close()
            except Exception:
                pass

    def _collect(self):
        buf = b""
        try:
            while self.running:
                # read(n) 은 n 바이트가 찰 때까지 막는다. os.read 로 오는 대로 받는다.
                d = os.read(self.proc.stdout.fileno(), 65536)
                if not d:
                    break
                buf += d
                while True:
                    s = buf.find(b"\xff\xd8")
                    e = buf.find(b"\xff\xd9", s + 2) if s >= 0 else -1
                    if s < 0 or e < 0:
                        break
                    with self.cond:
                        self.jpeg, self.seq = buf[s:e + 2], self.seq + 1
                        self.cond.notify_all()
                    buf = buf[e + 2:]
                if time.time() - self.last_want > IDLE_STOP_S:
                    break
        except Exception:
            pass
        finally:
            self.running = False
            if self.proc:
                try:
                    self.proc.kill()
                except Exception:
                    pass
                self.proc = None
            with self.cond:
                self.cond.notify_all()

    def wait_frame(self, last_seq, timeout=8.0):
        with self.cond:
            if self.seq == last_seq:
                self.cond.wait(timeout)
            return self.seq, self.jpeg


MJPEG = {cid: MjpegWorker(cid) for cid in CAMS}


# ---------------------------------------------------------------- HTTPS 인증서
CERT_DIR = os.path.expanduser("~/.cache/hw-cam")


def local_ips():
    out = set()
    try:
        txt = subprocess.run(["ip", "-4", "-o", "addr", "show"],
                             capture_output=True, text=True).stdout
        for line in txt.splitlines():
            f = line.split()
            if len(f) > 3 and f[2] == "inet":
                out.add(f[3].split("/")[0])
    except Exception:
        pass
    out.discard("127.0.0.1")
    return sorted(out)


def ensure_cert():
    """자체 서명 인증서를 만든다(없을 때만).

    **왜 HTTPS 가 필요한가.** WebCodecs 는 secure context 전용 API 다. 평문 http 로
    열면 `VideoDecoder` 자체가 window 에 없어서, 페이지는 조용히 MJPEG 대비 경로로
    떨어진다 — 화면은 나오는데 저지연 경로가 아닌 상태가 된다. 게다가 MJPEG 는
    브라우저의 호스트당 동시 연결 6개 제한을 하나씩 잡아먹어서, 전체 보기(5대) 탭을
    띄워 두면 다른 탭이 아예 멈춘다. 실제로 이 조합으로 화면이 멎었다.
    """
    os.makedirs(CERT_DIR, exist_ok=True)
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    alt = ["DNS:localhost", f"DNS:{socket.gethostname()}", f"DNS:{socket.gethostname()}.local",
           "IP:127.0.0.1"] + [f"IP:{ip}" for ip in local_ips()]
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
         "-keyout", key, "-out", cert, "-subj", "/CN=hw-cam",
         "-addext", "subjectAltName=" + ",".join(alt)],
        check=True, capture_output=True)
    return cert, key


# ---------------------------------------------------------------- 웹소켓 서버
def ws_accept(key):
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()


class WSConn:
    """서버→클라이언트 프레임 송신. 여러 스레드가 쓰므로 잠근다."""

    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()

    def send(self, payload, opcode=0x2):
        n = len(payload)
        if n < 126:
            hdr = bytes((0x80 | opcode, n))
        elif n < 65536:
            hdr = bytes((0x80 | opcode, 126)) + n.to_bytes(2, "big")
        else:
            hdr = bytes((0x80 | opcode, 127)) + n.to_bytes(8, "big")
        with self.lock:
            self.sock.sendall(hdr + payload)

    def send_text(self, obj):
        self.send(json.dumps(obj).encode("utf-8"), opcode=0x1)


# ---------------------------------------------------------------- 페이지
PAGE = r"""<!doctype html><meta charset="utf-8"><title>Go1 카메라</title>
<style>
body{background:#111;color:#ddd;font:14px/1.6 system-ui,sans-serif;margin:0;padding:16px}
h1{font-size:16px;margin:0 0 10px;font-weight:600}
nav{margin-bottom:12px}
a{color:#7bf;text-decoration:none;margin-right:14px}
a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
figure{margin:0;background:#000;border:1px solid #333;border-radius:6px;overflow:hidden}
figcaption{padding:6px 10px;font-size:12px;color:#9ad;border-top:1px solid #222;
           display:flex;justify-content:space-between;gap:8px}
.stat{color:#7a8}
canvas,img{width:100%;display:block;background:#000}
.big canvas,.big img{max-height:78vh;object-fit:contain}
.note{color:#777;font-size:12px;margin-top:14px}
#warn{display:none;background:#3a2a00;border:1px solid #a80;color:#fd8;
      padding:10px 14px;border-radius:6px;margin-bottom:12px;font-size:13px}
#warn a{color:#fe0}
#clk{position:fixed;right:16px;bottom:16px;background:#000;color:#0f0;
     font:700 84px/1 ui-monospace,Consolas,monospace;padding:14px 20px;
     border:2px solid #0f0;border-radius:8px;letter-spacing:2px;display:none}
body.glass #clk{display:block}
body.glass .note{margin-bottom:120px}
</style>
<h1>Unitree Go1 카메라 — 실시간</h1>
<div id="warn"></div>
<nav>%NAV%</nav><div class="grid">%BODY%</div>
<div id="clk">0.000</div>
<p class="note">망 = 파이 수신 → 브라우저 도착. 표시 = 도착 → 화면에 그림. 시계 차이는
왕복 측정으로 보정한다. <b>로봇 내부(촬영·인코딩) 지연은 기준 시각이 없어 빠져 있으므로
합계는 하한이다.</b> 전체 지연을 정확히 재려면 <a href="?glass=1">전구간 측정</a> 을 켜고,
이 화면을 로봇 정면 카메라 쪽으로 돌린 뒤 스크린샷을 한 장 찍으면 된다 — 오른쪽 아래
시계의 현재값과, 영상 속에 찍힌 같은 시계의 값 차이가 촬영부터 표시까지 전부다.
시계를 맞출 필요가 없어 오차가 없다.</p>
<script>
// WebCodecs 는 secure context 전용이다. 평문 http 로 열면 VideoDecoder 가 아예 없어
// MJPEG 대비 경로로 떨어진다 — 지연이 커지고, 브라우저의 호스트당 연결 6개 제한을
// 잡아먹어 탭을 여러 개 열면 화면이 멎는다. https 쪽으로 안내한다.
const HAS_WC = 'VideoDecoder' in window;
const HTTPS_PORT = %HTTPS%;
if (!HAS_WC){
  const w = document.getElementById('warn');
  const url = 'https://' + location.hostname + ':' + HTTPS_PORT + location.pathname + location.search;
  w.style.display = 'block';
  w.innerHTML = '지금은 <b>MJPEG 대비 경로</b>다. 저지연(무변환 통과) 경로는 브라우저가 '
    + 'WebCodecs 를 켜 주는 <b>보안 연결</b>에서만 쓸 수 있다 → '
    + '<a href="' + url + '">' + url + '</a><br>'
    + '자체 서명 인증서라 경고가 한 번 뜬다. <b>고급 → 계속</b> 을 누르면 된다. '
    + '탭을 여러 개 열어 두면 이 대비 경로는 연결 수 제한으로 멈출 수 있다.';
}

function start(cid, fig){
  const cap = fig.querySelector('.stat');
  // 끊기면 스스로 다시 붙는다. 상류가 잠시 끊기거나 서버를 재기동해도 사람이
  // 새로고침할 필요가 없다 — 얼어붙은 화면을 방치하지 않는 것이 목적이다.
  const retry = () => { cap.textContent = '재연결 중…'; setTimeout(() => start(cid, fig), 1000); };
  if (!HAS_WC){                       // 대비 경로 — 브라우저가 WebCodecs 를 모른다
    const img = document.createElement('img');
    img.src = '/stream/' + cid;
    fig.querySelector('canvas').replaceWith(img);
    cap.textContent = 'MJPEG 대비 경로';
    return;
  }
  const cv = fig.querySelector('canvas');
  // desynchronized 는 쓰지 않는다. vsync 한 주기(16.7ms)를 아끼려던 옵션인데,
  // 일부 윈도우/NVIDIA 조합에서 GPU 디코드 프레임을 이 캔버스에 그릴 때 프레임마다
  // 느린 GPU→CPU 복사가 일어나 그리기 하나에 수백 ms 가 걸렸다(표시 280ms·화면
  // 2~3fps 로 실측). 16ms 아끼려다 300ms 를 잃는 거래였다.
  const ctx = cv.getContext('2d', {alpha: false});
  const ws = new WebSocket((location.protocol==='https:'?'wss':'ws')
                            + '://' + location.host + '/ws/' + cid);
  ws.binaryType = 'arraybuffer';
  let dec = null, offset = null, started = false, frames = 0;
  let net = 0, dcd = 0;                 // 망 구간 / 디코드+표시 구간 (ms, 지수평활)
  const arrived = new Map();            // 청크 timestamp(µs) → 브라우저 도착 시각
  // 디코드와 그리기를 분리한다. 디코더 출력마다 즉시 drawImage 하면, 그리기가
  // GPU 경합(4K 화면·화면녹화 등)으로 늦어지는 순간 디코드 큐가 눈덩이처럼 쌓여
  // 표시 지연이 수백 ms 까지 밀린다 — 실제 녹화 분석에서 표시 280ms 를 확인했다.
  // 최신 프레임 하나만 들고 있다가 화면 주사(rAF)마다 그린다. 늦은 프레임은 버린다.
  let pendingFrame = null;
  function drain(){
    if (!pendingFrame) return;
    const f = pendingFrame; pendingFrame = null;
    if (cv.width !== f.displayWidth){ cv.width=f.displayWidth; cv.height=f.displayHeight; }
    ctx.drawImage(f, 0, 0);
    const t = arrived.get(f.timestamp);
    if (t !== undefined){
      arrived.delete(f.timestamp);
      const d = performance.now() - t;
      dcd = dcd ? dcd*0.85 + d*0.15 : d;
    }
    f.close(); frames++;
  }
  // rAF 만으로 그리면 절전 모드(배터리 세이버 등)에서 브라우저가 rAF 를 2fps 까지
  // 조여 화면이 뚝뚝 끊긴다 — 실제로 겪었다. 보조 타이머(가시 탭에서는 조여지지
  // 않는다)를 함께 돌려 어느 쪽이든 먼저 온 쪽이 그린다.
  (function paint(){ drain(); requestAnimationFrame(paint); })();
  const drainTimer = setInterval(drain, 33);

  // 시계 차이 보정. 브라우저와 파이의 Date.now() 는 서로 다르다.
  const ping = () => { if (ws.readyState===1) ws.send(JSON.stringify({t:'ping',c0:Date.now()})); };
  const pingTimer = setInterval(ping, 3000);

  ws.onopen = ping;
  ws.onclose = () => {
    clearInterval(pingTimer);
    clearInterval(drainTimer);
    try { if (dec && dec.state !== 'closed') dec.close(); } catch(e) {}
    retry();
  };
  ws.onerror = () => { cap.textContent = '연결 오류'; };

  ws.onmessage = ev => {
    if (typeof ev.data === 'string'){
      const m = JSON.parse(ev.data);
      if (m.t === 'pong'){
        // offset = 파이 시계 − 브라우저 시계. 파이의 시각 ts 를 브라우저 시계로 옮기면
        // (ts − offset) 이므로 지연은 now − ts + offset 이다. 부호를 뒤집으면 지연이
        // 음수로 나오는데, 그때는 값이 이상하다는 것이 바로 보이므로 다행히 눈에 띈다.
        const o = m.s - (m.c0 + Date.now())/2;
        offset = (offset === null) ? o : offset*0.7 + o*0.3;
      } else if (m.t === 'hello' && m.codec && !dec){
        dec = new VideoDecoder({
          output: f => {
            // 그리지 않는다 — 최신 프레임만 남기고 이전 것은 버린다 (위 paint 루프 참조)
            if (pendingFrame) pendingFrame.close();
            pendingFrame = f;
          },
          error: e => {
            // 디코더가 죽으면(참조 프레임 유실 등) 화면이 영영 멈춘다 — 조용히
            // 앉아 있지 말고 연결을 끊어 재연결 경로(onclose→retry)를 태운다.
            cap.textContent = '디코더 오류 — 재연결: ' + e.message;
            try { ws.close(); } catch(_) {}
          }
        });
        // prefer-software: 이 해상도(464x400)에서는 소프트웨어 디코드가 밀리초대로
        // 충분하고, 하드웨어(D3D11/NVDEC) 경로는 세션 수 제한·출력 풀 대기 등으로
        // 스트림이 2~3fps 까지 무너지는 환경이 실재한다(GPU 크롬에서 재현·확인).
        dec.configure({codec: m.codec, optimizeForLatency: true,
                       hardwareAcceleration: 'prefer-software'});
      } else if (m.t === 'error'){
        cap.textContent = m.msg;
      }
      return;
    }
    if (!dec || dec.state !== 'configured') return;
    const u8 = new Uint8Array(ev.data);
    const key = u8[0] === 1;
    const ts = new DataView(ev.data).getFloat64(1);
    if (offset !== null){
      const n = (Date.now() - ts) + offset;          // 파이 수신 → 브라우저 도착
      net = net ? net*0.85 + n*0.15 : n;
    }
    // 탭이 뒤로 밀리는 등으로 디코더가 크게 밀리면 지연이 쌓인다. 다만 임계를
    // 낮게(5) 잡았더니 정상 재생 중의 순간 스파이크에도 걸려, 키프레임(최대 1초)
    // 까지 화면이 멈추기를 반복했다 — "중간중간 멈춤"의 정체가 이것이었다.
    // 1초 분량(30프레임)이 진짜로 밀렸을 때만 리셋한다.
    if (dec.decodeQueueSize > 30) started = false;
    if (!started){ if (!key) return; started = true; arrived.clear(); }
    const tsu = Math.round(ts*1000);
    arrived.set(tsu, performance.now());
    if (arrived.size > 90) arrived.clear();          // 누수 방지
    dec.decode(new EncodedVideoChunk({
      type: key ? 'key' : 'delta', timestamp: tsu, data: u8.subarray(9)}));
  };

  let last = performance.now();
  setInterval(() => {
    const now = performance.now(), fps = frames*1000/(now-last);
    frames = 0; last = now;
    if (ws.readyState === 1)
      cap.textContent = net ? (fps.toFixed(0) + ' fps · 망 ' + Math.round(net)
                               + ' · 표시 ' + Math.round(dcd)
                               + ' · 합 ' + Math.round(net + dcd) + ' ms')
                            : (fps.toFixed(0) + ' fps · 측정 중');
  }, 1000);
}
document.querySelectorAll('figure[data-cam]').forEach(f => start(+f.dataset.cam, f));

// 전구간(glass-to-glass) 측정용 시계. 화면을 카메라로 찍어 스스로를 보게 하면
// 시계 동기 없이 촬영→표시 전 구간을 한 장의 스크린샷으로 잴 수 있다.
if (new URLSearchParams(location.search).has('glass')){
  document.body.classList.add('glass');
  const clk = document.getElementById('clk'), t0 = Date.now();
  (function tick(){
    const s = (Date.now() - t0)/1000;
    clk.textContent = (s % 100).toFixed(3).padStart(6,'0');
    requestAnimationFrame(tick);
  })();
}
</script>
"""


def nav_html():
    return ('<a href="/">전체</a>'
            + "".join(f'<a href="/cam/{c}">{c} {CAMS[c][2]}</a>' for c in CAMS))


def cell(cid, big=False):
    klass = ' class="big"' if big else ''
    return (f'<figure{klass} data-cam="{cid}"><canvas></canvas>'
            f'<figcaption><span>{cid} · {CAMS[cid][2]}</span>'
            f'<span class="stat">연결 중</span></figcaption></figure>')


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # 상류(로봇→파이)와 같은 이유로 하류(파이→브라우저)도 Nagle 을 끈다.
    disable_nagle_algorithm = True

    def log_message(self, *args):
        pass                                  # 프레임마다 로그가 찍히면 못 쓴다

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/favicon.ico":
            self.send_response(204)          # 없어서 404 가 콘솔을 더럽히는 것뿐이다
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/":
            return self._html("".join(cell(c) for c in CAMS))
        parts = path.strip("/").split("/")
        if len(parts) == 2 and parts[0] in ("cam", "stream", "ws"):
            try:
                cid = int(parts[1])
            except ValueError:
                return self.send_error(404)
            if cid not in CAMS:
                return self.send_error(404)
            if parts[0] == "cam":
                return self._html(cell(cid, big=True))
            if parts[0] == "stream":
                return self._mjpeg(cid)
            return self._ws(cid)
        self.send_error(404)

    def _html(self, body):
        b = (PAGE.replace("%NAV%", nav_html()).replace("%BODY%", body)
                 .replace("%HTTPS%", str(HTTPS_PORT))).encode("utf-8")
        self.send_response(200)
        # no-store 가 없으면 브라우저가 옛 페이지(옛 JS)를 캐시로 재사용한다.
        # 실제로 디코더 가드 버그를 고친 뒤에도 사용자 탭만 1초 주기로 멈췄다 —
        # 서버는 새 코드였지만 탭은 옛 JS 를 돌리고 있었다.
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    # ---------- 무변환 통과 (기본) ----------
    def _ws(self, cid):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self.send_error(400, "웹소켓 요청이 아니다")
        self.close_connection = True
        self.wfile.write(("HTTP/1.1 101 Switching Protocols\r\n"
                          "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                          f"Sec-WebSocket-Accept: {ws_accept(key)}\r\n\r\n").encode())
        self.wfile.flush()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn = WSConn(self.connection)
        hub = HUBS[cid]
        q = hub.subscribe()
        threading.Thread(target=self._ws_control, args=(conn,), daemon=True).start()
        try:
            sent_hello = False
            while True:
                item = q.get(timeout=15)
                if item is None:
                    break
                ts, is_key, chunk = item
                if not sent_hello:
                    if hub.codec is None:
                        continue              # SPS 를 아직 못 봤다. 키프레임을 기다린다
                    conn.send_text({"t": "hello", "codec": hub.codec, "cam": cid})
                    sent_hello = True
                conn.send(bytes((1 if is_key else 0,)) + struct.pack(">d", ts * 1000.0)
                          + chunk)
        except (queue.Empty, BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            hub.unsubscribe(q)

    def _ws_control(self, conn):
        """클라이언트가 보내는 것은 시계 보정용 ping 뿐이다."""
        try:
            reader = WSReader(conn.sock)
            while True:
                op, payload = reader.frame()
                if op == 0x8:
                    break
                if op == 0x9:                                  # ping
                    conn.send(payload, opcode=0xA)
                elif op == 0x1:
                    m = json.loads(payload.decode("utf-8"))
                    if m.get("t") == "ping":
                        conn.send_text({"t": "pong", "c0": m["c0"], "s": time.time() * 1000.0})
        except Exception:
            pass

    # ---------- MJPEG (대비) ----------
    def _mjpeg(self, cid):
        cam = MJPEG[cid]
        cam.want()
        self.send_response(200)
        self.send_header("Cache-Control", "no-cache, private")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=fr")
        self.end_headers()
        seq = -1
        try:
            while True:
                cam.want()
                seq, jpg = cam.wait_frame(seq)
                if jpg is None:
                    continue
                self.wfile.write(b"--fr\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                 + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                              # 브라우저가 닫은 것뿐이다


def serve(port, tls=None):
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*tls)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    global HTTPS_PORT
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    HTTPS_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else port + 353

    serve(port)
    try:
        serve(HTTPS_PORT, ensure_cert())
        tls_note = f"https://<이 호스트>:{HTTPS_PORT}/  ← 저지연(무변환 통과)"
    except Exception as e:
        # 인증서를 못 만들어도 평문 경로는 살려 둔다. 저지연만 못 쓸 뿐이다.
        HTTPS_PORT = 0
        tls_note = f"HTTPS 준비 실패({type(e).__name__}) — MJPEG 대비 경로만 쓸 수 있다"
    print(f"대기 중 — http://<이 호스트>:{port}/")
    print(f"         {tls_note}")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
