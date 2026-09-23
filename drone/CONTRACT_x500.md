# 드론 연결 계약 — X500 v2 (`x500-001`) @ pi3

> 대상: 가시화 웹 쪽 AI·개발자 · 작성 2026-09-21 · 장비: X500 v2 (PX4, 코아 H743) + Raspberry Pi 5 `pi3`
> **여기 적힌 값은 전부 실제로 브로커에서 캡처하거나 코드에서 확인한 것이다.** 추정값은 없다.
> 확인하지 못한 항목은 §9 에 따로 모아 두었다(기체 전원이 분리된 상태에서 작업했다).

이 문서 하나로 목(mock)을 만들어 붙였다 뗄 수 있게 쓴다. 실제 페이로드 hex 는 §8.

---

## 0. 한 줄 요약

Go1(`pi7`)과 **같은 구조**다. 웹은 연결 관리의 주소를 `ws://pi7.local:9001` 대신
`ws://pi3.local:9001` 로 바꾸면 드론에 붙는다. 다만 **상태 토픽의 두 번째 칸이 `robot` 이
아니라 `drone`** 이다 — 구독 패턴에서 이 칸을 `+` 로 받아야 한다(§3).

**이번 범위는 보기만 하는 것이다.** 선언된 명령은 `ping` 하나뿐이고, 그 외 모든 action 은
`UNIMPLEMENTED` 로 거부된다. 브리지는 FC 로 **0바이트**를 보낸다.

---

## 1. 브로커

| 항목 | 값 | 확인 |
|---|---|---|
| 이름(mDNS) | `pi3.local` | `getent hosts pi3.local` → `192.168.50.254` ✅ |
| 연구실 IP | `192.168.50.254` | 1883 pub ✅ / 9001 `101 Switching Protocols` ✅ |
| Tailscale IP | `100.85.243.54` | 1883 pub ✅ |
| TCP(말단·백엔드·도구) | **1883** | MQTT 3.1.1·5.0 왕복 ✅ |
| WebSocket(브라우저) | **9001** | `Sec-WebSocket-Protocol: mqtt`, `101` ✅ |
| 인증 | **없음**(`allow_anonymous true`) | `/etc/mosquitto/conf.d/hw.conf` |
| 프로토콜 | MQTT 5.0 권장(3.1.1 도 붙는다) | 노드는 MQTT 5.0 을 쓴다 |
| `max_keepalive` | 300 | — |

⚠ **https 로 서비스되는 페이지에서는 `ws://` 가 mixed content 로 차단된다.** 웹을 http 로
띄우거나, 브로커에 TLS(wss)를 붙여야 한다(인증서 준비 후).

---

## 2. 식별자

| 항목 | 값 |
|---|---|
| entity_id (= MQTT clientId = 규약 device_id) | **`x500-001`** |
| node_id | `pi3` |
| zone_id | `zoneA` (pi7 과 같은 구역) |
| entity_type | **`drone`** |
| device_type | `x500_drone` |
| MAC | `2c:cf:67:e7:cf:67` |

⚠ **clientId 는 브로커에서 유일해야 한다.** 웹이 `x500-001` 로 붙으면 노드를 밀어낸다
(노드가 20초 내 3회 재접속을 감지하면 치명 경보를 찍는다). 웹은 `web-<임의값>` 처럼 다른
clientId 를 쓸 것.

---

## 3. 토픽 — 두 평면이 따로 돈다

### 3-1. 상태 보고 (JSON) — 웹이 화면에 그릴 것

전체 패턴은 **`{zone}/{entity_type}/{entity_id}/{channel}`** 이다.

| 채널 | 이 드론의 실제 토픽 | 주기 | QoS | retained |
|---|---|---|---|---|
| `status` | `zoneA/drone/x500-001/status` | 10초 + 등록/종료/급사 | 1 | **○** |
| `state` | `zoneA/drone/x500-001/state` | **1Hz** + 사건 즉시 | 1 | × |
| `heartbeat` | `zoneA/drone/x500-001/heartbeat` | 5초 | 0 | × |

> **구독자는 두 번째 칸(entity_type)을 `+` 로 받아야 한다.**
> ```
> zoneA/+/+/state      ← 권장 (기종·장비가 늘어도 그대로)
> zoneA/+/+/status
> ```
> `zoneA/robot/+/state` 처럼 `robot` 을 박아 두면 **드론이 보이지 않는다.** 이 칸은 장비
> 종류를 구분하려고 있는 자리이고, 드론을 `robot` 으로 보내면 종류 정보가 틀어지므로
> 노드 쪽이 아니라 구독 쪽을 `+` 로 고치는 것이 맞다.

### 3-2. 명령 규약 (Protobuf) — `ping` 만

| 방향 | 토픽 | QoS |
|---|---|---|
| 웹 → 드론 | `terminal/x500-001/downlink` | 1 |
| 드론 → 웹 | `terminal/x500-001/uplink` | 1 |

