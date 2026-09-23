"""말단(Raspberry Pi) 에이전트 — 캡처 → 플로우 정렬 → 프레임 제공 → 판정 반영.

implements: AI-E-01, AI-S-06, AI-B-10, AI-C-03, AI-C-05, AI-C-06, AI-N-03

이 프로세스가 하는 일과 **하지 않는 일**:
  * 한다 — 카메라에서 최신 프레임을 잡고, 프레임 간 움직임을 KLT로 추정해 쌓고,
    엣지가 요청할 때 프레임을 내주고, 엣지가 준 장애물을 **현재 좌표로 옮겨**
    내보낸다.
  * 하지 않는다 — 검출, 추적, 의미 해석, 거리 산출. 전부 엣지 몫이다(AI-B-10).

── 왜 이렇게 가벼운가 ───────────────────────────────────────────────────────
예전에는 말단이 RPN으로 후보 200개를 만들고 ByteTracker로 track_id를 붙였다.
프레임당 350ms였고(Pi 5, 1.5GHz 스로틀링), 그 산출물을 실제로 소비하는 쪽이
없었다. 정렬이 필요로 하는 것은 **움직임**이지 정체성이므로, KLT 플로우 6ms가
같은 일을 한다(실측 58배). 근거와 잃은 것은 `alignment.py` 첫머리에 있다.

**엣지 주소를 모른다.** 먼저 연결하지 않으므로 알 필요가 없다 — 엣지가 당겨
간다(pull). 당기는 속도가 곧 backpressure이고, 요청 IP를 되찾아 되쏘는 대신
같은 연결의 응답에 실어 보낸다(NAT·LTE에서 안 깨지고 왕복도 절반이다).

스풀은 링크 단절 구간을 남긴다. 엣지가 `spool_after_idle_s` 동안 아예 오지
않으면 그때만 쌓는다 — pull에서 "안 가져간 프레임"은 대부분 정상이다.
"""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

from alignment import FlowAligner
from perception import apply_input_crop, resolve
from records import ObstacleStore

HERE = Path(__file__).resolve().parent
SOI, EOI = b"\xff\xd8\xff", b"\xff\xd9"


# ─────────────────────────────────────────────────────────────────────────────
# 설정
# ─────────────────────────────────────────────────────────────────────────────
def load_config(path: str | Path | None = None) -> dict:
    p = Path(path) if path else HERE / "config.json"
    cfg = json.loads(p.read_text(encoding="utf-8"))
    cfg["_config_path"], cfg["_root"] = str(p), str(p.parent)
    return cfg


