# 드론 연동 환경 세팅 — 진행 기록 (`pi3`)

대상: Raspberry Pi 5 Model B Rev 1.1 (hostname `pi3`) / Debian 13 trixie 13.7
용도: X500 v2 쿼드콥터 컴패니언 컴퓨터 (FC = 코아 H743, PX4, **TELEM2** 연결)
시작: 2026-09-21 (프롬프트 개정 3)

> `pi7`(Go1 장비) 시절 기록은 `archive/pi7/`에 보관. 이 장비와 무관하다.

## 0단계 — 새 장비 현황 조사 (완료, 무변경)

2026-09-21 16:51 KST 완료. **`~/drone` 정리 외에 시스템은 아무것도 바꾸지 않았다.**
새로 만든 것: `~/drone/baseline/`(신규 스냅샷), `~/drone/archive/pi7/`(이동), 이 파일,
`~/drone/STEP0_REPORT_pi3.md`.

### 확인된 핵심 사실
- **Pi 5 Rev 1.1** → `pi7`의 Pi 5 판단을 그대로 적용한다.
  `dtparam=uart0=on` 사용, `enable_uart=1`·`dtoverlay=disable-bt`·`hciuart` 금지(`hciuart` 유닛 없음).
- GPIO14/15(uart0, RP1 `serial@30000`)는 현재 **DT status=disabled**, `pinctrl` 기능 `none`.
  시리얼 장치는 `/dev/ttyAMA10` 하나뿐이고 **`/dev/serial0`는 디버그 UART를 가리킨다** — FC 포트가 아니다.
- `cmdline.txt`에 **`console=serial0,115200` 리터럴 존재** → UART를 켜면 부팅 콘솔이 FC 배선으로
  옮겨갈 위험. `console=ttyAMA10,115200`으로 명시 고정할 것.
- 사용자 `physical`은 **`dialout` 이미 포함**.
- 드론 포트 **14540 / 14550 / 5760 전부 비어 있음.** 방화벽 없음(ufw 미설치, nftables inactive,
  iptables는 tailscale 체인뿐) → 5760 개방 규칙 불필요.
- 네트워크: `wlan0` **192.168.50.254/24**, SSID `SysAILAB_5GHz`, GW `192.168.50.1` → 연구실 망 접속됨.
- **Tailscale은 이미 설치·로그인돼 있다.** `pi3` / **`100.85.243.54`**, `tailscaled` enabled+active.
  → 5단계의 설치·로그인 작업은 생략 가능. QGC 접속 주소는 `100.85.243.54:5760`.
- 미설치 도구: **git, meson, ninja-build, python3-pip** (2단계에서 설치). gcc·g++·make·pkg-config·
  python3-venv·curl은 이미 있음.
- `/etc/device_id` 없음 → 4단계에서 `x500-001`로 새로 만든다.
- 기존 `drone-*` 유닛 없음, mavlink 도구 없음. 깨끗한 상태.

### 보고서
전체 조사 결과: **`~/drone/STEP0_REPORT_pi3.md`**
기준 스냅샷: `~/drone/baseline/` (대조 방법은 `baseline/README.md`)
`pi7` 참고 자료: `~/drone/STEP0_REPORT.md`, `~/drone/archive/pi7/`

### 다음 단계
사용자 승인(2026-09-21) → 1단계 진행. Tailscale 이름은 `pi3` 그대로 유지하기로 결정.

## 1단계 — UART 설정 (완료, 재부팅·검증 끝)

2026-09-21 16:56 KST 적용 → 16:59 재부팅 → 검증 완료. 부트 설정 2개만 수정했다.
GPIO14/15가 UART 기능으로 올라왔고 FC 장치 경로를 `/dev/ttyAMA0` 으로 확정했다.

### 백업 (롤백 지점)

| 백업 파일 | sha256 | 0단계 스냅샷과 |
|---|---|---|
| `/boot/firmware/config.txt.bak.20260921` | `90a4468215…c98c3` | **일치 ✔** |
| `/boot/firmware/cmdline.txt.bak.20260921` | `dc6694ae6f…92a75` | **일치 ✔** |

롤백: `sudo cp -a /boot/firmware/<파일>.bak.20260921 /boot/firmware/<파일>` 후 재부팅.

### 바꾼 것

**1. `/boot/firmware/config.txt`** — `[all]` 섹션 끝에 3줄 추가 (변경 후 `9f1bb0b7d7…0efa8`)

```diff
 [all]
+# 드론 FC(TELEM1) 연결용 GPIO14/15 UART 활성화 — 2026-09-21
+# Pi 5 전용 방식. 구형 Pi용 UART/BT 설정은 이 보드에 쓰지 않는다
+dtparam=uart0=on
```

**2. `/boot/firmware/cmdline.txt`** — 콘솔 지정만 치환 (변경 후 `b32c7dc093…c15e67`)

```diff
-console=serial0,115200 console=tty1 root=PARTUUID=c48591e8-02 …
+console=ttyAMA10,115200 console=tty1 root=PARTUUID=c48591e8-02 …
```

개행 없는 1줄 구조 유지(169→170바이트, `wc -l`=0). `serial0` 잔존 0건.
이유: `uart0`를 켜면 `serial0` 별칭이 GPIO14/15로 옮겨가 부팅 콘솔·getty가 **FC 배선 위로**
올라간다. `ttyAMA10` 고정으로 디버그 커넥터 콘솔은 유지하고 GPIO 오염만 막는다.

### 하지 않은 것 (모델에 맞지 않거나 불필요)

`enable_uart=1` · `dtoverlay=disable-bt` · `systemctl disable hciuart`(유닛 자체가 not-found) ·
`dialout` 추가(이미 소속) · `serial-getty@ttyAMA10` 조작 · 재부팅

주석 제외 grep 확인: `enable_uart` 0건, `disable-bt` 0건, `hciuart` 0건, `dtparam=uart0=on` 1건.

### 적용 직후 검증 (재부팅 전)

| 항목 | 결과 |
|---|---|
| enabled 유닛 | 스냅샷과 **차이 없음 ✔** |
| 열린 포트 | 스냅샷과 **차이 없음 ✔** |
| NetworkManager 프로파일 | 스냅샷과 **차이 없음 ✔** |
| 사용자 그룹 | 변화 없음 ✔ |
| 시리얼 장치 | `/dev/serial0 → ttyAMA10` 그대로, `pinctrl 14,15` = `none` (재부팅 전이므로 정상) |
| 부트 설정 2개 | **의도적으로 변경됨** (스냅샷 대비 FAILED = 예상된 결과) |

→ **부트 설정 2개 외에 바뀐 것은 없다.**

### 재부팅 후 검증 (2026-09-21 16:59 재부팅, 완료)

| # | 확인 항목 | 결과 | 판정 |
|---|---|---|---|
| 1 | 시리얼 장치 실제 연결 대상 | `ttyAMA0` → `1f00030000.serial` = **RP1 uart0 = GPIO14/15**<br>`ttyAMA10` → `107d001000.serial` = 디버그 커넥터<br>`serial0` → **`ttyAMA10`** | ✅ |
| 2 | `pinctrl get 14,15` | `14: a4 … TXD0` / `15: a4 … RXD0`, DT uart0 status=okay | ✅ |
| 3 | 콘솔 + getty | `/proc/cmdline` = `console=ttyAMA10,115200 console=tty1`<br>활성 콘솔 `ttyAMA10 tty1`, getty는 `serial-getty@ttyAMA10`뿐<br>**`ttyAMA0`에 getty 없음** | ✅ |
| 4 | 스냅샷 대비 변화 | enabled 유닛 0 / NetworkManager 0 / 그룹 동일<br>포트는 재부팅으로 PID·임시포트만 변동, 신규 서비스 0<br>14540·14550·5760 여전히 빔 | ✅ |

### ⚠ pi7 보고서의 예상과 달랐던 점

`/dev/serial0`이 `ttyAMA0`으로 **옮겨가지 않았다.** `cmdline.txt`에 `console=ttyAMA10`을 고정한
결과 udev(`99-com.rules`)가 `serial0` 심볼릭 링크를 콘솔 장치 쪽에 붙였기 때문이다.
→ **`serial0`을 FC 포트로 쓰면 틀린다. 반드시 `/dev/ttyAMA0`을 쓸 것.**

### FC 장치 경로 확정

`~/drone/config/drone.env` 에 기록:
```
FC_DEVICE=/dev/ttyAMA0
FC_BAUD=921600
```
근거: `/dev/ttyAMA0` → `1f00030000.serial` = DT `uart0` = `rp1/serial@30000` = GPIO14/15.
사용자가 `dialout` 소속이라 읽기/쓰기 접근 가능.

## 2단계 — 소프트웨어 설치 (완료)

2026-09-21 17:17 KST 완료. 사용자가 `sudo -v` 로 타임스탬프를 갱신해 줘서 잔여분을 마쳤다.
(`/etc/sudoers.d/010_global-tty` 의 `Defaults timestamp_type=global` 덕에 세션 간 공유된다.)

### apt

| 패키지 | 버전 | 비고 |
|---|---|---|
| git | 1:2.47.3-0+deb13u1 | 신규 |
| meson | 1.7.0-1 | 신규 |
| ninja-build | 1.12.1-1+b1 | 신규 |
| python3-pip | 25.1.1+dfsg-1+rpt1 | 신규 |
| **systemd-dev** | 257.13-1~deb13u1 | **신규 — 프롬프트 목록에 없음** |
| python3-venv | 3.13.5-1 | 이미 있었음 |
| pkg-config / gcc / g++ | 1.8.1-4 / 14.2.0 / 14.2.0 | 이미 있었음 |

**`systemd-dev` 를 추가한 이유**: `meson setup` 이 `dependency('systemd')` 에서 멈춘다.
`systemdsystemunitdir` 경로를 pkg-config 로 알아내는 용도이고, 이게 없으면 빌드가 시작되지 않는다.
설치 후 `pkg-config --variable=systemdsystemunitdir systemd` → `/usr/lib/systemd/system`.

### ~/drone/venv (전역 `sudo pip install` 없음 — 규칙 2 준수)

| 패키지 | 버전 |
|---|---|
| pymavlink | 2.4.49 |
| MAVProxy | 1.8.74 |
| mavsdk | 3.17.4 |
| paho-mqtt | 2.1.0 |
| (의존성) | lxml 6.1.3, fastcrc 0.5.0, pyserial 3.5, numpy 2.5.3, grpcio 1.84.0, protobuf 7.36.2, pynmeagps 1.1.7, typing_extensions 4.16.0 |

### mavlink-router

| 항목 | 값 |
|---|---|
| 소스 | `~/drone/src/mavlink-router` (`git clone --recursive`) |
| 버전 | **v4-16-g2362c62** (커밋 `2362c620`) |
| 서브모듈 | `modules/mavlink_c_library_v2` @ `052b8579` ✔ |
| 빌드 | `meson setup build .` → `ninja -C build` — 경고 0건, 오류 0건 |
| 설치 | `sudo ninja -C build install` → `/usr/bin/mavlink-routerd` |
| 유닛 | `/usr/lib/systemd/system/mavlink-router.service` |
| **유닛 상태** | **`disabled` / `inactive`** — 활성화하지 않았다. 자동 실행은 4단계 `drone-` 유닛으로 한다 |

설치된 것은 바이너리 1개와 유닛 파일 1개뿐이다(`meson install --dry-run` 으로 미리 확인).
저장소의 예제 바이너리(`px4-offboard-mode` 등)는 설치되지 않았고 실행한 적도 없다.

전체 기록: `~/drone/config/installed-versions.txt`

### 설치 후 변경 범위 검증

| 항목 | 결과 |
|---|---|
| enabled 유닛 (스냅샷 대비) | **변화 없음 ✔** — `mavlink-router` 는 enabled 목록에 없다 |
| 드론 포트 14540/14550/5760 | 전부 비어 있음 ✔ |
| `mavlink-routerd` 프로세스 | 실행 중 아님 ✔ |
| `/etc/mavlink-router` | 생성되지 않음 (설정은 4단계에서 `~/drone/config/` 에 만든다) |
| 부트 설정 | 1단계 변경분 그대로, 추가 변경 없음 |

## 3단계 — 수동 연결 확인 (스크립트 완료, **FC 링크 실패**)

### 작성 완료: `~/drone/scripts/check_link.py`

프롬프트 3단계 요구사항을 모두 구현했다. 읽기 전용이며 보내는 것은
heartbeat · `PARAM_REQUEST_READ` · `SET_MESSAGE_INTERVAL`(스트림 요청)뿐이다.
arm/takeoff/모드변경/모터테스트/offboard/파라미터 쓰기는 일절 없다.

- `--device` 기본값 = `drone.env` 의 `FC_DEVICE`, `udpin:0.0.0.0:14540` 형식도 허용
- `--baud` 기본 921600, 실패 시 57600 자동 재시도 (`--no-fallback` 로 끌 수 있음)
- heartbeat 최대 10초 대기 → sysid/compid, autopilot, 기체 타입, arm 상태, custom mode 출력
- 5초간 메시지 종류별 개수와 Hz 표
- ATTITUDE roll/pitch/yaw 도 단위 6줄 (없으면 `SET_MESSAGE_INTERVAL` 로 스트림 요청)
- `MAV_0_CONFIG`/`MAV_0_MODE`/`SER_TEL1_BAUD` + `MAV_1_CONFIG`/`MAV_1_MODE`/`SER_TEL2_BAUD`
  + `UXRCE_DDS_CFG` 읽기 → **TELEM2 에 배정된 인스턴스**가 라즈베리파이 링크인지,
    TELEM1 Air Unit 이 살아 있는지 판정 (2026-09-21 배선 정정 반영)
