#!/usr/bin/env python3
"""
CPU 사용량 측정기 — /proc 기반 샘플러.

드론 프로그램 / 카메라 코드 / (개발 환경 잡음) 을 그룹으로 나눠서
구간 평균 CPU 사용량을 낸다.

쓰는 법:
  python3 cpuwatch.py --seconds 60 --label drone-only --out results/drone-only.json

출력 단위
  core%   : 코어 1개를 100% 로 본 값 (top 의 %CPU 와 같은 눈금)
  sys%    : 전체 4코어를 100% 로 본 값 (core% / 4)
"""
import argparse, json, os, re, subprocess, sys, time

HZ = os.sysconf("SC_CLK_TCK")          # 보통 100
NCPU = os.cpu_count()

# ── 프로세스 분류 규칙 (위에서부터 먼저 맞는 것) ──────────────────
GROUPS = [
    ("measure", re.compile(r"cpuwatch\.py")),
    # 말단 노드 (drone_rpi/drone-agent.service) — agent.py 와 그 자식 rpicam-vid.
    # camera 그룹보다 먼저 와야 한다. rpicam-vid 는 에이전트가 띄우는 것이다.
    ("agent",   re.compile(r"drone_rpi|agent\.py|rpicam-vid")),
    ("camera",  re.compile(r"cam_capture\.py|rpicam-hello|rpicam-still|libcamera")),
    ("drone",   re.compile(r"drone\.drone_node|fc_detect\.py|linkmon\.py|mavlink-routerd|drone_node|mosquitto")),
    ("noise",   re.compile(r"vscode-server|\.vscode|anthropic\.claude-code|copilot|/claude\b|node --dns-result-order")),
]

def classify(cmdline: str, comm: str) -> str:
    text = cmdline or comm
    for name, pat in GROUPS:
        if pat.search(text):
            return name
    return "other"


def read_proc_stat():
    """/proc/stat 의 cpu 합계 jiffies 를 항목별로 돌려준다."""
    with open("/proc/stat") as f:
        parts = f.readline().split()
    vals = [int(v) for v in parts[1:]]
    keys = ["user", "nice", "system", "idle", "iowait", "irq",
            "softirq", "steal", "guest", "guest_nice"]
    d = dict(zip(keys, vals))
    # guest 는 user 에 이미 포함돼 있어 중복으로 빼 준다.
    total = sum(vals[:8])
    busy = total - d["idle"] - d["iowait"]
    return total, busy, d


def snapshot_procs():
    """살아 있는 모든 PID 의 (utime+stime) jiffies 를 모은다."""
    out = {}
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat") as f:
                raw = f.read()
            # comm 에 공백/괄호가 들어갈 수 있어 마지막 ')' 기준으로 자른다.
            rp = raw.rindex(")")
            comm = raw[raw.index("(") + 1:rp]
            fields = raw[rp + 2:].split()
            utime, stime = int(fields[11]), int(fields[12])
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmdline = f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
            except OSError:
                cmdline = ""
            out[pid] = (utime + stime, comm, cmdline or f"[{comm}]")
        except (OSError, ValueError, IndexError):
            continue
    return out


def temp_throttle():
    def vc(arg):
        try:
            return subprocess.run(["vcgencmd", arg], capture_output=True,
                                  text=True, timeout=3).stdout.strip()
        except Exception:
            return "n/a"
    return vc("measure_temp"), vc("get_throttled")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--warmup", type=float, default=0.0, help="측정 시작 전 버리는 시간(초)")
    ap.add_argument("--label", default="run")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.warmup:
        time.sleep(args.warmup)

    t_temp0, t_thr0 = temp_throttle()
    t0 = time.time()
    sys_total0, sys_busy0, raw0 = read_proc_stat()
    procs0 = snapshot_procs()

    # 구간 내내 살아 있던 프로세스만 신뢰 (중간에 죽거나 뜬 건 따로 모은다)
    n = int(args.seconds / args.interval)
    for _ in range(n):
        time.sleep(args.interval)

    procs1 = snapshot_procs()
    sys_total1, sys_busy1, raw1 = read_proc_stat()
    t1 = time.time()
    t_temp1, t_thr1 = temp_throttle()

    elapsed = t1 - t0
    dtotal = sys_total1 - sys_total0          # jiffies, 전체 코어 합
    if dtotal <= 0:
        print("측정 실패: /proc/stat 델타가 0", file=sys.stderr)
        return 1

    # ── 프로세스별 델타 ────────────────────────────────────────
    per_proc = []
    group_j = {}
    for pid, (j1, comm, cmdline) in procs1.items():
        j0 = procs0[pid][0] if pid in procs0 else 0   # 새로 뜬 프로세스는 0 부터
        dj = j1 - j0
        if dj <= 0:
            continue
        g = classify(cmdline, comm)
        group_j[g] = group_j.get(g, 0) + dj
        per_proc.append({
            "pid": int(pid), "group": g, "comm": comm,
            "jiffies": dj,
            "core_pct": round(dj / HZ / elapsed * 100, 2),
            "cmd": cmdline[:110],
        })
    per_proc.sort(key=lambda r: -r["jiffies"])

    def pct(j):
        return round(j / HZ / elapsed * 100, 2)          # core%

    groups = {g: {"core_pct": pct(j), "sys_pct": round(pct(j) / NCPU, 2)}
              for g, j in sorted(group_j.items(), key=lambda kv: -kv[1])}

    sys_busy_core = round((sys_busy1 - sys_busy0) / dtotal * 100 * NCPU, 2)
    noise_core = pct(group_j.get("noise", 0)) + pct(group_j.get("measure", 0))
    effective_core = round(sys_busy_core - noise_core, 2)

    result = {
        "label": args.label,
        "started": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t0)),
        "elapsed_s": round(elapsed, 2),
        "ncpu": NCPU,
        "groups": groups,
        "system": {
            "busy_core_pct": sys_busy_core,
            "busy_sys_pct": round(sys_busy_core / NCPU, 2),
            "iowait_core_pct": round((raw1["iowait"] - raw0["iowait"]) / dtotal * 100 * NCPU, 2),
            "irq_softirq_core_pct": round(
                ((raw1["irq"] - raw0["irq"]) + (raw1["softirq"] - raw0["softirq"]))
                / dtotal * 100 * NCPU, 2),
        },
        # 개발 환경(VS Code/Claude)과 측정기 자신을 뺀, 드론+카메라+OS 실부하
        "effective_core_pct": effective_core,
        "effective_sys_pct": round(effective_core / NCPU, 2),
        "temp": {"start": t_temp0, "end": t_temp1},
        "throttled": {"start": t_thr0, "end": t_thr1},
        "top_processes": per_proc[:25],
    }

    js = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as f:
            f.write(js + "\n")
    print(js)
    return 0


if __name__ == "__main__":
    sys.exit(main())
