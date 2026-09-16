"""demo/test/mqtt_stream_receiver.py

implements: 로봇(라즈베리파이 pi7) ↔ 탐지 연동 -- `mock_stream_receiver.py`가 흉내 내던
프레임+회전각 스트림을 **실제 MQTT 수신**으로 바꾼 것이다.
규약은 로봇 쪽에서 받은 `detection-protocol_0914.md`를 그대로 따른다(A안 확정).

    브로커   ws://pi7.tailcb6bfb.ts.net:9001/mqtt  (또는 1883 생 TCP)
    프레임   zoneA/robot/go1-001/frame   QoS 1, 방향마다 1건(기본 8건)
    판 경계  zoneA/robot/go1-001/scan    QoS 1, scan_start / scan_end 각 1건

mock_stream_receiver.py는 지우지 않았다 -- 로봇 없이 데이터셋으로 돌려 보는 경로가
그대로 필요하고, 두 파일이 같은 오케스트레이션(스캔 -> 8프레임 -> 위치추정 -> 경로)을
공유한다. 이 파일은 그 중 **입력원만** 바꾼 것이다.

**명령은 오지 않는다.** `탐지_연동스키마_260912.md` §1에서 관제 웹은 GET만 던지기로
정해졌다. 그래서 "그 앞으로 가라" 명령을 기다리지 않고, 판이 정상 종료되면 **자동으로**
자기 위치 추정 -> 관측 요약 -> 경로 산출까지 끝내 놓는다. 관제 웹은 그 결과를
detect_api_server.py로 가져간다.

**규약에서 반드시 지켜야 하는 것 둘**(detection-protocol_0914.md):

1. `duplicate_of_prev` -- Go1 카메라는 얼어붙어도 30fps로 계속 내보내고 그림만 멈춘다.
   직전과 바이트까지 같은 프레임에 이 표시가 붙는다. **표시가 붙은 판은 버린다.**
   같은 사진 8장을 8방향으로 오해하면 문 방향이 통째로 틀어지기 때문이다.
   여기서는 한 발 더 나아가 **판 안에서 한 번이라도 나온 그림인지**를 우리도 직접
   해시로 본다(로봇은 직전 한 장하고만 견주므로 건너뛴 중복은 못 잡는다).
2. `yaw_deg`는 판마다 기준점이 옮겨지므로 방향 계산에 쓰면 안 된다. 각도는 언제나
   `rotation_deg`(0/45/.../315, 오른쪽=시계)로만 정한다.

실행:
    python3 mqtt_stream_receiver.py                 # 수신 + 파이프라인
    python3 mqtt_stream_receiver.py --sniff         # 토픽 구경만(모델 로드 안 함)
    python3 mqtt_stream_receiver.py --target door --broker ws://pi7...:9001/mqtt

필요 패키지: pip install "paho-mqtt>=2.0"
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import queue
import re
import shutil
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import paho.mqtt.client as mqtt

# ── 브로커·토픽 (detection-protocol_0914.md §1) ─────────────────────────────
BROKER_WS_URL = "ws://pi7.tailcb6bfb.ts.net:9001/mqtt"
ROBOT_DEVICE_ID = "go1-001"
FRAME_TOPIC = f"zoneA/robot/{ROBOT_DEVICE_ID}/frame"
SCAN_TOPIC = f"zoneA/robot/{ROBOT_DEVICE_ID}/scan"
SUBSCRIBE_QOS = 1

# 로봇 명령 경로는 protobuf(`terminal/go1-001/downlink`)라 JSON을 그냥 쏘면 안 된다.
# 그래서 **기본은 발행하지 않는다.** 번역 토픽이 열리면 --publish-topic으로 준다.
# 로봇이 바로 쓸 수 있는 숫자값(turn.deg / move_forward.distance_m)은 발행 여부와
# 무관하게 navigation/evidence.json의 `robot_command`에 항상 들어간다.
NAV_RESULT_TOPIC_DEFAULT = None

# ── 스캔 ─────────────────────────────────────────────────────────────────
EXPECTED_FRAME_COUNT = 8
NOMINAL_STEP_DEG = 45.0  # 오른쪽(시계) 45도씩 -- mock_stream_receiver.ROTATION_FRAMES와 같은 전제

RUN_DIR = Path(__file__).resolve().parent / "try1"
INCOMING_DIR = RUN_DIR / "incoming"  # 로봇이 보낸 원본 프레임을 떨어뜨리는 곳

# JSON 페이로드에서 찾아볼 키 이름들. 확정 규약(`image`/`rotation_deg`/`seq`)이 맨 앞이고,
# 뒤는 규약이 조금 달라져도 받아 내기 위한 대비책이다.
# **yaw 계열은 일부러 뺐다** -- detection-protocol_0914.md가 "yaw_deg는 판마다 기준점이
# 옮겨지므로 방향 계산에 쓰면 안 된다"고 못박았다. rotation_deg가 없으면 각도를
# 추정하지 말고 그 사실이 드러나야 한다.
IMAGE_KEYS = ["image", "image_b64", "jpeg", "jpg", "frame", "data", "payload", "img"]
ROTATION_KEYS = ["rotation_deg", "rotation", "angle", "angle_deg", "deg", "theta"]
INDEX_KEYS = ["seq", "frame_index", "index", "step", "sequence"]
NAME_KEYS = ["frame", "frame_name", "filename", "name", "file"]

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
TOPIC_NUMBER = re.compile(r"(-?\d+(?:\.\d+)?)")


@dataclass
class ParsedFrame:
    """`/frame` 메시지 한 건을 푼 것."""
    image: bytes
    rotation_deg: float
    rotation_source: str
    index: int
    name: str
    mission_id: str | None = None
    duplicate_of_prev: bool = False
    sha1: str | None = None
    size_wh: tuple | None = None


@dataclass
class IncomingFrame:
    """수신 스레드 -> 처리 스레드로 넘기는 프레임. mock_stream_receiver.FrameMessage와
    같은 역할이며, 두 경로가 같은 서비스 함수를 부르도록 필드를 맞춰 뒀다."""
    frame_index: int
    frame_path: Path
    rotation_deg: float
    topic: str
    parsed: ParsedFrame


@dataclass
class ScanEvent:
    """`/scan` 메시지 한 건(scan_start / scan_end)."""
    event: str
    mission_id: str | None
    expected_frames: int | None = None
    frames_sent: int | None = None
    outcome: str | None = None
    raw: dict = field(default_factory=dict)


# ────────────────────────── 페이로드 판별 ──────────────────────────

def _looks_like_image(raw: bytes) -> bool:
    return raw.startswith(JPEG_MAGIC) or raw.startswith(PNG_MAGIC)


def _decode_b64_image(value) -> bytes | None:
    """base64 문자열(또는 data: URI)이면 이미지 바이트로 푼다."""
    if not isinstance(value, str) or len(value) < 64:
        return None
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    try:
        raw = base64.b64decode(value, validate=False)
    except (binascii.Error, ValueError):
        return None
    return raw if _looks_like_image(raw) else None


def _first_key(obj: dict, keys: list[str]):
    for key in keys:
        if key in obj and obj[key] is not None:
            return key, obj[key]
    return None, None


def _rotation_from_topic(topic: str):
    """`.../frame/45` 처럼 토픽 끝에 각도가 붙는 형태 대비(확정 규약은 아니다)."""
    for part in reversed(topic.split("/")):
        match = TOPIC_NUMBER.fullmatch(part)
        if match:
            value = float(match.group(1))
            if 0.0 <= value <= 360.0:
                return value
    return None


def parse_scan_message(topic: str, raw: bytes) -> ScanEvent | None:
    """`/scan` 메시지(판의 시작·끝)를 푼다. 아니면 None."""
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(obj, dict):
        return None
    event = obj.get("event")
    if obj.get("channel") != "scan" and event not in ("scan_start", "scan_end"):
        return None
    if event not in ("scan_start", "scan_end"):
        return None
    plan = obj.get("plan") or {}
    expected = plan.get("expected_frames") or plan.get("steps") or obj.get("expected_frames")
    return ScanEvent(
        event=event, mission_id=obj.get("mission_id"),
        expected_frames=int(expected) if expected else None,
        frames_sent=obj.get("frames_sent"), outcome=obj.get("outcome"), raw=obj)


def parse_frame_message(topic: str, raw: bytes, arrival_index: int) -> ParsedFrame | None:
    """`/frame` 메시지를 푼다. 프레임이 아니면 None.

    확정 규약(JSON + base64 `image` + `rotation_deg`)이 주 경로이고, 원시 JPEG
    바이트가 그냥 오는 경우도 받아 낸다."""
    image_bytes = None
    rotation = None
    rotation_source = None
    index = None
    name = None
    mission_id = None
    duplicate = False
    sha1 = None
    size_wh = None

    if _looks_like_image(raw):
        image_bytes = raw
    else:
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(obj, dict):
            return None
        _key, value = _first_key(obj, IMAGE_KEYS)
        image_bytes = _decode_b64_image(value)
        if image_bytes is None:
            return None

        rot_key, rot_value = _first_key(obj, ROTATION_KEYS)
        if rot_value is not None:
            try:
                rotation = float(rot_value)
                rotation_source = f"payload.{rot_key}"
            except (TypeError, ValueError):
                rotation = None
        _ikey, ivalue = _first_key(obj, INDEX_KEYS)
        if ivalue is not None:
            try:
                index = int(ivalue)
            except (TypeError, ValueError):
                index = None
        _nkey, nvalue = _first_key(obj, NAME_KEYS)
        if isinstance(nvalue, str) and nvalue:
            name = Path(nvalue).name
        mission_id = obj.get("mission_id")
        duplicate = bool(obj.get("duplicate_of_prev"))
        sha1 = obj.get("sha1")
        if obj.get("width") and obj.get("height"):
            size_wh = (int(obj["width"]), int(obj["height"]))

    if rotation is None:
        rotation = _rotation_from_topic(topic)
        if rotation is not None:
            rotation_source = "topic"

    if index is None:
        index = arrival_index
    if rotation is None:
        # 마지막 수단. 규약대로면 여기까지 오지 않는다 -- 오면 로그에 "추정"이 찍힌다.
        rotation = (index * NOMINAL_STEP_DEG) % 360.0
        rotation_source = f"도착 순서 x {NOMINAL_STEP_DEG:g}도(추정)"

    if name is None:
        name = f"frame_{index:06d}.jpg"
    if not name.lower().endswith((".jpg", ".jpeg", ".png")):
        name += ".jpg"

    return ParsedFrame(image=image_bytes, rotation_deg=rotation, rotation_source=rotation_source,
                       index=index, name=name, mission_id=mission_id,
                       duplicate_of_prev=duplicate, sha1=sha1, size_wh=size_wh)


# ────────────────────────── 판(scan round) 관리 ──────────────────────────

def _clear_previous_run() -> list[str]:
    """새 판이 시작되면 이전 판의 산출물을 지운다.

    관제 웹은 try1/을 그대로 읽어 가므로(detect_api_server.py), 지우지 않으면 버린 판의
    결과가 화면에 남는다. **프레임 폴더는 original.jpg가 들어 있는 것만** 고른다 --
    이름이 아니라 파이프라인이 만든 흔적으로 판별해서 엉뚱한 폴더를 건드리지 않는다."""
    removed = []
    if not RUN_DIR.is_dir():
        return removed
    for child in sorted(RUN_DIR.iterdir()):
        if child.is_dir() and (child / "original.jpg").is_file():
            shutil.rmtree(child)
            removed.append(child.name)
    for name in ("localization", "navigation"):
        target = RUN_DIR / name
        if target.is_dir():
            shutil.rmtree(target)
            removed.append(name + "/")
    if INCOMING_DIR.is_dir():
        for f in INCOMING_DIR.iterdir():
            if f.is_file():
                f.unlink()
    return removed


class ScanSession:
    """한 판(mission_id 하나)의 상태. 프레임을 순서대로 먹이고, 판이 정상으로 끝나면
    자기 위치 추정 -> 관측 요약 -> 경로 산출까지 이어서 돌린다."""

    def __init__(self, finder, navigator, nav_module, target: str, expected_frames: int):
        self.finder = finder
        self.navigator = navigator
        self.nav_module = nav_module
        self.target = target
        self.default_expected = expected_frames
        self.mission_id = None
        self.expected = expected_frames
        self.processed = 0
        self.rejected: list[str] = []   # 버린 프레임의 사유
        self.digests: set[str] = set()  # 판 안에서 이미 본 그림(우리 쪽 중복 검사)
        self.active = False
        self.finished = False

    # ── 판 시작 ────────────────────────────────────────────────────
    def start(self, mission_id: str | None, expected: int | None) -> None:
        self.mission_id = mission_id
        self.expected = expected or self.default_expected
        self.processed = 0
        self.rejected = []
        self.digests = set()
        self.active = True
        self.finished = False

        removed = _clear_previous_run()
        if removed:
            print(f"[scan] 이전 판 산출물 정리: {', '.join(removed)}")
        INCOMING_DIR.mkdir(parents=True, exist_ok=True)
        # 같은 파일 경로에 다른 그림이 덮이므로 depth 캐시를 반드시 비운다.
        self.navigator._depth_cache.clear()
        # 탐지 누적 결과를 초기화한다(모델은 이미 올라와 있어 다시 로드하지 않는다).
        self.finder.on_class_discovery_command(self.target)
        print(f"[scan] 새 판 시작 mission_id={mission_id} 예상 프레임={self.expected}장")

    # ── 프레임 ────────────────────────────────────────────────────
    def add_frame(self, frame: IncomingFrame) -> None:
        parsed = frame.parsed
        if not self.active:
            # scan_start를 못 받았는데 프레임이 먼저 온 경우(이벤트 유실/중간 합류).
            self.start(parsed.mission_id, None)
        elif parsed.mission_id and self.mission_id and parsed.mission_id != self.mission_id:
            print(f"[scan] mission_id가 바뀌었다({self.mission_id} -> {parsed.mission_id}) "
                  f"-- 새 판으로 본다")
            self.start(parsed.mission_id, None)

        # ── 중복 그림 검사 (detection-protocol_0914.md §2) ──
        digest = hashlib.sha1(parsed.image).hexdigest()
        if parsed.duplicate_of_prev:
            reason = (f"seq={parsed.index} 로봇이 duplicate_of_prev로 표시"
                      f"(sha1={parsed.sha1}) -- 카메라 정지 의심")
            self.rejected.append(reason)
            print(f"[scan] ✗ 프레임 버림: {reason}")
            return
        if digest in self.digests:
            reason = (f"seq={parsed.index} 이 판에서 이미 나온 그림"
                      f"(sha1={digest[:16]}) -- 로봇은 직전 한 장만 견주므로 우리가 잡았다")
            self.rejected.append(reason)
            print(f"[scan] ✗ 프레임 버림: {reason}")
            return
        self.digests.add(digest)

        if self.processed >= self.expected:
            print(f"[scan] 이번 판에 필요한 {self.expected}장을 이미 채웠다 -- "
                  f"추가 프레임 무시(seq={parsed.index})")
            return

        size = f"{parsed.size_wh[0]}x{parsed.size_wh[1]}" if parsed.size_wh else "?"
        print(f"[scan] 수신 seq={parsed.index} 회전 {parsed.rotation_deg}도 "
              f"({parsed.rotation_source}) {size} {len(parsed.image)}B -> {frame.frame_path.name}")
        self.finder.on_frame(frame.frame_path, frame.rotation_deg, self.processed)
        self.processed += 1

        # scan_end를 못 받아도 예상 장수를 채우면 끝낸다(이벤트 유실 대비).
        if self.processed >= self.expected and not self.finished:
            self.finish(outcome="SUCCEEDED", frames_sent=self.processed, by="프레임 수 충족")

    # ── 판 종료 ────────────────────────────────────────────────────
    def finish(self, outcome: str | None, frames_sent: int | None, by: str) -> None:
        if self.finished:
            return
        self.finished = True
        self.active = False

        problems = []
        if outcome and outcome.upper() != "SUCCEEDED":
            problems.append(f"로봇이 보고한 결과가 {outcome}")
        if self.rejected:
            problems.append(f"버린 프레임 {len(self.rejected)}장(중복 그림)")
        if frames_sent is not None and frames_sent != self.expected:
            problems.append(f"로봇이 보낸 장수 {frames_sent} != 예상 {self.expected}")
        if self.processed != self.expected:
            problems.append(f"처리한 장수 {self.processed} != 예상 {self.expected}")

        if problems:
            print(f"\n[scan] ✗ 이 판은 버린다 ({by}) -- " + " / ".join(problems))
            for reason in self.rejected:
                print(f"         · {reason}")
            print("[scan] 자기 위치 추정과 경로 산출을 하지 않는다. "
                  "카메라 상태를 확인하고 스캔을 다시 돌려 달라.\n")
            return

        print(f"\n[scan] ✓ {self.processed}프레임 정상 종료 ({by}) -- 자기 위치 추정 시작")
        detections = self.finder.get_detections()
        localization = self.navigator.localize(detections, target_class=self.target)
        self.navigator.save_target_observation_summary(self.target, detections, localization)
        self.navigator.on_go_to_class_command(self.target, detections, localization)
        print("[scan] 산출 완료 -- 관제 웹은 detect_api_server.py로 가져간다.\n")

    def nav_evidence(self) -> dict | None:
        path = self.nav_module.NAV_DIR / "evidence.json"
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
        return None


def _materialize_frame(parsed: ParsedFrame, topic: str) -> IncomingFrame:
    """대기열에서 꺼낸 프레임을 **메인 스레드에서** incoming/ 에 쓴다.

    scan_start 의 판 정리(_clear_previous_run)가 먼저 끝난 뒤에 쓰이므로 정리가 새 프레임을
    지울 수 없다(2026-09-14 실측 버그 -- on_message 주석 참고)."""
    INCOMING_DIR.mkdir(parents=True, exist_ok=True)
    path = INCOMING_DIR / parsed.name
    if path.exists():
        # 같은 이름이 다시 왔다. 덮어쓰면 앞 프레임의 결과 폴더(try1/<stem>/)까지
        # 통째로 섞이므로 이름을 갈라 둔다.
        stem = Path(parsed.name).stem
        n = 2
        while (INCOMING_DIR / f"{stem}_{n:02d}.jpg").exists():
            n += 1
        path = INCOMING_DIR / f"{stem}_{n:02d}.jpg"
    path.write_bytes(parsed.image)
    return IncomingFrame(frame_index=parsed.index, frame_path=path,
                         rotation_deg=parsed.rotation_deg, topic=topic, parsed=parsed)


# ────────────────────────── MQTT 연결 ──────────────────────────

def _make_client(broker_url: str, client_id: str):
    """paho-mqtt 1.x/2.x 양쪽에서 동작하도록 감싼다(2.x는 콜백 API 버전을 요구).
    ws/wss면 WebSocket, mqtt/tcp면 생 TCP(1883)로 붙는다."""
    url = urlparse(broker_url)
    websocket = url.scheme in ("ws", "wss")
    if url.scheme not in ("ws", "wss", "mqtt", "mqtts", "tcp"):
        raise SystemExit(f"ws:// wss:// mqtt:// 중 하나여야 한다: {broker_url}")
    transport = "websockets" if websocket else "tcp"
    try:  # paho-mqtt 2.x
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id=client_id,
                             transport=transport)
    except AttributeError:  # paho-mqtt 1.x
        client = mqtt.Client(client_id=client_id, transport=transport)
    if websocket:
        client.ws_set_options(path=url.path or "/mqtt")
    if url.scheme in ("wss", "mqtts"):
        client.tls_set()
    if url.username:
        client.username_pw_set(url.username, url.password or "")
    default_port = {"ws": 80, "wss": 443, "mqtt": 1883, "tcp": 1883, "mqtts": 8883}[url.scheme]
    return client, url.hostname, url.port or default_port


def _connect_or_explain(client, host: str, port: int) -> None:
    """붙지 못하는 이유는 대개 셋 중 하나(테일넷 미가입 / 이름 미해결 / 브로커가
    리스너를 안 염)라서, 트레이스백 대신 확인 순서를 보여 준다."""
    try:
        client.connect(host, port, keepalive=30)
    except OSError as exc:
        raise SystemExit(
            f"[mqtt_stream] 브로커에 붙지 못했다: {host}:{port} -- {exc}\n"
            f"  1) 이 PC가 로봇과 같은 테일넷인가:  tailscale status | grep pi7\n"
            f"  2) 이름이 풀리는가:                 tailscale ping pi7\n"
            f"  3) 브로커 리스너가 열려 있는가:     ws :9001/mqtt, 생 TCP :1883")


def run_sniff(broker_url: str, topic: str, seconds: float) -> None:
    """규약 확인용: 어떤 토픽에 무엇이 흐르는지 모양만 찍는다(파이프라인 미실행)."""
    client, host, port = _make_client(broker_url, "physical-demo-sniffer")
    seen: dict[str, int] = {}

    def on_connect(_c, _u, _f, rc):
        print(f"[sniff] 연결 rc={rc} -- '{topic}' 구독, {seconds:g}초 동안 듣는다")
        client.subscribe(topic)

    def on_message(_c, _u, msg):
        count = seen.get(msg.topic, 0) + 1
        seen[msg.topic] = count
        if count > 3:
            return
        raw = msg.payload
        if _looks_like_image(raw):
            shape = f"원시 이미지 {len(raw)}바이트"
        else:
            try:
                obj = json.loads(raw.decode("utf-8"))
                shape = (f"JSON keys={list(obj)}" if isinstance(obj, dict)
                         else f"JSON {type(obj).__name__}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                shape = f"기타 {len(raw)}바이트 (앞부분 {raw[:16]!r})"
        print(f"[sniff] {msg.topic}  ->  {shape}")

    client.on_connect = on_connect
    client.on_message = on_message
    _connect_or_explain(client, host, port)
    client.loop_start()
    time.sleep(seconds)
    client.loop_stop()
    client.disconnect()
    print("\n[sniff] 토픽별 메시지 수:")
    for name, count in sorted(seen.items(), key=lambda kv: -kv[1]):
        print(f"  {count:5d}  {name}")
    if not seen:
        print("  (없음) -- 로봇이 아직 안 보내고 있거나 토픽 필터가 안 맞는다")


# ────────────────────────── 수신 + 파이프라인 ──────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="로봇 MQTT 프레임 수신 -> 탐지 파이프라인")
    parser.add_argument("--broker", default=BROKER_WS_URL)
    parser.add_argument("--frame-topic", default=FRAME_TOPIC)
    parser.add_argument("--scan-topic", default=SCAN_TOPIC)
    parser.add_argument("--target", default="door", help="찾을 클래스(class_features.json에 있어야 한다)")
    parser.add_argument("--frames", type=int, default=EXPECTED_FRAME_COUNT,
                        help="scan_start의 plan이 없을 때 쓸 예상 장수")
    parser.add_argument("--publish-topic", default=NAV_RESULT_TOPIC_DEFAULT,
                        help="주면 경로 산출 결과(JSON)를 이 토픽으로 발행한다. "
                             "로봇 명령 경로는 protobuf라 기본은 발행하지 않는다")
    parser.add_argument("--sniff", action="store_true", help="토픽/페이로드 모양만 확인하고 끝낸다")
    parser.add_argument("--sniff-topic", default="#")
    parser.add_argument("--sniff-seconds", type=float, default=20.0)
    args = parser.parse_args()

    if args.sniff:
        run_sniff(args.broker, args.sniff_topic, args.sniff_seconds)
        return

    # 무거운 import는 sniff 모드에서 피하려고 여기서 한다(모델 로드 수십 초).
    import class_finder_service
    import navigate_to_target_service

    finder = class_finder_service.ClassFinderService()
    navigator = navigate_to_target_service.NavigateToTargetService()

    # 첫 프레임이 오기 전에 모델을 다 올려 둔다 -- 로봇은 기다려 주지 않는다.
    print(f"[mqtt_stream] 모델 로드 + 탐색 클래스 준비(target={args.target}) ...")
    finder.on_class_discovery_command(args.target)

    INCOMING_DIR.mkdir(parents=True, exist_ok=True)
    # depth를 다시 재는 쪽(navigate)이 로봇이 보낸 원본을 찾을 수 있게 폴더를
    # 명시해 준다 -- 안 하면 데이터셋 폴더에서 같은 이름의 다른 사진을 열 수 있다.
    navigate_to_target_service.FRAME_SOURCE_DIR = INCOMING_DIR

    session = ScanSession(finder, navigator, navigate_to_target_service,
                          args.target, args.frames)

    # 수신 콜백은 네트워크 스레드에서 돌고 프레임 1장 처리에 수 초가 걸리므로,
    # 콜백에서는 큐에 넣기만 하고 처리는 메인 스레드에서 한다(수신 블로킹 방지).
    inbox: queue.Queue = queue.Queue()
    arrival = {"count": 0}

    client, host, port = _make_client(args.broker, f"physical-demo-detect-{int(time.time())}")

    def on_connect(_c, _u, _f, rc):
        if rc == 0:
            client.subscribe([(args.frame_topic, SUBSCRIBE_QOS), (args.scan_topic, SUBSCRIBE_QOS)])
            print(f"[mqtt_stream] 브로커 연결됨 {host}:{port}")
            print(f"[mqtt_stream] 구독: {args.frame_topic} , {args.scan_topic} (QoS {SUBSCRIBE_QOS})")
        else:
            print(f"[mqtt_stream] 연결 실패 rc={rc}")

    def on_disconnect(_c, _u, rc):
        print(f"[mqtt_stream] 연결 끊김 rc={rc} -- 자동 재연결 시도")

    def on_message(_c, _u, msg):
        scan_event = parse_scan_message(msg.topic, msg.payload)
        if scan_event is not None:
            inbox.put(scan_event)
            return
        parsed = parse_frame_message(msg.topic, msg.payload, arrival["count"])
        if parsed is None:
            return  # 프레임도 판 이벤트도 아닌 메시지는 흘려보낸다
        arrival["count"] += 1
        # **여기서 파일을 쓰지 않는다** (2026-09-14 실측 -- 수신기가 첫 프레임에서 죽었다).
        # 로봇은 scan_start 를 보내고 30ms 뒤 0도 프레임을 보낸다. 이 스레드가 곧바로
        # incoming/ 에 쓰면, 메인 스레드가 뒤늦게 scan_start 를 처리하며 _clear_previous_run()
        # 으로 incoming/ 을 비울 때 **방금 쓴 0도 프레임까지 지운다** -> on_frame 의 imread 가
        # None -> FileNotFoundError 로 프로세스가 끝났다. 파일은 대기열 순서대로 메인 스레드가
        # 판 정리 **뒤에** 쓴다(_materialize_frame).
        inbox.put(parsed)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=10)

    print(f"[mqtt_stream] 접속 시도: {args.broker}")
    _connect_or_explain(client, host, port)
    client.loop_start()
    print("[mqtt_stream] 로봇이 스캔을 시작하기를 기다린다. (Ctrl-C로 종료)")

    try:
        while True:
            try:
                item = inbox.get(timeout=1.0)
            except queue.Empty:
                continue

            # **한 건 때문에 수신기 전체가 죽지 않게 한다** (2026-09-14). 예외는 사유와 함께
            # 적고 다음 건으로 넘어간다 -- 수신기가 조용히 사라지면 로봇은 계속 보내는데
            # 화면은 영영 비어 있다(실제로 그랬다).
            try:
                if isinstance(item, ScanEvent):
                    if item.event == "scan_start":
                        session.start(item.mission_id, item.expected_frames)
                    else:
                        session.finish(outcome=item.outcome, frames_sent=item.frames_sent,
                                       by="scan_end 수신")
                        nav = session.nav_evidence()
                        if args.publish_topic and nav is not None:
                            client.publish(args.publish_topic,
                                           json.dumps(nav, ensure_ascii=False), qos=1)
                            print(f"[mqtt_stream] 경로 결과를 '{args.publish_topic}'으로 발행했다")
                    continue

                session.add_frame(_materialize_frame(item, args.frame_topic))
            except Exception as exc:  # noqa: BLE001 -- 한 건의 실패가 수신기를 끝내면 안 된다
                import traceback
                print(f"[mqtt_stream] ✗ 한 건 처리 중 오류 -- 수신기는 계속 돈다: {type(exc).__name__}: {exc}",
                      file=sys.stderr)
                traceback.print_exc()
    except KeyboardInterrupt:
        print("\n[mqtt_stream] 종료")
    finally:
        client.loop_stop()
        client.disconnect()

    if session.active and not session.finished:
        print(f"[mqtt_stream] 경고: 판이 끝나기 전에 종료됐다 "
              f"({session.processed}/{session.expected} 프레임)", file=sys.stderr)


if __name__ == "__main__":
    main()