def temp_c() -> float | None:
    """SoC 온도. 팬 없는 Pi 5는 85도에서 스로틀링이 걸리고 RPN 지연이 1.2배가 된다.

    **없으면 None을 돌려준다(NaN이 아니다).** NaN은 파이썬 json이 그대로 `NaN`으로
    써 버리는데 그건 유효한 JSON이 아니라서 브라우저 `JSON.parse`가 거부한다 —
    헬스를 읽는 웹 화면이 통째로 죽는다. 개발 기기(vcgencmd 없음)에서 실제로 그랬다.
    """
    try:
        out = subprocess.run(["vcgencmd", "measure_temp"], capture_output=True,
                             text=True, timeout=2).stdout
        return float(out.split("=")[1].split("'")[0])
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────────────────
# 카메라 — rpicam-vid MJPEG 파이프
# ─────────────────────────────────────────────────────────────────────────────
class CameraStream:
    """rpicam-vid 하나를 물고 **최신 JPEG 한 장만** 들고 있는다.

    rpicam-still은 1장에 542 ms인데 대부분이 프로세스 기동이라 줄일 수 없다.
    파이프에 쌓인 것을 순서대로 처리하면 RPN이 느린 만큼 화면이 뒤처지므로,
    실시간 감시 경로에서는 오래된 프레임을 버리고 최신 것만 본다(버린 수는
    카운터로 드러낸다, AI-O-02).
    """

    def __init__(self, index: int, width: int, height: int, framerate: int,
                 extra_args: list[str] | None = None):
        self.index, self.width, self.height = index, width, height
        self.framerate = framerate
        self.extra_args = list(extra_args or [])
        self._latest: bytes | None = None
        self._seq = self._dropped = 0
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._stop = threading.Event()
        self._error: str | None = None

    def start(self) -> None:
        cmd = ["rpicam-vid", "-n", "--camera", str(self.index), "-t", "0",
               "--codec", "mjpeg", "--width", str(self.width),
               "--height", str(self.height), "--framerate", str(self.framerate),
               *self.extra_args, "-o", "-"]
        try:
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                          stderr=subprocess.DEVNULL, bufsize=0)
        except Exception as exc:
            self._error = repr(exc)[:200]
            return
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        buf = bytearray()
        assert self._proc and self._proc.stdout
        while not self._stop.is_set():
            chunk = self._proc.stdout.read(65536)
            if not chunk:
                self._error = "stream ended"
                return
            buf += chunk
            while True:
                s = buf.find(SOI)
                if s < 0:
                    break
                e = buf.find(EOI, s + 3)
                if e < 0:
                    if s > 0:
                        del buf[:s]
                    break
                frame = bytes(buf[s:e + 2])
                del buf[:e + 2]
                with self._lock:
                    if self._latest is not None:
                        self._dropped += 1
                    self._latest, self._seq = frame, self._seq + 1

    def stop(self) -> None:
        self._stop.set()
        if self._proc:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except Exception:
                self._proc.kill()

    def available(self) -> bool:
        return self._error is None and self._latest is not None

    def take(self) -> tuple[bytes | None, int]:
        with self._lock:
            f, s = self._latest, self._seq
            self._latest = None
            return f, s

    def stats(self) -> dict:
        return {"camera": self.index, "seq": self._seq,
                "dropped": self._dropped, "error": self._error}


def open_cameras(cfg_cams: list[dict]) -> list[CameraStream]:
    """설정에 적힌 카메라를 모두 연다. 하나가 실패해도 나머지로 간다(AI-C-05)."""
    out = [CameraStream(int(c.get("index", 0)), int(c.get("width", 1280)),
                        int(c.get("height", 720)), int(c.get("framerate", 8)),
                        c.get("extra_args")) for c in cfg_cams]
    for s in out:
        s.start()
    deadline = time.time() + 6.0
    while time.time() < deadline and not all(s.available() for s in out):
        time.sleep(0.2)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 스풀 — 링크 단절 구간 보존
# ─────────────────────────────────────────────────────────────────────────────
class Spool:
    """단절 구간을 살리는 디스크 스풀. 원자적 쓰기(.tmp → rename).

    용량은 바이트가 아니라 개수·나이로 제한한다 — 드론 저장소는 유한하고 오래된
    프레임은 가치가 빠르게 떨어진다. 한계에 닿으면 오래된 것의 **픽셀부터** 버리고
    메타는 살린다. 몇 개를 버렸는지 센다 — 조용히 사라지면 안 된다(AI-O-02).
    """

    def __init__(self, root: Path, *, max_items: int = 500,
                 max_age_s: float = 1800.0, drop_frames_first: bool = True):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_items, self.max_age_s = max_items, max_age_s
        self.drop_frames_first = drop_frames_first
        self.dropped_old = self.dropped_overflow = self.frames_shed = 0
        self._lock = threading.Lock()

    def put(self, key: str, meta: dict, frame_jpeg: bytes | None) -> None:
        with self._lock:
            stem = self.root / f"{meta.get('frame_seq', 0):08d}_{key}"
            tmp = stem.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
            tmp.replace(stem.with_suffix(".json"))
            if frame_jpeg:
                ftmp = stem.with_suffix(".jpg.tmp")
                ftmp.write_bytes(frame_jpeg)
                ftmp.replace(stem.with_suffix(".jpg"))
            self._enforce()

    def pending(self) -> list[Path]:
        return sorted(self.root.glob("*.json"))

    def read(self, p: Path) -> tuple[dict, bytes | None]:
        meta = json.loads(p.read_text(encoding="utf-8"))
        jpg = p.with_suffix(".jpg")
        return meta, (jpg.read_bytes() if jpg.exists() else None)

    def done(self, p: Path) -> None:
        for q in (p, p.with_suffix(".jpg")):
            try:
                q.unlink()
            except FileNotFoundError:
                pass

    def _enforce(self) -> None:
        items, now = self.pending(), time.time()
        for p in list(items):
            try:
                age = now - json.loads(p.read_text(encoding="utf-8")).get("captured_at", now)
            except Exception:
                age = 0.0
            if age > self.max_age_s:
                self.done(p)
                self.dropped_old += 1
                items.remove(p)
        if self.drop_frames_first and len(items) > self.max_items:
            for p in items[: len(items) - self.max_items]:
                jpg = p.with_suffix(".jpg")
                if jpg.exists():
                    jpg.unlink()
                    self.frames_shed += 1
            items = self.pending()
        for p in items[:max(0, len(items) - self.max_items)]:
            self.done(p)
            self.dropped_overflow += 1

    def stats(self) -> dict:
        return {"pending": len(self.pending()), "dropped_old": self.dropped_old,
                "dropped_overflow": self.dropped_overflow,
                "frames_shed": self.frames_shed}


