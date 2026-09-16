#!/usr/bin/env bash
# Pi 5 소프트웨어 H.264 인코딩 부하 실측 (HW-S-06 / HW-R-07 선행)
# Pi 5 에는 H.264 하드웨어 인코더가 없다(SRS 9.3 실기 확인) -> CPU 예산이 지배 제약.
# 코어 1개를 100%로 보고, "코어 몇 개분"을 쓰는지로 읽는다.
set -u
DUR=${DUR:-20}
TIMEFORMAT='%R %U %S'

run() {
  local label="$1" size="$2" fps="$3" preset="$4" bitrate="$5"
  # -re: 소스를 실시간으로 흘린다. 이게 없으면 인코더가 최대 속도로 돌아
  # 항상 100%가 나와 실제 운용 부하를 알 수 없다.
  local t
  t=$( { time ffmpeg -hide_banner -loglevel error \
          -re -f lavfi -i "testsrc2=size=${size}:rate=${fps}" \
          -t "$DUR" -c:v libx264 -preset "$preset" -tune zerolatency \
          -b:v "$bitrate" -f null - > /dev/null 2>&1 ; } 2>&1 )
  local real user sys
  read -r real user sys <<< "$t"
  local cores
  cores=$(awk -v u="$user" -v s="$sys" -v r="$real" 'BEGIN{printf "%.2f", (u+s)/r}')
  local pct
  pct=$(awk -v c="$cores" 'BEGIN{printf "%.0f", c*100/4}')
  printf '  %-20s %-10s %-10s %-6s  코어 %-5s (전체의 %s%%)\n' \
    "$label" "$size" "$preset" "$bitrate" "$cores" "$pct"
}

echo "=== Pi 5 소프트웨어 H.264 인코딩 — 각 ${DUR}초, 4코어 ==="
echo "부하 조건: sensor-node + robot-node + actuator-node + k3s-agent 상주 중"
echo ""
run "AI 입력(HW-R-04)"   640x480   15 veryfast  800k
run "관제 720p"          1280x720  15 veryfast  2000k
run "관제 1080p"         1920x1080 15 veryfast  4000k
run "관제 1080p(faster)" 1920x1080 15 faster    4000k
run "CCTV 1080p 상시"    1920x1080 15 ultrafast 4000k
run "CCTV 720p 상시"     1280x720  15 ultrafast 2000k
echo ""
echo "=== 온도·스로틀 ==="
vcgencmd measure_temp; vcgencmd get_throttled
