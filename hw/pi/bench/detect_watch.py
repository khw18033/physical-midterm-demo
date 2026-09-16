# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 탐지로 나가는 프레임 엿보기 (연동 확인용)
==========================================================
`detect-bridge` 가 브로커로 발행하는 것을 탐지 담당과 **똑같이** 받아 본다.
base64 이미지는 길어서 그대로 찍으면 화면이 묻히므로 요약만 찍고 파일로 저장한다.

    python3 -m bench.detect_watch                       # 요약만
    python3 -m bench.detect_watch --save ~/scan_sample  # 8장을 저장(샘플 전달용)
    python3 -m bench.detect_watch --device go1-sim

저장한 파일 이름이 `frame_0_rot000.jpg` 처럼 각도를 품고 있어서, 폴더째 넘기면
어느 사진이 몇 도인지 따로 설명할 필요가 없다.
"""
import argparse
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import paho.mqtt.client as mqtt                      # noqa: E402

from common import config                            # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="go1-001")
    ap.add_argument("--zone", default=config.ZONE_ID)
    ap.add_argument("--broker", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=1883)
    ap.add_argument("--save", help="JPEG 를 이 디렉터리에 저장한다")
    a = ap.parse_args()

    base = f"{a.zone}/robot/{a.device}"
    seen = {"frame": 0, "dup": 0}

    def on_connect(c, u, f, rc, p=None):
        c.subscribe([(f"{base}/frame", 1), (f"{base}/scan", 1)])
        print(f"[구독] {base}/frame · {base}/scan", flush=True)

    def on_message(c, u, m):
        try:
            d = json.loads(m.payload)
        except ValueError:
            return
        ts = time.strftime("%H:%M:%S")
        if d.get("channel") == "scan":
            ev = d.get("event")
            if ev == "scan_start":
                seen["frame"] = seen["dup"] = 0
                plan = d.get("plan", {})
                print(f"[{ts}] ── 스캔 시작 {d.get('mission_id')} "
                      f"({plan.get('steps')}방향 x {plan.get('step_deg')}도)", flush=True)
            else:
                print(f"[{ts}] ── 스캔 끝 {d.get('outcome')} "
                      f"사진 {d.get('frames_sent')}/{d.get('expected_frames')}장 "
                      f"(받은 것 {seen['frame']}장, 중복 {seen['dup']}장)", flush=True)
            return

        if d.get("channel") != "frame":
            return
        img = base64.b64decode(d.get("image", ""))
        seen["frame"] += 1
        dup = bool(d.get("duplicate_of_prev"))
        seen["dup"] += dup
        rot = d.get("rotation_deg")
        print(f"[{ts}] seq={d.get('seq')} rotation={rot}도 "
              f"{d.get('width')}x{d.get('height')} {len(img)}B "
              f"sha={d.get('sha1','')[:8]}"
              + ("  ⚠ 직전과 같은 그림(카메라 정지 의심)" if dup else ""), flush=True)
        if a.save and img:
            os.makedirs(a.save, exist_ok=True)
            name = f"frame_{d.get('seq')}_rot{int(rot or 0):03d}.jpg"
            with open(os.path.join(a.save, name), "wb") as fh:
                fh.write(img)

    c = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                    protocol=mqtt.MQTTv5)
    c.on_connect = on_connect
    c.on_message = on_message
    c.connect(a.broker, a.port, 30)
    try:
        c.loop_forever()
    except KeyboardInterrupt:
        print(f"\n종료. 프레임 {seen['frame']}장 (중복 {seen['dup']}장)"
              + (f" → {a.save}" if a.save else ""), flush=True)


if __name__ == "__main__":
    main()
