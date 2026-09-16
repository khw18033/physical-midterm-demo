# 피지컬팀 mk2 — 라즈베리파이 `/etc` 설정 백업

Go1 로봇 구동·연결 스택이 동작하는 데 필요한 **시스템 설정(`/etc`)** 백업입니다.
코드 본체(`hw/`, `go1sdk/`)는 이 아카이브에 들어 있지 않습니다 — 별도로 받아 두세요.

| 항목 | 값 |
|---|---|
| 백업 시점 | 2026-09-16 15:05 KST |
| 원본 호스트 | `pi7` (Raspberry Pi, aarch64, Linux 6.18.34+rpt-rpi-2712) |
| 서비스 실행 계정 | `physical` |
| Python | 3.13.5 (venv: `/home/physical/venv`) |

---

## 1. 이 아카이브에 들어 있는 것

```
etc-config-backup-20260916/
├── README.md                  ← 이 문서
├── restore.sh                 ← 복원 스크립트 (sudo 필요)
├── unit-states.txt            ← 백업 당시 각 유닛의 enable/active 상태
├── venv-requirements.txt      ← venv 패키지 목록 (hw/ 에 requirements.txt 가 없어서 따로 떴음)
└── etc/
    ├── hw-node.env            ← 공통 현장 설정 (브로커 주소, 구역)
    ├── hw-robot.env           ← 로봇 전용 설정 (식별자, 제어기 링크, 탐지 서버)
    ├── device_id              ← "wl-001"  (센서노드 식별자)
    ├── zone_id                ← "zoneA"   (구역)
    └── systemd/system/
        ├── detect-bridge.service
        ├── go1-camview.service
        ├── go1-sdk.service        ← ★ 저장소 사본과 내용이 다름 (아래 4절)
        ├── go1-watchdog.service
        ├── go1-watchdog.timer
        ├── robot-node.service
        ├── robot-relay.service    ← ★ 저장소에 사본이 아예 없음 (아래 4절)
        └── sensor-node.service
```

> 자격증명 없음 — 위 파일 어디에도 비밀번호·토큰·인증서가 들어 있지 않습니다.
> 들어 있는 건 IP·호스트명·식별자뿐이라 평문 보관해도 무방합니다.
> (단, 6절의 WiFi 설정은 예외입니다.)

## 2. 이 아카이브에 **없는** 것 — 따로 챙겨야 함

| 대상 | 이유 |
|---|---|
| `/home/physical/hw/` | 코드 본체. git 저장소가 아니라 이 파이에만 있음 — 반드시 따로 백업 |
| `/home/physical/go1sdk/*.cpp` | `go1_sdk_pc.cpp` 등 SDK 브리지 소스 |
| `/etc/NetworkManager/system-connections/` | **WiFi PSK 포함**. root 전용(0600)이라 이 백업에 못 담았음 — 6절 참고 |
| `/home/physical/venv/` | 재생성 가능. `venv-requirements.txt` 로 복구 |
| `/home/physical/captures/` | 실행 중 수집된 프레임 데이터. 설정 아님 |

---

## 3. 시스템 구성 (복원 시 이해가 필요한 부분)

파이 한 대(`pi7`)가 세 갈래 네트워크에 동시에 물려 있습니다.

```
   [Go1 로봇 내부망]              [현장 WiFi]                  [상위]
   192.168.123.0/24               192.168.50.0/24
   ├ .161  Go1 메인보드           ├ .172  이 파이(wlan0)      MQTT 브로커
   └ .13   헤드 Nano(얼굴 라이트)  └ .244  Unity 호스트 PC      객체탐지 서버
```

동작 중인 서비스 7개의 역할:

| 유닛 | 하는 일 | 부팅 자동시작 |
|---|---|---|
| `robot-node` | 로봇 온보드 노드. MQTT 규약 명령 수신, 20Hz 상태 보고 | ✅ enabled |
| `robot-relay` | 로봇 상태에 신원(node_id/robot_id)을 찍어 Unity(15201)로 중계 | ✅ enabled |
| `detect-bridge` | 스캔 임무를 따라가며 방향별 사진을 객체탐지 서버로 송신 | ✅ enabled |
| `sensor-node` | 말단 수위센서 노드 | ✅ enabled |
| `go1-camview` | Go1 카메라 5대 H.264 브라우저 뷰어 (`:8090` / `:8443`) | ✅ enabled |
| `go1-watchdog.timer` | 카메라 프리즈 감시, 5분 주기 | ✅ enabled |
| `go1-sdk` | SDK 브리지 (Unity·자율주행·텔레옵·문탐색 미션) | ❌ **disabled (의도적)** |

> **`go1-sdk` 를 절대 `enable` 하지 마세요.**
> 이 서비스는 기동 순간 **로봇을 force-stand(기립)** 시킵니다. 부팅하자마자 로봇이
> 갑자기 일어서는 걸 막으려고 일부러 자동시작을 꺼 둔 것입니다. 쓸 때만 수동으로
> `sudo systemctl start go1-sdk` 하세요. `restore.sh` 도 이 유닛만 enable 하지 않습니다.

---

## 4. 저장소 사본과 다른 파일 — 복원 시 반드시 이쪽을 쓸 것