- 종료 코드 0/1 (4단계 `drone-detect.service` 가 재사용)
- 실패 시 원인 후보 6가지 출력

**PX4 정수 파라미터 처리**: PX4는 정수 파라미터를 PARAM_VALUE 의 float 필드에 **bit-cast**
해서 보낸다(ArduPilot 은 수치 캐스트). 그대로 읽으면 101 이 1.4e-43 으로 나온다.
`param_type` 이 정수형이면 비트를 int32 로 재해석하도록 했고, 양쪽 방식 모두 검증했다.

### 오프라인 검증 (FC 없이 확인 가능한 부분)

| 항목 | 결과 |
|---|---|
| 문법 검사 / `--help` | ✅ |
| PX4 bit-cast 파라미터 변환 (101, 2, 921600, 0, 102) | ✅ 전부 일치 |
| ArduPilot 수치 캐스트 / REAL32 실수 파라미터 | ✅ |
| enum 표시 (`fmt_cfg`, `fmt_mode`) | ✅ |
| PX4 custom_mode 디코딩 (MANUAL/POSCTL/AUTO.MISSION/TAKEOFF/LAND/OFFBOARD) | ✅ |
| UDP 경로 (`udpin:`) — 보드레이트 재시도 건너뜀, 실패 경로 | ✅ 종료 코드 1 |

### ❌ FC 링크 실패 — 원인은 배선 또는 FC 전원

`./venv/bin/python scripts/check_link.py` → 921600, 57600 둘 다 heartbeat 없음. 종료 코드 1.

원인을 좁힌 결과:

| 확인 | 결과 | 의미 |
|---|---|---|
| 원시 바이트 수신 (921600/115200/57600/38400/19200/9600) | **전 구간 0바이트** | 보드레이트 문제가 아니다 |
| 포트 열기 / `stty` | 정상 | 장치 경로 정상 |
| `/dev/ttyAMA0` 점유 프로세스 | **없음** | 콘솔·다른 프로세스 충돌 아님 |
| `pinctrl get 14,15` | `TXD0` / `RXD0` | UART 기능 정상 |
| **GPIO15 풀다운 시험** | 풀다운 → **`lo`**, 풀업 → `hi` | **10번 핀을 구동하는 외부 신호가 없다** |

풀다운 시험이 결정적이다. (당시 전제: 라즈베리파이가 TELEM1 에 붙어 있다 — **뒤에 TELEM2 로 정정됨**)
FC TX 가 연결돼 전원이 들어와 있으면 idle-high 로 선을
붙들어 풀다운을 이기고 `hi` 로 읽혀야 한다. `lo` 로 떨어졌다는 건 **핀이 떠 있다**는 뜻이다.
(시험 후 핀은 원래 상태 `a4 pu` 로 복구했다. GPIO15 는 입력이라 FC 쪽으로 아무것도 보내지 않았다.)

→ 라즈베리파이 쪽 설정은 정상이다. **FC 전원 / TELEM1 커넥터 / 점퍼선**을 사람이 확인해야 한다.

## 다음 단계 — 사용자 확인 대기

> **⚠ 정정 (2026-09-21 19:xx)**: 아래 배선·파라미터 기준은 **틀렸다**.
> 라즈베리파이는 TELEM1 이 아니라 **TELEM2** 에, Air Unit 은 **TELEM1** 에 꽂혀 있었다.
> 올바른 기준은 이 문서 맨 끝 「배선 정정」 절에 있다.

1. **FC 배선·전원 확인** (3단계 통과 조건)
   - FC 에 전원이 들어와 있는가
   - FC TELEM1 TX → 라즈베리파이 **10번 핀**(GPIO15), FC RX → **8번 핀**(GPIO14), GND → **6번 핀**
   - TX↔TX / RX↔RX 로 바뀌어 꽂히지 않았는가
   - 확인 후: `cd ~/drone && ./venv/bin/python scripts/check_link.py`
2. FC 파라미터 (QGroundControl, 사람이 설정)
   - `MAV_0_CONFIG=TELEM1`, `MAV_0_MODE=Onboard`, `SER_TEL1_BAUD=921600`, `UXRCE_DDS_CFG=0`
   - TELEM2 Air Unit 의 `MAV_1_*`·`SER_TEL2_BAUD` 는 현재 값 유지
   - 링크가 붙으면 `check_link.py` 가 이 값들을 읽어서 판정해 준다

## 4단계 — 부팅 시 자동 연결 준비 (구현 완료, FC 실물 검증만 남음)

2026-09-21 17:40 KST. pi7 과 같은 결로 **systemd 유닛 + `/etc` env 파일** 구조로 만들었다.

### /etc 파일 (pi7 의 `/etc/hw-node.env`·`/etc/device_id` 와 같은 결)

| 경로 | 내용 |
|---|---|
| `/etc/device_id` | `x500-001` (MQTT clientId 겸용. pi7 의 `go1-001`·`wl-001` 과 겹치지 않음) |
| `/etc/drone-node.env` | FC 장치·보드레이트, 감지 타이밍, 포트, Tailscale·MQTT 주소 |

`~/drone/config/drone.env` 는 **`/etc/drone-node.env` 를 가리키는 심볼릭 링크**다.
사본이 아니라 같은 파일이라 두 곳이 어긋날 수 없다. 고치려면 sudo 가 필요하다.
(기존 파일은 `config/drone.env.superseded.20260921` 로 남겨 뒀다.)

### 유닛

| 유닛 | 역할 | 실행 사용자 | 부팅 자동 시작 |
|---|---|---|---|
| `drone-detect.service` | FC 감지 → `drone.target` start/stop, `state/mode` 기록 | **root** (target 을 start/stop 해야 함) | **예** |
| `drone.target` | 드론 모드 묶음 | — | **아니오** (`static`) |
| `drone-mavlink-router.service` | `/usr/bin/mavlink-routerd -c ~/drone/config/mavlink-router.conf` | `physical` + `dialout` | 아니오 (target 소속) |
| `drone-linkmon.service` | 링크 끊김·복구 기록 (**읽기 전용**) | `physical` | 아니오 (target 소속) |

`systemctl list-unit-files` 에서 router·linkmon 도 `enabled` 로 보이지만, 이는 `drone.target`
소속이라는 뜻일 뿐이다. `drone.target` 이 `static` 이라 부팅 때 켜지지 않으므로
**부팅 시 실제로 뜨는 건 `drone-detect` 하나뿐**이다 (`multi-user.target.wants` 로 확인).

유닛 원본은 `~/drone/systemd/` 에 두고 `/etc/systemd/system/` 에 설치했다.
`systemd-analyze verify` 4개 전부 통과.

### 라우터 설정 `~/drone/config/mavlink-router.conf`

| 엔드포인트 | 용도 |
|---|---|
| `[UartEndpoint fc]` `/dev/ttyAMA0`, Baud `921600,57600` | FC **TELEM2**. 목록으로 두면 유효 패킷이 올 때까지 순환한다 |
| TCP 5760 | QGroundControl (Tailscale `100.85.243.54:5760`) |
| `[UdpEndpoint local_ctrl]` 14540 | MAVSDK 제어 코드 (6단계 스크립트) |
| `[UdpEndpoint linkmon]` **14541** | `drone-linkmon` 전용 |
| `[UdpEndpoint detect]` **14542** | `drone-detect` 의 끊김 감시 전용 |

**14541·14542 는 프롬프트 설정 예시에 없던 것을 추가했다.** linkmon 과 detect 가 14540 을
쓰면 MAVSDK 제어 코드와 포트를 다투게 된다. 소비자마다 전용 포트를 준 것이다.

### 상태 기계 (`scripts/fc_detect.py`)

```
mode=none ──FC heartbeat 발견──> 포트 해제 확인 ──> drone.target start ──> mode=drone
    ^                                                                        │
    └──── drone.target stop <── heartbeat 가 LINK_TIMEOUT(15s) 끊김 <────────┘
```

- FC 가 없으면 `DETECT_INTERVAL`(10초) 간격으로 조용히 재시도. 같은 사유의 로그는 한 번만 찍는다
- FC 전원이 늦게 들어와도 재시도 중에 잡힌다
- 감지 후 시리얼 포트를 닫고 `/proc/*/fd` 로 **실제 해제를 확인한 뒤** 라우터를 띄운다
- 다른 프로세스가 포트를 잡고 있으면 그 회차는 건너뛴다 (라우터와 충돌 방지)
- 상태는 `~/drone/state/mode` 에 `drone` / `none`

### ⚠ 검증 중 찾은 실제 버그 — heartbeat 판별

가짜 FC(pty)로 시험하다 발견했다. 원래 코드는 `msg.get_srcSystem() != m.mav.srcSystem` 으로
자기 자신을 걸러냈는데:

1. **PX4 기본 `MAV_SYS_ID` 는 1 이고 컴패니언도 관례상 sysid 1**(compid 191)을 쓴다.
   sysid 만 비교하니 **FC heartbeat 를 '내가 보낸 것'으로 오인해 버렸다.**
   → 실제 FC 를 연결했어도 감지가 통째로 실패했을 버그다.
2. 라우터를 거치면 QGC·MAVSDK 의 heartbeat 도 들어온다. 그걸 링크 생존 신호로 세면
   **FC 가 없는데도 링크가 살아 있다고 오판**한다.

공용 모듈 `scripts/dronelink.py` 의 `is_vehicle_heartbeat()` 로 고쳤다:
`(sysid, compid)` 를 **함께** 비교하고, `autopilot != MAV_AUTOPILOT_INVALID` 인 것만 FC 로 인정한다.
`fc_detect.py`·`linkmon.py`·`check_link.py` 세 곳 모두 적용했고 8가지 경우로 단위 검증했다.

### 검증 결과 (FC 실물 없이 가능한 범위)

| 경우 | 방법 | 결과 |
|---|---|---|
| FC 없이 부팅 (7단계 표 2행) | 실제 서비스 기동 | `mode = none`, `drone.target` inactive, 포트 전부 닫힘, **에러 반복 없음**(로그 9줄, 재시작 0회, CPU 0.39초) ✔ |
| FC 발견 → 드론 모드 | pty 가짜 FC(PX4 heartbeat 2Hz) | heartbeat 수신 → 포트 해제 확인 → `drone.target` start → `mode = drone` ✔ |
| 드론 모드 구성 | 위와 동시 | router+linkmon active, TCP 5760 LISTEN, UDP 14541/14542 bind, `/dev/ttyAMA0` 점유자 = `mavlink-routerd` ✔ |
| 링크 끊김 → 복귀 (7단계 표 4행) | 라우터가 무신호 ttyAMA0 을 보게 함 | 15초 후 `drone.target` stop → `mode = none` → 재감지 ✔ |
| 순환 반복 | 위 과정 4회 연속 | 발견 4 / 해제확인 4 / start 4 / 끊김 3 / stop 3 — 누수 없이 반복 ✔ |
| 유닛 문법 | `systemd-analyze verify` | 4개 전부 통과 ✔ |

**아직 못 한 것**: 실제 FC 로 붙는 경로. FC 배선이 연결되면 그대로 동작할 것으로 보지만
확인 전까지 단정하지 않는다. 7단계 재부팅 검증도 남아 있다.

### 규칙 1-4 확인 — 자동 실행에 제어 명령 없음

| 확인 | 결과 |
|---|---|
| 부팅 시 자동 시작 유닛 | `drone-detect` 하나뿐 |
| `arm_disarm_test` / `takeoff_land` 가 유닛에 포함? | **없음** ✔ |
| `fc_detect.py` 가 보내는 것 | heartbeat 뿐 |
| `linkmon.py` 가 보내는 것 | **없음** (송신 0바이트, `DevicePolicy=closed` 로 시리얼 접근도 차단) |
| 라우터 | 순수 전송 계층 |

## 5단계 — 지상국 연결 (Tailscale) — 확인만, 변경 없음

프롬프트는 "새 장비라 설치와 로그인이 필요할 가능성이 높다"고 봤지만 **이미 끝나 있었다.**
설치·`tailscale up`·옵션 변경 **아무것도 하지 않았다.** 이름도 `pi3` 그대로 두었다(사용자 지시).

| 항목 | 값 |
|---|---|
| 버전 / 유닛 | 1.102.4 / `tailscaled` **enabled + active** (재부팅 후 자동 접속됨) |
| 이 장비 | `pi3` / **`100.85.243.54`** / `pi3.tailcb6bfb.ts.net` |
| BackendState | `Running` |
| 지상국 | `desktop-oaujese` / **`100.125.71.51`** — 온라인 |
| **QGC 접속 주소** | **TCP `100.85.243.54:5760`** |
| 방화벽 | ufw 미설치, nftables inactive, iptables INPUT 정책 `ACCEPT`(tailscale 체인뿐) → **5760 개방 규칙 불필요** |
| MQTT 브로커 후보 | `/etc/drone-node.env` 에 `MQTT_HOST=192.168.50.172`, `MQTT_HOST_TS=100.72.109.9`, `MQTT_PORT=1883` 기록. **이번엔 연결하지 않았다** |

사용자 확인 필요: 지상국에서 `tailscale ping pi3`, QGC 에서 TCP `100.85.243.54:5760`.
(단 QGC 는 `drone.target` 이 떠 있어야 붙는다 = FC 연결이 먼저다.)

참고: `pi7`(MQTT 브로커)은 현재 offline 이다. 다음 작업에서 브로커에 붙을 때 확인이 필요하다.

