# 드론 연동 환경 세팅 — 최종 보고서 (`pi3`)

작성: 2026-09-21 / 대상: X500 v2 쿼드콥터 컴패니언 컴퓨터
작업 범위: 전원을 켜면 드론 연결 준비가 자동으로 되는 데까지 (MQTT 브리지는 다음 작업)

**결론: 0~7단계 전부 통과.** 전원을 넣으면 **부팅 후 약 10초 만에** FC 링크가 자동으로 붙는다.
사람이 확인할 것 2가지가 남아 있다 (맨 아래 참조).

---

## 1. 하드웨어 · OS

| 항목 | 값 |
|---|---|
| 보드 | Raspberry Pi 5 Model B Rev 1.1 |
| OS | Debian GNU/Linux 13 (trixie) |
| 커널 / 아키텍처 | 6.18.50+rpt-rpi-2712 / aarch64 |
| 호스트명 | `pi3` |
| Python | 3.13.5 |
| 장비 식별자 | `/etc/device_id` = `x500-001` (MQTT clientId 겸용) |
| 사용자 | `physical` — `dialout`, `gpio`, `adm`, `sudo` 소속 |
| 비행 컨트롤러 | 코아 FC H743 / PX4 (MAV_TYPE_QUADROTOR, sysid 1) |

### 배선 — **라즈베리파이는 TELEM2 다**

| | FC 포트 | FC 장치 | MAVLink 인스턴스 | 보드레이트 |
|---|---|---|---|---|
| **라즈베리파이 GPIO14/15** | **TELEM2** | `/dev/ttyS3` | `MAV_1_*` | 921600 |
| 무선 Air Unit | TELEM1 | `/dev/ttyS1` | `MAV_0_*` | 57600 |

```
FC TELEM2 TX → 라즈베리파이 10번 핀 (GPIO15, RXD0)
FC TELEM2 RX → 라즈베리파이  8번 핀 (GPIO14, TXD0)
GND          → 라즈베리파이  6번 핀
```

> ⚠ **작업 프롬프트와 초기 문서는 이것을 정반대로("라즈베리파이=TELEM1") 적고 있었다.**
> 3단계에서 신호가 하나도 안 잡힌 진짜 원인이 이것이다. 자세한 경위는 4절.

**전원**: 드론 배터리 하나로 FC 와 라즈베리파이가 같이 켜지고 같이 꺼진다. FC 만 따로 끌 수 없다.

---

## 2. 바꾼 시스템 설정

모두 백업 후 변경했고, `diff` 로 의도한 줄만 바뀐 것을 확인했다.

| 파일 | 변경 | 이유 | 백업 |
|---|---|---|---|
| `/boot/firmware/config.txt` | `dtparam=uart0=on` 추가 | Pi 5 에서 GPIO14/15 UART 활성화 | `/boot/firmware/config.txt.bak.20260921` |
| `/boot/firmware/cmdline.txt` | `console=serial0,115200` → `console=ttyAMA10,115200` | 부팅 콘솔이 FC 배선으로 올라가는 것을 막고 디버그 커넥터 콘솔은 살림 | `/boot/firmware/cmdline.txt.bak.20260921` |
| `/etc/drone-node.env` | 신규 생성 + TELEM 주석 정정 | `drone-*` 유닛이 `EnvironmentFile` 로 읽는 설정 | `/etc/drone-node.env.bak.20260921` |
| `/etc/device_id` | 신규 생성 (`x500-001`) | 장비 식별자 | — |

**Pi 5 전용 방식**을 썼다. `enable_uart=1`, `dtoverlay=disable-bt`, `systemctl disable hciuart` 는
이 보드에 쓰지 않는다.

현재 `/proc/cmdline` 에 `console=ttyAMA10,115200 console=tty1` 이 들어가 있고,
GPIO UART(`/dev/ttyAMA0`)에 `serial-getty` 가 붙어 있지 않다.

