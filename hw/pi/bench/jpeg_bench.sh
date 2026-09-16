#!/usr/bin/env bash
# Pi 5 JPEG(MJPEG) 인코딩 실측 — 아키텍처 v8 §5-10 확정 코덱
# ==============================================================
# v8 이 홉1(말단→엣지) 코덱을 **JPEG**로 확정했다. 기존 encode_bench.sh 는
# H.264(libx264) 기준이라 이 설계의 근거로 쓸 수 없어 따로 잰다.
#
# JPEG 는 프레임 간 압축을 하지 않으므로 H.264 와 성질이 반대다.
#   CPU  : 훨씬 싸다 (프레임 간 예측이 없다)
#   대역폭: 훨씬 크다 (매 프레임이 독립 이미지)
# 그래서 **대역폭을 함께 재는 것이 이 벤치의 핵심**이다. v8 은 "홉1이 로컬 LAN
# (기가비트)이라 제약이 아니다"라고 하지만, 로봇(HW-R-07)의 홉1은 무선이다.
#
# 사용:  DUR=20 bash jpeg_bench.sh
set -u
DUR=${DUR:-20}
TIMEFORMAT='%R %U %S'
TMP=/tmp/jpeg_bench.mjpg

run() {
  local label="$1" size="$2" fps="$3" q="$4"     # q: 2(최고화질)~31(최저)
  local t
  t=$( { time ffmpeg -hide_banner -loglevel error -y \
          -re -f lavfi -i "testsrc2=size=${size}:rate=${fps}" \
          -t "$DUR" -c:v mjpeg -q:v "$q" -f mjpeg "$TMP" > /dev/null 2>&1 ; } 2>&1 )
  local real user sys
  read -r real user sys <<< "$t"
  local cores pct bytes mbps
  cores=$(awk -v u="$user" -v s="$sys" -v r="$real" 'BEGIN{printf "%.2f", (u+s)/r}')
  pct=$(awk -v c="$cores" 'BEGIN{printf "%.0f", c*100/4}')
  bytes=$(stat -c %s "$TMP" 2>/dev/null || echo 0)
  mbps=$(awk -v b="$bytes" -v d="$DUR" 'BEGIN{printf "%.1f", b*8/d/1000000}')
  printf '  %-20s %-10s q=%-3s  코어 %-5s (%s%%)   대역폭 %6s Mbps\n' \
    "$label" "$size" "$q" "$cores" "$pct" "$mbps"
  rm -f "$TMP"
}

echo "=== Pi 5 JPEG(MJPEG) 인코딩 — 각 ${DUR}초, 4코어 ==="
echo "부하 조건: $(systemctl is-active k3s-agent 2>/dev/null) k3s-agent / $(sudo k3s crictl ps 2>/dev/null | grep -c Running) 컨테이너 가동 중"
echo ""
run "AI 입력(HW-R-04)"  640x480   15 5
run "관제 720p"         1280x720  15 5
run "관제 1080p"        1920x1080 15 5
run "관제 1080p(저화질)" 1920x1080 15 12
run "CCTV 720p 상시"    1280x720  15 8
echo ""
echo "=== 하드웨어 JPEG 인코딩 지원 여부 ==="
found=0
for d in /dev/video*; do
  out=$(v4l2-ctl -d "$d" --list-formats-out 2>/dev/null | grep -iE 'JPEG|MJPG')
  [ -n "$out" ] && { echo "  $d: $out"; found=1; }
done
[ "$found" = "0" ] && echo "  V4L2 JPEG 인코더 노드 없음 (소프트웨어 인코딩만)"
echo "  ffmpeg mjpeg 인코더: $(ffmpeg -hide_banner -encoders 2>/dev/null | grep -cE ' mjpeg') 종"
echo ""
echo "=== 온도·스로틀 ==="
vcgencmd measure_temp; vcgencmd get_throttled
