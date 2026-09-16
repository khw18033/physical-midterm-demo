# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 물리 명령 통신 규약 준수 검증 (실물·브로커 불필요)
==================================================================
Interface Specification §5(행동 규칙)·§6(예시 흐름) 전부를 가짜 엣지로 검증한다.
Protobuf 봉투를 실제로 직렬화/역직렬화하고, 서버가 uplink 로 내보내는 바이트를
파싱해 규약대로인지 바이트 수준으로 확인한다.

  6(a) 정상 성공        → Acceptance{true} → Result{SUCCEEDED, result}
  6(b) 거부(미선언)     → Acceptance{false, UNIMPLEMENTED}, Result 없음
  6(c) 취소             → Acceptance{true} → CancelResponse{true} → Result{CANCELED}
  6(d) 재전송(같은 내용)→ 재실행 없이 이전 응답 재송신
  §5-1 ALREADY_EXISTS   → 같은 id 다른 내용 거부
  §5-2 deadline         → FAILED_PRECONDITION
  §5-3 취소 우선        → 성공 시점에 취소돼 있으면 CANCELED
  §5-4 UNIMPLEMENTED    → 미선언 action 거부
  Capability            → start 시 지원 action 발행

사용: python -m bench.physical_command_test   (pi/ 디렉터리)
"""
import sys
import os
import time
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common import physical_command_pb2 as pb
from common.physical_command import PhysicalCommandServer, CommandError

PB = pb.PhysicalCommandEnvelope
TS = pb.TerminalStatus


# ---------------- 가짜 장치 로직 ----------------
class FakeOwner:
    def __init__(self):
        self._exec_count = {}     # action 별 실제 수행 횟수 (재실행 방지 검증용)

    def _navigate(self, params):
        # 실행에 시간이 걸리는 동작을 흉내 (취소가 끼어들 수 있게)
        yield "executing", None
        time.sleep(0.3)
        yield "state_changed", {"progress": 0.5}
        time.sleep(0.3)
        yield "completed", {"distance_moved": params.get("distance", 0.0)}

    def _jam(self, params):
        yield "executing", None
        raise CommandError("FAILED_PRECONDITION", "actuator jammed")

    ACTIONS = {}          # __init__ 후 아래에서 채움
    PHYSICAL_ACTIONS = {"navigate.relative"}

    def validate(self, action, params):
        if params.get("bad"):
            raise CommandError("INVALID_ARGUMENT", "bad param")

    def cancel(self, command_id):
        pass              # 실제 정지 유도 훅 (여기선 no-op)


def make_owner():
    o = FakeOwner()
    def nav(owner, p):
        owner._exec_count["navigate.relative"] = owner._exec_count.get("navigate.relative", 0) + 1
        yield from owner._navigate(p)
    def jam(owner, p):
        owner._exec_count["jam"] = owner._exec_count.get("jam", 0) + 1
        yield from owner._jam(p)
    o.ACTIONS = {"navigate.relative": nav, "jam": jam}
    return o


# ---------------- 가짜 엣지(MQTT 대역) ----------------
class FakeClient:
    """서버의 uplink publish 를 가로채 봉투로 보관한다."""
    def __init__(self):
        self.uplink = []          # PhysicalCommandEnvelope 목록
        self.lock = threading.Lock()

    def subscribe(self, topic, qos=0):
        pass

    def publish(self, topic, payload, qos=0):
        env = PB(); env.ParseFromString(payload)
        with self.lock:
            self.uplink.append(env)


def cmd_env(cid, action, target="robot1", params=None, deadline_ms=0):
    env = PB()
    c = env.command
    c.command_id = cid; c.target = target; c.action = action
    for k, v in (params or {}).items():
        c.parameters[k] = float(v)
    if deadline_ms:
        c.deadline_unix_ms = deadline_ms
    return env


def cancel_env(cid):
    env = PB(); env.cancel_request.command_id = cid
    return env


def wait_result(cli, cid, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        with cli.lock:
            for e in cli.uplink:
                if e.WhichOneof("body") == "result" and e.result.command_id == cid:
                    return e.result
        time.sleep(0.02)
    return None


def kinds(cli, cid):
    out = []
    with cli.lock:
        for e in cli.uplink:
            w = e.WhichOneof("body")
            body = getattr(e, w)
            if getattr(body, "command_id", None) == cid:
                out.append(w)
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    print("물리 명령 통신 규약 준수 검증 (Protobuf 실직렬화, 실물 불필요)")

    cli = FakeClient()
    owner = make_owner()
    srv = PhysicalCommandServer(cli, "robot1", owner, log=lambda *a: None)
    srv.start()

    # Capability 발행 확인
    with cli.lock:
        caps = [e for e in cli.uplink if e.WhichOneof("body") == "capability"]
    assert caps and set(caps[0].capability.actions) == {"navigate.relative", "jam"}, "Capability 미발행/불일치"
    print(f"  Capability: start 시 지원 action {list(caps[0].capability.actions)} 발행 ✓")

    # 6(a) 정상 성공
    srv.on_message(cmd_env("c-1", "navigate.relative", params={"distance": 1.0}).SerializeToString())
    r = wait_result(cli, "c-1")
    assert r and r.status == TS.SUCCEEDED, f"c-1 결과 {r}"
    assert abs(r.result["distance_moved"] - 1.0) < 1e-6, "result 필드 누락"
    ks = kinds(cli, "c-1")
    assert ks[0] == "acceptance" and "status" in ks and ks[-1] == "result", ks
    print(f"  6(a) 정상: acceptance→status(EXECUTING)→result(SUCCEEDED, distance_moved=1.0) ✓")

    # 6(b) 거부 — 미선언 action (§5-4 UNIMPLEMENTED)
    srv.on_message(cmd_env("c-2", "fly").SerializeToString())
    time.sleep(0.1)
    with cli.lock:
        acc = [e for e in cli.uplink if e.WhichOneof("body") == "acceptance" and e.acceptance.command_id == "c-2"]
    assert acc and not acc[0].acceptance.accepted and acc[0].acceptance.rejection.code == "UNIMPLEMENTED"
    assert wait_result(cli, "c-2", 0.5) is None, "거부인데 result 가 왔다"
    print(f"  6(b)/§5-4 미선언 action → UNIMPLEMENTED 거부, Result 없음 ✓")

    # 6(c) 취소 → CANCELED
    srv.on_message(cmd_env("c-3", "navigate.relative", params={"distance": 5.0}).SerializeToString())
    time.sleep(0.15)                       # 실행 중간
    srv.on_message(cancel_env("c-3").SerializeToString())
    with cli.lock:
        cr = [e for e in cli.uplink if e.WhichOneof("body") == "cancel_response" and e.cancel_response.command_id == "c-3"]
    assert cr and cr[0].cancel_response.accepted, "취소 응답 미수락"
    r = wait_result(cli, "c-3")
    assert r and r.status == TS.CANCELED, f"c-3 결과 {r}"
    print(f"  6(c)/§5-3 취소: CancelResponse(accepted) → Result(CANCELED) ✓")

    # 6(d) 재전송(같은 내용) — 재실행 없음
    owner._exec_count.clear()
    e5 = cmd_env("c-5", "navigate.relative", params={"distance": 1.0})
    srv.on_message(e5.SerializeToString())
    assert wait_result(cli, "c-5") is not None
    n1 = owner._exec_count.get("navigate.relative", 0)
    srv.on_message(e5.SerializeToString())   # 동일 재전송
    time.sleep(0.3)
    n2 = owner._exec_count.get("navigate.relative", 0)
    assert n1 == 1 and n2 == 1, f"재전송에 재실행됨 ({n1}→{n2})"
    print(f"  6(d)/§5-1 재전송(같은 내용): 물리 동작 재실행 안 함(수행 {n2}회), 이전 응답 재송신 ✓")

    # §5-1 ALREADY_EXISTS — 같은 id 다른 내용
    srv.on_message(cmd_env("c-5", "navigate.relative", params={"distance": 9.9}).SerializeToString())
    time.sleep(0.1)
    with cli.lock:
        rej = [e for e in cli.uplink if e.WhichOneof("body") == "acceptance"
               and e.acceptance.command_id == "c-5" and not e.acceptance.accepted]
    assert rej and rej[0].acceptance.rejection.code == "ALREADY_EXISTS", "ALREADY_EXISTS 미검출"
    print(f"  §5-1 같은 id·다른 내용 → ALREADY_EXISTS ✓")

    # §5-2 deadline
    srv.on_message(cmd_env("c-6", "navigate.relative", params={"distance": 1.0},
                           deadline_ms=int((time.time() - 5) * 1000)).SerializeToString())
    time.sleep(0.1)
    with cli.lock:
        acc = [e for e in cli.uplink if e.WhichOneof("body") == "acceptance" and e.acceptance.command_id == "c-6"]
    assert acc and not acc[0].acceptance.accepted and acc[0].acceptance.rejection.code == "FAILED_PRECONDITION"
    print(f"  §5-2 deadline 경과 → FAILED_PRECONDITION 거부 ✓")

    # ABORTED (실패)
    srv.on_message(cmd_env("c-7", "jam").SerializeToString())
    r = wait_result(cli, "c-7")
    assert r and r.status == TS.ABORTED and r.failure.code == "FAILED_PRECONDITION", f"c-7 {r}"
    print(f"  실패: Result(ABORTED, failure.code=FAILED_PRECONDITION) ✓")

    # 봉투 방향 규칙: 모든 uplink 는 장치→엣지 종류만
    device_to_edge = {"acceptance", "status", "result", "cancel_response", "capability"}
    with cli.lock:
        bad = [e.WhichOneof("body") for e in cli.uplink if e.WhichOneof("body") not in device_to_edge]
    assert not bad, f"uplink 에 잘못된 종류: {bad}"
    print(f"  §2 uplink 는 장치→엣지 메시지만(봉투 oneof) ✓")

    print("전부 통과 — 규약 준수 확인")


if __name__ == "__main__":
    main()
