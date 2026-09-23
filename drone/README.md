# X500 v2 드론 — 라즈베리파이 컴패니언 컴퓨터 (`pi3`)

쿼드콥터 X500 v2 에 올라가는 **컴패니언 컴퓨터**의 전부다.
비행 컨트롤러(FC)와 대화하고, 지상국·가시화 웹에 상태를 중계한다.

> **이 문서를 읽는 사람에게**: 이 저장소를 처음 만지는 사람을 위해 썼다.
> PX4 나 MAVLink 를 몰라도 따라올 수 있게 "무엇을"보다 **"왜 그렇게 했는지"**를 같이 적었다.
> 실제로 비행시킬 때는 [`FLIGHT_CHECKLIST_x500.md`](FLIGHT_CHECKLIST_x500.md) 를 본다.

---

## 1. 한눈에 보기

```
     [ 기체 X500 v2 ]
     ┌──────────────────────────────┐
     │  코아 FC H743 (PX4)          │   ← 비행은 전적으로 이 친구가 한다
     │   ├ TELEM1 ─ 무선 Air Unit   │   ← 건드리지 않음
     │   └ TELEM2 ─┐                │
     └─────────────┼────────────────┘
                   │ UART 921600bps (선 3가닥)
     ┌─────────────┼────────────────┐
     │  라즈베리파이 5 (pi3)         │   ← 이 저장소
     │   mavlink-router             │   ← 시리얼 1개를 여럿이 나눠 쓰게 함
     │    ├ TCP  5760  → QGroundControl (Tailscale 경유)
     │    ├ UDP 14540  → 제어 스크립트 (MAVSDK)
     │    ├ UDP 14541  → 링크 감시
     │    ├ UDP 14542  → 자동 감지
     │    └ UDP 14543  → MQTT 가시화 브리지
     └──────────────────────────────┘
```

**핵심 한 줄**: 라즈베리파이는 **비행을 하지 않는다.** 비행은 FC 가 한다.
라즈베리파이는 *상태를 읽고*, *명령을 시작시키고*, *바깥 세상과 이어 주는* 역할만 한다.

---

## 2. 하드웨어 — 선이 어떻게 연결돼 있나

| FC 쪽 | 라즈베리파이 쪽 | 뜻 |
|---|---|---|
| TELEM2 **TX** | 40핀 **10번** (GPIO15, RXD) | FC 가 말하고 파이가 듣는다 |
| TELEM2 **RX** | 40핀 **8번** (GPIO14, TXD) | 파이가 말하고 FC 가 듣는다 |
| TELEM2 GND | 40핀 **6번** | 기준 전위 |

- **속도 921600bps.** 일반 텔레메트리(57600)의 16배다. 자세 데이터를 100Hz 로 받으려면 필요하다
- **TELEM1 은 무선 Air Unit 자리다.** 조종기·지상국이 쓰는 별도 경로이고 **절대 건드리지 않는다**

### ⚠ 반드시 알아야 할 함정 — `/dev/serial0` 을 쓰면 안 된다

라즈베리파이에서 UART 하면 보통 `/dev/serial0` 을 떠올리는데, **Pi 5 에서는 그게 GPIO 가 아니다.**

```
/dev/serial0  →  /dev/ttyAMA10   ← 보드 옆 디버그 커넥터 (우리가 쓰는 선이 아님!)
/dev/ttyAMA0                     ← GPIO14/15 = FC 로 가는 진짜 선  ✅
```

그래서 모든 설정에 **`/dev/ttyAMA0` 을 명시**한다. 이걸 모르고 `serial0` 을 쓰면
"선은 맞는데 아무것도 안 들어온다"에 몇 시간을 태운다.

Pi 5 는 `config.txt` 에 `dtparam=uart0=on` 으로 이 포트를 켠다
(`enable_uart=1`·`dtoverlay=disable-bt` 는 Pi 4 이하 방식이라 여기서는 쓰지 않는다).
그리고 부팅 콘솔이 이 선을 타고 나가 MAVLink 를 깨뜨리지 않도록
`cmdline.txt` 의 콘솔을 `ttyAMA10` 으로 고정했다.