`hw/pi/deploy/` 에도 유닛 사본이 있지만, **실제로 돌던 것은 이 백업 쪽**입니다.
두 군데가 어긋나 있으니 주의하세요.

**`robot-relay.service` — `hw/pi/deploy/` 에 아예 없음**
저장소에 커밋되지 않은 채 `/etc` 에만 설치되어 돌고 있었습니다. 이 백업이 유일본입니다.

**`go1-sdk.service` — 저장소 사본과 내용이 다름**
실제 실행 인자에 현장 IP가 하드코딩되어 있습니다:
```
--robot_ip 192.168.123.161   --unity_ip 192.168.50.244
--ack_ip 127.0.0.1 --ack_port 15106
--light_ip 192.168.123.13 --light_port 7801
--state_dead_restart 30
--relay_ip 127.0.0.1 --relay_port 15200 --robot_id go1-1
```
다른 현장/다른 로봇에 복원한다면 이 IP들을 먼저 고쳐야 합니다.

**`go1_sdk_pc.cpp` 소스도 두 벌입니다** (이 아카이브 밖의 이야기지만 같이 기억해 두세요)
`go1sdk/go1_sdk_pc.cpp`(2034줄, 9/14 20:12)와 `hw/pi/robot/go1_sdk_pc.cpp`(1944줄, 9/14 18:27)이
**138줄 다릅니다.** 실제 돌던 바이너리는 `go1sdk/` 쪽에서 빌드된 것이므로 **`go1sdk/` 가 정본**입니다.

**`50-go1-sdk.rules` — 저장소에만 있고 설치 안 되어 있음**
`hw/pi/deploy/50-go1-sdk.rules` 는 `/etc/udev/rules.d/` 에 설치되어 있지 않았습니다.
없이도 동작했으므로 복원 시 굳이 넣을 필요 없습니다.

---

## 5. 복원 방법

새 파이에 올릴 때는 **코드 먼저, 설정 나중**입니다.

```bash
# 1) 코드 배치 — 경로가 유닛 파일에 하드코딩되어 있으므로 그대로 맞춰야 함
#    /home/physical/hw/  와  /home/physical/go1sdk/  에 풀 것

# 2) venv 재생성
python3 -m venv /home/physical/venv
/home/physical/venv/bin/pip install -r venv-requirements.txt

# 3) go1sdk 바이너리 재빌드 (백업엔 소스만 있음)
#    unitree_legged_sdk 는 upstream 그대로이므로 재클론 가능:
#    git clone https://github.com/unitreerobotics/unitree_legged_sdk.git  (커밋 4539a6c)

# 4) /etc 설정 복원  ← 이 아카이브
sudo ./restore.sh
```

`restore.sh` 가 하는 일: `/etc` 파일 6개 + 유닛 8개를 제자리에 복사하고,
`daemon-reload` 후 `unit-states.txt` 에 `enabled` 로 기록된 유닛만 enable 합니다
(`go1-sdk` 는 3절의 이유로 제외). 기존 파일이 있으면 `.bak-<날짜>` 로 먼저 피신시킵니다.

**복원 후 확인:**
```bash
systemctl status robot-node robot-relay detect-bridge sensor-node
journalctl -u robot-node -f
```

**다른 현장이라면 `etc/hw-node.env` 의 이 값들을 먼저 고치세요:**
- `HW_BROKER_HOST` — 지금은 `127.0.0.1` (임시로 로컬 브로커를 보고 있음)
- `HW_ZONE_ID` — 지금은 `zoneA`
- `hw-robot.env` 의 `HW_DETECT_URL` — 지금은 호스트명 `ubuntu3-15ug50p-gp55kn:8000`.
  이름 해석이 안 되면 IP로 바꿔야 합니다.

**식별자 충돌 주의:** `HW_ENTITY_ID=go1-001`(로봇)과 `/etc/device_id=wl-001`(센서노드)은
**반드시 서로 달라야** 합니다. 같은 값으로 두 노드가 브로커에 붙으면 client_id 플래핑으로
서로를 끊습니다.

---

## 6. 별도로 챙겨야 할 것 — 네트워크 설정 (⚠ 비밀번호 포함)

`/etc/NetworkManager/system-connections/` 에 연결 프로파일 3개가 있습니다:

- `go1-link.nmconnection` — **Go1 로봇 내부망(192.168.123.x) 링크. 로봇 연결의 핵심**
- `hotspot-SysaiLAB.nmconnection`
- `hotspot-demo.nmconnection`

root 전용(0600)이고 **WiFi 비밀번호(PSK)가 평문으로** 들어 있어 이 백업에 담지 않았습니다.
필요하면 직접 받되, 반드시 암호화해서 보관하세요:

```bash
sudo tar czf - -C / etc/NetworkManager/system-connections | gpg -c > nm-connections.tar.gz.gpg
```

같은 이유로 `/home/physical/.ssh/id_ed25519`(SSH 개인키)도 이 백업에서 제외했습니다.

---

## 7. 참고 — 원본 파일 목록 및 체크섬

`checksums.sha256` 파일로 동봉되어 있습니다. 복원 후 검증:

```bash
sha256sum -c checksums.sha256
```
