"""
피지컬팀 mk2 — 증강 분석 워크로드 (HW-C-03)
=============================================
상황 발생 시 엣지 K3s 가 말단에 배포하고, 종료 시 제거하는 **증강 기능**의 실제 예시.

여기 들어가는 것의 조건은 하나다 — **없어도 안전 루프가 깨지지 않을 것.**
계측·임계 판정·자율 주기 전환·하트비트·버퍼링은 systemd 로 상주하는 노드가 담당한다
(SDD §7.2). 이 컨테이너가 죽거나 배포되지 않아도 수위 보고와 경보는 계속된다.

하는 일: 센서 상태 채널을 구독해 **추세**를 계산한다.
  - 창(기본 5분) 안의 표본으로 선형 회귀 기울기(m/min)를 구하고
  - 현재 값과 기울기로 임계 도달까지 남은 시간을 추정한다.

말단 노드는 "지금 3.0m 를 넘었다"만 말한다(그게 골든타임 경로다). 이 컨테이너는
"이 속도면 7분 뒤 넘는다"를 더한다 — **있으면 더 빨리 대응할 수 있지만, 없다고
경보가 사라지지는 않는 정보**다. 증강 기능의 성질이 정확히 그렇다.

실행: python3 -m augment.analyzer   (pi/ 디렉터리에서)
"""
import json
import os
import time
from collections import defaultdict, deque

import paho.mqtt.client as mqtt

from common import config, schema

WINDOW_S = float(os.environ.get("HW_ANALYZER_WINDOW_S", 300))
PUBLISH_S = float(os.environ.get("HW_ANALYZER_PUBLISH_S", 15))
MIN_POINTS = int(os.environ.get("HW_ANALYZER_MIN_POINTS", 4))
# 표본 개수만으로는 부족하다. 3초 주기로 5개면 15초치인데, 그 폭의 잔물결에 회귀선을
# 그으면 "3분 뒤 임계 도달" 같은 오경보가 나온다(실측에서 확인). 시간 폭도 함께 본다.
MIN_SPAN_S = float(os.environ.get("HW_ANALYZER_MIN_SPAN_S", 60))

ZONE = config.ZONE_ID
samples = defaultdict(lambda: deque())     # entity -> deque[(t, value)]
seq = 0


def slope_per_min(points):
    """최소제곱 기울기(m/min). 표본이 적거나 시간 폭이 없으면 None.
    평균 변화량 대신 회귀를 쓰는 이유는, 잔물결이 섞인 표본에서 한두 점의 튐이
    추세를 좌우하지 않게 하기 위해서다."""
    n = len(points)
    if n < MIN_POINTS:
        return None
    if points[-1][0] - points[0][0] < MIN_SPAN_S:
        return None                                # 창이 덜 찼으면 판단을 보류한다
    t0 = points[0][0]
    xs = [(t - t0) / 60.0 for t, _ in points]      # 분 단위
    ys = [v for _, v in points]
    mx = sum(xs) / n
    my = sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    if den <= 1e-9:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


def eta_to_threshold(value, slope):
    """현재 값과 기울기로 임계 도달까지 남은 분.
    이미 임계를 넘었거나 멀어지는 중이면 None — 그때 필요한 정보는 '몇 분 남았나'가
    아니라 '넘었다'와 '오르고 있나'다. 0 을 돌려주면 소비자가 '방금 넘었다'로 오해한다."""
    if slope is None or slope <= 0:
        return None
    remain = config.THRESHOLD - value
    if remain <= 0:
        return None
    return round(remain / slope, 1)


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code != 0:
        print(f"[분석] 접속 실패 {reason_code}")
        return
    topic = f"{ZONE}/sensor/+/state"
    client.subscribe(topic, qos=0)          # 분석은 유실을 견딘다 — 추세는 표본 하나에 좌우되지 않는다
    print(f"[분석] 접속 — {topic} 구독")


def on_message(client, userdata, msg):
    try:
        p = json.loads(msg.payload)
    except ValueError:
        return
    if p.get("replayed"):
        return                               # 재전송분은 과거 값이라 현재 추세를 흐린다
    value = p.get("water_level_m")
    if value is None:
        return
    dev = p.get("source_id") or p.get("device_id") or msg.topic.split("/")[2]
    now = time.time()
    q = samples[dev]
    q.append((now, value))
    while q and now - q[0][0] > WINDOW_S:
        q.popleft()


def main():
    global seq
    node_id = os.environ.get("HW_NODE_ID", os.uname().nodename)
    kw = {"callback_api_version": mqtt.CallbackAPIVersion.VERSION2,
          "client_id": f"augment-analyzer-{node_id}"}
    if config.MQTT_V5:
        kw["protocol"] = mqtt.MQTTv5
    c = mqtt.Client(**kw)
    c.on_connect = on_connect
    c.on_message = on_message
    c.connect_async(config.BROKER_HOST, config.BROKER_PORT, keepalive=30)
    c.loop_start()
    print(f"[분석] 시작 — 창 {WINDOW_S:.0f}s / 발행 {PUBLISH_S:.0f}s / 임계 {config.THRESHOLD}m")

    while True:
        time.sleep(PUBLISH_S)
        for dev, q in list(samples.items()):
            pts = list(q)
            if len(pts) < MIN_POINTS:
                continue
            value = pts[-1][1]
            slope = slope_per_min(pts)
            eta = eta_to_threshold(value, slope)
            ident = schema.Identity(dev, node_id, ZONE, "", "", "analysis")
            payload = schema.envelope(ident, seq=seq)
            payload.update({
                "channel": "analysis",
                "subject_id": dev,                 # 분석 대상 (자기 자신이 아니다)
                "window_s": WINDOW_S,
                "samples": len(pts),
                "value": value,
                "trend_m_per_min": None if slope is None else round(slope, 4),
                "eta_to_threshold_min": eta,
                "above_threshold": value >= config.THRESHOLD,
                "threshold_m": config.THRESHOLD,
            })
            c.publish(f"{ZONE}/analysis/{dev}/state",
                      json.dumps(payload, ensure_ascii=False), qos=0)
            seq += 1
            if value >= config.THRESHOLD:
                eta_txt = "임계 초과 상태"
            elif eta is None:
                eta_txt = "도달 예상 없음"
            else:
                eta_txt = f"{eta}분 후 도달 예상"
            slope_txt = "판단보류" if slope is None else format(slope, "+.4f") + "m/분"
            span = pts[-1][0] - pts[0][0]
            print(f"[분석] {dev} {value}m 추세 {slope_txt} · {eta_txt} "
                  f"(표본 {len(pts)}, 창 {span:.0f}s)")


if __name__ == "__main__":
    main()
