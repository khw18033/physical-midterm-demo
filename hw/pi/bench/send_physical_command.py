# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 물리 명령 통신 규약 송신기 (검증·참조 구현)
=============================================================
말단 장치에 규약 명령을 걸고 uplink(수락/진행/결과)를 그대로 찍어 본다.
**상위(백엔드)가 명령을 어떻게 보내야 하는지의 참조**이기도 하다.

사용 (pi/ 디렉터리에서):
  python3 -m bench.send_physical_command --device go1-001 --action scan_mission \
          --param steps=8 --param step_deg=45 --param forward_m=1.0
  python3 -m bench.send_physical_command --device go1-001 --action ping
  python3 -m bench.send_physical_command --device go1-001 --cancel <command_id>

규약 요점(이 파일이 지키는 것):
  · 토픽은 방향만 — terminal/<device-id>/downlink 로 보내고 uplink 로 받는다.
  · payload 는 PhysicalCommandEnvelope(protobuf) 직렬화 바이트. JSON 아님.
  · parameters 는 map<string,double> — **숫자만** 실린다(문자열 파라미터 불가).
  · command_id 는 재전송 식별용이라 같은 내용으로 다시 보내면 재실행 없이
    이전 응답이 그대로 온다(§5-1). 새 실행을 원하면 새 id 를 쓴다.
"""
import argparse
import sys
import time
import uuid

import paho.mqtt.client as mqtt

from common import physical_command_pb2 as pb

PB = pb.PhysicalCommandEnvelope
TS_NAME = {0: "UNSPECIFIED", 1: "SUCCEEDED", 2: "ABORTED", 3: "CANCELED"}


def describe(env):
    which = env.WhichOneof("body")
    if which == "capability":
        return f"[Capability] device={env.capability.device_id} actions={list(env.capability.actions)}"
    if which == "acceptance":
        a = env.acceptance
        if a.accepted:
            return f"[Acceptance] {a.command_id} accepted"
        return (f"[Acceptance] {a.command_id} REJECTED "
                f"{a.rejection.code}: {a.rejection.message}")
    if which == "status":
        st = env.status
        return f"[Status] {st.command_id} {st.state} {st.detail}"
    if which == "result":
        r = env.result
        out = f"[Result] {r.command_id} {TS_NAME.get(r.status, r.status)}"
        if r.result:
            out += " " + " ".join(f"{k}={v:g}" for k, v in sorted(r.result.items()))
        if r.status == 2:
            out += f" failure={r.failure.code}: {r.failure.message}"
        return out
    if which == "cancel_response":
        c = env.cancel_response
        return f"[CancelResponse] {c.command_id} accepted={c.accepted}"
    return f"[{which}]"


def main():
    ap = argparse.ArgumentParser()
    # 브로커는 로봇 옆 파이에서 돈다. 핫스팟으로 IP 가 바뀌어도 mDNS 이름은 그대로다.
    ap.add_argument("--broker", default="pi7.local")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--device", required=True, help="장치 id (terminal/<id>/downlink)")
    ap.add_argument("--action", default="ping")
    ap.add_argument("--target", default="")
    ap.add_argument("--param", action="append", default=[],
                    help="key=value (값은 숫자만 — 규약 parameters 는 map<string,double>)")
    ap.add_argument("--deadline-ms", type=int, default=0,
                    help="이 시각(unix ms) 넘으면 장치가 시작하지 않는다(§5-2)")
    ap.add_argument("--command-id", default="")
    ap.add_argument("--cancel", default="", help="이 command_id 를 취소한다")
    ap.add_argument("--wait", type=float, default=300.0, help="결과 대기 상한(초)")
    ap.add_argument("--ws", action="store_true",
                    help="MQTT over WebSocket(기본 9001)으로 붙는다 — 관제 웹(브라우저)이 "
                         "쓰는 것과 같은 전송이다. 토픽·페이로드는 동일하다.")
    ap.add_argument("--mqtt3", action="store_true",
                    help="MQTT 3.1.1 로 붙는다. 규약은 MQTT5 가 정본이고, 이건 5를 "
                         "지원하지 않는 브로커(예: Go1 내부 브로커)로 경로만 볼 때 쓴다.")
    args = ap.parse_args()

    downlink = f"terminal/{args.device}/downlink"
    uplink = f"terminal/{args.device}/uplink"
    done = {"result": False, "rejected": False}

    def on_connect(c, u, flags, rc, props=None):
        c.subscribe(uplink, qos=1)

    def on_message(c, u, msg):
        env = PB()
        try:
            env.ParseFromString(msg.payload)
        except Exception:
            print(f"[파싱실패] {len(msg.payload)}바이트")
            return
        print(f"{time.strftime('%H:%M:%S')} {describe(env)}", flush=True)
        which = env.WhichOneof("body")
        if which == "result":
            done["result"] = True
        # 거부는 그 자체가 종료다 — 규약상 거부된 명령에는 CommandResult 가 오지 않는다.
        # 이걸 기다리면 멀쩡한 거부가 "결과 미수신"처럼 보인다.
        if which == "acceptance" and not env.acceptance.accepted:
            done["result"] = True
            done["rejected"] = True

    cli = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                      client_id=f"cmd-sender-{uuid.uuid4().hex[:6]}",
                      protocol=(mqtt.MQTTv311 if args.mqtt3 else mqtt.MQTTv5),
                      transport=("websockets" if args.ws else "tcp"))
    if args.ws and args.port == 1883:
        args.port = 9001                 # WebSocket 리스너 기본 포트
    cli.on_connect = on_connect
    cli.on_message = on_message
    cli.connect(args.broker, args.port, keepalive=20)
    cli.loop_start()
    time.sleep(0.8)                      # 구독이 붙기 전에 보내면 응답을 놓친다

    env = PB()
    if args.cancel:
        env.cancel_request.command_id = args.cancel
        cid = args.cancel
        print(f"→ 취소 요청 {cid}")
    else:
        cid = args.command_id or f"cmd-{uuid.uuid4().hex[:8]}"
        cmd = env.command
        cmd.command_id = cid
        cmd.target = args.target or args.device
        cmd.action = args.action
        for kv in args.param:
            k, _, v = kv.partition("=")
            try:
                cmd.parameters[k] = float(v)
            except ValueError:
                sys.exit(f"parameters 는 숫자만 가능하다(규약 map<string,double>): {kv}")
        if args.deadline_ms:
            cmd.deadline_unix_ms = args.deadline_ms
        print(f"→ {downlink} action={args.action} id={cid} "
              f"params={ {k: cmd.parameters[k] for k in cmd.parameters} }")

    cli.publish(downlink, env.SerializeToString(), qos=1)

    deadline = time.time() + args.wait
    while time.time() < deadline and not done["result"]:
        time.sleep(0.2)
    cli.loop_stop()
    if done["rejected"]:
        print("거부됨 — 장치가 지금은 수행할 수 없다(위 Acceptance 의 사유 참조)")
        return 1
    print("완료" if done["result"] else "결과 미수신(대기 시간 초과)")
    return 0 if done["result"] else 2


if __name__ == "__main__":
    sys.exit(main())