### FC 장치 경로 — 실측 확정

```
/dev/ttyAMA0  -> 1f00030000.serial = DT uart0 = rp1/serial@30000 = GPIO14/15   ← FC
/dev/serial0  -> ttyAMA10 = 디버그 커넥터                                        ← 쓰면 안 된다
```

`pinctrl get 14,15` → `GPIO14 = TXD0`, `GPIO15 = RXD0`.
**`/dev/serial0` 을 쓰면 안 된다.** 모든 설정에 `/dev/ttyAMA0` 을 명시했다.

---

## 3. 설치한 소프트웨어

| 구분 | 패키지 | 버전 |
|---|---|---|
| apt (신규) | git / meson / ninja-build / python3-pip | 2.47.3 / 1.7.0 / 1.12.1 / 25.1.1 |
| apt (신규, 목록 외) | `systemd-dev` | 257.13 — mavlink-router 빌드에 필요해 추가 |
| apt (기존) | python3-venv / pkg-config / gcc / g++ | 3.13.5 / 1.8.1 / 14.2.0 / 14.2.0 |
| venv (`~/drone/venv`) | pymavlink | 2.4.49 |
| | MAVProxy | 1.8.74 |
| | mavsdk | 3.17.4 |
| | paho-mqtt | 2.1.0 |
| | pyserial / lxml | 3.5 / 6.1.3 |
| 소스 빌드 | mavlink-router | `v4-16-g2362c62` (`~/drone/src/mavlink-router`) |

파이썬 패키지는 전부 `~/drone/venv` 안에만 설치했다. 전역 `sudo pip install` 은 쓰지 않았다.
패키지가 설치하는 `mavlink-router.service` 는 **활성화하지 않았다** (자동 실행은 `drone-` 유닛이 맡는다).

---

## 4. FC 링크 — 확인 결과

### 처음에 왜 안 붙었나

라즈베리파이 선이 꽂힌 **TELEM2 가 FC 에서 설정이 꺼져 있었다.** PX4 는 설정되지 않은 포트를
초기화하지 않아 TX 핀이 high-Z 로 남는다. 그래서 `GPIO15` 풀다운 시험에서 핀이 떠 있는 것으로
읽혔고, 원시 바이트가 0 이었다.

진단 과정에서 라즈베리파이 쪽은 이상이 없음을 먼저 입증했다 —
UART 송신 시험(300 baud 로 `0x00` 출력 중 GPIO14 전압 90% LOW), 핀 기능, 장치 경로, 포트 점유 모두 정상.

**사람이 QGC 에서 조치**: `MAV_1_CONFIG=102(TELEM2)`, `MAV_1_MODE=2(Onboard)`,
`SER_TEL2_BAUD=921600` 설정 후 FC 재부팅. 이후 즉시 링크가 붙었다.

| 시험 | 조치 전 | 조치 후 |
|---|---|---|
| GPIO15 풀다운 60회 | `lo` 100% (핀이 떠 있음) | **`hi` 56 / `lo` 4 (93%)** — FC TX 가 선을 구동 |
| 원시 수신 | 0 바이트 | **60초당 약 19,000건 / 22~23종** |

풀다운에서 `hi` 93% 는 UART idle-high 에 데이터 구간 LOW 가 섞인 정확한 모습이다
(921600 baud 에서 초당 약 13KB ≈ 14% duty).

### 3단계 `check_link.py` 결과 — 성공 (종료 코드 0)

heartbeat: **PX4 / MAV_TYPE_QUADROTOR / DISARMED / AUTO.LOITER / sysid·compid = 1·1**

| 메시지 | Hz | | 메시지 | Hz |
|---|---|---|---|---|
| ATTITUDE | 99.6 | | VFR_HUD / GPS_RAW_INT / ALTITUDE 등 | 10.0 |
| HIGHRES_IMU | 50.0 | | SYS_STATUS / EXTENDED_SYS_STATE | 5.0 |
| ATTITUDE_QUATERNION | 50.0 | | HEARTBEAT / SYSTEM_TIME 등 | 1.0 |
| LOCAL_POSITION_NED | 30.0 | | BATTERY_STATUS / VIBRATION | 0.6 |

