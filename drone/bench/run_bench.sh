#!/usr/bin/env bash
# CPU 사용량 측정 — 4가지 시나리오를 연속으로 돈다.
#
#   0. 기준선   : 드론 정지 + 카메라 없음   (OS 상시 부하만)
#   2. 카메라만 : 드론 정지 + 카메라 켬
#   1. 드론만   : 드론 켬  + 카메라 없음
#   3. 둘 다    : 드론 켬  + 카메라 켬
#
# 순서를 0→2→1→3 으로 짠 이유: 드론 서비스를 두 번만 껐다 켜면 되기 때문이다.

set -u
cd "$(dirname "$0")"

SECS=${SECS:-180}          # 측정 구간
WARMUP=${WARMUP:-15}       # 카메라 안정화 대기 (측정에서 제외)
W=1280; H=720; FPS=15
CAMSECS=$((SECS + WARMUP + 20))

DRONE_UNITS="drone-detect drone-node mosquitto"
CAMPID=""

log() { echo "[$(date +%H:%M:%S)] $*"; }

restore() {
  log "정리 — 카메라 종료, 드론 서비스 복구"
  [ -n "$CAMPID" ] && kill "$CAMPID" 2>/dev/null
  sudo -n systemctl start mosquitto drone-node drone-detect 2>/dev/null
}
trap restore EXIT INT TERM

# drone-detect 를 내리면 fc_detect.py 가 종료 처리로 drone.target 도 같이 내린다
# (scripts/fc_detect.py:293). 그래서 라우터/linkmon 까지 한 번에 정지된다.
drone_stop() {
  log "드론 서비스 정지 (drone.target 포함)"
  sudo -n systemctl stop drone-detect
  sudo -n systemctl stop drone.target 2>/dev/null   # 혹시 남아 있으면
  sudo -n systemctl stop drone-node mosquitto
  sleep 3
  log "  상태: $(systemctl is-active drone-detect drone.target drone-mavlink-router drone-linkmon drone-node mosquitto | tr '\n' ' ')"
}

# FC 가 붙어 있으면 drone-detect 가 10초 주기로 감지해 drone.target 을 올린다.
# 링크가 실제로 올라온 뒤에 측정해야 하므로 mode=drone 이 될 때까지 기다린다.
drone_start() {
  log "드론 서비스 기동"
  sudo -n systemctl start mosquitto drone-node drone-detect
  local waited=0
  while [ $waited -lt 90 ]; do
    if [ "$(cat /home/physical/drone/state/mode 2>/dev/null)" = "drone" ] \
       && [ "$(systemctl is-active drone-mavlink-router)" = "active" ] \
       && [ "$(systemctl is-active drone-linkmon)" = "active" ]; then
      log "  FC 링크 확보 (${waited}초) — 라우터·linkmon active"
      sleep 5           # 스트림이 정상 속도에 도달할 여유
      return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  log "  ⚠ 90초 안에 mode=drone 이 안 됐다 (현재: $(cat /home/physical/drone/state/mode 2>/dev/null))"
  log "  ⚠ FC 미연결 상태로 측정된다"
}

cam_start() {
  log "카메라 시작 (${W}x${H} @ ${FPS}fps, ${CAMSECS}초)"
  LIBCAMERA_LOG_LEVELS='*:ERROR' python3 cam_capture.py \
      --fps $FPS --width $W --height $H --seconds $CAMSECS \
      > "results/camlog_$1.txt" 2>&1 &
  CAMPID=$!
}
cam_stop() {
  if [ -n "$CAMPID" ]; then
    log "카메라 종료"
    kill "$CAMPID" 2>/dev/null; wait "$CAMPID" 2>/dev/null; CAMPID=""
  fi
  sleep 3
}

measure() {   # measure <파일이름> <라벨>
  log "측정 시작: $2  (워밍업 ${WARMUP}초 + 본측정 ${SECS}초)"
  python3 cpuwatch.py --seconds "$SECS" --warmup "$WARMUP" \
      --label "$2" --out "results/$1.json" > /dev/null
  log "측정 끝: $2"
}

mkdir -p results
log "===== 측정 시작 (각 ${SECS}초) ====="

# ── 0. 기준선 ──────────────────────────────────────────
drone_stop
measure 00_baseline "0-기준선(드론정지·카메라없음)"

# ── 2. 카메라만 ────────────────────────────────────────
cam_start camonly
measure 02_camera_only "2-카메라만"
cam_stop

# ── 1. 드론만 ──────────────────────────────────────────
drone_start
measure 01_drone_only "1-드론만"

# ── 3. 둘 다 ───────────────────────────────────────────
cam_start both
measure 03_both "3-둘다"
cam_stop

log "===== 전체 완료 ====="
