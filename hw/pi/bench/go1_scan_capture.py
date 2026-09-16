# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 8방향 스캔 촬영 (HW-R-05 / HW-R-07)
=====================================================
오른쪽 45도씩 8번 돌면서 **멈춘 자리마다 사진 한 장**을 찍는다. 한 바퀴 = 8장.
한 바퀴 뒤 추가 회전은 없다. **전진은 하지 않는다.**

    python3 -m bench.go1_scan_capture                      (pi/ 디렉터리에서)
    python3 -m bench.go1_scan_capture --steps 12 --step_deg 30    # 12방향
    python3 -m bench.go1_scan_capture --follow             # 명령은 웹/백엔드가, 촬영만 여기서

## 왜 ACK 시점에 찍는가

미션은 회전 -> **정지(settle)** -> ACK -> 다음 회전 순서로 돈다. ACK 가 오는 순간이
로봇이 막 멈춘 시점이라, 거기서 조금(--delay, 기본 0.6초) 기다렸다 집으면 흔들리지 않은
그림이 나온다. 회전 중에 찍으면 전부 흐려진다.

## 어떻게 한 장을 집는가

H.264 스트림에서 원하는 순간의 한 장을 바로 뽑을 수는 없다(디코드가 필요하다).
그래서 ffmpeg 로 **낮은 fps 로 계속 디코드해 링 디렉터리에 떨어뜨려 두고**, ACK 가 오면
그 시점의 최신 파일을 집는다. 쓰는 중인 파일을 집으면 반쯤 쓰인 JPEG 이 되므로
**마지막 것이 아니라 그 앞의 것**을 고른다(그건 쓰기가 끝났음이 보장된다).

## 산출물

    <out>/shot_01_scan_turn_1.jpg …   방향마다 한 장
    <out>/manifest.json               사진 <-> ACK(방위·단계) 대응표

manifest 의 `shots[]` 가 사진과 그때의 yaw 를 묶어 준다. 이게 이 도구의 핵심이다 —
사진만 있으면 "어느 방향을 본 것"인지 알 수 없다.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from robot.go1_camera import Go1CameraSource      # noqa: E402
from robot import go1_mission                      # noqa: E402

# 링 버퍼는 robot/frame_ring.py 가 정본이다(탐지 연동도 같은 것을 쓴다).
from robot.frame_ring import FrameRing, RING_FPS, RING_KEEP   # noqa: F401,E402


def follow_acks_mqtt(device_id, broker, timeout_s):
    """규약 uplink(CommandStatus)를 보고 ACK 를 흘린다 — 명령은 웹/백엔드가 건 경우.

    detail 이 JSON 이라 그대로 읽으면 된다(HW-interface/mission-command.md)."""
    import paho.mqtt.client as mqtt
    from common import physical_command_pb2 as pb

    q = []
    def on_msg(c, u, m):
        env = pb.PhysicalCommandEnvelope()
        try:
            env.ParseFromString(m.payload)
        except Exception:
            return
        which = env.WhichOneof("body")
        if which == "status" and env.status.detail.startswith("{"):
            try:
                q.append(json.loads(env.status.detail))
            except ValueError:
                pass
        elif which == "result":
            q.append({"event": "_result"})

    cli = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                      client_id="scan-capture", protocol=mqtt.MQTTv5)
    cli.on_connect = lambda c, u, f, r, p=None: c.subscribe(
        f"terminal/{device_id}/uplink", qos=1)
    cli.on_message = on_msg
    cli.connect(broker, 1883, 30)
    cli.loop_start()
    end = time.time() + timeout_s
    try:
        while time.time() < end:
            if q:
                ack = q.pop(0)
                if ack.get("event") == "_result":
                    return
                yield ack
            else:
                time.sleep(0.05)
    finally:
        cli.loop_stop()


