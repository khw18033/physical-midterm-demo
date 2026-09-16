# 로봇 스캔 → 객체탐지 전송 규약

작성 2026-09-14 · 보내는 쪽 pi7 (`go1-001`) · 받는 쪽 탐지 담당 노트북(Ubuntu)
· 근거 문서 `탐지_로봇데이터요구_260914.md`

탐지 요구의 **A안**으로 구현했다. 사진과 각도가 **같은 MQTT 메시지**에 실려 나가므로
짝이 어긋날 여지가 없다.

---

## 1. 토픽

| 토픽 | QoS | 언제 |
|---|---|---|
| `zoneA/robot/go1-001/frame` | 1 | 방향마다 1건 (기본 8건) |
| `zoneA/robot/go1-001/scan` | 1 | 한 판의 시작·끝 각 1건 |

브로커는 기존과 같다. `ws://pi7.tailcb6bfb.ts.net:9001/mqtt` (또는 1883 생 TCP).

**브로커에 메시지 크기 제한은 걸려 있지 않다**(`message_size_limit` 미설정 = 무제한).
프레임 한 장이 약 25 KB, base64 로 34 KB 라 8장을 합쳐도 300 KB 이하다. B안으로 갈 이유가 없다.

## 2. `/frame` 페이로드

```json
{
  "schema_version": "1.3",
  "device_id": "go1-001",
  "channel": "frame",
  "timestamp": "2026-09-14T11:45:53+0900",
  "seq": 0,
  "rotation_deg": 0.0,
  "image": "<JPEG base64>",

  "mission_id": "scan-1789353953",
  "source_id": "go1-001", "node_id": "pi7", "zone_id": "zoneA",
  "step": 0, "steps": 8,
  "yaw_deg": null,
  "camera": { "camera_id": 1, "position": "정면" },
  "width": 464, "height": 400, "bytes": 24558,
  "sha1": "0ece0f94dc1947ee",
  "captured_at_unix": 1789353953.715
}
```

위 일곱 줄이 요구한 필수 필드이고, 아래는 참고 필드다 — 무시해도 된다.

- `seq` 0~7, `rotation_deg` 0·45·90·135·180·225·270·315 (오른쪽=시계).
- `mission_id` 가 한 판의 묶음 키다. 8장이 같은 값을 갖는다.
- `yaw_deg` 는 로봇이 보고한 절대 방위다. **기준점이 판마다 옮겨지므로 판을 넘어
  견주면 안 된다.** 방향 계산은 `rotation_deg` 로만 할 것.

### `sha1` 과 `duplicate_of_prev` — 반드시 봐 달라

Go1 카메라는 얼어붙어도 **30 fps 로 계속 내보낸다.** 그림만 멈춘다. 프레임률로는
알 수 없고 그림의 변화로만 알 수 있다. 그래서 프레임마다 `sha1` 을 싣고, 직전과
바이트까지 같으면 `"duplicate_of_prev": true` 를 붙인다.

**이 표시가 붙은 판은 버려야 한다.** 같은 사진 8장을 8방향으로 오해하면 문 방향이
통째로 틀어진다. 실측 2026-09-14: 링이 카메라에 막 붙은 직후 8장이 전부 같은 그림으로
나가는 것을 확인했다(그 뒤 정상 복귀).

## 3. `/scan` 페이로드 — 판의 경계

`in_mission` 으로 대신해도 되지만, 명시적으로 보낸다(10초 주기 상태보고보다 정확하다).

```json
{ "channel": "scan", "event": "scan_start", "mission_id": "scan-…",
  "plan": { "steps": 8, "step_deg": 45.0, "expected_frames": 8 }, … }

{ "channel": "scan", "event": "scan_end", "mission_id": "scan-…",
  "outcome": "SUCCEEDED", "frames_sent": 8, "expected_frames": 8, … }
```

`outcome` 은 `SUCCEEDED` / `ABORTED` / `CANCELED`. 중단된 판은 사진이 모자라니
`frames_sent` 와 `expected_frames` 를 견줄 것.

---

## 4. 요구 문서에 대한 답

### ② 회전 방향과 시작 기준 — 그대로다

**오른쪽(시계)으로 45도씩 8번**이 맞다. `rotation_deg = 0` 인 첫 프레임은
**첫 회전을 시작하기 전**에 집은 그림이라 스캔 시작 시점의 정면이 맞다.

한 바퀴를 다 돈 뒤(8번째 걸음)에는 찍지 않는다. 각도는 0 으로 같지만 360도를 돌고 온
자세라 오도메트리·IMU 오차가 누적된 뒤다. 첫 장이 더 정확하다.

### ③ 촬영 조건 — 맞춘다

