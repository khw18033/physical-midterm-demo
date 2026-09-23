# 0단계 보고 — 라즈베리파이 드론 연동 환경 현황 조사

- **대상**: Raspberry Pi 5 Model B Rev 1.0 (hostname `pi7`)
- **작성**: 2026-09-21 15:17 KST
- **근거 프롬프트**: `~/작업프롬프트_라즈베리파이세팅_260921.md`
- **상태**: 0단계 완료 / **시스템·Go1 자산 변경 0건** / 1단계 승인 대기

> 개정 2 반영: 배선이 TELEM2 → **TELEM1**, 읽을 파라미터가 `MAV_1_*` → **`MAV_0_CONFIG` / `MAV_0_MODE` / `SER_TEL1_BAUD`** 로 바뀌었고 TELEM2에는 무선 Air Unit이 붙는다.
> 라즈베리파이 쪽 접속 핀은 GPIO14/15(8·10번 핀)로 동일하므로 **아래 0단계 결론은 그대로 유효**하다.
> 단 3단계 `check_link.py`는 개정 2 기준(`MAV_0_*` + TELEM2 Air Unit 인스턴스 동시 확인)으로 작성해야 한다.

---

## 0-1. 시스템

| 항목 | 값 |
|---|---|
| 모델 | **Raspberry Pi 5 Model B Rev 1.0** |
| OS | Debian GNU/Linux 13 (trixie), 13.5 |
| 아키텍처 / 커널 | aarch64 / 6.18.34+rpt-rpi-2712 |
| 호스트명 | `pi7` |
| Python | 3.13.5 (`/usr/bin/python3`) |
| 부트 설정 파일 | **`/boot/firmware/config.txt`** (실사용). `/boot/config.txt`는 91바이트 안내문 |
| `enable_uart` / `dtparam=uart0` | **둘 다 설정 없음** |
| 시리얼 장치 | `/dev/ttyAMA10` 하나뿐. `/dev/serial0 → ttyAMA10` |
| GPIO14/15 (uart0) | device-tree **`status = disabled`**, `pinctrl get 14,15` → 기능 `none` |
| 시리얼 콘솔 | **사용 중**. `/proc/cmdline`에 `console=ttyAMA10,115200`, `serial-getty@ttyAMA10` = enabled-runtime |
| 블루투스 | `bluetooth.service` enabled/active. `hciuart` = **not-found** (Pi 5는 사용 안 함) |
| 현재 사용자 그룹 | `physical` — `dialout` **이미 포함** (gpio·i2c·spi·video 등도 포함) |

### UART 실체 (Pi 5 구조)

| DT 별칭 | 노드 | 물리 위치 | 현재 상태 |
|---|---|---|---|
| `uart0` / `serial0` | `rp1/serial@30000` | **GPIO14/15 = 40핀 헤더 8·10번** ← FC 연결 대상 | **disabled** |
| `uart10` / `serial10` | `soc/serial@7d001000` → `ttyAMA10` | **전용 3핀 디버그 커넥터** | okay, 부팅 콘솔 점유 |
| (BT 전용) | `107d50c000.serial` → `ttyS0` | 내부 블루투스 전용 | 활성 (hci0) |

`/dev/serial0`를 만드는 규칙은 `/lib/udev/rules.d/99-com.rules`. DT 별칭 `serial0`(= GPIO14/15)가 disabled라 tty가 없어서, 현재는 `uart10` 대체 분기가 동작해 **`/dev/serial0`가 디버그 UART를 가리키고 있다.**

---

## 0-2. Go1 세팅 조사

### ① Go1 자동 실행 방식 = **systemd 단독**

cron(사용자) 없음 · `/etc/rc.local` 없음 · `~/.bashrc`/`~/.profile` 자동실행 없음 · docker/pm2 미설치 · 사용자 세션 유닛 없음.
(root crontab만 sudo 암호 요구로 미확인 — 다른 경로가 전부 깨끗해 systemd로 단정해도 무방)

