# 0단계 보고 — pi3 드론 브리지 조사 (2026-09-21)

> 범위: 조사만. **아무것도 바꾸지 않았다.** mavlink-router.conf·systemd 유닛·/etc 파일 전부 무수정.
> 새로 생긴 것: `~/hw`(저장소 clone), 이 파일.

---

## 0-1. Go1 노드 코드 가져오기

| 항목 | 값 |
|---|---|
| 저장소 | `https://github.com/khw18033/Physical-Project-mk2.git` (공개 — 인증 불필요) |
| 브랜치 | `HW` (single-branch) |
| 위치 | `/home/physical/hw` |
| HEAD | `02241ac` "HW: MAC 이 노드마다 갈리던 것 수정 + 컨테이너 타임존" |
| pi7 접촉 | 없음 (꺼져 있음 — 저장소에서만 확인) |

pi3 venv(`~/drone/venv`, Python 3.13.5)에 `paho-mqtt 2.1.0`, `protobuf 7.36.2`가 **이미 있다.**
`~/hw/pi` 에서 `common.*` 임포트·`Identity.resolve()` 실행 성공을 확인했다
(opentelemetry 미설치여도 `[otel] 미설정 — 관측 발신 비활성`으로 정상 동작, `metrics.enabled=False`).
**mosquitto 는 설치돼 있지 않다.**

---

## 0-2. Go1 이 어떻게 붙는가 (코드 확인)

### 두 개의 평면이 따로 돈다 — 이게 핵심이다

| 평면 | 토픽 | 페이로드 | 담당 코드 |
|---|---|---|---|
| **명령 규약** | `terminal/<entity_id>/downlink` (수신) · `/uplink` (발신) | **protobuf** `PhysicalCommandEnvelope` | `common/physical_command.py` |
| **상태 보고** | `{zone}/{etype}/{eid}/status` · `/heartbeat` · `/state` | **JSON** (`common/schema.py envelope()`) | `common/node.py`, `robot/robot_node.py` |

Go1 실값: 명령은 `terminal/go1-001/downlink|uplink`, 상태는 `zoneA/robot/go1-001/{status,heartbeat,state}`.
protobuf 는 **명령 경로에만** 쓰이고, 배터리·자세 같은 상태는 JSON 으로 별도 토픽에 나간다.

### 접속·식별

| 항목 | 코드 | 값 |
|---|---|---|
| 브로커 | `node.py:_connect()` → `config.BROKER_HOST/PORT` | `HW_BROKER_HOST` / `HW_BROKER_PORT`(1883) |
| 프로토콜 | `config.MQTT_V5=1` | MQTT 5.0 |
| clientId | `mqtt.Client(client_id=self.identity.entity_id)` | `go1-001` 그대로 |
| keepalive | `config.KEEPALIVE` | 10초 (브로커 LWT 약 15초) |
| 재접속 | `reconnect_delay_set(1, RECONNECT_MAX_DELAY=10)` | 백오프 상한 10초 |
| LWT(Death) | `will_set("{base}/status", ..., qos=1, retain=True)` | `event=death, device_status=fault, reason=lwt` |
| entity_id 출처 | `schema.Identity.resolve()` | `HW_ENTITY_ID` > `/etc/device_id` |
| 토픽 틀 | `config.TOPIC_TEMPLATE` | `{zone}/{etype}/{eid}` |

### 접속 직후 순서 (`node.py:_on_connect`)

1. `_flap_check()` — 20초 내 3회 재접속이면 device_id 중복 경보
2. `pcmd.start()` → `downlink` 구독(QoS 1) + **Capability 발행**
3. `publish_status("birth")` — JSON status 를 retained 로

### Capability

```python
env.capability.device_id = self.device_id          # = entity_id
env.capability.actions.extend(sorted(owner.ACTIONS.keys()))
```
`uplink` 에 QoS 1 로 발행. 필드는 `device_id`, `actions[]` **둘뿐이다**(proto 73~76행).

