"""
피지컬팀 mk2 — 말단 노드 공통 코어 (HW-C 계열)
================================================
센서노드·로봇 온보드·액추에이터 제어노드가 공유하는 생애주기를 담는다. 세 노드는
계측 원천과 보고 정책, 명령 어휘만 다르고 아래는 전부 같다.

  HW-C-04  등록(Birth)·Death + 상태 요약 10초 주기
  HW-C-06  명령 수신·ACK + 결과 4단계 승격 (commands.py)
  HW-C-07  식별자 + 네트워크·구역 변경 시 재등록
  HW-C-05  자기 관측 metric 5종 OTLP 발신 (otel_metrics.py)
  HW-R-09  두절 시 버퍼링·재전송 (spool.py)
  HW-S-05  하트비트 (노드가 억제할 수 있다 — 로봇은 임무 중 정지)
  HW-S-08  전 메시지 타임스탬프

설계 원칙 P1(SDD): 이 층은 **네트워크에 의존하지 않는다.** 브로커·엣지·오케스트레이터가
전부 죽어도 계측과 판정과 버퍼링은 계속된다. 그래서 systemd 로 상주시키고 k3s 에
넣지 않는다 — k3s agent 는 제어평면에 연결되지 못하면 기동조차 못하기 때문이다.

하위 클래스가 채우는 훅
    on_sample(now)          계측 수집과 보고 판정. 노드마다 완전히 다르다
    heartbeat_enabled()     False 면 하트비트를 건너뛴다 (HW-R-02)
    device_status_extra()   노드 고유의 fault/degraded 조건
    status_extra()          상태 요약에 덧붙일 노드 고유 필드
    diagnostics()           diag 명령이 돌려줄 내용
    ACTIONS / PHYSICAL_ACTIONS   노드 고유 명령 어휘
"""
import json
import signal
import time
from collections import deque

import paho.mqtt.client as mqtt

from common import config, otel_metrics, otel_trace, schema
from common.base_actions import BASE_ACTIONS
from common.physical_command import PhysicalCommandServer
from common.schema import Identity, envelope
from common.spool import EVENT, Spool