| 유닛 | enabled | active | 실행 대상 |
|---|---|---|---|
| `robot-node.service` | enabled | **running** | `~/venv/bin/python3 -m robot.robot_node` |
| `robot-relay.service` | enabled | **running** | `robot_state_relay.py --node_id pi7 --unity_ip 192.168.50.244 --unity_port 15201 --ingress_port 15200` |
| `sensor-node.service` | enabled | **running** | `~/venv/bin/python3 -m sensor.sensor_node` |
| `detect-bridge.service` | enabled | **running** | `~/venv/bin/python3 -m robot.detect_bridge` |
| `go1-camview.service` | enabled | **running** | `/usr/bin/python3 -m bench.go1_cam_view 8090 8443` |
| `go1-watchdog.timer` | enabled | active | 부팅 3분 후 + 5분 주기 → `go1-watchdog.service` (oneshot) |
| `go1-sdk.service` | **disabled** | inactive | `~/go1sdk/go1_sdk_pc …` — **의도적 비활성.** 유닛 주석: *"기동 시 로봇이 force-stand(기립)한다. 그래서 부팅 자동시작은 기본 비활성"* → 사람이 수동 시작 |

> **주의**: `go1-sdk.service`가 disabled인 것은 버그가 아니라 안전 설계다. 어떤 경우에도 enable 하지 말 것.

### 코드·설정 위치

| 항목 | 경로 |
|---|---|
| 로봇/센서 노드 코드 | `~/hw/pi/` (`robot/`, `sensor/`, `common/`, `bench/`, `edge/`, `deploy/`) |
| Go1 C++ 브리지 | `~/go1sdk/` (정적 링크 바이너리 `go1_sdk_pc`) |
| Unitree SDK | `~/unitree_legged_sdk/` |
| 가상환경 | **`~/venv`** (`go1-camview`·`go1-watchdog`는 시스템 `/usr/bin/python3` 사용) |
| 현장 설정 | `/etc/hw-node.env`(공통), `/etc/hw-robot.env`(로봇), `/etc/device_id`=`wl-001`, `/etc/zone_id`=`zoneA` |
| 기존 설정 백업 | `~/etc-config-backup-20260916/` (사용자가 이전에 남긴 것) |

### Go1 연결 방식 (네트워크)

| 항목 | 값 |
|---|---|
| 인터페이스 | **유선 `eth0`** — NetworkManager 프로파일 `go1-link` |
| 주소 | `ipv4.method=manual`, **`192.168.123.162/24`**, `never-default=yes`, `autoconnect=yes` |
| 로봇 측 | `192.168.123.161` (Go1 본체), `192.168.123.13` (헤드 Nano 라이트 브리지 :7801) |
| 현재 상태 | `eth0` = **NO-CARRIER / DOWN** (로봇 미연결) |
| 상위망 | `wlan0` `192.168.50.172/24`, 기본 게이트웨이 `192.168.50.1` (SSID `SysAILAB_5GHz`) |
| Unity(디지털 트윈) | `192.168.50.244` — 직결 UDP 15101 + 릴레이 15201 |
| 기타 프로파일 | `hotspot-demo`, `hotspot-SysaiLAB`, `netplan-eth0` (모두 비활성) |

### MQTT

| 항목 | 값 |
|---|---|
| 브로커 위치 | **이 라즈베리파이(pi7)에서 mosquitto 실행 중** (enabled/active) |
| 리스너 | `1883` (0.0.0.0) + `9001` (0.0.0.0, websockets) — `/etc/mosquitto/conf.d/hw.conf` |
| 인증 | `allow_anonymous true` (BE-T-01 TLS 준비 전까지 폐쇄망 전제) |
| 노드가 접속하는 주소 | `/etc/hw-node.env`의 `HW_BROKER_HOST=127.0.0.1:1883`. 코드 기본값은 `config.py`의 `BROKER_HOST=192.168.50.244`("임시: 노트북") |
| clientId 생성 | `common/node.py` — `identity.entity_id`를 그대로 client_id로 사용 |
| 사용 중 clientId | 로봇 **`go1-001`** (`/etc/hw-robot.env`의 `HW_ENTITY_ID`), 센서 **`wl-001`** (`/etc/device_id`) |
| 토픽 | `terminal/go1-001/downlink` (상위→로봇), `terminal/<...>/uplink` (로봇→상위) |
| **드론 `x500-001` 충돌 여부** | **없음.** 기존 두 식별자와 겹치지 않음 |

