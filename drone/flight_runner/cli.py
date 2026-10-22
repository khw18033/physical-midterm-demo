"""손으로 시험하는 입구 — 드론 노드를 건드리기 전에 실행기만 확인한다.

    cd ~/drone && ./venv/bin/python -m flight_runner start pattern=0 side=0 altitude_m=3 length_m=3 speed_mps=1 passes=1 dry_run=1
    ./venv/bin/python -m flight_runner start --no-rtk …  # test_sar.py 로 (노드 밖에서는 RTK 를 판정하지 않는다 — 기본 test_sar_rtk.py)
    ./venv/bin/python -m flight_runner status          # 마지막 실행 · 비상 명령
    ./venv/bin/python -m flight_runner follow          # 돌고 있는 실행의 출력을 따라 본다 (Ctrl+C 는 따라보기만 끝낸다)
    ./venv/bin/python -m flight_runner stop            # 주 프로세스에 SIGTERM (= 스크립트의 Ctrl+C)
    ./venv/bin/python -m flight_runner emergency land  # emergency_land.py (land · rtl · hold)

    --mqtt 127.0.0.1:1883 --device x500-001 을 붙이면 zoneA/drone/<device>/flight_run 으로도 낸다(가시화에서 보인다).
    --systemd user(기본) · system · local

⚠ 파라미터는 가시화가 보내는 것과 같은 이름 · 번호다(요청 문서 §2-1). 실제 비행(dry_run=0)은 confirmed=1 이 있어야
  받는다 — 여기서도 화면과 같은 확인을 대신하는 것이니, 스크립트의 점검 목록을 먼저 읽을 것.
⚠ 누가 주인인가 — drone-node 덮어쓰기(deploy/install.sh --install)가 설치돼 있으면 노드 안의 실행기가 주인이다.
  그때 이 도구는 status · follow(보기만, 상태 파일 · 유닛을 안 건드린다) · stop(신호만) 만 하고 start · emergency 는
  거절한다 — 같은 상태 파일을 둘이 쓰면 서로 덮는다. 비상은 가시화 또는 emergency_land.py 를 직접 실행.
  설치 전에는 이 도구가 주인이다. --owner 로 강제할 수 있다(노드가 꺼져 있을 때만).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from .core import DEFAULT_OUT_DIR, DEFAULT_PYTHON, DEFAULT_SCRIPTS, FlightRunner, LocalLauncher, Rejected, SystemdLauncher


NODE_DROPIN = Path("/etc/systemd/system/drone-node.service.d/60-flight-runner.conf")


def mqtt_publisher(spec: str, topic: str):
    import paho.mqtt.client as mqtt  # drone venv 에 있다(requirements.lock: paho-mqtt 2.1.0)

    host, _, port = spec.partition(":")
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"flight-runner-cli-{os.getpid()}")
    client.connect(host, int(port or 1883))
    client.loop_start()

    def publish(body: dict) -> None:
        client.publish(topic, json.dumps(body, ensure_ascii=False), qos=1, retain=True)
    return publish


def parse_params(items: list[str]) -> dict:
    params = {}
    for item in items:
        key, sep, value = item.partition("=")
        if not sep:
            raise SystemExit(f"key=value 꼴이 아니다: {item}")
        params[key] = float(value)
    return params


def follow(runner: FlightRunner, shown: int = 0) -> int | None:
    proc = runner.run
    try:
        while True:
            runner.pump()
            proc = runner.run
            if proc is None:
                return None
            for seq, text in list(proc.lines):
                if seq > shown:
                    print(text, flush=True)
                    shown = seq
            if proc.state != "running":
                print(f"--- 끝: 종료 코드 {proc.exit_code} · 출력 {proc.out_path}", flush=True)
                return proc.exit_code
            time.sleep(0.3)
    except KeyboardInterrupt:
        print("\n--- 따라보기만 끝냈다. 스크립트는 계속 돈다 (멈추려면: python -m flight_runner stop)", flush=True)
        return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m flight_runner", description="비행 실행기 손 시험")
    ap.add_argument("command", choices=["start", "stop", "emergency", "status", "follow"])
    ap.add_argument("args", nargs="*", help="start: key=value … · emergency: land|rtl|hold")
    ap.add_argument("--systemd", default=os.environ.get("FLIGHT_RUNNER_SYSTEMD", "user"), choices=["user", "system", "local"])
    ap.add_argument("--sudo", action="store_true", help="system 일 때 sudo -n 으로")
    ap.add_argument("--out-dir", default=os.environ.get("FLIGHT_RUNNER_OUT_DIR", str(DEFAULT_OUT_DIR)))
    ap.add_argument("--python", default=os.environ.get("FLIGHT_RUNNER_PYTHON", str(DEFAULT_PYTHON)))
    ap.add_argument("--scripts", default=os.environ.get("FLIGHT_RUNNER_SCRIPTS", str(DEFAULT_SCRIPTS)))
    ap.add_argument("--mqtt", default=None, help="host:port — 주면 flight_run 을 브로커로도 낸다")
    ap.add_argument("--device", default="x500-001")
    ap.add_argument("--zone", default="zoneA")
    ap.add_argument("--no-follow", action="store_true")
    ap.add_argument("--no-rtk", action="store_true", help="start: test_sar_rtk.py 대신 test_sar.py (RTK 확인 없음)")
    ap.add_argument("--owner", action="store_true", help="노드 덮어쓰기가 있어도 이 도구를 주인으로 (노드가 꺼져 있을 때만)")
    a = ap.parse_args(argv)
    node_owns = NODE_DROPIN.exists() and not a.owner
    if node_owns and a.command in ("start", "emergency"):
        print(f"거절: drone-node 의 비행 실행기가 주인이다({NODE_DROPIN}). 가시화에서 보내거나, 비상이면 "
              "./venv/bin/python scripts/emergency_land.py 를 직접 실행할 것", file=sys.stderr)
        return 2

    launcher = LocalLauncher() if a.systemd == "local" else SystemdLauncher(scope=a.systemd, sudo=a.sudo)
    publish = mqtt_publisher(a.mqtt, f"{a.zone}/drone/{a.device}/flight_run") if a.mqtt else (lambda body: None)
    runner = FlightRunner(launcher, publish, device_id=a.device, zone_id=a.zone, python=Path(a.python),
                          scripts=Path(a.scripts), out_dir=Path(a.out_dir),
                          # 보기만 하는 명령은 상태 파일 · 유닛을 건드리지 않는다 — 노드 안의 실행기가 주인일 수 있다
                          read_only=node_owns, rtk_ok=(lambda: False) if a.no_rtk else None)
    try:
        if a.command == "start":
            proc = runner.start(f"cli-{int(time.time())}", parse_params(a.args))
            print(f"--- 띄웠다: {proc.unit} · {proc.script} {' '.join(proc.argv)}", flush=True)
            if a.no_follow:
                return 0
            code = follow(runner)
            runner.publish_now()
            return 0 if code in (0, None) else 1
        if a.command == "stop":
            proc = runner.stop()
            print(f"--- SIGTERM → {proc.unit} (주 프로세스만)", flush=True)
            return 0
        if a.command == "emergency":
            mode = {"land": 0, "rtl": 1, "hold": 2}[(a.args or ["land"])[0]]
            proc = runner.emergency_land(f"cli-{int(time.time())}", {"mode": mode})
            print(f"--- 비상 명령 띄움: {proc.unit} · {' '.join(proc.argv) or '(land)'} · 출력 {proc.out_path}", flush=True)
            return 0
        if a.command == "follow":
            follow(runner, shown=0)
            return 0
        runner.pump()
        report = runner.report()
        for kind in ("run", "emergency"):
            p = report[kind]
            print(f"{kind}: " + ("없음" if p is None else
                  f"{p['run_id']} {p['state']} 코드={p['exit_code']} dry_run={p['dry_run']} 줄={len(p['lines'])} · {p['out_path']}"))
        return 0
    except Rejected as e:
        print(f"거절: {e.code} {e.message}", file=sys.stderr)
        return 2
    finally:
        runner.close()


if __name__ == "__main__":
    sys.exit(main())
