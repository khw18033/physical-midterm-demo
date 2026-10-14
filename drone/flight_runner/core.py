"""비행 실행기 본체 — test_sar_rtk.py · emergency_land.py 를 **고치지 않고** 옵션으로 띄우고, 출력을 따라 읽어 상태를 낸다.

규약: 가시화 저장소의 `261014_드론비행실행기_요청_VZ.md` (명령 §2 · 실행기 §3 · 상태 토픽 §4).
이 파일은 드론 노드 공통 틀(BaseNode)을 모른다 — 붙이는 것은 `node.py`, 손으로 시험하는 것은 `cli.py`.

    params(map<string,double>) ─ build_*_argv ─▶ Launcher.launch ─▶ (systemd 유닛) python -u test_sar_rtk.py --yes …
                                                                            │ stdout·stderr
    publish(flight_run 본문) ◀─ report() ◀─ 따라 읽기(_pump) ◀── <out_dir>/<run_id>.out

지키는 것
  · 스크립트는 실행기와 **다른 cgroup** 에서 돈다(systemd 유닛). 실행기 · 노드가 재시작돼도 비행은 계속된다.
    재시작하면 상태 파일(runner_state.json)로 같은 유닛 · 같은 출력 파일에 다시 붙는다.
  · 중단은 **주 프로세스에만** SIGTERM — 스크립트가 Ctrl+C 와 같이 처리한다(캡처 OFF → --abort).
    그룹 전체에 보내면 mavsdk_server 가 먼저 죽어 abort 를 못 보낸다.
  · 출력은 가공하지 않는다. 가시화가 원문을 읽어 단계를 판정한다.
  · 비행 스크립트는 사람이 화면에서 누를 때만 뜬다 — 여기에 자동 실행 · 재시도 경로는 없다.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

HOME = Path("/home/physical")
DEFAULT_PYTHON = HOME / "drone" / "venv" / "bin" / "python"
DEFAULT_SCRIPTS = HOME / "drone" / "scripts"
DEFAULT_OUT_DIR = HOME / "cansar_logs" / "runner"

KEEP_LINES = 200          # 상태 토픽에 싣는 최근 줄 수 (규약 §4)
PUBLISH_MIN_S = 0.5       # 새 줄이 있어도 이보다 자주 내지 않는다 (최대 2 Hz)
PUBLISH_IDLE_S = 5.0      # 줄이 없어도 이 주기로 낸다
PUMP_S = 0.2

PATTERN = {0: "fb", 1: "lr", 2: "rotate"}
SIDE = {0: "forward", 1: "back", 2: "right", 3: "left"}
ABORT = {0: "rtl", 1: "hold", 2: "land"}
EMERGENCY = {0: "land", 1: "rtl", 2: "hold"}

# 파라미터 키 → 스크립트 옵션 (규약 §2-1). 고정 키(pattern·side·dry_run·confirmed·abort)는 따로 다룬다.
NUMERIC_FLAGS = {
    "altitude_m": "--altitude",
    "length_m": "--length",
    "speed_mps": "--speed",
    "passes": "--passes",
    "gap_s": "--gap",
    "heading_deg": "--heading",
    "accept_radius_m": "--accept-radius",
    "align_hold_s": "--align-hold",
    "settle_s": "--settle",
    "rtk_min_s": "--rtk-min",
    "rtk_timeout_s": "--rtk-timeout",
}
START_KEYS = set(NUMERIC_FLAGS) | {"pattern", "side", "abort", "dry_run", "confirmed"}


class Rejected(Exception):
    """명령을 받지 않는다. 공통 틀의 거절과 같은 모양(code · message) — message 는 가시화가 풀어 쓰는 값이다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# ── 파라미터 → 명령줄 ──────────────────────────────────────────────────

def _num(value) -> str:
    v = float(value)
    return str(int(v)) if v.is_integer() else repr(v)


def _code(params: dict, key: str, table: dict, required: bool) -> str | None:
    if key not in params:
        if required:
            raise Rejected("INVALID_ARGUMENT", f"missing {key}")
        return None
    v = float(params[key])
    if not v.is_integer() or int(v) not in table:
        raise Rejected("INVALID_ARGUMENT", f"{key}={params[key]} not in {sorted(table)}")
    return table[int(v)]


