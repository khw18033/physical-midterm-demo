"""비행 실행기 시험 — 진짜 프로세스를 띄우되 스크립트는 가짜다(FC · systemd 없이).

    cd ~/drone && ./venv/bin/python -m pytest flight_runner -q

systemd 쪽(SystemdLauncher)은 여기서 못 본다 — Pi 에서 `python -m flight_runner start …` 로 본다(PI3_작업_261014.md §3).
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

from flight_runner.core import FlightRunner, LocalLauncher, Rejected, build_emergency_argv, build_start_argv
from flight_runner.node import HANDLERS, with_flight_runner

POSIX = os.name == "posix"

FAKE_SCRIPT = r'''
import signal, sys, time
def log(s):
    print(f"[{time.time():.3f}] {s}", flush=True)
argv = sys.argv[1:]
if "--altitude" in argv and float(argv[argv.index("--altitude") + 1]) > 30:
    print("test_sar_rtk.py: error: --altitude 는 2~30 m 여야 한다", file=sys.stderr, flush=True)
    sys.exit(2)
stop = False
def on_term(*_):
    global stop
    stop = True
signal.signal(signal.SIGTERM, on_term)
log("[연결] udpin://0.0.0.0:14540 ...")
log("[연결] 완료")
log("[미션] 업로드 (12개 항목)...")
log("[미션] 대조 일치 ✔ (12개 항목 모두 같다)")
if "--dry-run" in argv:
    log("[dry-run] 여기서 끝낸다. arm 하지 않았다.")
    log("[종료]")
    sys.exit(0)
log("[명령] arm")
for i in range(60):
    if stop:
        log("[중단] 사용자 중단 (Ctrl+C/SIGTERM) — 캡처 OFF")
        log("[종료]")
        sys.exit(1)
    log(f"       #{i} 진행   0.0m")
    time.sleep(0.05)
log("[확인] 착륙 완료 ✔")
log("[종료]")
'''

FAKE_EMERGENCY = r'''
import sys, time
print(f"[{time.time():.3f}] [명령] {'RTL' if '--rtl' in sys.argv else 'HOLD' if '--hold' in sys.argv else 'LAND'} 전송", flush=True)
'''

FB = {"pattern": 0, "side": 0, "altitude_m": 5, "length_m": 5, "speed_mps": 1, "passes": 2}


@pytest.fixture
def env(tmp_path):
    scripts = tmp_path / "drone" / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "test_sar_rtk.py").write_text(FAKE_SCRIPT, encoding="utf-8")
    (scripts / "emergency_land.py").write_text(FAKE_EMERGENCY, encoding="utf-8")
    published = []
    launcher = LocalLauncher()

    def make():
        return FlightRunner(launcher, published.append, device_id="x500-001", python=Path(sys.executable),
                            scripts=scripts, out_dir=tmp_path / "out")
    return make, published


def wait_exit(runner, proc_attr="run", timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        runner.pump()
        proc = getattr(runner, proc_attr)
        if proc is not None and proc.state == "exited":
            return proc
        time.sleep(0.05)
    raise AssertionError("시간 안에 안 끝났다")


def texts(proc):
    return [t for _, t in proc.lines]


# ── 파라미터 → 명령줄 ────────────────────────────────────────────────

def test_argv_matches_request_doc():
    argv, dry = build_start_argv({**FB, "gap_s": 10, "abort": 0, "rtk_min_s": 30, "accept_radius_m": 0.5, "dry_run": 1})
    assert dry is True
    assert argv == ["--yes", "--pattern", "fb", "--side", "forward", "--altitude", "5", "--length", "5", "--speed", "1",
                    "--passes", "2", "--gap", "10", "--accept-radius", "0.5", "--rtk-min", "30", "--abort", "rtl", "--dry-run"]


def test_rotate_drops_side_length_speed():
    argv, _ = build_start_argv({"pattern": 2, "altitude_m": 4, "passes": 1, "length_m": 9, "speed_mps": 2, "dry_run": 1})
    assert "--side" not in argv and "--length" not in argv and "--speed" not in argv
    assert argv[:3] == ["--yes", "--pattern", "rotate"]


@pytest.mark.parametrize("params, message", [
    ({**FB, "dry_run": 0}, "not_confirmed"),
    ({**FB, "dry_run": 0, "confirmed": 0}, "not_confirmed"),
    ({**FB, "dry_run": 1, "bogus": 1}, "unknown parameter bogus"),
    ({**FB, "dry_run": 1, "side": 7}, "side=7"),
    ({**FB, "dry_run": 1, "passes": 2.5}, "integer"),
    ({"pattern": 0, "side": 0, "altitude_m": 5, "passes": 1, "dry_run": 1}, "missing length_m"),
    ({**FB}, "missing dry_run"),
])
def test_rejects(params, message):
    with pytest.raises(Rejected) as e:
        build_start_argv(params)
    assert e.value.code == "INVALID_ARGUMENT" and message in e.value.message


def test_flight_with_confirmed():
    argv, dry = build_start_argv({**FB, "dry_run": 0, "confirmed": 1})
    assert dry is False and "--dry-run" not in argv and argv[0] == "--yes"


def test_emergency_argv():
    assert build_emergency_argv({}) == ([], "land")
    assert build_emergency_argv({"mode": 1}) == (["--rtl"], "rtl")
    assert build_emergency_argv({"mode": 2}) == (["--hold"], "hold")


# ── 실제로 띄우기 ───────────────────────────────────────────────────

def test_dry_run_exits_zero_and_reports(env):
    make, published = env
    runner = make()
    proc = runner.start("cmd-dry", {**FB, "dry_run": 1})
    assert proc.argv[-1] == "--dry-run" and proc.unit.startswith("test-sar-rtk-")
    proc = wait_exit(runner)
    assert proc.exit_code == 0
    assert any("[dry-run] 여기서 끝낸다" in t for t in texts(proc))
    runner.publish_now()
    body = published[-1]
    assert body["source_id"] == "x500-001" and body["emergency"] is None
    run = body["run"]
    assert run["command_id"] == "cmd-dry" and run["state"] == "exited" and run["exit_code"] == 0 and run["dry_run"] is True
    assert [line["seq"] for line in run["lines"]] == list(range(1, len(run["lines"]) + 1))
    assert Path(run["out_path"]).exists()


def test_bad_option_exit_two_with_stderr(env):
    make, _ = env
    runner = make()
    runner.start("cmd-bad", {**FB, "altitude_m": 50, "dry_run": 1})
    proc = wait_exit(runner)
    assert proc.exit_code == 2
    assert any("error: --altitude" in t for t in texts(proc))


def test_one_at_a_time_and_not_running(env):
    make, _ = env
    runner = make()
    with pytest.raises(Rejected) as e:
        runner.stop()
    assert e.value.message == "not_running"
    runner.start("cmd-1", {**FB, "dry_run": 0, "confirmed": 1})
    with pytest.raises(Rejected) as e:
        runner.start("cmd-2", {**FB, "dry_run": 1})
    assert e.value.code == "FAILED_PRECONDITION" and e.value.message == "already_running"
    wait_exit(runner)


@pytest.mark.skipif(not POSIX, reason="SIGTERM 처리기는 POSIX 에서만 돈다(Windows 는 바로 죽인다)")
def test_stop_is_sigterm_to_script(env):
    make, _ = env
    runner = make()
    runner.start("cmd-fly", {**FB, "dry_run": 0, "confirmed": 1})
    time.sleep(0.4)
    runner.stop()
    proc = wait_exit(runner)
    assert proc.exit_code == 1
    assert any("사용자 중단" in t for t in texts(proc))


def test_restart_reattaches_same_lines(env):
    make, _ = env
    first = make()
    first.start("cmd-a", {**FB, "dry_run": 1})
    done = wait_exit(first)
    first.close()
    again = make()                      # 실행기가 다시 떴다 — 상태 파일 · 출력 파일로 다시 붙는다
    assert again.run is not None and again.run.run_id == done.run_id and again.run.command_id == "cmd-a"
    assert list(again.run.lines) == list(done.lines)


def test_emergency_runs_beside_flight(env):
    make, _ = env
    runner = make()
    runner.start("cmd-fly", {**FB, "dry_run": 0, "confirmed": 1})
    runner.emergency_land("cmd-e", {"mode": 1})
    proc = wait_exit(runner, "emergency")
    assert proc.mode == "rtl" and proc.exit_code == 0 and any("RTL 전송" in t for t in texts(proc))
    assert runner.report()["emergency"]["mode"] == "rtl"
    wait_exit(runner)


# ── 노드에 붙이기 (공통 틀 흉내 — 가정 A1~A6) ─────────────────────────

class FakeIdentity:
    entity_id, node_id, zone_id, entity_type = "x500-001", "pi3", "zoneA", "drone"


class FakeDroneNode:
    ACTIONS = {"ping": lambda node, p: iter([("completed", {"uptime_s": 1.0})])}

    def __init__(self):
        self.identity = FakeIdentity()
        self.base = "zoneA/drone/x500-001"
        self.published = []
        self.validated = []
        self.current_command_id = None

    def validate(self, action, params):
        self.validated.append(action)

    def status_extra(self):
        return {"fc": "ok"}

    def publish(self, topic, payload, qos=1, retain=False, allow_spool=True):
        self.published.append((topic, payload, qos, retain, allow_spool))
        return True

    def shutdown(self):
        pass


def test_node_declares_and_validates(env, tmp_path):
    make, _ = env

    class Node(with_flight_runner(FakeDroneNode)):
        def make_flight_runner(self):
            runner = make()
            runner._publish = lambda body: self.publish(f"{self.base}/flight_run", body, qos=1, retain=True, allow_spool=False)
            return runner

    node = Node()
    try:
        assert {"ping", *HANDLERS} <= set(node.ACTIONS)
        node.validate("ping", {})
        assert node.validated == ["ping"]                       # 원래 검증은 그대로
        with pytest.raises(Rejected):
            node.validate("rtk_test_start", {**FB, "dry_run": 0})
        node.validate("rtk_test_start", {**FB, "dry_run": 1})
        node.current_command_id = "cmd-node"
        stages = list(HANDLERS["rtk_test_start"](node, {**FB, "dry_run": 1}))
        assert stages[-1] == ("completed", {"launched": 1.0, "dry_run": 1.0})
        proc = wait_exit(node.flight)
        assert proc.command_id == "cmd-node"
        node.flight.publish_now()
        topic, body, qos, retain, spool = node.published[-1]
        assert topic == "zoneA/drone/x500-001/flight_run" and retain is True and spool is False and qos == 1
        assert node.status_extra()["fc"] == "ok" and node.status_extra()["flight_run"]["running"] is False
    finally:
        node.shutdown()


def test_read_only_viewer_does_not_steal_exit_code(env, tmp_path):
    """보기만 하는 실행기(cli status · follow)가 끝난 유닛을 치우면 주인이 종료 코드를 잃는다."""
    make, _ = env
    owner = make()
    owner.start("cmd-own", {**FB, "dry_run": 1})
    viewer = FlightRunner(owner.launcher, lambda body: None, device_id="x500-001", python=Path(sys.executable),
                          scripts=owner.scripts, out_dir=owner.out_dir, read_only=True)
    seen = wait_exit(viewer)
    assert seen.exit_code == 0
    assert owner.launcher.poll(owner.run.unit) == (False, 0)      # 유닛이 그대로 남아 주인이 읽을 수 있다
    assert wait_exit(owner).exit_code == 0
