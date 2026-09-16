# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 스캔 → 객체탐지 연동 다리 (HW-R-05 / HW-R-07)
================================================================
스캔 임무가 도는 것을 **옆에서 지켜보다가** 방향마다 사진 한 장을 탐지 담당 쪽으로 보낸다.

    python3 -m robot.detect_bridge --url http://ubuntu3-15ug50p-gp55kn:8000
    python3 -m robot.detect_bridge --device go1-sim --dry-run     # 시뮬로 경로만 확인

## 왜 로봇 노드 안에 넣지 않았나

넣으면 명령 처리 경로에 ffmpeg 수명 관리와 HTTP 왕복이 들어온다. 탐지 노트북이 꺼져
있거나 느릴 때 **임무 자체가 밀린다.** 임무는 로봇의 본업이고 탐지 전송은 부업이다 —
부업이 본업을 막으면 안 된다. 그래서 규약 uplink 를 구독해 따라가기만 하고, 실패해도
로봇은 아무 영향을 받지 않는다. `bench/go1_scan_capture.py --follow` 와 같은 방식이다.

## 무엇을 보고 무엇을 보내나

규약 uplink(`terminal/<device>/uplink`)의 CommandStatus 를 읽는다.

| 본 것 | 보내는 것 |
|---|---|
| `expected_acks` 가 담긴 첫 진행 보고 | 한 판 시작 + **0도 사진 1장** |
| `event: "scan_turn"` 진행 보고 | 그 방향의 사진 1장 (45·90·…·315도) |
| CommandResult (종료) | 한 판 끝 |

## 왜 0도 사진을 시작 시점에 찍나

탐지 요구(2026-09-14 §1-②)가 **`rotation_deg = 0` 인 첫 프레임이 스캔 시작 시점의 로봇
정면**이라고 못박았다. 회전을 마친 뒤에 찍으면 한 바퀴(360도)를 돌고 온 자세라 각도는
같아도 오도메트리·IMU 오차가 누적된 다음이다. 그래서 **돌기 전에** 한 장 집는다.

이때는 기다리지 않고 곧바로 집는다 — 링에 있는 최신 완성 프레임이 이미 회전 이전의
것이기 때문이다(5 fps 라 최대 0.4초 전). 기다렸다 집으면 그 사이에 돌기 시작한다.

마지막 걸음(steps 번째)에서는 찍지 않는다. 한 바퀴를 다 돌아 0도로 돌아온 자리라
첫 장과 겹친다. 결과적으로 `steps` 장이 0·45·…·315 도를 한 번씩 덮는다.

한 바퀴 뒤 추가 회전(`door_turn`)은 없어졌다. 옛 펌웨어가 보내면 사진을 보내지 않는다
(`--with-door` 로 켤 수 있다). 탐지 결과는 **돌아오지 않는다** — 탐지 쪽이
가시화 웹으로 직접 보낸다.

## 사진을 집는 시점

ACK 는 로봇이 막 멈춘 순간에 온다. 거기서 `--settle`(기본 0.6초) 기다렸다 집어야
흔들리지 않은 그림이 나온다. 회전 중에 집으면 전부 흐리다. 그 기다림이 MQTT 수신을
막지 않도록 **집기·보내기는 별도 스레드**에서 순서대로 처리한다.

## 링 버퍼는 상시 돌린다

