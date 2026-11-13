"""복합 미션 실행기 — `mission_seq.py` 를 옵션으로 띄우고 출력을 따라 읽어 `mission_run` 상태를 낸다.

기존 `FlightRunner`(core.py)를 **상속만** 한다(core.py 는 고치지 않는다). 띄우기(systemd 유닛) · 중단(주 프로세스 SIGTERM) ·
따라 읽기 · 재시작 뒤 이어 붙기는 그대로 물려받고, 바뀌는 것은 셋이다.

  1. 파라미터 → 명령줄: 규약 parameters 가 map<string,double> 이라 단계 목록을 평평한 숫자 키로 받는다.
         step_count=2, s1_kind=2, s1_value=3, s2_kind=0, s2_value=1   →   --step right:3 --step forward:1
  2. 출력의 `[계획] {json}` 줄을 따로 붙잡아 상태의 run.plan 에 싣는다 — 최근 200줄만 싣는 lines 에서는
     긴 비행 중에 밀려 나가기 때문이다. 실행기가 다시 뜨면 출력 파일을 처음부터 읽으므로 다시 채워진다.
  3. 출력 폴더(`cansar_logs/runner_seq`) · 상태 파일 · 유닛 이름(`mission-seq-…`)이 기존 실행기와 따로다.

비상 착륙은 여기서 하지 않는다 — 기존 `rtk_test_emergency`(emergency_land.py)가 어느 스크립트가 날든 같은 일을 한다.
규약 전체: docs/MISSION_SEQ_요청_VZ.md
"""

from __future__ import annotations

import json
import re
import signal
from dataclasses import dataclass
from pathlib import Path

from .core import (ABORT, DEFAULT_PYTHON, DEFAULT_SCRIPTS, HOME, FlightRunner, Proc, Rejected, _code, _num)

DEFAULT_SEQ_OUT_DIR = HOME / "cansar_logs" / "runner_seq"
SCRIPT_SEQ = "mission_seq.py"
UNIT_PREFIX = "mission-seq"
PLAN_TAG = "[계획] ".encode("utf-8")

# s{k}_kind 숫자 → mission_seq 단계 종류. scripts/seq_plan.py 의 KIND_CODE 와 같아야 한다(test_seq.py 가 대조).
KIND = {0: "forward", 1: "back", 2: "right", 3: "left", 4: "cw", 5: "ccw", 6: "hover"}
LAND = {0: "here", 1: "home"}
MAX_STEPS = 20

SEQ_NUMERIC = {
    "altitude_m": "--altitude",
    "speed_mps": "--speed",
    "max_radius_m": "--max-radius",
    "heading_deg": "--heading",
    "accept_radius_m": "--accept-radius",
    "align_hold_s": "--align-hold",
    "settle_s": "--settle",
    "gap_s": "--gap",
    "rtk_min_s": "--rtk-min",
    "rtk_timeout_s": "--rtk-timeout",
}
SEQ_FIXED = {"step_count", "land", "abort", "dry_run", "confirmed"}
RTK_KEYS = {"rtk_min_s", "rtk_timeout_s"}
_STEP_KEY = re.compile(r"^s([1-9]\d*)_(kind|value|speed_mps|capture)$")


def build_seq_argv(params: dict, rtk: bool = True) -> tuple[list[str], bool]:
    """`seq_mission_start` 파라미터 → mission_seq.py 옵션. (옵션, dry_run).
    모양(빠진 키 · 모르는 키 · 정수여야 하는 값)만 본다. 범위는 스크립트(ap.error, 종료 코드 2)에 맡긴다.
    rtk=False 면 RTK 보정이 FC 로 들어오지 않는 것이다 — rtk_* 는 버리고 --rtk-min 0 을 준다."""
    step_keys = {}
    unknown = []
    for key in params:
        m = _STEP_KEY.match(key)
        if m:
            step_keys[key] = (int(m.group(1)), m.group(2))
        elif key not in SEQ_NUMERIC and key not in SEQ_FIXED:
            unknown.append(key)
    if unknown:
        raise Rejected("INVALID_ARGUMENT", f"unknown parameter {', '.join(sorted(unknown))}")

    dry = _code(params, "dry_run", {0: False, 1: True}, required=True)
    if not dry and params.get("confirmed") != 1:
        raise Rejected("INVALID_ARGUMENT", "not_confirmed")
    if "altitude_m" not in params:
        raise Rejected("INVALID_ARGUMENT", "missing altitude_m")
    count = _code(params, "step_count", {n: n for n in range(1, MAX_STEPS + 1)}, required=True)
    beyond = sorted(key for key, (k, _) in step_keys.items() if k > count)
    if beyond:
        raise Rejected("INVALID_ARGUMENT", f"{', '.join(beyond)} beyond step_count={count}")

    argv = ["--yes"]
    for k in range(1, count + 1):
        kind = _code(params, f"s{k}_kind", KIND, required=True)
        if f"s{k}_value" not in params:
            raise Rejected("INVALID_ARGUMENT", f"missing s{k}_value")
        text = f"{kind}:{_num(params[f's{k}_value'])}"
        if f"s{k}_speed_mps" in params:
            text += f"@{_num(params[f's{k}_speed_mps'])}"
        if _code(params, f"s{k}_capture", {0: False, 1: True}, required=False):
            text += "+cap"
        argv += ["--step", text]
    for key, flag in SEQ_NUMERIC.items():
        if key in params and (rtk or key not in RTK_KEYS):
            argv += [flag, _num(params[key])]
    if not rtk:
        argv += ["--rtk-min", "0"]
    land = _code(params, "land", LAND, required=False)
    if land is not None:
        argv += ["--land", land]
    abort = _code(params, "abort", ABORT, required=False)
    if abort is not None:
        argv += ["--abort", abort]
    if dry:
        argv.append("--dry-run")
    return argv, bool(dry)


