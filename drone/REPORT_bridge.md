# 구현 보고서 — pi3 드론 MQTT 가시화 브리지

> 작성 2026-09-21 · 장비 X500 v2 (PX4 / 코아 H743) + Raspberry Pi 5 `pi3` · 작업자 AI 에이전트
> 범위: 0~4단계 완료. 5단계(실물 검증)는 기체 재연결 후.
> 관련 문서: 조사 `STEP0_REPORT_bridge.md` · 계약 `CONTRACT_x500.md` · 경과 `PROGRESS.md`

---

## 1. 무엇을 했나

가시화 웹이 **pi3 의 브로커에 직접 붙어** 드론의 연결 상태·배터리·드론 상태를 보게 만들었다.
Go1(`pi7`)과 같은 구조다 — 서버를 거치지 않는 온디바이스 직통이고, 웹은 연결 주소를
`ws://pi7.local:9001` → `ws://pi3.local:9001` 로 바꾸면 드론에 붙는다.

**제어 명령은 범위 밖이다.** 선언한 action 은 `ping` 하나뿐이고, 브리지는 FC 로 **0바이트**를
보낸다.

```
  가시화 웹 ──ws://pi3.local:9001──┐
                                  ├─► mosquitto (pi3, 1883 + 9001)
  도구/백엔드 ──tcp:1883──────────┘        ▲
                                           │ 상태 JSON 1Hz / 규약 protobuf
                                    drone-node.service
                                           ▲ udp 14543 (수신 전용)
                                    mavlink-router ──uart 921600──► FC TELEM2
```

---

## 2. 범용성 증거 — 이번 작업의 핵심 숫자

캡스톤2의 주장은 "신규 장비 1대 연결 = 어댑터 1파일"이다. 이번이 그 실증이다.

| 항목 | 수 |
|---|---|
| **공통 틀(`~/hw/pi/common/`) 수정** | **0 줄** |
| **`.proto` 스키마 수정** | **0 줄** |
| 기존 Go1 코드(`pi/robot/`) 수정 | 0 줄 |
| 새로 만든 어댑터 파일 | **2개** (+ 빈 패키지 표시 1개) |
| 어댑터 코드 줄 수 | 571줄 (주석·설계 근거 포함) |

저장소에서 직접 확인한 증거:

```
$ cd ~/hw && git status --porcelain
?? pi/drone/
```

**추적 중인 파일의 변경이 0건이다.** 새 디렉터리 하나만 늘었다.

| 새 파일 | 줄 | 역할 |
|---|---|---|
| `~/hw/pi/drone/drone_link.py` | 348 | MAVLink 수신 전용 링크. `robot/go1_link.py` 자리 |
| `~/hw/pi/drone/drone_node.py` | 223 | `BaseNode` 상속 노드. `robot/robot_node.py` 자리 |
| `~/hw/pi/drone/__init__.py` | 0 | 패키지 표시 |

재사용한 것: 브로커 접속·clientId·LWT·Capability 발행·명령 멱등·deadline·취소·미선언 거부·
재접속 백오프·두절 버퍼·식별자 갱신·관측 지표 — 전부 `common/` 이 그대로 해 준다.

pi3 기존 자산도 다시 짜지 않고 가져다 썼다:

| 가져다 쓴 것 | 출처 |
|---|---|
| `is_vehicle_heartbeat()` — FC heartbeat 판별(sysid+compid, autopilot≠INVALID) | `~/drone/scripts/dronelink.py` |
| `decode_px4_custom_mode()` — `0x03040000` → `AUTO.LOITER` | `~/drone/scripts/check_link.py` |

---

## 3. 만든 것 · 바꾼 것 전부

### 새로 만든 것

| 파일 | 용도 |
|---|---|
| `~/hw/pi/drone/{drone_link.py, drone_node.py, __init__.py}` | 어댑터 |
| `~/drone/config/mosquitto-hw.conf` → `/etc/mosquitto/conf.d/hw.conf` | 브로커 설정 |
| `~/drone/config/hw-node.env` → `/etc/hw-node.env` | 공통 노드 설정 |
| `~/drone/config/hw-drone.env` → `/etc/hw-drone.env` | 드론 노드 설정 |
| `~/drone/config/zone_id` → `/etc/zone_id` | 구역(`zoneA`) |
| `~/drone/systemd/drone-node.service` → `/etc/systemd/system/` | 부팅 자동 시작 |
| `~/drone/STEP0_REPORT_bridge.md` | 0단계 조사 보고 |
| `~/drone/CONTRACT_x500.md` | 웹 쪽이 읽을 계약 |
| `~/hw/` (저장소 clone, 브랜치 `HW`, HEAD `02241ac`) | Go1 노드 코드 |

