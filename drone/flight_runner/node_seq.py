"""드론 노드에 복합 미션 명령을 붙인다 — 기존 비행 실행기(node.py) 위에 한 겹 더 감싼다. 기존 파일은 고치지 않는다.

    python -m flight_runner.node_seq                                  # 기본: drone.drone_node:DroneNode
    python -m flight_runner.node_seq --node drone.drone_node:DroneNode

띄우는 클래스: with_mission_seq(with_flight_runner(DroneNode))
  · 기존 action(rtk_test_start · rtk_test_stop · rtk_test_emergency)과 상태(flight_run)는 그대로 산다.
  · 더하는 action: seq_mission_start · seq_mission_stop  → Capability 로 나간다(가시화 「복합 미션」 화면이 열린다).
  · 더하는 상태: <base>/mission_run (retain) — flight_run 과 같은 모양 + plan · steps · mission_key · mission_hash.
  · 비상 착륙은 기존 rtk_test_emergency 를 쓴다.

두 실행기의 상호 배제 — 기체 하나에 비행 스크립트 둘이 붙으면 안 된다.
  · validate(수락 전): 한쪽이 돌고 있으면 다른 쪽 시작을 FAILED_PRECONDITION "other_flight_running" 으로 거절.
  · 핸들러(수락 뒤 실제로 띄우는 순간): 노드 단위 잠금 안에서 다시 확인하고 띄운다 — 두 시작이 동시에 수락돼도 하나만 뜬다.
  · 그래도 새면 mavsdk_guard.connect() 가 UDP 14540 이 쓰이고 있다고 두 번째 스크립트를 명령 없이 끝낸다.
배포: deploy/61-mission-seq.conf (60-flight-runner.conf 위에 얹는 drop-in), deploy/install_seq.sh
"""

from __future__ import annotations

import argparse
import logging
import os
import threading
from pathlib import Path

from .core import DEFAULT_PYTHON, DEFAULT_SCRIPTS, Rejected
from .node import DEFAULT_NODE, command_id_of, load_class, make_launcher, node_identity, rtk_connected, with_flight_runner
from .seq import DEFAULT_SEQ_OUT_DIR, SeqRunner

log = logging.getLogger("flight_runner.node_seq")

OTHER = "other_flight_running"


def _other_running(node, mine: str) -> bool:
    other = node.flight if mine == "seq" else node.mission_runner
    return other is not None and other.running


def act_seq_start(node, params):
    yield "launching", None
    with node._flight_gate:
        if _other_running(node, "seq"):
            raise Rejected("FAILED_PRECONDITION", OTHER)
        proc = node.mission_runner.start(command_id_of(node, params), dict(params))
    yield "completed", {"launched": 1.0, "dry_run": 1.0 if proc.dry_run else 0.0, "rtk": 1.0 if proc.rtk else 0.0}


def act_seq_stop(node, params):
    node.mission_runner.stop()
    yield "completed", {"signaled": 1.0}


def act_rtk_start_guarded(node, params):
    """기존 rtk_test_start 와 같은 일 — 복합 미션이 돌고 있지 않을 때만, 노드 잠금 안에서."""
    yield "launching", None
    with node._flight_gate:
        if _other_running(node, "flight"):
            raise Rejected("FAILED_PRECONDITION", OTHER)
        proc = node.flight.start(command_id_of(node, params), dict(params))
    yield "completed", {"launched": 1.0, "dry_run": 1.0 if proc.dry_run else 0.0, "rtk": 1.0 if proc.rtk else 0.0}


SEQ_HANDLERS = {SeqRunner.START: act_seq_start, SeqRunner.STOP: act_seq_stop}


