#!/bin/bash
# ============================================================================
# step7_cb_watch.sh — 7단계 C(링크 차단) / B(링크 복구) 상태 변화 기록기
#
# 용도    : 점퍼선을 뽑았다 꽂는 동안 mode / drone.target / 포트 변화를
#           타임스탬프와 함께 기록한다. 사람이 언제 조작하든 놓치지 않는다.
# 실행 조건 : 없음. sudo 불필요.
# 위험도  : 없음 — 상태를 읽기만 한다. FC 로 아무것도 보내지 않는다.
# ============================================================================
cd "$(dirname "$0")/.." || exit 1
LOG=logs/step7_cb_watch.log
DUR=${1:-2400}          # 기본 40분
END=$(( $(date +%s) + DUR ))
prev=""
{
  echo "════════════════════════════════════════════════════════════"
  echo "[$(date '+%F %T')] 감시 시작 (최대 ${DUR}초). C=점퍼 뽑기 → B=다시 꽂기"
} >> "$LOG"
while [ "$(date +%s)" -lt "$END" ]; do
  mode=$(cat state/mode 2>/dev/null || echo '?')
  tgt=$(systemctl is-active drone.target)
  rtr=$(systemctl is-active drone-mavlink-router)
  lkm=$(systemctl is-active drone-linkmon)
  p5760=$(ss -tln 2>/dev/null | grep -c ':5760 ')
  now="$mode|$tgt|$rtr|$lkm|$p5760"
  if [ "$now" != "$prev" ]; then
    printf '[%s] mode=%-5s target=%-8s router=%-8s linkmon=%-8s tcp5760=%s\n' \
      "$(date '+%F %T')" "$mode" "$tgt" "$rtr" "$lkm" "$p5760" >> "$LOG"
    prev="$now"
  fi
  sleep 1
done
echo "[$(date '+%F %T')] 감시 종료" >> "$LOG"