### 명령 수신·거부 흐름 (`physical_command.py:_on_command`)

| 순서 | 조건 | 결과 |
|---|---|---|
| 1 | `command_id` 없음 | `acceptance{accepted=false, INVALID_ARGUMENT}` |
| 2 | 같은 id·다른 내용 | `ALREADY_EXISTS` / 같은 내용이면 이전 응답 재송신(재실행 없음) |
| 3 | `deadline_unix_ms` 경과 | `FAILED_PRECONDITION` |
| 4 | **`action not in owner.ACTIONS`** | **`UNIMPLEMENTED`, 실행 스레드 자체를 안 띄움** |
| 5 | `owner.validate()` 예외 | 그 코드로 거부 |
| 6 | 통과 | `accepted=true` → 스레드에서 handler 실행 → `status(EXECUTING)`… → `result` |

→ **미선언 action 은 어댑터 코드에 닿기 전에 거부된다.** `arm`/`takeoff` 가 FC 로 나갈 경로가 구조적으로 없다.

### 로봇 어댑터가 구현하는 인터페이스

`robot/controller_link.py` 의 `ControllerLink` — **메서드 3개뿐**:

| 메서드 | 계약 |
|---|---|
| `read_state() -> RobotState` | 내부 수집. 값이 없으면 **예외를 던진다**(Go1Link: `go1_state_unavailable`, 전부 0이면 `go1_state_zeroed`) |
| `send_command(action, params)` | Go1Link 는 **의도적으로 `NotImplementedError`** — 명령을 안 보낸다 |
| `link_health() -> "ok"\|"degraded"\|"fault"` | 링크 자체 건강. Go1: state 2초·BMS 15초 초과로 판정 |

`RobotState` 는 고정 dataclass: `battery_pct(None 가능), x, y, heading_deg, speed_mps, mode`.

노드(`RobotNode`)가 `BaseNode` 에 채우는 훅: `on_sample`, `on_tick`, `sample_interval`, `next_wakeup`,
`heartbeat_enabled`, `device_status_extra`, `status_extra`, `validate`, `ACTIONS`, `ENTITY_TYPE`.

**Go1Link 가 드론 어댑터의 정확한 선례다** — Go1 내부 MQTT 를 구독만 하고(제어권 탈취 방지),
명령은 막아 두고, 모르는 값은 `None` 으로 낸다. 드론의 "FC 로 0바이트"와 동기가 같다.

### `ping` 응답에 실리는 것

`common/base_actions.py:act_ping` → `yield "completed", {"uptime_s": ...}` 하나뿐.
규약 서버가 이걸 `CommandResult.result`(**`map<string,double>`**)로 옮긴다.
`BASE_ACTIONS = {"ping", "diag"}` 이므로 **가만히 두면 `diag` 도 Capability 에 실린다.**

### Go1 은 상태를 웹에 어떻게 보내는가 — **주기 발행, JSON, 별도 토픽**

| 채널 | 토픽 | 주기 | QoS | retained | 내용 |
|---|---|---|---|---|---|
| `state` | `zoneA/robot/go1-001/state` | 임무 중 20Hz / 대기 **5초**(`ROBOT_STATE_INTERVAL_IDLE`) | 0 (`ROBOT_STATE_QOS`) | × | `battery_pct`, `position{x,y,heading_deg}`, `speed_mps`, `robot_mode`, `device_status`, `internal_seq`, `reason` |
| `state`(이산) | 같음 | 사건 즉시 | 1 | × | `reason=mode_changed` / `battery_low` |
| `status` | `…/status` | 10초 + birth/rebirth/shutdown/LWT | 1 | **○** | `registration{entity_id,node_id,zone_id,entity_type,device_type,fw_version,mac,ip}`, `device_status`, `uptime_s`, `buffer`, `status_extra()` |
| `heartbeat` | `…/heartbeat` | 5초 (임무 중 억제) | 0 | × | 봉투만 |

