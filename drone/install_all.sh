#!/usr/bin/env bash
# 새 라즈베리파이 5 에 드론 제어 환경 전체를 깐다 — drone-all 브랜치 하나로 끝나게.
#
#   ./drone/install_all.sh                    # 확인만 (기본) — 아무것도 바꾸지 않는다
#   sudo ./drone/install_all.sh --install     # 아래 1~9 를 설치 (재실행 안전)
#   sudo ./drone/install_all.sh --install --boot   # + 부트 설정(UART·카메라) 패치. 끝나면 재부팅 필요
#   ./drone/install_all.sh --install --dry-run     # 할 일만 보여 준다
#
# 전제: 계정 이름이 physical 이고, 이 저장소를 홈 디렉터리에 clone 했다
#       (git clone -b drone-all <url> /tmp/x && cp -a /tmp/x/. ~ 처럼 — 저장소 루트 = ~).
#       유닛·스크립트에 /home/physical 이 박혀 있다.
#
# 설치하는 것
#   1 apt 패키지          2 mavlink-router(소스 빌드, 고정 커밋)   3 venv 2개(drone · drone_rpi)
#   4 /etc 설정 파일      5 런타임 폴더·그룹                       6 FC 쪽 systemd 유닛
#   7 MQTT 브로커 설정    8 영상 에이전트(drone-agent)             9 비행 실행기(flight_runner)
#   --boot: /boot/firmware/config.txt (UART0 · 카메라 overlay) · cmdline.txt (콘솔 ttyAMA10)
#
# 하지 않는 것: Tailscale 설치·로그인(계정이 필요하다), FC(PX4) 파라미터 변경(QGC 로 사람이 한다)
#
# ★ 기체마다 바꿀 값 — 설치 전에 저장소 파일을 고친다:
#   drone/config/device_id · drone-node.env(DRONE_DEVICE_ID, DRONE_TS_NAME/IP, FC_BAUD) · hw-drone.env(HW_ENTITY_ID)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # ~/drone
ROOT="$(dirname "$HERE")"                               # 저장소 루트 = ~
SVC_USER=physical
MR_COMMIT=2362c620f483cef1edd574fb962a373a288e4b9e      # config/installed-versions.txt
MR_URL=https://github.com/mavlink-router/mavlink-router.git
APT_PKGS=(git meson ninja-build pkg-config gcc g++ systemd-dev python3-pip python3-venv
          mosquitto mosquitto-clients rpicam-apps-lite)

MODE=check; DRY=0; BOOT=0
for a in "$@"; do
  case "$a" in
    --install) MODE=install ;;
    --boot) BOOT=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "모르는 옵션: $a" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }
as_user() { if [ "$(id -un)" = "$SVC_USER" ]; then run "$@"; else run sudo -u "$SVC_USER" -H "$@"; fi; }
inst() { [ "$MODE" = install ]; }

if inst && [ "$DRY" = 0 ] && [ "$(id -u)" != 0 ]; then echo "sudo 로 실행한다: sudo $0 $*" >&2; exit 1; fi
if ! id "$SVC_USER" >/dev/null 2>&1; then bad "계정 $SVC_USER 이 없다"; exit 1; fi
[ "$ROOT" = "/home/$SVC_USER" ] || warn "저장소 루트가 $ROOT 다 — 유닛은 /home/$SVC_USER 를 가정한다"

# 저장소 파일 → 설치 위치 (내용이 다를 때만 복사, 원본은 .bak.<날짜> 로 남긴다)
place() {  # place <src> <dst> [mode]
  local src="$1" dst="$2" mode="${3:-0644}"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then ok "$dst"; return; fi
  if inst; then
    [ -f "$dst" ] && run cp -a "$dst" "$dst.bak.$(date +%Y%m%d%H%M%S)"
    run install -D -m "$mode" "$src" "$dst"; ok "$dst ← ${src#$ROOT/}"
  else
    [ -f "$dst" ] && warn "$dst 가 저장소와 다르다" || warn "$dst 없음"
  fi
}

step "1. apt 패키지"
missing=()
for p in "${APT_PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ ${#missing[@]} = 0 ]; then ok "전부 있음"
elif inst; then run apt-get update -q; run apt-get install -y -q "${missing[@]}"; ok "설치: ${missing[*]}"
else warn "없음: ${missing[*]}"; fi
command -v tailscale >/dev/null && ok "tailscale $(tailscale version 2>/dev/null | head -1)" \
  || warn "tailscale 없음 — 수동: curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up (QGC 원격 접속용)"