# ─────────────────────────────────────────────────────────────────────────────
# 공유 상태 — 인지 루프가 쓰고 HTTP 핸들러가 읽는다
# ─────────────────────────────────────────────────────────────────────────────
class State:
    """카메라별 최신 (meta, jpeg)와 레코드 창고.

    **Condition을 쓰는 이유**: 엣지가 같은 프레임을 반복해 받던 것을 없애기
    위해서다. 실측(2026-09-21, cam0만 최대 속도로 10초): 요청 137회 중 새 프레임은
    14개뿐이고 **90%가 중복**이었다. 그걸 만들어 보내느라 초당 1.3MB와 말단 CPU를
    태웠다 — 말단은 이미 RPN으로 포화 상태다.

    이제 엣지가 `since`로 자기가 가진 seq를 말하고, 더 새로운 게 없으면 말단은
    `wait`초까지 **자면서 기다린다**(롱폴). 폴링이 사라지고, 새 프레임이 나오는
    즉시 깨어나므로 지연도 최소가 된다.
    """

    def __init__(self):
        self.lock = threading.Condition()
        self.latest: dict[int, tuple[dict, bytes | None]] = {}
        self.stores: dict[int, ObstacleStore] = {}
        self.aligners: dict[int, object] = {}
        self.last_pull_at = 0.0          # 엣지가 마지막으로 가져간 시각
        self.served = self.not_modified = self.verdicts_in = 0

    def publish(self, cam: int, meta: dict, jpeg: bytes | None) -> None:
        with self.lock:
            self.latest[cam] = (meta, jpeg)
            self.lock.notify_all()       # 기다리던 요청을 깨운다

    def take_latest(self, cam: int, since: int = 0, wait_s: float = 0.0):
        """since보다 새로운 프레임. 없으면 wait_s까지 기다리고, 그래도 없으면 None.

        Returns: (meta, jpeg) 또는 None
        """
        deadline = time.time() + max(0.0, wait_s)
        with self.lock:
            while True:
                self.last_pull_at = time.time()
                got = self.latest.get(cam)
                if got is not None and int(got[0].get("frame_seq", 0)) > since:
                    self.served += 1
                    return got
                remain = deadline - time.time()
                if remain <= 0:
                    self.not_modified += 1
                    return None
                # notify_all을 놓쳐도 remain 안에 깨어난다.
                self.lock.wait(min(remain, 0.5))

    def idle_s(self) -> float:
        return time.time() - self.last_pull_at if self.last_pull_at else 1e9


