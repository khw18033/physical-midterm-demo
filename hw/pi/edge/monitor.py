"""
피지컬팀 mk2 — 엣지 대역 감시 (HW-S-07 오프라인 판정 + 상태 3층 관찰)
=======================================================================
엣지노드가 맡을 로직을 임시로 대행한다. 구역 내 모든 장치의 하트비트를 구독해
"하트비트 4회(4초) 미수신 → OFFLINE" 판정을 내린다.

BE-T-04는 상태를 단일 값으로 뭉치지 말고 3층으로 나누라고 못박았다. 이 스크립트는
그중 두 층을 다룬다.
  device_status  장치 자기보고 (ok/degraded/fault) — status 메시지에서 그대로 받는다
  availability   서버 판정 (online/offline)       — 여기 watchdog 이 직접 매긴다
  deployment     오케스트레이터 판정              — K3s 도입(HW-C-03) 후 합류

이중 감지 구조
  1) LWT (status 채널): 브로커가 TCP 끊김을 감지하면 즉시 offline 발행
  2) 하트비트 타임아웃 (이 스크립트): LWT가 못 잡는 어중간한 끊김까지 커버

명령 4단계(BE-X-03)도 같이 관찰해 ACK→수행중→물리변화→완료 흐름을 눈으로 확인한다.
토픽의 + 와일드카드 덕에 장치가 늘어도 코드 수정이 필요 없다.

실행: python3 monitor.py   (엣지노드 구축 후 그쪽으로 이전 예정)
"""
import json
import threading
import time

import paho.mqtt.client as mqtt

from common import config

INTERVAL = config.HB_INTERVAL      # 장치의 하트비트 주기 (HW-S-05: 1 Hz)
MISS_LIMIT = config.MISS_LIMIT     # HW-S-07: 4회 미수신이면 오프라인 → 약 4초
ZONE = config.ZONE_ID

last_seen = {}        # 장치별 마지막 하트비트 수신 시각
availability = {}     # 서버 판정 층
self_report = {}      # 장치 자기보고 층 (device_status)


_last_print = {}
_rate = {}


def _throttle(dev, every=1.0):
    """연속 표본을 화면에 초당 1줄로 솎는다. 판정 로직은 모든 메시지를 다 보되
    사람이 보는 출력만 줄인다 — 20Hz 를 그대로 찍으면 다른 사건이 묻힌다."""
    now = time.time()
    _rate[dev] = _rate.get(dev, 0) + 1
    if now - _last_print.get(dev, 0) >= every:
        _last_print[dev] = now
        return True
    return False


def _dev(payload, topic):
    """source_id 가 정본(BE-C-01). 확정 전 과도기라 device_id 별칭도 받아준다."""
    return payload.get("source_id") or payload.get("device_id") or topic.split("/")[2]