step "2. mavlink-router (커밋 ${MR_COMMIT:0:8})"
if command -v mavlink-routerd >/dev/null && mavlink-routerd --version 2>&1 | grep -q "g${MR_COMMIT:0:7}"; then
  ok "$(mavlink-routerd --version 2>&1 | head -1)"
elif inst; then
  SRC="$HERE/src/mavlink-router"
  [ -d "$SRC/.git" ] || as_user git clone --recursive "$MR_URL" "$SRC"
  as_user git -C "$SRC" fetch -q origin
  as_user git -C "$SRC" checkout -q "$MR_COMMIT"
  as_user git -C "$SRC" submodule update --init --recursive
  [ -d "$SRC/build" ] || as_user meson setup "$SRC/build" "$SRC"
  as_user ninja -C "$SRC/build"
  run ninja -C "$SRC/build" install
  run systemctl disable --now mavlink-router 2>/dev/null || true   # 업스트림 유닛은 쓰지 않는다 — drone-mavlink-router 가 띄운다
  ok "빌드·설치 → /usr/bin/mavlink-routerd"
else warn "mavlink-routerd 없음 또는 다른 버전"; fi

step "3. 파이썬 가상환경"
mkvenv() {  # mkvenv <dir> <requirements> <import-check>
  local dir="$1" req="$2" chk="$3"
  if [ -x "$dir/venv/bin/python" ] && "$dir/venv/bin/python" -c "$chk" 2>/dev/null; then ok "${dir#$ROOT/}/venv"; return; fi
  if inst; then
    [ -d "$dir/venv" ] || as_user python3 -m venv "$dir/venv"
    as_user "$dir/venv/bin/pip" install -q --upgrade pip
    as_user "$dir/venv/bin/pip" install -q -r "$req"
    ok "${dir#$ROOT/}/venv ← ${req#$ROOT/}"
  else warn "${dir#$ROOT/}/venv 없음 또는 패키지 부족"; fi
}
mkvenv "$HERE" "$HERE/config/requirements.lock.txt" "import mavsdk, pymavlink, paho.mqtt, google.protobuf"
mkvenv "$ROOT/drone_rpi" "$ROOT/drone_rpi/requirements.txt" "import numpy, cv2"

step "4. /etc 설정 파일"
place "$HERE/config/drone-node.env" /etc/drone-node.env
place "$HERE/config/hw-node.env"    /etc/hw-node.env
place "$HERE/config/hw-drone.env"   /etc/hw-drone.env
place "$HERE/config/device_id"      /etc/device_id
if [ -L "$HERE/config/drone.env" ]; then ok "drone/config/drone.env → /etc/drone-node.env"
elif inst; then as_user ln -sfn /etc/drone-node.env "$HERE/config/drone.env"; ok "drone/config/drone.env 링크 생성"
else warn "drone/config/drone.env 링크 없음"; fi
id1="$(tr -d '[:space:]' < "$HERE/config/device_id")"
grep -q "^DRONE_DEVICE_ID=$id1$" "$HERE/config/drone-node.env" && grep -q "^HW_ENTITY_ID=$id1$" "$HERE/config/hw-drone.env" \
  && ok "기기 ID 세 곳 일치: $id1" || bad "기기 ID 불일치 — device_id · drone-node.env · hw-drone.env 를 맞출 것"

step "5. 런타임 폴더 · 그룹"
for d in "$HERE/logs" "$HERE/state" "$ROOT/cansar_logs"; do
  if [ -d "$d" ]; then ok "$d"; elif inst; then as_user mkdir -p "$d"; ok "$d 생성"; else warn "$d 없음"; fi
done
for g in dialout video; do
  if id -nG "$SVC_USER" | tr ' ' '\n' | grep -qx "$g"; then ok "$SVC_USER ∈ $g"
  elif inst; then run usermod -aG "$g" "$SVC_USER"; ok "$SVC_USER 를 $g 에 추가 (다시 로그인해야 반영)"
  else warn "$SVC_USER 가 $g 그룹이 아니다"; fi
done

step "6. FC 쪽 systemd 유닛"
for u in drone-detect.service drone-mavlink-router.service drone-linkmon.service drone-node.service drone.target; do
  place "$HERE/systemd/$u" "/etc/systemd/system/$u"