# ─────────────────────────────────────────────────────────────────────────────
# HTTP — 엣지가 당겨 가는 창구. 말단은 서버이고 먼저 연결하지 않는다.
# ─────────────────────────────────────────────────────────────────────────────
def _multipart(meta: dict, jpeg: bytes | None) -> tuple[bytes, str]:
    """업무 메타(meta)와 미디어(frame)를 **나눠서** 한 응답에 싣는다(AI-C-06).

    나중에 meta를 MQTT로, frame을 별도 미디어 경로로 옮길 때 고칠 곳이 여기뿐이고
    판정 로직은 그대로다.
    """
    b = b"--drone\r\n"
    parts = [b + b'Content-Disposition: form-data; name="meta"\r\n'
             b"Content-Type: application/json\r\n\r\n"
             + json.dumps(meta, ensure_ascii=False).encode("utf-8") + b"\r\n"]
    if jpeg:
        parts.append(b + b'Content-Disposition: form-data; name="frame"; '
                     b'filename="frame.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
                     + jpeg + b"\r\n")
    parts.append(b"--drone--\r\n")
    return b"".join(parts), "multipart/form-data; boundary=drone"


def make_handler(cfg: dict, state: State, spool: Spool):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass                          # 프레임마다 stderr를 채우지 않는다

        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj: dict):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json")

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/api/frame":
                cam = int(q.get("cam", ["0"])[0])
                # since: 엣지가 이미 가진 frame_seq. 그보다 새 것이 없으면
                # 만들어 보내지 않고 204로 끝낸다 — 중복 90%가 여기서 사라진다.
                # wait: 롱폴 상한(초). 새 프레임이 나오면 즉시 깨어난다.
                since = int(q.get("since", ["0"])[0])
                wait_s = min(float(q.get("wait", ["0"])[0]), 30.0)
                got = state.take_latest(cam, since=since, wait_s=wait_s)
                if not got:
                    # 204 No Content — 본문이 없다. 404와 구분한다: 404는 "그런
                    # 카메라가 없다", 204는 "새 것이 없다"로 뜻이 다르고, 엣지가
                    # 둘을 같게 다루면 카메라 오타를 영원히 못 찾는다.
                    code = 204 if cam in state.latest else 404
                    self.send_response(code)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                meta, jpeg = got
                body, ctype = _multipart(meta, jpeg)
                return self._send(200, body, ctype)

            if u.path == "/api/spool":
                # 링크가 돌아온 뒤 밀린 것을 오래된 순서로. 지우는 건 ack에서 한다 —
                # 전송 도중 끊기면 다시 받을 수 있어야 한다.
                items = spool.pending()
                if not items:
                    return self._json(204, {"pending": 0})
                p = items[0]
                try:
                    meta, jpeg = spool.read(p)
                except Exception:
                    spool.done(p)
                    return self._json(204, {"pending": len(items) - 1})
                meta = {**meta, "spool_id": p.name, "from_spool": True}
                body, ctype = _multipart(meta, jpeg)
                return self._send(200, body, ctype)

            if u.path == "/api/health":
                return self._json(200, {
                    "node_id": cfg.get("node_id", "pi"),
                    "temp_c": temp_c(), "spool": spool.stats(),
                    "served": state.served,
                    "not_modified": state.not_modified,
                    "verdicts_in": state.verdicts_in,
                    "idle_s": round(state.idle_s(), 1),
                    "cameras": sorted(state.latest.keys())})
            return self._json(404, {"error": "unknown path"})

        def do_POST(self):
            u = urlparse(self.path)
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n) if n else b"{}"

            if u.path == "/api/verdict":
                # 엣지가 끝낸 판정을 밀어 넣는다. 말단이 폴링하지 않는 이유는
                # 엣지가 언제 끝나는지 아는 쪽이 엣지이기 때문이다.
                try:
                    v = json.loads(raw)
                except Exception:
                    return self._json(400, {"error": "bad json"})
                cam = int(v.get("camera_id", 0))
                with state.lock:
                    st = state.stores.get(cam)
                if st is None:
                    return self._json(404, {"error": "unknown camera",
                                            "camera_id": cam})
                # 좌표는 여기서 옮기지 않는다 — 내보낼 때 매 프레임 옮긴다.
                res = st.apply_verdict(v)
                state.verdicts_in += 1
                return self._json(200, res)

            if u.path == "/api/spool/ack":
                try:
                    sid = json.loads(raw).get("spool_id", "")
                except Exception:
                    return self._json(400, {"error": "bad json"})
                p = spool.root / Path(sid).name      # 경로 탈출 방지
                if p.parent != spool.root or not p.exists():
                    return self._json(404, {"error": "unknown spool_id"})
                spool.done(p)
                return self._json(200, {"acked": p.name})
            return self._json(404, {"error": "unknown path"})

    return Handler


