#!/usr/bin/env bash
# 복합 미션 실행기 설치 — drone-node 에 seq_mission_start / stop 을 더한다 (기존 비행 실행기 위에 얹는다).
#
#   ./install_seq.sh                   # 확인만 (기본) — 아무것도 바꾸지 않는다
#   sudo ./install_seq.sh --install    # 출력 폴더 · 61-mission-seq.conf → drone-node 재시작
#   sudo ./install_seq.sh --uninstall  # 61-mission-seq.conf 만 걷어 내고 drone-node 재시작 (60 번 상태로)
#   ./install_seq.sh --install --dry-run
#
# 먼저 기존 비행 실행기(install.sh --install, 60-flight-runner.conf)가 설치돼 있어야 한다.
# 바꾸는 것: /etc/systemd/system/drone-node.service.d/61-mission-seq.conf · ~/cansar_logs/runner_seq
# 바꾸지 않는 것: 60-flight-runner.conf · /etc/flight-runner.env · HW 의 drone-node.service · 모든 비행 스크립트
#
# drone-node 재시작은 돌고 있는 비행 스크립트를 죽이지 않는다(별도 유닛) — 그래도 착륙 뒤에 하는 편이 낫다.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC_USER="${FLIGHT_RUNNER_USER:-physical}"
HOME_DIR="$(getent passwd "$SVC_USER" | cut -d: -f6)"
DROPIN_DIR=/etc/systemd/system/drone-node.service.d
BASE_DROPIN="$DROPIN_DIR/60-flight-runner.conf"
DROPIN="$DROPIN_DIR/61-mission-seq.conf"
OUT_DIR="$HOME_DIR/cansar_logs/runner_seq"
UID_N="$(id -u "$SVC_USER")"

MODE=check; DRY=0
for a in "$@"; do
  case "$a" in
    --install) MODE=install ;;
    --uninstall) MODE=uninstall ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $a" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
need_root() { if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then echo "sudo 로 실행한다: sudo $0 $*" >&2; exit 1; fi; }
as_user() {
  local envs=(XDG_RUNTIME_DIR="/run/user/$UID_N" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UID_N/bus")
  if [ "$(id -u)" = "$UID_N" ]; then env "${envs[@]}" "$@"; else sudo -n -u "$SVC_USER" "${envs[@]}" "$@"; fi
}

check() {
  FAIL=0
  step "파일"
  for f in mission_seq.py seq_plan.py mavsdk_guard.py emergency_land.py; do
    [ -f "$HOME_DIR/drone/scripts/$f" ] && ok "scripts/$f" || bad "scripts/$f 없음 (git pull?)"
  done
  for f in seq.py node_seq.py; do
    [ -f "$HOME_DIR/drone/flight_runner/$f" ] && ok "flight_runner/$f" || bad "flight_runner/$f 없음 (git pull?)"
  done
  step "systemd"
  [ -f "$BASE_DROPIN" ] && ok "기존 비행 실행기 덮어쓰기(60) 설치됨" || bad "60-flight-runner.conf 없음 — 먼저 install.sh --install"
  [ -f "$DROPIN" ] && ok "복합 미션 덮어쓰기(61) 설치됨" || warn "복합 미션 덮어쓰기(61) 아직 없음 (--install)"
  for f in "$DROPIN_DIR"/*.conf; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in 60-flight-runner.conf|61-mission-seq.conf) ;;
      *) grep -q '^ExecStart=' "$f" && warn "$(basename "$f") 도 ExecStart 를 바꾼다 — 이름 순서상 뒤의 것만 산다" ;;
    esac
  done
  if as_user systemctl --user list-units 'test-sar-*' 'mission-seq-*' 'emergency-land-*' --no-legend 2>/dev/null | grep -q .; then
    warn "지금 돌고 있는 비행/비상 유닛이 있다 — 재시작은 비행에 영향이 없지만 착륙 뒤에 하는 편이 낫다"
  fi
  [ -d "$OUT_DIR" ] && ok "출력 폴더 $OUT_DIR" || warn "출력 폴더 $OUT_DIR 없음 (--install 이 만든다)"
  step "drone-node"
  systemctl is-active --quiet drone-node && ok "drone-node 동작 중" || warn "drone-node 멈춤"
  if journalctl -u drone-node -n 300 --no-pager 2>/dev/null | grep -q "복합 미션 실행기 준비"; then ok "「복합 미션 실행기 준비」 로그가 보인다"
  elif [ -f "$DROPIN" ]; then warn "덮어쓰기는 있는데 「복합 미션 실행기 준비」 로그가 없다 — journalctl -u drone-node -n 80"; fi
  return 0
}

do_install() {
  need_root "$@"
  check
  if [ "${FAIL:-0}" = 1 ]; then echo; echo "위 ✗ 를 먼저 해결한다." >&2; exit 1; fi
  step "설치"
  run install -d -o "$SVC_USER" -g "$SVC_USER" "$OUT_DIR"
  run install -m 0644 "$HERE/61-mission-seq.conf" "$DROPIN"
  run systemctl daemon-reload
  run systemctl restart drone-node
  [ "$DRY" = 1 ] || sleep 5
  check
}

do_uninstall() {
  need_root "$@"
  step "61 번 덮어쓰기만 걷어 낸다"
  run rm -f "$DROPIN"
  run systemctl daemon-reload
  run systemctl restart drone-node
  ok "drone-node 가 60 번(기존 비행 실행기) 상태로 돌아갔다 (출력 폴더는 남김)"
}

case "$MODE" in
  check) check ;;
  install) do_install "$@" ;;
  uninstall) do_uninstall "$@" ;;
esac
