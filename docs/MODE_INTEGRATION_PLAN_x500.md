# X500 v2 — 모드 연동·조회 개선 계획서

**대상 코드**: [`drone/`](../drone/) (라즈베리파이 컴패니언 컴퓨터)
**작성일**: 2026-09-24 · **브랜치**: `drone-pi3` · **기체**: X500 v2 (`x500-001`) · **FC**: 코아 H743 (PX4)

**선행 문서**
- [`FLIGHT_MODE_ANALYSIS_x500.md`](FLIGHT_MODE_ANALYSIS_x500.md) — 현재 코드의 모드 거동 조사
- [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) — PX4 쪽 표준 동작·파라미터 (외부 문서 기반)

이 문서는 그 조사에서 나온 문제를 **어떻게 고칠 것인가**를 다룬다.

> 이 문서는 **계획서**다. 아직 코드를 수정하지 않았다.
> **2026-09-24 갱신** — `PX4_동작정리_260924.md` 를 반영했다. 바뀐 곳은 0-1 절에 모았다.

---

## 0. 요약

현재 코드는 비행 모드를 **바꾸지도, 읽지도 않는다.**
바꾸지 않는 것은 [README 6-5](../drone/README.md) 의 의도된 설계이므로 유지한다.
**읽지 않는 것이 문제다.**

모드 조회가 필요한 이유는 **명령을 더 보내기 위해서가 아니라, 언제 명령을 멈춰야 하는지 알기 위해서**다.

---

## 0-1. 2026-09-24 갱신 — PX4 동작 정리 반영