---

## 3. mavlink-router — 이 구조의 심장

### 문제

시리얼 포트는 **한 번에 하나의 프로그램만** 열 수 있다. 그런데 FC 와 대화하고 싶은 쪽은 여럿이다.

- 지상국 QGroundControl 이 보고 싶다
- 제어 스크립트가 이륙 명령을 보내고 싶다
- 링크 감시가 끊김을 기록하고 싶다
- 가시화 웹 브리지가 배터리를 읽고 싶다

이들이 서로 포트를 뺏으면 아무도 못 쓴다.

### 해결

**`mavlink-router` 가 시리얼을 혼자 독점**하고, 받은 MAVLink 패킷을 여러 UDP/TCP 창구로 **복사해서 뿌린다.**
각 프로그램은 자기 창구만 본다. 우체국 사서함과 같다.

| 창구 | 쓰는 쪽 | 방향 |
|---|---|---|
| **TCP 5760** | QGroundControl | 양방향 |
| **UDP 14540** | 제어 스크립트 (MAVSDK) | 양방향 |
| **UDP 14541** | `drone-linkmon` | **읽기만** |
| **UDP 14542** | `drone-detect` | **읽기만** |
| **UDP 14543** | MQTT 가시화 브리지 | **읽기만** |

> 왜 포트를 넷으로 나눴나 — 전부 14540 을 쓰면 서로 UDP 포트를 다툰다.
> 읽기 전용 소비자마다 자기 포트를 주면 **누구도 남을 방해하지 않는다.**

설정: [`config/mavlink-router.conf`](config/mavlink-router.conf)

---

## 4. 전원만 켜면 알아서 되는 구조

목표는 **"배터리를 꽂으면 그냥 준비된다"**였다. 사람이 SSH 로 들어가 뭘 실행하지 않는다.

### 상태 기계

```
     전원 ON
        │
        ▼
   ┌─────────────────┐   FC heartbeat 발견    ┌──────────────────┐
   │   mode = none   │ ─────────────────────▶ │  mode = drone    │
   │  (10초마다 탐색) │                        │ drone.target 가동 │
   └─────────────────┘ ◀───────────────────── └──────────────────┘
                         15초간 heartbeat 없음
```

- **FC 가 없어도 에러를 쏟지 않는다.** 조용히 10초마다 다시 본다
- **FC 전원이 파이보다 늦게 들어와도** 알아서 붙는다
- 현재 상태는 언제나 [`state/mode`](state/) 파일에 `drone` 또는 `none` 으로 적혀 있다

### systemd 유닛

| 유닛 | 언제 도나 | 하는 일 |
|---|---|---|
| `drone-detect` | **항상** | FC 를 찾는다. 찾으면 `drone.target` 시작, 끊기면 정지 |
| `drone.target` | FC 있을 때 | 아래 둘을 묶는 스위치 |
| `drone-mavlink-router` | `drone.target` 소속 | 시리얼 ↔ 여러 창구 중계 |
| `drone-linkmon` | `drone.target` 소속 | 링크 통계·끊김 기록 (읽기 전용) |
| `drone-node` | **항상** | MQTT 가시화 브리지 (읽기 전용) |

> **`drone-node` 만 `drone.target` 소속이 아닌 이유**: FC 가 없어도 떠 있어야 한다.
> 그래야 웹이 *"브로커는 붙었고 드론 노드도 답하는데 **FC 링크만** 없다"* 를 구분할 수 있다.
> 노드가 통째로 죽어 있으면 웹은 "파이가 꺼졌나? 네트워크인가?"를 구분하지 못한다.

### 고장을 스스로 회복한다

| 고장 | 어떻게 잡나 | 복구 시간 |
|---|---|---|
| 프로세스가 죽음 | `Restart=always` | 약 6초 |
| 프로세스가 **살아는 있는데 멈춤**(hang) | systemd `WatchdogSec=60` + 코드가 주기적으로 생존 보고 | 45~52초 |
| 다른 프로세스가 시리얼을 붙잡고 안 놓음 | `drone-detect` 가 점유자를 찾아 단계적으로 해제 | 약 35초 |