def on_message(client, userdata, m):
    parts = m.topic.split("/")
    channel = "/".join(parts[3:])
    if not m.payload:                       # retained 삭제 신호 (구역 이동 시)
        print(f"[레지스트리] {parts[2]} retained 등록 삭제됨")
        return
    try:
        p = json.loads(m.payload)
    except ValueError:
        return
    dev = _dev(p, m.topic)

    if channel == "heartbeat":
        last_seen[dev] = time.time()        # 도착 시각 갱신 — 판정의 근거
        if availability.get(dev) != "online":
            availability[dev] = "online"
            print(f"[가용성] {dev} ONLINE")

    elif channel == "status":
        ds = p.get("device_status", "?")
        if self_report.get(dev) != ds:
            self_report[dev] = ds
            print(f"[자기보고] {dev} device_status = {ds}")
        line = f"[status:{p.get('event')}] {dev} {p.get('status')}"
        if p.get("mode"):          # LWT payload 는 접속 시점에 고정된 최소 정보만 담는다
            buf = p.get("buffer", {})
            line += (f" mode={p['mode']}({p.get('mode_source')}) "
                     f"interval={p.get('report_interval_s')}s "
                     f"buffer={buf.get('pending', 0)}"
                     f"/drop {buf.get('dropped', 0)}/thin {buf.get('thinned', 0)}")
        print(line)
        if p.get("status") == "offline":
            # 정상 종료(shutdown)와 급사(lwt)는 다른 사건이다 — VZ-U-01이
            # '장애'와 '의도적 미배포'를 구분해 표시해야 하기 때문.
            availability[dev] = "offline"
            print(f"[가용성] {dev} OFFLINE — 사유 {p.get('reason')} / event {p.get('event')}")

    elif channel == "state":
        rep = " (재전송분)" if p.get("replayed") else ""
        if "water_level_m" in p:                    # 센서노드 (HW-S-02)
            flag = " ⚠" if p.get("alert") else ""
            print(f"[계측] {dev} {p['water_level_m']}m {p.get('reason')}{flag}{rep}")
        elif "battery_pct" in p:                    # 로봇 온보드 (HW-R-03)
            pos = p.get("position", {})
            m = p.get("mission", {})
            line = (f"[로봇] {dev} bat {p['battery_pct']}% "
                    f"pos({pos.get('x')},{pos.get('y')}) {p.get('speed_mps')}m/s "
                    f"mode={p.get('robot_mode')} {p.get('reason')}{rep}")
            if m:
                line += f" mission={m.get('mission_id')}/{m.get('status')}"
            # 임무 중 20Hz 는 초당 20줄이라 화면을 덮는다. 연속 표본은 솎아 보여주고
            # 이산 사건(모드 전환·배터리 경보)은 전부 보여준다.
            if p.get("reason") != "periodic" or _throttle(dev):
                print(line)
        else:
            print(f"[상태] {dev} {p.get('reason')}{rep}")

    elif channel in ("cmd/ack", "cmd/result"):
        print(f"[명령 {p.get('stage')}] {dev} {p.get('action')} "
              f"cid={p.get('correlation_id')} "
              f"{p.get('detail') or p.get('error') or ''}")


def on_connect(client, userdata, flags, reason_code, properties=None):
    """구독은 반드시 on_connect 안에서. 재접속하면 브로커가 이전 구독을 기억하지
    않으므로(clean session), 접속 전에 한 번만 subscribe 하면 브로커가 한 번
    재시작한 뒤부터 감시자가 조용히 눈이 먼다."""
    if reason_code != 0:
        print(f"[접속 실패] {reason_code}")
        return
    print(f"[접속] {config.BROKER_HOST}:{config.BROKER_PORT} — {ZONE} 구독")
    client.subscribe(f"{ZONE}/+/+/#", qos=1)   # +: 한 칸, #: 나머지 전부(cmd/ack 등)


def watchdog():
    """1초마다 전 장치의 침묵 시간을 점검한다. '안 오는 것'은 이벤트가 아니라
    기다리는 쪽이 직접 시계를 봐야 한다."""
    limit = INTERVAL * MISS_LIMIT
    while True:
        now = time.time()
        for dev, t in list(last_seen.items()):
            if now - t > limit and availability.get(dev) == "online":
                availability[dev] = "offline"
                print(f"[가용성] {dev} OFFLINE — 하트비트 {MISS_LIMIT}회({limit:.0f}초) 미수신")
        time.sleep(min(1.0, INTERVAL))


kw = {"callback_api_version": mqtt.CallbackAPIVersion.VERSION2, "client_id": "edge-monitor"}
if config.MQTT_V5:
    kw["protocol"] = mqtt.MQTTv5
c = mqtt.Client(**kw)
c.on_connect = on_connect
c.on_message = on_message
# connect_async + loop_forever: 브로커가 아직 안 떠 있어도 계속 재시도한다.
c.connect_async(config.BROKER_HOST, config.BROKER_PORT)
threading.Thread(target=watchdog, daemon=True).start()
print(f"엣지 감시 시작 — {ZONE} / 하트비트 {INTERVAL}s x {MISS_LIMIT}회 = "
      f"{INTERVAL * MISS_LIMIT:.0f}초 내 오프라인 판정")
c.loop_forever(retry_first_connection=True)   # 브로커보다 먼저 떠도 죽지 않는다