토픽에는 **방향만** 담긴다. 메시지 종류는 봉투의 `oneof body` 가 결정한다.
스키마는 저장소 `HW` 브랜치의 `schema/physical_command.proto` **한 파일이 전부**이며,
**이번 작업에서 고치지 않았다.**

---

## 4. Capability — 접속하면 자동으로 온다

노드가 브로커에 붙는 즉시 `uplink` 로 발행한다(QoS 1, retained 아님 —
**늦게 붙은 웹은 못 받는다.** 필요하면 `ping` 을 한 번 보내 생존을 확인할 것).

```
capability {
  device_id: "x500-001"
  actions: "ping"
}
```
hex (18B): `3a100a08783530302d303031120470696e67`

**선언된 action 은 `ping` 하나뿐이다.** `diag` 도, 정지(`abort`)도 없다 — 드론 정지는
조종기가 맡는다. 미선언 action 은 §6 처럼 거부된다.

---

## 5. `ping` — 요청과 응답 (실제 캡처)

### 요청 (웹 → `terminal/x500-001/downlink`)

```
command {
  command_id: "live-ping-1"     # 재전송 식별용. 같은 id 를 다시 보내면 재실행 없이 이전 응답이 온다
  target: "x500-001"
  action: "ping"
}
```
hex: `0a1d0a0b6c6976652d70696e672d311208783530302d3030311a0470696e67`

### 응답 (드론 → `terminal/x500-001/uplink`) — 4건이 순서대로 온다

| # | 메시지 | hex |
|---|---|---|
| 1 | `acceptance{command_id:"live-ping-1", accepted:true}` | `1a0f0a0b6c6976652d70696e672d311001` |
| 2 | `status{state:"EXECUTING"}` | `22180a0b6c6976652d70696e672d311209455845435554494e47` |
| 3 | `status{state:"EXECUTING", detail:"executing"}` | `22230a0b6c6976652d70696e672d311209455845435554494e471a09657865637574696e67` |
| 4 | `result{status:SUCCEEDED, result{uptime_s:3.8, fc_link:0}}` | `2a380a0b6c6976652d70696e672d3110011a130a08757074696d655f73116666666666660e401a120a0766635f6c696e6b110000000000000000` |

`result` 필드 (규약상 `map<string,double>` — **숫자만 실린다**):

| 키 | 뜻 | 단위 |
|---|---|---|
| `uptime_s` | 노드가 떠 있던 시간 | 초 |
| `fc_link` | FC 링크 생존. **1.0 = 있음 / 0.0 = 없음** | — |
| `fc_link_age_s` | 마지막 FC heartbeat 이후 경과 | 초 |

⚠ `fc_link_age_s` 는 **한 번도 heartbeat 를 못 받았으면 키 자체가 없다.** 0 을 넣으면
"방금 받았다"와 구별되지 않기 때문이다(결측 규칙). 웹은 **키 없음 = 모름**으로 읽어야 한다.

### 5단계 재확인 (2026-09-21 21:06) — **`fc_link` 는 실제로 실려 온다**

가시화의 "FC 링크" 줄이 이 값을 보므로 다른 `command_id` 로 한 번 더 왕복시켰다.

요청 `command{command_id:"be-ping-1", target:"x500-001", action:"ping"}`
hex: `0a1b0a0962652d70696e672d311208783530302d3030311a0470696e67`

응답 4건(순서 동일), 마지막 `result` 의 hex:
`2a360a0962652d70696e672d3110011a130a08757074696d655f731100000000008485401a120a0766635f6c696e6b110000000000000000`

```
result {
  command_id: "be-ping-1"
  status: SUCCEEDED
  result { key: "uptime_s"  value: 688.5 }
  result { key: "fc_link"   value: 0 }      # 0.0 = FC 링크 없음 (지금 FC 분리 상태)
}
```

`fc_link` 키는 **링크가 있든 없든 항상 실린다**(1.0/0.0). 반면 `fc_link_age_s` 는 이번에도
없었다 — 이 세션에서 FC heartbeat 를 한 번도 못 받았기 때문이다. 가시화는
**`fc_link` 로 링크 유무를 그리고, `fc_link_age_s` 는 있을 때만 "n초 전" 으로 덧붙이면 된다.**

---

## 6. 미선언 action 은 거부된다 (실제 캡처)

요청 `command{command_id:"live-arm-1", target:"x500-001", action:"arm"}`
hex: `0a1b0a0a6c6976652d61726d2d311208783530302d3030311a0361726d`

응답 — **`acceptance` 하나뿐이고 `result` 는 오지 않는다.**
```
acceptance {
  command_id: "live-arm-1"
  rejection { code: "UNIMPLEMENTED"  message: "action not supported" }
}
```
hex: `1a330a0a6c6976652d61726d2d311a250a0d554e494d504c454d454e5445441214616374696f6e206e6f7420737570706f72746564`