## 6단계 — 제어 스크립트 (작성만, 실행하지 않음)

`~/drone/scripts/` 에 MAVSDK-Python 으로 작성. 연결 기본값은 `udpin://0.0.0.0:14540` 이고
`--address` 로 바꿀 수 있다. 설치된 mavsdk 3.17.4 가 `udpin://` 형식을 지원하는 것을
확인했으므로 `udp://:14540` 로 낮출 필요가 없었다.

| 파일 | 위험도 | 동작 | 실행 여부 |
|---|---|---|---|
| `telemetry_watch.py` | ★☆☆ 없음 | 위치·고도·자세·배터리·비행모드·arm·GPS/home 상태를 1Hz 출력. **명령 없음** | **실행해도 됨** |
| `arm_disarm_test.py` | ★★☆ 높음 | arm → 3초 → disarm. 이륙하지 않음 | 실행 안 함 |
| `takeoff_land.py` | ★★★ 매우 높음 | 위치 추정 확인 → arm → takeoff 1.5m → 8초 → land → 착륙 확인 | 실행 안 함 |

각 파일 맨 위에 **용도 · 실행 조건 · 위험도**를 주석으로 적었다.

### 안전장치

- 두 위험 스크립트는 `"yes"` 를 **직접 입력**해야 진행한다
- **stdin 이 터미널이 아니면 거부한다** — 자동화·파이프로 실수로 돌아가는 것을 막는다
  (비대화형 실행 시험 → 둘 다 종료 코드 1 로 거부 확인 ✔)
- `takeoff_land.py` 는 `is_global_position_ok` + `is_home_position_ok` 가 아니면 이륙하지 않는다
- 이미 ARM 상태면 두 스크립트 모두 중단한다
- takeoff 실패 시 disarm 시도, land 실패 시 "즉시 조종기로 개입" 경고
- 어느 것도 systemd 유닛에 들어 있지 않다

참고: 설치된 `mavsdk` 패키지가 실행할 때마다 "`mavsdk-grpc` 로 이름이 바뀐다"는
FutureWarning 을 띄운다. 동작에는 문제가 없다. 다음 작업에서 정리할지 결정하면 된다.

## 7단계 — 재부팅 검증 (진행 중)

점검 도구: `~/drone/scripts/step7_check.sh` — sudo 불필요, 읽기 전용.
각 경우가 끝날 때마다 실행해 기대 결과와 대조한다.

### ⚠ 전원 구조 (2026-09-21 사용자 확인) — 검증 방법을 바꾼 이유

**드론 배터리 하나로 FC 와 라즈베리파이가 같이 켜지고 같이 꺼진다. FC 만 따로 끄고 켤 수 없다.**

이 때문에 프롬프트 7단계 표의 "FC 전원 ON/OFF" 를 그대로 할 수 없다.
사용자 지시로 **TELEM 점퍼선을 뽑았다 꽂는 것**으로 대체한다.
FC 입장에서 링크가 끊겼다 붙는 것은 동일하므로 검증 목적은 그대로 달성된다.

중요한 부수 효과: **라즈베리파이가 돌고 있다는 사실 자체가 FC 에도 전원이 들어와 있다는 증거다.**
같은 배터리를 쓰기 때문이다. 따라서 앞선 진단에서 "FC 전원 OFF" 가능성은 완전히 배제된다.

### 진행 순서 (개정)

**D 가 실제 운용 방식(배터리 연결 → 둘 다 부팅)이므로 가장 중요하다.**

| 순서 | 표의 경우 | 실제로 할 일 | 재부팅 |
|---|---|---|---|
| A | 표 2행: FC 없이 부팅 | (완료) 링크 없는 상태로 부팅 | 완료 |
| **C** | 표 4행: 드론 모드 중 링크 차단 | 드론 모드일 때 **TELEM 점퍼선 뽑기** | 불필요 |
| **B** | 표 3행: 나중에 링크 복구 | **점퍼선 다시 꽂기** | 불필요 |
| **D** | 표 1행: FC 연결 상태로 부팅 | 점퍼 꽂힌 채 **배터리로 재부팅** ← **가장 중요** | 필요 |

C → B 순서인 이유: 드론 모드에 먼저 들어가야 "드론 모드 중 차단"을 볼 수 있다.
따라서 링크가 한 번 붙는 것이 C·B·D 모두의 선행 조건이다.

### 전원 상태 점검 (2026-09-21 18:2x)

드론 배터리로 라즈베리파이를 구동하므로 BEC 전압 여유가 중요하다. 결과는 **전부 정상**이다.

| 항목 | 결과 | 판정 |
|---|---|---|
| `vcgencmd get_throttled` | **`0x0`** | ✅ 현재/이력 모두 저전압·스로틀링 **없음** |
| ├ bit0/16 저전압 (현재/이력) | 없음 / 없음 | ✅ |
| ├ bit1/17 주파수 제한 | 없음 / 없음 | ✅ |
| ├ bit2/18 스로틀링 | 없음 / 없음 | ✅ |
| └ bit3/19 온도 제한 | 없음 / 없음 | ✅ |
| `vcgencmd pmic_read_adc EXT5V_V` | **`5.331V`** | ✅ 5V 입력 양호 (저전압 임계 4.63V 대비 충분) |
| `dmesg` under-voltage 경고 | **0건** | ✅ |
| journal 전체 부팅 이력 under-voltage | **0건** | ✅ |
| 3V3_SYS / 1V8_SYS | 3.329V / 1.806V | ✅ 정상 |
| SoC 온도 / 코어 전압 | 43.9°C / 0.880V | ✅ 정상 |

전류: VDD_CORE 0.572A, 3V3_SYS 0.056A, 1V8_SYS 0.119A — 유휴 상태 수준.

**주의**: 이 측정은 **모터가 정지한 상태**의 값이다. 비행 중에는 ESC 부하로 배터리 전압이
떨어져 BEC 출력도 같이 흔들릴 수 있다. 실제 비행 전에 모터를 돌린 상태에서
`vcgencmd get_throttled` 를 다시 확인할 것을 권한다 (0x0 이 아니면 BEC 용량 부족).

### 기대 결과

| 경우 | mode | drone.target | 그 밖에 |
|---|---|---|---|
| A | `none` | inactive | 포트 전부 닫힘, 에러 반복 없음, 재시작 0회 |
| C | `drone` → `none` | active → inactive | 점퍼 뽑고 15초 내 복귀, linkmon 로그에 끊김 기록, 포트 전부 닫힘 |
| B | `none` → `drone` | inactive → active | 점퍼 꽂고 10초 내 감지, 5760/14541/14542 열림, ttyAMA0 점유자 = mavlink-routerd |
| D | `drone` | active | 배터리 연결 부팅만으로 드론 모드, QGC 가 `100.85.243.54:5760` 으로 접속 |

### ⚠ 선행 조건 — FC 배선이 아직 한 번도 검증된 적 없다

3단계에서 GPIO15 풀다운 시험 결과 10번 핀이 떠 있었다(FC TX 신호 없음).
**B 단계가 사실상 첫 실물 링크 시험**이다. B 에서 감지가 안 되면 재부팅을 더 쓰지 말고
먼저 배선을 진단한다:

```sh
cd ~/drone
# 1) 원시 바이트가 들어오는지
./venv/bin/python -c "
import serial,time
s=serial.Serial('/dev/ttyAMA0',921600,timeout=0.2); s.reset_input_buffer()
d=b''; e=time.time()+3
while time.time()<e: d+=s.read(4096)
s.close(); print(len(d),'바이트  0xFD=',d.count(b'\xfd'))"
# 2) 핀이 떠 있는지 (풀다운에서 lo 면 아무것도 안 붙어 있다)
pinctrl set 15 ip pd; sleep 0.3; pinctrl get 15; pinctrl set 15 a4 pu
# 3) 상세 진단
sudo systemctl stop drone-detect      # 포트를 놓게 한다
./venv/bin/python scripts/check_link.py
sudo systemctl start drone-detect
```

### 마지막에 할 것

기준 스냅샷(`~/drone/baseline/`) 대비 **드론 관련 변경 외에 달라진 게 없는지** 확인.
예상되는 차이는 다음 셋뿐이다:
- 부트 설정 2개 (1단계에서 의도적으로 변경)
- enabled 유닛 3개 증가 (`drone-detect`, `drone-mavlink-router`, `drone-linkmon`)
- 드론 모드일 때 포트 5760/14541/14542

### A 단계 결과 (표 2행: FC 없이 부팅) — **통과**

2026-09-21 18:03 재부팅 (부팅 ID `25a99983…`).

| 확인 항목 | 기대 | 실측 | 판정 |
|---|---|---|---|
| `state/mode` | `none` | `none` | ✅ |
| `drone-detect` | active, 대기 | active, **재시작 0회** | ✅ |
| `drone.target` / router / linkmon | 전부 inactive | 전부 inactive | ✅ |
| 포트 5760·14540·14541·14542 | 전부 닫힘 | 전부 닫힘 | ✅ |
| 에러 반복 없음 | — | 이번 부팅 로그 **9줄**, "FC 없음" **1회**, CPU 0.45초 | ✅ |
| 부팅 자동 시작 | `drone-detect` 만 | `drone-detect` 만 (`multi-user.target.wants`) | ✅ |

부팅 후 1초 안에 `drone-detect` 가 떴고(`17:59:32`), 조용히 10초 간격 재시도로 들어갔다.

### B·C·D 단계 — **진행 불가 (FC 가 전기적으로 연결돼 있지 않다)**

사용자가 "드론과 연결된 상태"라고 알려 줘 B 를 시도했으나 감지되지 않았다.
5분 넘게 `mode = none` 이었고, 원인을 좁힌 결과 **라즈베리파이 쪽 문제가 아니다.**

| 진단 | 결과 | 의미 |
|---|---|---|
| `drone-detect` 동작 | 부팅 후 정상 기동, 10초마다 재시도 중 | 감지기는 정상 |
| GPIO14/15 기능 | `TXD0` / `RXD0` | UART 정상 |
| `/dev/ttyAMA0` 점유 | 없음 | 포트 충돌 아님 |
| 원시 바이트 (921600, 3초) | **0바이트** | 신호 자체가 없음 |
| **10번 핀(GPIO15) 풀다운** | **`lo`** | 외부 구동 없음 = 핀이 떠 있다 |
| **8번 핀(GPIO14) 풀다운** | **`lo`** | **TX/RX 바뀜도 아니다** (바뀌었다면 `hi`) |
| USB 시리얼 (`ttyACM*`/`ttyUSB*`) | 없음 | USB 연결도 아님 |
| `lsusb` | 루트 허브 4개뿐 | 연결된 USB 장치 0개 |

두 핀 모두 떠 있고 USB 에도 아무것도 없다 → **FC 가 이 라즈베리파이에 닿아 있지 않다.**
(풀다운 시험은 GPIO 를 잠시 입력으로 두고 읽기만 한다. FC 로 나간 신호는 없고 핀은 원상 복구했다.)

사람이 확인할 것:
1. FC 전원이 실제로 들어와 있는가 (LED 확인)
2. 점퍼선이 **TELEM1** 커넥터에 꽂혀 있는가 (TELEM2 는 Air Unit 자리다)
3. 라즈베리파이 쪽이 40핀 헤더 **8·10·6번**에 정확히 꽂혀 있는가
4. 점퍼선 단선 / 커넥터 헐거움
5. GND(6번 핀) 가 연결돼 있는가 — 없으면 신호가 제대로 전달되지 않는다

### 기준 스냅샷 대조 (A 단계 시점)

| 항목 | 결과 |
|---|---|
| 부트 설정 2개 | **의도적 변경** (1단계) — 예상된 차이 |
| enabled 유닛 | **+3** (`drone-detect`, `drone-mavlink-router`, `drone-linkmon`) — 드론 관련, 사라진 것 **0** |
| 사용자 세션 유닛 | 변화 없음 ✔ |
| NetworkManager 프로파일 | 변화 없음 ✔ |
| IPv4 주소 | `192.168.50.254/24` 동일 ✔ (차이는 DHCP 임대 잔여시간뿐) |
| 방화벽 | ufw 미설치 / nftables inactive — 변화 없음 ✔ |
| 열린 포트 | 드론 포트 0개(FC 미연결이라 정상). 나머지 차이는 avahi·VS Code 가 부팅마다 새로 받는 임시 포트 |

→ **드론 관련 변경 외에 달라진 것이 없다.**

### 2차 진단 (2026-09-21 18:1x, 사용자가 "전원 ON + TELEM1 배선함" 확인 후)

| 시험 | 결과 | 결론 |
|---|---|---|
| 8·10번 핀 풀다운 (안정화 1초) | 둘 다 `lo` | 외부 구동 없음 |
| 원시 바이트 8개 보드레이트 (각 4초) | **합계 0바이트** | 수신 신호 전무 |
| **라즈베리파이 UART 송신 시험** | 송신 전 `hi` 20/20 → **송신 중 `lo` 54/60 (90%)** → 송신 후 `hi` 20/20 | **라즈베리파이 송신 정상** |

송신 시험은 300 baud 로 `0x00` 을 내보내며 GPIO14 전압을 샘플링한 것이다.
`0x00` 은 start bit + 8 data bit 가 전부 LOW 라 이론상 90% 가 LOW 여야 하는데 정확히 54/60 이 나왔다.
(`0x00` 은 MAVLink 시작 바이트 `0xFD`/`0xFE` 가 아니므로 어떤 명령도 되지 않는다.)