임무가 시작될 때 ffmpeg 를 띄우면 첫 프레임이 나오기까지 몇 초가 걸려 첫 방향을 놓친다.
그래서 카메라 스트림을 계속 디코드해 두고 필요한 순간에 집기만 한다(5 fps, 저부하).
카메라가 끊기면 감시 스레드가 다시 띄운다 — 로봇 전원이 오르내려도 알아서 붙는다.
"""
import argparse
import hashlib
import json
import os
import queue
import socket
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import paho.mqtt.client as mqtt                      # noqa: E402

from common import config, physical_command_pb2 as pb  # noqa: E402
from robot import detect_sink                         # noqa: E402
from robot.frame_ring import FrameRing                # noqa: E402
from robot.go1_camera import CAMS                     # noqa: E402


# 링이 5 fps 라 5초면 프레임 25장을 놓친 것이다. 이보다 오래된 그림은 보내지 않는다.
RING_STALE_S = 5.0


def jpeg_size(data):
    """JPEG 의 SOF 세그먼트에서 가로·세로를 읽는다. 탐지 쪽이 해상도를 미리 알아야
    판정 기준을 맞출 수 있어서 실어 보낸다(실측 464x400 — 1280x720 이 아니다)."""
    i = 2
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            return (data[i + 7] << 8 | data[i + 8],      # width
                    data[i + 5] << 8 | data[i + 6])      # height
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + (data[i + 2] << 8 | data[i + 3])
    return (None, None)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Mission:
    """진행 중인 스캔 한 바퀴."""

    def __init__(self, command_id, detail):
        self.command_id = command_id
        self.mission_id = f"scan-{int(time.time())}"
        self.steps = int(detail.get("steps") or 0)
        self.step_deg = float(detail.get("step_deg") or 0.0)
        self.expected = int(detail.get("expected_acks") or 0)
        self.started_at = time.time()
        self.seq = 0
        self.frames = 0


class DetectBridge:
    def __init__(self, args):
        self.args = args
        self.topic_base = config.TOPIC_TEMPLATE.format(
            zone=args.zone_id, etype="robot", eid=args.device)
        self.sink = detect_sink.create(self.topic_base, args.device,
                                       url=args.url, broker=args.broker,
                                       port=args.broker_port, log=log).start()
        self.mission = None
        self.ring = None
        self.cam_id = args.cam
        self.shots = queue.Queue(maxsize=32)
        self._notify_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.prev_sha = None        # 직전에 보낸 프레임 — 같은 그림이 반복되는지 본다
        # downlink 에서 본 scan_mission 명령. command_id -> 계획(steps, step_deg).
        # 진행 보고에는 계획이 실리지 않아서 명령 쪽에서 미리 알아 둔다(아래 on_message 참조).
        self.pending = {}
        self.identity = {"source_id": args.device, "node_id": args.node_id,
                         "zone_id": args.zone_id}
        self._stop = threading.Event()

    # ---------- 링 버퍼 ----------
    def start_ring(self):
        if self.args.dry_run:
            log("[링] --dry-run: 카메라를 열지 않는다")
            return
        threading.Thread(target=self._ring_supervisor, daemon=True).start()

    def _ring_supervisor(self):
        """카메라가 끊기면 다시 띄운다. 로봇 전원이 오르내려도 알아서 붙게."""
        while not self._stop.is_set():
            ring = FrameRing(self.args.ring_dir, cam_id=self.cam_id,
                             quality=self.args.quality)
            try:
                ring.start()
            except OSError as e:
                log(f"[링] 기동 실패: {e} — 10초 뒤 재시도")
                self._stop.wait(10.0)
                continue
            if ring.wait_ready(timeout=15.0):
                self.ring = ring
                log(f"[링] 카메라 {self.cam_id}({CAMS[self.cam_id][2]}) 프레임 확보")
            else:
                log(f"[링] 첫 프레임 없음({ring.error}) — 10초 뒤 재시도")
                ring.close()
                self._stop.wait(10.0)
                continue
            # 살아 있는 동안 지켜본다.
            while not self._stop.wait(3.0):
                if ring.error:
                    log(f"[링] 스트림 끊김: {ring.error} — 다시 띄운다")
                    break
                # 오류 없이 **멈추기만** 한 경우도 잡는다(웹소켓이 조용히 닫히거나 막힘).
                age = ring.last_frame_age()
                if age is not None and age > RING_STALE_S:
                    log(f"[링] {age:.0f}초째 새 프레임 없음 — 다시 띄운다")
                    break
            self.ring = None
            ring.close()

    # ---------- 촬영·전송 (전용 스레드, 순서 보존) ----------
    def start_shooter(self):
        threading.Thread(target=self._shooter, daemon=True).start()

    def _shooter(self):
        while not self._stop.is_set():
            item = self.shots.get()
            if item is None:
                break
            meta, grab_at = item
            # 로봇이 막 멈춘 뒤라 조금 기다려야 흔들리지 않는다.
            delay = grab_at - time.time()
            if delay > 0:
                time.sleep(delay)
            image = self._grab()
            if image is None:
                log(f"[촬영] seq={meta['seq']} 프레임 없음 — 건너뛴다")
                self._notify(meta, sent=False)
                continue
            w, h = jpeg_size(image)
            sha = hashlib.sha1(image).hexdigest()
            # 직전과 **바이트까지 같은** 그림이면 카메라가 얼어붙었거나 링이 안 돌고 있다.
            # Go1 은 정지해도 30fps 로 계속 내보내므로 프레임률로는 알 수 없다 —
            # 그림의 변화로만 판정할 수 있다(robot/go1_camera.py 참조). 실측 2026-09-14:
            # 링이 막 붙은 직후 8장이 전부 같은 그림으로 나갔다. 탐지 쪽은 같은 사진
            # 8장을 받고도 그것이 8방향인 줄 안다 — 반드시 드러내야 한다.
            meta["sha1"] = sha[:16]
            if sha == self.prev_sha:
                meta["duplicate_of_prev"] = True
                log(f"[경고] seq={meta['seq']} 직전과 같은 그림이다 "
                    f"— 카메라 정지 의심(sha {sha[:10]})")
            self.prev_sha = sha
            meta.update(bytes=len(image), width=w, height=h,
                        captured_at_unix=round(time.time(), 3))
            self.sink.frame(meta, image)
            self._notify(meta, sent=True)
            if self.mission:
                self.mission.frames += 1
            log(f"[촬영] seq={meta['seq']} rotation={meta['rotation_deg']}deg "
                f"{w}x{h} {len(image)}B → 전송")

    def _notify(self, meta, sent):
        """로봇 노드에 "이 촬영의 /frame 이 나갔다(또는 못 나갔다)"를 알린다.

        스캔이 hold_after_capture 로 돌 때 노드는 이 알림을 받고서야 촬영 뒤 대기에
        들어간다. 듣는 쪽이 없으면 UDP 가 그냥 사라진다 — 임무에는 영향이 없다."""
        msg = {"command_id": meta.get("command_id"), "seq": meta.get("seq"),
               "rotation_deg": meta.get("rotation_deg"), "sent": sent}
        try:
            self._notify_sock.sendto(json.dumps(msg).encode(),
                                     ("127.0.0.1", config.DETECT_NOTIFY_PORT))
        except OSError:
            pass

    def _grab(self):
        if self.args.dry_run:
            return b"\xff\xd8\xff\xdb" + b"\x00" * 512 + b"\xff\xd9"   # 최소 JPEG 흉내
        ring = self.ring
        if ring is None:
            return None
        # 감시 스레드가 알아차리기 전이라도 **오래된 그림은 보내지 않는다.** 멈춘 링에서
        # 집으면 방향만 바뀐 같은 사진이 나가고, 탐지는 그걸 8방향으로 오해한다.
        age = ring.last_frame_age()
        if age is None or age > RING_STALE_S:
            log(f"[촬영] 링의 최신 프레임이 {age if age is None else round(age)}초 전 것 — 보내지 않는다")
            return None
        tmp = os.path.join(self.args.ring_dir, "_shot.jpg")
        try:
            if ring.grab(tmp) is None:
                return None
            with open(tmp, "rb") as f:
                return f.read()
        except OSError as e:
            log(f"[촬영] 집기 실패: {e}")
            return None

    # ---------- 규약 uplink 따라가기 ----------
    def on_message(self, client, userdata, msg):
        env = pb.PhysicalCommandEnvelope()
        try:
            env.ParseFromString(msg.payload)
        except Exception:
            return
        which = env.WhichOneof("body")
        # downlink 는 명령을 미리 알아 두는 용도다. 로봇에 아무것도 보내지 않는다.
        if msg.topic.endswith("/downlink"):
            if which == "command":
                self._on_command(env.command)
            return
        if which == "acceptance":
            if not env.acceptance.accepted:
                self.pending.pop(env.acceptance.command_id, None)   # 거부 — 임무 없음
        elif which == "status":
            self._on_status(env.status)
        elif which == "result":
            self._on_result(env.result)

    def _on_command(self, cmd):
        """scan_mission 명령을 미리 알아 둔다.

        ## 왜 명령을 봐야 하나 (실측 2026-09-14 버그)

        규약 서버는 진행 보고에 핸들러가 낸 `(stage, detail)` 중 **stage 만** 싣는다.
        스캔 임무의 첫 보고는 `yield "executing", {"steps":…, "expected_acks":…}` 라서
        실제로 나가는 것은 `"executing"` 문자열뿐이고 계획은 버려진다. 이 다리는 처음에
        `expected_acks` 가 담긴 보고를 기다렸는데 그게 끝내 오지 않아, 실물 스캔을 한 번도
        따라가지 못했다(합성 시험은 그 값을 직접 실어 보내서 버그를 가렸다).

        그래서 계획은 명령에서 가져온다. 명령은 수락·실행보다 먼저 지나가므로 늦지 않다."""
        if cmd.action != "scan_mission":
            return
        p = dict(cmd.parameters)
        # 노드와 같은 기본값. 0 을 "안 준 값"으로 보지 않는다(키가 없을 때만 기본값).
        self.pending[cmd.command_id] = {
            "steps": int(p["steps"]) if "steps" in p else 8,
            "step_deg": float(p["step_deg"]) if "step_deg" in p else 45.0,
            "at": time.time()}
        # 수락·실행이 안 온 채 쌓인 것은 버린다(거부됐거나 브로커를 놓쳤다).
        for cid in [c for c, v in self.pending.items() if time.time() - v["at"] > 120]:
            self.pending.pop(cid, None)

    def _start_mission(self, command_id, steps, step_deg, take_zero=True):
        """한 판을 연다. take_zero 면 돌기 전 정면(0도)을 곧바로 집는다."""
        self.mission = m = Mission(command_id, {"steps": steps, "step_deg": step_deg,
                                                "expected_acks": steps})
        meta = dict(self.identity,
                    mission_id=m.mission_id, command_id=m.command_id,
                    camera={"camera_id": self.cam_id,
                            "position": CAMS[self.cam_id][2]},
                    plan={"steps": m.steps, "step_deg": m.step_deg,
                          "expected_frames": m.steps},
                    started_at_unix=round(m.started_at, 3))
        self.prev_sha = None          # 판이 바뀌면 비교 기준도 새로
        self.sink.mission_start(meta)
        log(f"[임무] 시작 {m.mission_id} — {m.step_deg:.0f}도 x{m.steps} "
            f"(사진 {m.steps}장 예정)")
        if take_zero:
            # 돌기 전의 정면 = rotation_deg 0. 기다리지 않고 곧바로 집는다.
            self._queue_shot(m, seq=0, step=0, rotation=0.0,
                             event="scan_start", yaw=None, note=None, settle=0.0)
        return m

    def _on_status(self, st):
        # [1] 한 바퀴 시작. 실제 규약에서는 계획 없이 "executing" 문자열만 온다.
        #     이 보고는 구동 브리지가 회전을 건 **직후**에 나가므로, 링의 최신 완성 프레임은
        #     아직 돌기 전의 그림이다(5 fps — 최대 0.4초 전).
        if st.detail == "executing" and st.command_id in self.pending:
            plan = self.pending.pop(st.command_id)
            self._start_mission(st.command_id, plan["steps"], plan["step_deg"])
            return

        try:
            detail = json.loads(st.detail)
        except (ValueError, TypeError):
            return
        if not isinstance(detail, dict):
            return

        # 계획이 JSON 으로 실려 오는 경로(시뮬레이터·향후 규약)도 받는다.
        if "expected_acks" in detail and float(detail.get("step_deg") or 0) > 0:
            self.pending.pop(st.command_id, None)
            self._start_mission(st.command_id, int(detail.get("steps") or 8),
                                float(detail["step_deg"]))
            return

        # [2][3] 한 방향을 다 돌았다 — 사진 한 장 + 그때의 각도.
        event = detail.get("event")
        if event not in ("scan_turn", "door_turn"):
            return
        m = self.mission
        if m is None or m.command_id != st.command_id:
            # 명령을 못 본 채 임무가 이미 돌고 있다(다리가 도중에 재시작했거나 브로커를
            # 놓쳤다). 버리지 말고 ACK 로 판을 연다. 회전각은 한 바퀴를 steps 로 나눈 값이다.
            # 0도 사진은 이미 지나갔으므로 찍지 않는다 — 없는 사진을 지어내지 않는다.
            steps = int(detail.get("steps") or 8)
            log(f"[임무] 시작을 못 봤다 — {event} step={detail.get('step')} 에서 판을 연다 "
                f"(0도 사진 없음)")
            m = self._start_mission(st.command_id, steps, 360.0 / steps, take_zero=False)
        step = int(detail.get("step") or 0)

        if event == "door_turn":
            if not self.args.with_door:
                return
            self._queue_shot(m, seq=m.steps, step=step, rotation=None,
                             event=event, yaw=detail.get("yaw_deg"),
                             note=detail.get("note"))
            return

        # 마지막 걸음은 한 바퀴를 다 돌아 0도로 돌아온 자리 — 첫 장과 겹친다.
        if step >= m.steps:
            return
        self._queue_shot(m, seq=step, step=step,
                         rotation=round((m.step_deg * step) % 360.0, 1),
                         event=event, yaw=detail.get("yaw_deg"),
                         note=detail.get("note"))

    def _queue_shot(self, m, seq, step, rotation, event, yaw, note, settle=None):
        """한 장을 촬영 대기열에 올린다. 실제 집기·전송은 전용 스레드가 순서대로 한다."""
        meta = dict(self.identity,
                    mission_id=m.mission_id, command_id=m.command_id,
                    seq=seq, event=event, step=step, steps=m.steps,
                    rotation_deg=rotation, yaw_deg=yaw, note=note,
                    camera={"camera_id": self.cam_id,
                            "position": CAMS[self.cam_id][2]})
        delay = self.args.settle if settle is None else settle
        try:
            self.shots.put_nowait((meta, time.time() + delay))
        except queue.Full:
            log(f"[촬영] 큐가 찼다 — seq={seq} 건너뛴다")

    def _on_result(self, res):
        self.pending.pop(res.command_id, None)
        m = self.mission
        if m is None or res.command_id != m.command_id:
            return
        self.mission = None
        status = {0: "UNSPECIFIED", 1: "SUCCEEDED", 2: "ABORTED", 3: "CANCELED"}
        # 아직 큐에 남은 사진이 있을 수 있다. 다 나간 뒤에 끝을 알린다.
        def finish():
            end = time.time() + 20.0
            while not self.shots.empty() and time.time() < end:
                time.sleep(0.2)
            meta = dict(self.identity, mission_id=m.mission_id,
                        command_id=m.command_id,
                        outcome=status.get(res.status, "?"),
                        frames_sent=m.frames,
                        expected_frames=m.steps,
                        duration_s=round(time.time() - m.started_at, 1),
                        sink=self.sink.stats())
            self.sink.mission_end(meta)
            log(f"[임무] 끝 {m.mission_id} {status.get(res.status,'?')} — "
                f"사진 {m.frames}/{m.steps}장, 송신 {self.sink.stats()}")
        threading.Thread(target=finish, daemon=True).start()

    # ---------- 수명 ----------
    def run(self):
        self.start_ring()
        self.start_shooter()
        topic = f"terminal/{self.args.device}/uplink"
        down = f"terminal/{self.args.device}/downlink"
        c = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                        client_id=f"detect-bridge-{int(time.time())}",
                        protocol=mqtt.MQTTv5)
        # downlink 도 구독한다 — 명령에서 계획을 읽기 위해서다(_on_command). 발행은 하지 않는다.
        c.on_connect = lambda cl, u, f, rc, p=None: (
            cl.subscribe([(topic, 1), (down, 1)]),
            log(f"[규약] 구독 {topic} · {down}"))
        c.on_message = self.on_message
        c.reconnect_delay_set(min_delay=1, max_delay=config.RECONNECT_MAX_DELAY)
        c.connect_async(self.args.broker, self.args.broker_port,
                        keepalive=config.KEEPALIVE)
        c.loop_start()
        log(f"[다리] 대기 중 — 스캔 임무가 시작되면 따라간다")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        finally:
            self._stop.set()
            self.shots.put(None)
            self.sink.close()
            c.loop_stop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=config.DETECT_URL,
                    help="탐지 담당 쪽 기준 주소 (예: http://ubuntu3-...:8000)")
    ap.add_argument("--device", default="go1-001")
    ap.add_argument("--broker", default=config.BROKER_HOST)
    ap.add_argument("--broker-port", type=int, default=config.BROKER_PORT)
    ap.add_argument("--node-id", default="pi7")
    ap.add_argument("--zone-id", default=config.ZONE_ID)
    ap.add_argument("--cam", type=int, default=config.DETECT_CAM_ID)
    ap.add_argument("--ring-dir", default=config.DETECT_RING_DIR)
    ap.add_argument("--quality", type=int, default=config.DETECT_JPEG_QUALITY)
    ap.add_argument("--settle", type=float, default=config.DETECT_SETTLE_S,
                    help="ACK 뒤 이만큼 기다렸다 집는다(흔들림 방지)")
    ap.add_argument("--timeout", type=float, default=config.DETECT_TIMEOUT)
    ap.add_argument("--transport", default=config.DETECT_TRANSPORT,
                    choices=["mqtt", "http", "both"],
                    help="mqtt=사진+각도를 한 메시지로 발행(기본) | http=탐지 쪽에 POST")
    ap.add_argument("--with-door", action="store_true",
                    help="문 방향 회전에서도 한 장 보낸다(기본은 스캔 걸음만)")
    ap.add_argument("--dry-run", action="store_true",
                    help="카메라를 열지 않고 더미 이미지로 경로만 확인한다")
    args = ap.parse_args()
    config.DETECT_TRANSPORT = args.transport      # create() 가 이 값을 본다
    if args.transport in ("http", "both") and not args.url:
        sys.exit("--url 또는 HW_DETECT_URL 이 필요하다 (탐지 담당 쪽 HTTP 주소)")
    DetectBridge(args).run()


if __name__ == "__main__":
    main()