[`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) 를 읽고 계획이 바뀐 곳을 모았다.
**계획의 방향은 그대로다.** 바뀐 것은 구체적인 수치와 판정 문구, 그리고 검증 수단이다.

| # | 새로 알게 된 것 | 계획의 어디가 바뀌나 |
|---|---|---|
| ① | **`COM_RC_OVERRIDE` 는 기본 켜짐** — 자동 모드에서 스틱을 조금만 움직여도 Position 으로 넘어간다 (민감도 `COM_RC_STICK_OV`) | 3단계 (c) **판정 문구와 안내**. 선행 조사에서 "미확인" 이던 항목이 풀렸다 |
| ② | **`COM_DISARM_PRFLT` 기본 10초** — arm 후 그 안에 이륙하지 않으면 자동 disarm | 3단계 (b) **타임아웃 값**. 10초로 잡으면 자동 disarm 과 겹친다 |
| ③ | 이륙 속도 `MPC_TKO_SPEED` 기본 1.5m/s | 1-1·3-1 위험도 **완화 근거** (문제 자체는 남는다) |
| ④ | **`NAV_DLL_ACT` 는 Air Unit 쪽 링크 상실로도 발동할 수 있다** | 3단계 (c) `AUTO.RTL` 감지의 **중요도 상승** |
| ⑤ | 라즈베리파이에 **RTC 가 없다** — 부팅 직후 시각이 틀어질 수 있다 | 2단계 로그에 **FC 시각 기준 병기** |
| ⑥ | **SITL (`make px4_sitl gz_x500`)** 로 같은 코드를 돌릴 수 있다 | 5절 검증에 **SITL 열 추가** — `fake_fc.py` 로는 못 하는 것이 있다 |
| ⑦ | **킬 스위치 채널·지오펜스가 아직 미설정** | 새 **2-0 절 선결 조건** |
| ⑧ | "수락은 '하겠다' 이지 '했다' 가 아니다" (PX4 공식 문서) | 3단계 (b) **설계 근거 보강** |

---

## 1. 지금 코드의 문제

### 1-1. ★ 사람이 개입해도 코드가 모르고 `land()` 를 보낸다

[`takeoff_land.py` L124-134](../drone/scripts/takeoff_land.py#L124) 가 이렇게 생겼다.

```python
try:
    await asyncio.sleep(args.hold)      # 8초
finally:
    await drone.action.land()            # ← 무조건 나간다
```

`finally` 라서 **어떤 경우에도 `land()` 가 나간다.** 그런데 코드는 모드를 보지 않는다.

체크리스트는 "조종기를 손에 들고 즉시 개입하라" 고 하고, 개입의 확실한 방법은
**모드 스위치를 POSCTL 로 내려 AUTO 를 뺏는 것**이다. 그 상황을 시간축에 놓으면:

| t | 사람 | 코드 | 기체 모드 |
|---|---|---|---|
| 0s | — | `takeoff()` | `AUTO.TAKEOFF` |
| 3s | **이상 감지 → POSCTL 로 전환** | (모름) | `POSCTL` — 사람이 조종 중 |
| 8s | 수동 조종 중 | **`land()` 발사** | **`AUTO.LAND` 로 다시 뺏김** |

**사람과 코드가 기체를 두고 싸운다.** 사람은 조종하던 중에 기체를 뺏기고,
다시 모드 스위치를 조작해야 한다.

이건 모드 조회 없이는 고칠 수 없고, **"모드 연동" 이 필요한 진짜 이유**다.

> Ctrl-C 로 중단할 때도 같다. `finally` 가 `land()` 를 보내려 하는데,
> `asyncio.run` 취소 중에 `await` 가 성사되는지는 확실하지 않다 —
> 즉 **가장 위험한 경로의 동작이 비결정적이다.**
> 실제로 어떻게 되는지는 [`fake_fc.py`](../drone/scripts/fake_fc.py) 로 확인해야 한다.

### 1-2. 모드 해석기가 실행 스크립트 안에 있다

`decode_px4_custom_mode()` 는 [`check_link.py` L101](../drone/scripts/check_link.py#L101) 에 있다.
공용 헬퍼인 [`dronelink.py`](../drone/scripts/dronelink.py) 에는 없다.

그런데 저장소 **밖**의 MQTT 브리지가
`HW_DRONE_SCRIPTS=/home/physical/drone/scripts` ([`hw-drone.env`](../drone/config/hw-drone.env))
로 **`check_link.py` 를 라이브러리처럼 import** 한다.

→ 실행 스크립트를 고치면 브리지가 깨진다. 라이브러리와 실행 파일의 경계가 없다.
`dronelink.py` 가 정확히 그 경계로 만들어졌는데 모드 어휘만 빠져 있다.

### 1-3. 모드 이름이 두 벌이다

| 경로 | 같은 상태를 부르는 이름 |
|---|---|
| pymavlink (`check_link`, 브리지, CONTRACT) | **`AUTO.LOITER`** |
| MAVSDK ([`telemetry_watch.py` L46](../drone/scripts/telemetry_watch.py#L46)) | **`HOLD`** |

[CONTRACT §13](../drone/CONTRACT_x500.md) 은 `AUTO.LOITER` 로 고정했는데
터미널에 뜨는 건 `HOLD` 다. 웹·로그·터미널이 서로 다른 단어를 쓴다.

지금은 사람 눈으로만 보니 넘어가지만, **코드가 모드로 분기하기 시작하면 바로 버그가 된다.**

### 1-4. 제어 중에는 모드를 볼 창구가 없다

14540 은 한 번에 하나다. `takeoff_land.py` 가 잡으면 `telemetry_watch.py` 를 못 켠다.
즉 **모드 감시는 반드시 제어 스크립트 자신이 해야 한다.**
바깥에서 볼 수 있는 건 QGC(5760)와 브리지(14543)뿐이고 둘 다 이 저장소 밖이다.

### 1-5. 나머지

선행 조사 문서 5절과 같다.

- `sleep(8)` 이 고도 도달과 무관 — 상태 기반이 아님
  > **완화 근거(2026-09-24)**: `MPC_TKO_SPEED` 기본 1.5m/s 이므로 1.5m 이륙은 가감속을 넣어도
  > 수 초 안에 끝난다. **8초 안에 도달할 가능성이 높아 실제로 상승 중 `land()` 가 나갈 확률은 낮다.**
  > 다만 이건 우연히 맞는 것이지 설계가 보장하는 것이 아니다 — 고도나 `hold` 를 바꾸면 바로 깨진다.
  > **"확인하지 않는다" 는 구조적 문제는 그대로 남는다.**
- `fc_state.py` 가 모드를 출력하지 않음 (헤더에는 적혀 있음)
- `state/mode` 이름 충돌 — 라우터 모드(`drone`/`none`)를 `mode` 라 부름.
  CONTRACT 는 `router_mode` 로 구분했지만 파일명·환경변수는 아직 `mode`

---

## 2. 고치는 순서 — 위험도 낮은 것부터

### 2-0. 선결 조건 — 코드 이전에 기체 설정

[`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §5-4 가 **아직 정해지지 않았다**고 적은 값들이다.
3단계(모드 연동)는 "사람이 개입한다"를 전제로 설계되는데, **개입 수단 자체가 아직 갖춰지지 않았다.**

| 항목 | 상태 | 우리 구성에서 필요한가 |
|---|---|---|
| **킬 스위치 채널** | 미설정 | ★ **필수** — 프로펠러를 다는 4단계 전에 반드시. [체크리스트 §2](../drone/FLIGHT_CHECKLIST_x500.md) 가 이미 요구한다 |
| **지오펜스 `GF_*`** | 미설정 | ★ 권장 — 1.5m 이륙이라도 폭주 시 경계가 있는 편이 낫다 |
| `COM_OF_LOSS_T` | 미설정 | **불필요** — offboard 를 쓰지 않는다 |
| `COM_OBL_RC_ACT` | 미설정 | **불필요** — 위와 같음 |

> 원본 문서는 "제어 명령 시험 전에 이 **넷**을 정해야 한다" 고 적었지만,
> 우리 구성은 OFFBOARD 를 쓰지 않으므로 **앞의 둘만 해당**한다.
> offboard 관련 둘은 "쓰지 않는 문은 닫아 둔다" 는 기존 방침대로 미설정으로 두면 된다.

3단계 코드는 킬 스위치 없이도 **작성**할 수 있다. 다만 **실기 시험은 킬 스위치 설정 후에** 한다.

### 0단계. `dronelink.py` 로 모드 어휘 승격 — 위험 0, 선행 필수

모든 이후 단계가 여기에 의존한다.

```python
# dronelink.py 에 추가
PX4_MAIN_MODE = {1:"MANUAL", 2:"ALTCTL", 3:"POSCTL", 4:"AUTO", 5:"ACRO",
                 6:"OFFBOARD", 7:"STABILIZED", 8:"RATTITUDE", 9:"SIMPLE"}
PX4_SUB_MODE  = {1:"READY", 2:"TAKEOFF", 3:"LOITER", 4:"MISSION",
                 5:"RTL", 6:"LAND", 7:"RTGS", 8:"FOLLOW_TARGET", 9:"PRECLAND"}

def decode_px4_custom_mode(custom_mode): ...   # check_link 에서 그대로 이동

# ★ MAVSDK 어휘 → PX4 어휘 정규화 (1-3 문제 해결)
MAVSDK_TO_PX4 = {
    "TAKEOFF": "AUTO.TAKEOFF", "HOLD": "AUTO.LOITER",
    "LAND": "AUTO.LAND", "RETURN_TO_LAUNCH": "AUTO.RTL",
    "MISSION": "AUTO.MISSION", "READY": "AUTO.READY",
    "POSCTL": "POSCTL", "ALTCTL": "ALTCTL", "MANUAL": "MANUAL",
    "STABILIZED": "STABILIZED", "OFFBOARD": "OFFBOARD", "ACRO": "ACRO",
}
def normalize_mode(mavsdk_flight_mode) -> str: ...
```

**`check_link.py` 에는 re-export 를 남겨야 한다** — 안 그러면 저장소 밖 브리지가 깨진다.

```python
from dronelink import decode_px4_custom_mode, PX4_MAIN_MODE, PX4_SUB_MODE  # noqa: F401
```

> ⚠ `MAVSDK_TO_PX4` 표는 **`fake_fc.py` 로 실제 값을 찍어 확인한 뒤 확정**한다.
> MAVSDK `FlightMode` enum 의 정확한 멤버 이름을 문서가 아니라 실물로 확인하는 게 안전하다.

### 1단계. `fc_state.py` 에 모드 출력 — 위험 0, 5760, 송신 0바이트

이미 `hb` 를 손에 쥐고 있으니 두 줄이다.

```python
# fc_state.py, armed 출력 바로 아래
mode = decode_px4_custom_mode(hb.custom_mode)
print(f"    비행 모드     : {mode}  (custom_mode=0x{hb.custom_mode:08x})")
```

헤더에 적어 놓고 안 하던 일을 하는 것이라 **문서 수정도 필요 없다.**

### 2단계. `linkmon.py` 에 모드 전환 로깅 — ★ 가성비 최고

지금 linkmon 은 heartbeat 를 **생존 신호로만** 센다.
같은 heartbeat 안에 `custom_mode` 가 들어 있는데 버리고 있다.

```python
# linkmon.py, is_vehicle_heartbeat(msg) 블록 안
mode = decode_px4_custom_mode(msg.custom_mode)
armed = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
if (mode, armed) != last_state:
    if last_state is not None:          # 첫 관측은 전환으로 치지 않는다
        log(f"모드 전환 — {last_state[0]} → {mode} "
            f"(arm {'ARMED' if armed else 'DISARMED'}) "
            f"fc_boot_ms={last_boot_ms}")   # ← FC 시각 기준 (아래 참고)
    last_state = (mode, armed)
```

> **★ FC 시각을 같이 남겨야 한다 (2026-09-24 추가).**
> [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §5-3 ④ — **라즈베리파이에 RTC 가 없다.**
> 부팅 직후 시각이 틀어져 있을 수 있는데 `log()` 는 `datetime.now()` 를 쓴다.
> 그러면 모드 타임라인을 남겨도 **FC 의 ulog 와 시각을 맞출 수 없어 대조가 안 된다** —
> 이 단계의 가치가 절반으로 준다.
> `ATTITUDE` 나 `SYSTEM_TIME` 의 `time_boot_ms` 를 같이 적어 두면 ulog 와 붙일 수 있다.
> (linkmon 은 이미 모든 메시지를 받고 있으므로 최근 `time_boot_ms` 를 들고만 있으면 된다.)

얻는 것:

- **`logs/linkmon.log` 에 비행 전체의 모드 타임라인이 남는다.**
  지금은 FC 의 SD 카드에서 ulog 를 회수해야만 알 수 있다
- 14541 읽기 전용 포트라 **제어 스크립트와 전혀 충돌하지 않는다**
- `DevicePolicy=closed` 가 그대로 유지된다 — 송신 0바이트 원칙 안 깨짐
- 페일세이프가 발동해 FC 가 스스로 `AUTO.RTL` 로 갔을 때 **기록이 남는다**

> [CONTRACT §13-4](../drone/CONTRACT_x500.md) 의 `mode_changed` 이벤트가 브리지 쪽에
> 이미 같은 규칙("첫 관측은 전환으로 치지 않는다")으로 구현돼 있다.
> **같은 규칙을 그대로 쓰면 로그와 MQTT 가 일치한다.**

### 3단계. `takeoff_land.py` 모드 연동 — 핵심

여기가 "모드 연동" 의 본체다. 세 가지를 바꾼다.

#### (a) 모드 감시 태스크

```python
shared = {"mode": None, "prev": None}

async def watch_mode(drone, shared):
    async for m in drone.telemetry.flight_mode():
        name = normalize_mode(m)
        if name != shared["mode"]:
            print(f"[모드] {shared['mode']} → {name}")
            shared["prev"], shared["mode"] = shared["mode"], name
```

#### (b) 시간 대기 → 상태 대기

```python
EXPECTED = {"AUTO.TAKEOFF", "AUTO.LOITER", "AUTO.LAND"}

await drone.action.takeoff()
await wait_mode(shared, "AUTO.TAKEOFF", timeout=5)    # 명령이 먹었나  ← 10 아님, 아래 참고
await wait_mode(shared, "AUTO.LOITER",  timeout=30)   # 고도 도달했나
print(f"[대기] 호버 안정 — 여기서부터 {args.hold}초")
await hold_or_abort(shared, args.hold)                 # 8초 (감시하며)
```

`AUTO.TAKEOFF` 가 제 시간에 안 나오면 **명령이 씹힌 것**이므로 진행하지 않는다.
지금은 이걸 구분할 방법이 없다.

> **설계 근거** — [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §1-1:
> *"수락은 '하겠다'는 뜻이지 '했다'는 뜻이 아니다. 이륙 명령이 수락돼도 실제 고도 도달 여부는
> 텔레메트리로 따로 확인해야 한다."* — PX4 공식 문서가 이 단계를 요구한다.

> **★ 타임아웃을 10초로 잡으면 안 된다 (2026-09-24 수정).**
> `COM_DISARM_PRFLT` 기본값이 **10초**다 — arm 후 그 안에 이륙하지 않으면 **PX4 가 스스로 disarm** 한다.
> 첫 `wait_mode` 타임아웃을 10초로 두면 **만료 시점과 자동 disarm 시점이 겹쳐**,
> "명령이 씹혔다" 와 "PX4 가 시동을 껐다" 를 구분할 수 없다.
> 5초로 줄이면 그 안쪽에서 판정이 끝난다.
>
> 실행 전 **실제 `COM_DISARM_PRFLT` 값을 읽어** 그보다 확실히 짧은지 확인한다
> (`failsafe_audit.py` 의 `SPEC` 에 추가할 항목 — 아래 5절).
>
> 참고로 현재 코드의 `set_takeoff_altitude()` → `arm()` → `takeoff()` 순서는
> **파라미터 쓰기가 arm 앞에 있어서** 이 10초를 잡아먹지 않는다. 이 순서는 유지한다.

#### (c) ★ 사람이 뺏으면 손을 뗀다 — 1-1 문제의 해법

```python
async def hold_or_abort(shared, seconds):
    """호버 중 모드가 예상 밖으로 바뀌면 = 사람 개입 또는 페일세이프."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        m = shared["mode"]
        if m not in EXPECTED:
            raise ModeTakenOver(m)      # land() 를 보내지 않는다
        await asyncio.sleep(0.1)
```

그리고 `finally` 의 무조건 `land()` 를 바꾼다.

```python
except ModeTakenOver as e:
    print(f"[중단] 모드가 {e.mode} 로 바뀌었다 — 사람 또는 FC 가 기체를 잡았다.")
    print("       스크립트는 land 를 보내지 않는다. ★ 조종기로 마무리할 것 ★")
    if e.mode == "POSCTL":
        print("       (POSCTL = 스틱 오버라이드. 일부러 개입했거나, 스틱이 살짝 건드려졌다.")
        print("        어느 쪽이든 지금 기체는 조종기 것이다. 그대로 POSCTL 로 착륙시킨다.)")
    return 2                    # ← 새 종료 코드
```

판정 기준:

| 바뀐 모드 | 해석 | 코드의 행동 |
|---|---|---|
| **`POSCTL`** | **사람이 뺏음** — 모드 스위치 **또는 스틱 오버라이드** | 즉시 손 뗌, `land()` 안 보냄 |
| `ALTCTL` / `MANUAL` / `STABILIZED` | 사람이 모드 스위치로 뺏음 | 즉시 손 뗌 |
| `AUTO.RTL` | **FC 페일세이프 발동** (RC 상실·데이터링크 상실·배터리·지오펜스) | 손 뗌 + 로그 |
| `AUTO.LAND` (내가 안 보냈는데) | FC 페일세이프 | 손 뗌 + 로그 |
| `AUTO.TAKEOFF` → `AUTO.LOITER` | 정상 진행 | 계속 |

> **★ `POSCTL` 이 특별한 이유 (2026-09-24 추가)** —
> [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §2-3 에 따르면
> **`COM_RC_OVERRIDE` 는 기본으로 켜져 있고**, 자동 모드(Takeoff/Land/Hold/Mission)에서는
> **스틱을 조금만 움직여도 Position 으로 넘어간다** (민감도 `COM_RC_STICK_OV`).
>
> 우리는 AUTO 모드만 쓰므로 **이 기능이 그대로 살아 있다.** 두 가지 뜻이 있다.
>
> | | |
> |---|---|
> | ✅ 좋은 소식 | 개입 수단이 **둘 다** 작동한다 — 모드 스위치도, 스틱도. 선행 조사 4-2 절의 "미확인" 항목이 풀렸다 |
> | ⚠ 새 주의점 | **실수로 스틱을 건드려도** 똑같이 abort 된다. 조종사가 "나는 아무것도 안 했는데 스크립트가 손을 뗐다" 고 느낄 수 있다 |
>
> 그래서 abort 메시지가 이유를 설명해야 한다. **판정을 바꾸지는 않는다** —
> 어느 쪽이든 기체는 이미 조종기 것이고, 코드가 `land()` 를 보내면 안 되는 상황인 건 같다.
>
> 비행 전 `COM_RC_STICK_OV` 실제 값을 읽어 두면 "얼마나 살짝 건드려야 넘어가는지" 를 알 수 있다.

> **`AUTO.RTL` 감지의 중요도가 올라갔다** — §5-3 ① 에 따르면 `NAV_DLL_ACT` 는
> **라즈베리파이 링크뿐 아니라 Air Unit(지상국) 링크가 끊겨도** 발동할 수 있다.
> 즉 **파이는 멀쩡한데 기체가 스스로 RTL 을 시작하는 경우**가 실제로 있을 수 있고,
> 그때 코드가 `land()` 를 보내면 귀환 중인 기체를 그 자리에 내려 버린다.
> 둘 중 어느 링크가 `NAV_DLL_ACT` 의 기준인지는 **비행 전에 확인해야 할 항목**이다.

> **"코드가 물러나는 것" 이 이 설계의 요점이다.**
> 모드 조회는 명령을 더 보내기 위해서가 아니라,
> **언제 명령을 멈춰야 하는지 알기 위해서** 필요하다.

### 4단계. 명시적 모드 명령 — 정말 필요할 때만

MAVSDK Action 플러그인에 `action.hold()`(→`AUTO.LOITER`)와
`action.return_to_launch()`(→`AUTO.RTL`)가 있다.
쓰기 전에 `dir(drone.action)` 으로 실제 존재를 확인한다.

다만 이건 [README 6-5](../drone/README.md) 의 "명령은 최소한으로" 원칙을 넓히는 일이다.
**`land()` 로 충분하면 추가하지 않는 쪽을 권한다.**
굳이 넣는다면 `--rtl-on-abort` 같은 옵트인 플래그로, 기본값은 꺼짐으로 두는 게
기존 설계와 일관된다.

---

## 3. 하지 말아야 할 것

| 하지 말 것 | 이유 |
|---|---|
| **OFFBOARD 도입** | 파이가 죽으면 즉시 페일세이프. [README 6-5](../drone/README.md) 의 근본 전제를 깬다 (아래 상세) |
| **브리지(`drone-node`)에 모드 명령 추가** | `DevicePolicy=closed` + CONTRACT `ping` 하나. 구조와 규약을 동시에 깨야 한다 |
| **페일세이프 파라미터를 코드로 쓰기** | 원칙 3. 자동화가 기체 설정을 말없이 바꾸면 원인 추적 불가 |
| **`check_link.py` 에서 모드 코드를 그냥 삭제** | 저장소 밖 브리지가 import 중. re-export 필수 |

### OFFBOARD 를 쓰지 않는 이유 — 구체적 근거 (2026-09-24 보강)

[`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §3·§5-2 가 OFFBOARD 의 실제 요구 조건을 적어 놨다.
우리 구조와 하나씩 맞춰 보면 **전부 어긋난다.**

| OFFBOARD 가 요구하는 것 | 우리 구조 |
|---|---|
| 셋포인트를 **2Hz 이상** 끊김 없이 (권장 10~20Hz) | 파이가 hang 하면 45~52초 뒤 복구 — **한참 전에 페일세이프** |
| 모드 진입 **전에 1초 이상** 선행 송신 | 현재 스크립트는 명령 한 번 보내고 끝나는 구조 |
| 위치 셋포인트에 **지역 위치 추정 필요** | 실내 GPS 없음 = 사실상 불가 (지금 겪고 있는 문제) |
| RC 스틱 오버라이드가 **기본 꺼짐** | **개입 수단이 하나 줄어든다** — 3단계 (c) 설계의 전제가 무너진다 |
| **이륙·착륙을 offboard 로 하지 말 것** (PX4 공식) | 우리가 하려는 게 정확히 이륙·착륙이다 |

> 네 번째 줄이 특히 중요하다. OFFBOARD 에서는 **스틱을 흔들어도 회수되지 않고 모드 스위치를 직접 돌려야 한다.**
> 지금 AUTO 방식은 스틱만 건드려도 회수되므로 **개입 문턱이 훨씬 낮다.**
> OFFBOARD 도입은 성능이 아니라 **안전 여유를 깎는 거래**다.

---

## 4. 우선순위

| 순서 | 작업 | 위험 | 얻는 것 |
|---|---|---|---|
| **0** | **`failsafe_audit.py` SPEC 확장 + 1회 실행** (5-3) | **0** | **3단계 설계에 필요한 실제 값. 기준선 기록도 겸한다** |
| 1 | 0단계 `dronelink.py` 승격 | 0 | 이후 전부의 전제 |
| 2 | **2단계 linkmon 모드 로깅** | 0 | **비행 기록 확보 — 지금 당장 가치** |
| 3 | 1단계 `fc_state.py` 모드 출력 | 0 | 문서-코드 불일치 해소 |
| 4 | **3단계 takeoff_land 모드 연동** | 중 | **1-1 의 사람↔코드 충돌 해소** |
| 5 | 4단계 명시적 모드 명령 | 중 | 권장하지 않음 |

**0번이 새로 맨 앞에 왔다 (2026-09-24).** 3단계의 타임아웃(`COM_DISARM_PRFLT`)과
판정 기준(`COM_RC_OVERRIDE`·`COM_RC_STICK_OV`)이 **전부 FC 파라미터 실측값에 걸려 있다.**
값을 모르고 설계하면 숫자를 지어내는 셈이 된다.

> **실기 시험은 2-0 절의 킬 스위치 설정 후에.** 코드 작성(1~4번)은 그 전에 해도 된다.

1~3번은 **FC 로 나가는 바이트를 1도 늘리지 않는다.**
읽기 전용 원칙이 그대로 유지되고, 실물 FC 없이 `fake_fc.py` 로 전부 검증할 수 있다.

4번만 제어 경로를 건드리는데, 이것도 **명령을 추가하는 게 아니라
"안 보내는 조건" 을 추가**하는 방향이라 위험은 줄어든다.

---

## 5. 검증 — 실물 FC 없이 어디까지 되나

[`fake_fc.py`](../drone/scripts/fake_fc.py) 가 `PX4_AUTO_LOITER` 를 `custom_mode` 로 실어
heartbeat 를 보낸다. 모드 전환 시나리오를 모사하려면 이 값을 시간에 따라 바꾸면 된다.

### 5-1. 두 가지 시험 수단 — 역할이 다르다

> **2026-09-27 변경 — SITL 은 쓰지 않는다.** 대신 **프로펠러를 뺀 실기**로 확인한다.
> SITL 은 PX4 **기본 파라미터**로 도는데, 우리가 확인하려는 값(`COM_DISARM_PRFLT` 등)은
> 애초에 **우리 기체의 값**이었다. 실기가 더 강한 근거다.
> 자세한 절차는 [`00_통합개발계획서_x500.md`](00_통합개발계획서_x500.md) **P4-5** 에 있다.

|  | [`fake_fc.py`](../drone/scripts/fake_fc.py) | **실기 + 프로펠러 제거** |
|---|---|---|
| 정체 | 우리가 만든 **인형** — 정해진 메시지를 쏠 뿐 | **실물 FC(PX4)** — Commander 가 실제로 판단한다 |
| 답할 수 있는 것 | *"모드가 X 로 바뀌면 **내 코드가** 어떻게 반응하나"* | *"**우리 FC 가** 실제로 어떻게 행동하나"* |
| 못 하는 것 | arm 거부·모드 전이 규칙·페일세이프를 **재현하지 못한다** | **기체가 떠야 하는 것** — 이륙 전이, 비행 중 페일세이프 |
| 위험 | 없음 (FC 없이) | **arm 한다 — 모터가 돈다.** 프로펠러 제거 필수 |

**둘 다 필요하다.** `fake_fc` 로 코드의 반응을 먼저 짜고, 실기로 FC 의 실제 거동을 확인한다.
순서를 바꾸면 안 된다 — 코드가 엉뚱하게 반응하는 것을 실기에서 처음 발견하면 곤란하다.

### 5-2. 검증 항목

| 검증 대상 | `fake_fc` | **실기 프로펠러 제거** | **실기 비행(P5)** |
|---|---|---|---|
| 0단계 어휘 정규화 | ✅ | ✅ 실물 문자열 확인 | — |
| MAVSDK `FlightMode` enum 실제 이름 | ✅ **완료** | — | — |
| 1단계 `fc_state` 모드 출력 | ✅ | ✅ | — |
| 2단계 linkmon 전환 로깅 | ✅ | ✅ | — |
| 2단계 FC 시각 병기 | ✅ | ✅ | — |
| 3단계 (b) 코드의 상태 대기 로직 | ✅ | — | ✅ 실제 타이밍 |
| 3단계 (c) 코드의 abort 반응 | ✅ | **✅ 모드 스위치로** | — |
| **`COM_DISARM_PRFLT` 실제 동작** | ✖ | **✅ arm 후 대기** | — |
| **모드 스위치로 `POSCTL` 진입** | ✖ | **✅** | — |
| Ctrl-C 시 `land()` 실제 발사 여부 | ✅ | — | — |
| **`AUTO.TAKEOFF → AUTO.LOITER` 전이** | ✖ | **✖ 떠야 한다** | **✅ 여기서 처음** |
| **페일세이프 → `AUTO.RTL` 전이** | ✖ | **✖ armed 비행 필요** | **✅ 여기서 처음** |

**프로펠러 제거로 `fake_fc` 의 공백 대부분이 메워진다.** 남는 것은 마지막 두 줄 —
**기체가 실제로 떠야만 확인되는 것** 뿐이고, 그건 SITL 을 세웠더라도 우리 기체의 값으로는
답하지 못했을 항목이다.

> ⚠ **프로펠러를 뺀 채로 `takeoff_land.py` 를 정상 실행하지 않는다.** 고도 도달이 없어
> 얻는 것이 없고 착륙·고장 감지기가 끼어들어 거동이 예측 불가하다.
> abort 검증은 `--observe` 플래그로 한다 (P4-5 (c)).

> `fake_fc.py` 는 실물 FC 가 붙어 있으면(`mode=drone`) 스스로 실행을 거부한다.
> 시험은 FC 를 떼거나 정비 모드에서 한다.

### 5-3. `failsafe_audit.py` 의 `SPEC` 에 추가할 파라미터

이 계획을 실행하려면 값을 알아야 하는데 현재 감사 목록에 없는 것들이다.
[`failsafe_audit.py` L48-66](../drone/scripts/failsafe_audit.py#L48) 에 줄만 더하면 된다 (읽기 전용 그대로).

| 파라미터 | 왜 필요한가 | 어느 단계가 쓰나 |
|---|---|---|
| **`COM_DISARM_PRFLT`** | arm 후 자동 disarm 까지의 시간. 타임아웃을 이보다 짧게 잡아야 한다 | 3단계 (b) |
| **`COM_RC_OVERRIDE`** | 스틱 오버라이드가 켜져 있나 (기본 켜짐이지만 **이 기체 값은 미확인**) | 3단계 (c) |
| **`COM_RC_STICK_OV`** | 얼마나 움직여야 넘어가나 — 오작동 abort 빈도를 좌우한다 | 3단계 (c) |
| `COM_DISARM_LAND` | 착지 후 자동 disarm 시간 | 3단계 마무리 판정 |
| `MPC_TKO_SPEED` | 이륙 속도 — `AUTO.LOITER` 대기 타임아웃 산정 | 3단계 (b) |
| `MIS_TAKEOFF_ALT` | 현재 값 확인 (스크립트가 1.5m 로 덮어쓴다) | 참고 |

선행 조사에서 이미 지적한 `NAV_DLL_ACT`·`NAV_RCL_ACT`·`COM_LOW_BAT_ACT` 는 이미 `SPEC` 에 있다.
**한 번 돌려서 결과를 남기는 일만 남았다.**

---

## 6. 관련 문서

| 문서 | 언제 |
|---|---|
| [`FLIGHT_MODE_ANALYSIS_x500.md`](FLIGHT_MODE_ANALYSIS_x500.md) | **이 계획의 근거** — 현재 거동 조사 |
| [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) | **PX4 쪽 표준 동작·파라미터** — 0-1 절 갱신의 출처 |
| [`MODE_PLAN_REGRESSION_RISK_x500.md`](MODE_PLAN_REGRESSION_RISK_x500.md) | 이 계획이 현재 진행도를 깨뜨리지 않는지 |
| [`drone/README.md`](../drone/README.md) | 6-5 절(OFFBOARD 배제), 11 절(원칙) |
| [`drone/CONTRACT_x500.md`](../drone/CONTRACT_x500.md) | §13-4 `mode_changed` 규칙 — 2단계가 따라야 할 기준 |
| [`drone/FLIGHT_CHECKLIST_x500.md`](../drone/FLIGHT_CHECKLIST_x500.md) | 4·5단계 절차 — 3단계 구현 시 이 문서도 갱신 필요 |
| [`drone/scripts/dronelink.py`](../drone/scripts/dronelink.py) | 0단계 대상 |
| [`drone/scripts/fake_fc.py`](../drone/scripts/fake_fc.py) | 5절 검증 도구 |