→ **UART 주변장치·핀 할당·장치 경로가 모두 정상임이 입증됐다. 1단계 설정은 완전히 성공했다.**
→ 문제는 FC 쪽 또는 점퍼선이다.

### ⚠ 앞선 판단 정정

1차 진단에서 "FC 가 라즈베리파이에 닿아 있지 않다"고 단정했는데 **너무 강한 표현이었다.**
핀이 떠 있는 상태는 세 경우가 모두 같은 모습으로 보인다:

1. 배선 미연결 / 단선 / 다른 커넥터
2. FC 전원 OFF
3. **배선·전원 정상인데 FC 의 TELEM1 UART 가 꺼져 있음**
   — `MAV_0_CONFIG` 가 기본값(Disabled)이면 PX4 가 그 포트를 초기화하지 않아 TX 핀이 high-Z 가 된다

사용자 확인 결과 **전원 ON + TELEM1 배선함** 이므로 1·2 는 배제된다.
**3번(FC 파라미터 미설정)이 가장 유력하다.** 프롬프트에도 FC 파라미터는 사람이 QGC 에서
설정한다고 돼 있고, 사용자는 설정 여부를 모르는 상태다.

### 아직 시험하지 못한 것 — 라즈베리파이 수신 경로

GPIO15 가 풀업/풀다운에 정상 반응하므로 핀 자체는 살아 있지만,
**UART 수신 주변장치 경로는 아직 입증되지 않았다.** 루프백(8번↔10번 점퍼 직결)으로
확인할 수 있으나 FC 배선을 잠시 빼야 한다.

## 다음 단계

1. **FC 파라미터 확인** (가장 유력) — TELEM2 의 Air Unit 으로 QGC 를 무선 연결하면
   배선을 건드리지 않고 확인할 수 있다. `MAV_0_CONFIG=TELEM1`, `MAV_0_MODE=Onboard`,
   `SER_TEL1_BAUD=921600`, `UXRCE_DDS_CFG=0`. **변경 후 FC 재부팅 필요.**
2. 파라미터가 이미 맞다면 → 점퍼선 교체, 그래도 안 되면 루프백 시험으로 라즈베리파이 수신 경로 확인
3. 링크가 붙으면 → 3단계 `check_link.py` 통과 확인 → B·C·D 단계
4. **FC 배선·전원 확인** (1차 진단 목록) → B·C·D 단계
   - FC 가 붙으면 재부팅 없이 B(전원 ON)·C(전원 OFF)를 바로 확인할 수 있고,
     D(FC 연결 상태로 부팅)만 재부팅 1회가 필요하다
2. 3단계 통과 확인 (`check_link.py` 로 FC 파라미터까지 읽기)
3. 8단계 `SETUP_REPORT.md` 작성

---

## 배선 정정 — 라즈베리파이는 TELEM1 이 아니라 **TELEM2** 였다 (2026-09-21 19:xx)

### 무엇이 틀렸나

프롬프트와 이 문서는 처음부터 **라즈베리파이 = TELEM1, Air Unit = TELEM2** 로 적혀 있었다.
실제는 정반대였다.

| | 실제 배선 | FC 포트 | MAVLink 인스턴스 | 보드레이트 |
|---|---|---|---|---|
| 라즈베리파이 GPIO14/15 | **TELEM2** | `/dev/ttyS3` | `MAV_1_*` | 921600 |
| 무선 Air Unit | **TELEM1** | `/dev/ttyS1` | `MAV_0_*` | 57600 |

3단계에서 신호가 하나도 안 잡힌 진짜 이유: 라즈베리파이 선이 꽂힌 **TELEM2 는 FC 에서
설정이 꺼져 있었다**. PX4 는 설정되지 않은 포트를 초기화하지 않아 TX 핀이 high-Z 로 남는다.
앞선 진단에서 "핀이 떠 있다"고 본 것이 정확히 이 상태였다.
(라즈베리파이 쪽 UART·핀 할당·장치 경로는 처음부터 정상이었다. 2차 진단의 송신 시험이 옳았다.)

### 사용자가 FC 에 한 조치

`MAV_1_CONFIG=102(TELEM2)`, `MAV_1_MODE=2(Onboard)`, `SER_TEL2_BAUD=921600` 설정 후 FC 재부팅.

### 라즈베리파이 쪽 검증 결과 — **전부 통과**

| 시험 | 이전 (정정 전) | 이번 | 판정 |
|---|---|---|---|
| **GPIO15(10번 핀) 풀다운 60회** | `lo` 100% (핀이 떠 있음) | **`hi` 56 / `lo` 4 (93%)** | ✅ FC TX 가 선을 구동 중 |
| `drone-detect` 자동 감지 | FC 없음 반복 | **19:13:33 heartbeat 수신 → `drone.target` 시작** | ✅ |
| `state/mode` | `none` | **`drone`** | ✅ |
| linkmon 수신량 | 0 | **60초당 약 19,080건 / 22~23종, ATTITUDE 99.9Hz** | ✅ |
| 3단계 `check_link.py` | 실패 | **성공 (종료 코드 0)** | ✅ |

풀다운에서 `hi` 93% 는 UART idle-high 에 데이터 구간의 LOW 가 섞인 정확한 모습이다
(921600 baud 에서 초당 13KB ≈ 14% duty). 시험 후 핀은 `a4 pu` 로 복구했다.

### 라즈베리파이 TX(8번 핀) → FC RX 방향도 정상 — rx=0 걱정은 해소

`check_link.py` 가 `PARAM_REQUEST_READ` 로 FC 파라미터 7개를 **실제로 읽어 왔다.**
요청이 FC 에 닿지 않으면 값이 하나도 돌아오지 않는다. 따라서 **8번 핀 → FC RX 방향은 정상**이다.
FC 콘솔에서 본 rx=0 은 그 시점에 라즈베리파이가 아직 아무것도 보내지 않고 있었기 때문이다
(`drone-detect` 와 `drone-linkmon` 은 읽기 전용이라 평소 송신이 거의 없다).

### 3단계 최종 판정 (2026-09-21 19:2x, `--device udpin:0.0.0.0:14540` 라우터 경유)

```
✔ 라즈베리파이 링크 = MAVLink 인스턴스 1 on TELEM2, Onboard 모드
✔ Air Unit 링크 = MAVLink 인스턴스 0 on TELEM1 (모드 0 (Normal), 보드레이트 57600) — 건드리지 않음
✔ UXRCE_DDS_CFG = 0 (Disabled) — 예정대로
통과 기준: heartbeat 수신 ✔ / ATTITUDE 수신 ✔ → 종료 코드 0
```

| 파라미터 | 값 |
|---|---|
| `MAV_0_CONFIG` / `MAV_0_MODE` / `SER_TEL1_BAUD` | 101 (TELEM 1) / 0 (Normal) / 57600 — Air Unit, 유지 |
| `MAV_1_CONFIG` / `MAV_1_MODE` / `SER_TEL2_BAUD` | **102 (TELEM 2) / 2 (Onboard) / 921600** — 라즈베리파이 |
| `UXRCE_DDS_CFG` | 0 (Disabled) |

heartbeat: PX4, MAV_TYPE_QUADROTOR, DISARMED, AUTO.LOITER, sysid/compid = 1/1.
**FC 파라미터는 읽기만 했다. 하나도 쓰지 않았다.**

### 고친 파일

| 파일 | 내용 | 백업 |
|---|---|---|
| `scripts/check_link.py` | 배선 상수(`PI_PORT=102`, `AIR_UNIT_PORT=101`) 도입, `judge_instances()` 재작성, 기대값 표·실패 힌트 반전 | `.bak.20260921` |
| `config/mavlink-router.conf` | `[UartEndpoint fc]` 주석 TELEM1 → TELEM2 | `.bak.20260921` |
| `systemd/drone-mavlink-router.service` | Description TELEM1 → TELEM2 | `.bak.20260921` |
| `STEP0_REPORT_pi3.md` | 배선·FC 파라미터 기준 반전 | `.bak.20260921` |
| `PROGRESS.md` | 현재 사실 기술 반전 + 이 절 추가 | `.bak.20260921` |

**`check_link.py` 판정 방식**: 인스턴스 번호를 고정하지 않는다. `MAV_x_CONFIG` 값을 훑어
**TELEM2(102) 에 배정된 인스턴스를 라즈베리파이 링크로 판정**하고, TELEM1(101) 쪽을 Air Unit 으로
본다. 사람이 QGC 에서 인스턴스를 바꿔 잡아도 판정이 따라간다.

**`read_params()` 재요청 추가**: 링크에 300Hz 넘게 텔레메트리가 흐르면 `PARAM_VALUE` 응답이
타임아웃 뒤로 밀린다. 실제로 첫 실행에서 `MAV_0_CONFIG` 를 놓쳐 "TELEM1 에 인스턴스가 없다" 는
잘못된 경고가 나왔다. 놓친 것만 최대 3회 다시 요청하도록 고쳤고, 재실행에서 전부 읽혔다.

### 이력은 지우지 않았다

이 문서 앞쪽 3단계 진단 기록은 **그 시점의 판단 그대로** 두고 정정 표시만 붙였다.
틀린 전제에서 무엇을 어떻게 좁혀 갔는지가 남아 있어야 하기 때문이다.
`archive/pi7/` 와 `config/drone.env.superseded.20260921` 도 보관 목적이라 건드리지 않았다.

### ⚠ 아직 못 고친 것 — sudo 가 필요하다

에이전트 세션에서 `sudo` 와 polkit 이 모두 대화형 인증을 요구해 아래 두 줄을 고치지 못했다.
**둘 다 주석 한 줄이고 동작에는 영향이 없다.** 사람이 고쳐야 한다.

```sh
sudo sed -i 's|# ── FC 연결 (TELEM1 ↔ GPIO14/15)|# ── FC 연결 (TELEM2 ↔ GPIO14/15)|' /etc/drone-node.env
sudo sed -i 's|# 드론 FC(TELEM1) 연결용|# 드론 FC(TELEM2) 연결용|' /boot/firmware/config.txt
```

`/etc/drone-node.env` 는 `config/drone.env` 가 가리키는 실제 파일이다.
`/boot/firmware/config.txt` 55번 줄 주석은 `dtparam=uart0=on` 의 설명일 뿐이라 부팅에 영향이 없다.

같은 이유로 3단계 검증을 `sudo systemctl stop drone-detect` → 시리얼 직접 접속 순서로 하지 못하고,
`check_link.py` 에 원래 준비돼 있던 **라우터 경유 경로**(`--device udpin:0.0.0.0:14540`)로 했다.
이 경로도 같은 `/dev/ttyAMA0` 시리얼 링크를 지나므로 검증 내용은 같고,
오히려 `mavlink-router` 까지 포함해 확인한 셈이다.

---

## 7단계 C·B — **통과** (2026-09-21 19:27~19:28, 점퍼선 없이)

### 점퍼선 대신 GPIO15 를 UART 에서 떼어냈다

사용자가 점퍼선을 임의로 뽑을 수 없어, **`pinctrl` 로 GPIO15(수신 핀)를 UART 기능(`a4`)에서
일반 입력(`ip pd`)으로 잠시 떼어내는 방식**으로 대체했다. 도구: `scripts/step7_cb_gpio.sh`.

- 배선과 FC 는 그대로다. 라즈베리파이 쪽 **수신만 0** 이 된다
- `drone-detect` 가 보는 것(heartbeat 끊김)은 점퍼를 뽑았을 때와 완전히 같다
- GPIO15 는 입력 핀이라 FC 로 아무것도 내보내지 않는다. GPIO14(TX) 는 건드리지 않았다
- `trap` 으로 어떤 경로로 끝나든 `a4 pu` 로 복구한다
- 실행 전 기체가 **DISARMED** 임을 heartbeat 로 확인했다

### 결과

| 단계 | 조작 | 기대 | 실측 | 판정 |
|---|---|---|---|---|
| **C** | GPIO15 떼어냄 (19:27:41) | 15초 내 `mode=none`, 포트 전부 닫힘 | **15초** 만에 `mode=none`, 5760·14541·14542 **전부 닫힘**, target/router/linkmon 전부 inactive | ✅ |
| **B** | GPIO15 복구 (19:27:59) | 10초 내 `mode=drone`, 포트 열림 | **9초** 만에 `mode=drone`, 포트 3개 **전부 열림**, `/dev/ttyAMA0` 점유자 = `mavlink-routerd` | ✅ |

`drone-detect` 재시작 0회. 핀 최종 상태 `15: a4 pu | hi // GPIO15 = RXD0` — 원상 복구됐다.

### 로그 대조

```
linkmon   19:27:55  링크 끊김 — heartbeat 가 15.0초 이상 없다
          19:27:56  linkmon 종료
          19:28:08  링크 복구 — FC heartbeat 수신 (sysid=1 compid=1)
detect    19:27:56  [감시] heartbeat 가 15.0초 끊겼다 — 드론 모드를 내린다
          19:27:56  [systemd] stop drone.target ✔ / [상태] mode = none
          19:28:06  [감지] FC heartbeat 수신 — /dev/ttyAMA0 @ 921600
          19:28:08  [systemd] start drone.target ✔ / [상태] mode = drone
```

C 기대 결과의 "linkmon 로그에 끊김 기록" 까지 그대로 남았다.

### 설계대로 동작한 방어 장치 하나

`19:27:56` 에 `drone.target` 을 내린 직후 첫 감지 시도에서:

```
[감지] /dev/ttyAMA0 를 다른 프로세스가 잡고 있다: [('1267', 'mavlink-routerd')] — 건너뛴다
```