> 코드 주석: *"같은 client_id 로 두 노드가 붙으면 서로를 밀어내며 초당 한 번씩 재접속한다"* — 규칙 1의 경고와 일치. `x500-001`을 반드시 유지할 것.

### ② UART·블루투스 변경의 Go1 영향 = **없음**

| 확인 | 결과 |
|---|---|
| Go1 코드의 시리얼 사용 | `~/hw`, `~/go1sdk`, `~/unitree_legged_sdk` 전체에서 `/dev/tty*`·`serial0`·`ttyAMA`·`pyserial`·`import serial`·`uart` 검색 → **0건** |
| Go1 venv 패키지 | serial / pymavlink / mavsdk 계열 **없음** |
| systemd 유닛의 장치 참조 | Go1 유닛 어디에도 `/dev/*` 없음 |
| 센서노드 하드웨어 I/F | `sensor_node.py`에 GPIO/I2C/SPI/ADC 참조 **0건** (GPIO14/15와 무관) |
| Pi 5 블루투스 경로 | `hci0 → /sys/devices/platform/soc@107c000000/**107d50c000.serial**` = `ttyS0` (BCM7271). GPIO14/15(RP1 `serial@30000`)와 **물리적으로 별개** |
| `disable-bt` 오버레이 설명 | *"On Pis **prior to Pi 5** this restores UART0/ttyAMA0 over GPIOs 14 & 15"* |

→ **결론**: Go1 스택은 UART를 전혀 쓰지 않고 전부 네트워크(이더넷 + UDP + MQTT) 기반이다. GPIO UART를 켜도 영향이 없다.
→ **블루투스는 아예 건드릴 필요가 없다.** `dtoverlay=disable-bt`와 `systemctl disable hciuart`는 **실행 금지**(`hciuart` 유닛 자체가 존재하지 않음).

### ③ 포트 충돌 = **없음**

드론 예정 포트 **14540 / 14550 / 5760 전부 미사용.**

| 포트 | 프로토콜 | 점유 프로세스 |
|---|---|---|
| 22 | tcp | sshd |
| 1883 | tcp | mosquitto (MQTT) |
| 9001 | tcp | mosquitto (websockets) |
| 8090 / 8443 | tcp | `go1_cam_view` (pid 1161) |
| 15200 | udp | `robot_state_relay` (pid 1166) |
| 41641 | udp | tailscaled |
| 5353 | udp | avahi (mDNS) |
| 323 | udp | chrony |
| 10012 / 34485 / 42021 / 45715 | tcp (127.0.0.1) | VS Code 서버 등 로컬 |
| **14540 / 14550 / 5760** | — | **비어 있음** |

방화벽: `ufw` 미설치, `nftables.service`·`firewalld` 모두 inactive → 5760 개방에 별도 규칙 불필요(재확인은 5단계에서).

---

## 0-3. Tailscale — ④ 상태

| 항목 | 값 |
|---|---|
| `tailscaled` | **enabled / active** |
| pi7 주소 | **`100.72.109.9`** / `fd7a:115c:a1e0::9a30:6d0a` |
| tailnet | `khw671@`, 피어 11대 |
| 인증 상태 | 정상 (재인증 불필요) |

### 지상국 후보

| 이름 | Tailscale IP | OS | 상태 |
|---|---|---|---|
| **`desktop-oaujese`** | `100.125.71.51` | Windows | **active, direct `192.168.50.62`** ← 같은 LAN, 유력 |
| `desktop-0ib285f` | `100.83.37.9` | Linux | 온라인 |
| `desktop-oft3u6h` | `100.83.113.100` | Windows | 온라인 |
| `sysai-server2` | `100.102.8.102` | Linux | 온라인 |
| `pi4` | `100.81.196.55` | Linux | 온라인 |
| `laptop-isk6l1rq` / `pi1` / `pi2` / `pi6` / `ubuntu3-…` | — | — | offline |

### Go1 때 지상국이 Tailscale로 무엇에 붙었나 → **붙지 않았다**

