#!/usr/bin/env bash
# 피지컬팀 mk2 — 말단 라즈베리파이 공통 베이스 셋업
# ==================================================
# 센서노드·로봇 온보드 공통의 사전조건을 갖춘다. 여러 번 실행해도 안전하다(멱등).
#
# 사용:
#   ./pi_base_setup.sh --entity wl-001 --node pi7 --zone zoneA --role sensor
#   ./pi_base_setup.sh --entity rb-01  --node pi8 --zone zoneA --role robot \
#                      --ntp 192.168.50.10 --broker 192.168.50.10
#
# 옵션
#   --entity   Entity 식별자(장치 ID). type-serial 형식. 채번 대장에서 받아온다 (HW-C-07)
#   --node     물리 노드 식별자. 생략 시 hostname
#   --zone     소속 구역 (HW-C-04)
#   --role     sensor | robot | actuator — 설치할 서비스가 갈린다 (요구사항 8)
#   --ntp      상위 NTP 서버(엣지노드). 생략 시 기존 chrony 설정 유지 (HW-S-08)
#   --broker   MQTT 브로커 주소. /etc/hw-node.env 에 기록
#   --go1 IP   Unitree Go1 내부망(192.168.123.0/24) 연결을 eth0 에 영구 등록.
#              IP 는 우리 쪽 주소(예: 192.168.123.162). 생략 시 이 단계를 건너뛴다
#   --no-venv  파이썬 venv 구성 생략
#
# 근거: HW-S-08(시각 동기), HW-C-07(device_id 채번), HW-C-03(K3s 워커 편입 전제 cgroup)
set -euo pipefail

ENTITY=""; NODE=""; ZONE=""; ROLE="sensor"; NTP=""; BROKER=""; DO_VENV=1; GO1_IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --entity) ENTITY="$2"; shift 2 ;;
    --node)   NODE="$2";   shift 2 ;;
    --zone)   ZONE="$2";   shift 2 ;;
    --role)   ROLE="$2";   shift 2 ;;
    --ntp)    NTP="$2";    shift 2 ;;
    --broker) BROKER="$2"; shift 2 ;;
    --go1)    GO1_IP="$2";  shift 2 ;;
    --no-venv) DO_VENV=0;  shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 1 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="${HOME}/venv"
REBOOT_NEEDED=0
say() { printf '\n[셋업] %s\n' "$1"; }
ok()  { printf '  ✓ %s\n' "$1"; }

# ---------------------------------------------------------------- 1. 식별자
# device_id 는 채번 대장에서 수동 배정한다. MAC 기반 자동 채번은 보드 교체 시
# ID가 바뀌어 이력이 끊기므로 쓰지 않는다 (HW-C-07: MAC을 영구 식별자로 단독 사용 금지).
say "식별자 기록 (HW-C-07)"
if [ -n "$ENTITY" ]; then
  echo "$ENTITY" | sudo tee /etc/device_id > /dev/null
  ok "/etc/device_id = $ENTITY"
elif [ -f /etc/device_id ]; then
  ok "/etc/device_id = $(cat /etc/device_id) (기존값 유지)"
else
  echo "  ✗ --entity 가 필요하다. 채번 대장에서 device_id 를 받아올 것" >&2; exit 1
fi
[ -n "$NODE" ] && { echo "$NODE" | sudo tee /etc/node_id > /dev/null; ok "/etc/node_id = $NODE"; }
[ -n "$ZONE" ] && { echo "$ZONE" | sudo tee /etc/zone_id > /dev/null; ok "/etc/zone_id = $ZONE"; }

# ---------------------------------------------------------------- 2. 시각 동기
# 핵심은 절대 시각보다 장치 간 시각 정합이다 — 재전송 후 타임스탬프 순서 복원(HW-R-09)의
# 전제이고, 서버가 구역·장치별 데이터를 병합·정렬하는 근거다(HW-S-08).
# 현장망은 인터넷이 끊길 수 있으므로 엣지노드를 로컬 기준시계로 두는 것을 권장한다.
say "시각 동기 (HW-S-08)"
if ! command -v chronyc > /dev/null; then
  sudo apt-get update -qq && sudo apt-get install -y -qq chrony
  ok "chrony 설치"