라우터가 아직 포트를 놓기 전이라 **감지를 건너뛰었다.** 포트를 다투지 않도록 만든 장치가
실제로 작동한 것이고, 10초 뒤 재시도에서 정상 감지했다. 복구는 9초로 기대치(10초) 안이다.

### 남은 것 — D (배터리 연결 → 둘 다 부팅)

**사용자 지시에 따라 D 는 승인 전까지 하지 않는다.** 실제 운용 방식이라 가장 중요한 경우다.
D 는 재부팅이 필요하고, 배터리 하나로 FC 와 라즈베리파이가 같이 켜지므로
전원을 넣는 것만으로 검증된다. 부팅 후 `scripts/step7_check.sh` 로 대조하면 된다.

기대: `mode=drone`, `drone.target` active, QGC 가 `100.85.243.54:5760` 으로 접속.

---

## sudo 필요 항목 처리 완료 (2026-09-21 19:3x)

사용자가 `sudo -v` 로 인증을 캐시해 줘 앞서 못 고친 주석 2줄을 고쳤다. **둘 다 주석이다.**

| 파일 | 변경 | 백업 |
|---|---|---|
| `/etc/drone-node.env` 6행 | `# ── FC 연결 (TELEM1 ↔ GPIO14/15)` → **TELEM2** | `/etc/drone-node.env.bak.20260921` |
| `/boot/firmware/config.txt` 55행 | `# 드론 FC(TELEM1) 연결용 …` → **TELEM2** | `/boot/firmware/config.txt.bak.20260921` |

`diff` 로 두 파일 모두 **1줄만** 바뀐 것을 확인했다. 설정값·`dtparam=uart0=on` 은 그대로다.
→ **TELEM1/TELEM2 표기 정정이 문서·코드·설정 전체에서 끝났다.**

`config.txt` 해시가 1단계 기록(`9f1bb0b7d7…`)에서 바뀐 이유가 이 주석 수정이다.
현재 해시: `bc47abb65d119df9…`

### 기준 스냅샷 대조 (재부팅 직전)

| 항목 | 결과 |
|---|---|
| enabled 유닛 | **+3** (`drone-detect`, `drone-linkmon`, `drone-mavlink-router`) — 사라진 것 0 |
| IPv4 | `192.168.50.254/24` (wlan0), `100.85.243.54/32` (tailscale0) — 동일 |
| 부트 설정 2개 | 1단계 의도적 변경 + 위 주석 수정 — 예상된 차이 |

→ 드론 관련 변경 외에 달라진 것이 없다.

---

## D 단계 — 재부팅 검증 (승인받고 진행, 2026-09-21 19:3x)

### 재부팅 전 상태 (이 기록이 재부팅 후 비교 기준이다)

```
mode=drone / drone-detect active(재시작 0회) / drone.target active
router active / linkmon active / 포트 5760·14541·14542 열림
GPIO14=TXD0, GPIO15=RXD0 / /dev/ttyAMA0 점유 1 (mavlink-routerd)
```

### ⚠ 배터리 재부팅이 아니라 `sudo reboot` 다 — 차이를 적어 둔다

원래 D 는 "배터리 연결 부팅"이다. 사용자가 배선·배터리를 물리적으로 조작할 수 없어
**소프트웨어 재부팅(`sudo shutdown -r`)** 으로 한다. 차이는 다음과 같다.

| | 배터리 부팅 | `sudo reboot` (이번) |
|---|---|---|
| FC | 라즈베리파이와 **동시에** 기동 | **계속 켜진 채** 유지 |
| 부팅 시점의 링크 | FC 부팅이 늦으면 heartbeat 가 아직 없다 | heartbeat 가 이미 흐르고 있다 |
| 검증되는 것 | "FC 가 늦게 떠도 붙는가" + "FC 연결 상태로 부팅" | **"FC 연결 상태로 부팅"** |

빠진 쪽("FC 가 늦게 떠도 붙는가")은 **B 단계에서 이미 통과**했다
(링크가 없는 상태에서 10초 간격 재시도 → 9초 만에 감지). 따라서 두 단계를 합치면
배터리 부팅에서 일어날 수 있는 경우가 모두 덮인다.
다만 **배터리 한 번으로 둘 다 켜지는 실물 상황 자체는 아직 확인되지 않았다.**
사람이 배터리를 넣을 기회가 있을 때 `scripts/step7_check.sh` 한 번이면 확인된다.

### 재부팅 후 할 일

1. `cd ~/drone && bash scripts/step7_check.sh`
   - 기대: `mode=drone`, `drone-detect` active(재시작 0회), `drone.target` active,
     포트 5760·14541·14542 열림, `/dev/ttyAMA0` 점유 1
2. `journalctl -u drone-detect -b --no-pager` 로 부팅 후 몇 초 만에 감지했는지 확인
3. 기준 스냅샷 대조 (위 표와 같은 항목)
4. 지상국에서 QGC 로 `100.85.243.54:5760` (TCP) 접속 — **사람이 확인**
5. 통과하면 8단계 `SETUP_REPORT.md` 작성

### 세션이 끊긴다

이 에이전트는 VS Code Remote SSH 로 라즈베리파이에 붙어 있어 재부팅과 함께 끊긴다.
부팅 과정은 journal 에 남으므로 재접속 후 위 1~3 으로 전부 재구성할 수 있다.

### D 단계 결과 — **통과** (2026-09-21 19:32 재부팅, 부팅 ID `a2e7088e…`)

부팅 `19:32:30` → `drone-detect` 기동 `19:32:37` → **heartbeat 감지 `19:32:38`** →
`drone.target` 시작 `19:32:40`. **부팅 후 10초 만에 완전한 드론 모드**가 됐다.

| 확인 항목 | 기대 | 실측 | 판정 |
|---|---|---|---|
| `state/mode` | `drone` | `drone` | ✅ |
| `drone-detect` | active | active, **재시작 0회** | ✅ |
| `drone.target` / router / linkmon | 전부 active | 전부 active | ✅ |
| 포트 5760·14541·14542 | 열림 | 전부 열림 (14540 은 MAVSDK 자리라 닫힘이 정상) | ✅ |
| `/dev/ttyAMA0` 점유 | `mavlink-routerd` 1개 | 1개 | ✅ |
| GPIO14/15 | `TXD0` / `RXD0` | `TXD0` / `RXD0` | ✅ |
| 감지 소요 | — | 서비스 기동 후 **1초** | ✅ |
| 에러 반복 | 없음 | 이번 부팅 로그 **13줄**, CPU 1.87초 | ✅ |
| 수신 품질 | — | 60초당 **19,015건 / 22종**, ATTITUDE 99.6Hz | ✅ |

주석 수정 후의 `config.txt` 로 정상 부팅했고 UART 도 그대로 잡혔다.

### 기준 스냅샷 최종 대조 (재부팅 후)

| 항목 | 결과 |
|---|---|
| enabled 유닛 | **+3** (드론 유닛). 사라진 것 **0** | 
| 부팅 자동 시작 | `multi-user.target.wants` 에 **`drone-detect.service` 만** | 
| `drone.target` 소속 | `drone-linkmon`, `drone-mavlink-router` 둘뿐 | 
| IPv4 | `192.168.50.254/24`, `100.85.243.54/32` — 동일 | 
| Tailscale | `pi3` = `100.85.243.54` 정상, 지상국 `desktop-oaujese` = `100.125.71.51` 보임 | 
| 방화벽 | ufw 미설치, nftables 는 Tailscale 자체 체인뿐 — 변화 없음 | 
| 시리얼 장치 | `/dev/serial0 -> ttyAMA10`(디버그), `/dev/ttyAMA0`(FC) — 동일 | 
| 드론 외 포트 | ssh(22), avahi(5353), Tailscale(41641), VS Code 임시 포트 — 부팅마다 바뀌는 것뿐 | 

→ **드론 관련 변경 외에 달라진 것이 없다.**

### 7단계 종합

| 경우 | 방법 | 결과 |
|---|---|---|
| **A** FC 없이 부팅 | 링크 없는 상태로 부팅 | ✅ `mode=none`, 조용히 재시도, 재시작 0회 |
| **C** 드론 모드 중 링크 차단 | GPIO15 를 UART 에서 떼어냄 | ✅ **15초** 만에 `none`, 포트 전부 닫힘 |
| **B** 링크 복구 | GPIO15 복구 | ✅ **9초** 만에 `drone`, 포트 전부 열림 |
| **D** 연결 상태로 부팅 | `sudo reboot` | ✅ **10초** 만에 `drone` |

**남은 것**: 지상국 QGC 에서 TCP `100.85.243.54:5760` 접속 확인 (사람), 그리고
배터리 한 번으로 FC·라즈베리파이가 같이 켜지는 실물 상황 확인 (사람, 기회 될 때).

---

## 8단계 — 보고서 작성 완료 (2026-09-21)

`~/drone/SETUP_REPORT.md` 작성. 프롬프트 8단계 요구 항목을 전부 담았다:
하드웨어·OS / 바꾼 시스템 설정과 백업 경로 / 설치 패키지와 버전 / 만든 파일과 유닛 /
FC 장치 경로와 연결 확인 결과 / 자동 실행 검증(7단계 표) / Tailscale 주소 /
해결 못 한 문제와 사람이 확인할 것.

**작업 범위(0~8단계)가 끝났다.** 남은 것은 사람이 해야 하는 확인 2가지뿐이다
(QGC 접속, 기체 기울일 때 ATTITUDE 반응). 다음 작업은 MQTT 브리지다.

---

## 사람 확인 2가지 완료 (2026-09-21 19:4x) — **작업 전체 종료**

| 확인 | 결과 |
|---|---|
| QGroundControl TCP `100.85.243.54:5760` 접속 | ✅ 사용자 확인 |
| 기체 기울임에 ATTITUDE 반응 | ✅ roll 변화폭 **173.2도**, pitch **121.6도** |

`scripts/attitude_watch.py` 를 새로 만들어 측정했다 (읽기 전용, FC 로 송신 0바이트,
heartbeat 조차 보내지 않는다 — 라우터가 이미 받고 있는 스트림을 읽기만 한다).

정지 상태 기준선은 roll 약 1.6도 / pitch 약 -0.8도에서 변화폭 1도 미만(센서 노이즈)이었고,
기울이자 즉시 따라왔으며, 내려놓자 roll 0.16 / pitch 1.58 에서 **0.05도 이내로 안정**됐다.
드리프트나 튐이 없다 — **자세 추정(EKF)까지 정상**이다.
측정 중 ATTITUDE 5,000건 이상을 누락 없이 받았다.

yaw 는 판정 기준에서 제외했다. 정지 상태에서도 2도가량 흔들리는데 자력계 특성상 정상이다.

→ **0~8단계와 사람 확인까지 전부 끝났다. 다음 작업은 MQTT 브리지다.**

---

# MQTT 가시화 브리지 (2026-09-21 20:xx~) — Go1(pi7) 과 같은 방식

목표: 가시화 웹이 pi3 의 브로커에 직접 붙어 **연결 상태·배터리·드론 상태**를 본다.
제어 명령은 범위 밖이다. 브리지는 FC 로 **0바이트**를 보낸다(읽기 전용).
0단계 조사 결과는 `~/drone/STEP0_REPORT_bridge.md`, 계약은 `~/drone/CONTRACT_x500.md`.

## mavlink-router 설정 변경 — 엔드포인트 1개 추가 (규칙 4)

`~/drone/config/mavlink-router.conf` (라우터가 실제로 읽는 파일).
백업: `config/mavlink-router.conf.bak.before-bridge-14543`.

**전** — UDP 엔드포인트 3개

```
[UdpEndpoint local_ctrl]  127.0.0.1:14540   # MAVSDK 제어 자리
[UdpEndpoint linkmon]     127.0.0.1:14541   # drone-linkmon
[UdpEndpoint detect]      127.0.0.1:14542   # drone-detect
```

**후** — 4개 (아래 블록을 파일 끝에 추가. 기존 3개와 [General]·[UartEndpoint fc] 는 무수정)

```
[UdpEndpoint bridge]
# drone-node.service(가시화 브리지) 전용. 읽기만 한다 — 브리지는 FC 로 0바이트를 보낸다.
# 14540 은 MAVSDK 제어 코드 자리라 쓰지 않는다 (2026-09-21 브리지 작업에서 추가).
Mode = Normal
Address = 127.0.0.1
Port = 14543
```

14540 을 그대로 두는 이유: 나중에 붙일 제어 코드(MAVSDK)의 자리다. 브리지가 그 포트를
쓰면 제어 코드를 붙일 때 포트를 다투게 된다.

반영 시점: 라우터는 드론 모드일 때만 뜬다. 지금은 FC 링크가 없어 라우터가 내려가 있으므로
**다음에 drone.target 이 뜰 때 자동으로 새 설정으로 시작한다** (별도 재시작 불필요).

## FC 링크 없음 상태에서 작업 중 (2026-09-21 20:20~)

브리지 조사 중 FC heartbeat 가 끊기고 `drone-detect` 가 감지 모드로 복귀했다
(`state/mode` = `none`). **사용자가 이 작업에 기체가 필요 없다고 보고 드론과의 연결을
일부러 해제한 것이다 — 지금은 라즈베리파이만 따로 전원을 받고 있다.** 장애가 아니다.