def default_seq_runner(node) -> SeqRunner:
    ident = node_identity(node)

    def publish(body: dict) -> None:
        # 상태는 「지금」 값이다 — 두절 중에 쌓았다 늦게 보내면 낡은 상태가 retained 를 덮는다(flight_run 과 같은 규칙).
        node.publish(f"{node.base}/mission_run", body, qos=1, retain=True, allow_spool=False)

    return SeqRunner(
        make_launcher(), publish, device_id=ident["source_id"], zone_id=ident["zone_id"], node_id=ident["node_id"],
        python=Path(os.environ.get("FLIGHT_RUNNER_PYTHON", str(DEFAULT_PYTHON))),
        scripts=Path(os.environ.get("FLIGHT_RUNNER_SCRIPTS", str(DEFAULT_SCRIPTS))),
        out_dir=Path(os.environ.get("MISSION_SEQ_OUT_DIR", str(DEFAULT_SEQ_OUT_DIR))),
        rtk_ok=(lambda: rtk_connected(node)) if hasattr(node, "link") else None,
    )


def with_mission_seq(node_cls: type) -> type:
    """`with_flight_runner(...)` 로 감싼 클래스를 받아 복합 미션 명령을 덧붙인다."""
    if "rtk_test_start" not in getattr(node_cls, "ACTIONS", {}):
        raise TypeError("with_mission_seq 는 with_flight_runner(...) 로 감싼 클래스 위에 얹는다")

    class MissionSeqNode(node_cls):  # type: ignore[misc, valid-type]
        ACTIONS = {**node_cls.ACTIONS, "rtk_test_start": act_rtk_start_guarded, **SEQ_HANDLERS}

        def __init__(self, *args, **kwargs):
            self.mission_runner = None                      # 채우기 전에 온 명령은 validate 가 UNAVAILABLE 로 거절
            self._flight_gate = threading.Lock()
            super().__init__(*args, **kwargs)
            self.mission_runner = self.make_seq_runner()
            self.mission_runner.start_background()
            self.mission_runner.publish_now()
            log.info("복합 미션 실행기 준비 — %s", ", ".join(SEQ_HANDLERS))

        def make_seq_runner(self) -> SeqRunner:
            return default_seq_runner(self)

        def validate(self, action, params):
            if action in SEQ_HANDLERS:
                if self.mission_runner is None:
                    raise Rejected("UNAVAILABLE", "mission seq runner not ready yet")
                if action == SeqRunner.START and _other_running(self, "seq"):
                    raise Rejected("FAILED_PRECONDITION", OTHER)
                self.mission_runner.precheck(action, dict(params or {}))
                return
            if action == "rtk_test_start" and _other_running(self, "flight"):
                raise Rejected("FAILED_PRECONDITION", OTHER)
            super().validate(action, params)

        def status_extra(self):
            extra = dict(super().status_extra() or {})
            run = self.mission_runner.run if self.mission_runner is not None else None
            extra["mission_run"] = {"running": bool(self.mission_runner and self.mission_runner.running), "run_id": run.run_id if run else None}
            return extra

        def _close_seq(self):
            # 실행기만 멈춘다. 돌고 있는 비행 스크립트는 별도 유닛이라 그대로 산다 — 다시 뜨면 이어 읽는다.
            if self.mission_runner is not None:
                self.mission_runner.close()

        def on_shutdown(self):
            self._close_seq()
            super().on_shutdown()

        def shutdown(self):
            self._close_seq()
            super().shutdown()

    MissionSeqNode.__name__ = MissionSeqNode.__qualname__ = f"MissionSeq{node_cls.__name__}"
    return MissionSeqNode


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m flight_runner.node_seq",
                                 description="드론 노드에 비행 실행기(rtk_test_*)와 복합 미션(seq_mission_*)을 붙여 실행")
    ap.add_argument("--node", default=os.environ.get("FLIGHT_RUNNER_NODE", DEFAULT_NODE),
                    help=f"감쌀 노드 클래스 module:Class (기본 {DEFAULT_NODE})")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from common.node import main as node_main  # node.py 의 가정 A5

    node_main(with_mission_seq(with_flight_runner(load_class(a.node))))


if __name__ == "__main__":
    main()