> `Restart=always` 는 프로세스가 *종료*할 때만 작동한다. 데드락으로 살아만 있는 상태는
> 못 잡는데, 드론은 사람이 손을 못 대는 자리에 있으므로 워치독을 따로 붙였다.
> `StartLimitIntervalSec=0` 으로 재시작 횟수 제한도 껐다 — 유닛이 `failed` 로 굳어
> 영영 안 올라오는 게 제일 나쁜 결과다.

사람이 수동으로 시리얼을 써야 할 땐 감지기를 잠시 재운다:
```bash
touch ~/drone/state/maintenance   # 켜기
rm    ~/drone/state/maintenance   # 끄기 (끝나면 반드시)
```

---

## 5. QGroundControl 연동

### 어떻게 이어지나

```
[노트북 QGC]  ──Tailscale VPN──▶  [pi3:5760 TCP]  ──▶  mavlink-router  ──UART──▶  [FC]
100.125.71.51                     100.85.243.54
```

QGC 에서 연결 추가:

| 항목 | 값 |
|---|---|
| 방식 | **TCP** |
| 주소 | `100.85.243.54` (pi3 의 Tailscale IP) |
| 포트 | `5760` |

### 왜 이렇게 했나

**왜 Tailscale 인가** — 현장 네트워크가 핫스팟으로 자주 바뀐다. 공유기 IP 에 의존하면
장소를 옮길 때마다 주소를 고쳐야 한다. Tailscale IP 는 **어느 망에 있든 그대로**다.

**왜 TCP 인가** — QGC 가 붙는 순간부터 패킷이 오간다. UDP 는 QGC 쪽에서 먼저 뭔가를
보내야 라우터가 상대 주소를 알 수 있지만, TCP 는 접속 자체가 상대를 알려 준다.
방화벽·NAT 도 다루기 쉽다.

**QGC 를 켜도 다른 게 안 죽는다** — 라우터가 패킷을 복사해 뿌리므로 QGC 와
제어 스크립트, 감시, 브리지가 **동시에** 같은 FC 를 본다.

### QGC 로 하는 일 / 하지 않는 일

| QGC 로 한다 | 라즈베리파이로 한다 |
|---|---|
| 센서 캘리브레이션 | 상태 읽기·기록 |
| **파라미터 변경** (사람만) | 파라미터 **읽기만** |
| 페일세이프·비행모드 설정 | 이륙·착륙 명령 시작 |
| 거부 사유 확인 | 웹으로 상태 중계 |

> **FC 파라미터를 쓰는 것은 사람이 QGC 로만 한다.** 이 저장소의 어떤 코드도 파라미터를
> 쓰지 않는다. 자동화가 기체 설정을 말없이 바꾸면 원인 추적이 불가능해진다.

---

## 6. PX4 / FC 의 어떤 기능을 어떻게 쓰는가

여기가 이 문서의 핵심이다. **MAVLink** 는 FC 와 대화하는 공용어이고,
크게 ① 계속 흘러오는 **메시지**, ② 우리가 보내는 **요청/명령**, ③ 저장된 **파라미터** 로 나뉜다.

### 6-1. PX4 에게 "온보드 컴퓨터"라고 선언해 두었다

FC 파라미터 `MAV_1_MODE = 2 (Onboard)` 가 이 구성의 출발점이다.

PX4 는 MAVLink 상대가 누구냐에 따라 **보내 주는 메시지 종류와 속도를 바꾼다.**

| 모드 | 용도 | 결과 |
|---|---|---|
| `Normal` | 지상국(사람이 보는 화면) | 적당한 종류를 느리게 |
| **`Onboard`** | **컴패니언 컴퓨터** | **더 많은 종류를 훨씬 빠르게** |