### 읽어 온 FC 파라미터 (**읽기만 했다 — 하나도 쓰지 않았다**)

| 파라미터 | 값 | 의미 |
|---|---|---|
| `MAV_0_CONFIG` / `MAV_0_MODE` / `SER_TEL1_BAUD` | 101 (TELEM 1) / 0 (Normal) / 57600 | **Air Unit** — 건드리지 않음 |
| `MAV_1_CONFIG` / `MAV_1_MODE` / `SER_TEL2_BAUD` | **102 (TELEM 2) / 2 (Onboard) / 921600** | **라즈베리파이** |
| `UXRCE_DDS_CFG` | 0 (Disabled) | 예정대로 — 시리얼 포트를 물지 않는다 |

### 라즈베리파이 TX → FC RX 방향도 정상

`PARAM_REQUEST_READ` 로 파라미터 7개를 실제로 읽어 왔다. 요청이 FC 에 닿지 않으면 값이
하나도 돌아오지 않으므로, **8번 핀 → FC RX 방향이 정상임이 증명된다.**
FC 콘솔에서 rx=0 으로 보였던 것은 그 시점에 라즈베리파이가 아직 아무것도 보내지 않고 있었기
때문이다 (`drone-detect`·`drone-linkmon` 은 읽기 전용이라 평소 송신이 거의 없다).

---

## 5. 만든 파일과 유닛

### systemd 유닛 (`~/drone/systemd/`, `/etc/systemd/system/` 에 설치)

| 유닛 | 역할 | 자동 시작 |
|---|---|---|
| `drone-detect.service` | `/dev/ttyAMA0` 에서 heartbeat 를 찾는다. 찾으면 `drone.target` 시작, 못 찾으면 10초 간격 재시도. 드론 모드에서는 링크 끊김(15초)을 감시해 되돌린다 | **enabled** |
| `drone.target` | 드론 모드 묶음 | `drone-detect` 가 시작 |
| `drone-mavlink-router.service` | `config/mavlink-router.conf` 로 라우팅. 죽으면 자동 재시작 | `drone.target` 소속 |
| `drone-linkmon.service` | heartbeat 를 계속 확인해 끊김·복구를 기록. **읽기 전용** | `drone.target` 소속 |

부팅 시 자동으로 뜨는 것은 **`drone-detect.service` 하나뿐**이다. 제어 명령을 보내는 프로그램은
자동 실행 대상에 **하나도 없다**.

### 엔드포인트

| 포트 | 용도 |
|---|---|
| **TCP 5760** | **QGroundControl** (Tailscale `100.85.243.54:5760`) |
| UDP 14540 | MAVSDK 제어 코드 자리 (6단계 스크립트용, 평소 닫힘이 정상) |
| UDP 14541 | `drone-linkmon` 전용 (읽기 전용) |
| UDP 14542 | `drone-detect` 링크 감시용 (읽기 전용) |

### 스크립트 (`~/drone/scripts/`)

| 파일 | 용도 | 위험도 |
|---|---|---|
| `check_link.py` | 3단계 링크 확인. heartbeat·메시지 주기·ATTITUDE·FC 파라미터 판정 | 낮음 — 읽기 전용 |
| `dronelink.py` | 공통 헬퍼 (기체 heartbeat 판별 등) | — |
| `fc_detect.py` | `drone-detect.service` 본체 | 낮음 — 읽기 전용 |
| `linkmon.py` | `drone-linkmon.service` 본체 | 낮음 — 읽기 전용, 송신 0바이트 |
| `step7_check.sh` | 7단계 상태 점검 | 없음 — 읽기만 |
| `step7_cb_watch.sh` | 링크 차단/복구 시 상태 변화 기록 | 없음 — 읽기만 |
| `step7_cb_gpio.sh` | 점퍼선 없이 링크 차단/복구를 재현 | 낮음 — GPIO15 입력 전환, `trap` 으로 복구 |
| `telemetry_watch.py` | 위치·고도·자세·배터리·모드 1Hz 출력. **명령 없음. 실행해도 된다** | 낮음 |
| `arm_disarm_test.py` | arm → 3초 → disarm | **높음 — 프로펠러 제거 확인 후에만** |
| `takeoff_land.py` | 1.5m 이륙 → 8초 → 착륙 | **높음 — 실제 비행** |

