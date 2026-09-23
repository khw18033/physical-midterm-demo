#!/bin/bash
# ============================================================================
# step7_cb_gpio.sh — 7단계 C(링크 차단) / B(링크 복구) 를 점퍼선 없이 재현
#
# 용도    : GPIO15 를 UART 기능(a4)에서 일반 입력(ip pd)으로 잠시 떼어
#           라즈베리파이 쪽 수신만 0 으로 만든다. FC 입장에서도, drone-detect
#           입장에서도 점퍼선을 뽑은 것과 같다.
#             C = pinctrl set 15 ip pd   (수신 차단)
#             B = pinctrl set 15 a4 pu   (원상 복구)
#
# 실행 조건 : 기체가 DISARMED 일 것. sudo 불필요(physical 이 gpio 그룹).
# 위험도  : 낮음 — GPIO15 는 입력 핀이라 FC 로 아무것도 내보내지 않는다.
#           GPIO14(TX) 는 건드리지 않는다. trap 으로 어떤 경로로 끝나든 복구한다.
# ============================================================================
cd "$(dirname "$0")/.." || exit 1
LOG=logs/step7_cb_gpio.log

restore() { pinctrl set 15 a4 pu 2>/dev/null; }
trap restore EXIT INT TERM

log() { printf '[%s] %s\n' "$(date '+%T')" "$*" | tee -a "$LOG"; }

snap() {
  printf '        mode=%s target=%s router=%s linkmon=%s | 포트 5760=%s 14541=%s 14542=%s\n' \
    "$(cat state/mode 2>/dev/null)" "$(systemctl is-active drone.target)" \
    "$(systemctl is-active drone-mavlink-router)" "$(systemctl is-active drone-linkmon)" \
    "$(ss -tln 2>/dev/null | grep -c ':5760 ')" \
    "$(ss -uln 2>/dev/null | grep -c ':14541 ')" \
    "$(ss -uln 2>/dev/null | grep -c ':14542 ')" | tee -a "$LOG"
}

# 목표 mode 가 될 때까지 대기. 걸린 시간을 초 단위로 돌려준다.
wait_mode() {
  local want=$1 limit=$2 t0 el
  t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt "$limit" ]; do
    if [ "$(cat state/mode 2>/dev/null)" = "$want" ]; then
      echo $(( $(date +%s) - t0 )); return 0
    fi
    sleep 1
  done
  echo $(( $(date +%s) - t0 )); return 1
}

echo "════════════════════════════════════════════════════════" >> "$LOG"
log "시작 — 기준 상태"; snap
if [ "$(cat state/mode 2>/dev/null)" != "drone" ]; then
  log "✗ 드론 모드가 아니다. C 를 시작할 수 없다."; exit 1
fi

# ── C : 링크 차단 (기대: LINK_TIMEOUT=15초 내 mode=none) ──────────
log "C ─ GPIO15 를 UART 에서 떼어낸다 (수신 차단). 기대: 15초 내 mode=none"
pinctrl set 15 ip pd
log "    핀 상태: $(pinctrl get 15)"
if el=$(wait_mode none 40); then
  log "✔ C 성립 — ${el}초 만에 mode=none"
else
  log "✗ C 실패 — ${el}초 동안 mode 가 바뀌지 않았다"
fi
sleep 3
log "    차단 후 상태"; snap

# ── B : 링크 복구 (기대: DETECT_INTERVAL=10초 내 mode=drone) ──────
log "B ─ GPIO15 를 UART 로 되돌린다 (수신 복구). 기대: 10초대에 mode=drone"
pinctrl set 15 a4 pu
log "    핀 상태: $(pinctrl get 15)"
if el=$(wait_mode drone 60); then
  log "✔ B 성립 — ${el}초 만에 mode=drone"
else
  log "✗ B 실패 — ${el}초 동안 mode 가 돌아오지 않았다"
fi
sleep 4
log "    복구 후 상태"; snap
log "    mavlink-router MainPID: $(systemctl show drone-mavlink-router -p MainPID --value)"
log "완료 — 핀 최종: $(pinctrl get 15)"
