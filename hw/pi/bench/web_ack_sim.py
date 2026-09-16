# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 관제 웹 시험용 ACK 시뮬레이터 (로봇 없이 규약 전 구간)
==========================================================================
웹이 `terminal/<device>/downlink` 로 명령을 걸면, **보낸 값 그대로** 진행 ACK 를
만들어 `terminal/<device>/uplink` 로 돌려준다. 로봇도 go1_sdk_pc 도 필요 없다.

    python3 -m bench.web_ack_sim                   (pi/ 디렉터리에서)
    python3 -m bench.web_ack_sim --fast            # 단계 간격 0.3초
    python3 -m bench.web_ack_sim --device go1-001  # ⚠ robot-node 를 먼저 끌 것

## 왜 bench/fake_go1_sdk 와 따로 두나

fake_go1_sdk 는 **UDP 아래**(구동 브리지)를 흉내내므로 그 위에 robot-node 가 떠
있어야 하고, robot-node 는 Go1 내부 MQTT(192.168.123.161)에 붙지 못하면
`go1_state_unavailable` 로 계속 넘어진다 — 로봇이 없는 자리에서는 그 경로가 통째로
죽는다. 이 도구는 위쪽(MQTT 규약)만 세우므로 파이 한 대와 브로커만 있으면 웹이 붙는다.

## 어디까지가 진짜인가

  진짜  규약 서버가 실물과 **같은 코드**다(common.physical_command.PhysicalCommandServer).
        멱등 재송신·deadline 거부·취소 우선·미선언 action 거부(규약 §5)가 실물과 같다.
        봉투/토픽/QoS 1 도 같고, CommandStatus.detail 의 ACK JSON 필드도
        robot_node._act_scan_mission 와 글자 그대로 같다.
  가짜  시간과 물리량. 도는 척하며 yaw 를 누적하고 시간만 흘려보낸다.
  다름  실물은 임무 중에 임무를 또 걸면 ACK 가 안 와서 예산(약 100초) 뒤 INTERNAL 로
        끝난다. 여기서는 즉시 FAILED_PRECONDITION/mission_in_progress 로 거부한다 —
        시연 준비 중에 100초를 기다리게 하는 편이 더 해롭다고 보았다.

## 웹에서 시나리오를 바꾸는 법 (실패 UI 를 만들려면 필요하다)

`terminal/<device>/sim` 에 JSON 한 줄을 던지면 그때부터 적용된다. 적용 결과는
`terminal/<device>/sim/state` 로 retained 발행하므로 늦게 붙은 화면도 현재 설정을 본다.

    {"turn_s": 0.3}                단계 간격(초). 실물 회전은 약 4초
    {"forward_mps": 0.25}          전진 속도 — 전진 ACK 까지의 대기시간이 여기서 나온다
    {"fail_at": 3}                 3번째 ACK 의 note 를 turn_timeout 으로(임무는 계속)
    {"abort_at": 5}                5번째 ACK 를 event=aborted 로 내고 CommandResult=ABORTED
    {"reject": "UNAVAILABLE"}      다음부터 모든 명령을 이 코드로 거부(""로 해제)
    {"battery": 15}                배터리 %. 20 이하면 scan_mission 이 battery_too_low 거부
    {"odo_gain": 1.14}             전진 실측/지령 비. note 의 odo= 값에 곱한다
    {"reset": true}                전부 기본값으로