done
if inst; then
  run systemctl daemon-reload
  run systemctl enable drone-detect drone-node drone-mavlink-router drone-linkmon   # 뒤의 둘은 drone.target 에 매달린다
  run systemctl restart drone-detect drone-node
  ok "enable: drone-detect drone-node (+ drone.target 소속 2개)"
else
  for u in drone-detect drone-node; do systemctl is-enabled --quiet "$u" 2>/dev/null && ok "$u enabled" || warn "$u 꺼짐"; done
fi

step "7. MQTT 브로커"
place "$HERE/config/mosquitto-hw.conf" /etc/mosquitto/conf.d/hw.conf
if inst; then run systemctl enable mosquitto; run systemctl restart mosquitto; ok "mosquitto 재시작 (1883 · ws 9001)"
else systemctl is-active --quiet mosquitto && ok "mosquitto 동작 중" || warn "mosquitto 멈춤"; fi

step "8. 영상 에이전트 (drone_rpi)"
if inst; then
  if [ "$DRY" = 1 ]; then echo "  [dry-run] drone_rpi/install_service.sh"; else (cd "$ROOT/drone_rpi" && ./install_service.sh); fi
else
  cmp -s "$ROOT/drone_rpi/drone-agent.service" /etc/systemd/system/drone-agent.service \
    && ok "drone-agent 유닛 = 저장소" || warn "drone-agent 유닛 없음 또는 다름"
fi

step "9. 비행 실행기 (flight_runner)"
if inst; then
  fr=("$HERE/flight_runner/deploy/install.sh" --install); [ "$DRY" = 1 ] && fr+=(--dry-run)
  "${fr[@]}"
else
  "$HERE/flight_runner/deploy/install.sh" | sed 's/^/  /' || true
fi

step "부트 설정 (--boot)"
CFG=/boot/firmware/config.txt; CMD=/boot/firmware/cmdline.txt
boot_lines=(dtparam=uart0=on dtoverlay=imx708 "dtoverlay=arducam-pivariety,cam0")
need=()
for l in "${boot_lines[@]}"; do grep -qxF "$l" "$CFG" || need+=("$l"); done
grep -qx 'camera_auto_detect=0' "$CFG" || need+=(camera_auto_detect=0)
grep -q 'console=serial0' "$CMD" && need+=("cmdline console=ttyAMA10")
if [ ${#need[@]} = 0 ]; then ok "UART0 · 카메라 overlay · 콘솔 ttyAMA10 — 전부 적용돼 있다"
elif inst && [ "$BOOT" = 1 ]; then
  stamp="$(date +%Y%m%d%H%M%S)"
  run cp -a "$CFG" "$CFG.bak.$stamp"; run cp -a "$CMD" "$CMD.bak.$stamp"
  # 정본은 drone/config/boot/config.txt — 여기서는 필요한 줄만 고친다(다른 보드 설정을 덮지 않게)
  run sed -i 's/^camera_auto_detect=1$/camera_auto_detect=0/' "$CFG"
  add=(); for l in "${boot_lines[@]}"; do grep -qxF "$l" "$CFG" || add+=("$l"); done
  if [ ${#add[@]} -gt 0 ]; then
    if [ "$DRY" = 1 ]; then echo "  [dry-run] $CFG 끝에 [all] + ${add[*]}"
    else { printf '\n[all]\n# 드론 FC(TELEM2) UART0 · 카메라 2대 — drone/install_all.sh\n'; printf '%s\n' "${add[@]}"; } >> "$CFG"; fi
  fi
  run sed -i 's/console=serial0,115200/console=ttyAMA10,115200/' "$CMD"
  ok "패치함 (백업 .bak.$stamp) — 재부팅해야 적용된다: sudo reboot"
else
  warn "필요: ${need[*]}  →  sudo $0 --install --boot  (정본: drone/config/boot/config.txt)"
fi

step "사람이 할 일"
echo "  - FC(PX4) TELEM2 보율이 drone-node.env 의 FC_BAUD 와 같은지 QGC 로 확인 (pi3 FC = 230400)"
echo "  - tailscale up 후 drone-node.env 의 DRONE_TS_IP 를 그 Pi 값으로 (QGC 접속: TCP <ip>:5760)"
echo "  - 카메라 index: rpicam-hello --list-cameras 가 drone_rpi/config.json 의 cameras 와 맞는지"
echo "  - 확인: cat ~/drone/state/mode (drone 이면 FC 링크 OK) · curl localhost:8890/api/health"
