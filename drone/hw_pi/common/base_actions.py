# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 - 공통 명령 어휘 (모든 노드가 공유)
====================================================
명령 엔진과 무관한 순수 어휘다. 핸들러는 (stage, detail) 을 내는 제너레이터로,
규약 서버(physical_command.PhysicalCommandServer)가 그대로 소비한다.

  - 종료 stage: "completed" (물리 상태 확정) -> 규약 서버가 CommandResult 로 변환.
  - 중간 stage: "executing"/"state_changed" 등 -> CommandStatus 로 변환.
"""
import time

def act_ping(node, params):
    yield "executing", None
    yield "completed", {"uptime_s": round(time.time() - node.started, 1)}


def act_diag(node, params):
    """진단 — 노드가 지금 무엇을 하고 있는지 한 번에 돌려준다. 현장에서
    journalctl 을 못 볼 때 원격으로 상태를 확인하는 경로."""
    yield "executing", None
    yield "completed", node.diagnostics()


BASE_ACTIONS = {"ping": act_ping, "diag": act_diag}