`takeoff`·`land`·`set_mode` 등도 모두 같다. 거부는 **실행 로직에 닿기 전에** 일어나고,
FC 로는 아무것도 나가지 않는다.

---

## 7. 상태 보고 — 필드 전부

### 7-1. `state` (1Hz, QoS 1, retained 아님)

공통 봉투 + 드론 본문. **FC 링크가 없으면 `battery`·`flight`·`gps`·`attitude`·`altitude`
가 전부 `null` 이다** — 마지막 값을 현재값처럼 재사용하지 않는다.

> **백엔드가 `state.drone.schema.json` 을 만들 목적이면 §13 을 볼 것.** 같은 메시지를
> 타입·필수 여부·결측 표현까지 적어 두었다. 이 절은 사람이 읽는 요약이다.

FC 분리 상태에서 실제로 캡처한 것:

```json
{
  "schema_version": "1.1",
  "source_id": "x500-001",
  "node_id": "pi3",
  "zone_id": "zoneA",
  "timestamp": "2026-09-21T20:43:48.225+09:00",
  "session_id": "3e276e814c9b",
  "sequence_id": 20,
  "channel": "state",
  "reason": "periodic",
  "device_status": "degraded",
  "link": "degraded",
  "fc_link": false,
  "fc_link_age_s": null,
  "router_mode": "none",
  "battery": null,
  "flight": null,
  "gps": null,
  "attitude": null,
  "altitude": null,
  "warnings": []
}
```

| 필드 | 뜻 | 단위·값 | 없을 때 |
|---|---|---|---|
| `timestamp` | 발행 시각 (RFC3339, ms, +09:00) | — | 항상 있다 |
| `sequence_id` | 발행 순번. `session_id` 가 바뀌면 0 부터 다시 센다 | — | 항상 있다 |
| `session_id` | 프로세스 1회 기동 식별자 | — | 항상 있다 |
| `reason` | `periodic` / `fc_link_lost` / `fc_link_up` / `armed_changed` / `mode_changed` / `battery_low` | — | 항상 있다 |
| `device_status` | 장치 자기보고 `ok` / `degraded` / `fault` | — | 항상 있다 |
| `link` | FC 링크 건강 `ok` / `degraded` / `fault` | — | 항상 있다 |
| `fc_link` | **FC 링크 유무** | `true`/`false` | 항상 있다 |
| `fc_link_age_s` | 마지막 FC heartbeat 이후 경과 | 초 | `null` = 한 번도 못 받음 |
| `router_mode` | mavlink-router 상태(`drone` = 기체 연결됨 / `none`) | — | 항상 있다 |
| `battery` | 아래 표 | — | `null` |
| `flight` | 아래 표 | — | `null` |
| `gps` | 아래 표 | — | `null` |
| `attitude` | `roll_deg`·`pitch_deg`·`yaw_deg`·`age_s` | 도 / 초 | `null` |
| `altitude` | `relative_m`·`amsl_m`·`age_s` | m / 초 | `null` |
| `warnings` | FC STATUSTEXT 최근 5줄 `{severity, text, age_s}` | `severity` = `WARNING`·`CRITICAL` … | `[]` |

`battery` (기준은 SYS_STATUS 5Hz, 보조는 BATTERY_STATUS 0.5Hz)

| 키 | 단위 | 없을 때 |
|---|---|---|
| `voltage_v` | V | `null` |
| `current_a` | A — **참고값. 실측에서 디스암 상태인데 12.2A 로 읽혔다(스케일 의심)** | `null` |
| `remaining_pct` | % | `null` |
| `consumed_mah` | mAh | `null` |
| `source` | `SYS_STATUS` / `BATTERY_STATUS` | `null` |
| `age_s` | 초 — 이 표본의 나이 | `null` |

`flight`

| 키 | 값 |
|---|---|
| `armed` | `true`/`false` (HEARTBEAT `base_mode` 의 SAFETY_ARMED 비트) |
| `mode` | PX4 비행 모드 문자열 — 예 `AUTO.LOITER`, `MANUAL`, `POSCTL` |
| `custom_mode`, `base_mode` | 원본 정수 |
| `system_status` | 원본 정수. **arm 판정에 쓰지 말 것** — pi3 실측에서 0(UNINIT)으로 온다 |
| `landed_state` | `ON_GROUND` / `IN_AIR` / `TAKEOFF` / `LANDING` / `UNDEFINED` |
| `age_s` | 초 |

`gps`

| 키 | 값 |
|---|---|
| `fix_type` / `fix` | 0 `NO_GPS` · 1 `NO_FIX` · 2 `2D` · 3 `3D` · 4 `DGPS` · 5 `RTK_FLOAT` · 6 `RTK_FIXED` |
| `satellites` | 개수 |
| `lat` / `lon` | 도. **fix_type < 2 면 `null`** — fix 없을 때의 0,0 은 좌표가 아니라 데이터 부재다 |
| `eph_m` | m | 
| `age_s` | 초 |

