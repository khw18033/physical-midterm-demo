#!/usr/bin/env bash
# 말단 에이전트를 systemd 서비스로 등록한다. 재실행 안전(멱등).
#
#   ./install_service.sh                 # 등록 + 즉시 시작 + 부팅 시 자동
#   ./install_service.sh --disable       # 자동 시작 해제(파일은 남긴다)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT=/etc/systemd/system/drone-agent.service

if [[ "${1:-}" == "--disable" ]]; then
  sudo systemctl disable --now drone-agent 2>/dev/null || true
  echo "자동 시작 해제됨. 수동 실행: ./venv/bin/python -u agent.py"
  exit 0
fi

[ -x "$HERE/venv/bin/python" ] || {
  echo "venv가 없다. 먼저 배포한다:  ./deploy.sh --host <pi>" >&2; exit 1; }

sudo cp "$HERE/drone-agent.service" "$UNIT"
# 드롭인(시험비행 메타데이터 로테이션 등)도 함께 깐다 — 빠지면 설치본과 저장소가 다시 어긋난다.
sudo mkdir -p "$UNIT.d"
sudo cp "$HERE"/drone-agent.service.d/*.conf "$UNIT.d/"
sudo systemctl daemon-reload
sudo systemctl enable --now drone-agent
sleep 3
sudo systemctl --no-pager --lines=8 status drone-agent || true
echo
echo "확인:  curl http://localhost:8890/api/health"
echo "로그:  journalctl -u drone-agent -f"
echo "정지:  sudo systemctl stop drone-agent"