# ─────────────────────────────────────────────────────────────────────────────
# 메인
# ─────────────────────────────────────────────────────────────────────────────
def frames_from_camera(cam: CameraStream):
    """한 카메라의 최신 프레임만 계속 낸다. (frame_id, bgr)

    **카메라마다 이 생성기를 자기 스레드에서 돌린다.** 예전에는 한 스레드가
    두 카메라를 번갈아 처리해서, 어느 카메라든 다른 카메라의 RPN이 끝나기를
    기다려야 했다 — 실측으로 카메라당 프레임 간격이 821ms(1.4 fps)였고 RPN은
    310ms였다. 나머지 500ms는 순전히 상대 카메라를 기다린 시간이다.
    """
    while True:
        jpeg, _ = cam.take()
        if jpeg is None:
            time.sleep(0.005)
            continue
        bgr = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            continue
        yield f"cam{cam.index}_{time.time():.3f}", bgr


def frames_from_dir(cfg: dict):
    """이미지 디렉터리 순회 — 카메라 없는 기기에서의 재현 경로."""
    d = resolve(cfg, cfg["pi"].get("images_dir", "images"))
    files = sorted([p for p in d.iterdir()
                    if p.suffix.lower() in (".jpg", ".jpeg", ".png")])
    if not files:
        raise SystemExit(f"이미지가 없다: {d}")
    while True:
        for p in files:
            bgr = cv2.imread(str(p))
            if bgr is not None:
                yield p.stem, bgr
        if not cfg["pi"].get("loop", True):
            return