fi
if [ -n "$NTP" ]; then
  echo "server $NTP iburst prefer" | sudo tee /etc/chrony/conf.d/hw-edge.conf > /dev/null
  sudo systemctl restart chrony
  ok "상위 NTP = $NTP (엣지노드 기준시계)"
fi
sudo systemctl enable --now chrony > /dev/null 2>&1 || true
ok "chrony: $(systemctl is-active chrony) / $(chronyc tracking 2>/dev/null | awk -F': ' '/System time/{print $2}')"

# ---------------------------------------------------------------- 3. cgroup
# K3s 워커로 편입되려면 cgroup memory 컨트롤러가 켜져 있어야 한다 (HW-C-03).
say "cgroup memory (HW-C-03 K3s 워커 편입 전제)"
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
if grep -q "cgroup_memory=1" "$CMDLINE" 2>/dev/null; then
  ok "cmdline.txt 에 이미 설정됨"
else
  sudo sed -i '1 s/$/ cgroup_memory=1 cgroup_enable=memory/' "$CMDLINE"
  REBOOT_NEEDED=1
  ok "cmdline.txt 수정 — 재부팅 후 적용"
fi
# Debian 13 은 cgroup v2(unified) 이므로 /proc/cgroups 에 memory 행이 아예 없다.
# v2 에서는 /sys/fs/cgroup/cgroup.controllers 에 나열되는지로 봐야 한다.
if [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = "cgroup2fs" ]; then
  if grep -qw memory /sys/fs/cgroup/cgroup.controllers 2>/dev/null; then
    ok "memory 컨트롤러 활성 (cgroup v2)"
  else
    echo "  ! memory 컨트롤러 비활성 (cgroup v2) — 재부팅 필요"; REBOOT_NEEDED=1
  fi
elif [ "$(awk '/^memory/{print $4}' /proc/cgroups 2>/dev/null)" = "1" ]; then
  ok "memory 컨트롤러 활성 (cgroup v1)"
else
  echo "  ! memory 컨트롤러 비활성 — 재부팅 필요"; REBOOT_NEEDED=1
fi

# ---------------------------------------------------------------- 4. 파이썬 환경
say "파이썬 실행 환경"
if [ "$DO_VENV" = "1" ]; then
  if [ ! -x "$VENV/bin/python3" ]; then
    sudo apt-get install -y -qq python3-venv
    python3 -m venv "$VENV"
    ok "venv 생성: $VENV"
  fi
  # 말단에는 전송 클라이언트와 관측 SDK 만 둔다. 브로커·수집기 같은 서버형
  # 미들웨어는 설치 대상이 아니다 (AI-B-10 말단 경량 실행 경계).
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q \
      paho-mqtt \
      opentelemetry-sdk opentelemetry-exporter-otlp \
      psutil
  ok "라이브러리: $("$VENV/bin/pip" list 2>/dev/null | grep -ciE 'paho|opentelemetry|psutil')개 확인"
else
  ok "venv 구성 생략(--no-venv)"
fi

# ---------------------------------------------------------------- 4-1. Go1 내부망
# 로봇(Unitree Go1)은 등판 이더넷이 내부 스위치에 직결되어 있고 내부망이
# 192.168.123.0/24 다. 말단을 여기에 붙여 텔레메트리를 받는다(HW-R-01).
#
# ⚠ 기본 경로(default route)를 절대 이쪽으로 넘기지 않는다. Go1 내부망에는 우리가
#   쓸 게이트웨이가 없어서, 기본 경로가 넘어가면 엣지·브로커와의 연결이 통째로 끊긴다.
#   그래서 gateway 를 주지 않고 ipv4.never-default 를 건다.
#
# ⚠ `ip addr add` 로 붙이면 재부팅에 날아간다. NetworkManager 프로파일로 등록한다
#   (실제로 임시 설정을 쓰다가 파이 재부팅 때 Go1 연결이 통째로 끊긴 적이 있다).
if [ -n "$GO1_IP" ]; then
  say "Go1 내부망 연결 (HW-R-01)"
  if command -v nmcli > /dev/null && [ "$(systemctl is-active NetworkManager)" = "active" ]; then
    sudo nmcli con delete go1-link > /dev/null 2>&1 || true
    sudo nmcli con add type ethernet ifname eth0 con-name go1-link          ipv4.method manual ipv4.addresses "$GO1_IP/24"          ipv4.never-default yes ipv6.method disabled          connection.autoconnect yes > /dev/null
    sudo nmcli con up go1-link > /dev/null 2>&1 || true
    ok "eth0 = $GO1_IP (영구, 기본 경로는 기존 인터페이스 유지)"
    if ip route | grep -q "^default.*eth0"; then
      echo "  ✗ 기본 경로가 eth0 로 넘어갔다 — 엣지 연결이 끊긴다. 확인 필요" >&2
    else
      ok "기본 경로: $(ip route | awk '/^default/{print $3, $5; exit}')"
    fi
    for h in 192.168.123.161 192.168.123.13; do
      timeout 2 ping -c1 -W1 "$h" > /dev/null 2>&1         && ok "Go1 $h 응답" || echo "  ! Go1 $h 무응답 (케이블·전원 확인)"
    done
  else
    echo "  ! NetworkManager 가 없어 영구 등록을 건너뛴다. 수동 설정 필요"
  fi
