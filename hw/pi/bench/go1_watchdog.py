"""
피지컬팀 mk2 — Go1 카메라 정지 워치독 (HW-R-07 운용 안정성)
=============================================================
**턱 카메라 USB 가 저절로 끊긴다.** 부팅 15~18분 뒤 자발적 재열거가 이틀 연속
관측됐다(dmesg `usb 1-3.2 disconnect` → `usb_suspend_both`). 장치 번호가 밀리면
로봇 카메라 스택이 무너지고 정면 스트림이 **얼어붙는다** — 프레임은 30fps 로 계속
나오므로 프레임 수 감시로는 못 잡고, 복구 방법은 나노 재부팅뿐이다(링크 복원·프로세스
재기동 모두 실패 확인).

시연 중 재발을 사람이 지킬 수 없으므로 이 워치독이 대신 지킨다.

    주기 실행 → 5대 잡음 판정(go1_cam_probe 와 동일 기준) → 정지 발견 시
    해당 나노 ssh 재부팅 → 쿨다운(재부팅 직후 오탐·연속 재부팅 방지)

판정 기준은 go1_cam_probe 와 같다 — **잡음의 유무**. 살아 있는 카메라는 정적
장면에서도 센서 잡음(평균차 0.08~0.25)이 있고, 정지는 0.02 로 잡음조차 없다.

안전장치:
  - 쿨다운 15분: 나노가 재부팅·스택 기동에 ~2분 걸린다. 그 사이 재판정하면
    "포트 안 열림"을 정지로 오판해 재부팅 루프에 빠진다.
  - 상태 파일(/var/tmp)로 마지막 재부팅 시각을 기억 — 워치독 자신이 재시작돼도 유지.
  - --dry-run: 재부팅 대신 로그만. 배선 검증용.

사용:
    python3 -m bench.go1_watchdog --once            # 1회 점검
    python3 -m bench.go1_watchdog --once --dry-run  # 재부팅 없이 판정만
    (상시: systemd 타이머로 5분 주기 --once 실행)

나노 접속은 ssh 키(무암호) + sudo 비밀번호를 쓴다. 키가 없으면 재부팅을 못 하고
로그만 남긴다 — 감시가 로봇을 건드릴 수 있는 경로는 명시적 설정 후에만 열린다.
"""
import argparse
import json
import subprocess
import sys
import time

from robot.go1_camera import CAMS, Go1CameraSource

STILL_MEAN = 0.05           # go1_cam_probe 와 동일 — 잡음 단독 기준
SAMPLE_S = 6.0
COOLDOWN_S = 15 * 60
STATE_PATH = "/var/tmp/go1_watchdog.json"
SUDO_PW = "123"             # 나노 sudo (현장 공용 계정 — 운영 전 교체 대상)
CELL = 32 * 32

# 카메라 → 담당 나노
NANO_OF = {1: "192.168.123.13", 2: "192.168.123.13",
           3: "192.168.123.14", 4: "192.168.123.14", 5: "192.168.123.15"}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def mean_diff(cam_id):
    """카메라 하나의 프레임간 평균차. 수집 실패는 None — 정지와 구분한다
    (안 나오는 것과 얼어붙은 것은 다른 장애이고 대응도 다르다)."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".h264", delete=False) as tf:
        path = tf.name
    try:
        n = 0
        with open(path, "wb") as f:
            t0 = time.time()
            try:
                for chunk in Go1CameraSource(cam_id):
                    f.write(chunk)
                    n += 1
                    if time.time() - t0 > SAMPLE_S:
                        break
            except Exception:
                pass
        if n < 30:
            return None
        raw = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", path,
             "-vf", "scale=32x32,format=gray", "-f", "rawvideo", "pipe:1"],
            stdout=subprocess.PIPE).stdout
        frames = [raw[i * CELL:(i + 1) * CELL] for i in range(len(raw) // CELL)]
        if len(frames) < 2:
            return None
        diffs = [sum(abs(a - b) for a, b in zip(frames[i - 1], frames[i])) / CELL
                 for i in range(1, len(frames))]
        return sum(diffs) / len(diffs)
    finally:
        subprocess.run(["rm", "-f", path])


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(st):
    try:
        with open(STATE_PATH, "w") as f:
            json.dump(st, f)
    except OSError:
        pass


def reboot_nano(host, dry_run):
    if dry_run:
        log(f"  (dry-run) {host} 재부팅 생략")
        return True
    # BatchMode: 키가 없으면 비밀번호 프롬프트에 걸리는 대신 즉시 실패한다
    r = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
         "-o", "ConnectTimeout=8", f"unitree@{host}",
         f"echo {SUDO_PW} | sudo -S sh -c 'sleep 1; systemctl reboot -i' >/dev/null 2>&1 &"],
        capture_output=True, timeout=30)
    if r.returncode != 0:
        log(f"  {host} ssh 실패 — 키 미설정? ({r.stderr.decode(errors='replace').strip()[:80]})")
        return False
    return True


def check_once(dry_run=False):
    st = load_state()
    now = time.time()
    frozen_nanos = set()
    for cid in CAMS:
        m = mean_diff(cid)
        if m is None:
            log(f"카메라 {cid}({CAMS[cid][2]}): 수집 불가 — 정지와 구분되는 별개 장애, 재부팅 안 함")
            continue
        frozen = m < STILL_MEAN
        log(f"카메라 {cid}({CAMS[cid][2]}): 평균차 {m:.3f} → {'⛔ 정지' if frozen else '정상'}")
        if frozen:
            frozen_nanos.add(NANO_OF[cid])

    for host in sorted(frozen_nanos):
        last = st.get(host, 0)
        if now - last < COOLDOWN_S:
            log(f"{host}: 정지 감지했으나 쿨다운 중 ({(COOLDOWN_S - (now - last)) / 60:.0f}분 남음)")
            continue
        log(f"{host}: 정지 → 재부팅")
        # dry-run 은 상태를 기록하지 않는다 — 기록하면 검증 실행이 실제 실행의
        # 쿨다운을 잡아먹는다 (실제로 dry-run 직후 진짜 재부팅이 15분 막혔다)
        if reboot_nano(host, dry_run) and not dry_run:
            st[host] = now
            save_state(st)
    return len(frozen_nanos)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--interval", type=float, default=300.0)
    args = ap.parse_args()
    if args.once:
        # 정지 감지·재부팅은 워치독이 '할 일을 한 것'이므로 0으로 종료한다.
        # (감지·재부팅 내역은 로그에 남는다. systemd oneshot 이 정상 복구를 'failed'로
        #  표시하지 않도록.) ssh 자체 실패 등 실제 오류만 비정상 종료로 남긴다.
        check_once(args.dry_run)
        sys.exit(0)
    while True:
        check_once(args.dry_run)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