공통 봉투: `schema_version, source_id, node_id, zone_id, timestamp(RFC3339 ms), session_id, sequence_id`.
**결측 규칙(`common/schema.py`)**: 모르는 값은 `null`, 0/-1/"" 금지. 오래된 값은 `*_age_s` 동반.
(Go1 이 전부 0인 프레임을 올려 배터리 0% 오발동을 낸 사고에서 나온 규칙 — 드론에 그대로 적용된다.)

### env 파일 키

`/etc/hw-node.env` (공통, `pi/deploy/hw-node.env.example`)

| 키 | 값(pi7) |
|---|---|
| `HW_BROKER_HOST` | `127.0.0.1` (pi7 자신이 브로커) |
| `HW_BROKER_PORT` | `1883` |
| `HW_ZONE_ID` | `zoneA` |
| (주석) `HW_HB_INTERVAL`, `HW_REPORT_INTERVAL_NORMAL`, `HW_OTEL_ENDPOINT`, `HW_TLS_CA` | 비움 |

`/etc/hw-robot.env` (로봇 전용, 공통값을 덮어씀)

| 키 | 값(pi7) |
|---|---|
| `HW_CONTROLLER_LINK` | `go1` |
| `HW_ENTITY_ID` | `go1-001` |
| `HW_ENTITY_TYPE` | `robot` |
| `HW_DEVICE_TYPE` | `go1_robot` |

`robot-node.service`: `WorkingDirectory=/home/physical/hw/pi`, `ExecStart=~/venv/bin/python3 -u -m robot.robot_node`,
`EnvironmentFile=-/etc/hw-node.env` → `-/etc/hw-robot.env`, `StateDirectory=hw-node`,
`HW_SPOOL_PATH=/var/lib/hw-node/robot-spool.jsonl`, `Restart=always`, `After=network-online.target chrony.service`.

> pi7 의 **실제** `/etc/*.env` 값은 확인하지 못했다(pi7 전원 off). 위 표는 저장소 example 기준이다.

### mosquitto 설정 (`pi/deploy/mosquitto-hw.conf` → `/etc/mosquitto/conf.d/hw.conf`)

```
listener 1883 0.0.0.0
allow_anonymous true
listener 9001 0.0.0.0
protocol websockets
max_keepalive 300
```
주석의 경고 두 가지: ① 기본 `mosquitto.conf` 에 있는 `persistence`/`log_dest` 를 중복 기재하면
기동 실패 ② https 페이지에서 `ws://` 는 mixed content 로 차단된다.

---

## 0-3. 드론 상태로 무엇을 보낼 수 있는가

**측정 방법**: 라우터의 비어 있던 14540 자리에 `pymavlink udpin` 으로 붙어 20초간 **받기만** 했다
(udpin 은 호출하지 않으면 1바이트도 보내지 않는다 — 14543 브리지와 같은 방식). QGC 는 미접속 상태였다.
이어서 `telemetry_watch.py`(MAVSDK, 읽기 전용) 로 같은 값을 교차 확인했다.

### 실측 스트림 (2026-09-21, 20.0초, 무선 지상국 없음)

| 메시지 | 실측 Hz | 메시지 | 실측 Hz |
|---|---|---|---|
| ATTITUDE | 99.86 | EXTENDED_SYS_STATE | 5.00 |
| ATTITUDE_QUATERNION | 50.03 | **SYS_STATUS** | **5.00** |
| HIGHRES_IMU | 49.98 | **HEARTBEAT** | **1.00** |
| LOCAL_POSITION_NED | 29.99 | ESTIMATOR_STATUS | 1.00 |
| ALTITUDE / VFR_HUD / **GPS_RAW_INT** | 10.00 | SCALED_PRESSURE / MISSION_CURRENT | 1.00 |
| TIMESYNC / ATTITUDE_TARGET / SERVO_OUTPUT_RAW / POSITION_TARGET_LOCAL_NED | 10.00 | **BATTERY_STATUS** | **0.50** |
| | | VIBRATION | 0.50 |