오히려 이 상태가 3단계 요구("라우터가 없어도 노드는 떠 있어야 하고, 웹이 'FC 링크만
없다'를 구분할 수 있어야 한다")를 검증하기에 맞는 조건이다. 1~3단계는 이 상태로 전부
확인하고, **배터리 전압·자세 실값 대조와 링크 끊김/복구 전환(5단계)만 기체 재연결 후로
미룬다.**

끊기기 직전 실측값(참고): 15.75V / 74% / 전류 12.2A / 누적 소모 891mAh.
디스암 상태에서 12.2A 는 과대로 보여 **배터리 모니터 전류 스케일을 의심**하고 있다.
전압·잔량은 MAVSDK 값과 일치했다. 계약 문서에서 전류는 참고값으로 표시한다.

## 1단계 — 브로커 (2026-09-21 20:42) ✅

`mosquitto 2.0.21-1` + `mosquitto-clients` 설치(apt). 설정은 Go1(pi7)의 `hw.conf` 와 같은 내용:
`~/drone/config/mosquitto-hw.conf` → `/etc/mosquitto/conf.d/hw.conf`.

```
listener 1883 0.0.0.0      # 말단·백엔드·도구
allow_anonymous true       # 폐쇄망 전제. TLS/인증은 BE-T-01 준비 후
listener 9001 0.0.0.0      # 브라우저(MQTT over WebSocket)
protocol websockets
max_keepalive 300
```

`systemctl enable --now mosquitto` → `active` / `enabled`.

| 확인 | 결과 |
|---|---|
| 포트 | `ss -tlnp` 에 `0.0.0.0:1883`, `0.0.0.0:9001` ✅ |
| 1883 왕복 | MQTT 3.1.1 ✅ / MQTT 5.0 ✅ (`mosquitto_pub`→`mosquitto_sub`) |
| 9001 | `101 Switching Protocols` + `Sec-WebSocket-Protocol: mqtt` ✅ |
| 주소 3개 | `pi3.local`(→192.168.50.254) ✅ / `192.168.50.254` ✅ / `100.85.243.54` ✅ |

## 2단계 — 드론 어댑터 (2026-09-21 20:43) ✅

**공통 틀(`~/hw/pi/common/`)을 한 줄도 고치지 않았다. `.proto` 도 무수정.** 새 파일만 추가했다.

| 새 파일 | 역할 |
|---|---|
| `~/hw/pi/drone/drone_link.py` | 14543 구독 전용 링크. `Go1Link` 자리 |
| `~/hw/pi/drone/drone_node.py` | `BaseNode` 상속. `ACTIONS={"ping"}` 만 |
| `~/hw/pi/drone/__init__.py` | 패키지 표시(빈 파일) |

`RobotNode` 를 상속하지 않은 이유: `RobotState`(battery_pct·x·y·heading_deg·speed_mps·mode)에
전압·GPS fix·arm·비행모드를 담을 칸이 없다. `BaseNode` 를 직접 상속하면 공통 생애주기
(LWT·Capability·멱등·UNIMPLEMENTED·spool·재접속)를 전부 재사용하면서 필드는 자유롭다.

`ACTIONS` 를 `BASE_ACTIONS` 로 시작하지 않는다 — 공통 어휘에는 `diag` 가 같이 들어 있어서
그대로 쓰면 Capability 에 두 개가 실린다. 어댑터에서 어휘를 직접 정의해 `ping` 하나만 남겼다.

재사용한 pi3 자산: `scripts/dronelink.py` 의 `is_vehicle_heartbeat()`,
`scripts/check_link.py` 의 `decode_px4_custom_mode()`. 다시 짜지 않았다.

### 설정 파일

| 파일 | 변경 | 백업 |
|---|---|---|
| `/etc/hw-node.env` | 신규. `HW_BROKER_HOST=127.0.0.1`, `HW_ZONE_ID=zoneA` | — |
| `/etc/hw-drone.env` | 신규. `HW_ENTITY_ID=x500-001`, `HW_ENTITY_TYPE=drone`, `HW_DEVICE_TYPE=x500_drone`, `HW_DRONE_UDP_PORT=14543`, 주기 4개 | — |
| `/etc/zone_id` | 신규. `zoneA` (pi7 과 같은 구역) | — |
| `/etc/drone-node.env` | `MQTT_HOST` 192.168.50.172(pi7) → **127.0.0.1**. pi7 값은 주석으로 남김 | `/etc/drone-node.env.bak.before-bridge` |

원본은 전부 `~/drone/config/` 에 둔다(사본이 아니라 설치원).

⚠ **함정 하나**: systemd `EnvironmentFile` 은 값 뒤 주석을 잘라 주지 않는다.
`HW_DRONE_STATE_INTERVAL=1.0   # 1Hz` 로 쓰면 주석까지 값이 된다. 설명은 윗줄로 올렸다.

## 3단계 — 자동 실행 (2026-09-21 20:43) ✅

`~/drone/systemd/drone-node.service` → `/etc/systemd/system/`. `enable --now` → `active`/`enabled`.

**`drone.target` 소속이 아니다**(`PartOf=` 비어 있음, `WantedBy=multi-user.target`).
라우터는 드론 모드일 때만 뜨지만 노드는 FC 가 없어도 떠 있어야 하고, 웹이 "브로커는 붙었고
드론 노드도 답하는데 FC 링크만 없다"를 구분할 수 있어야 하기 때문이다.
FC 유무는 14543 수신 공백 + `~/drone/state/mode` 로 노드가 스스로 판정한다.

제어 명령이 없음을 두 겹으로 확인했다:

| 확인 | 결과 |
|---|---|
| 코드 — `mav.send`/`command_long`/`set_mode`/`param_set`/스트림 요청 호출 | **0건** (주석·문서 문자열에만 등장) |
| `mavutil` 사용처 | `mavlink_connection(udpin:…)` 과 `MAV_MODE_FLAG_SAFETY_ARMED` 상수 둘뿐 |
| 유닛 | `DevicePolicy=closed` — **시리얼 장치를 열 수조차 없다.** `ProtectSystem=strict`, `NoNewPrivileges=yes` |
| 런타임 | `status.tx_bytes = 0` (pymavlink `total_bytes_sent`) |

### 실측 검증 (FC 분리 상태)

| 확인 | 결과 |
|---|---|
| 노드 기동 | `entity=x500-001 node=pi3 zone=zoneA type=drone`, `[접속] 127.0.0.1:1883` ✅ |
| Capability | `capability{device_id:"x500-001", actions:["ping"]}` 18B ✅ |
| `ping` | `acceptance(true)` → `status(EXECUTING)`×2 → `result{SUCCEEDED, uptime_s, fc_link=0}` ✅ |
| 미선언 `arm` | `acceptance{UNIMPLEMENTED, "action not supported"}`, `result` 없음 ✅ |
| 상태 주기 | `state` 1Hz, `heartbeat` 5초, `status` 10초 retained ✅ |
| FC 없음 표현 | `fc_link:false`, battery·flight·gps·attitude 전부 `null` ✅ (마지막 값 재사용 안 함) |
| 급사(LWT) | SIGKILL → 브로커가 `event:death, status:offline, device_status:fault, reason:lwt` 발행 → 3초 뒤 자동 재시작 `birth` ✅ |

## 4단계 — 계약 문서 (2026-09-21 20:48) ✅

`~/drone/CONTRACT_x500.md`. 실제 캡처한 페이로드만 적었다. 상태 토픽 전체 패턴
`{zone}/{entity_type}/{entity_id}/{channel}` 과 **"구독자는 entity_type 자리를 `+` 로 받아야
한다"** 를 명시했고, 확인하지 못한 항목(값이 채워진 battery/flight/gps/attitude)은 §9 에
따로 모아 정직하게 표시했다.

**남은 것은 5단계 검증이다. 기체 재연결이 필요하다.**

## 4-1단계 — 백엔드 회신 반영 (2026-09-21 21:06) ✅

5단계 실물 검증 전에 백엔드가 요구한 셋을 확인하고 계약 문서에 반영했다.

### ① 공통 헤더 5필드 — **공통 틀이 전부 채운다. 어댑터는 손대지 않는다**

백엔드 필수 검사 대상 `schema_version`·`source_id`·`node_id`·`zone_id`·`timestamp` 는
`common/schema.py:envelope()` 한 함수가 만든다. `drone_node._publish_state()` 는 그 결과에
본문만 덧쓴다(`payload.update(...)`). 덧쓰는 키(`channel`·`reason`·`device_status`·`link`
+ 스냅샷 10키)와 헤더 5필드는 **이름이 겹치지 않는다** — 덮어쓸 경로가 없다.

라이브 캡처로 재확인(21:05, 21:06): 다섯 필드 모두 존재. 빠진 것 없음.

| 필드 | 출처 | 빌 수 있나 |
|---|---|---|
| `source_id` | `HW_ENTITY_ID`(`/etc/hw-drone.env`) → `/etc/device_id` | **둘 다 없으면 기동 실패**(SystemExit) — 빈 값 발행 경로 없음 |
| `node_id` | `HW_NODE_ID` → `/etc/node_id`(없음) → **hostname `pi3`** | 최후 수단이 hostname 이라 항상 채워진다 |
| `zone_id` | `HW_ZONE_ID=zoneA` → `/etc/zone_id`(`zoneA`) → 기본값 | 항상 |
| `schema_version` | 코드 상수 `"1.1"` | 항상 |
| `timestamp` | 발행 직전 생성. RFC3339 ms + `+09:00` | 항상 |

`status`·`heartbeat` 도 같은 `envelope()` 를 쓴다(`node.py:92,200,234`). 채널 3개 전부 동일.

### ② `CONTRACT_x500.md` §13 "백엔드 규격용" 추가

`state.drone.schema.json` 을 이 절만 보고 쓸 수 있게 만들었다.
- 공통 헤더 5필드 + `session_id`·`sequence_id` 의 타입·필수 여부·출처
- `state` 본문 최상위 표 — 타입 / 단위 / 필수 / 없을 때 / **FC 링크 없을 때** 열
- 중첩 객체(`battery`·`flight`·`gps`·`attitude`·`altitude`·`warnings[]`) 키별 타입
- `reason` 어휘 6개 (Go1 의 `periodic`·`mode_changed`·`battery_low` 포함 + 드론 고유
  `fc_link_lost`·`fc_link_up`·`armed_changed`)
- 실제 발행된 `state` 1건 원문(21:06:50.795, seq 173)

**핵심 규칙 하나를 명시했다: 키는 항상 있고 값이 `null` 이다.** FC 가 없어도 `battery` 키는
사라지지 않는다 → 스키마에서 전부 `required`, 타입 쪽에서 `null` 허용.
반대로 규약(protobuf) `ping` 응답의 `result` 는 **키가 빠진다**(map<string,double>).
두 평면의 결측 표현이 다르다는 것도 같이 적었다.

### ③ `ping` 응답의 FC 링크 — **실려 온다** (재확인)

새 `command_id`(`be-ping-1`)로 다시 왕복시켰다. 응답 4건, 마지막 `result`:
`{uptime_s: 688.5, fc_link: 0}` — `fc_link` 키는 **링크 유무와 무관하게 항상 실린다**(1.0/0.0).
`fc_link_age_s` 는 이번에도 없었다(이 세션에서 FC heartbeat 를 한 번도 못 받음 = 결측 규칙).
가시화의 "FC 링크" 줄은 `fc_link` 를 보고, `fc_link_age_s` 는 있을 때만 덧붙이면 된다.
계약 §5 에 이 캡처를 "5단계 재확인" 으로 추가했다.

---

## 2026-09-22 — 감지기가 못 잡던 고장 보완 (시리얼 포트 영구 점유)

### 무엇이 문제였나

`scripts/fc_detect.py` 의 `probe_serial()` 은 `/dev/ttyAMA0` 을 누가 잡고 있으면
`skip()` 으로 건너뛰기만 했다. 메인 루프는 `DETECT_INTERVAL`(10초) 뒤 똑같이
재시도한다. **에스컬레이션이 없어서 점유자가 스스로 죽지 않으면 영원히 맴돈다.**

- FC 가 물리적으로 정상인데도 `mode=none` 에서 못 빠져나온다
- 웹은 `fc_link:false`, `router_mode:"none"` 을 정확히 보긴 하지만, **복구가 안 된다**
- 사람이 SSH 로 들어가 점유자를 죽여야 했다 — 자동 복구 설계의 유일한 구멍

실제로 걸릴 수 있는 경로:

1. `mavlink-routerd` 가 `systemctl stop` 에 안 죽고 fd 를 물고 남는 경우
2. `scripts/` 의 수동 테스트 스크립트(`arm_disarm_test.py`, `takeoff_land.py`,
   `attitude_watch.py`)나 `mavproxy` 를 띄워 놓고 잊은 경우 — **가장 흔할 것**
3. `serial-getty@ttyAMA0` 가 실수로 활성화된 경우

> 2026-09-22 10:21 저널에 실제로 이 메시지가 찍혀 있었다:
> `[감지] /dev/ttyAMA0 를 다른 프로세스가 잡고 있다: [('1170', 'mavlink-routerd')] — 건너뛴다`
> 그때는 라우터가 스스로 죽어서 풀렸다. 안 죽었으면 멈춰 있었다.

### 무엇을 고쳤나

`scripts/fc_detect.py` (백업: `scripts/fc_detect.py.bak.20260922`, 302 → 393줄)

| 추가 | 하는 일 |
|---|---|
| `_held_streak` 카운터 | 시리얼 점유로 연속 건너뛴 횟수를 센다. 로그에 `(n회 연속)` 으로 보인다 |
| `STUCK_ESCALATE_AFTER` (기본 3) | 이 횟수에 도달하면 `resolve_stuck_port()` 를 부른다. `0` 이면 옛 동작 |
| `resolve_stuck_port()` | 점유를 강제로 푼다. 아래 순서 |
| `unit_of(pid)` | `/proc/<pid>/cgroup` 으로 pid 의 systemd 유닛을 알아낸다 |
| `MAINT_FILE` 안전장치 | `state/maintenance` 가 있으면 강제 해제를 **보류**하고 로그만 남긴다 |

`resolve_stuck_port()` 순서:

1. `drone.target` 이 active 면 먼저 정상 경로로 `stop` (mode=none 인데 target 이
   살아 있는 상태 불일치를 여기서 바로잡는다)
2. 남은 점유자를 훑는다. pid 1 과 자기 자신은 건너뛴다
3. 점유자가 `drone-*` 유닛 소속이면 → `systemctl stop` 후 `systemctl kill -s KILL`
4. 유닛 밖이면 → `SIGTERM` → 2초 대기 → 안 죽으면 `SIGKILL`
5. 결과를 확인해 로그로 남긴다. 안 풀렸으면 다음 회차에 다시 시도

**FC 로는 아무것도 보내지 않는다.** 포트를 잡은 프로세스만 정리한다 (규칙 1 유지).

### 정비 모드 — 사람이 수동으로 시리얼을 쓸 때

강제 해제가 수동 작업 프로세스를 죽이면 안 되므로 보류 장치를 뒀다.

```bash
touch ~/drone/state/maintenance   # 강제 해제 보류
rm    ~/drone/state/maintenance   # 다시 켜기
```

보류 중에는 시작 로그에 `(정비 모드 파일 있음 — 보류 중)` 이 붙고,
점유를 감지할 때마다 보류 사유를 로그에 남긴다.

### 설정

`/etc/drone-node.env` (백업: `/etc/drone-node.env.bak.20260922`)

```ini
STUCK_ESCALATE_AFTER=3     # 3회 연속(약 20~30초) 점유 시 개입. 0 = 안 함
```

### 검증 — 고장을 실제로 재현해서 확인했다

가짜 점유 프로세스(`/dev/ttyAMA0` 을 열고 놔주지 않는 파이썬)를 띄워
고장을 재현했다.

**시험 1 — 강제 해제 ✅**

| 시각 | 사건 |
|---|---|
| 10:50:22 | `drone-detect` 기동, 점유 감지 (1회 연속) |
| 10:50:32 | 2회 연속 |
| 10:50:42 | 3회 연속 → **`[강제해제]` 개입**, pid 3225 에 SIGTERM |
| 10:50:45 | `✔ /dev/ttyAMA0 해제 완료` |
| 10:50:56 | FC heartbeat 수신 |
| 10:50:57 | `drone.target` 시작, **`mode = drone`** |

**고친 뒤: 35초 자동 복구. 고치기 전: 영구 정지 + SSH 필요.**

**시험 2 — 정비 모드 보류 ✅**

`state/maintenance` 를 만들어 두고 같은 고장을 재현했다.
3회 연속 점유를 감지했지만 **점유자를 죽이지 않고** 보류 로그만 남겼고,
45초 뒤에도 프로세스가 살아 있었다(`mode=none` 유지). 의도한 대로다.

**시험 후 상태**: `mode=drone`, 6개 유닛 전부 active, 테스트 프로세스 잔여 없음,
`state/maintenance` 삭제됨, 웹 status 에 `fc_link:true`·`router_mode:"drone"`·`link:"ok"`.

### 남은 구멍 (아직 안 고침)

| 구멍 | 왜 남겼나 |
|---|---|
| 점유자가 `D`(uninterruptible) 상태로 굳으면 SIGKILL 도 안 통한다 | 재부팅 외에 방법이 없다. 로그에 그 사실을 적어 두는 것까지만 했다 |
| `fc_detect.py`·`drone_node` 가 **죽지 않고 멈추는(hang)** 경우 | `Restart=always` 는 종료만 잡고 hang 은 못 잡는다. systemd `WatchdogSec` + `sd_notify(WATCHDOG=1)` 가 필요하다 — 코드 변경 범위가 커서 별건으로 남긴다 |
| 웹에서 원격으로 조치할 수단이 없다 | `downlink` 명령 평면이 `ping` 하나뿐(계약서 3-2). 정비용 action 추가는 계약·웹·백엔드 동시 변경이라 별건 |

---

## 2026-09-22 — hang 감시 (systemd 워치독) + 재시작 시 링크 이어받기

### 무엇이 문제였나

`Restart=always` 는 프로세스가 **종료** 할 때만 동작한다. 데드락·무한 대기로
**살아는 있지만 아무 일도 못 하는(hang)** 상태는 systemd 가 알 수 없다.

- `fc_detect.py` 가 멈추면 **자동 복구 장치 자체가 죽는다** — 링크가 끊겨도
  아무도 `drone.target` 을 다시 올리지 않는다
- `drone_node` 가 멈추면 웹이 낡은 retained status 를 계속 본다
- 둘 다 SSH 로 들어가 재시작해야 했다

### 무엇을 고쳤나

#### 1. systemd 워치독 (`WatchdogSec=60`)

유닛에 `WatchdogSec=` 를 주면 systemd 가 `WATCHDOG_USEC` 를 환경변수로 넣어 주고,
프로세스는 그 안에 `WATCHDOG=1` 을 계속 보내야 한다. 끊기면 systemd 가 죽이고
`Restart=` 대로 다시 띄운다. **살아 있음을 반대로 증명하게 하는 방식**이다.

| 파일 | 변경 |
|---|---|
| `~/hw/pi/common/watchdog.py` | **새 파일.** `NOTIFY_SOCKET` 에 유닉스 데이터그램을 직접 쏜다. `python3-systemd` 불필요 |
| `~/hw/pi/common/node.py` | `BaseNode.run()` 루프 맨 위에서 `wd.ping(now)`. 백업 `node.py.bak.20260922` |
| `~/drone/scripts/sdwatchdog.py` | **새 파일.** 위와 같은 내용. 두 트리가 따로 배포되고 서로를 import 하지 않아 의도적으로 복제했다 |
| `~/drone/scripts/fc_detect.py` | 메인 루프·`probe_serial()`·`monitor_link()`·감지 대기 슬립 4곳에서 `wd_ping()` |
| `systemd/drone-detect.service`, `systemd/drone-node.service` | `WatchdogSec=60`, `StartLimitIntervalSec=0`. 백업 `*.bak.20260922` |

**`WATCHDOG_USEC` 가 없으면 `Watchdog` 은 아무 일도 하지 않는다.** pi7 의
sensor·robot·actuator 노드는 유닛에 `WatchdogSec=` 가 없으므로 동작이 한 줄도
바뀌지 않는다. 켜고 끄는 건 유닛 파일 쪽 결정이다.

##### `StartLimitIntervalSec=0` 을 같이 넣은 이유

기본값은 "10초에 5회"다. 여기에 걸리면 유닛이 `failed` 로 굳어 **더 이상 재시작하지
않는다.** hang 이 반복될 때 그게 제일 나쁜 결과다 — 무한히 다시 시도하는 편이 낫다.
드론은 사람이 못 붙는 자리에 있다.

> ⚠ 함정: 이 키는 **`[Unit]` 소속**이다. 처음에 `[Service]` 에 넣었더니 systemd 가
> `Unknown key 'StartLimitIntervalSec' in section [Service], ignoring` 경고만 내고
> 조용히 무시했다. `systemctl show -p StartLimitIntervalUSec` 로 실제 반영을 확인해야 한다.

#### 2. 재시작 직후 링크 이어받기 (`adopt_existing_link()`)

워치독이 `fc_detect` 를 죽여 다시 띄우면 `drone.target` 과 라우터는 **멀쩡히 살아
있다**(SIGABRT 라 종료 처리를 못 하고 죽기 때문). 그런데 무조건 `mode=none` 에서
시작하면:

1. 라우터가 시리얼을 잡고 있어 감지가 막힌다
2. 강제해제가 **건강한 링크를 내렸다 다시 올린다** — 35초 낭비
3. 웹은 헛된 `fc_link_lost` → `fc_link_up` 전환을 본다

그래서 시작 시 "`drone.target` 이 active 이고 udp/14542 로 기체 heartbeat 가 실제로
오고 있으면" 내리지 않고 감시로 바로 복귀한다. heartbeat 가 없으면 `stop` 하고
원래 감지 경로를 탄다. 대기 시간은 `ADOPT_TIMEOUT`(기본 5초).

### 설정

`/etc/drone-node.env` (백업 `.bak.20260922`)

```ini
STUCK_ESCALATE_AFTER=3     # 앞 절 — 포트 강제해제
ADOPT_TIMEOUT=5            # 이어받기 판단 시 heartbeat 대기(초)
```

### 검증 — `SIGSTOP` 으로 hang 을 실제로 모사했다

`kill -STOP` 은 프로세스를 살려 둔 채 얼린다(`ps` 상태 `T`). 워치독 보고가 끊기므로
hang 과 같은 상황이다.

**시험 1 — `drone-node` ✅**

| 시각 | 사건 |
|---|---|
| 11:06:07 | SIGSTOP |
| 11:06:49 | `Watchdog timeout (limit 1min)!` → SIGABRT → `Failed with result 'watchdog'` |
| 11:06:52 | 재시작, 새 PID 4445 |

**45초 자동 복구.**

**시험 2 — `drone-detect`, 이어받기 전 ✅ (강제해제와의 상호작용)**

| 시각 | 사건 |
|---|---|
| 11:07:13 | SIGSTOP |
| 11:07:55 | 워치독 timeout → SIGABRT |
| 11:08:00 | 재시작. 라우터가 시리얼을 잡고 있어 감지 막힘 |
| 11:08:21 | 3회 연속 → **강제해제**: `drone.target` active 감지 → 정상 stop → 포트 해제 |
| 11:08:35 | FC 재감지 → `mode=drone` |

**85초.** 앞 절의 강제해제 수정이 없었다면 재시작 후 **영구히 `건너뛴다` 에 갇혔다.**
두 수정이 맞물려야 복구된다.

**시험 3 — 이어받기 적용 후 ✅**

SIGKILL: **6초** 복구, 링크 미차단.

워치독 경로 (11:10:08 SIGSTOP → 11:11:00 복구): **52초**.
`[이어받기] ✔ 살아 있는 링크를 이어받는다 (sysid=1) — 링크를 내리지 않는다`

`linkmon.log` 11:10:39 요약이 hang 중에도 **`상태=UP, 총 19018건`** 으로 정상이다
— 라우터는 계속 돌고 있었고 링크는 한 번도 끊기지 않았다. `85초 → 52초`, 그리고
**웹이 보는 헛된 링크 전환이 사라졌다.**

### 최종 상태

`mode=drone`, 6개 유닛 전부 active, `systemctl --failed` 0건,
두 유닛 `WatchdogUSec=1min` · `StartLimitIntervalUSec=0`,
웹 status `fc_link:true` · `router_mode:"drone"` · `link:"ok"`.

### 복구 시간 정리

| 고장 | 고치기 전 | 고친 뒤 |
|---|---|---|
| 시리얼 포트 영구 점유 | **영구 정지 (SSH 필요)** | 35초 |
| 프로세스 hang | **영구 정지 (SSH 필요)** | `drone-node` 45초 / `drone-detect` 52초 (링크 미차단) |
| 프로세스 급사(SIGKILL) | 이미 자동 (Restart=always) | 6초 (이어받기로 단축) |

### 남은 구멍

| 구멍 | 상태 |
|---|---|
| 점유자가 `D`(uninterruptible) 상태로 굳음 | SIGKILL 도 안 통한다. 재부팅 외 방법 없음. 로그로 알리는 것까지만 |
| `mavlink-routerd` 자체의 hang | C 프로그램이라 `sd_notify` 를 넣을 수 없다. 다만 라우터가 멈추면 14542 heartbeat 가 끊겨 `fc_detect` 의 `LINK_TIMEOUT`(15초)이 잡는다 — 이미 덮인다 |
| `drone-linkmon` 의 hang | 미적용. 멈춰도 `fc_detect` 가 독립적으로 14542 를 보므로 링크 판정에는 영향 없다. 링크 통계만 멈춘다 |
| 웹에서 원격 조치할 수단 | `downlink` 가 `ping` 하나뿐(계약서 3-2). 계약·웹·백엔드 동시 변경이라 별건 |

### ⚠ `~/hw` 저장소는 커밋하지 않았다

```
 M pi/common/node.py          (+7줄: import, wd = Watchdog(), wd.ping(now))
?? pi/common/watchdog.py      (새 파일)
?? pi/common/node.py.bak.20260922
?? pi/drone/                  (이전부터 미추적)
```

`pi/common/node.py` 는 pi7 의 sensor·robot·actuator 노드도 쓰는 공유 파일이다.
커밋·배포는 사람이 판단할 일이라 그대로 두었다.

---

## 2026-09-22 — 첫 비행(야외) 사전 점검: FC 없이 채울 수 있는 것 채우기

드론이 분리된 상태에서, 비행 전에 **FC 없이도 검증 가능한 것**만 골라 실제로 통과시켰다.
목적은 비행 당일 "라즈베리파이 쪽이 원인인가"를 후보에서 지우는 것이다.

### 새로 만든 것 — `scripts/fake_fc.py` (시험 도구)

pymavlink 로 127.0.0.1:14540 에 heartbeat + 텔레메트리를 흘려보내는 가짜 기체다.
실물 FC 없이 MAVSDK 계층만 떼어내 시험한다. `state/mode == drone` 이면 스스로 거부한다.
`--no-gps` 로 GPS 없는 상태를 모사할 수 있다. **시험 전용 — 자동 실행에 넣지 않는다.**

### 드라이런 결과 — MAVSDK 경로 전 구간 통과

| 확인 항목 | 이전 | 결과 |
|---|---|---|
| `udpin://0.0.0.0:14540` 주소 형식을 mavsdk 3.17.4 가 아는가 | 미확인(프롬프트가 `udp://:14540` 대안을 남겨 둠) | ✅ **그대로 동작** — 대안 불필요 |
| `mavsdk_server` (arm64) 기동 · gRPC 연결 | 미확인 | ✅ |
| `telemetry_watch.py` 전 항목 구독 | 미확인 | ✅ 연결·arm·모드·위치·고도·자세·배터리·GPS·home 전부 표시 |
| `takeoff_land.py` 의 위치 추정 게이트 | 미확인 | ✅ `--no-gps` 에서 **이륙 거부, 종료코드 1, arm 미도달** |

> 실행은 전부 루프백(127.0.0.1)이고 FC 는 물리적으로 분리돼 있었다. `state/mode = none`
> 을 매 실행 직전에 확인했다. 라우터가 내려가 있어 14540 은 비어 있었다.

### 고친 것 — `takeoff_land.py` 의 미처리 예외 (진짜 결함)

`await drone.action.set_takeoff_altitude()` 가 try 로 감싸여 있지 않았다. 이 호출은
FC 파라미터(`MIS_TAKEOFF_ALT`) 쓰기라 ACK 가 없으면 `ActionError` 를 던지는데,
**raw traceback 으로 죽었다.** arm 前이라 위험하지는 않지만 현장에서 원인 파악이 어렵다.

고친 뒤: `[오류] 이륙 고도 설정 실패: ... / arm 하지 않고 중단한다` + 종료코드 1.
백업 `scripts/takeoff_land.py.bak.20260922`.

### 막아 둔 것 — mavsdk 업그레이드 함정

드라이런 중 경고가 떴다: `mavsdk` 패키지가 `mavsdk-grpc` 로 이름이 바뀌었고, `mavsdk`
라는 이름은 이제 **API 가 다른** 네이티브 바인딩을 가리킨다. `pip install -U mavsdk` 한 번이면
제어 스크립트 3개가 전부 깨진다. `config/requirements.lock.txt` 에 12개 패키지를 고정하고
경고를 적어 두었다.

### 확인만 한 것

- 스풀 디스크 위험 없음: `drone_rpi/config.json` 의 `max_items=500`, `max_age_s=1800` 으로 상한이 걸려 있다
- 현재 부하 여유: 63.7°C, `throttled=0x0`, 디스크 6%

### 여전히 FC·야외가 있어야 하는 것 (비행 당일)

`action.arm()` / `action.takeoff()` 를 PX4 가 실제로 수락하는지, GPS fix, home 설정,
배터리 단일 전원 동시 부팅, 프로펠러·조종기·페일세이프. 가짜 FC 는 COMMAND_LONG 에
ACK 를 돌려주지 않으므로 여기까지는 모사하지 않았다 (모사해 봐야 실물에 대한 정보가 없다).

### 현장 절차서 작성 — `FLIGHT_CHECKLIST_x500.md`

첫 비행을 위한 현장용 문서를 새로 만들었다. 한 장짜리 빠른 순서(0~5단계), 나가기 전
확인(문서·장비·QGC 파라미터), 단계별 통과 기준, 중단 기준, 증상별 대응표 [A]~[G],
비행 후 처리, 주요 값 부록으로 구성했다.

§7 에 **검증된 것과 아직 모르는 것을 표로 갈라 적었다.** 첫 비행에서 처음 확인되는 것은
arm/takeoff 수락 여부, GPS fix·home, 배터리 단일 전원 동시 부팅, 급전 시 전압,
기체가 실제로 나는지 — 6가지다. 비행 후 이 표를 갱신한다.

---

## 2026-09-22 저녁 — 첫 현장 시도: 0~1단계 통과, FC 사전검사에서 막힘

### 0·1단계 — 통과

`mode=drone`, 4개 유닛 active, `throttled=0x0`, 64.8°C.
`check_link.py --device udpin:0.0.0.0:14540` 종료코드 0.
5초간 1,764건 / **28종**, ATTITUDE 99.8Hz (9/21 의 22~23종보다 풍부하다).
FC 파라미터 7개 전부 기대값 일치 — 라즈베리파이 = 인스턴스 1 on TELEM2 Onboard 921600,
Air Unit = 인스턴스 0 on TELEM1 57600 (미변경), `UXRCE_DDS_CFG=0`.
linkmon 6분 이상 연속 `상태=UP`, 끊김 0건. **통신 계통은 이상 없다.**

### 새로 만든 것 — `scripts/fc_state.py`

`system_status` / arm / GPS fix·위성 수 / 센서 헬스 / 배터리를 한 번 찍는 읽기 전용 도구.
**라우터의 QGC 포트(TCP 5760)로 붙는다** — 14540 을 쓰지 않으므로 `telemetry_watch.py` 와
동시에 돌릴 수 있다. 14540 을 다투던 기존 읽기 도구들의 불편을 푼 것이다.

### 막힌 지점 — FC 쪽이다

```
[CRITICAL] Preflight Fail: heading estimate not stable
```

| 항목 | 값 | 판정 |
|---|---|---|
| `system_status` | **`MAV_STATE_UNINIT`** | ⚠ STANDBY 가 아니다 → arm 거부 |
| GPS | **`NO_GPS`(fix_type=0), 위성 0개** | ⚠ "하늘 가림"이 아니라 **장치 미검출** 신호 |
| 센서 헬스 RC | **X** | ⚠ 조종기 꺼짐 또는 미바인딩 |
| 센서 헬스 지자기·자이로·가속도·AHRS | O | ✅ |
| 배터리 | 16.59V 95% | ✅ 4S 만충 근처 |
| PREARM_CHECK | health=X | ⚠ 위와 일관 |

> `present` 비트마스크는 AHRS 까지 X 로 나와 이 PX4 버전에서 신뢰하기 어렵다.
> GPS 판단은 `GPS_RAW_INT` 의 `fix_type=0` + `satellites_visible=0` 을 근거로 한다.
> **`NO_GPS`(0) 와 `NO_FIX`(1) 는 다르다** — 실내라서 못 잡는 거라면 보통 1 이 뜬다.

### 판정

라즈베리파이 쪽은 할 일을 다 했다. 남은 건 전부 FC·기체 쪽이다:
실내 자기 간섭(야외로 나가면 대개 풀린다), GPS 모듈 연결 확인, 조종기 전원.
체크리스트 §6 에 [H](heading 불안정)·[I](NO_GPS vs NO_FIX) 대응을 추가했다.

### 부수 확인

- `check_link.py` 의 ATTITUDE 6줄이 전부 같은 값인 것은 **정상**이다. 연속된 메시지 6개를
  찍는데 100Hz 면 60ms 안에 들어오고, 시각 표시가 0.1초 단위라 같게 보인다. 정지 상태에서
  60ms 동안 자세가 안 바뀌는 건 당연하다. 기울임 시험은 `attitude_watch.py` 로 따로 한다

## 2026-09-22 — 3단계 arm 시도: `COMMAND_DENIED`. 원인 확정

### ✅ 뜻밖의 수확 — MAVSDK 명령 경로가 증명됐다

`arm_disarm_test.py` 가 `COMMAND_DENIED` 를 받았다. **이건 FC 가 실제로 답한 것이다.**
즉 `MAVSDK → 14540 → mavlink-router → UART → FC` 경로로 명령이 가고 ACK 가 돌아온다.
지금까지 "아직 모르는 것" 표의 첫 줄이던 **"PX4 가 action.arm() 을 수락하는가"** 는
이제 *"명령은 도달한다. FC 가 자기 사정으로 거부한다"* 로 바뀌었다. 배관은 검증 완료다.

### 거부 사유

```
[CRITICAL] Preflight Fail: heading estimate not stable
```

### arm 관련 FC 파라미터 (읽기 전용, 쓰지 않았다)

| 파라미터 | 값 | 판정 |
|---|---|---|
| `SER_TEL2_BAUD` | 921600 | (대조군 — 읽기 방식이 옳음을 확인) |
| `COM_ARM_WO_GPS` | **1** | GPS 없이 arm 허용 → **GPS 는 직접적 차단 요인이 아니다** |
| `SYS_HAS_GPS` | **1** | 기체가 GPS 있다고 선언 |
| `EKF2_GPS_CTRL` | 7 | EKF 가 GPS 를 쓰도록 설정됨 |
| `EKF2_MAG_TYPE` | 0 | 자동 |
| `COM_ARM_MAG_ANG` | 60 | 지자기-기수 각도차 60도 검사 |
| `COM_RC_IN_MODE` | 3 | RC 또는 조이스틱 중 먼저 오는 것 |
| `CBRK_SUPPLY_CHK` | 894281 | 전원 검사 차단됨 |

### 원인 사슬

`SYS_HAS_GPS=1` 인데 `GPS_RAW_INT` 는 `fix_type=0`·위성 0개다.
**PX4 는 GPS 를 기대하는데 데이터가 아예 안 온다.** `EKF2_GPS_CTRL=7` 이라 EKF 는 GPS 보조
기수 추정을 쓰도록 돼 있는데 그게 없으니 지자기에만 의존하고, 실내 자기 간섭에서는
수렴하지 못한다 → `heading estimate not stable` → arm 거부.

**GPS 와 heading 은 한 뿌리로 보인다. GPS 를 살리면 heading 도 같이 풀릴 가능성이 높다.**

### ⚠ 파라미터 읽을 때 주의 — PX4 는 bytewise 다

`PARAM_VALUE.param_value` 는 float32 인데 PX4 는 INT32 값을 **비트 그대로** 실어 보낸다.
`int(param_value)` 로 읽으면 denormal 이라 **전부 0 으로 보인다** (이번에 실제로 겪었다).
올바른 해독: `struct.unpack('<i', struct.pack('<f', v))[0]`.
`check_link.py` 는 이미 올바르게 처리하고 있다.

### 다음

GPS 모듈 커넥터(FC GPS1 포트)·마스트 배선 확인 → 야외 → `fc_state.py` 재확인.
`STANDBY` + `3D_FIX` 가 되면 3단계를 다시 시도한다. 조종기도 켜 둔다(RC 헬스 X 였다).

---

## 2026-09-22 — 3단계 통과 (야외) + 비행 중 고장 시나리오 정리

### 3단계 통과

사용자가 야외에서 GPS 연결 후 프로펠러 제거 상태로 `arm_disarm_test.py` 를 통과시켰다.
앞선 `heading estimate not stable` 은 예상대로 **GPS 를 살리고 야외로 나가자 풀렸다.**
linkmon 마지막 기록(17:54~17:55)에 `GLOBAL_POSITION_INT` 49.9~50.0Hz 가 찍혀 있어
GPS 가 실제로 동작했음이 로그로도 남았다.

→ "아직 모르는 것" 표에서 **arm 수락**, **GPS fix**, **heading** 세 줄이 해소됐다.
남은 것은 `takeoff()`/`land()` 수락과 실제 비행이다.

### 새로 만든 것 — `scripts/failsafe_audit.py` (읽기 전용)

"비행 중 라즈베리파이가 죽으면 / 조종기가 끊기면 / 배터리가 바닥나면 어떻게 되는가" 를
**기체의 실제 파라미터로** 답하는 감사 도구. `NAV_DLL_ACT`, `NAV_RCL_ACT`,
`COM_LOW_BAT_ACT`, `BAT_*_THR`, `GF_ACTION`, `RTL_RETURN_ALT`, `COM_OBL_ACT` 등을 읽고
끝에 사람 말로 정리해 준다. TCP 5760 을 쓰므로 14540 도구들과 겹치지 않는다.
bytewise 디코딩(위 §"PX4 는 bytewise 다" 참고)을 내장했다.

**FC 없이 검증했다**: `fake_fc.py` 에 `PARAM_REQUEST_READ` 응답 기능을 추가하고
(PX4 와 같은 bytewise 규칙으로 싣는다) 감사 도구를 붙여 13개 파라미터 왕복을 확인했다.
실물 기체에서는 아직 돌리지 않았다 — 다음 연결 때 돌릴 것.

### 구조적 결론 — 라즈베리파이가 죽어도 기체는 떨어지지 않는다

비행 제어는 FC 전담이고 라즈베리파이는 명령을 **시작만** 시킨다. `takeoff()`/`land()` 는
모드 전환 명령이지 연속 제어가 아니다. **OFFBOARD 를 쓰지 않으므로**(`UXRCE_DDS_CFG=0`,
offboard 스크립트 없음) 스트림이 끊겨도 즉각적인 영향이 없다.

**다만 이륙 직후 라즈베리파이가 죽으면 `land()` 가 영영 오지 않아 그 고도에서 무한 호버한다.**
조종기로 내려야 한다. `NAV_DLL_ACT` 가 0 이 아니면 FC 가 스스로 RTL·착륙할 수도 있는데,
그 값은 실물에서 아직 읽지 않았다.

### 새로 인식한 위험 — SD 카드

비행 중 라즈베리파이 전원이 갑자기 끊기면 SD 파일시스템이 깨질 수 있다.
`drone-agent` 가 스풀에 계속 쓰므로 위험이 커진다. 첫 비행 동안 정지 + 비행 직전 `sync` 권장.

체크리스트에 **§4-1 "비행 중 이상 상황"** 을 새로 넣었다.