### 7-2. `status` (10초 요약, QoS 1, **retained**)

늦게 붙은 웹도 **구독 즉시 현재 상태 1건**을 받는다. 첫 화면은 이 채널로 그리면 된다.
실제 캡처(FC 분리 상태):

```json
{
  "channel": "status", "event": "summary", "status": "online",
  "device_status": "degraded",
  "registration": {
    "entity_id": "x500-001", "node_id": "pi3", "zone_id": "zoneA",
    "entity_type": "drone", "device_type": "x500_drone",
    "fw_version": "0.3.0", "mac": "2c:cf:67:e7:cf:67", "ip": "127.0.0.1"
  },
  "uptime_s": 40.0,
  "buffer": {"pending": 0, "dropped": 0, "thinned": 0},
  "publish_failures": 2,
  "fc_link": false, "fc_link_age_s": null, "router_mode": "none",
  "link": "degraded", "udp_port": 14543, "tx_bytes": 0,
  "state_interval_s": 1.0, "battery": null, "flight": null
}
```

| 필드 | 읽는 법 |
|---|---|
| `event` | `birth`(등록) / `summary`(10초) / `rebirth` / `shutdown`(정상 종료) / **`death`(급사)** |
| `status` | `online` / `offline` |
| `tx_bytes` | **브리지가 FC 로 보낸 바이트. 항상 0 이어야 한다** — 0 이 아니면 그 자체가 사건이다 |
| `publish_failures` | 기동 직후 브로커 접속 전에 발행을 시도한 횟수. 2 정도는 정상이다 |
| `registration.ip` | **`127.0.0.1` 로 나온다** — 브로커가 자기 자신이라 그렇다. 실주소는 §1 을 쓸 것 |

### 7-3. 급사(LWT) — 실제로 SIGKILL 해서 확인했다

노드가 급사하면 **브로커가 대신** `status` 토픽에 발행한다:

```json
{"schema_version":"1.1","source_id":"x500-001","node_id":"pi3","zone_id":"zoneA",
 "timestamp":"2026-09-21T20:44:16.481+09:00","session_id":"e95081f16507",
 "channel":"status","event":"death","status":"offline",
 "device_status":"fault","reason":"lwt"}
```

⚠ 이 `timestamp` 는 **죽은 시각이 아니라 접속한 시각**이다(LWT 는 접속 시점에 고정된다).
끊긴 시각은 웹이 수신 시각으로 매겨야 한다.
실측 순서: `summary(online)` → **`death(offline/fault)`** → 3초 뒤 자동 재시작 → `birth(online)`.

### 7-4. `heartbeat` (5초, QoS 0)

```json
{"schema_version":"1.1","source_id":"x500-001","node_id":"pi3","zone_id":"zoneA",
 "timestamp":"2026-09-21T20:45:01.488+09:00","session_id":"e95081f16507",
 "sequence_id":9,"channel":"heartbeat"}
```
본문이 없다. 생사만 본다면 retained `status` + LWT 로 충분하다.

---

## 8. 장비 종류를 어디서 아는가

| 위치 | 값 | 비고 |
|---|---|---|
| 상태 토픽 2번째 칸 | `drone` | `zoneA/**drone**/x500-001/state` |
| `status.registration.entity_type` | `"drone"` | |
| `status.registration.device_type` | `"x500_drone"` | **가장 구체적** |
| entity_id / clientId / `capability.device_id` | `x500-001` | |

⚠ **규약 `Capability` 에는 장비 종류를 실을 자리가 없다**(`device_id` 와 `actions[]` 뿐).
그래서 종류는 위 JSON 쪽에서 읽어야 한다. `.proto` 를 고치지 않기 위한 선택이다.

---

## 9. 아직 확인하지 못한 것 (정직하게)

작업 시점에 **기체(FC)가 분리돼 있었다**(사용자가 의도적으로 연결 해제, 라즈베리파이만 전원 연결).
그래서 아래는 코드와 0단계 원시 MAVLink 실측으로는 확인했지만, **MQTT 로 흐르는 모습은
아직 보지 못했다.**

| 항목 | 현재 상태 |
|---|---|
| `battery`·`flight`·`gps`·`attitude`·`altitude` 의 **값이 채워진** 모습 | 미확인 — 지금은 전부 `null` 로 나간다 |
| `reason` 이 `fc_link_up` / `armed_changed` / `mode_changed` 인 `state` | 미확인 |
| `tx_bytes` 가 실제 수신 중에도 0 인지 | 미확인(라우터가 내려가 있어 수신 자체가 없다) |