송신자는 `(sysid=1, compid=1)` = FC 단독(6,319건). `(0,0)` 20건은 PING.
**PROGRESS.md 기록(BATTERY_STATUS 0.6Hz)보다 스트림이 넓다** — 요청 없이 21종이 들어온다.
STATUSTEXT 는 20초 동안 0건(정상 유휴 상태에서는 잘 안 온다 — 이벤트 때만).

### 뽑을 수 있는 항목과 실제 값

| 분류 | 항목 | 메시지·필드 | 실측값 (pi3, 실내, 디스암) | 없을 때 |
|---|---|---|---|---|
| 연결 | FC 링크 유무 | HEARTBEAT 수신 여부 (`is_vehicle_heartbeat`, autopilot=12=PX4) | 1.00Hz 수신 중 | `fc_link=false` |
| 연결 | 마지막 heartbeat 경과 | 수신 시각 차 | 0~1초 | `null` |
| 연결 | 드론 모드 여부 | `~/drone/state/mode` | `drone` | 파일 없음 = `none` |
| 배터리 | 전압 | SYS_STATUS `voltage_battery` mV | **15752 → 15.75V** | `null` |
| 배터리 | 전류 | SYS_STATUS `current_battery` cA | 1220 → 12.20A (**과대 의심 — 디스암 상태**) | `null` |
| 배터리 | 잔량 | SYS_STATUS `battery_remaining` % | **74%** | `null`(-1 이면 모름) |
| 배터리 | 보조 | BATTERY_STATUS `voltages[0]`=15750mV, `current_battery`=1194cA, `current_consumed`=891mAh, `temperature`=32767(=모름) | 일치 | `null` |
| 상태 | arm 여부 | HEARTBEAT `base_mode & 128`(SAFETY_ARMED) | base_mode=29 → **DISARMED** | `null` |
| 상태 | 비행 모드 | HEARTBEAT `custom_mode` + `check_link.decode_px4_custom_mode()` | 0x03040000 → **AUTO.LOITER**(MAVSDK 표기 `HOLD`) | `null` |
| 상태 | 착륙/공중 | EXTENDED_SYS_STATE `landed_state` | 1 = ON_GROUND | `null` |
| 상태 | system_status | HEARTBEAT `system_status` | **0 = UNINIT** (arm 판정에 쓰면 안 된다 — base_mode 비트를 쓴다) | — |
| 위치 | GPS fix | GPS_RAW_INT `fix_type` | **0 = NO_GPS** (실내) | `null` |
| 위치 | 위성 수 | GPS_RAW_INT `satellites_visible` | **0** | `null` |
| 위치 | 위도·경도 | GPS_RAW_INT `lat/lon` | 0,0 (**fix 없음 → 값으로 보내면 안 된다**) | `null` |
| 위치 | 추정 정상 | ESTIMATOR_STATUS `flags`=165, `pos_horiz_accuracy`=0.0128, `vel_ratio`=nan | 수평 추정 비활성 | `null` |
| 고도 | 상대/기압 | ALTITUDE `altitude_relative` / VFR_HUD `alt` | -0.518m / 153.86m | `null` |
| 자세 | roll·pitch·yaw | ATTITUDE (rad) | r=-0.29° p=+1.46° **y=108.5°** | `null` |
| 경고 | 최근 경고 | STATUSTEXT `severity`,`text` | 20초간 0건 | 빈 배열 |

MAVSDK 교차 확인: `arm=DISARMED 모드=HOLD 자세 r=-0.26 p=1.48 y=108.53 배터리=15.75V 74% GPS=X home=X`.

---

## 0단계 판단 — 요구된 세 가지

### ① Go1 의 상태 보고 방식과 드론 적용 가능 여부