class CameraWorker:
    """카메라 하나를 끝까지 책임지는 스레드 — 캡처·플로우 정렬·발행.

    검출도 추적도 하지 않는다. 프레임을 잡고, 직전 프레임 대비 움직임을 재고,
    엣지가 준 장애물을 현재 좌표로 옮겨 실어 보낸다. 그게 전부다.
    """

    def __init__(self, cfg: dict, cam: CameraStream | None, state: State,
                 spool: Spool, log, log_lock: threading.Lock):
        self.cfg, self.cam, self.state, self.spool = cfg, cam, state, spool
        self.cam_id = cam.index if cam is not None else 0
        self.log, self.log_lock = log, log_lock
        acfg = cfg.get("alignment", {})
        self.aligner = FlowAligner(
            work_w=int(acfg.get("work_width", 640)),
            max_corners=int(acfg.get("max_corners", 200)),
            history=int(acfg.get("history_frames", 120)))
        self.store = ObstacleStore(
            self.aligner,
            ttl_s=float(acfg.get("obstacle_ttl_s", 6.0)),
            max_items=int(acfg.get("max_obstacles", 200)))
        with state.lock:
            state.stores[self.cam_id] = self.store
            state.aligners[self.cam_id] = self.aligner
        self.seq = 0
        self._stop = threading.Event()
        self._last_spooled = 0.0

    def stop(self):
        self._stop.set()

    def run(self) -> None:
        cfg, pcfg = self.cfg, self.cfg["pi"]
        scfg = cfg.get("spool", {})
        spool_idle = float(scfg.get("spool_after_idle_s", 5.0))
        spool_every = float(scfg.get("spool_min_interval_s", 1.0))
        max_frames = int(pcfg.get("max_frames", 0))
        src = (frames_from_camera(self.cam) if self.cam is not None
               else frames_from_dir(cfg))

        for frame_id, bgr in src:
            if self._stop.is_set():
                return
            self.seq += 1
            if max_frames and self.seq > max_frames:
                return
            now = time.time()

            bgr, crop_box = apply_input_crop(cfg, bgr)
            h, w = bgr.shape[:2]

            # **이 한 줄이 예전의 RPN+ByteTrack을 대신한다.** 프레임 간 (이동,
            # 배율)을 쌓아 두면 엣지 판정이 언제 와도 현재 좌표로 옮길 수 있다.
            flow = self.aligner.observe(bgr, self.seq)

            # 엣지가 준 장애물을 **지금 좌표로** 옮겨 담는다. 매 프레임 옮기므로
            # 판정이 낡아도 화면 위치는 최신이다.
            obstacles = self.store.current(now)

            meta = {
                # AI-C-03: 원본 관측 참조와 정렬 기준이 같은 값이다 — 엣지가
                # frame_seq를 그대로 돌려주면 그 프레임부터 누적해 옮긴다.
                "frame_id": frame_id, "frame_seq": self.seq,
                "node_id": cfg.get("node_id", "pi"), "camera_id": self.cam_id,
                "captured_at": now, "observed_at": now,
                "frame_wh": [w, h],
                # crop을 적용했으면 좌표계가 원본과 다르다(AI-C-02).
                "input_crop": crop_box,
                # 카메라 기하 — 엣지 depth가 metric 스케일을 잡는 데 쓴다.
                # 안 넘기면 모델이 FoV를 추정하고 항공 영상에서 크게 틀린다.
                "camera": {"hfov_deg": pcfg.get("hfov_deg"),
                           "focal_px": pcfg.get("focal_px")},
                "flow": flow,
                # **시점 정렬 결과.** 박스는 지금 좌표, 라벨·거리는 몇 프레임 전
                # 관측에서 온 것이다. 엣지가 이걸 현재 프레임에 그려 스트리밍한다.
                "obstacles": obstacles,
            }
            jpeg = None
            if pcfg.get("send_frame", True):
                ok, enc = cv2.imencode(".jpg", bgr,
                                       [cv2.IMWRITE_JPEG_QUALITY,
                                        int(pcfg.get("jpeg_quality", 85))])
                if ok:
                    jpeg = enc.tobytes()

            self.state.publish(self.cam_id, meta, jpeg)

            idle = self.state.idle_s()
            if idle > spool_idle and (now - self._last_spooled) >= spool_every:
                self.spool.put(frame_id, meta, jpeg)
                self._last_spooled = now

            moved = max((o["moved_px"] for o in obstacles), default=0.0)
            print(f"[cam{self.cam_id} {self.seq}] {frame_id[-8:]}  "
                  f"flow {flow['flow_ms']:.0f}ms/{flow['flow_points']}점  "
                  f"장애물 {len(obstacles)}  최대이동 {moved:.0f}px  "
                  f"{'단절' if idle > spool_idle else '연결'}({idle:.0f}s)  "
                  f"스풀 {self.spool.stats()['pending']}  "
                  f"판정 {self.state.verdicts_in}", flush=True)
            with self.log_lock:
                self.log.write(json.dumps(
                    {"cam": self.cam_id, "seq": self.seq, "frame_id": frame_id,
                     "at": now, "temp_c": temp_c(), **flow,
                     "n_obstacles": len(obstacles), "max_moved_px": moved,
                     "idle_s": round(idle, 1)}, ensure_ascii=False) + "\n")
                self.log.flush()
            if pcfg.get("interval_s", 0.0) > 0:
                time.sleep(pcfg["interval_s"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=None)
    ap.add_argument("--out", default="agent_log.jsonl")
    args = ap.parse_args()

    cfg = load_config(args.config)
    pcfg, scfg = cfg["pi"], cfg.get("spool", {})
    state = State()

    spool = Spool(resolve(cfg, scfg.get("dir", "spool")),
                  max_items=int(scfg.get("max_items", 500)),
                  max_age_s=float(scfg.get("max_age_s", 1800)),
                  drop_frames_first=bool(scfg.get("drop_frames_first", True)))

    srv_cfg = cfg.get("server", {})
    httpd = ThreadingHTTPServer((srv_cfg.get("host", "0.0.0.0"),
                                 int(srv_cfg.get("port", 8890))),
                                make_handler(cfg, state, spool))
    httpd.daemon_threads = True
    # server_close()가 요청 스레드를 join하지 않게 한다. ThreadingMixIn은
    # block_on_close가 기본 True라, 롱폴로 대기 중인 연결 하나가 종료를 붙잡는다.
    httpd.block_on_close = False
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def _bye(signum, _frame):
        # SIGTERM도 KeyboardInterrupt로 바꾼다. systemd나 docker가 보내는 것이
        # 이쪽인데, 안 받으면 아래 finally가 통째로 건너뛰어져 레코드 스냅샷과
        # 카메라 프로세스 정리가 날아간다(rpicam-vid가 고아로 남는다).
        raise KeyboardInterrupt

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _bye)
        except (ValueError, OSError):
            pass

    print(f"말단 창구: http://{srv_cfg.get('host','0.0.0.0')}:"
          f"{srv_cfg.get('port',8890)}  (엣지가 /api/frame 으로 가져간다)")

    # ── 카메라마다 스레드 하나 ───────────────────────────────────────────────
    cams: list[CameraStream] = []
    workers: list[CameraWorker] = []
    log = (HERE / args.out).open("a", encoding="utf-8")
    log_lock = threading.Lock()

    if pcfg.get("source") == "camera":
        cams = open_cameras(pcfg.get("cameras", [{"index": 0}]))
        live = [c for c in cams if c.available()]
        if not live:
            raise SystemExit("사용 가능한 카메라가 없다: "
                             + json.dumps([c.stats() for c in cams],
                                          ensure_ascii=False))
        print(f"카메라 {len(live)}대 — 각각 자기 스레드 "
              f"(플로우 정렬만, 검출·추적은 엣지 몫)")
        workers = [CameraWorker(cfg, c, state, spool, log, log_lock)
                   for c in live]
    else:
        # 이미지 디렉터리 재현 경로는 한 워커로 충분하다.
        workers = [CameraWorker(cfg, None, state, spool, log, log_lock)]

    threads = [threading.Thread(target=w.run, daemon=True) for w in workers]
    for t in threads:
        t.start()

    try:
        while any(t.is_alive() for t in threads):
            for t in threads:
                t.join(timeout=0.5)
    except KeyboardInterrupt:
        print("\n중지 요청")
    finally:
        for w in workers:
            w.stop()
        httpd.shutdown()               # serve_forever 루프 정지
        httpd.server_close()           # 리슨 소켓 반환 — 여기서 포트가 풀린다
        for c in cams:
            c.stop()                   # rpicam-vid 자식 프로세스 종료
        snap = {f"cam{k}": v.snapshot() for k, v in state.stores.items()}
        (HERE / "records_snapshot.json").write_text(
            json.dumps(snap, ensure_ascii=False, indent=1), encoding="utf-8")
        log.close()
        print(f"제공 {state.served}회 / 새것없음 {state.not_modified}회 / "
              f"판정수신 {state.verdicts_in}건 / 스풀 {spool.stats()}")
        print(f"포트 {srv_cfg.get('port', 8890)} 반환 완료")
        for k, v in snap.items():
            print(f"{k}: 장애물 보유 {v['held']}개, 반영 누적 "
                  f"{v['applied_total']} / 만료 {v['dropped_stale']}")
        for k, w in ((w.cam_id, w) for w in workers):
            print(f"cam{k} 정렬: {w.aligner.stats()}")


if __name__ == "__main__":
    main()