참고로 0단계에서 **라우터를 통해 직접 관측한 원시 값**은 이렇다(2026-09-21 20:15, 실내):
전압 15.75V · 잔량 74% · `AUTO.LOITER` · DISARMED · `ON_GROUND` ·
GPS `NO_GPS` 위성 0 · 자세 roll -0.29° pitch +1.46° yaw 108.5° · STATUSTEXT 0건.
기체를 다시 연결하면 위 필드가 이 값들로 채워진다.

---

## 10. 목(mock)으로 흉내 내기

브로커만 있으면 아래로 드론 없이 웹을 개발할 수 있다.

hex 를 바이너리 파일로 만들어 `-f` 로 발행한다. **`xxd` 는 pi3 에 없다**(`vim-common` 에
들어 있다) — 어디서나 되는 `python3` 를 쓴다.

```bash
# hex → .bin (이 방법은 pi3 에서 실제로 확인했다)
hex2bin() { python3 -c "open('$2','wb').write(bytes.fromhex('$1'))"; }

# 1) Capability (접속했다고 알리기)
hex2bin 3a100a08783530302d303031120470696e67 cap.bin
mosquitto_pub -h pi3.local -t terminal/x500-001/uplink -f cap.bin

# 2) ping 응답 4건 — §5 의 hex 를 같은 방법으로 순서대로 발행

# 3) 미선언 거부
hex2bin 1a330a0a6c6976652d61726d2d311a250a0d554e494d504c454d454e5445441214616374696f6e206e6f7420737570706f72746564 reject.bin
mosquitto_pub -h pi3.local -t terminal/x500-001/uplink -f reject.bin

# 4) 상태 (JSON 은 그대로)
mosquitto_pub -h pi3.local -t zoneA/drone/x500-001/state -q 1 -m '{"channel":"state","fc_link":true,"battery":{"voltage_v":15.75,"remaining_pct":74.0,"source":"SYS_STATUS","age_s":0.2},"flight":{"armed":false,"mode":"AUTO.LOITER","landed_state":"ON_GROUND"},"gps":null,"attitude":{"roll_deg":-0.29,"pitch_deg":1.46,"yaw_deg":108.5},"warnings":[]}'
```

실제로 붙어서 볼 때:
```bash
mosquitto_sub -h pi3.local -V 5 -t 'zoneA/+/+/#' -v          # 상태 전부
mosquitto_sub -h pi3.local -V 5 -t 'terminal/x500-001/uplink' -F '%x'   # 규약(hex)
```

---

## 11. 웹이 조심할 것 5가지

1. **`zoneA/robot/...` 을 박아 두지 말 것.** 두 번째 칸은 `+` 로 받는다(§3-1).
2. **clientId 를 `x500-001` 로 쓰지 말 것.** 노드를 밀어낸다(§2).
3. **`null` 을 0 으로 바꾸지 말 것.** `null` 은 "모른다"이고 0 은 "쟀더니 0"이다.
   특히 `battery: null` 을 0% 로 그리면 잘못된 경보가 된다.
4. **`Capability` 는 retained 가 아니다.** 늦게 붙으면 못 받는다 — `ping` 으로 확인할 것.
5. **`ping` 응답의 `result` 는 숫자만 담는다.** 없는 값은 키가 통째로 빠진다.

## 12. 관련 파일

| 무엇 | 어디 |
|---|---|
| 드론 링크(수신 전용) | `~/hw/pi/drone/drone_link.py` |
| 드론 노드 | `~/hw/pi/drone/drone_node.py` |
| 공통 틀(무수정) | `~/hw/pi/common/` |
| 규약 스키마(무수정) | `~/hw/schema/physical_command.proto` |
| 브로커 설정 | `/etc/mosquitto/conf.d/hw.conf` (원본 `~/drone/config/mosquitto-hw.conf`) |
| 노드 설정 | `/etc/hw-node.env`, `/etc/hw-drone.env` (원본 `~/drone/config/`) |
| 서비스 | `/etc/systemd/system/drone-node.service` (원본 `~/drone/systemd/`) |
| 0단계 조사 | `~/drone/STEP0_REPORT_bridge.md` |

---

## 13. 백엔드 규격용 — `state.drone.schema.json` 을 만들 때 보는 표

> 백엔드가 **이 절만 읽고** JSON Schema 를 쓸 수 있게 따로 모았다. §7-1 과 같은 메시지지만
> 여기서는 **타입 · 단위 · 필수 여부 · 값이 없을 때의 표현**을 빠짐없이 적는다.
> 값은 전부 코드(`~/hw/pi/drone/drone_link.py`, `drone_node.py`, `~/hw/pi/common/schema.py`)와
> 실제 캡처에서 확인했다. 캡처는 2026-09-21 21:06, **FC 분리 상태**, `drone-node.service` 가동 중.

### 13-0. 읽기 전에 — 규칙 두 가지