`~/hw` 전체에서 `tailscale` · `100.x` 참조 **0건**. Go1 경로는 전부 LAN 직결이다.

- Unity 직결/릴레이: `192.168.50.244:15101` / `:15201`
- 브로커 접속: `127.0.0.1` (노드), `192.168.50.244` (코드 기본값), `pi7.local` (bench 도구)
- 카메라 뷰어: `http://pi7.local:8090/`

> **인식 정렬 필요**: 프롬프트 5단계의 *"Go1 때와 똑같이 Tailscale로 지상국과 연결한다"* 는 실제와 다르다. Tailscale은 떠 있지만 Go1이 쓰던 경로가 아니다. 드론에 Tailscale(TCP 5760)을 쓰는 것은 **문제없는 선택이지만 새로 도입하는 방식**이다.

---

## 0-4. 기준 스냅샷

`~/drone/baseline/` 에 저장 완료. 대조 방법은 같은 디렉터리의 `README.md` 참조.

| 파일 | 내용 |
|---|---|
| `TIMESTAMP` | 스냅샷 시각 |
| `go1-code-sha256.txt` | Go1 코드 **391개** 파일 해시 (`~/hw`, `~/go1sdk`, `~/unitree_legged_sdk`, `__pycache__`·`*.pyc` 제외) |
| `go1-config-sha256.txt` | 시스템 설정 **23개** 해시 (systemd 유닛·타이머, `/etc/hw-*.env`, `device_id`, `zone_id`, mosquitto, 부트 설정) |
| `go1-services-status.txt` | Go1 관련 10개 유닛 `systemctl status` 전문 |
| `enabled-units.txt` / `enabled-units-user.txt` | enabled 유닛 **43개** / 사용자 세션 8개 |
| `ss-tulnp.txt` | 열린 포트 전체 |
| `ip-4-addr.txt` | IPv4 주소 + 라우팅 |
| `nmcli-connections.txt` | NetworkManager 연결 프로파일 |
| `tailscale-status.txt` | tailnet 피어 목록 |
| `system-info.txt` | 모델 / `uname -a` / `/proc/cmdline` |
| `config.txt.snapshot` · `cmdline.txt.snapshot` | 부트 설정 원본 |
| `serial-devices.txt` | 시리얼 장치 노드 |
| `go1-venv-packages.txt` | `~/venv` 패키지 목록 |

### 자체 검증 (조사 직후 실행)

```
sha256sum -c go1-config-sha256.txt --quiet   → 설정 23개 변화 없음 ✔
sha256sum -c go1-code-sha256.txt   --quiet   → 코드 391개 변화 없음 ✔
Go1 서비스 5종                                → 전부 active 유지 ✔
```

**0단계에서 새로 만든 것은 `~/drone/baseline/`, `~/drone/PROGRESS.md`, 이 파일뿐이다.**

---

## ⚠ 프롬프트와 실제 하드웨어의 불일치 (1단계 전 수정 필요)

프롬프트 1·4단계는 Pi 3/4를 전제로 쓰여 있는데 실제 장비는 **Pi 5**라 다음이 맞지 않는다.

| # | 프롬프트 | 실제 | 조치 |
|---|---|---|---|
| A | FC 포트 = `/dev/serial0` | 현재 `/dev/serial0` = **디버그 UART `ttyAMA10`**, GPIO 8/10번 핀이 아님 | `dtparam=uart0=on` 적용 후 GPIO14/15가 **`/dev/ttyAMA0`** 로 생기고 udev가 `/dev/serial0`를 그쪽으로 옮길 것으로 예상되나 **재부팅 후 실측 확인 필수**. 설정 파일에는 모호한 `serial0` 대신 **`/dev/ttyAMA0` 명시** 권장 (4단계 `mavlink-router.conf`, 3단계 `check_link.py` 기본값 포함) |
| B | `enable_uart=1` 추가 | Pi 5에선 무의미. `raspi-config`의 `do_serial_hw 0`도 Pi5면 `dtparam=uart0=on`만 씀 (`is_pifive` 분기) | **생략** |
| C | `dtoverlay=disable-bt` + `systemctl disable hciuart` | Pi 5 BT는 `ttyS0` 전용. `hciuart` 유닛 **없음** | **실행 금지** |
| D | 사용자 `dialout` 그룹 추가 | **이미 소속** | 불필요 |

