#!/usr/bin/env bash
# 피지컬팀 mk2 — /etc 설정 복원 스크립트
# 사용법:  sudo ./restore.sh
# 자세한 설명은 README.md 참고.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ "$(id -u)" -ne 0 ]; then
  echo "root 권한이 필요합니다:  sudo $0" >&2
  exit 1
fi

if [ ! -d /home/physical/hw/pi ]; then
  echo "경고: /home/physical/hw/pi 가 없습니다." >&2
  echo "      유닛 파일이 이 경로를 하드코딩하고 있으므로 코드를 먼저 배치하세요." >&2
  read -r -p "그래도 계속할까요? [y/N] " a
  [ "$a" = "y" ] || exit 1
fi

install_file() {  # $1=출처(SRC 기준 상대) $2=대상
  local from="$SRC/$1" to="$2"
  if [ -e "$to" ] && ! cmp -s "$from" "$to"; then
    cp -p "$to" "$to.bak-$STAMP"
    echo "  기존 파일 백업 -> $to.bak-$STAMP"
  fi
  install -m 644 -o root -g root "$from" "$to"
  echo "  설치: $to"
}

echo "[1/3] /etc 설정 파일 복원"
for f in hw-node.env hw-robot.env device_id zone_id; do
  install_file "etc/$f" "/etc/$f"
done

echo "[2/3] systemd 유닛 복원"
for u in detect-bridge.service go1-camview.service go1-sdk.service \
         go1-watchdog.service go1-watchdog.timer robot-node.service \
         robot-relay.service sensor-node.service; do
  install_file "etc/systemd/system/$u" "/etc/systemd/system/$u"
done

systemctl daemon-reload
echo "  daemon-reload 완료"

echo "[3/3] 유닛 활성화 (백업 당시 enabled 였던 것만)"
# go1-sdk 는 제외한다 — 기동 시 로봇이 force-stand(기립)하므로 부팅 자동시작하면 위험.
# 쓸 때만 수동으로: sudo systemctl start go1-sdk
for u in detect-bridge.service go1-camview.service go1-watchdog.timer \
         robot-node.service robot-relay.service sensor-node.service; do
  systemctl enable "$u"
done
systemctl disable go1-sdk.service 2>/dev/null || true
echo "  go1-sdk.service 는 의도적으로 disabled 로 둡니다 (README 3절)."

cat <<'DONE'

복원 완료.

다음 할 일
  1) 현장이 바뀌었다면 값을 고치세요:
       /etc/hw-node.env   HW_BROKER_HOST, HW_ZONE_ID
       /etc/hw-robot.env  HW_DETECT_URL
       /etc/systemd/system/go1-sdk.service  의 --robot_ip / --unity_ip / --light_ip
     고친 뒤: sudo systemctl daemon-reload
  2) 서비스 시작:
       sudo systemctl start robot-node robot-relay detect-bridge sensor-node go1-camview
  3) 확인:
       systemctl status robot-node robot-relay detect-bridge sensor-node
       journalctl -u robot-node -f
  4) WiFi/로봇 내부망 프로파일은 이 백업에 없습니다 (README 6절).
DONE