def main():
    ap = argparse.ArgumentParser(description="8방향 스캔 촬영(전진 없음)")
    ap.add_argument("--steps", type=int, default=8, help="회전 횟수 (기본 8)")
    ap.add_argument("--step_deg", type=float, default=45.0, help="1회 회전각 (기본 45)")
    ap.add_argument("--out", default=None, help="저장 디렉터리 (기본 ~/captures/scan-<시각>)")
    ap.add_argument("--cam", type=int, default=1, help="1=정면 2=턱 3=좌 4=우 5=복부")
    ap.add_argument("--quality", type=int, default=2, help="JPEG 품질 2(최고)~31")
    ap.add_argument("--delay", type=float, default=0.6,
                    help="ACK 후 몇 초 뒤 프레임을 집을지 (흔들림 방지, 기본 0.6)")
    ap.add_argument("--follow", action="store_true",
                    help="미션을 직접 걸지 않고 규약 uplink 를 보고 촬영만 한다")
    ap.add_argument("--device", default="go1-001", help="--follow 일 때 장치 id")
    ap.add_argument("--broker", default="127.0.0.1", help="--follow 일 때 브로커")
    args = ap.parse_args()

    out = os.path.expanduser(
        args.out or time.strftime("~/captures/scan-%Y%m%d-%H%M%S"))
    os.makedirs(out, exist_ok=True)
    ring_dir = os.path.join(out, ".ring")

    ring = FrameRing(ring_dir, cam_id=args.cam, quality=args.quality)
    ring.start()
    print("카메라 준비 중…")
    if not ring.wait_ready():
        print(f"[중단] 카메라에서 영상이 오지 않는다: {ring.error or '시간 초과'}")
        print("       로봇 전원과 카메라 노드(192.168.123.13)를 확인할 것.")
        ring.close()
        return 2

    started = time.time()
    shots = []
    # 스캔 회전 steps. **전진은 하지 않는다(forward_m=0).**
    expected = args.steps

    if args.follow:
        print(f"규약 uplink 를 본다 — terminal/{args.device}/uplink "
              f"(명령은 웹/백엔드가 건다). 대기 중…")
        source = follow_acks_mqtt(args.device, args.broker,
                                  go1_mission.MissionClient.budget(
                                      args.steps, args.step_deg, 0))
        mc = None
    else:
        mc = go1_mission.MissionClient()
        up, state_ok = mc.probe()
        if not up:
            print("[중단] go1_sdk_pc 가 떠 있지 않다 — sudo systemctl start go1-sdk")
            ring.close()
            return 2
        if not state_ok:
            print("[중단] 로봇이 상태를 올려보내지 않는다(전원/기립 확인)")
            ring.close()
            return 2
        print(f"미션 시작 — 오른쪽 {args.step_deg:.0f}도 x{args.steps}, "
              f"전진 없음. 방향마다 1장씩 찍는다.")
        mc.start(args.steps, args.step_deg, forward_m=0)
        source = mc.acks(expected, go1_mission.MissionClient.budget(
            args.steps, args.step_deg, 0))

    try:
        for ack in source:
            event = ack.get("event", "?")
            step = ack.get("step")
            seq = ack.get("ack") or ack.get("ack_seq") or (len(shots) + 1)
            if event == "aborted":
                print(f"[중단] 미션이 끊겼다: {ack.get('note')}")
                break

            time.sleep(args.delay)          # 흔들림이 가라앉기를 기다린다
            name = f"shot_{len(shots)+1:02d}_{event}" + (f"_{step}" if step else "") + ".jpg"
            dest = os.path.join(out, name)
            size = ring.grab(dest)
            yaw = ack.get("yaw_deg")
            shots.append({"n": len(shots) + 1, "ack": seq, "event": event,
                          "step": step, "yaw_deg": yaw, "file": name,
                          "bytes": size, "t_unix": round(time.time(), 3)})
            print(f"  [{len(shots)}/{expected}] {name}  yaw={yaw}  "
                  f"{(size or 0)/1024:.0f}KB  ({ack.get('note')})")
    except go1_mission.MissionError as e:
        print(f"[중단] {e}")
    finally:
        if mc is not None:
            mc.close()
        ring.close()
        shutil.rmtree(ring_dir, ignore_errors=True)

    manifest = {
        "schema_version": "1.0",
        "kind": "scan_capture_session",
        "session": os.path.basename(out),
        "started_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(started)),
        "started_at": started,
        "duration_s": round(time.time() - started, 1),
        "mission": {"steps": args.steps, "step_deg": args.step_deg,
                    "forward_m": 0, "door_turn": False},
        "sensor": {"type": "camera", "camera_id": args.cam,
                   "format": "jpeg", "jpeg_quality": args.quality},
        "shots": shots,
        "complete": len(shots) == expected,
        # 아직 못 만드는 것들 — 0 이 아니라 null 이다. 다른 소스가 채운다.
        "pose_track": None,
        "labels": None,
    }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    total = sum(s["bytes"] or 0 for s in shots)
    print(f"\n끝 — {len(shots)}/{expected}장, {total/1e6:.1f}MB, "
          f"{manifest['duration_s']:.0f}초")
    print(f"저장 위치: {out}")
    if not manifest["complete"]:
        print("⚠ 예상보다 적게 찍혔다 — manifest.json 의 shots 를 확인할 것")
    print(f"보내려면: python3 -m robot.capture_upload {out} --stage <경로>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
