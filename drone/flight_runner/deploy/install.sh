#!/usr/bin/env bash
# 비행 실행기 Pi 설치 — drone-node 에 rtk_test_start / stop / emergency 를 붙인다.
#
#   ./install.sh                 # 확인만 (기본) — 아무것도 바꾸지 않는다
#   sudo ./install.sh --install  # linger · 출력 폴더 · /etc/flight-runner.env(처음 한 번) · 덮어쓰기 → drone-node 재시작
#   sudo ./install.sh --uninstall  # 덮어쓰기만 걷어 내고 drone-node 재시작 (env · 출력은 남긴다)
#   ./install.sh --install --dry-run  # 할 일만 보여 준다
#
# 바꾸는 것: loginctl enable-linger physical · /etc/flight-runner.env · /etc/systemd/system/drone-node.service.d/60-flight-runner.conf
# 바꾸지 않는 것: HW 의 drone-node.service · ~/hw 코드 · test_sar_rtk.py · emergency_land.py
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SVC_USER="${FLIGHT_RUNNER_USER:-physical}"
HOME_DIR="$(getent passwd "$SVC_USER" | cut -d: -f6)"
DROPIN_DIR=/etc/systemd/system/drone-node.service.d
DROPIN="$DROPIN_DIR/60-flight-runner.conf"
SAR_DROPIN="$DROPIN_DIR/50-sar.conf"
ENV_FILE=/etc/flight-runner.env
OUT_DIR="$HOME_DIR/cansar_logs/runner"

MODE=check; DRY=0
for a in "$@"; do
  case "$a" in
    --install) MODE=install ;;
    --uninstall) MODE=uninstall ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $a" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
