"""드론 노드(drone-node.service)에 비행 실행기 명령 셋을 붙인다 — HW 쪽 파일(~/hw/pi)은 한 줄도 고치지 않는다.

    python -m flight_runner.node                                   # 기본: drone.drone_node:DroneNode 를 감싼다
    python -m flight_runner.node --node drone.drone_node:DroneNode

선언하는 action (Capability 로 나간다 → 가시화 「비행 제어」 탭의 버튼이 열린다):
    rtk_test_start · rtk_test_stop · rtk_test_emergency

공통 틀(~/hw/pi/common/node.py · physical_command.py, HW 브랜치 02241ac)과 pi3 에서 대조했다(2026-10-17,
REPORT_pi3_261017.md §2). 처음엔 가시화 쪽 `sar_pass/agent.py` 의 규약을 따른 가정이었다.

확인된 규약
  A1  클래스 속성 `ACTIONS: dict[str, handler]` 의 키가 Capability 로 나간다(`PhysicalCommandServer.publish_capability`).
  A2  handler(owner, params) 는 (stage, detail) 를 내는 제너레이터. 종료 stage("completed")의 마지막 detail(dict)이
      CommandResult.result(map<string,double>) — 다른 stage 는 CommandStatus(EXECUTING, detail=stage).
      params 는 `dict(cmd.parameters)` 라 **값이 모두 float** 이다.
  A3  `validate(action, params)` 가 Acceptance 전에 paho 망 스레드에서 불린다 — 입출력 금지. 예외의 `code`(str) ·
      `message` 가 rejection 이 된다(공통 틀의 `CommandError` 를 상속할 필요 없다 — `_err()` 가 속성만 본다).
      핸들러 안에서 던진 예외는 CommandResult ABORTED(failure.code · message)가 된다.
  A4  `node.publish(topic, payload, qos=, retain=, allow_spool=)` · `node.base`(= identity.topic_base) ·
      `node.identity.entity_id / node_id / zone_id`.
  A5  `common.node.main(cls)` 가 진입점이다(SIGTERM → KeyboardInterrupt → `node.shutdown()`).
      ⚠ 공통 틀의 `shutdown()` 은 `on_shutdown()` 을 부르지 않는다 — 그래서 실행기 정리는 `shutdown()` 에서 한다.
  A6  ★ 공통 틀은 핸들러에 **command_id 를 넘기지 않는다**(params 에도, 노드 속성에도 없다). 대신 수락한 명령마다
      `PhysicalCommandServer._execute(cmd, entry)` 를 **새 스레드**에서 돌린다. 그래서 감싸개가 그 메서드를 노드의
      `pcmd` 인스턴스에서 덮어, 그 스레드의 지역 변수에 command_id 를 적어 둔다 — `command_id_of()` 가 그것을 읽는다.
      공통 틀은 고치지 않는다. 그 메서드 이름이 바뀌면 `_hook_command_id()` 가 경고를 남기고 command_id 는 None 이 된다.
"""

from __future__ import annotations

import argparse
import importlib
import logging
import os
import threading
from pathlib import Path

from .core import DEFAULT_OUT_DIR, DEFAULT_PYTHON, DEFAULT_SCRIPTS, FlightRunner, LocalLauncher, Rejected, SystemdLauncher

log = logging.getLogger("flight_runner.node")

DEFAULT_NODE = "drone.drone_node:DroneNode"


_current = threading.local()     # 명령 스레드마다 — 지금 그 스레드가 돌리는 명령의 command_id (가정 A6)


def command_id_of(node, params: dict) -> str | None:
    """가정 A6 — 지금 처리 중인 명령의 command_id. `_hook_command_id()` 가 명령 스레드에 적어 둔 값."""
    value = getattr(_current, "command_id", None)
    return value if isinstance(value, str) and value else None


def _hook_command_id(node) -> bool:
    """공통 틀의 명령 서버(`node.pcmd`)가 명령마다 새 스레드에서 부르는 `_execute(cmd, entry)` 를 인스턴스에서 감싼다.
    `threading.Thread(target=self._execute, …)` 는 부를 때 속성을 찾으므로 인스턴스 속성이 이긴다."""
    server = getattr(node, "pcmd", None)
    original = getattr(server, "_execute", None)
    if original is None:
        log.warning("명령 서버(pcmd._execute)를 못 찾았다 — flight_run 의 command_id 가 비어 「비행 시작」이 안 열린다")
        return False

    def execute(cmd, *args, **kwargs):
        _current.command_id = getattr(cmd, "command_id", None)
        try:
            return original(cmd, *args, **kwargs)
        finally:
            _current.command_id = None

    server._execute = execute
    return True


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
            _hook_command_id(self)          # 가정 A6 — self.flight 를 채우기 전에(그 전엔 validate 가 거절한다)
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
            # 공통 틀의 main 은 SIGTERM 에 shutdown() 만 부른다(on_shutdown 은 안 부른다) — 그래서 여기서도 닫는다.
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