**제어 스크립트 3개는 작성만 했고 한 번도 실행하지 않았다.**
(`scripts/__pycache__/` 에 `check_link`·`dronelink` 만 있는 것이 그 증거다.)

### 설정 (`~/drone/config/`)

- `drone.env` → `/etc/drone-node.env` 심볼릭 링크. `FC_DEVICE`, 타이밍, 포트, Tailscale/MQTT 주소
- `mavlink-router.conf` — UART `/dev/ttyAMA0` @ `921600,57600` + UDP/TCP 엔드포인트
- `installed-versions.txt` — 설치 도구 버전 기록

---

## 6. 자동 실행 검증 (7단계) — **전부 통과**

배터리 하나로 FC 와 라즈베리파이가 같이 켜지므로 "FC 전원만 차단" 을 할 수 없다.
대신 **GPIO15(수신 핀)를 UART 기능에서 잠시 떼어내** 링크 차단을 재현했다
(`scripts/step7_cb_gpio.sh`). FC 입장에서도 `drone-detect` 입장에서도 점퍼를 뽑은 것과 같다.

| 경우 | 방법 | 기대 | 실측 | |
|---|---|---|---|---|
| **A** FC 없이 부팅 | 링크 없는 상태로 부팅 | `mode=none`, 조용히 대기 | `none`, 재시작 0회, 로그 9줄, CPU 0.45초 | ✅ |
| **C** 드론 모드 중 링크 차단 | GPIO15 떼어냄 | 15초 내 복귀, 포트 닫힘 | **15초**, 포트 전부 닫힘, linkmon 에 끊김 기록 | ✅ |
| **B** 링크 복구 | GPIO15 복구 | 10초 내 감지 | **9초**, 포트 전부 열림 | ✅ |
| **D** 연결 상태로 부팅 | `sudo reboot` | `mode=drone` | **10초** (부팅 19:32:30 → 드론 모드 19:32:40) | ✅ |

D 는 배터리 부팅이 아니라 소프트웨어 재부팅이다. 차이는 "FC 가 늦게 떠도 붙는가" 인데
그쪽은 **B 가 이미 통과**했으므로 두 단계를 합치면 배터리 부팅의 경우가 덮인다.

### 기준 스냅샷 대조 — 드론 관련 변경 외에 달라진 것 없음

| 항목 | 결과 |
|---|---|
| enabled 유닛 | **+3** (드론 유닛), 사라진 것 **0** |
| 부팅 자동 시작 | `drone-detect.service` 만 |
| 부트 설정 2개 | 1단계 의도적 변경 + TELEM 주석 정정 |
| IPv4 | `192.168.50.254/24` (wlan0), `100.85.243.54/32` (tailscale0) — 동일 |
| 방화벽 | ufw 미설치, nftables 는 Tailscale 자체 체인뿐 — 변화 없음 |
| 시리얼 장치 | 동일 |
| 드론 외 포트 | ssh·avahi·Tailscale·VS Code 임시 포트뿐 |

---

## 7. 지상국 연결 (Tailscale)