def build_start_argv(params: dict) -> tuple[list[str], bool]:
    """`rtk_test_start` 파라미터 → test_sar_rtk.py 옵션. (옵션, dry_run). 범위 검사는 스크립트(ap.error)에 맡긴다."""
    unknown = set(params) - START_KEYS
    if unknown:
        raise Rejected("INVALID_ARGUMENT", f"unknown parameter {', '.join(sorted(unknown))}")
    pattern = _code(params, "pattern", PATTERN, required=True)
    rotate = pattern == "rotate"
    dry = _code(params, "dry_run", {0: False, 1: True}, required=True)
    if not dry and params.get("confirmed") != 1:
        raise Rejected("INVALID_ARGUMENT", "not_confirmed")
    for key in ("altitude_m", "passes") + (() if rotate else ("length_m", "speed_mps")):
        if key not in params:
            raise Rejected("INVALID_ARGUMENT", f"missing {key}")
    passes = float(params["passes"])
    if not passes.is_integer():
        raise Rejected("INVALID_ARGUMENT", "passes must be an integer")

    # --yes: 붙이지 않으면 스크립트가 「터미널이 아니다」로 거부한다(ask_yes). 사람의 확인은 화면이 받았다(confirmed).
    argv = ["--yes", "--pattern", pattern]
    side = _code(params, "side", SIDE, required=not rotate)
    if not rotate:
        argv += ["--side", side]
    for key, flag in NUMERIC_FLAGS.items():
        if key not in params or (rotate and key in ("length_m", "speed_mps")):
            continue
        argv += [flag, _num(params[key])]
    abort = _code(params, "abort", ABORT, required=False)
    if abort is not None:
        argv += ["--abort", abort]
    if dry:
        argv.append("--dry-run")
    return argv, bool(dry)


def build_emergency_argv(params: dict) -> tuple[list[str], str]:
    unknown = set(params) - {"mode"}
    if unknown:
        raise Rejected("INVALID_ARGUMENT", f"unknown parameter {', '.join(sorted(unknown))}")
    mode = _code(params, "mode", EMERGENCY, required=False) or "land"
    return ([] if mode == "land" else [f"--{mode}"]), mode


# ── 띄우는 쪽 ────────────────────────────────────────────────────────────

class Launcher(Protocol):
    def launch(self, unit: str, argv: list[str], out_path: Path, cwd: Path) -> None: ...
    def poll(self, unit: str) -> tuple[bool, int | None]:
        """(돌고 있나, 종료 코드). 끝났으면 종료 코드 — 신호로 죽었으면 -신호번호. 모르면 None."""
    def signal_main(self, unit: str, sig: int) -> None: ...
    def cleanup(self, unit: str) -> None: ...