fi

# ---------------------------------------------------------------- 5. 현장 설정
say "현장 설정 /etc/hw-node.env"
if [ ! -f /etc/hw-node.env ]; then
  sudo cp "$REPO_DIR/deploy/hw-node.env.example" /etc/hw-node.env
  ok "템플릿 복사"
fi
if [ -n "$BROKER" ]; then
  if sudo grep -q '^HW_BROKER_HOST=' /etc/hw-node.env; then
    sudo sed -i "s|^HW_BROKER_HOST=.*|HW_BROKER_HOST=$BROKER|" /etc/hw-node.env
  else
    echo "HW_BROKER_HOST=$BROKER" | sudo tee -a /etc/hw-node.env > /dev/null
  fi
  ok "브로커 = $BROKER"
fi
[ -n "$ZONE" ] && sudo sed -i "s|^HW_ZONE_ID=.*|HW_ZONE_ID=$ZONE|" /etc/hw-node.env || true

# ---------------------------------------------------------------- 6. 서비스
# 역할에 따라 설치할 서비스가 갈린다. 센서노드와 로봇 온보드는 공통 기반(HW-C)을
# 공유하지만 상위 기능과 주기가 다르다.
say "systemd 서비스 (role=$ROLE)"
case "$ROLE" in
  sensor)
    if [ -f "$REPO_DIR/deploy/sensor-node.service" ]; then
      sudo cp "$REPO_DIR/deploy/sensor-node.service" /etc/systemd/system/
      sudo systemctl daemon-reload
      sudo systemctl enable sensor-node > /dev/null 2>&1
      ok "sensor-node.service 설치·부팅 등록 (기동은 수동: systemctl start sensor-node)"
    fi
    ;;
  robot)
    if [ -f "$REPO_DIR/deploy/robot-node.service" ]; then
      sudo cp "$REPO_DIR/deploy/robot-node.service" /etc/systemd/system/
      sudo systemctl daemon-reload
      sudo systemctl enable robot-node > /dev/null 2>&1
      ok "robot-node.service 설치·부팅 등록 (기동은 수동: systemctl start robot-node)"
    else
      echo "  ! deploy/robot-node.service 미존재"
    fi
    ;;
  actuator)
    if [ -f "$REPO_DIR/deploy/actuator-node.service" ]; then
      sudo cp "$REPO_DIR/deploy/actuator-node.service" /etc/systemd/system/
      sudo systemctl daemon-reload
      sudo systemctl enable actuator-node > /dev/null 2>&1
      ok "actuator-node.service 설치·부팅 등록 (기동은 수동: systemctl start actuator-node)"
    else
      echo "  ! deploy/actuator-node.service 미존재"
    fi
    ;;
  *) echo "  ✗ 알 수 없는 role: $ROLE (sensor|robot|actuator)" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------- 마무리
say "요약"
printf '  entity=%s node=%s zone=%s role=%s\n' \
  "$(cat /etc/device_id 2>/dev/null || echo -)" \
  "$(cat /etc/node_id   2>/dev/null || hostname)" \
  "$(cat /etc/zone_id   2>/dev/null || echo -)" "$ROLE"
if [ "$REBOOT_NEEDED" = "1" ]; then
  printf '\n  ⚠ cgroup 설정 반영을 위해 재부팅이 필요하다: sudo reboot\n'
fi
printf '\n완료.\n'