def steps_of(argv: list[str]) -> list[str]:
    return [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--step"]


@dataclass
class SeqProc(Proc):
    plan: dict | None = None         # 출력의 [계획] 줄 — 상태 파일에는 안 남긴다(출력을 다시 읽으면 다시 나온다)

    def wire(self) -> dict:
        body = super().wire()
        body["script"] = self.script or SCRIPT_SEQ
        body["steps"] = steps_of(self.argv)
        body["plan"] = self.plan
        body["mission_key"] = (self.plan or {}).get("key")
        body["mission_hash"] = (self.plan or {}).get("hash")
        return body


class SeqRunner(FlightRunner):
    """`seq_mission_start` · `seq_mission_stop`. 한 번에 하나 — 기존 실행기와의 배제는 node_seq.py 가 한다."""

    START, STOP = "seq_mission_start", "seq_mission_stop"

    def __init__(self, launcher, publish, *, out_dir: Path = DEFAULT_SEQ_OUT_DIR, python: Path = DEFAULT_PYTHON,
                 scripts: Path = DEFAULT_SCRIPTS, **kwargs) -> None:
        super().__init__(launcher, publish, out_dir=out_dir, python=python, scripts=scripts, **kwargs)

    def _restore(self) -> None:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        meta = data.get("run")
        if meta:
            proc = SeqProc(**meta)
            self._read(proc)
            self.run = proc

    def precheck(self, action: str, params: dict) -> None:
        with self._lock:
            if action == self.START:
                if self.running:
                    raise Rejected("FAILED_PRECONDITION", "already_running")
                build_seq_argv(params)
            elif action == self.STOP:
                if not self.running:
                    raise Rejected("FAILED_PRECONDITION", "not_running")
            else:
                raise Rejected("UNIMPLEMENTED", f"action {action} not supported")

    def start(self, command_id: str | None, params: dict) -> SeqProc:
        with self._lock:
            self.precheck(self.START, params)
            rtk = self._rtk_now()
            args, dry = build_seq_argv(params, rtk=rtk)
            base = self._new_proc("run", UNIT_PREFIX, args, command_id, dry_run=dry, script=SCRIPT_SEQ, rtk=rtk)
            proc = SeqProc(**base.meta())
            self._launch(proc, SCRIPT_SEQ, args)
            self.run = proc
            self._changed()
            return proc

    def stop(self) -> SeqProc:
        with self._lock:
            self.precheck(self.STOP, {})
            self.launcher.signal_main(self.run.unit, signal.SIGTERM)      # 주 프로세스에만
            return self.run

    def emergency_land(self, command_id, params):
        raise Rejected("UNIMPLEMENTED", "use rtk_test_emergency")

    def _read(self, proc: Proc) -> bool:
        # 부모가 읽기 전에 같은 구간에서 [계획] 줄을 찾는다(부모는 최근 KEEP_LINES 줄만 남긴다).
        if isinstance(proc, SeqProc) and proc.plan is None:
            try:
                with open(proc.out_path, "rb") as f:
                    f.seek(proc.offset)
                    chunk = f.read()
            except OSError:
                chunk = b""
            for raw in (proc.partial + chunk).split(b"\n")[:-1]:
                i = raw.find(PLAN_TAG)
                if i >= 0:
                    try:
                        proc.plan = json.loads(raw[i + len(PLAN_TAG):].decode("utf-8"))
                        break
                    except ValueError:
                        pass
        return super()._read(proc)

    def report(self) -> dict:
        body = super().report()
        body["runner"] = "mission_seq"
        body.pop("emergency", None)
        return body