설치 패키지: `mosquitto 2.0.21-1`, `mosquitto-clients 2.0.21-1` (+ 의존 `libwebsockets19t64` 등).
파이썬 의존은 추가 설치가 없었다 — `~/drone/venv` 에 `paho-mqtt 2.1.0`·`protobuf 7.36.2` 가 이미 있었다.

### 바꾼 것 (백업 있음)

| 대상 | 전 | 후 | 백업 |
|---|---|---|---|
| `~/drone/config/mavlink-router.conf` | UDP 엔드포인트 3개 (14540·14541·14542) | **+7줄, `[UdpEndpoint bridge]` 14543 추가** | `…bak.before-bridge-14543` |
| `/etc/drone-node.env` | `MQTT_HOST=192.168.50.172` (pi7) | `MQTT_HOST=127.0.0.1` (pi7 값은 주석으로 보존) | `/etc/drone-node.env.bak.before-bridge` |
| `~/drone/PROGRESS.md` | — | 브리지 절 추가(전후 기록 포함) | `PROGRESS.md.bak.20260921` |

기존 `drone-*` 유닛·`drone.target`·Tailscale 설정은 **손대지 않았다.**
14540 은 그대로 비워 뒀다 — 나중에 붙일 MAVSDK 제어 코드 자리다.

> 라우터 설정은 드론 모드일 때만 읽힌다. 지금은 FC 가 분리돼 라우터가 내려가 있으므로
> **다음에 `drone.target` 이 뜰 때 새 설정으로 자동 시작한다**(재시작·재부팅 불필요).

---

## 4. 설계 판단 5가지와 근거

### ① `RobotNode` 가 아니라 `BaseNode` 를 직접 상속했다

`RobotNode` 는 `go1_mission`·`media`·`controller_link` 에 묶여 있고, 그 `RobotState`
(`battery_pct, x, y, heading_deg, speed_mps, mode`)에는 **전압·GPS fix·arm 여부·비행 모드를
담을 칸이 없다.** 억지로 끼우면 공통 dataclass 를 고쳐야 했고, 그건 공통 틀 수정이다.
`BaseNode` 를 직접 상속해 공통 생애주기는 전부 재사용하고 상태 필드만 드론 것으로 채웠다.

### ② `ACTIONS` 를 `BASE_ACTIONS` 로 시작하지 않았다

공통 어휘에는 `ping` 과 **`diag` 가 같이** 들어 있다. 그대로 쓰면 Capability 에 두 개가 실린다.
규칙은 "선언하는 action 은 `ping` 하나"이므로 어댑터에서 어휘를 직접 정의했다.
**공통 파일을 고치는 대신 하위 클래스에서 덮어썼다** — 이게 프레임워크가 의도한 확장점이다.

### ③ `entity_type` 을 `drone` 으로 했다

etype 칸은 장비 종류를 구분하려고 있는 자리다. 드론을 `robot` 으로 보내면 종류 정보가 틀어진다.
대신 구독 쪽이 `zoneA/+/+/state` 로 받아야 한다 — 계약 문서 §3·§11 에 명시했다.

코드에서 etype 이 쓰이는 곳을 전부 확인했다: 상태 토픽 2번째 칸, `registration.entity_type`,
OTel `service.name`(관측 미설정이라 비활성) 셋뿐이다. **clientId·규약 토픽·Capability 는
etype 을 쓰지 않는다** — 규약 평면은 `robot` 이든 `drone` 이든 똑같다.

### ④ 주기 상태는 버퍼에 넣지 않는다

공통 층은 두절 시 발행분을 버퍼에 쌓았다가 재전송한다(HW-R-09). 그런데 1Hz 드론 상태를
10분 뒤에 쏟으면 **낡은 상태가 현재처럼 보인다.** 그래서 주기 `state` 는 `allow_spool=False`
(공통 층이 `status` 를 버퍼에서 빼는 것과 같은 이유), 이산 사건(링크 전환·arm·모드·배터리
경보)만 버퍼 대상으로 뒀다. 사건은 빠지면 인과가 끊기기 때문이다.

### ⑤ `drone-node.service` 는 `drone.target` 밖에 둔다