need_root() { if [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then echo "sudo 로 실행한다: sudo $0 $*" >&2; exit 1; fi; }

UID_N="$(id -u "$SVC_USER")"
as_user() {
  local envs=(XDG_RUNTIME_DIR="/run/user/$UID_N" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UID_N/bus")
  if [ "$(id -u)" = "$UID_N" ]; then env "${envs[@]}" "$@"; else sudo -n -u "$SVC_USER" "${envs[@]}" "$@"; fi
}

check() {
  FAIL=0
  step "파일"
  [ -x "$HOME_DIR/drone/venv/bin/python3" ] && ok "venv $HOME_DIR/drone/venv" || bad "venv 없음 — $HOME_DIR/drone/venv/bin/python3"
  for f in test_sar_rtk.py emergency_land.py mavsdk_guard.py; do
    [ -f "$HOME_DIR/drone/scripts/$f" ] && ok "scripts/$f" || bad "scripts/$f 없음"
  done
  [ -f "$HOME_DIR/drone/flight_runner/node.py" ] && ok "flight_runner 패키지" || bad "flight_runner 패키지 없음 (git pull?)"
  if [ -f "$HOME_DIR/hw/pi/common/node.py" ]; then
    ok "공통 틀 ~/hw/pi/common/node.py"
    grep -q "ACTIONS" "$HOME_DIR/hw/pi/common/node.py" && ok "  ACTIONS 가 보인다 (가정 A1)" || warn "  ACTIONS 가 안 보인다 — 가정 A1 을 확인할 것"
    # 가정 A6: 명령 서버가 명령마다 새 스레드에서 _execute(cmd, entry) 를 돈다 — node.py 가 그것을 감싸 command_id 를 얻는다
    grep -qE "def _execute\(self, cmd" "$HOME_DIR/hw/pi/common/physical_command.py" 2>/dev/null \
      && grep -qE "target=self\._execute" "$HOME_DIR/hw/pi/common/physical_command.py" \
      && ok "  명령 서버 _execute(cmd, …) 가 보인다 (가정 A6 — command_id 를 얻는 길)" \
      || warn "  명령 서버 _execute(cmd, …) 가 안 보인다 — 가정 A6 이 깨졌다. flight_run 의 command_id 가 비어 「비행 시작」이 안 열린다"
  else bad "공통 틀 ~/hw/pi/common/node.py 없음"; fi

  step "systemd"
  if [ -f "$SAR_DROPIN" ]; then bad "sar_pass 덮어쓰기($SAR_DROPIN)가 있다 — 둘 다 ExecStart 를 바꾼다. PI3_작업_261014.md §5 를 볼 것"
  else ok "sar_pass 덮어쓰기 없음"; fi
  [ -f "$DROPIN" ] && ok "비행 실행기 덮어쓰기 설치됨" || warn "비행 실행기 덮어쓰기 아직 없음 (--install)"
  if loginctl show-user "$SVC_USER" -p Linger 2>/dev/null | grep -q "Linger=yes"; then ok "linger 켜짐 — 로그인 없이도 사용자 systemd 가 떠 있다"
  else warn "linger 꺼짐 — --install 이 켠다 (loginctl enable-linger $SVC_USER)"; fi
  if as_user systemctl --user is-system-running >/dev/null 2>&1 || as_user systemctl --user list-units >/dev/null 2>&1; then ok "사용자 systemd 응답 (/run/user/$UID_N)"
  else warn "사용자 systemd 에 못 붙는다 — linger 를 켜고 다시"; fi
  if as_user systemctl --user list-units 'test-sar-rtk-*' 'emergency-land-*' --no-legend 2>/dev/null | grep -q .; then
    warn "지금 돌고 있는 비행/비상 유닛이 있다 — 설치(노드 재시작)는 비행 스크립트에 영향이 없지만, 착륙 뒤에 하는 편이 낫다"
  fi
  [ -d "$OUT_DIR" ] && ok "출력 폴더 $OUT_DIR" || warn "출력 폴더 $OUT_DIR 없음 (--install 이 만든다)"

  step "drone-node"
  systemctl is-active --quiet drone-node && ok "drone-node 동작 중" || warn "drone-node 멈춤"
  if journalctl -u drone-node -n 300 --no-pager 2>/dev/null | grep -q "비행 실행기 준비"; then ok "「비행 실행기 준비」 로그가 보인다"
  elif [ -f "$DROPIN" ]; then warn "덮어쓰기는 있는데 「비행 실행기 준비」 로그가 없다 — journalctl -u drone-node -n 80"; fi
  return 0
}

# 함수 이름을 install 로 두면 안 된다 — 안의 `run install -d …` 가 /usr/bin/install 대신 이 함수를 다시 불러
# 끝없이 돈다(2026-10-17 pi3 에서 실제로 돌았다. --dry-run 에선 run 이 찍기만 해서 안 드러난다).
do_install() {
  need_root "$@"
  check
  if [ -f "$SAR_DROPIN" ]; then echo; echo "sar_pass 덮어쓰기가 있어 멈춘다." >&2; exit 1; fi
  step "설치"
  run loginctl enable-linger "$SVC_USER"
  run install -d -o "$SVC_USER" -g "$SVC_USER" "$OUT_DIR"
  if [ ! -f "$ENV_FILE" ]; then run install -m 0644 "$HERE/flight-runner.env.example" "$ENV_FILE"; ok "$ENV_FILE 복사"
  else ok "$ENV_FILE 있음 — 그대로 둔다"; fi
  run install -d "$DROPIN_DIR"
  if [ "$DRY" = 1 ]; then printf '  [dry-run] sed s/@UID@/%s/ 60-flight-runner.conf > %s\n' "$UID_N" "$DROPIN"
  else sed "s/@UID@/$UID_N/g" "$HERE/60-flight-runner.conf" > "$DROPIN"; fi
  run systemctl daemon-reload
  run systemctl restart drone-node
  [ "$DRY" = 1 ] || sleep 5
  check
}

do_uninstall() {
  need_root "$@"
  step "덮어쓰기만 걷어 낸다"
  run rm -f "$DROPIN"
  run systemctl daemon-reload
  run systemctl restart drone-node
  ok "drone-node 원래 실행 명령으로 돌아갔다 (env · 출력 폴더는 남김)"
}

case "$MODE" in
  check) check ;;
  install) do_install "$@" ;;
  uninstall) do_uninstall "$@" ;;
esac