- **정지한 뒤에 찍는다.** 회전 → 정지 → 0.6초 대기 → 촬영 순서다.
  (0도 한 장만 예외로 즉시 집는다. 아직 돌기 전이라 이미 정지 상태다.)
- **찍는 대로 한 장씩** 보낸다. 몰아서 보내지 않는다.
- **자르기·리사이즈·회전·보정을 하지 않는다.** 다만 H.264 를 JPEG 로 바꾸는
  디코딩은 들어간다(로봇이 H.264 로만 주기 때문이다). 화각과 화소는 그대로다.

### ⚠ 해상도가 1280×720 이 아니다 — **464×400** 이다

요구 문서가 `status.media` 의 `"size": "1280x720"` 을 보고 GO1 카메라를 1280×720 으로
적었는데, **그 값은 이 경로와 무관하다.** `media` 블록은 아직 쓰지 않는 별도 송출기의
설정값이고 지금 소스는 테스트 패턴이다(`"source": "test"`).

실제 Go1 정면 카메라는 **464×400** 이다(실측, 프레임마다 `width`/`height` 로도 싣는다).
요구 문서가 말한 "이전 카메라 464×400" 과 **같은 화소다.** 기존 튜닝값이 그대로 맞을
가능성이 높다.

### ④ 스캔 경계 — `/scan` 토픽으로 보낸다

`in_mission` 도 계속 유효하다. 둘 중 편한 것을 쓰면 된다.

### ⑤ 샘플 8장 — 실물 한 바퀴를 돌려야 한다

로봇을 실제로 움직여야 나온다. 시연 환경에 로봇을 세워 두고 한 판 돌리면 그 8장이
그대로 이 토픽으로 나간다. `bench/detect_sink_stub.py` 나 `mosquitto_sub` 로 받아
저장하면 된다.

### §4 탐지 → 로봇, 이동 지시를 받을 토픽

지금 **로봇 명령 경로는 protobuf** 다(`terminal/go1-001/downlink`). 탐지 쪽이 protobuf 를
쓰기 번거로우면 JSON 을 받아 번역해 주는 토픽을 하나 열겠다 — 말만 해 달라.

다행히 보내 주신 값이 그대로 들어맞는다. 지금 어휘가 이렇다.

| 지시 | 우리 명령 | 부호 |
|---|---|---|
| `turn_deg: -90.0` | `turn { deg: -90 }` | **오른쪽이 +** — 음수면 왼쪽. 규약이 같다 |
| `forward_distance_cm: 614.3` | `move_forward { distance_m: 6.143 }` | 0.05~10 m 범위 |

`standoff_cm` 은 이미 `forward_distance_cm` 에 반영된 값으로 이해했다. 아니면 알려 달라.

## 5. 안 보내는 것

요구 문서 §3 대로 depth·탐지결과·배터리·수위·heartbeat 는 보내지 않는다.
`zoneA/robot/go1-sim/*` 는 시뮬레이터라 무시하면 된다.

---

## 6. 받는 쪽 최소 구현

```python
import base64, json
import paho.mqtt.client as mqtt

def on_message(c, u, m):
    d = json.loads(m.payload)
    if d.get("channel") != "frame":
        return
    if d.get("duplicate_of_prev"):
        print("직전과 같은 그림 — 카메라 정지 의심")
    jpeg = base64.b64decode(d["image"])
    handle(jpeg, d["rotation_deg"], d["seq"])      # 짝이 이미 맞춰져 있다

c = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                protocol=mqtt.MQTTv5)
c.on_connect = lambda cl, *a: cl.subscribe("zoneA/robot/go1-001/frame", qos=1)
c.on_message = on_message
c.connect("pi7.tailcb6bfb.ts.net", 1883, 30)
c.loop_forever()
```

## 7. 보내는 쪽 운용

이미 상시 구동 중이다(`detect-bridge.service`). 전원을 껐다 켜도 자동으로 올라오고,
카메라가 끊기면 알아서 다시 붙는다.

```bash
systemctl status detect-bridge
journalctl -u detect-bridge -f
```

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `HW_DETECT_TRANSPORT` | `mqtt` | `mqtt`(A안) / `http`(C안) / `both` |
| `HW_DETECT_CAM_ID` | 1 | 1=정면 2=턱 3=좌 4=우 5=복부 |
| `HW_DETECT_SETTLE_S` | 0.6 | 정지 후 이만큼 기다렸다 촬영 |
| `HW_DETECT_JPEG_QUALITY` | 2 | ffmpeg `-q:v` (2=최고) |
| `HW_DETECT_URL` | — | C안을 쓸 때만 필요 |

C안(HTTP POST)도 그대로 남아 있다. `HW_DETECT_TRANSPORT=http` 로 바꾸면
`/mission/start`, `/frame`(multipart), `/mission/end` 로 보낸다.