그래서 우리가 **ATTITUDE 를 100Hz 로 받는다.** Normal 이었다면 10Hz 수준이다.
스트림을 일일이 요청할 필요 없이, 모드 선언 하나로 PX4 가 알아서 쏟아 준다.

### 6-2. FC 에서 받아 쓰는 메시지

전부 **가만히 듣기만** 하면 들어온다. 실측 기준 초당 약 350건 / 28~34종이 온다.

| 메시지 | 주기 | 여기서 뭘 얻나 | 쓰는 곳 |
|---|---|---|---|
| `HEARTBEAT` | 1~2Hz | **링크 생존**, arm 여부, 비행 모드, 시스템 상태 | 감지·감시·브리지 전부 |
| `ATTITUDE` | 100Hz | roll / pitch / yaw | 자세 확인 |
| `SYS_STATUS` | 5Hz | 전압, 잔량, **센서별 정상 여부** | 브리지, `fc_state.py` |
| `BATTERY_STATUS` | 0.5Hz | 전압·전류 보조 정보 | 브리지 (보조) |
| `GPS_RAW_INT` | 10Hz | **fix 종류, 위성 수** | 이륙 가능 판단 |
| `GLOBAL_POSITION_INT` | 50Hz | 위도·경도·고도 | 위치 표시 |
| `LOCAL_POSITION_NED` | 30Hz | 이륙 지점 기준 상대 좌표 | |
| `ALTITUDE` | 10Hz | 고도 여러 기준 | 브리지 |
| `EXTENDED_SYS_STATE` | 5Hz | **지상/공중/이륙중/착륙중** | 착륙 완료 판정 |
| `ESTIMATOR_STATUS` | 1Hz | EKF 추정 건전성 | |
| `STATUSTEXT` | 수시 | **PX4 가 사람 말로 보내는 경고·거부 사유** | 문제 진단의 핵심 |

**`STATUSTEXT` 가 특히 중요하다.** arm 이 거부됐을 때
`Preflight Fail: heading estimate not stable` 같은 **이유를 글로** 보내 준다.
실제로 이걸로 첫 arm 실패 원인을 30초 만에 찾았다.

`HEARTBEAT` 의 `custom_mode` 필드는 PX4 전용 인코딩이라
`scripts/check_link.py` 의 `decode_px4_custom_mode()` 가 `AUTO.LOITER` 같은 이름으로 풀어 준다.

### 6-3. FC 로 **보내는** 것 — 딱 네 가지뿐

| 보내는 것 | 누가 | 왜 |
|---|---|---|
| `HEARTBEAT` | `fc_detect`, `check_link` | "나 여기 있다" — MAVLink 의 기본 예절 |
| `PARAM_REQUEST_READ` | `check_link`, `failsafe_audit` | 파라미터 **읽기** (조회일 뿐 변경 아님) |
| `MAV_CMD_SET_MESSAGE_INTERVAL` | `check_link` | ATTITUDE 가 안 올 때만 스트림 요청 |
| **제어 명령** | `arm_disarm_test`, `takeoff_land` **만** | 아래 6-4 |

**`drone-linkmon` 과 `drone-node` 는 FC 로 0 바이트를 보낸다.** 이건 약속이 아니라 **구조로 보장**된다 —
systemd 유닛에 `DevicePolicy=closed` 가 걸려 있어 시리얼 장치를 **열 수조차 없다.**

### 6-4. MAVSDK 로 부르는 PX4 기능