1. **키는 항상 있다. 없는 것은 값이지 키가 아니다.**
   아래 표의 "필수" 는 전부 **키의 필수**다. FC 링크가 없어도 `battery` 키는 사라지지 않고
   `null` 로 온다. 그러니 스키마에서는 **전부 `required` 에 넣고**, 타입 쪽에서
   `["object","null"]` 처럼 `null` 을 허용하면 된다.
   ⚠ 규약(protobuf) 쪽 `ping` 응답의 `result` 는 **반대**다 — 거기선 없는 값의 **키가 통째로
   빠진다**(`map<string,double>` 라 `null` 을 실을 수 없다). §5 참고. 두 평면의 결측 표현이
   다르다는 것을 스키마에 반영할 것.
2. **`null` 을 0 으로 치환하지 말 것.** `null` 은 "모른다", `0` 은 "쟀더니 0"이다.
   `battery: null` 을 0% 로 해석하면 잘못된 경보가 된다.

### 13-1. 공통 헤더 — 모든 채널이 공유한다 (공통 틀이 채운다)

`state`·`status`·`heartbeat` 가 **같은 함수**(`common/schema.py:envelope()`)로 머리를 만든다.
어댑터(`drone/drone_node.py`)는 이 다섯 필드를 **건드리지 않는다.**

| 필드 | 타입 | 값·형식 | 필수 | 없을 때 |
|---|---|---|---|---|
| `schema_version` | `string` | 현재 `"1.1"` 고정 | ✅ | 없는 경우 없음 |
| `source_id` | `string` | entity_id = `"x500-001"` | ✅ | 없는 경우 없음 |
| `node_id` | `string` | `"pi3"` | ✅ | 없는 경우 없음 |
| `zone_id` | `string` | `"zoneA"` | ✅ | 없는 경우 없음 |
| `timestamp` | `string` (`format: date-time`) | RFC3339 · 밀리초 · 콜론 있는 오프셋 `+09:00` | ✅ | 없는 경우 없음 |
| `session_id` | `string` | 12자리 hex. 프로세스 1회 기동 식별자 | ✅ | 없는 경우 없음 |
| `sequence_id` | `integer` (≥0) | 채널별 발행 순번. `session_id` 가 바뀌면 0부터 | ✅ (`state`·`heartbeat`) | `status` 에는 **없다** |
| `correlation_id` | `string` | 백엔드 발급 command_id 에코 | ✖ | **`state` 에는 실리지 않는다** |

값의 출처(고장 나면 여기를 본다):

| 필드 | 어디서 오는가 | 비어 있을 수 있는가 |
|---|---|---|
| `source_id` | `HW_ENTITY_ID`(=`/etc/hw-drone.env`) → 없으면 `/etc/device_id` | **둘 다 없으면 노드가 기동하지 않는다**(`SystemExit`) — 빈 값으로 발행되는 경로가 없다 |
| `node_id` | `HW_NODE_ID` → `/etc/node_id` → **hostname**(현재 이 경로, `pi3`) | hostname 이 최후 수단이라 항상 채워진다 |
| `zone_id` | `HW_ZONE_ID`(`zoneA`) → `/etc/zone_id`(`zoneA`) → 기본값 `zoneA` | 항상 채워진다 |
| `schema_version` | 코드 상수 `SCHEMA_VERSION` | 항상 |
| `timestamp` | 발행 직전 `datetime.now(...).isoformat(timespec="milliseconds")` | 항상 |

### 13-2. `state` 본문 — 최상위

토픽 `zoneA/drone/x500-001/state` · 1Hz · QoS 1 · retained 아님.

| 필드 | 타입 | 단위·값 | 필수 | 값이 없을 때 | **FC 링크 없을 때** |
|---|---|---|---|---|---|
| `channel` | `string` | `"state"` 고정 | ✅ | — | `"state"` |
| `reason` | `string` (enum, §13-4) | — | ✅ | — | 그대로 온다 |
| `device_status` | `string` (enum) | `ok`·`degraded`·`fault` — 장치 자기보고 | ✅ | — | `degraded`(라우터 `none`) / `fault`(라우터는 `drone` 인데 heartbeat 없음) |
| `link` | `string` (enum) | `ok`·`degraded`·`fault` — FC 링크 건강 | ✅ | — | 위와 같은 규칙 |
| `fc_link` | `boolean` | FC 링크 유무 | ✅ | — | **`false`** |
| `fc_link_age_s` | `number` \| `null` | 초. 마지막 FC heartbeat 이후 경과 | ✅ | `null` = 한 번도 못 받음 | `null` (한 번도 못 받은 경우) |
| `router_mode` | `string` | `"drone"`(라우터 가동) / `"none"` | ✅ | — | 보통 `"none"` |
| `battery` | `object` \| `null` | §13-3 | ✅ | `null` | **`null`** |
| `flight` | `object` \| `null` | §13-3 | ✅ | `null` | **`null`** |
| `gps` | `object` \| `null` | §13-3 | ✅ | `null` | **`null`** |
| `attitude` | `object` \| `null` | §13-3 | ✅ | `null` | **`null`** |
| `altitude` | `object` \| `null` | §13-3 | ✅ | `null` | **`null`** |
| `warnings` | `array` (§13-3) | FC STATUSTEXT 최근 5줄·120초 이내 | ✅ | `[]` (빈 배열, `null` 아님) | `[]` 또는 **끊기기 직전 경고가 남아 있다** |