**그대로 쓸 수 있다.** Go1 은 protobuf 가 아니라 **JSON 을 `{zone}/{etype}/{eid}/state` 에 주기 발행**하고,
retained `status` 로 등록·요약을 낸다. 드론도 `BaseNode.publish()` 를 그대로 호출하면 같은 모양이 나온다.
주기만 드론에 맞춘다(요구 1~2Hz → `state` 0.5~1초, Go1 대기 5초보다 빠르게).
"모르면 `null`" 규칙이 이미 공통 층에 박혀 있어서, **FC 링크가 끊겼을 때 배터리를 `null` 로 보내라**는
이번 요구가 기존 규칙과 정확히 같다(마지막 값을 현재 값처럼 보내지 않는다).

⚠ **확인 필요 — 웹이 무엇을 구독하는가.** 저장소에 웹 코드가 없다. 웹이 상태를 보려면
`terminal/x500-001/uplink`(protobuf, 명령 응답 전용)가 아니라 **JSON `state`/`status` 토픽**을 구독해야 한다.
그리고 그 토픽에는 `{etype}` 이 들어간다:
- `HW_ENTITY_TYPE=robot` → `zoneA/robot/x500-001/state` (웹이 Go1 용 구독 패턴을 그대로 쓰면 바로 잡힌다)
- `HW_ENTITY_TYPE=drone` → `zoneA/drone/x500-001/state` (정직하지만 웹이 `zoneA/robot/+` 를 구독 중이면 안 보인다)

→ **2단계 시작 전에 결정이 필요하다.** 기본안은 `drone` + 웹에 `zoneA/+/+/state` 와일드카드 구독을 요청(계약 문서에 명시).

### ② 스키마 안에 드론 상태를 실을 자리가 있는가

| 실을 것 | 자리 | 판정 |
|---|---|---|
| 주기 상태(배터리·자세·모드·GPS) | JSON `state` 채널 — **스키마 자유** | ✅ `.proto` 무관 |
| `ping` 응답의 FC 링크 | `CommandResult.result` = `map<string,double>` | ✅ 단 **숫자만** → `fc_link=1.0/0.0`, `hb_age_s`, `batt_v` 식으로. `null` 을 못 실으므로 **모르면 키를 뺀다** |
| 장비 종류(kind=drone) | `Capability{device_id, actions[]}` 뿐 — **문자열 자리 없음** | ⚠ Capability 로는 불가. `entity_id="x500-001"` 과 JSON `status.registration{entity_type, device_type=x500_drone}` 로 드러낸다 |
| STATUSTEXT 같은 문자열 | 명령 응답에는 자리 없음(`detail` 문자열은 `CommandStatus` 뿐) | JSON `state` 로 보낸다 |

**결론: `.proto` 를 고칠 필요가 없다.** 드론 상태는 애초에 protobuf 경로로 가지 않는다.
다만 Capability 에 장비 종류를 실을 자리는 **없다**는 것이 규약의 사실이고, 그건 JSON 등록 정보로 대신한다.

### ③ 어댑터 1파일로 끝나는가

**공통 틀(`pi/common/*`) 수정은 필요 없다.** 새 파일만 추가하면 된다.

| 새로 만들 것 | 이유 |
|---|---|
| `pi/robot/drone_link.py` | `Go1Link` 자리. mavlink-router UDP 14543 을 `pymavlink udpin` 으로 **구독만** 하고, `~/drone/scripts/dronelink.py` 의 `is_vehicle_heartbeat` 를 가져다 쓴다. `send_command()` 는 Go1Link 처럼 `NotImplementedError` |
| `pi/robot/drone_node.py` | `BaseNode` 상속. `ENTITY_TYPE`, `ACTIONS={"ping": act_ping}`(→ Capability 에 `ping` 만), `on_tick` 1~2Hz `state` 발행, `status_extra`, `device_status_extra` |

한 파일로 합치는 것도 가능하다(`drone_node.py` 안에 링크 클래스 동거). **2파일을 권한다** — Go1 의
`go1_link.py` ↔ `robot_node.py` 분리를 그대로 따르는 편이 "어댑터 1개 = 링크 1개" 주장과 모양이 맞는다.

