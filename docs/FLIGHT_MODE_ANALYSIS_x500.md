# X500 v2 — 비행 모드 조사 보고서

**대상 코드**: [`drone/`](../drone/) (라즈베리파이 컴패니언 컴퓨터)
**조사일**: 2026-09-24 · **브랜치**: `drone-pi3` · **기체**: X500 v2 (`x500-001`) · **FC**: 코아 H743 (PX4)

**조사 질문 세 가지**

1. 현재 코드로 드론을 제어할 때 드론의 **모드에 관여할 수 있는가**
2. 모드가 **제어 명령에 따라 어떻게 바뀌는가**
3. **코드 제어 외**(조종기·QGC·페일세이프)로 제어할 때 모드가 어떻게 바뀌어야 하는가

> 이 문서는 **조사 보고서**다. 코드를 수정하지 않았다.
> 실제 비행 절차는 [`FLIGHT_CHECKLIST_x500.md`](../drone/FLIGHT_CHECKLIST_x500.md) 를 본다.

---

## 0. 결론 한 줄

**이 코드에는 "모드를 바꿔라"라는 명령이 단 한 줄도 없다.**
모드는 항상 `takeoff()` / `land()` 의 **부수효과**로만 바뀌고, 그나마도 **코드가 바뀐 모드를 확인하지 않는다.**
나머지 모드 전환은 전부 사람(조종기·QGC)과 PX4 페일세이프의 몫이다.

---

## 1. 코드가 FC 로 보내는 것 전부

`drone/scripts/*.py` 전체에서 FC 로 나가는 호출을 전수 조사한 결과다.

| 스크립트 | FC 로 보내는 것 | 모드에 영향? |
|---|---|---|
| [`takeoff_land.py`](../drone/scripts/takeoff_land.py) | `set_takeoff_altitude` / `arm` / `takeoff` / `land` / `disarm` | **있음 (간접)** |
| [`arm_disarm_test.py`](../drone/scripts/arm_disarm_test.py) | `arm` / `disarm` | 없음 |
| [`check_link.py`](../drone/scripts/check_link.py) | `heartbeat` / `PARAM_REQUEST_READ` / `SET_MESSAGE_INTERVAL` | 없음 |
| [`failsafe_audit.py`](../drone/scripts/failsafe_audit.py) | `PARAM_REQUEST_READ` | 없음 |
| [`fc_detect.py`](../drone/scripts/fc_detect.py) | `heartbeat` | 없음 |
| [`telemetry_watch.py`](../drone/scripts/telemetry_watch.py) · [`fc_state.py`](../drone/scripts/fc_state.py) · [`linkmon.py`](../drone/scripts/linkmon.py) | **0바이트** | 없음 |

### 없는 것이 더 중요하다

`SET_MODE`, `MAV_CMD_DO_SET_MODE`, MAVSDK 의 `action.hold()`, `action.return_to_launch()`,
`offboard.*`, `manual_control.*` 가 **전부 0건**이다.

`drone-linkmon` 과 `drone-node` 는 systemd 의 `DevicePolicy=closed`
([`drone-node.service`](../drone/systemd/drone-node.service) L47, [`drone-linkmon.service`](../drone/systemd/drone-linkmon.service) L24)
로 시리얼 장치를 **열 수조차 없게** 구조로 막혀 있다. 약속이 아니라 구조다.

> ⚠ **예외 하나** — `action.set_takeoff_altitude()` 는 실제로는 **FC 파라미터 `MIS_TAKEOFF_ALT` 쓰기**다.
> [`README.md`](../drone/README.md) 11절 원칙 3 "FC 파라미터는 읽기만 한다" 와 충돌한다.
> 같은 README 6-4 표에는 파라미터를 쓴다고 솔직히 적혀 있다. 문서 내 모순이다.

---

## 2. 제어 명령에 따라 모드가 어떻게 바뀌는가

`takeoff_land.py` 실행 시의 실제 타임라인이다.
(PX4 동작은 표준 동작 기준, 코드 근거는 행 번호로 표시)

