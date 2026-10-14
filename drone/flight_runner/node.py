"""드론 노드(drone-node.service)에 비행 실행기 명령 셋을 붙인다 — HW 쪽 파일(~/hw/pi)은 한 줄도 고치지 않는다.

    python -m flight_runner.node                                   # 기본: drone.drone_node:DroneNode 를 감싼다
    python -m flight_runner.node --node drone.drone_node:DroneNode

선언하는 action (Capability 로 나간다 → 가시화 「비행 제어」 탭의 버튼이 열린다):
    rtk_test_start · rtk_test_stop · rtk_test_emergency

⚠ **공통 틀(~/hw/pi/common/node.py)에 맞춰 확인되지 않았다.** 이 저장소에 그 코드가 없어, 같은 일을 하는
가시화 쪽 `viz-debugger/drone/sar_pass/agent.py` 가 적어 둔 규약을 따랐다. 아래 「가정」을 Pi 에서 실제 코드와
대조하고 틀린 곳을 고칠 것 — `PI3_작업_261014.md` §2.

가정 (sar_pass/agent.py 에서 온 것)
  A1  클래스 속성 `ACTIONS: dict[str, handler]` 의 키가 Capability 로 나간다.
  A2  handler(node, params) 는 (stage, detail) 를 내는 제너레이터이고, 마지막 ("completed", {숫자}) 가 result 다.
  A3  `validate(action, params)` 가 Acceptance 전에 paho 망 스레드에서 불린다 — 입출력 금지.
      거기서 `code` · `message` 를 가진 예외를 던지면 그것이 rejection 이 된다.
  A4  `node.publish(topic, body, qos=, retain=, allow_spool=)` · `node.base`(= zoneA/drone/<id>) · `node.identity`.
  A5  `common.node.main(cls)` 가 진입점이다(SIGTERM → 정상 종료).
  A6  ★ handler 가 **command_id 를 알 길**이 정해져 있지 않다. 가시화의 dry-run 통과 판정이 flight_run 의
      `command_id` 로 짝을 맞추므로 꼭 필요하다. 아래 `command_id_of()` 가 몇 가지 이름을 찾아보고 못 찾으면 None —
      None 이면 화면의 「비행 시작」이 영영 안 열린다. 실제 틀에서 얻는 방법으로 고칠 것.
"""

from __future__ import annotations

import argparse
import importlib
import logging
import os
from pathlib import Path

from .core import DEFAULT_OUT_DIR, DEFAULT_PYTHON, DEFAULT_SCRIPTS, FlightRunner, LocalLauncher, Rejected, SystemdLauncher

log = logging.getLogger("flight_runner.node")

DEFAULT_NODE = "drone.drone_node:DroneNode"


def command_id_of(node, params: dict) -> str | None:
    """가정 A6 — 지금 처리 중인 명령의 command_id. 공통 틀이 어디에 두는지 확인해 이 함수만 고친다."""
    for name in ("current_command_id", "command_id", "_current_command_id"):
        value = getattr(node, name, None)
        if isinstance(value, str) and value:
            return value
    current = getattr(node, "current_command", None)
    value = getattr(current, "command_id", None) or getattr(current, "commandId", None)
    return value if isinstance(value, str) and value else None


def act_start(node, params):
    yield "launching", None
    proc = node.flight.start(command_id_of(node, params), dict(params))
    yield "completed", {"launched": 1.0, "dry_run": 1.0 if proc.dry_run else 0.0}


def act_stop(node, params):
    node.flight.stop()
    yield "completed", {"signaled": 1.0}


def act_emergency(node, params):
    yield "launching", None
    node.flight.emergency_land(command_id_of(node, params), dict(params))
    yield "completed", {"launched": 1.0}


HANDLERS = {"rtk_test_start": act_start, "rtk_test_stop": act_stop, "rtk_test_emergency": act_emergency}


def node_identity(node) -> dict:
    ident = getattr(node, "identity", None)
    return {"source_id": getattr(ident, "entity_id", "x500-001"), "node_id": getattr(ident, "node_id", ""),
            "zone_id": getattr(ident, "zone_id", "zoneA")}