라우터는 FC 가 붙었을 때만 뜬다. 노드가 거기 묶이면 **FC 가 없을 때 노드도 같이 사라져**,
웹은 "드론이 없다"와 "FC 링크만 없다"를 구별할 수 없다. 노드를 `multi-user.target` 에 두고,
FC 유무는 14543 수신 공백 + `~/drone/state/mode` 로 스스로 판정하게 했다.

---

## 5. 안전 — FC 송신 0바이트를 네 겹으로 막았다

| 겹 | 수단 | 확인 |
|---|---|---|
| 1. 프로토콜 | `pymavlink udpin` 소켓. `mav.send()` 를 호출하지 않으면 한 바이트도 안 나간다 | 코드 검색 결과 송신 호출 **0건** (주석·문서에만 등장) |
| 2. 어휘 | Capability 에 `ping` 만. `arm`·`takeoff`·`set_mode` 는 규약 서버가 **실행 로직에 닿기 전에** `UNIMPLEMENTED` 거부 | 실측 캡처 ✅ |
| 3. 어댑터 | `DroneLink.send_command()` 는 `NotImplementedError` 를 던진다(`Go1Link` 과 같은 방어) | 코드 |
| 4. OS | 유닛의 `DevicePolicy=closed` — **시리얼 장치를 열 수조차 없다.** `ProtectSystem=strict`, `NoNewPrivileges=yes` | `systemctl show` ✅ |

추가로 런타임에 재서 보고한다: `status.tx_bytes` (pymavlink `total_bytes_sent`). **0 이 아니면
그 자체가 사건이다.** 웹·감시 쪽에서 이 값 하나만 봐도 된다.

스트림 요청(`SET_MESSAGE_INTERVAL`/`REQUEST_DATA_STREAM`)도 하지 않는다 — FC 의 TELEM2 가
`MAV_1_MODE=Onboard` 라 **요청 없이 21종을 이미 흘려 준다**(0단계 실측).

---

## 6. 검증 결과

### 완료 (1~4단계, FC 분리 상태에서 확인)

| 확인 | 방법 | 결과 |
|---|---|---|
| 브로커 포트 | `ss -tlnp` | `0.0.0.0:1883`, `0.0.0.0:9001` ✅ |
| 1883 왕복 | `mosquitto_pub`→`mosquitto_sub` | 3.1.1 ✅ / MQTT 5.0 ✅ |
| 9001 WebSocket | HTTP Upgrade | `101 Switching Protocols` + `Sec-WebSocket-Protocol: mqtt` ✅ |
| 주소 3개 | 각 주소로 발행 | `pi3.local`(→192.168.50.254) ✅ / `192.168.50.254` ✅ / `100.85.243.54` ✅ |
| 노드 기동 | journal | `entity=x500-001 node=pi3 zone=zoneA type=drone`, `[접속] 127.0.0.1:1883` ✅ |
| Capability | `mosquitto_sub -F %x` | `capability{device_id:"x500-001", actions:["ping"]}` 18B ✅ |
| `ping` | protobuf 발행 → uplink 관찰 | `acceptance(true)`→`status(EXECUTING)`×2→`result{SUCCEEDED, uptime_s, fc_link=0}` ✅ |
| **미선언 `arm`** | 같은 방법 | `acceptance{UNIMPLEMENTED,"action not supported"}`, **`result` 없음** ✅ |
| 상태 주기 | 8초 구독 | `state` 1Hz(8건) / `heartbeat` 5초(2건) / `status` 10초 retained ✅ |
| **FC 없음 표현** | `state` 페이로드 | `fc_link:false`, battery·flight·gps·attitude **전부 `null`** ✅ (마지막 값 재사용 안 함) |
| 급사 감지 | `systemctl kill -s SIGKILL` | 브로커가 `death/offline/fault/reason:lwt` 발행 → 3초 뒤 자동 재시작 `birth` ✅ |
| 자동 시작 | `systemctl is-enabled` | `drone-node` `enabled`, `mosquitto` `enabled` ✅ |
| 제어 코드 없음 | 코드 검색 + 유닛 속성 | 송신 호출 0건, `DevicePolicy=closed` ✅ |
| 공통 틀 무수정 | `git status --porcelain` | 추적 파일 변경 **0건** ✅ |

### 남은 것 (5단계 — 기체 재연결 필요)

| 확인 | 왜 아직 못 했나 |
|---|---|
| 배터리 전압·잔량이 실제와 맞는지 | FC 분리 상태 |
| 기체를 기울이면 자세가 바뀌는지 | 〃 |
| FC 링크 끊김→복구 전환(`reason: fc_link_lost` / `fc_link_up`) | 〃 |
| 수신 중에도 `tx_bytes` 가 0 인지 | 라우터가 내려가 있어 수신 자체가 없다 |
| 다른 PC 에서 `ws://pi3.local:9001` 접속 | 사용자 확인 필요 |
| 배터리 실물 부팅 시 브로커·노드·드론 모드 자동 기동 | 승인 필요 |