> `warnings` 만 FC 링크가 없어도 비워지지 않는다. 끊긴 직전의 STATUSTEXT 가 끊긴 이유일
> 때가 많아 일부러 남긴다. 그래서 `warnings` 는 "지금 FC 가 살아 있다"의 근거가 아니다 —
> 생사는 `fc_link` 만 본다.

### 13-3. `state` 본문 — 중첩 객체

객체가 `null` 이 아니면 **아래 키는 전부 들어 있다**(값이 `null` 일 수 있다).

**`battery`** — 기준 SYS_STATUS(5Hz), 보조 BATTERY_STATUS(0.5Hz)

| 키 | 타입 | 단위 | 필수 | 없을 때 |
|---|---|---|---|---|
| `voltage_v` | `number` \| `null` | V | ✅ | `null` (PX4 의 `0`·`65535` = 모름을 옮긴 것) |
| `current_a` | `number` \| `null` | A | ✅ | `null` (PX4 `-1`). ⚠ 실측에서 디스암인데 12.2A 로 읽혔다 — **스케일 의심, 참고값** |
| `remaining_pct` | `number` \| `null` | % (0~100) | ✅ | `null` (PX4 `-1`) |
| `consumed_mah` | `number` \| `null` | mAh | ✅ | `null` |
| `source` | `string` \| `null` | `"SYS_STATUS"` / `"BATTERY_STATUS"` | ✅ | `null` |
| `age_s` | `number` \| `null` | 초 — 이 표본의 나이 | ✅ | `null` |

**`flight`**

| 키 | 타입 | 값 | 필수 | 없을 때 |
|---|---|---|---|---|
| `armed` | `boolean` | HEARTBEAT `base_mode` 의 SAFETY_ARMED 비트 | ✅ | `null` 되지 않는다(객체가 있으면 항상 bool) |
| `mode` | `string` | PX4 비행 모드 — `AUTO.LOITER`·`MANUAL`·`POSCTL` …, 모르는 값은 `"main=N"` | ✅ | 항상 문자열 |
| `custom_mode` | `integer` | 원본 | ✅ | — |
| `base_mode` | `integer` | 원본 | ✅ | — |
| `system_status` | `integer` | 원본. **arm 판정에 쓰지 말 것** — pi3 실측 0(UNINIT) | ✅ | — |
| `landed_state` | `string` \| `null` | `ON_GROUND`·`IN_AIR`·`TAKEOFF`·`LANDING`·`UNDEFINED` | ✅ | `null` = EXTENDED_SYS_STATE 미수신 |
| `age_s` | `number` \| `null` | 초 | ✅ | `null` |

**`gps`**

| 키 | 타입 | 값 | 필수 | 없을 때 |
|---|---|---|---|---|
| `fix_type` | `integer` | 0~6 | ✅ | — |
| `fix` | `string` | `NO_GPS`(0)·`NO_FIX`(1)·`2D`·`3D`·`DGPS`·`RTK_FLOAT`·`RTK_FIXED`. 모르는 값은 숫자의 문자열 | ✅ | — |
| `satellites` | `integer` | 개수 | ✅ | — |
| `lat` | `number` \| `null` | 도 (WGS84) | ✅ | **`fix_type < 2` 면 `null`** — fix 없을 때의 0,0 은 좌표가 아니다 |
| `lon` | `number` \| `null` | 도 | ✅ | 위와 같다 |
| `eph_m` | `number` \| `null` | m | ✅ | `null` (PX4 `0`·`65535`·`9999` = 모름) |
| `age_s` | `number` \| `null` | 초 | ✅ | `null` |

**`attitude`** (ATTITUDE 100Hz, 1초 넘으면 객체가 통째로 `null`)

| 키 | 타입 | 단위 | 필수 |
|---|---|---|---|
| `roll_deg` · `pitch_deg` · `yaw_deg` | `number` | 도 (소수 2자리) | ✅ |
| `age_s` | `number` \| `null` | 초 | ✅ |

**`altitude`** (ALTITUDE, 3초 넘으면 `null`)

| 키 | 타입 | 단위 | 필수 |
|---|---|---|---|
| `relative_m` | `number` | m (이륙 지점 기준) | ✅ |
| `amsl_m` | `number` | m (해발) | ✅ |
| `age_s` | `number` \| `null` | 초 | ✅ |