**`RobotNode` 를 상속하지 않는 이유**: `RobotNode` 는 `go1_mission`·`media`·`controller_link.create()` 에 묶여 있고,
`RobotState` dataclass(`battery_pct, x, y, heading_deg, speed_mps, mode`)에는 **전압·GPS fix·arm·비행모드를 담을 칸이 없다.**
`BaseNode` 를 직접 상속하면 공통 생애주기(LWT·Capability·멱등·UNIMPLEMENTED·spool·재접속)는 전부 재사용하면서
드론 고유 필드는 자유롭게 넣을 수 있다. **이 경로에 공통 틀 수정은 한 줄도 없다.**

세부 주의 3가지:
1. `BASE_ACTIONS` 에 `diag` 가 들어 있다. 규칙 2(`ping` 만)를 지키려면 어댑터에서
   `ACTIONS = {"ping": act_ping}` 로 **덮어쓴다**(공통 파일 수정 아님).
2. spool 파일은 `HW_SPOOL_PATH` 로 분리한다(`/var/lib/hw-node/drone-spool.jsonl`).
3. `heartbeat_enabled()` 는 기본 True 로 둔다(드론은 임무 개념이 없다).

---

## 1~2단계 들어가기 전 확인·결정 사항

| # | 항목 | 내용 |
|---|---|---|
| 1 | **웹 구독 토픽** | 상태는 JSON `{zone}/{etype}/{eid}/state`. `etype` 을 `drone` 으로 할지 `robot` 으로 할지, 웹이 와일드카드를 쓰는지 확인 필요 (①번 참조) |
| 2 | zone | pi3 에 `/etc/zone_id` 없음 → 기본 `zoneA`. Go1 과 같은 구역으로 둘지 |
| 3 | mosquitto 설치 | 미설치. 1단계에서 `apt install mosquitto mosquitto-clients` 필요(네트워크 사용) |
| 4 | 배선 | `/etc/drone-node.env` 의 `MQTT_HOST=192.168.50.172`(pi7) → `127.0.0.1` 교체는 2단계 예정. 지금은 **미수정** |
| 5 | 라우터 | 14543 엔드포인트 **아직 추가하지 않았다**. 2단계에서 `mavlink-router.conf` 에 `[UdpEndpoint bridge] Mode=Normal / 127.0.0.1 / 14543` 1블록 추가 → 라우터 재시작 필요(재부팅 아님) |
| 6 | 전류값 | 디스암 상태에서 12.2A 로 읽힌다. 배터리 모니터 스케일 오차 가능 — 전압·잔량과 달리 전류는 **참고값**으로만 싣는 것을 권한다 |
| 7 | 주소 | pi3: `pi3.local` / 랩 `192.168.50.254` / Tailscale `100.85.243.54`. 4단계 계약 문서에 3개 다 적는다 |

## 검증 가능한 예시 페이로드 (실제 직렬화, 아직 발행하지 않음)

| 메시지 | hex |
|---|---|
| `Capability{x500-001, [ping]}` (18B) | `3a100a08783530302d303031120470696e67` |
| `Command{cmd-1, target=x500-001, ping}` | `0a170a05636d642d311208783530302d3030311a0470696e67` |
| `Acceptance{cmd-1, true}` | `1a090a05636d642d311001` |
| `Result{cmd-1, SUCCEEDED, uptime_s=12.3, fc_link=1.0}` | `2a320a05636d642d3110011a130a08757074696d655f73119a999999999928401a120a0766635f6c696e6b11000000000000f03f` |
| `Acceptance{cmd-2, false, UNIMPLEMENTED}` (arm 거부 예상 모습) | `1a2e0a05636d642d321a250a0d554e494d504c454d454e5445441214616374696f6e206e6f7420737570706f72746564` |

---

**승인 대기.** 1단계(mosquitto 설치·설정)부터는 시스템을 바꾸므로 지시가 있을 때까지 진행하지 않는다.