def make_launcher():
    """FLIGHT_RUNNER_SYSTEMD = user(기본) · system · local(시험용, 노드가 죽으면 같이 끊긴다 — 실기 금지)."""
    scope = os.environ.get("FLIGHT_RUNNER_SYSTEMD", "user")
    if scope == "local":
        log.warning("FLIGHT_RUNNER_SYSTEMD=local — 스크립트가 노드의 자식이 된다. 실기 비행에 쓰지 말 것")
        return LocalLauncher()
    return SystemdLauncher(scope=scope, sudo=os.environ.get("FLIGHT_RUNNER_SUDO", "0") == "1")


def default_runner(node) -> FlightRunner:
    ident = node_identity(node)

    def publish(body: dict) -> None:
        # 상태는 「지금」 값이다 — 두절 중에 쌓았다가 늦게 보내면 낡은 상태가 retained 를 덮는다(sar_pass 와 같은 규칙).
        node.publish(f"{node.base}/flight_run", body, qos=1, retain=True, allow_spool=False)

    return FlightRunner(
        make_launcher(), publish, device_id=ident["source_id"], zone_id=ident["zone_id"], node_id=ident["node_id"],
        python=Path(os.environ.get("FLIGHT_RUNNER_PYTHON", str(DEFAULT_PYTHON))),
        scripts=Path(os.environ.get("FLIGHT_RUNNER_SCRIPTS", str(DEFAULT_SCRIPTS))),
        out_dir=Path(os.environ.get("FLIGHT_RUNNER_OUT_DIR", str(DEFAULT_OUT_DIR))),
    )


def with_flight_runner(node_cls: type) -> type:
    """`node_cls` 를 상속해 세 명령을 덧붙인 클래스. 원래 명령 · 검증 · 종료 처리는 그대로 산다."""

    class FlightRunnerNode(node_cls):  # type: ignore[misc, valid-type]
        ACTIONS = {**getattr(node_cls, "ACTIONS", {}), **HANDLERS}

        def __init__(self, *args, **kwargs):
            # 공통 틀의 __init__ 이 곧바로 명령을 받기 시작한다. 그 사이에 온 명령은 validate 가 UNAVAILABLE 로 거절한다.
            self.flight = None
            super().__init__(*args, **kwargs)
            self.flight = self.make_flight_runner()
            self.flight.start_background()
            self.flight.publish_now()
            log.info("비행 실행기 준비 — %s", ", ".join(HANDLERS))

        def make_flight_runner(self) -> FlightRunner:
            return default_runner(self)

        def validate(self, action, params):
            if action in HANDLERS:
                if self.flight is None:
                    raise Rejected("UNAVAILABLE", "flight runner not ready yet")
                self.flight.precheck(action, dict(params or {}))
                return
            parent = getattr(super(), "validate", None)
            if parent is not None:
                parent(action, params)

        def status_extra(self):
            parent = getattr(super(), "status_extra", None)
            extra = dict((parent() if parent else None) or {})
            run = self.flight.run if self.flight is not None else None
            extra["flight_run"] = {"running": bool(self.flight and self.flight.running),
                                   "run_id": run.run_id if run else None}
            return extra

        def _close_flight(self):
            # 실행기만 멈춘다. 돌고 있는 비행 스크립트는 별도 유닛이라 그대로 산다 — 다시 뜨면 이어 읽는다.
            if self.flight is not None:
                self.flight.close()

        def on_shutdown(self):
            self._close_flight()
            parent = getattr(super(), "on_shutdown", None)
            if parent is not None:
                parent()

        def shutdown(self):
            self._close_flight()
            super().shutdown()

    FlightRunnerNode.__name__ = FlightRunnerNode.__qualname__ = f"FlightRunner{node_cls.__name__}"
    return FlightRunnerNode


def load_class(spec: str) -> type:
    mod, _, name = spec.partition(":")
    return getattr(importlib.import_module(mod), name or "DroneNode")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m flight_runner.node",
                                 description="드론 노드(DroneNode)에 rtk_test_start / stop / emergency 를 붙여 실행")
    ap.add_argument("--node", default=os.environ.get("FLIGHT_RUNNER_NODE", DEFAULT_NODE),
                    help=f"감쌀 노드 클래스 module:Class (기본 {DEFAULT_NODE})")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from common.node import main as node_main  # 가정 A5

    node_main(with_flight_runner(load_class(a.node)))


if __name__ == "__main__":
    main()
