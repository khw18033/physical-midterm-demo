#!/usr/bin/env bash
# rpicam-vid --metadata 파일(시험비행용) 로테이션 — drone-agent 기동 직전에 돈다.
#
# 왜 필요한가: rpicam-vid는 시작할 때마다 메타데이터 파일을 **처음부터 새로 쓴다**.
# 재부팅·재시작은 물론, 비행 중 카메라 정지로 systemd가 에이전트를 다시 띄워도
# 그 비행의 앞부분 기록이 지워진다 — 정작 들여다봐야 할 비행의 기록이 먼저 사라진다.
# 그래서 기동 전에 직전 파일을 시각이 붙은 이름으로 옮기고, 최근 KEEP개만 남긴다.
# 쓰는 중인 파일은 건드리지 않는다(이 시점엔 rpicam-vid가 아직 없다).
#
# config.json에서 --metadata를 빼면 옮길 파일이 없어 아무 일도 하지 않는다.
set -euo pipefail

SRC=/home/physical/flight_meta.json
DIR=/home/physical/flight_meta
KEEP=100

[ -s "$SRC" ] || exit 0
mkdir -p "$DIR"
# 이름은 파일이 마지막으로 쓰인 시각(= 그 실행이 끝난 시각)으로 붙인다.
dst="$DIR/$(date -r "$SRC" +%Y%m%d-%H%M%S).json"
[ -e "$dst" ] && dst="${dst%.json}-$$.json"
mv "$SRC" "$dst"
echo "flight_meta: $SRC -> $dst"

# 이름이 시각순이므로 정렬 뒤 앞쪽(오래된 것)부터 지운다.
ls -1 "$DIR"/*.json 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
  rm -f -- "$old"
  echo "flight_meta: 보관 한도($KEEP) 초과로 삭제 $old"
done
