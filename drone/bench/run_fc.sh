#!/usr/bin/env bash
# FC 연결 상태에서 시나리오 1(드론만)과 3(둘 다)만 측정한다.
# 0(기준선)·2(카메라만)은 드론 서비스 정지가 필요해 sudo 가 있어야 한다.
set -u
cd "$(dirname "$0")"
SECS=${SECS:-60}; WARMUP=${WARMUP:-10}
W=1280; H=720; FPS=15
CAMPID=""
log() { echo "[$(date +%H:%M:%S)] $*"; }
cleanup() { [ -n "$CAMPID" ] && kill "$CAMPID" 2>/dev/null; }
trap cleanup EXIT INT TERM

log "링크 확인: mode=$(cat ../state/mode) router=$(systemctl is-active drone-mavlink-router) linkmon=$(systemctl is-active drone-linkmon)"

log "측정 시작: 1-드론만(FC연결)"
python3 cpuwatch.py --seconds $SECS --warmup $WARMUP \
    --label "1-드론만(FC연결)" --out results/fc/01_drone_only_fc.json > /dev/null
log "측정 끝: 1-드론만(FC연결)"

log "카메라 시작 (${W}x${H} @ ${FPS}fps)"
LIBCAMERA_LOG_LEVELS='*:ERROR' python3 cam_capture.py \
    --fps $FPS --width $W --height $H --seconds $((SECS + WARMUP + 20)) \
    > results/fc/camlog_both.txt 2>&1 &
CAMPID=$!

log "측정 시작: 3-둘다(FC연결)"
python3 cpuwatch.py --seconds $SECS --warmup $WARMUP \
    --label "3-둘다(FC연결)" --out results/fc/03_both_fc.json > /dev/null
log "측정 끝: 3-둘다(FC연결)"

kill "$CAMPID" 2>/dev/null; wait "$CAMPID" 2>/dev/null; CAMPID=""
log "===== 완료 ====="