| 항목 | 값 |
|---|---|
| 이 장비 | `pi3` = **`100.85.243.54`** |
| 지상국 | `desktop-oaujese` = `100.125.71.51` |
| **QGC 에 입력할 주소** | **TCP `100.85.243.54:5760`** |
| `tailscaled` | enabled — 재부팅 후에도 자동 접속 (재부팅으로 확인함) |

`--ssh`, `--advertise-exit-node`, `--accept-routes` 는 쓰지 않았다.
방화벽이 없어 5760 포트를 따로 열 필요가 없었다.

**MQTT 브로커**(`pi7`)는 주소만 `drone.env` 에 기록하고 연결하지 않았다:
`MQTT_HOST=192.168.50.172`, `MQTT_HOST_TS=100.72.109.9`, `MQTT_PORT=1883`.

---

## 8. 사람이 확인해야 할 것

### 남은 확인 2가지 — **둘 다 완료 (2026-09-21 19:4x)**

1. **QGroundControl 접속** — 지상국에서 TCP `100.85.243.54:5760`. **사용자 확인 완료.** ✅
2. **기체 기울임에 ATTITUDE 가 따라 바뀌는지** — **확인 완료.** ✅
   `scripts/attitude_watch.py` (읽기 전용, 송신 0바이트) 로 측정:

   | | 정지 기준선 | 기울이는 중 | 정지 복귀 후 |
   |---|---|---|---|
   | roll | 약 1.6도, 변화폭 1도 미만 | **변화폭 173.2도** | 0.16도에서 0.05도 이내 안정 |
   | pitch | 약 -0.8도, 변화폭 1도 미만 | **변화폭 121.6도** | 1.58도에서 0.05도 이내 안정 |
   | yaw | 드리프트 약 2도 | 변화폭 359.9도 | 안정 |

   기울임에 즉시 따라왔고, 내려놓자 흔들림 없이 수평으로 수렴했다.
   **자세 추정(EKF)까지 정상이다.** 측정 중 5,000건 넘는 ATTITUDE 를 누락 없이 받았다.

### 참고 사항

- **배터리 실물 부팅은 아직 안 해 봤다.** 기회가 될 때 배터리를 넣고
  `cd ~/drone && bash scripts/step7_check.sh` 한 번이면 확인된다. 기대: `mode=drone`.
- **비행 중 전원 여유**는 모터 정지 상태에서만 쟀다 (`vcgencmd get_throttled` = `0x0`,
  EXT5V 5.331V, under-voltage 0건). **비행 전에 모터를 돌린 상태에서 다시 확인**할 것.
  `0x0` 이 아니면 BEC 용량이 부족한 것이다.
- **`MAV_0_MODE` 가 `0 (Normal)`** 이다. Air Unit 자리라 규칙대로 건드리지 않았다.
  무선 텔레메트리 동작에 문제가 있으면 이 값을 확인할 것.
- 제어 스크립트 `arm_disarm_test.py`, `takeoff_land.py` 는 **프로펠러 제거 / 비행 안전 확보 후**
  사람이 직접 실행해야 한다.

### 다음 작업 (이번 범위 밖)

MQTT 규약에 맞춘 드론 브리지. 경로는 웹 → 서버 → MQTT → 라즈베리파이 → MAVLink → FC.
라즈베리파이 안의 제어 코드는 `udpin://0.0.0.0:14540` 으로 붙으면 된다 (`mavlink-router` 가 중계).

---

## 부록 — 자주 쓸 명령

```sh
cd ~/drone

# 상태 한눈에
bash scripts/step7_check.sh

# 링크 상세 확인 (라우터가 떠 있을 때는 UDP 경유로 붙는다)
./venv/bin/python scripts/check_link.py --device udpin:0.0.0.0:14540

# 텔레메트리 실시간 보기 (안전 — 명령 없음)
./venv/bin/python scripts/telemetry_watch.py

# 로그
journalctl -u drone-detect -b --no-pager
tail -f logs/linkmon.log
```

작업 경위와 진단 기록 전체는 `~/drone/PROGRESS.md` 에 있다.
