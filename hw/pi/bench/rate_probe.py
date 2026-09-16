"""
피지컬팀 mk2 — 발행 주기 실측기 (HW-S-05 / HW-R-02 / HW-R-03 검증용)
=====================================================================
"20 Hz로 보낸다"는 코드를 읽어서는 확인되지 않는다. 브로커에서 실제로 세어 봐야 안다.
그렇게 재서 16.5 Hz(=1/0.06초, 발행이 수집 틱에 양자화됨)를 찾아냈고, 고친 뒤
같은 방법으로 다시 재서 19.9 Hz 를 확인했다.

사용:
    python3 -m bench.rate_probe <측정초> [라벨] [토픽]

예:
    python3 -m bench.rate_probe 8  "대기 중"   "zoneA/robot/rb-01/#"
    python3 -m bench.rate_probe 10 "임무 중"   "zoneA/robot/rb-01/#"
    python3 -m bench.rate_probe 8  "센서"      "zoneA/sensor/wl-001/#"

브로커 주소는 공통 설정(HW_BROKER_HOST)을 그대로 쓴다.
"""
import collections
import sys
import time

import paho.mqtt.client as mqtt

from common import config


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    window = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
    label = sys.argv[2] if len(sys.argv) > 2 else "측정"
    topic = sys.argv[3] if len(sys.argv) > 3 else f"{config.ZONE_ID}/+/+/#"

    counts = collections.Counter()

    def on_message(client, userdata, msg):
        # 채널별로 센다. 마지막 칸이 채널명 (state / heartbeat / status ...)
        counts[msg.topic.split("/")[-1]] += 1

    kw = {"callback_api_version": mqtt.CallbackAPIVersion.VERSION2,
          "client_id": f"rate-probe-{int(time.time())}"}
    if config.MQTT_V5:
        kw["protocol"] = mqtt.MQTTv5
    c = mqtt.Client(**kw)
    c.on_message = on_message
    c.connect(config.BROKER_HOST, config.BROKER_PORT)
    c.subscribe(topic, qos=0)
    c.loop_start()

    t0 = time.time()
    time.sleep(window)
    c.loop_stop()
    elapsed = time.time() - t0

    print(f"[{label}] {elapsed:.1f}초 측정 — {topic}")
    if not counts:
        print("   (수신 없음)")
        return
    for channel, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"   {channel:12s} {n:5d}건  =  {n / elapsed:6.1f} Hz")


if __name__ == "__main__":
    main()
