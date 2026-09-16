# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 규약 서버의 노드 연동 검증 (브로커·실물 불필요)
================================================================
BaseNode 가 물리 명령 통신 규약(Protobuf/terminal 토픽)만 처리하고 레거시 JSON cmd
경로는 폐기했는지, 재접속 안전 어댑터로 현재 client 를 쓰는지 확인한다.

  · downlink(terminal/<id>/downlink) 로 온 Command → 규약 서버가 처리,
    uplink 로 Capability/Acceptance/Result(Protobuf) 발행
  · 레거시 {base}/cmd 경로는 폐기됨 — 구독도 응답도 없어야 한다
  · publish 어댑터는 호출 시점의 self.client 를 읽는다(재접속 안전)

사용: python -m bench.physical_command_node_test   (pi/ 디렉터리)
필요 환경: HW_ENTITY_ID/HW_NODE_ID/HW_ZONE_ID (없으면 기본값 주입)
"""
import json
import os
import sys
import time
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("HW_ENTITY_ID", "wl-001")
os.environ.setdefault("HW_NODE_ID", "pi1")
os.environ.setdefault("HW_ZONE_ID", "zoneA")

# paho 가 없어도 노드 import 가 되도록 최소 스텁 (실물에선 실제 paho 사용)
if "paho.mqtt.client" not in sys.modules:
    try:
        import paho.mqtt.client  # noqa
    except Exception:
        m = types.ModuleType("paho"); mc = types.ModuleType("paho.mqtt")
        cl = types.ModuleType("paho.mqtt.client")

        class _C:
            MQTTv5 = 5; MQTT_ERR_SUCCESS = 0

            class CallbackAPIVersion:
                VERSION2 = 2

            def __init__(self, *a, **k):
                pass
        cl.Client = _C; cl.MQTTv5 = 5; cl.MQTT_ERR_SUCCESS = 0
        cl.CallbackAPIVersion = _C.CallbackAPIVersion
        m.mqtt = mc; mc.client = cl
        sys.modules["paho"] = m; sys.modules["paho.mqtt"] = mc
        sys.modules["paho.mqtt.client"] = cl

from common.node import BaseNode
from common import physical_command_pb2 as pb


class _Info:
    rc = 0; mid = 1


class FakeClient:
    def __init__(self):
        self.sent = []

    def publish(self, t, pl, qos=0, retain=False):
        self.sent.append((t, pl)); return _Info()

    def subscribe(self, t, qos=0):
        self.sent.append(("SUB", t))


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    print("규약 서버 노드 연동 검증 (브로커·실물 불필요)")

    BaseNode._connect = lambda self: None      # 브로커 접속 무력화
    n = BaseNode()
    n.connected = True
    fc = FakeClient()
    n.client = fc

    assert n.pcmd.downlink == f"terminal/{n.identity.entity_id}/downlink"
    assert n.pcmd.uplink == f"terminal/{n.identity.entity_id}/uplink"
    print(f"  토픽: downlink={n.pcmd.downlink}, uplink={n.pcmd.uplink} ✓")

    # 규약 경로: downlink 로 ping Command
    env = pb.PhysicalCommandEnvelope()
    c = env.command
    c.command_id = "n-1"; c.target = n.identity.entity_id; c.action = "ping"

    class Msg:
        topic = n.pcmd.downlink; payload = env.SerializeToString()

    n.pcmd.start()                              # 구독 + Capability
    n._on_message(None, None, Msg())
    time.sleep(0.4)
    before = len(fc.sent)
    proto = [pb.PhysicalCommandEnvelope.FromString(pl).WhichOneof("body")
             for t, pl in fc.sent if t != "SUB"]
    assert ("SUB", n.pcmd.downlink) in fc.sent, "downlink 미구독"
    assert {"capability", "acceptance", "result"} <= set(proto), proto
    print(f"  규약: downlink 구독·Capability 발행·Command 처리 → {proto} ✓")

    # 레거시 폐기 확인: {base}/cmd 는 더 이상 구독하지도, 처리하지도 않는다.
    assert not any(t == "SUB" and pl == f"{n.base}/cmd" for t, pl in fc.sent), "레거시 cmd 를 아직 구독함"
    class Msg2:
        topic = f"{n.base}/cmd"
        payload = json.dumps({"command_id": "j-1", "action": "ping"}).encode()

    n._on_message(None, None, Msg2())
    time.sleep(0.3)
    assert len(fc.sent) == before, f"레거시 {n.base}/cmd 가 아직 응답을 냄: {fc.sent[before:]}"
    print(f"  레거시 폐기: {n.base}/cmd 미구독·무응답(규약 경로만) ✓")

    # 재접속 안전: client 를 갈아끼워도 어댑터가 새 client 로 발행
    fc2 = FakeClient()
    n.client = fc2
    env2 = pb.PhysicalCommandEnvelope()
    env2.command.command_id = "n-2"; env2.command.target = n.identity.entity_id
    env2.command.action = "ping"

    class Msg3:
        topic = n.pcmd.downlink; payload = env2.SerializeToString()

    n._on_message(None, None, Msg3())
    time.sleep(0.3)
    assert fc2.sent, "재접속 후 새 client 로 발행되지 않음"
    print(f"  재접속 안전: client 교체 후 새 client 로 발행({len(fc2.sent)}건) ✓")

    print("전부 통과 — 규약 경로 전용(레거시 폐기) + 재접속 안전")


if __name__ == "__main__":
    main()