---

## 7. 스키마 판단 — `.proto` 를 고칠 필요가 없었다

| 실을 것 | 자리 | 결론 |
|---|---|---|
| 주기 상태(배터리·자세·모드·GPS·경고) | **JSON `state` 채널** — 스키마 자유 | protobuf 와 무관. 고칠 이유 자체가 없다 |
| `ping` 의 FC 링크 유무 | `CommandResult.result` = `map<string,double>` | `fc_link=1.0/0.0` 으로 해결. **모르는 값은 키를 뺀다**(0 은 "쟀더니 0"과 구별 불가) |
| 장비 종류 | `Capability{device_id, actions[]}` 뿐 | ⚠ **자리 없음.** `entity_id`·토픽 etype 칸·`registration.{entity_type, device_type}` 으로 대신했다 |
| 문자열(STATUSTEXT 등) | 규약 응답에 자리 없음 | JSON `state.warnings` 로 보낸다 |

즉 이번 구조에서 **규약(protobuf)은 명령 평면만, 상태는 JSON 평면**이 맡는다. Go1 도 같다.
`Capability` 에 장비 종류를 실을 자리가 없다는 것은 규약의 사실이고, 필요해지면 백엔드와
스키마 확장을 협의할 사항으로 남긴다(이번엔 고치지 않았다).

---

## 8. 남은 문제 · 사람이 확인할 것

| # | 항목 | 내용 |
|---|---|---|
| 1 | **배터리 전류 12.2A** | 디스암 상태인데 12.2A 로 읽혔다(누적 891mAh). 배터리 모니터 전류 스케일 의심. 전압·잔량은 MAVSDK 값과 일치. 계약 문서에 **참고값**으로 표시해 뒀다 |
| 2 | `registration.ip` 가 `127.0.0.1` | 브로커가 자기 자신이라 공통 층의 IP 탐지가 루프백을 고른다. pi7/Go1 도 같은 구조라 같은 값이 나온다. **공통 틀을 고쳐야 바뀌므로 손대지 않았다.** MAC 은 실제 값이라 식별에는 문제없다 |
| 3 | `publish_failures: 2` | 기동 직후 브로커 접속 전 발행 시도 2건. 접속 후 증가하지 않는다. 정상 |
| 4 | 웹 구독 패턴 | `zoneA/robot/...` 을 박아 둔 코드가 있으면 드론이 보이지 않는다. `+` 로 고쳐야 한다 |
| 5 | 보안 | 브로커가 익명 허용으로 `0.0.0.0` 에 열려 있다. 폐쇄망 전제다 — 공개망에 두면 안 된다 |
| 6 | 5단계 미완 | §6 의 "남은 것" 표 |

### 작업 중 걸린 함정 둘 (기록용)

- **systemd `EnvironmentFile` 은 값 뒤 주석을 자르지 않는다.** `HW_DRONE_STATE_INTERVAL=1.0 # 1Hz`
  로 쓰면 주석까지 값이 되어 조용히 기본값으로 떨어진다. 설명을 윗줄로 옮겼다.
- **`xxd` 가 pi3 에 없다.** 계약 문서의 목(mock) 예시가 빈 페이로드를 발행하고 있었다.
  `python3 -c "open(...).write(bytes.fromhex(...))"` 로 바꾸고 실제로 다시 검증했다.

---

## 9. 되돌리는 법

```bash
# 노드·브로커 내리기
sudo systemctl disable --now drone-node mosquitto

# 설정 되돌리기
sudo cp -a /etc/drone-node.env.bak.before-bridge /etc/drone-node.env
cp -a ~/drone/config/mavlink-router.conf.bak.before-bridge-14543 ~/drone/config/mavlink-router.conf
sudo rm -f /etc/systemd/system/drone-node.service /etc/mosquitto/conf.d/hw.conf \
           /etc/hw-node.env /etc/hw-drone.env /etc/zone_id
sudo systemctl daemon-reload
```

기존 `drone-*` 유닛과 `drone.target` 은 이번 작업에서 바뀌지 않았으므로 위 조치만으로
브리지 이전 상태로 돌아간다. 어댑터 코드(`~/hw/pi/drone/`)는 지워도 되고 둬도 된다 —
서비스가 내려가면 실행되지 않는다.