**`warnings[]`** — 배열 원소

| 키 | 타입 | 값 | 필수 |
|---|---|---|---|
| `severity` | `string` | `EMERGENCY`·`ALERT`·`CRITICAL`·`ERROR`·`WARNING`·`NOTICE`·`INFO`·`DEBUG` (MAVLink 0~7 이름). 모르는 값이면 숫자 그대로 | ✅ |
| `text` | `string` | FC STATUSTEXT 원문 | ✅ |
| `age_s` | `number` \| `null` | 초 | ✅ |

### 13-4. `reason` 어휘 — 드론 `state` 는 6개

Go1 의 3개(`periodic`·`mode_changed`·`battery_low`)를 **포함**하고 드론 고유 3개가 더 있다.

| 값 | 언제 | 발행 방식 | Go1 에도 있나 |
|---|---|---|---|
| `periodic` | 1Hz 주기 | QoS 1, 버퍼에 넣지 않는다(낡은 "지금"을 나중에 보내지 않으려고) | ○ |
| `fc_link_lost` | FC heartbeat 3초 결번 | QoS 1 + **버퍼 대상**(끊기면 재전송) | ✖ (드론 고유) |
| `fc_link_up` | FC heartbeat 복귀 | QoS 1 + 버퍼 | ✖ (드론 고유) |
| `armed_changed` | arm ↔ disarm 전환 | QoS 1 + 버퍼 | ✖ (드론 고유) |
| `mode_changed` | 비행 모드 문자열 변경 | QoS 1 + 버퍼 | ○ |
| `battery_low` | `remaining_pct` 가 임계(기본 20%) 이하로 **내려가는 순간 1회** | QoS 1 + 버퍼 | ○ |

규칙 두 가지:
- **첫 관측에서는 전환 이벤트를 쏘지 않는다.** 이전 값이 `None` 이면 기록만 하고 넘어간다 —
  기동 직후 "모름 → 값" 을 전환으로 보고하면 없던 사건이 생긴다.
- **FC 링크가 끊기면 arm·모드 기억을 버린다.** 링크가 없는 동안은 기체 상태를 "모른다" 이고,
  복구되면 전환을 처음부터 다시 알린다. `battery_low` 경보도 같이 해제된다.

> 다른 채널의 `reason`: `status` 채널의 급사(LWT)는 `"lwt"`, 정상 종료는 `"graceful_shutdown"`
> 이다(§7-2·§7-3). `state` 의 어휘와 섞이지 않는다.

### 13-5. 실제로 발행된 `state` 1건 — 원문 그대로

5단계 검증에서 브로커로 흐르는 것을 그대로 받아 적었다. 수신 명령과 출력은 이렇다.

```bash
mosquitto_sub -h pi3.local -V 5 -t 'zoneA/drone/x500-001/state' -C 1 -v
```

```
zoneA/drone/x500-001/state {"schema_version": "1.1", "source_id": "x500-001", "node_id": "pi3", "zone_id": "zoneA", "timestamp": "2026-09-21T21:06:50.795+09:00", "session_id": "a93f81192e02", "sequence_id": 173, "channel": "state", "reason": "periodic", "device_status": "degraded", "link": "degraded", "fc_link": false, "fc_link_age_s": null, "router_mode": "none", "battery": null, "flight": null, "gps": null, "attitude": null, "altitude": null, "warnings": []}
```

들여쓴 모습(같은 메시지다):

```json
{
  "schema_version": "1.1",
  "source_id": "x500-001",
  "node_id": "pi3",
  "zone_id": "zoneA",
  "timestamp": "2026-09-21T21:06:50.795+09:00",
  "session_id": "a93f81192e02",
  "sequence_id": 173,
  "channel": "state",
  "reason": "periodic",
  "device_status": "degraded",
  "link": "degraded",
  "fc_link": false,
  "fc_link_age_s": null,
  "router_mode": "none",
  "battery": null,
  "flight": null,
  "gps": null,
  "attitude": null,
  "altitude": null,
  "warnings": []
}
```

⚠ **이 캡처는 FC 가 분리된 상태다.** 그래서 `battery`·`flight`·`gps`·`attitude`·`altitude`
가 전부 `null` 이다 — 이게 정상 동작이며, 스키마에서 이 다섯은 **`null` 을 반드시 허용해야
한다.** 값이 채워진 모습은 아직 MQTT 로 관측하지 못했다(§9). 기체를 연결하면 §13-3 의 키들이
0단계 원시 실측값(전압 15.75V · 잔량 74% · `AUTO.LOITER` · DISARMED · `ON_GROUND` ·
GPS `NO_GPS` 위성 0 · roll -0.29° pitch 1.46° yaw 108.5°)으로 채워진다.

키 순서는 발행 코드 순서라 안정적이지만, **순서에 의존하지 말 것**(JSON 객체다).