### 추가 위험 — 부팅 콘솔이 FC 배선으로 옮겨갈 수 있음

`/boot/firmware/cmdline.txt`에 **`console=serial0,115200`** 이 리터럴로 들어 있고, 펌웨어가 이를 실제 장치로 치환한다(현재 결과: `console=ttyAMA10,115200`).

`dtparam=uart0=on` 적용 후 `serial0` 별칭이 GPIO14/15를 가리키게 되면, **커널 부팅 콘솔 + 로그인 getty가 FC 배선 위로 올라가** 부팅 텍스트가 FC로 쏟아지고 MAVLink 링크가 깨질 수 있다.

→ `do_serial_cons 1`(= `cmdline.txt`에서 `console=serial0,115200 ` 제거)을 **반드시 함께** 수행해야 한다.
→ 단, 그러면 **3핀 디버그 커넥터 콘솔도 함께 사라진다.** 복구용으로 쓰고 있다면 대안: `console=serial0` → `console=ttyAMA10`으로 **명시 고정**(디버그 콘솔 유지 + GPIO 오염 방지).

---

## 1단계 제안 — 승인 요청

### 바꿀 것

| # | 작업 | 대상 파일 | Go1 영향 | 백업 |
|---|---|---|---|---|
| 1 | `sudo raspi-config nonint do_serial_cons 1` → `console=serial0,115200 ` 제거 | `/boot/firmware/cmdline.txt` | 없음 (Go1은 네트워크 경로) | `.bak.20260921` |
| 2 | `sudo raspi-config nonint do_serial_hw 0` → `dtparam=uart0=on` 추가 | `/boot/firmware/config.txt` | 없음 | `.bak.20260921` |
| 3 | 재부팅 | — | 재부팅 후 스냅샷 대조 | 규칙 3 — **별도 승인 후** |

### 하지 않을 것

`enable_uart=1` · `dtoverlay=disable-bt` · `systemctl disable hciuart` · `dialout` 추가 · **Go1 서비스 일절 조작**(stop/restart/disable/mask/파일 수정 모두 금지)

### 승인이 필요한 선택지

시리얼 콘솔 처리 방식:
- **(가)** `do_serial_cons 1` — 콘솔 완전 제거. 프롬프트 원안. 디버그 커넥터 콘솔도 사라짐
- **(나)** `console=serial0` → `console=ttyAMA10` 명시 고정 — 디버그 콘솔 유지하면서 GPIO14/15 오염만 차단

### 재부팅 후 확인 항목

1. `/dev/serial0`·`/dev/ttyAMA0`의 실제 연결 대상
2. `pinctrl get 14,15` 가 UART 기능으로 바뀌었는지
3. `/proc/cmdline` 에서 시리얼 콘솔 제거 확인
4. **Go1 서비스 5종 + `go1-watchdog.timer` 가 스냅샷과 동일하게 기동**, `go1-sdk`는 여전히 inactive
5. `sha256sum -c` 로 코드 391개 변화 0건, 설정은 부트 파일 2건 외 변화 0건

---

## 사람이 별도로 확인해야 할 것

- **root crontab** — sudo 암호가 필요해 미확인. 다른 자동실행 경로가 전부 비어 있어 systemd 단독으로 판단했으나, 확인 가능하면 `sudo crontab -l`로 검증 권장
- **지상국 PC 지정** — `desktop-oaujese`(`100.125.71.51`)가 유력하나 확정 필요
- **FC 파라미터** — 개정 2 기준 `MAV_0_CONFIG=TELEM1`, `MAV_0_MODE=Onboard`, `SER_TEL1_BAUD=921600`, `UXRCE_DDS_CFG=0` 을 QGroundControl에서 설정 (TELEM2 Air Unit의 `MAV_1_*`·`SER_TEL2_BAUD`는 현재 값 유지)
- **배선** — FC TELEM1 TX → 10번 핀(GPIO15), FC RX → 8번 핀(GPIO14), GND → 6번 핀