실행: python3 -m bench.web_ack_sim   (pi/ 디렉터리에서)
"""
import argparse
import json
import socket
import threading
import time

import paho.mqtt.client as mqtt

from common import config, schema
from common.base_actions import BASE_ACTIONS
from common.physical_command import CommandError, PhysicalCommandServer
from common.schema import envelope

# 실물 감각에 맞춘 기본값. go1_sdk_pc 의 회전 상한은 15초이고 실측 회전은 4초쯤이다.
DEFAULT_TURN_S = 4.0
DEFAULT_FORWARD_MPS = 0.25


class Canceled(Exception):
    """취소·abort 로 단계 대기가 끊겼다. 규약 오류로 번역하는 건 호출부 몫."""


class SimRobot:
    """규약 서버가 요구하는 장치 어댑터. ACTIONS 어휘는 robot_node 와 같게 맞춘다 —
    웹이 Capability 로 만든 버튼이 실물과 달라지면 시험의 의미가 없다."""

    def __init__(self, log=print):
        self.started = time.time()
        self.log = log
        self.yaw = 0.0
        self.mission = None            # {"mission_id", "subtask", "status"}
        self.streaming = False
        self.stop = threading.Event()  # 진행 중인 단계 대기를 깨운다(취소/abort)
        self._lock = threading.Lock()
        # ---- 시나리오 손잡이(웹에서 sim 토픽으로 바꾼다) ----
        self.turn_s = DEFAULT_TURN_S
        self.forward_mps = DEFAULT_FORWARD_MPS
        self.fail_at = 0               # 0 = 안 함
        self.abort_at = 0
        self.reject = ""               # 비면 거부 안 함
        self.battery = None            # None = 모름(배터리 검사 안 함)
        self.odo_gain = 1.0

    # ================= 시나리오 =================
    def settings(self):
        return {"turn_s": self.turn_s, "forward_mps": self.forward_mps,
                "fail_at": self.fail_at, "abort_at": self.abort_at,
                "reject": self.reject, "battery": self.battery,
                "odo_gain": self.odo_gain}

    def configure(self, opts):
        """sim 토픽에서 온 설정을 적용한다. 모르는 키는 무시하고, 값이 이상하면
        그 키만 버린다 — 시험 도구가 오타 하나로 죽으면 쓸모가 없다."""
        if opts.get("reset"):
            SimRobot.__init__(self, self.log)
            return self.settings()
        for key, cast in (("turn_s", float), ("forward_mps", float),
                          ("fail_at", int), ("abort_at", int),
                          ("odo_gain", float)):
            if key in opts:
                try:
                    setattr(self, key, cast(opts[key]))
                except (TypeError, ValueError):
                    self.log(f"[sim] {key} 값을 못 읽었다: {opts[key]!r} — 무시")
        if "reject" in opts:
            self.reject = str(opts["reject"] or "")
        if "battery" in opts:
            # null 은 "모름"이다. 0.0 으로 바꾸면 방전으로 읽혀 뜻이 달라진다.
            try:
                self.battery = None if opts["battery"] is None else float(opts["battery"])
            except (TypeError, ValueError):
                self.log(f"[sim] battery 값을 못 읽었다: {opts['battery']!r} — 무시")
        return self.settings()

    # ================= 규약 어댑터 =================
    def validate(self, action, params):
        if self.reject:
            raise CommandError(self.reject, "injected_by_sim")
        if action in ("scan_mission", "move_forward", "assign_mission") and self.mission:
            raise CommandError("FAILED_PRECONDITION", "mission_in_progress")

    def cancel(self, command_id):
        """규약 §5-3 취소 — 실제 정지를 유도한다. CommandResult=CANCELED 보고는
        규약 서버가 핸들러 종료 시 낸다."""
        self.stop.set()

    def diagnostics(self):
        d = {"uptime_s": round(time.time() - self.started, 1),
             "simulated": 1.0,
             "yaw_deg": round(self.yaw, 1),
             "mission_active": 1.0 if self.mission else 0.0,
             "streaming": 1.0 if self.streaming else 0.0,
             "turn_s": self.turn_s}
        if self.battery is not None:
            d["battery_pct"] = self.battery
        return d

    # ================= 도구 =================
    def _wait(self, seconds):
        """단계 시간을 흘려보낸다. 취소가 오면 기다리다 말고 튀어나간다."""
        if self.stop.wait(seconds):
            raise Canceled()

    def _ack(self, ack, of, event, step, steps, note):
        """CommandStatus.detail 에 실을 ACK JSON.

        **필드 이름과 뜻은 robot_node._act_scan_mission 와 같아야 한다** — 웹은 실물과
        이것을 구별할 수 없어야 하고, 구별된다면 여기가 틀린 것이다."""
        self.log(f"  -> ACK {ack}/{of} {event} {step}/{steps} "
                 f"yaw={self.yaw:.1f} ({note})")
        return json.dumps({
            "ack": ack,                        # 이번 임무의 ACK 순번
            "of": of,                          # 총 ACK 수
            "event": event,                    # scan_turn | door_turn | forward | aborted
            "step": step,                      # 그 단계 안에서 몇 번째(회전 3/8 의 3)
            "steps": steps,                    # 그 단계의 총 횟수(8)
            "yaw_deg": round(self.yaw, 2),     # 그 시점 방위
            "note": note,                      # ok | turn_timeout | robot_state_lost …
        }, ensure_ascii=False)

    def _note(self, ack, bad="turn_timeout"):
        return bad if self.fail_at and ack == self.fail_at else "ok"

    def _begin(self, subtask, prefix):
        self.stop.clear()
        mission_id = "%s-%d" % (prefix, int(time.time()))
        with self._lock:
            self.mission = {"mission_id": mission_id, "subtask": subtask,
                            "status": "executing", "started_at": schema.iso_now()}
        return mission_id

    def _end(self, status):
        with self._lock:
            if self.mission:
                self.mission["status"] = status
            self.mission = None

    # ================= 명령 어휘 =================
    def _act_scan_mission(self, params):
        """오른쪽 step_deg 씩 steps 번 회전(회전마다 ACK) → forward_m 직진 ACK.
        상위는 CommandStatus 를 steps+1 번(전진 없으면 steps 번) 받고 마지막에
        CommandResult 를 받는다."""
        steps = int(params.get("steps") or 8)
        step_deg = float(params.get("step_deg") or 45.0)
        forward_m = float(params.get("forward_m") or 1.0)

        if self.battery is not None and self.battery <= config.ROBOT_BATTERY_WARN:
            raise CommandError("FAILED_PRECONDITION", "battery_too_low")

        expected = steps + (1 if forward_m > 0 else 0)
        started = time.time()
        self._begin("door_scan", "scan")
        self.log(f"[미션] 스캔 {step_deg:.0f}도 x{steps}"
                 f"{f' + 전진 {forward_m}m' if forward_m > 0 else ' (전진 없음)'}"
                 f" — ACK {expected}건 예정")
        yield "executing", {"steps": steps, "step_deg": step_deg,
                            "forward_m": forward_m, "expected_acks": expected}

        acks = turns_ok = 0
        odo_m = None
        aborted = None
        try:
            for i in range(1, steps + 1):
                self._wait(self.turn_s)
                acks += 1
                self.yaw = (self.yaw - step_deg) % 360.0      # 오른쪽 = 시계방향
                if self.abort_at and acks == self.abort_at:
                    aborted = "robot_state_lost"
                    yield self._ack(acks, expected, "aborted", i, steps, aborted), None
                    break
                note = self._note(acks)
                if note == "ok":
                    turns_ok += 1
                yield self._ack(acks, expected, "scan_turn", i, steps, note), None

            if aborted is None and forward_m > 0:
                self._wait(max(0.3, forward_m / max(self.forward_mps, 0.01)))
                acks += 1
                if self.abort_at and acks == self.abort_at:
                    aborted = "robot_state_lost"
                    yield self._ack(acks, expected, "aborted", 1, 1, aborted), None
                elif self.fail_at and acks == self.fail_at:
                    # 못 갔으면 거리는 "모름"이다 — 0 을 실으면 "제자리였다"는 거짓이 된다.
                    yield self._ack(acks, expected, "forward", 1, 1,
                                    "forward_timeout"), None
                else:
                    odo_m = round(forward_m * self.odo_gain, 2)
                    yield self._ack(acks, expected, "forward", 1, 1,
                                    f"ok odo={odo_m:.2f}m cmd={forward_m:.2f}m"), None
        except Canceled:
            self._end("failed")
            raise CommandError("ABORTED", "aborted_by_command")

        if aborted:
            self._end("failed")
            raise CommandError("ABORTED", aborted)

        self._end("completed")
        yield "state_changed", {"robot_mode": "idle"}
        result = {"acks": acks, "turns_ok": turns_ok, "steps": steps,
                  "step_deg": step_deg, "forward_m": forward_m,
                  "duration_s": round(time.time() - started, 1)}
        if odo_m is not None:
            # 모르면 키를 빼는 것이 0 을 싣는 것보다 정확하다(규약 result 는 double 맵).
            result["odo_m"] = odo_m
        yield "completed", result

    def _act_move_forward(self, params):
        """전진만. 스캔 없이 지정 거리를 직진하고 ACK 1건을 돌려준다."""
        distance_m = float(params.get("distance_m") or 1.0)
        started = time.time()
        self._begin("move_forward", "fwd")
        self.log(f"[미션] 전진만 {distance_m}m — ACK 1건 예정")
        yield "executing", {"distance_m": distance_m}

        odo_m = None
        try:
            self._wait(max(0.3, distance_m / max(self.forward_mps, 0.01)))
        except Canceled:
            self._end("failed")
            raise CommandError("ABORTED", "aborted_by_command")

        if self.abort_at == 1:
            self._end("failed")
            yield json.dumps({"ack": 1, "of": 1, "event": "aborted",
                              "yaw_deg": round(self.yaw, 2),
                              "note": "robot_state_lost"}, ensure_ascii=False), None
            raise CommandError("ABORTED", "robot_state_lost")

        if self.fail_at == 1:
            note = "forward_timeout"
        else:
            odo_m = round(distance_m * self.odo_gain, 2)
            note = f"ok odo={odo_m:.2f}m cmd={distance_m:.2f}m"
        self.log(f"  -> ACK 1/1 forward yaw={self.yaw:.1f} ({note})")
        yield json.dumps({"ack": 1, "of": 1, "event": "forward",
                          "yaw_deg": round(self.yaw, 2), "note": note},
                         ensure_ascii=False), None

        self._end("completed")
        result = {"distance_m": distance_m,
                  "duration_s": round(time.time() - started, 1)}
        if odo_m is not None:
            result["odo_m"] = odo_m
        yield "completed", result

    def _act_abort(self, params):
        """진행 중인 모든 동작을 즉시 멈춘다. 규약 취소와 달리 command_id 를 몰라도 되고
        무엇이 돌고 있든 멈춘다. `reason` 은 숫자만 실린다(규약 map<string,double>).

        ※ 안전 E-stop 이 아니다 — E-stop 은 통신과 독립인 장치 안전장치다(규약 §7)."""
        reason = params.get("reason")
        had_mission = bool(self.mission)
        mission_id = (self.mission or {}).get("mission_id")
        yield "executing", {"reason": reason}

        self.stop.set()                 # 진행 중인 임무 핸들러가 ABORTED 로 끝난다
        time.sleep(0.2)                 # 그 핸들러가 결과를 먼저 내도록 한 박자 둔다
        self.log(f"[로봇] abort — 임무={mission_id or '없음'} reason={reason} (시뮬)")

        yield "state_changed", {"robot_mode": "idle", "aborted": True}
        result = {"had_mission": 1.0 if had_mission else 0.0, "sdk_reached": 1.0}
        if reason is not None:
            result["reason"] = float(reason)
        yield "completed", result

    def _act_assign_mission(self, params):
        yield "executing", None
        self._begin("assigned", "msn")
        yield "state_changed", {"robot_mode": "mission"}
        yield "completed", {"assigned": 1.0}

    def _act_abort_mission(self, params):
        if not self.mission:
            raise CommandError("FAILED_PRECONDITION", "no_mission")
        yield "executing", None
        self.stop.set()
        self._end("aborted")
        yield "state_changed", {"robot_mode": "idle"}
        yield "completed", {"aborted": 1.0}

    def _act_stream(self, params):
        """영상 세션 여닫기. 제어만 MQTT 로 오가고 픽셀은 별도 경로다 — 시뮬에서는
        열렸다/닫혔다는 사실만 되돌려준다(픽셀은 나가지 않는다)."""
        action = params.get("action")
        if action == "start":
            yield "executing", None
            self.streaming = True
            yield "state_changed", {"streaming": True, "simulated": True}
            yield "completed", {"streaming": 1.0}
            return
        if action == "stop":
            yield "executing", None
            self.streaming = False
            yield "state_changed", {"streaming": False}
            yield "completed", {"streaming": 0.0}
            return
        raise CommandError("INVALID_ARGUMENT", "invalid_stream_action")

    ACTIONS = dict(BASE_ACTIONS, **{
        "assign_mission": _act_assign_mission,
        "abort_mission": _act_abort_mission,
        "scan_mission": _act_scan_mission,
        "move_forward": _act_move_forward,
        "abort": _act_abort,
        "stream": _act_stream,
    })
    PHYSICAL_ACTIONS = frozenset({"assign_mission", "abort_mission", "stream"})


class AckSim:
    def __init__(self, device_id, host, port, zone_id):
        self.device_id = device_id
        self.host = host
        self.port = port
        self.robot = SimRobot(log=self.log)
        self.identity = schema.Identity(
            entity_id=device_id, node_id=socket.gethostname(), zone_id=zone_id,
            mac="", ip="", entity_type="robot")
        self.base = config.TOPIC_TEMPLATE.format(
            zone=zone_id, etype="robot", eid=device_id)
        self.sim_topic = f"terminal/{device_id}/sim"
        self.hb_seq = 0
        self.client = None
        self.pcmd = PhysicalCommandServer(
            client=None, device_id=device_id, owner=self.robot, log=self.log,
            publish=lambda t, pl, qos: self.client.publish(t, pl, qos=qos),
            subscribe=lambda t, qos: self.client.subscribe(t, qos=qos))

    def log(self, *a):
        print(*a, flush=True)

    # ---------- 접속 ----------
    def connect(self):
        # client_id 를 device_id 와 다르게 둔다. 같으면 실물 노드가 같은 id 로 붙어 있을 때
        # 브로커가 서로를 끊어 두 쪽 다 못 쓰게 된다(플래핑).
        kw = {"callback_api_version": mqtt.CallbackAPIVersion.VERSION2,
              "client_id": f"{self.device_id}-sim"}
        if config.MQTT_V5:
            kw["protocol"] = mqtt.MQTTv5
        c = mqtt.Client(**kw)
        if config.MQTT_USER:
            c.username_pw_set(config.MQTT_USER, config.MQTT_PASS)
        death = envelope(self.identity)
        death.update({"channel": "status", "event": "death", "status": "offline",
                      "device_status": schema.STATUS_FAULT, "reason": "lwt",
                      "simulated": True})
        c.will_set(f"{self.base}/status", json.dumps(death, ensure_ascii=False),
                   qos=1, retain=True)
        c.on_connect = self._on_connect
        c.on_message = self._on_message
        c.reconnect_delay_set(min_delay=1, max_delay=config.RECONNECT_MAX_DELAY)
        self.client = c
        c.connect_async(self.host, self.port, keepalive=config.KEEPALIVE)
        c.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if getattr(reason_code, "is_failure", False):
            self.log(f"[sim] 접속 실패: {reason_code}")
            return
        self.log(f"[sim] 브로커 접속 {self.host}:{self.port}")
        self.pcmd.start()                      # downlink 구독 + Capability 발행
        client.subscribe(self.sim_topic, qos=1)
        self.publish_status("birth")
        self.publish_sim_state()
        self.log(f"[sim] 시나리오 토픽 구독 {self.sim_topic}")

    def _on_message(self, client, userdata, msg):
        if msg.topic == self.pcmd.downlink:
            self.pcmd.on_message(msg.payload)
            return
        if msg.topic == self.sim_topic:
            try:
                opts = json.loads(msg.payload.decode("utf-8", "replace"))
            except ValueError as e:
                self.log(f"[sim] 시나리오 JSON 아님: {e}")
                return
            if not isinstance(opts, dict):
                self.log("[sim] 시나리오는 JSON 객체여야 한다")
                return
            self.log(f"[sim] 시나리오 적용 {self.robot.configure(opts)}")
            self.publish_sim_state()

    # ---------- 발행 ----------
    def publish_status(self, event):
        payload = envelope(self.identity)
        payload.update({
            "channel": "status", "event": event,
            "status": "offline" if event == "shutdown" else "online",
            "device_status": schema.STATUS_OK,
            "simulated": True,                 # 실물과 헷갈리지 않게 표시한다
            "uptime_s": round(time.time() - self.robot.started, 1),
        })
        self.client.publish(f"{self.base}/status",
                            json.dumps(payload, ensure_ascii=False),
                            qos=1, retain=True)

    def publish_sim_state(self):
        payload = dict(self.robot.settings())
        payload["timestamp"] = schema.iso_now()
        self.client.publish(f"{self.sim_topic}/state",
                            json.dumps(payload, ensure_ascii=False),
                            qos=1, retain=True)

    def tick_heartbeat(self):
        payload = envelope(self.identity, seq=self.hb_seq)
        payload["channel"] = "heartbeat"
        payload["simulated"] = True
        self.client.publish(f"{self.base}/heartbeat",
                            json.dumps(payload, ensure_ascii=False), qos=0)
        self.hb_seq += 1

    # ---------- 본체 ----------
    def run(self):
        self.connect()
        self.log(f"[sim] 장치 {self.device_id} — 명령을 기다린다\n"
                 f"       받는다 terminal/{self.device_id}/downlink\n"
                 f"       보낸다 terminal/{self.device_id}/uplink  (QoS 1)\n"
                 f"       시나리오 {self.sim_topic}")
        try:
            while True:
                time.sleep(config.HB_INTERVAL)
                if self.client.is_connected():
                    self.tick_heartbeat()
        except KeyboardInterrupt:
            self.log("\n[sim] 종료")
            if self.client.is_connected():
                self.publish_status("shutdown")
                time.sleep(0.2)
            self.client.loop_stop()
            self.client.disconnect()


def main():
    ap = argparse.ArgumentParser(
        description="관제 웹 시험용 ACK 시뮬레이터 (로봇 없이 규약 응답 전 구간)")
    ap.add_argument("--device", default="go1-sim",
                    help="장치 id. 토픽이 이 값으로 정해진다. 실물과 같은 go1-001 을 쓰려면 "
                         "robot-node 를 먼저 꺼야 한다(둘 다 답해서 응답이 겹친다)")
    ap.add_argument("--broker", default=config.BROKER_HOST)
    ap.add_argument("--port", type=int, default=config.BROKER_PORT)
    ap.add_argument("--zone", default=config.ZONE_ID)
    ap.add_argument("--turn-s", type=float, default=DEFAULT_TURN_S,
                    help=f"회전 1회에 걸리는 시간(초). 기본 {DEFAULT_TURN_S} = 실측값")
    ap.add_argument("--forward-mps", type=float, default=DEFAULT_FORWARD_MPS,
                    help="전진 속도(m/s). 전진 ACK 까지의 대기시간이 여기서 나온다")
    ap.add_argument("--fast", action="store_true",
                    help="단계 간격을 0.3초로 — 웹 화면을 빠르게 돌려볼 때")
    ap.add_argument("--fail-at", type=int, default=0,
                    help="N번째 ACK 의 note 를 timeout 으로(임무는 계속)")
    ap.add_argument("--abort-at", type=int, default=0,
                    help="N번째 ACK 를 event=aborted 로 내고 CommandResult=ABORTED")
    ap.add_argument("--reject", default="",
                    help="모든 명령을 이 규약 코드로 거부(예: UNAVAILABLE)")
    ap.add_argument("--battery", type=float, default=None,
                    help="배터리 %%. 20 이하면 scan_mission 이 battery_too_low 로 거부된다")
    args = ap.parse_args()

    sim = AckSim(args.device, args.broker, args.port, args.zone)
    sim.robot.configure({
        "turn_s": 0.3 if args.fast else args.turn_s,
        "forward_mps": 1.0 if args.fast else args.forward_mps,
        "fail_at": args.fail_at, "abort_at": args.abort_at,
        "reject": args.reject, "battery": args.battery,
    })
    sim.run()


if __name__ == "__main__":
    main()
