# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 탐지 담당 쪽 송신기 (HW-R-07 / 객체탐지 연동)
================================================================
스캔 한 바퀴를 도는 동안 **각 방향의 사진 한 장**을 객체탐지 담당 노트북으로 보낸다.

    [1] 한 바퀴 돌기 전   POST /mission/start   "나 지금부터 돈다"
    [2] 45도 돌 때마다    POST /frame           사진 + 그때의 각도
    [3] 끝나면            POST /mission/end     "이번 바퀴 끝. 몇 장 보냈다"

## 단방향이다

탐지 결과는 **여기로 돌아오지 않는다.** 탐지 쪽이 가시화 웹으로 직접 보낸다.
그래서 이 모듈은 응답 본문을 읽지 않고, 실패해도 로봇 동작에 영향을 주지 않는다.
전송은 전용 스레드에서 돌고, 큐가 차면 **오래된 것부터 버린다** — 탐지 노트북이
느리다고 로봇의 임무가 밀리면 안 되기 때문이다.

## 두 가지 전송 경로

탐지 담당 요구(2026-09-14)가 **MQTT 한 메시지에 사진과 각도를 같이** 싣는 쪽(A안)을
택했다. 각도와 사진이 같은 메시지에 있으면 짝이 어긋날 여지가 아예 없고, 그쪽 수신기가
이미 그 모양을 읽는다. 그래서 `MqttSink` 가 기본이다.

`HttpSink` 는 처음에 만든 경로(C안)다. 탐지 쪽이 엔드포인트를 열면 쓸 수 있게 남겨 둔다.
`HW_DETECT_TRANSPORT=mqtt|http|both` 로 고른다.

둘 다 **이산 사건**으로 다룬다 — 한 바퀴에 8장뿐이라 한 장을 잃으면 그 방향이 통째로
비고, 그러면 문 방향 계산이 틀어진다. MQTT 는 QoS 1, HTTP 는 TCP 를 쓰는 이유다.
유실을 감수하는 스트림(RTP/QoS 0) 방식이 맞지 않는 것도 같은 이유다.

## 각도를 두 개 보낸다

| 필드 | 뜻 | 신뢰도 |
|---|---|---|
| `bearing_deg` | 임무 시작 방향 기준 회전량(오른쪽 +). `step_deg × step` | **이걸 써라** |
| `yaw_deg` | 로봇이 보고한 절대 방위. ±180 으로 감긴다 | 기준점이 임무마다 옮겨질 수 있다 |