def _run(cmd: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


class SystemdLauncher:
    """`systemd-run` 으로 별도 유닛을 만든다 — 지금 tmux 로 띄우는 것과 같은 효과.

    scope="user"   사용자 systemd(`--user`). sudo 가 필요 없다. `loginctl enable-linger physical` 이 있어야
                   로그인 없이도 사용자 관리자가 떠 있다. drone-node(NoNewPrivileges=yes)에서도 부를 수 있다.
    scope="system" 시스템 systemd. root 이거나 sudo(-n, 좁힌 sudoers)가 있어야 한다. --uid/--gid 로 physical 로 돈다.
    """

    def __init__(self, scope: str = "user", sudo: bool = False, user: str = "physical") -> None:
        if scope not in ("user", "system"):
            raise ValueError(scope)
        self.scope, self.sudo, self.user = scope, sudo, user

    def _systemctl(self, *args: str) -> list[str]:
        base = (["sudo", "-n"] if self.sudo else []) + ["systemctl"]
        return base + (["--user"] if self.scope == "user" else []) + list(args)

    def launch(self, unit: str, argv: list[str], out_path: Path, cwd: Path) -> None:
        cmd = (["sudo", "-n"] if self.sudo else []) + ["systemd-run"]
        if self.scope == "user":
            cmd.append("--user")
        else:
            cmd += [f"--uid={self.user}", f"--gid={self.user}"]
        cmd += [
            f"--unit={unit}", "--quiet",
            # 끝난 뒤에도 유닛을 남겨 종료 코드를 읽는다 — 안 남기면 정상 종료 즉시 내려가 ExecMainStatus 를 잃는다.
            "-p", "RemainAfterExit=yes",
            # SIGTERM 은 주 프로세스에만, 시간이 지나면 나머지까지 — 그룹 전체에 SIGTERM 이 가면 mavsdk_server 가 먼저 죽는다.
            "-p", "KillMode=mixed", "-p", "TimeoutStopSec=60",
            "-p", f"WorkingDirectory={cwd}",
            "-p", f"StandardOutput=append:{out_path}", "-p", f"StandardError=append:{out_path}",
            "--setenv=PYTHONUNBUFFERED=1",
            *argv,
        ]
        r = _run(cmd, timeout=15)
        if r.returncode != 0:
            raise Rejected("UNAVAILABLE", f"systemd-run failed: {(r.stderr or r.stdout).strip()[:300]}")

    def poll(self, unit: str) -> tuple[bool, int | None]:
        r = _run(self._systemctl("show", unit, "-p", "LoadState,ActiveState,SubState,MainPID,ExecMainCode,ExecMainStatus"))
        props = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
        if props.get("LoadState") == "not-found":
            return False, None
        if props.get("SubState") in ("running", "start", "start-pre", "start-post", "stop-sigterm", "stop-sigkill", "stop", "reload") \
                or props.get("MainPID", "0") not in ("", "0"):
            return True, None
        status = props.get("ExecMainStatus")
        if status is None or status == "":
            return False, None
        code = int(status)
        # ExecMainCode 1=CLD_EXITED(코드) · 2=CLD_KILLED · 3=CLD_DUMPED(신호)
        return False, (-code if props.get("ExecMainCode") in ("2", "3") else code)

    def signal_main(self, unit: str, sig: int) -> None:
        name = signal.Signals(sig).name
        # systemd 252+ 는 --kill-whom, 그 전은 --kill-who. 앞엣것이 안 되면 뒤엣것.
        for flag in ("--kill-whom=main", "--kill-who=main"):
            r = _run(self._systemctl("kill", flag, f"--signal={name}", unit))
            if r.returncode == 0:
                return
        raise Rejected("UNAVAILABLE", f"systemctl kill failed: {(r.stderr or r.stdout).strip()[:300]}")

    def cleanup(self, unit: str) -> None:
        # RemainAfterExit 로 남겨 둔 유닛을 내린다. 프로세스는 이미 끝났다.
        _run(self._systemctl("stop", unit))
        _run(self._systemctl("reset-failed", unit))


class LocalLauncher:
    """시험 · 개발용 — 같은 프로세스 그룹 밖(새 세션)의 자식 프로세스. 실행기가 죽으면 유닛과 달리 다시 못 붙는다."""

    def __init__(self) -> None:
        self.procs: dict[str, subprocess.Popen] = {}

    def launch(self, unit: str, argv: list[str], out_path: Path, cwd: Path) -> None:
        out = open(out_path, "ab")
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        kwargs = {"start_new_session": True} if os.name == "posix" else {}
        try:
            self.procs[unit] = subprocess.Popen(argv, cwd=cwd, stdout=out, stderr=subprocess.STDOUT, env=env, **kwargs)
        except OSError as e:
            raise Rejected("UNAVAILABLE", f"launch failed: {e}") from None
        finally:
            out.close()

    def poll(self, unit: str) -> tuple[bool, int | None]:
        p = self.procs.get(unit)
        if p is None:
            return False, None
        code = p.poll()
        return (True, None) if code is None else (False, code)

    def signal_main(self, unit: str, sig: int) -> None:
        p = self.procs.get(unit)
        if p is not None and p.poll() is None:
            p.send_signal(sig)

    def cleanup(self, unit: str) -> None:
        self.procs.pop(unit, None)


# ── 실행 하나 ───────────────────────────────────────────────────────────

@dataclass
class Proc:
    kind: str                       # "run" · "emergency"
    run_id: str
    unit: str
    out_path: str
    argv: list[str]
    command_id: str | None = None
    dry_run: bool | None = None
    mode: str | None = None
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    exit_code: int | None = None
    state: str = "running"          # running · exited
    # 따라 읽기 — 상태 파일에는 안 남긴다(파일을 처음부터 다시 읽으면 같은 seq 가 나온다)
    seq: int = 0
    offset: int = 0
    partial: bytes = b""
    lines: deque = field(default_factory=lambda: deque(maxlen=KEEP_LINES))

    def meta(self) -> dict:
        return {k: getattr(self, k) for k in ("kind", "run_id", "unit", "out_path", "argv", "command_id", "dry_run",
                                             "mode", "started_at", "ended_at", "exit_code", "state")}

    def wire(self) -> dict:
        body = {"run_id": self.run_id, "command_id": self.command_id, "state": self.state, "dry_run": self.dry_run,
                "argv": self.argv, "started_at": self.started_at, "ended_at": self.ended_at, "exit_code": self.exit_code,
                "out_path": self.out_path, "lines": [{"seq": s, "text": t} for s, t in self.lines]}
        if self.mode is not None:
            body["mode"] = self.mode
        return body


def _run_id(now: float | None = None) -> str:
    return datetime.fromtimestamp(now or time.time()).strftime("%Y%m%d_%H%M%S")


# ── 실행기 ──────────────────────────────────────────────────────────────

class FlightRunner:
    """명령 셋(start · stop · emergency)과 상태(report). 스레드에서 불러도 된다."""

    def __init__(self, launcher: Launcher, publish: Callable[[dict], None], *, device_id: str, zone_id: str = "zoneA",
                 node_id: str = "", python: Path = DEFAULT_PYTHON, scripts: Path = DEFAULT_SCRIPTS,
                 out_dir: Path = DEFAULT_OUT_DIR, clock: Callable[[], float] = time.time,
                 read_only: bool = False) -> None:
        self.launcher = launcher
        self._publish = publish
        self.device_id, self.zone_id, self.node_id = device_id, zone_id, node_id
        self.python, self.scripts, self.out_dir = Path(python), Path(scripts), Path(out_dir)
        self.clock = clock
        # 읽기 전용 — 남(노드 안의 실행기)이 쥔 실행을 들여다보기만 한다. 상태 파일을 안 쓰고 끝난 유닛도 안 치운다
        # (치우면 주인이 종료 코드를 잃는다). cli 의 status · follow 가 쓴다.
        self.read_only = read_only
        self.run: Proc | None = None
        self.emergency: Proc | None = None
        self._lock = threading.RLock()
        self._dirty = True
        self._last_pub = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self._restore()

    # ── 상태 파일 ──
    @property
    def state_path(self) -> Path:
        return self.out_dir / "runner_state.json"

    def _save(self) -> None:
        if self.read_only:
            return
        data = {"run": self.run.meta() if self.run else None, "emergency": self.emergency.meta() if self.emergency else None}
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.state_path)

    def _restore(self) -> None:
        """실행기가 다시 떴다 — 지난 실행에 다시 붙는다. 출력 파일을 처음부터 읽어 같은 seq 를 다시 만든다."""
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for kind in ("run", "emergency"):
            meta = data.get(kind)
            if not meta:
                continue
            proc = Proc(**meta)
            self._read(proc)
            setattr(self, kind, proc)

    # ── 명령 ──
    def precheck(self, action: str, params: dict) -> None:
        """입출력 없이 — 받을 수 있는 명령인가. 안 되면 Rejected (공통 틀의 validate 에서 부른다)."""
        with self._lock:
            if action == "rtk_test_start":
                if self.run is not None and self.run.state == "running":
                    raise Rejected("FAILED_PRECONDITION", "already_running")
                build_start_argv(params)
            elif action == "rtk_test_stop":
                if self.run is None or self.run.state != "running":
                    raise Rejected("FAILED_PRECONDITION", "not_running")
            elif action == "rtk_test_emergency":
                if self.emergency is not None and self.emergency.state == "running":
                    raise Rejected("FAILED_PRECONDITION", "already_running")
                build_emergency_argv(params)
            else:
                raise Rejected("UNIMPLEMENTED", f"action {action} not supported")

    def _new_proc(self, kind: str, prefix: str, argv: list[str], command_id: str | None, **extra) -> Proc:
        run_id = _run_id(self.clock())
        n = 1
        while (self.out_dir / f"{run_id}.out").exists() or (self.out_dir / f"{run_id}-e.out").exists():
            n += 1
            run_id = f"{_run_id(self.clock())}_{n}"
        out = self.out_dir / (f"{run_id}.out" if kind == "run" else f"{run_id}-e.out")
        return Proc(kind=kind, run_id=run_id, unit=f"{prefix}-{run_id.replace('_', '-')}", out_path=str(out), argv=argv,
                    command_id=command_id, started_at=self.clock(), **extra)

    def _launch(self, proc: Proc, script: str, args: list[str]) -> None:
        Path(proc.out_path).touch()
        self.launcher.launch(proc.unit, [str(self.python), "-u", str(self.scripts / script), *args],
                             Path(proc.out_path), self.scripts.parent)

    def start(self, command_id: str | None, params: dict) -> Proc:
        with self._lock:
            self.precheck("rtk_test_start", params)
            args, dry = build_start_argv(params)
            proc = self._new_proc("run", "test-sar-rtk", args, command_id, dry_run=dry)
            self._launch(proc, "test_sar_rtk.py", args)
            self.run = proc
            self._changed()
            return proc

    def stop(self) -> Proc:
        with self._lock:
            self.precheck("rtk_test_stop", {})
            self.launcher.signal_main(self.run.unit, signal.SIGTERM)
            return self.run

    def emergency_land(self, command_id: str | None, params: dict) -> Proc:
        with self._lock:
            self.precheck("rtk_test_emergency", params)
            args, mode = build_emergency_argv(params)
            proc = self._new_proc("emergency", "emergency-land", args, command_id, mode=mode)
            self._launch(proc, "emergency_land.py", args)
            self.emergency = proc
            self._changed()
            return proc

    # ── 따라 읽기 · 내기 ──
    def _changed(self) -> None:
        self._dirty = True
        self._save()

    def _read(self, proc: Proc) -> bool:
        try:
            with open(proc.out_path, "rb") as f:
                f.seek(proc.offset)
                chunk = f.read()
        except OSError:
            return False
        if not chunk:
            return False
        proc.offset += len(chunk)
        data = proc.partial + chunk
        *done, proc.partial = data.split(b"\n")
        for raw in done:
            proc.seq += 1
            proc.lines.append((proc.seq, raw.rstrip(b"\r").decode("utf-8", errors="replace")))
        return bool(done)

    def _finish(self, proc: Proc, code: int | None) -> None:
        self._read(proc)
        if proc.partial:
            proc.seq += 1
            proc.lines.append((proc.seq, proc.partial.rstrip(b"\r").decode("utf-8", errors="replace")))
            proc.partial = b""
        proc.state, proc.exit_code, proc.ended_at = "exited", code, self.clock()
        try:
            if not self.read_only:
                self.launcher.cleanup(proc.unit)
        except Exception:  # noqa: BLE001 — 정리 실패로 상태를 잃지 않는다
            pass
        self._changed()

    def pump(self) -> None:
        """한 바퀴: 새 줄 읽기 · 종료 확인 · 필요하면 내기. 배경 스레드가 PUMP_S 마다 부른다(시험은 직접)."""
        with self._lock:
            for proc in (self.run, self.emergency):
                if proc is None or proc.state != "running":
                    continue
                if self._read(proc):
                    self._dirty = True
                running, code = self.launcher.poll(proc.unit)
                if not running:
                    self._finish(proc, code)
            now = self.clock()
            if (self._dirty and now - self._last_pub >= PUBLISH_MIN_S) or now - self._last_pub >= PUBLISH_IDLE_S:
                self.publish_now()

    def report(self) -> dict:
        with self._lock:
            return {
                "schema_version": "1",
                "source_id": self.device_id, "node_id": self.node_id, "zone_id": self.zone_id,
                "timestamp": datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds"),
                "run": self.run.wire() if self.run else None,
                "emergency": self.emergency.wire() if self.emergency else None,
            }

    def publish_now(self) -> None:
        body = self.report()
        self._dirty = False
        self._last_pub = self.clock()
        try:
            self._publish(body)
        except Exception:  # noqa: BLE001 — 내기 실패로 따라 읽기를 멈추지 않는다
            pass

    @property
    def running(self) -> bool:
        return self.run is not None and self.run.state == "running"

    def start_background(self) -> None:
        if self._thread is not None:
            return
        def loop():
            while not self._stop.wait(PUMP_S):
                try:
                    self.pump()
                except Exception:  # noqa: BLE001
                    pass
        self._thread = threading.Thread(target=loop, name="flight-runner", daemon=True)
        self._thread.start()

    def close(self) -> None:
        """실행기만 멈춘다 — **돌고 있는 스크립트는 건드리지 않는다**(비행 중 노드 재시작이 RTL 이 되면 안 된다)."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        with self._lock:
            self._save()