제어 스크립트는 [MAVSDK](https://mavsdk.mavlink.io) 를 쓴다.
MAVSDK 는 복잡한 MAVLink 주고받기를 `arm()` 같은 함수 하나로 감싸 준다.

```
[파이썬 스크립트] ──gRPC──▶ [mavsdk_server] ──MAVLink UDP 14540──▶ [라우터] ──▶ [FC]
```

> `mavsdk_server` 는 파이썬 패키지 안에 들어 있는 실행 파일이고, 스크립트가 켜질 때 자동으로 뜬다.

**읽기 (`telemetry`)** — 구독만 한다. 안전하다.

| 호출 | 얻는 것 |
|---|---|
| `telemetry.armed()` | arm 여부 |
| `telemetry.flight_mode()` | 비행 모드 |
| `telemetry.position()` | 위경도·고도 |
| `telemetry.attitude_euler()` | roll/pitch/yaw |
| `telemetry.battery()` | 전압·잔량 |
| **`telemetry.health()`** | **`is_global_position_ok`, `is_home_position_ok`** |
| `telemetry.in_air()` | 공중에 떠 있는지 |
| `core.connection_state()` | 연결 여부 |

`health()` 가 이륙 안전장치의 근거다. 이게 통과 못 하면 **스크립트가 이륙을 거부한다.**

**쓰기 (`action`)** — 기체가 실제로 움직인다.

| 호출 | PX4 에서 실제로 일어나는 일 |
|---|---|
| `action.arm()` | `MAV_CMD_COMPONENT_ARM_DISARM` → PX4 가 **사전검사(preflight check)** 를 돌리고 통과해야 모터에 전원을 준다 |
| `action.set_takeoff_altitude(m)` | 파라미터 `MIS_TAKEOFF_ALT` 를 쓴다 |
| `action.takeoff()` | `MAV_CMD_NAV_TAKEOFF` → PX4 가 **`AUTO.TAKEOFF` 모드**로 바뀌어 스스로 올라간다 |
| `action.land()` | `MAV_CMD_NAV_LAND` → **`AUTO.LAND` 모드**로 바뀌어 스스로 내려온다 |
| `action.disarm()` | 모터 전원을 끊는다 |

### 6-5. ★ 가장 중요한 설계 결정 — OFFBOARD 를 쓰지 않는다

PX4 로 기체를 움직이는 방법은 크게 둘이다.

| | **OFFBOARD 모드** | **AUTO 모드 (우리 방식)** |
|---|---|---|
| 방식 | 외부 컴퓨터가 초당 수십 번 목표값을 **계속** 보냄 | 명령을 **한 번** 보내면 FC 가 알아서 수행 |
| 컴퓨터가 죽으면 | **즉시 페일세이프** — 스트림이 끊기면 못 난다 | **영향 없음** — FC 가 하던 걸 계속한다 |
| 쓸 수 있는 것 | 자유로운 궤적·시각 추종 | 이륙·착륙·귀환 같은 정형 동작 |

우리는 **AUTO 모드만** 쓴다. `takeoff()` 와 `land()` 는 *"이륙해"*, *"착륙해"* 라고
한 번 말하는 것이고, 실제 비행은 PX4 가 자기 제어 루프로 수행한다.

**그래서 비행 중 라즈베리파이가 죽어도 기체는 떨어지지 않는다.**

단, 뒤집어 보면 위험도 있다 — **이륙 직후 파이가 죽으면 `land()` 가 영영 오지 않아
기체가 그 고도에서 계속 호버한다.** 조종기로 내려야 한다.
그래서 이륙 스크립트는 반드시 **조종기를 손에 든 채로** 실행한다.

(`UXRCE_DDS_CFG = 0` 으로 ROS2 연동 경로도 꺼 두었다. 쓰지 않는 문은 닫아 둔다.)

### 6-6. PX4 의 안전장치는 우리가 건드리지 않는다

| 장치 | 누가 담당 |
|---|---|
| 사전검사 (arm 거부) | **PX4** — 우리는 거부 사유를 `STATUSTEXT` 로 읽을 뿐 |
| 조종기 상실 페일세이프 | **PX4** (`NAV_RCL_ACT`) |
| 데이터링크 상실 페일세이프 | **PX4** (`NAV_DLL_ACT`) |
| 배터리 페일세이프 | **PX4** (`COM_LOW_BAT_ACT`) |
| 지오펜스 | **PX4** (`GF_ACTION`) |

라즈베리파이는 이 중 어느 것도 대신하지 않는다. **안전의 최종 책임은 FC 와 조종기에 있다.**
현재 설정값은 [`scripts/failsafe_audit.py`](scripts/failsafe_audit.py) 로 확인한다.

---

## 7. MQTT 가시화 브리지

가시화 웹이 드론 상태를 보게 하는 경로다. **서버를 거치지 않는 온디바이스 직통**이다.

```
[브라우저]  ──ws://pi3.local:9001──▶  [pi3 의 mosquitto]  ◀──1883──  [drone-node]  ◀──UDP 14543──  [라우터]
```

**왜 브로커가 파이에 있나** — 현장 망이 자주 바뀐다. 브로커가 노트북이나 서버에 있으면
그 주소가 바뀔 때마다 설정을 고쳐야 하고, 그 장비가 꺼지면 경로가 통째로 죽는다.
파이는 기체와 같은 자리에 있고 `pi3.local` 이라는 이름이 IP 변화와 무관하다.

| 항목 | 값 |
|---|---|
| 장비 ID | `x500-001` |
| 상태 토픽 | `zoneA/drone/x500-001/...` |
| 명령 토픽 | `terminal/x500-001/downlink` · `uplink` |
| 브라우저용 | `ws://pi3.local:9001` (WebSocket) |
| 말단용 | `127.0.0.1:1883` |

### ⚠ 웹에서는 드론을 조종할 수 없다 — 의도된 설계다

선언된 명령은 **`ping` 하나뿐**이다. arm 도 takeoff 도 없다.
브리지는 FC 로 **0 바이트**를 보낸다. 규약은 [`CONTRACT_x500.md`](CONTRACT_x500.md) 참고.

또 하나의 규칙: **FC 가 없을 때 마지막 값을 현재값처럼 재사용하지 않는다.**
`fc_link:false` 와 함께 battery·gps·attitude 를 전부 `null` 로 보낸다.
낡은 값이 현재 상태처럼 보이는 것이 값이 없는 것보다 위험하다.

---

## 8. 스크립트 — 위험도별

전부 `~/drone/venv/bin/python` 으로 실행한다 (시스템 python 아님).

### 🟢 읽기 전용 — 마음 놓고 실행

| 스크립트 | 하는 일 | 포트 |
|---|---|---|
| [`check_link.py`](scripts/check_link.py) | 링크 확인, 메시지 주기 측정, 파라미터 읽기 | 14540 |
| [`telemetry_watch.py`](scripts/telemetry_watch.py) | 상태 1Hz 출력 | 14540 |
| [`attitude_watch.py`](scripts/attitude_watch.py) | 자세 변화 관찰 (기울임 시험용) | 14540 |
| [`fc_state.py`](scripts/fc_state.py) | **arm 가능 상태인지** 한 번에 확인 | **5760** |
| [`failsafe_audit.py`](scripts/failsafe_audit.py) | **페일세이프 설정 감사** | **5760** |

> 14540 을 쓰는 셋은 서로 포트를 다툰다 — **한 번에 하나만.**
> 5760 을 쓰는 둘은 다른 것과 동시에 돌려도 된다.

### 🔴 기체가 움직인다 — 사람이 판단해서 실행

| 스크립트 | 하는 일 |
|---|---|
| [`arm_disarm_test.py`](scripts/arm_disarm_test.py) | arm → 3초 → disarm. **프로펠러 제거 필수** |
| [`takeoff_land.py`](scripts/takeoff_land.py) | 1.5m 이륙 → 8초 → 착륙. **조종기 필수** |

둘 다 `yes` 를 직접 입력해야 진행되고, 터미널이 아니면 거부한다.

### 🧪 시험 도구

[`fake_fc.py`](scripts/fake_fc.py) — FC 없이 MAVSDK 경로를 시험하는 가짜 기체.
실물 FC 가 붙어 있으면(`mode=drone`) 스스로 실행을 거부한다.

---

## 9. 디렉터리

```
~/drone/
├── README.md                    이 문서
├── FLIGHT_CHECKLIST_x500.md     ★ 실제 비행할 때 보는 현장 절차서
├── CONTRACT_x500.md             MQTT 규약 (백엔드·웹과의 약속)
├── PROGRESS.md                  전체 작업 이력 (맨 뒤가 최신)
├── SETUP_REPORT.md              환경 세팅 결과 보고서
├── config/
│   ├── drone.env → /etc/drone-node.env    장치 경로·포트·타임아웃
│   ├── mavlink-router.conf                라우터 창구 설정
│   ├── mosquitto-hw.conf                  MQTT 브로커 설정
│   └── requirements.lock.txt              ⚠ mavsdk 업그레이드 금지 사유 포함
├── scripts/                     위 8절 참고
├── systemd/                     유닛 파일 원본
├── state/mode                   현재 상태 (drone / none)
├── logs/                        linkmon 기록
└── venv/                        파이썬 환경
```

가시화 브리지 코드만 다른 곳에 있다: `~/hw/pi/drone/` (공통 노드 틀을 상속하기 때문)

---

## 10. 빠른 시작

```bash
# 지금 FC 가 붙어 있나?
cat ~/drone/state/mode                    # drone 이면 연결됨

# 무슨 일이 벌어지고 있나?
systemctl status drone-detect
tail -20 ~/drone/logs/linkmon.log

# FC 상태 한 번 보기 (읽기 전용)
cd ~/drone && ./venv/bin/python scripts/fc_state.py

# 실시간 상태
./venv/bin/python scripts/telemetry_watch.py
```

**비행시킬 거라면 [`FLIGHT_CHECKLIST_x500.md`](FLIGHT_CHECKLIST_x500.md) 를 연다.**

---

## 11. 이 저장소를 관통하는 원칙

1. **기본은 읽기 전용이다.** 움직이는 스크립트는 둘뿐이고, 자동 실행에는 하나도 없다
2. **자동 실행되는 것은 아무것도 조종하지 않는다.** 부팅 시 뜨는 건 통신 준비와 상태 확인까지다
3. **FC 파라미터는 읽기만 한다.** 변경은 사람이 QGC 로만
4. **약속이 아니라 구조로 막는다.** `DevicePolicy=closed` 로 애초에 못 열게 한다
5. **모르는 값을 지어내지 않는다.** FC 가 없으면 `null` 을 보낸다
6. **고장은 스스로 회복한다.** 드론은 사람이 손을 못 대는 자리에 있다
7. **판단 근거를 남긴다.** 왜 그렇게 했는지가 `PROGRESS.md` 에 전부 있다

---

## 12. 자주 부딪히는 함정

| 함정 | 결과 | 답 |
|---|---|---|
| `/dev/serial0` 을 씀 | 아무것도 안 들어옴 | `/dev/ttyAMA0` 을 쓴다 |
| `pip install -U mavsdk` | 제어 스크립트 3개가 전부 깨짐 | `config/requirements.lock.txt` 로 복구 |
| 파라미터가 전부 `0` 으로 보임 | PX4 는 INT 를 **비트 그대로** 싣는다 | `struct.unpack('<i', struct.pack('<f', v))[0]` |
| 14540 스크립트 두 개 동시 실행 | 뒤에 뜬 쪽이 연결 실패 | 한 번에 하나만 |
| `pkill -f <패턴>` | **자기 셸까지 죽음** (명령줄에 패턴이 들어 있어서) | 패턴을 `fake_[f]c` 처럼 쓴다 |
| `EnvironmentFile` 에 `값 # 주석` | 주석까지 값이 됨 | 설명은 윗줄에 |

---

## 13. 관련 문서

| 문서 | 언제 |
|---|---|
| [`FLIGHT_CHECKLIST_x500.md`](FLIGHT_CHECKLIST_x500.md) | **비행할 때** |
| [`CONTRACT_x500.md`](CONTRACT_x500.md) | 웹·백엔드 연동할 때 |
| [`SETUP_REPORT.md`](SETUP_REPORT.md) | 환경을 다시 만들 때 |
| [`PROGRESS.md`](PROGRESS.md) | 원인을 못 찾을 때 (맨 뒤가 최신) |