class BaseNode:
    ENTITY_TYPE = "node"          # 토픽 2번째 칸. 하위가 덮어쓴다
    ACTIONS = dict(BASE_ACTIONS)
    PHYSICAL_ACTIONS = frozenset()

    def __init__(self):
        self.identity = Identity.resolve(self.ENTITY_TYPE)
        self.base = self.identity.topic_base
        self.spool = Spool(config.SPOOL_PATH, config.SPOOL_MAX,
                           config.SPOOL_REPLAY_BATCH, config.SPOOL_DOWNSAMPLE_S)
        self.metrics = otel_metrics.create(self.identity)
        self.traces = otel_trace.create(self.identity)   # 명령 경로만 (10-3)

        self.connected = False
        self.started = time.time()
        self.hb_seq = 0
        self.seq = 0

        self.pub_fail = 0
        self._inflight = {}           # mid -> 발행 시각 (지연 metric 산출용)
        self._connects = deque()      # 접속 시각 — client_id 중복(플래핑) 판정용

        self.client = None
        # 물리 명령 통신 규약(정본): Protobuf 봉투 / terminal/<id>/downlink|uplink.
        # publish/subscribe 는 어댑터로 넘겨 재접속으로 client 가 갈려도 항상 현재 것을 쓴다.
        self.pcmd = PhysicalCommandServer(
            client=None, device_id=self.identity.entity_id, owner=self,
            publish=lambda t, pl, qos: self.client.publish(t, pl, qos=qos),
            subscribe=lambda t, qos: self.client.subscribe(t, qos=qos))
        self._connect()

    # ================= 접속 =================
    def _connect(self):
        """클라이언트를 새로 만들어 붙인다. LWT는 접속 전에만 걸 수 있어서,
        구역 변경으로 토픽이 바뀌면 재접속이 가장 확실한 방법이다."""
        kw = {"callback_api_version": mqtt.CallbackAPIVersion.VERSION2,
              "client_id": self.identity.entity_id}
        if config.MQTT_V5:
            kw["protocol"] = mqtt.MQTTv5          # BE-T-01: 말단↔엣지 MQTT 5.0 확정
        c = mqtt.Client(**kw)

        if config.MQTT_USER:
            c.username_pw_set(config.MQTT_USER, config.MQTT_PASS)
        if config.TLS_CA:                          # BE-T-01의 TLS — 인증서 준비 시 활성
            c.tls_set(ca_certs=config.TLS_CA,
                      certfile=config.TLS_CERT or None,
                      keyfile=config.TLS_KEY or None)

        # Death(LWT): 급사하면 브로커가 대신 발행한다. payload는 접속 시점에 고정되므로
        # 여기 timestamp는 "죽은 시각"이 아니라 "접속한 시각"이다 — 실제 단절 시각은
        # 서버 판정(BE-T-04 availability)이 브로커 수신 시각으로 매긴다.
        death = envelope(self.identity)
        death.update({"channel": "status", "event": "death", "status": "offline",
                      "device_status": schema.STATUS_FAULT, "reason": "lwt"})
        c.will_set(f"{self.base}/status", json.dumps(death, ensure_ascii=False),
                   qos=1, retain=True)

        c.on_connect = self._on_connect
        c.on_disconnect = self._on_disconnect
        c.on_message = self._on_message
        c.on_publish = self._on_publish

        self.client = c
        # paho 기본 재접속 백오프는 최대 120초까지 늘어난다. 두절이 길었을수록
        # 복구가 늦어지는데, 재난 대응에서는 정확히 반대여야 한다 — 오래 끊겼을수록
        # 밀린 데이터가 많아 빨리 붙어야 한다. 실측에서 20초 두절 뒤 재접속까지
        # 1분 넘게 걸린 것을 확인해 상한을 둔다.
        c.reconnect_delay_set(min_delay=1, max_delay=config.RECONNECT_MAX_DELAY)
        # connect_async + loop_start: 브로커가 아직 안 떠 있어도 계속 재시도하고,
        # 끊겨도 스스로 다시 붙는다. 그 사이의 계측값은 spool 이 받아준다(HW-R-09).
        c.connect_async(config.BROKER_HOST, config.BROKER_PORT, keepalive=config.KEEPALIVE)
        c.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code != 0:
            print(f"[접속 실패] {reason_code}")
            return
        self.connected = True
        print(f"[접속] {config.BROKER_HOST}:{config.BROKER_PORT} — {self.base}")
        self._flap_check()
        self.pcmd.start()                     # 규약 downlink 구독 + Capability 발행
        self.publish_status("birth")          # HW-C-04 등록
        if self.spool.pending:
            print(f"[버퍼] 미전송 {self.spool.pending}건 재전송 시작 (HW-R-09)")

    def _on_disconnect(self, client, userdata, flags=None, reason_code=None, properties=None):
        self.connected = False
        rc = getattr(reason_code, "value", reason_code)
        if rc == 142:                      # MQTT 5.0 0x8E "Session taken over"
            self._duplicate_id_alarm()
        print(f"[단절] rc={rc} 재접속 대기 — 이후 발행분은 버퍼로 "
              f"(미전송 {self.spool.pending}건)")

    def _flap_check(self):
        """같은 client_id 로 두 노드가 붙으면 서로를 밀어내며 초당 한 번씩 재접속한다.
        브로커 로그에는 'session taken over' 가 남지만 그 사유가 클라이언트까지
        전달되지 않는 경우가 있어(Mosquitto 2.x 실측), 접속 빈도로도 판정한다.
        device_id 중복은 채번 사고이므로 조용히 넘기면 안 된다(HW-C-07)."""
        now = time.time()
        self._connects.append(now)
        while self._connects and now - self._connects[0] > 20:
            self._connects.popleft()
        if len(self._connects) >= 3:
            self._duplicate_id_alarm()
            self._connects.clear()         # 경보 후 창을 비워 매 초 반복 출력을 막는다

    def _duplicate_id_alarm(self):
        print(f"[치명] 20초 내 재접속이 반복된다 — 같은 device_id "
              f"'{self.identity.entity_id}' 로 다른 노드가 접속했을 가능성이 높다. "
              f"채번 대장과 /etc/device_id 확인 필요")

    def _on_message(self, client, userdata, msg):
        # 규약 downlink 만 처리한다(레거시 JSON cmd 경로 폐기). 다른 토픽은 무시.
        if msg.topic == self.pcmd.downlink:
            self.pcmd.on_message(msg.payload)     # 규약 Protobuf 봉투

    def _on_publish(self, client, userdata, mid, reason_code=None, properties=None):
        """PUBACK(QoS 1) 시점에 지연을 확정한다. publish() 호출 반환은 '큐에 넣었다'는
        뜻일 뿐이라 그걸 재면 항상 0에 가깝다 — 브로커까지의 왕복이 진짜 발행 지연."""
        t0 = self._inflight.pop(mid, None)
        if t0 is not None:
            self.metrics.record_publish(True, (time.perf_counter() - t0) * 1000)

    # ================= 발행 =================
    def publish(self, topic, payload, qos=1, retain=False, allow_spool=True, kind=EVENT):
        body = json.dumps(payload, ensure_ascii=False)
        if self.connected:
            info = self.client.publish(topic, body, qos=qos, retain=retain)
            if info.rc == mqtt.MQTT_ERR_SUCCESS:
                if qos > 0:
                    self._inflight[info.mid] = time.perf_counter()
                    if len(self._inflight) > 1000:   # PUBACK이 끝내 안 온 것들 정리
                        self._inflight.clear()
                else:
                    # QoS 0 은 PUBACK 이 없어 왕복을 잴 수 없다 — 건수만 센다
                    self.metrics.record_publish(True)
                return True
        self.pub_fail += 1
        self.metrics.record_publish(False)
        if allow_spool:
            self.spool.append(topic, payload, qos, time.time(), kind)
        return False

    # ================= 상태 =================
    def device_status(self):
        """BE-T-04 / [G3] 장치 자기보고 층. 서버 판정 가용성과는 별개다."""
        extra = self.device_status_extra()
        if extra == schema.STATUS_FAULT:
            return schema.STATUS_FAULT
        if extra == schema.STATUS_DEGRADED:
            return schema.STATUS_DEGRADED
        if self.spool.pending or self.spool.dropped or not self.connected:
            return schema.STATUS_DEGRADED
        return schema.STATUS_OK

    def publish_status(self, event, extra=None):
        """등록·10초 요약·정상 종료가 모두 이 채널로 나간다(retained).
        늦게 붙은 구독자도 구독 즉시 현재 상태 1회를 받는다(BE-T-06/VZ-I-02).
        요약에 등록 정보를 같이 실어야 retained 가 요약으로 덮여도 장치 정보가 남는다."""
        payload = envelope(self.identity)
        payload.update({
            "channel": "status",
            "event": event,                       # birth | summary | rebirth | shutdown
            "status": "offline" if event == "shutdown" else "online",
            "device_status": self.device_status(),
            "registration": self.identity.registration(),
            "uptime_s": round(time.time() - self.started, 1),
            "buffer": {"pending": self.spool.pending, "dropped": self.spool.dropped,
                       "thinned": self.spool.thinned},
            "publish_failures": self.pub_fail,
        })
        payload.update(self.status_extra())
        if extra:
            payload.update(extra)
        # 상태는 "지금"의 값이다. 두절 중 쌓아뒀다 나중에 보내면 낡은 상태로 retained 를
        # 덮어써 오히려 해로우므로 버퍼에 넣지 않는다.
        self.publish(f"{self.base}/status", payload, qos=1, retain=True, allow_spool=False)

    def diagnostics(self):
        d = {"uptime_s": round(time.time() - self.started, 1),
             "connected": self.connected,
             "device_status": self.device_status(),
             "buffer": {"pending": self.spool.pending, "dropped": self.spool.dropped,
                        "thinned": self.spool.thinned},
             "publish_failures": self.pub_fail,
             "observability": "on" if self.metrics.enabled else "off"}
        d.update(self.status_extra())
        return d

    # ================= 주기 작업 =================
    def tick_heartbeat(self):
        if not self.heartbeat_enabled():
            return
        payload = envelope(self.identity, seq=self.hb_seq)
        payload["channel"] = "heartbeat"
        # 하트비트도 버퍼 대상이 아니다 — "지금 살아있다"는 신호를 나중에 보내면 거짓말이 된다.
        self.publish(f"{self.base}/heartbeat", payload, qos=0, allow_spool=False)
        self.hb_seq += 1

    def tick_identity(self):
        """HW-C-07: 네트워크 또는 구역이 바뀌면 갱신. BE-T-05가 MAC↔구역 매핑으로
        라우팅하므로, 바뀐 걸 알리지 않으면 백엔드가 옛 경로로 찾아온다."""
        fresh = Identity.resolve(self.ENTITY_TYPE)
        if fresh.fingerprint() == self.identity.fingerprint():
            return
        old = self.identity
        print(f"[식별자 변경] zone {old.zone_id}->{fresh.zone_id} "
              f"ip {old.ip}->{fresh.ip} mac {old.mac}->{fresh.mac}")
        self.identity = fresh
        if fresh.topic_base != old.topic_base:
            # 구역이 바뀌면 토픽이 통째로 바뀐다. 옛 토픽에 남은 retained 등록을
            # 빈 payload 로 지우지 않으면 그 구역에 유령 장치가 계속 보인다.
            self.client.publish(f"{old.topic_base}/status", "", qos=1, retain=True)
            time.sleep(0.5)
            self.client.disconnect()
            self.client.loop_stop()
            self.base = fresh.topic_base
            self._connect()          # 새 토픽으로 LWT를 다시 걸어야 하므로 재접속
        else:
            self.publish_status("rebirth")

    # ================= 하위 클래스 훅 =================
    def on_sample(self, now):
        raise NotImplementedError

    def sample_interval(self):
        return config.SAMPLE_INTERVAL

    def heartbeat_enabled(self):
        return True

    def device_status_extra(self):
        return None

    def status_extra(self):
        return {}

    def on_shutdown(self):
        """정상 종료 시 노드가 띄운 외부 자원을 정리한다(예: 영상 송출 프로세스).
        정리하지 않으면 노드가 내려간 뒤에도 대역폭을 계속 먹는다."""

    def on_tick(self, now):
        """매 반복 호출. 수집 주기와 다른 자기만의 마감을 가진 노드가 여기서 처리한다.
        로봇은 20ms 로 수집하고 50ms 로 발행하는데, 발행을 on_sample 안에 두면
        20ms 틱에 양자화되어 60ms 간격(16.7Hz)이 나온다 — 20Hz 를 못 채운다."""

    def validate(self, action, params):
        """ACK 전 사전 검증. 수행할 수 없으면 CommandError 를 던진다(HW-A-03).
        기본은 통과 — 설정 명령처럼 되돌릴 수 있는 것은 수행 중 실패로도 충분하다."""

    def next_wakeup(self):
        """on_tick 이 처리할 다음 마감시각(epoch). 없으면 None.
        루프가 이 시각에도 깨도록 해 위의 양자화를 막는다."""
        return None

    # ================= 메인 루프 =================
    def run(self):
        now = time.time()
        next_sample = next_hb = next_status = now
        next_ident = now + config.IDENTITY_CHECK_INTERVAL
        print(f"노드 시작 — entity={self.identity.entity_id} node={self.identity.node_id} "
              f"zone={self.identity.zone_id} type={self.ENTITY_TYPE}")
        while True:
            now = time.time()
            self.on_tick(now)
            if now >= next_sample:
                self.on_sample(now)
                next_sample = now + self.sample_interval()
            if now >= next_hb:
                self.tick_heartbeat()
                next_hb = now + config.HB_INTERVAL
            if now >= next_status:
                self.publish_status("summary")          # HW-C-04 10초 요약
                next_status = now + config.STATUS_SUMMARY_INTERVAL
            if now >= next_ident:
                self.tick_identity()                    # HW-C-07
                next_ident = now + config.IDENTITY_CHECK_INTERVAL
            if self.connected and self.spool.pending:
                sent = self.spool.replay(
                    lambda t, p, q: self.publish(t, p, qos=q, allow_spool=False))
                if sent:
                    print(f"[버퍼] {sent}건 재전송 (남은 {self.spool.pending}건)")
            # 다음 마감까지만 잔다. 고정 간격으로 자면 20ms 주기(로봇 50Hz)에서
            # 드리프트가 누적된다.
            nxt = min(next_sample, next_hb, next_status, next_ident)
            extra = self.next_wakeup()
            if extra is not None:
                nxt = min(nxt, extra)
            time.sleep(max(0.001, min(nxt - time.time(), 1.0)))

    def shutdown(self):
        """정상 종료는 급사와 구분되어야 한다. 둘을 같은 offline 으로 뭉치면
        가시화가 '장애'와 '의도적 미배포'를 나눌 수 없다(VZ-U-01)."""
        print("\n종료 — Death(shutdown) 발행")
        self.publish_status("shutdown", {"reason": "graceful_shutdown"})
        time.sleep(0.3)
        self.client.disconnect()
        self.client.loop_stop()
        self.metrics.shutdown()
        self.traces.shutdown()


def _on_sigterm(signum, frame):
    """systemd 의 stop/restart 는 SIGTERM 을 보낸다. 이걸 받지 않으면 프로세스가
    그대로 죽어 브로커가 LWT(death/fault)를 띄우고, 계획된 재시작·재부팅이 전부
    장애로 보고된다. Ctrl+C 와 같은 정상 종료 경로로 합류시킨다(VZ-U-01)."""
    raise KeyboardInterrupt


def main(node_class):
    """세 노드의 공통 진입점."""
    signal.signal(signal.SIGTERM, _on_sigterm)
    node = node_class()
    try:
        node.run()
    except KeyboardInterrupt:
        node.shutdown()
