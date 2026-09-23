#!/bin/bash
# ============================================================================
# step7_check.sh — 7단계 재부팅 검증용 상태 점검 (읽기 전용)
#
# 용도    : 한 경우가 끝날 때마다 실행해 기대 결과와 대조한다.
# 실행 조건 : 없음. sudo 불필요 (physical 이 adm 그룹이라 journal 도 읽힌다).
# 위험도  : 없음 — 상태를 읽기만 한다. FC 로 아무것도 보내지 않는다.
# ============================================================================
cd "$(dirname "$0")/.." || exit 1

echo "══════════════════════════════════════════════════════════════"
echo " 7단계 점검  $(date '+%F %T')   uptime: $(uptime -p)  (부팅 $(uptime -s))"
echo "══════════════════════════════════════════════════════════════"

echo "── 상태 ──"
printf "  state/mode               : %s\n" "$(cat state/mode 2>/dev/null || echo '(없음)')"
printf "  drone-detect             : %s (재시작 %s회)\n" \
  "$(systemctl is-active drone-detect)" "$(systemctl show drone-detect -p NRestarts --value)"
printf "  drone.target             : %s\n" "$(systemctl is-active drone.target)"
printf "  drone-mavlink-router     : %s\n" "$(systemctl is-active drone-mavlink-router)"
printf "  drone-linkmon            : %s\n" "$(systemctl is-active drone-linkmon)"

echo "── 포트 ──"
for p in 5760 14540 14541 14542; do
  if ss -tuln 2>/dev/null | grep -qE "[:.]$p\b"; then echo "  $p 열림"; else echo "  $p 닫힘"; fi
done

echo "── 시리얼 ──"
printf "  /dev/ttyAMA0 점유        : %s\n" \
  "$(ls -l /proc/*/fd/* 2>/dev/null | grep -c '/dev/ttyAMA0' | sed 's/^0$/없음/')"
printf "  GPIO14/15                : %s\n" "$(pinctrl get 14,15 2>/dev/null | tr '\n' ' ')"

echo "── drone-detect 최근 로그 ──"
journalctl -b -u drone-detect --no-pager -n 8 2>/dev/null | sed 's/^/  /' | tail -8

echo "── linkmon 최근 로그 ──"
tail -4 logs/linkmon.log 2>/dev/null | sed 's/^/  /' || echo "  (아직 없음)"

echo "── 에러 반복 여부 ──"
printf "  이번 부팅 로그 줄 수     : %s\n" "$(journalctl -b -u drone-detect --no-pager 2>/dev/null | wc -l)"
systemctl show drone-detect -p CPUUsageNSec --value \
  | awk '{printf "  drone-detect 누적 CPU    : %.2f초\n", ($1+0)/1e9}' 
echo "══════════════════════════════════════════════════════════════"