절대 yaw 는 기준이 재보정되거나(실물) 임무 간 이월되어(시뮬) 바퀴마다 달라진다.
같은 바퀴 안에서만 견주는 것이 아니라면 `bearing_deg` 를 써야 한다.
"""
import base64
import io
import json
import mimetypes  # noqa: F401  (multipart 경계 계산과 무관 — 의도적으로 쓰지 않는다)
import queue
import threading
import time
import urllib.error
import urllib.request
import uuid

import paho.mqtt.client as mqtt

from common import config, schema

SCHEMA = "1.0"


def _multipart(meta: dict, image: bytes, filename: str):
    """meta(JSON) + image(JPEG) 두 파트. 라이브러리 없이 만든다 —
    말단에 패키지를 덜 얹는다는 이 저장소의 방침을 따른다."""
    boundary = "----hw" + uuid.uuid4().hex
    out = io.BytesIO()

    def part(headers, payload):
        out.write(f"--{boundary}\r\n".encode())
        for h in headers:
            out.write(h.encode() + b"\r\n")
        out.write(b"\r\n")
        out.write(payload)
        out.write(b"\r\n")

    part(['Content-Disposition: form-data; name="meta"',
          "Content-Type: application/json; charset=utf-8"],
         json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    part([f'Content-Disposition: form-data; name="image"; filename="{filename}"',
          "Content-Type: image/jpeg"],
         image)
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


class HttpSink:
    """C안 — 탐지 쪽 HTTP 엔드포인트로 POST. 실패해도 예외를 밖으로 내지 않는다."""

    def __init__(self, base_url=None, timeout=None, queue_max=None, log=print):
        self.base = (base_url or config.DETECT_URL).rstrip("/")
        self.timeout = timeout or config.DETECT_TIMEOUT
        self.log = log
        self.q = queue.Queue(maxsize=queue_max or config.DETECT_QUEUE_MAX)
        self.sent = self.failed = self.dropped = 0
        self._stop = threading.Event()
        self._worker = None

    # ---------- 수명 ----------
    @property
    def enabled(self):
        return bool(self.base)

    def start(self):
        if not self.enabled:
            self.log("[탐지] DETECT_URL 이 비어 있다 — 송신하지 않는다")
            return self
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()
        self.log(f"[탐지] 송신 대상 {self.base}")
        return self

    def close(self, drain_s=3.0):
        end = time.time() + drain_s
        while not self.q.empty() and time.time() < end:
            time.sleep(0.1)
        self._stop.set()
        self.q.put(None)

    # ---------- 보내는 것 ----------
    def mission_start(self, meta):
        """[1] 한 바퀴 돌기 전. 탐지 쪽이 이번 바퀴의 묶음을 열 수 있게 한다."""
        body = dict(meta, schema_version=SCHEMA, kind="scan_mission_start")
        self._enqueue("/mission/start", json.dumps(body, ensure_ascii=False).encode(),
                      "application/json; charset=utf-8", f"start {meta.get('mission_id')}")

    def frame(self, meta, image):
        """[2][3] 한 방향의 사진 + 그때의 각도."""
        body = dict(meta, schema_version=SCHEMA, kind="scan_frame")
        name = f"{meta.get('mission_id','m')}_{meta.get('seq',0):02d}.jpg"
        payload, ctype = _multipart(body, image, name)
        self._enqueue("/frame", payload, ctype,
                      f"frame {meta.get('seq')} bearing={meta.get('bearing_deg')}")

    def mission_end(self, meta):
        """바퀴가 끝났음. 탐지 쪽이 묶음을 닫고 결과를 낼 시점을 안다."""
        body = dict(meta, schema_version=SCHEMA, kind="scan_mission_end")
        self._enqueue("/mission/end", json.dumps(body, ensure_ascii=False).encode(),
                      "application/json; charset=utf-8", f"end {meta.get('mission_id')}")

    # ---------- 전송 ----------
    def _enqueue(self, path, payload, ctype, label):
        if not self.enabled:
            return
        try:
            self.q.put_nowait((path, payload, ctype, label))
        except queue.Full:
            # 탐지 노트북이 느려도 로봇은 계속 돈다. 오래된 것부터 버린다.
            try:
                self.q.get_nowait()
                self.dropped += 1
                self.q.put_nowait((path, payload, ctype, label))
            except queue.Empty:
                pass

    def _run(self):
        while not self._stop.is_set():
            item = self.q.get()
            if item is None:
                break
            path, payload, ctype, label = item
            req = urllib.request.Request(self.base + path, data=payload, method="POST")
            req.add_header("Content-Type", ctype)
            req.add_header("Content-Length", str(len(payload)))
            try:
                # 응답 본문은 읽지 않는다 — 단방향이다. 상태 코드만 본다.
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    code = r.status
                if 200 <= code < 300:
                    self.sent += 1
                else:
                    self.failed += 1
                    self.log(f"[탐지] {label} 거부 HTTP {code}")
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                # 재시도하지 않는다. 다음 방향의 사진이 곧 온다 — 밀린 과거를
                # 되보내면 그때부터 계속 뒤처진다(SDD 5.4 와 같은 이유).
                self.failed += 1
                self.log(f"[탐지] {label} 실패: {type(e).__name__}: {e}")

    def stats(self):
        return {"sent": self.sent, "failed": self.failed,
                "dropped": self.dropped, "pending": self.q.qsize()}


# ---------------------------------------------------------------- MQTT (A안)
class MqttSink:
    """A안 — 사진과 각도를 **한 메시지에** 실어 브로커로 발행한다.

    탐지 담당이 요구한 모양(2026-09-14 §1-①)이다. 토픽은 기존 작명 체계를 그대로 따른다.

        zoneA/robot/go1-001/frame    사진 + rotation_deg   (QoS 1)
        zoneA/robot/go1-001/scan     한 판의 시작·끝       (QoS 1)

    JPEG 는 base64 로 싣는다. 실측 464x400 한 장이 약 25 KB, base64 로 34 KB 라
    8장을 다 합쳐도 300 KB 이하다. 브로커에 크기 제한은 걸려 있지 않다.
    """

    def __init__(self, base_topic, device_id, broker=None, port=None, log=print):
        self.base = base_topic.rstrip("/")
        self.device_id = device_id
        self.log = log
        self.sent = self.failed = self.dropped = 0
        self._c = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"detect-frames-{int(time.time())}",
            protocol=mqtt.MQTTv5 if config.MQTT_V5 else mqtt.MQTTv311)
        self._c.reconnect_delay_set(min_delay=1, max_delay=config.RECONNECT_MAX_DELAY)
        self._host = broker or config.BROKER_HOST
        self._port = port or config.BROKER_PORT

    @property
    def enabled(self):
        return True

    def start(self):
        self._c.connect_async(self._host, self._port, keepalive=config.KEEPALIVE)
        self._c.loop_start()
        self.log(f"[탐지] MQTT 발행 {self.base}/frame ({self._host}:{self._port})")
        return self

    def close(self, drain_s=3.0):
        # 발행이 실제로 나갈 시간을 준다. 바로 끊으면 마지막 프레임이 큐에서 죽는다.
        end = time.time() + drain_s
        while time.time() < end and self._c.want_write():
            time.sleep(0.1)
        self._c.loop_stop()
        self._c.disconnect()

    # ---------- 보내는 것 ----------
    def mission_start(self, meta):
        self._pub(f"{self.base}/scan",
                  dict(meta, channel="scan", event="scan_start"),
                  f"scan_start {meta.get('mission_id')}")

    def frame(self, meta, image):
        """탐지 요구 스키마. `rotation_deg` 와 `image` 가 같은 메시지에 있다."""
        body = {
            "schema_version": schema.SCHEMA_VERSION,
            "device_id": self.device_id,
            "channel": "frame",
            "timestamp": schema.iso_now(),
            "seq": meta.get("seq"),
            "rotation_deg": meta.get("rotation_deg"),
            "image": base64.b64encode(image).decode("ascii"),
        }
        # 참고 필드 — 탐지 쪽은 무시해도 된다. 현장에서 짝을 검증할 때 쓴다.
        body.update({k: meta[k] for k in
                     ("mission_id", "source_id", "node_id", "zone_id",
                      "step", "steps", "yaw_deg", "camera", "width", "height",
                      "bytes", "sha1", "duplicate_of_prev",
                      "captured_at_unix") if k in meta})
        self._pub(f"{self.base}/frame", body,
                  f"frame seq={body['seq']} rot={body['rotation_deg']}")

    def mission_end(self, meta):
        self._pub(f"{self.base}/scan",
                  dict(meta, channel="scan", event="scan_end"),
                  f"scan_end {meta.get('mission_id')}")

    def _pub(self, topic, body, label):
        try:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError) as e:
            self.failed += 1
            self.log(f"[탐지] {label} 직렬화 실패: {e}")
            return
        # QoS 1 — 한 바퀴에 8장뿐이라 한 장을 잃으면 그 방향이 통째로 빈다.
        info = self._c.publish(topic, payload, qos=1)
        if info.rc == mqtt.MQTT_ERR_SUCCESS:
            self.sent += 1
        else:
            self.failed += 1
            self.log(f"[탐지] {label} 발행 실패 rc={info.rc}")

    def stats(self):
        return {"sent": self.sent, "failed": self.failed, "dropped": self.dropped}


class FanoutSink:
    """여러 경로로 같은 것을 보낸다(`both`). 하나가 죽어도 나머지는 간다."""

    def __init__(self, sinks):
        self.sinks = [s for s in sinks if s is not None]

    enabled = True

    def start(self):
        for s in self.sinks:
            s.start()
        return self

    def close(self, drain_s=3.0):
        for s in self.sinks:
            s.close(drain_s)

    def mission_start(self, m):
        for s in self.sinks:
            s.mission_start(m)

    def frame(self, m, img):
        for s in self.sinks:
            s.frame(m, img)

    def mission_end(self, m):
        for s in self.sinks:
            s.mission_end(m)

    def stats(self):
        out = {}
        for s in self.sinks:
            out[type(s).__name__] = s.stats()
        return out


def create(base_topic, device_id, url=None, broker=None, port=None, log=print):
    """`HW_DETECT_TRANSPORT` 에 따라 싱크를 고른다 — mqtt(기본) | http | both.

    broker/port 는 부르는 쪽이 명시적으로 넘긴다. 설정 기본값에 기대면 명령줄로 준
    주소가 조용히 무시된다 — 실제로 겪었다(구독은 127.0.0.1, 발행은 설정 기본값).
    둘이 다른 브로커를 보면 임무는 따라가는데 사진은 엉뚱한 데로 간다."""
    kind = (config.DETECT_TRANSPORT or "mqtt").lower()
    mq = (MqttSink(base_topic, device_id, broker=broker, port=port, log=log)
          if kind in ("mqtt", "both") else None)
    ht = HttpSink(url, log=log) if kind in ("http", "both") else None
    if kind == "mqtt":
        return mq
    if kind == "http":
        return ht
    return FanoutSink([mq, ht])