| # | 코드가 하는 일 | PX4 모드 | arm |
|---|---|---|---|
| 0 | (실행 전) | **`AUTO.LOITER`** — 실측 `custom_mode=0x03040000`, `base_mode=29` | DISARMED |
| 1 | `set_takeoff_altitude(1.5)` ([L100](../drone/scripts/takeoff_land.py#L100)) | 변화 없음 (파라미터 쓰기) | DISARMED |
| 2 | `arm()` ([L108](../drone/scripts/takeoff_land.py#L108)) | **변화 없음** — arm 은 모드를 바꾸지 않는다 | → ARMED |
| 3 | `takeoff()` ([L115](../drone/scripts/takeoff_land.py#L115)) | `AUTO.LOITER` → **`AUTO.TAKEOFF`** (sub=2) | ARMED |
| 4 | (고도 도달 — **PX4 가 자발적으로**) | `AUTO.TAKEOFF` → **`AUTO.LOITER`** (sub=3) | ARMED |
| 5 | `sleep(8)` ([L126](../drone/scripts/takeoff_land.py#L126)) | — | ARMED |
| 6 | `land()` ([L130](../drone/scripts/takeoff_land.py#L130)) | → **`AUTO.LAND`** (sub=6) | ARMED |
| 7 | (착지 — **PX4 가 자발적으로**) | `AUTO.LAND` 유지 | → **자동 DISARMED** |

### 핵심 세 가지

1. **코드가 도달시킬 수 있는 모드는 `AUTO.TAKEOFF` · `AUTO.LOITER` · `AUTO.LAND` 셋뿐이다.**
   `AUTO.RTL`, `POSCTL`, `ALTCTL`, `MANUAL`, `OFFBOARD` 는 이 코드로 **절대 들어갈 수 없다.**
   이건 사고가 아니라 [README 6-5](../drone/README.md) 의 의도된 설계다 (OFFBOARD 배제).

2. **4번과 7번은 코드가 시킨 게 아니다.** PX4 가 알아서 하는 전환이고 코드는 관여하지 않는다.

3. 7번의 자동 disarm 은 PX4 파라미터 `COM_DISARM_LAND` 에 달려 있는데
   **이 값은 저장소 어디에서도 읽은 적이 없다.** 코드는 착륙 후 `disarm()` 을 명시적으로 부르지 않고
   PX4 에 전적으로 맡긴다.

### 모드 문자열 디코딩

[`check_link.py`](../drone/scripts/check_link.py) 의 `decode_px4_custom_mode()` 가 유일한 해석기다.

```
main = (custom_mode >> 16) & 0xFF      # 4 = AUTO
sub  = (custom_mode >> 24) & 0xFF      # 2 = TAKEOFF, 3 = LOITER, 5 = RTL, 6 = LAND
```

실측 `0x03040000` → main=4(AUTO), sub=3(LOITER) → **`AUTO.LOITER`** (MAVSDK 표기로는 `HOLD`).
MQTT 가시화 브리지도 이 함수를 그대로 재사용한다 ([`hw-drone.env`](../drone/config/hw-drone.env) 의 `HW_DRONE_SCRIPTS`).

---

## 3. ★ 코드는 자기가 유발한 모드를 확인하지 않는다

조사에서 나온 **가장 실질적인 문제**다.

**`takeoff_land.py` 에는 `flight_mode()` 구독이 0건이다.**
보는 것은 `armed()`, `health()`, `in_air()` 셋뿐이다.

### 3-1. "8초 호버" 가 실제로는 8초 호버가 아니다

[L126](../drone/scripts/takeoff_land.py#L126) 의 `sleep(8)` 은 `takeoff()` 의 ACK 를 받은 **직후부터** 센다.
1.5m 도달 여부와 무관하다. 상승 중에 `land()` 가 나가면 PX4 는 `AUTO.TAKEOFF` 에서 곧장 `AUTO.LAND` 로 넘어간다.

1.5m 라 실질 위험은 작지만, 문서가 설명하는 동작(`AUTO.TAKEOFF → AUTO.LOITER 8초 → AUTO.LAND`)과 다를 수 있다.
`EXTENDED_SYS_STATE` 의 `landed_state` 나 `flight_mode()` 를 보면 확정할 수 있는데 보지 않는다.

### 3-2. `fc_state.py` 는 비행 모드를 보여 준다고 적어 놓고 보여 주지 않는다

[헤더 5~6행](../drone/scripts/fc_state.py#L5) 에 "비행 모드" 가 적혀 있지만,
출력 코드(L69-101)는 `hb.custom_mode` 를 **한 번도 쓰지 않는다.**
실제 출력은 `system_status`, arm 비트, GPS, 센서 헬스, 배터리뿐이다. 문서와 코드 불일치다.

### 3-3. 비행 중 모드를 실시간으로 볼 경로가 사실상 파이에 없다

`flight_mode()` 를 읽는 유일한 코드는 [`telemetry_watch.py` L45](../drone/scripts/telemetry_watch.py#L45) 인데,
이것도 `takeoff_land.py` 와 **같은 14540 포트를 다투므로 동시 실행이 불가능**하다
(체크리스트 §6-[B]).

| 경로 | 포트 | 이륙 중 사용 가능? |
|---|---|---|
| `telemetry_watch.py` | 14540 | ✗ `takeoff_land.py` 와 충돌 |
| `fc_state.py` | 5760 | △ 동시 실행은 되지만 **모드를 출력하지 않음** (3-2) |
| **QGroundControl** | 5760 | ✅ |
| **MQTT 가시화 브리지** | 14543 | ✅ (단, 코드는 이 저장소 밖 `~/hw/pi/drone/`) |

---

## 4. 코드 외 제어 — 모드가 어떻게 바뀌어야 하는가

### 4-1. 사람이 만드는 모드

| 단계 | 누가 | 모드 |
|---|---|---|
| 0~3단계 (링크·텔레메트리·모터 시험) | — | PX4 기본값 그대로 (`AUTO.LOITER`). **모드와 무관한 단계** |
| **4단계 수동 호버** | **조종기** | 사람이 모드 스위치로 **`POSCTL`(Position)** 에 놓고 띄운다 |
| 5단계 자동 이륙 중 개입 | **조종기** | `AUTO.*` → **모드 스위치를 POSCTL 로 내려 AUTO 를 뺏는다** |
| 언제든 | **QGC** | 모드 전환·파라미터 변경 가능. 저장소 규칙상 **파라미터 쓰기는 사람이 QGC 로만** |

[체크리스트 §2](../drone/FLIGHT_CHECKLIST_x500.md) 에 "비행 모드 스위치 배치 (Position / Altitude / Manual)" 확인 항목이 있다.

> **4단계를 5단계보다 먼저 하는 진짜 이유가 두 개다.**
> 문서에는 "기체가 제대로 뜨는지 먼저 확인한다" 만 적혀 있지만,
> 4단계는 동시에 **5단계의 유일한 안전망인 모드 스위치가 실제로 작동하는지 확인하는 단계**다.

### 4-2. 개입 방법은 둘 — `COM_RC_OVERRIDE` (2026-09-24 갱신)

체크리스트는 "조종기를 손에 들고 즉시 개입" 을 반복해서 요구한다. 개입 방법은 둘이다.

| 방법 | 확실성 |
|---|---|
| **모드 스위치를 POSCTL 등으로 전환** | 확실 — 명시적 모드 변경 |
| **스틱만 움직여 AUTO 를 자동 해제** | **기본으로 작동한다** — `COM_RC_OVERRIDE` 기본 켜짐 |

> **2026-09-24 갱신** — 이 항목은 처음 조사할 때 "미확인" 이었다.
> [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §2-3 에 답이 있다:
> **자동 모드(Takeoff/Land/Hold/Mission)에서는 스틱을 조금만 움직여도 Position 으로 넘어간다.**
> `COM_RC_OVERRIDE` 가 기본 켜짐이고, 민감도는 `COM_RC_STICK_OV` 가 정한다.
> (OFFBOARD 에서는 반대로 기본 꺼짐이다 — 우리는 OFFBOARD 를 안 쓰므로 해당 없음.)
>
> 즉 **우리 구성에서는 개입 수단이 둘 다 살아 있다.** 좋은 소식이다.
> 다만 뒤집으면 **실수로 스틱을 건드려도 AUTO 가 풀린다**는 뜻이라,
> 모드 연동 코드가 이걸 "사람의 의도적 개입" 과 구분할 수 없다
> ([`MODE_INTEGRATION_PLAN_x500.md`](MODE_INTEGRATION_PLAN_x500.md) 3단계 (c) 참고).

**다만 이 기체의 실제 값은 여전히 읽은 적이 없다.** 위는 PX4 기본값이다.
[`failsafe_audit.py`](../drone/scripts/failsafe_audit.py) 의 `SPEC` 목록(L48-66)에 `COM_RC_OVERRIDE` 와
`COM_RC_STICK_OV` 가 없으므로, 비행 전 감사 목록에 추가해서 확인한다.

기록된 관련 실측값은 `COM_RC_IN_MODE = 3` (RC 또는 조이스틱 중 먼저 오는 것) 하나뿐이다
([`PROGRESS.md`](../drone/PROGRESS.md) L1471 부근).

> **킬 스위치는 모드 전환이 아니다.** 즉시 모터 정지이고 되돌릴 수 없다.
> 모드로 개입하는 것과 별개의 최후 수단이다.

### 4-3. PX4 가 스스로 바꾸는 모드 (페일세이프)

`failsafe_audit.py` 가 읽는 값들이 곧 **"사람도 코드도 개입 안 했는데 모드가 바뀌는"** 경우다.

| 파라미터 | 트리거 | 결과 모드 |
|---|---|---|
| `NAV_DLL_ACT` | **라즈베리파이·지상국 링크 상실** | 0=유지 / 1=`AUTO.LOITER` / 2=`AUTO.RTL` / 3=`AUTO.LAND` / 4=Disarm / 5=Terminate |
| `NAV_RCL_ACT` | 조종기 상실 | 동일 enum |
| `COM_LOW_BAT_ACT` | 배터리 부족 | 0=경고만 / 1=`AUTO.RTL` / 2=`AUTO.LAND` / 3=단계별 |
| `GF_ACTION` | 지오펜스 이탈 | 동일 enum |
| `COM_OBL_ACT` | OFFBOARD 상실 | **해당 없음** (OFFBOARD 미사용) |

#### ⚠ 이 기체의 실제 값이 저장소 어디에도 기록되어 있지 않다

`PROGRESS.md` 와 각 REPORT 를 전부 뒤졌지만
`NAV_DLL_ACT` / `NAV_RCL_ACT` / `COM_LOW_BAT_ACT` 의 **실측값이 없다.**
도구는 만들어 놨는데 실물 FC 에 돌린 결과가 남아 있지 않다.

이게 중요한 이유는 **`NAV_DLL_ACT` 값 하나로 비행 중 시나리오가 정반대가 되기 때문**이다.

| 값 | 파이가 죽었을 때 | 사람이 해야 할 일 |
|---|---|---|
| `0` | 기체가 **그 고도에서 계속 호버** | **조종기로 직접 내려야 한다** |
| `2` | 기체가 **스스로 RTL 을 시작** | 가만히 둔다 — 놀라서 잘못 개입하면 위험 |

[`failsafe_audit.py` L119-135](../drone/scripts/failsafe_audit.py#L119) 가 정확히 이 두 경우를 나눠
사람 말로 설명하도록 짜여 있다. 체크리스트 §4-1 도 "나가기 전에 반드시 한 번 돌릴 것" 이라고 적어 놨다.

---

## 5. 발견한 불일치 · 공백 정리

> 전부 **보고만** 한 것이고 수정하지 않았다.

| # | 내용 | 위치 | 성격 |
|---|---|---|---|
| 1 | `fc_state.py` 헤더는 "비행 모드" 를 본다고 하지만 출력에 없음 | [`fc_state.py`](../drone/scripts/fc_state.py#L5) L5 vs L69-101 | 문서-코드 불일치 |
| 2 | "8초 호버" 가 고도 도달과 무관한 단순 `sleep` — 상승 중 `land()` 가능 | [`takeoff_land.py` L126](../drone/scripts/takeoff_land.py#L126) | 동작 불일치 |
| 3 | `set_takeoff_altitude()` 는 파라미터 쓰기인데 README 원칙 3 은 "읽기만" | [`README.md`](../drone/README.md#L287) L287 vs 11절 | 문서 내 모순 |
| 4 | `COM_RC_OVERRIDE` / `COM_RC_STICK_OV` 실측값 미확인 (기본값은 4-2 절에서 확인됨) | `failsafe_audit.py` SPEC 누락 | 미검증 |
| 5 | `COM_DISARM_LAND` 미확인 — 착륙 후 자동 disarm 을 PX4 에 전적으로 위임 | 저장소 전체 | 미검증 |
| 6 | 페일세이프 실측값 미기록 — 모드 자동 전환 거동이 미지 | `PROGRESS.md` | **안전 공백** |
| 7 | 이륙 중 모드를 파이에서 실시간 관측할 경로 없음 (14540 포트 충돌) | 설계상 제약 | 관측 공백 |
| 8 | `check_link.py` 헤더의 *"drone-detect 가 이 스크립트의 종료 코드를 재사용한다"* 는 **사실이 아니다** — `fc_detect.py` 는 독립 구현 | [`check_link.py` L7](../drone/scripts/check_link.py#L7) | 문서-코드 불일치 |
| 9 | **`COM_DISARM_PRFLT` 기본 10초** — arm 후 이륙이 늦으면 PX4 가 스스로 disarm. 현재 코드는 이 제한을 전혀 고려하지 않는다 | [`takeoff_land.py`](../drone/scripts/takeoff_land.py#L106) | **설계 공백** |

---

## 6. 요약 답변

### Q1. 현재 코드로 모드에 관여할 수 있나?

직접은 **불가**. 모드 설정 명령 자체가 코드에 없다.
`takeoff()` / `land()` 를 통한 **간접 유발만** 가능하고,
도달 가능한 모드는 `AUTO.TAKEOFF` · `AUTO.LOITER` · `AUTO.LAND` 셋뿐이다.
이건 사고가 아니라 [README 6-5](../drone/README.md) 의 의도된 설계다.

### Q2. 제어 명령에 따라 모드가 어떻게 바뀌나?

- `arm` / `disarm` → **모드를 바꾸지 않는다** (arm 비트만 토글)
- `takeoff` → `AUTO.TAKEOFF`, 고도 도달 시 PX4 가 자발적으로 `AUTO.LOITER`
- `land` → `AUTO.LAND`, 착지 후 PX4 자동 disarm

**코드는 이 전환들을 하나도 검증하지 않는다.**

### Q3. 코드 외 제어 시 모드는?

- 4단계 수동 호버는 조종기 **`POSCTL`** 로 사람이 만든다
- 5단계 개입도 **모드 스위치로 AUTO 를 뺏는 것**이 확실한 방법이다
- 그 외 모드 전환은 PX4 페일세이프(`NAV_DLL_ACT` / `NAV_RCL_ACT` / `COM_LOW_BAT_ACT` / `GF_ACTION`)가 자동으로 한다

**이 기체의 실제 페일세이프 값이 기록돼 있지 않다.**
비행 전 `failsafe_audit.py` 를 돌리고 결과를 `PROGRESS.md` 에 남기는 것이
지금 가장 우선순위 높은 일이다.

```bash
cd ~/drone && ./venv/bin/python scripts/failsafe_audit.py
```

---

## 7. 관련 문서

| 문서 | 언제 |
|---|---|
| [`drone/README.md`](../drone/README.md) | 구조 전체 — 특히 6-4, 6-5, 6-6 절 |
| [`drone/FLIGHT_CHECKLIST_x500.md`](../drone/FLIGHT_CHECKLIST_x500.md) | **비행할 때** — 특히 §2 QGC 사전 확인, §4-1 |
| [`drone/scripts/failsafe_audit.py`](../drone/scripts/failsafe_audit.py) | 페일세이프 실측값이 필요할 때 |
| [`drone/scripts/check_link.py`](../drone/scripts/check_link.py) | `decode_px4_custom_mode()` — 모드 문자열 해석 |
| [`drone/PROGRESS.md`](../drone/PROGRESS.md) | 원인을 못 찾을 때 (맨 뒤가 최신) |
