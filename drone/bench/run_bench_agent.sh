#!/usr/bin/env bash
# CPU 측정 — 드론 프로그램 + 말단 노드(drone-agent) 조합.
#
#   0. 기준선     : 드론 정지 + 말단 정지
#   2. 말단만     : 드론 정지 + 말단 구동 (카메라 8fps + KLT + 프레임 서버)
#   1. 드론만     : 드론 구동 + 말단 정지
#   3. 둘 다      : 실제 운용 상태
#
# 말단 노드가 카메라를 배타 점유하므로 cam_capture.py 는 쓰지 않는다.
set -u
cd "$(dirname "$0")"
SECS=${SECS:-60}; WARMUP=${WARMUP:-10}
OUT=results/agent
mkdir -p "$OUT"
log() { echo "[$(date +%H:%M:%S)] $*"; }

restore() {
  log "정리 — 전부 복구"
  sudo -n systemctl start mosquitto drone-node drone-detect drone-agent 2>/dev/null
}
trap restore EXIT INT TERM

drone_stop() {
  log "드론 정지"; sudo -n systemctl stop drone-detect
  sudo -n systemctl stop drone.target 2>/dev/null
  sudo -n systemctl stop drone-node mosquitto; sleep 3
}
drone_start() {
  log "드론 기동"; sudo -n systemctl start mosquitto drone-node drone-detect
  local w=0
  while [ $w -lt 90 ]; do
    if [ "$(cat ../state/mode 2>/dev/null)" = "drone" ] \
       && [ "$(systemctl is-active drone-mavlink-router)" = "active" ]; then
      log "  FC 링크 확보 (${w}초)"; sleep 5; return 0
    fi
    sleep 2; w=$((w+2))
  done
  log "  ⚠ FC 링크 미확보 — mode=$(cat ../state/mode 2>/dev/null)"
}
agent_stop()  { log "말단 노드 정지"; sudo -n systemctl stop drone-agent; sleep 4; }
agent_start() {
  log "말단 노드 기동"; sudo -n systemctl start drone-agent
  local w=0
  while [ $w -lt 40 ]; do
    pgrep -f "drone_rpi/venv/bin/python -u agent.py" >/dev/null && \
      pgrep -x rpicam-vid >/dev/null && { log "  캡처 시작 확인 (${w}초)"; sleep 6; return 0; }
    sleep 2; w=$((w+2))
  done
  log "  ⚠ 말단 노드가 안 떴다"
}

measure() {
  log "측정: $2"
  python3 cpuwatch.py --seconds "$SECS" --warmup "$WARMUP" --label "$2" --out "$OUT/$1.json" >/dev/null
  log "  끝"
}

log "===== 시작 (각 ${SECS}초) ====="
drone_stop; agent_stop
measure 00_baseline   "0-기준선(둘다정지)"
agent_start
measure 02_agent_only "2-말단노드만"
agent_stop
drone_start
measure 01_drone_only "1-드론만"
agent_start
measure 03_both       "3-둘다(실제운용)"
log "===== 완료 ====="
