"""복합 미션 실행기 시험 — 진짜 프로세스를 띄우되 스크립트는 가짜다(FC · systemd 없이).

    cd ~/drone && ./venv/bin/python -m pytest flight_runner -q
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

from flight_runner.core import LocalLauncher, Rejected
from flight_runner.node import HANDLERS
from flight_runner.node_seq import OTHER, SEQ_HANDLERS, with_mission_seq
from flight_runner.seq import KIND, SeqRunner, build_seq_argv
from flight_runner.test_flight_runner import FB, FAKE_NO_RTK, FAKE_SCRIPT, FakeDroneNode, node_class, texts, wait_exit

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

# 가짜 mission_seq.py — [계획] 줄 뒤에 300줄을 더 찍어 lines(최근 200줄)에서 밀려 나가게 한다
FAKE_SEQ = r'''
import json, signal, sys, time
def log(s):
    print(f"[{time.time():.3f}] {s}", flush=True)
argv = sys.argv[1:]
if "--altitude" in argv and float(argv[argv.index("--altitude") + 1]) > 30:
    print("mission_seq.py: error: 고도는 2~30 m 여야 한다", file=sys.stderr, flush=True)
    sys.exit(2)
stop = False
def on_term(*_):
    global stop
    stop = True
signal.signal(signal.SIGTERM, on_term)
steps = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--step"]
key = "v1|alt=5|spd=1|land=here|" + ";".join(steps)
rtk = argv[argv.index("--rtk-min") + 1] if "--rtk-min" in argv else "none"
log("[연결] 완료")
log("[계획] " + json.dumps({"v": 1, "key": key, "hash": "0123456789abcdef", "rtk": rtk, "steps": steps}, ensure_ascii=False))
for i in range(300):
    log(f"       #{i} 단계 1/2 진행")
if "--dry-run" in argv:
    log("[dry-run] 여기서 끝낸다. arm 하지 않았다.")
    sys.exit(0)
for i in range(60):
    if stop:
        log("[중단] 사용자 중단 (Ctrl+C/SIGTERM) — 캡처 OFF")
        sys.exit(1)
    time.sleep(0.05)
log("[확인] 착륙 완료 ✔")
'''

EX = {"altitude_m": 5, "step_count": 2, "s1_kind": 2, "s1_value": 3, "s2_kind": 0, "s2_value": 1}


@pytest.fixture
def env(tmp_path):
    scripts = tmp_path / "drone" / "scripts"
    scripts.mkdir(parents=True)
    (scripts / "mission_seq.py").write_text(FAKE_SEQ, encoding="utf-8")
    (scripts / "test_sar_rtk.py").write_text(FAKE_SCRIPT, encoding="utf-8")
    (scripts / "test_sar.py").write_text(FAKE_NO_RTK, encoding="utf-8")
    (scripts / "emergency_land.py").write_text("print('[명령] LAND 전송')\n", encoding="utf-8")
    published = []
    launcher = LocalLauncher()

    def make(rtk_ok=None):
        return SeqRunner(launcher, published.append, device_id="x500-001", python=Path(sys.executable),
                         scripts=scripts, out_dir=tmp_path / "out_seq", rtk_ok=rtk_ok)
    return make, published, scripts, tmp_path, launcher


# ── 파라미터 → 명령줄 ────────────────────────────────────────────────

def test_kind_table_matches_seq_plan():
    sys.path.insert(0, str(SCRIPTS))
    import seq_plan
    assert KIND == seq_plan.KIND_CODE


def test_user_example_argv():
    argv, dry = build_seq_argv({**EX, "dry_run": 1})
    assert argv == ["--yes", "--step", "right:3", "--step", "forward:1", "--altitude", "5", "--dry-run"] and dry


def test_full_argv():
    argv, dry = build_seq_argv({"altitude_m": 6.5, "step_count": 3, "s1_kind": 4, "s1_value": 90,
                                "s2_kind": 1, "s2_value": 2.5, "s2_speed_mps": 0.5, "s2_capture": 1,
                                "s3_kind": 6, "s3_value": 5, "s3_capture": 0, "speed_mps": 2, "land": 1, "abort": 2,
                                "max_radius_m": 40, "rtk_min_s": 30, "rtk_timeout_s": 90, "dry_run": 0, "confirmed": 1})
    assert not dry and "--dry-run" not in argv
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--step"] == ["cw:90", "back:2.5@0.5+cap", "hover:5"]
    joined = " ".join(argv)
    for frag in ("--altitude 6.5", "--speed 2", "--land home", "--abort land", "--max-radius 40", "--rtk-min 30",
                 "--rtk-timeout 90"):
        assert frag in joined


def test_no_rtk_forces_rtk_min_zero():
    argv, _ = build_seq_argv({**EX, "rtk_min_s": 30, "rtk_timeout_s": 90, "dry_run": 1}, rtk=False)
    assert "--rtk-timeout" not in argv and argv[argv.index("--rtk-min") + 1] == "0" and argv.count("--rtk-min") == 1


@pytest.mark.parametrize("params, message", [
    ({**EX, "dry_run": 0}, "not_confirmed"),
    ({**EX}, "missing dry_run"),
    ({k: v for k, v in EX.items() if k != "altitude_m"} | {"dry_run": 1}, "missing altitude_m"),
    ({k: v for k, v in EX.items() if k != "step_count"} | {"dry_run": 1}, "missing step_count"),
    ({**EX, "step_count": 0, "dry_run": 1}, "step_count=0 not in"),
    ({**EX, "step_count": 21, "dry_run": 1}, "step_count=21 not in"),
    ({**EX, "step_count": 1.5, "dry_run": 1}, "step_count=1.5 not in"),
    ({**EX, "step_count": 3, "dry_run": 1}, "missing s3_kind"),
    ({**EX, "s3_kind": 0, "s3_value": 1, "dry_run": 1}, "beyond step_count=2"),
    ({**EX, "s2_kind": 9, "dry_run": 1}, "s2_kind=9 not in"),
    ({k: v for k, v in EX.items() if k != "s1_value"} | {"dry_run": 1}, "missing s1_value"),
    ({**EX, "s1_capture": 2, "dry_run": 1}, "s1_capture=2 not in"),
    ({**EX, "land": 2, "dry_run": 1}, "land=2 not in"),
    ({**EX, "pattern": 0, "dry_run": 1}, "unknown parameter pattern"),
    ({**EX, "s1_foo": 1, "dry_run": 1}, "unknown parameter s1_foo"),
])
def test_rejects(params, message):
    with pytest.raises(Rejected) as e:
        build_seq_argv(params)
    assert e.value.code == "INVALID_ARGUMENT" and message in e.value.message


# ── 띄우기 ──────────────────────────────────────────────────────────

def test_dry_run_keeps_plan_beyond_200_lines(env):
    make, published, *_ = env
    runner = make()
    proc = runner.start("cmd-dry", {**EX, "dry_run": 1})
    assert proc.unit.startswith("mission-seq-") and proc.script == "mission_seq.py"
    proc = wait_exit(runner)
    assert proc.exit_code == 0 and len(proc.lines) == 200
    assert not any("[계획]" in t for t in texts(proc))            # lines 에서는 밀려 나갔다
    runner.publish_now()
    body = published[-1]
    run = body["run"]
    assert body["runner"] == "mission_seq" and "emergency" not in body
    assert run["command_id"] == "cmd-dry" and run["exit_code"] == 0 and run["dry_run"] is True
    assert run["steps"] == ["right:3", "forward:1"]
    assert run["plan"]["steps"] == ["right:3", "forward:1"]
    assert run["mission_key"] == "v1|alt=5|spd=1|land=here|right:3;forward:1" and run["mission_hash"] == "0123456789abcdef"
    assert Path(run["out_path"]).parent.name == "out_seq"


def test_restart_recovers_plan(env):
    make, *_ = env
    first = make()
    first.start("cmd-a", {**EX, "dry_run": 1})
    done = wait_exit(first)
    first.close()
    again = make()
    assert again.run.run_id == done.run_id and again.run.plan == done.plan and again.run.plan is not None
    assert list(again.run.lines) == list(done.lines)


@pytest.mark.parametrize("rtk_ok, rtk_min", [(None, "none"), (lambda: True, "none"), (lambda: False, "0")])
def test_rtk_choice(env, rtk_ok, rtk_min):
    make, *_ = env
    runner = make(rtk_ok)
    runner.start("cmd-r", {**EX, "dry_run": 1})
    proc = wait_exit(runner)
    assert proc.plan["rtk"] == rtk_min


def test_bad_altitude_exit_two(env):
    make, *_ = env
    runner = make()
    runner.start("cmd-bad", {**EX, "altitude_m": 50, "dry_run": 1})
    proc = wait_exit(runner)
    assert proc.exit_code == 2 and any("고도는 2~30" in t for t in texts(proc)) and proc.plan is None


def test_stop_and_one_at_a_time(env):
    make, *_ = env
    runner = make()
    with pytest.raises(Rejected, match="not_running"):
        runner.stop()
    runner.start("cmd-1", {**EX, "dry_run": 0, "confirmed": 1})
    with pytest.raises(Rejected, match="already_running"):
        runner.start("cmd-2", {**EX, "dry_run": 1})
    time.sleep(0.6)
    runner.stop()
    proc = wait_exit(runner)
    assert proc.exit_code == 1 and any("사용자 중단" in t for t in texts(proc))
    with pytest.raises(Rejected, match="UNIMPLEMENTED"):
        runner.precheck("rtk_test_start", {})


# ── 노드: 두 실행기 함께 ───────────────────────────────────────────────

def seq_node_class(env):
    make_seq, _, scripts, tmp_path, launcher = env
    from flight_runner.core import FlightRunner

    def make_flight():
        return FlightRunner(launcher, lambda body: None, device_id="x500-001", python=Path(sys.executable),
                            scripts=scripts, out_dir=tmp_path / "out", rtk_ok=None)

    class Node(with_mission_seq(node_class(make_flight, FakeDroneNode))):
        def make_seq_runner(self):
            runner = make_seq()
            runner._publish = lambda body: self.publish(f"{self.base}/mission_run", body, qos=1, retain=True,
                                                        allow_spool=False)
            return runner
    return Node


def test_node_declares_both_and_publishes(env):
    node = seq_node_class(env)()
    try:
        assert {"ping", *HANDLERS, *SEQ_HANDLERS} <= set(node.ACTIONS)
        assert node.pcmd.on_command("cmd-nc", "seq_mission_start", {**EX, "dry_run": 0}) is None
        assert node.pcmd.sent[-1] == ("rejected", "cmd-nc", "INVALID_ARGUMENT", "not_confirmed")
        node.pcmd.on_command("cmd-s", "seq_mission_start", {**EX, "dry_run": 1}).join(5)
        assert node.pcmd.sent[-1] == ("succeeded", "cmd-s", {"launched": 1.0, "dry_run": 1.0, "rtk": 1.0})
        proc = wait_exit(node.mission_runner)
        assert proc.command_id == "cmd-s" and proc.argv[proc.argv.index("--altitude") + 1] == "5"
        node.mission_runner.publish_now()
        topic, body, qos, retain, spool = node.published[-1]
        assert topic == "zoneA/drone/x500-001/mission_run" and retain is True and spool is False
        assert body["run"]["mission_key"].endswith("right:3;forward:1")
        extra = node.status_extra()
        assert extra["fc"] == "ok" and extra["flight_run"]["running"] is False and extra["mission_run"]["running"] is False
        # 기존 명령은 그대로 산다
        node.pcmd.on_command("cmd-f", "rtk_test_start", {**FB, "dry_run": 1}).join(5)
        assert node.pcmd.sent[-1][0] == "succeeded" and wait_exit(node.flight).command_id == "cmd-f"
    finally:
        node.shutdown()


def test_node_mutual_exclusion(env):
    node = seq_node_class(env)()
    try:
        node.pcmd.on_command("cmd-s", "seq_mission_start", {**EX, "dry_run": 0, "confirmed": 1}).join(5)
        assert node.mission_runner.running
        assert node.pcmd.on_command("cmd-f", "rtk_test_start", {**FB, "dry_run": 1}) is None
        assert node.pcmd.sent[-1] == ("rejected", "cmd-f", "FAILED_PRECONDITION", OTHER)
        assert node.flight.run is None
        # 비상은 막지 않는다
        node.pcmd.on_command("cmd-e", "rtk_test_emergency", {"mode": 0}).join(5)
        assert wait_exit(node.flight, "emergency").exit_code == 0
        node.pcmd.on_command("cmd-stop", "seq_mission_stop", {}).join(5)
        wait_exit(node.mission_runner)

        node.pcmd.on_command("cmd-f2", "rtk_test_start", {**FB, "dry_run": 0, "confirmed": 1}).join(5)
        assert node.flight.running
        assert node.pcmd.on_command("cmd-s2", "seq_mission_start", {**EX, "dry_run": 1}) is None
        assert node.pcmd.sent[-1] == ("rejected", "cmd-s2", "FAILED_PRECONDITION", OTHER)
        wait_exit(node.flight)
    finally:
        node.shutdown()


def test_handler_rechecks_under_lock(env):
    """둘 다 validate 를 통과한 뒤(수락 뒤) 띄우는 순간에도 다시 본다 — 하나만 뜬다."""
    node = seq_node_class(env)()
    try:
        node.flight.start("cmd-f", {**FB, "dry_run": 0, "confirmed": 1})       # validate 를 거치지 않고 먼저 뜸
        gen = node.ACTIONS["seq_mission_start"](node, {**EX, "dry_run": 1})
        assert next(gen) == ("launching", None)
        with pytest.raises(Rejected, match=OTHER):
            next(gen)
        assert node.mission_runner.run is None
        wait_exit(node.flight)
    finally:
        node.shutdown()


def test_requires_flight_runner_underneath():
    with pytest.raises(TypeError):
        with_mission_seq(FakeDroneNode)


def test_does_not_clobber_base_node_attributes(env):
    """2026-11-13 실기 설치 사고: 공통 틀 BaseNode 의 `seq`(메시지 순번)를 감싸개가 실행기 객체로 덮어
    state 발행(json.dumps)에서 노드가 죽었다. 감싸개는 원래 노드가 가진 속성을 하나도 바꾸면 안 된다."""
    import json

    class SeqCountingNode(FakeDroneNode):
        def __init__(self):
            self.seq = 0                       # 공통 틀 BaseNode 와 같은 이름 · 뜻
            super().__init__()
            self.before = {k: v for k, v in vars(self).items() if isinstance(v, (int, float, str))}

    make_seq, _, scripts, tmp_path, launcher = env
    from flight_runner.core import FlightRunner

    def make_flight():
        return FlightRunner(launcher, lambda body: None, device_id="x500-001", python=Path(sys.executable),
                            scripts=scripts, out_dir=tmp_path / "out", rtk_ok=None)

    class Node(with_mission_seq(node_class(make_flight, SeqCountingNode))):
        def make_seq_runner(self):
            return make_seq()

    node = Node()
    try:
        assert node.seq == 0
        assert {k: getattr(node, k) for k in node.before} == node.before
        json.dumps({"seq": node.seq})                                  # 노드의 state 발행과 같은 일
    finally:
        node.shutdown()
