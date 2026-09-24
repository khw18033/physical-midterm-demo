# X500 v2 — 모드 개선 계획의 진행도 침범 위험 검토

**대상 코드**: [`drone/`](../drone/) · **작성일**: 2026-09-24 · **브랜치**: `drone-pi3`

**전제 — 현재 진행도 (사용자 보고, 2026-09-24)**
[체크리스트](../drone/FLIGHT_CHECKLIST_x500.md) **3단계까지 통과**.
프로펠러 제거 상태에서 `arm_disarm_test.py` 로 **모터 가동 확인**.

**검토 대상**: [`MODE_INTEGRATION_PLAN_x500.md`](MODE_INTEGRATION_PLAN_x500.md) 의 0~4단계
**검토 질문**: 이 계획을 실행하면 이미 확보한 0~3단계가 깨질 수 있는가?

---

## 0. 결론

**두 개로 나뉜다.**

| | 판정 |
|---|---|
| **확인된 기능 자체** | ✅ **안전** — 계획서는 [`arm_disarm_test.py`](../drone/scripts/arm_disarm_test.py) 를 **한 줄도 건드리지 않는다** |
| **그 기능을 실행할 수 있는 상태** | ⚠ **위험 있음** — 계획 0단계가 **부팅 경로의 단일 실패점**을 건드린다 |

`arm_disarm_test.py` 는 혼자서는 아무것도 못 한다. 라우터가 14540 을 열어 줘야 돌아가고,
라우터는 `drone-detect` 가 띄워 주며, `drone-detect` 는 **`dronelink.py` 를 import 한다.**
그리고 계획 0단계의 대상이 바로 그 `dronelink.py` 다.

> 계획서는 0단계를 "위험 0" 이라고 적었다. **그건 "FC 로 나가는 바이트" 기준이었고,
> "시스템 가용성" 기준으로는 0 이 아니다.** 이 문서가 그 차이를 메운다.

---

## 1. 현재 진행도가 의존하는 것

| 체크리스트 단계 | 통과 | 의존하는 코드 |
|---|---|---|
| 0 — 전원 인가, `mode=drone` | ✅ | `fc_detect.py` → **`dronelink.py`**, `sdwatchdog.py`, mavlink-router |
| 1 — 링크 확인 | ✅ | `check_link.py` → **`dronelink.py`** |
| 2 — 텔레메트리·GPS | ✅ | `telemetry_watch.py`, `fc_state.py` |
| **3 — 모터 가동** | ✅ | **`arm_disarm_test.py`** + 0단계의 라우터 |
| 4 — 수동 호버 | ✖ | (조종기 — 코드 무관) |
| 5 — 자동 이륙 | ✖ | `takeoff_land.py` |

### `dronelink.py` 를 import 하는 곳 — 실측

```
drone/scripts/check_link.py:33   from dronelink import is_vehicle_heartbeat
drone/scripts/fc_detect.py:29    from dronelink import is_vehicle_heartbeat
drone/scripts/linkmon.py:26      from dronelink import is_vehicle_heartbeat
```

여기에 **저장소 밖의 MQTT 브리지가 하나 더 있다.**
[`hw-drone.env`](../drone/config/hw-drone.env) 가 `HW_DRONE_SCRIPTS=/home/physical/drone/scripts` 를
주면서 주석에 이렇게 적어 놨다:

> `# 재사용하는 pi3 스크립트 (is_vehicle_heartbeat, decode_px4_custom_mode)`

즉 브리지는 **`dronelink.py` 와 `check_link.py` 를 둘 다** 쓴다.
(브리지 코드는 `~/hw/pi/drone/` 에 있어 이 저장소에서 확인할 수 없다. 위 주석이 근거다.)

**정리하면 `dronelink.py` 는 서비스 세 개의 공통 의존성이다.**

```
dronelink.py
   ├── drone-detect    (root, 부팅 필수, 라우터를 띄우는 주체)
   ├── drone-linkmon   (drone.target 소속)
   └── drone-node      (MQTT 브리지 — check_link.py 도 함께)
```

---

## 2. 계획서가 건드리는 파일 × 진행도 교차표

| 파일 | 계획 단계 | 진행도 의존 | 침범 위험 |
|---|---|---|---|
| **`dronelink.py`** | 0 | **0·1단계 + 서비스 3개** | **★★★** |
| `check_link.py` | 0 (re-export) | 1단계, 브리지 | ★★ |
| `linkmon.py` | 2 | 0단계(서비스) | ★★ |
| `fc_state.py` | 1 | 2단계 보조 도구 | ★ |
| `takeoff_land.py` | 3 | **없음** (5단계 미검증) | **0** |
| **`arm_disarm_test.py`** | — | **3단계 ✅** | **0 — 대상 아님** |
| `mavlink-router.conf` | — | 0단계 전체 | **0 — 대상 아님** |
| systemd 유닛 | — | 0단계 전체 | **0 — 대상 아님** |

**확인된 3단계를 만들어 낸 파일과 설정은 계획서의 수정 대상에 전혀 없다.**

---

## 3. ★ 진짜 침범 경로 — `dronelink.py` 오타 하나

계획 0단계는 `dronelink.py` 에 모드 어휘(딕셔너리 2개 + 함수 2개)를 **추가**한다.
추가만 해도 파일 전체가 다시 파싱되므로, 문법 오류나 잘못된 import 하나면 이렇게 된다:

```
dronelink.py 오류
   → fc_detect.py import 실패 → 즉시 종료
   → drone-detect: Restart=always, RestartSec=5, StartLimitIntervalSec=0
   → 5초마다 영원히 재시작 (유닛이 failed 로 굳지도 않는다)
   → state/mode 가 영영 "none"
   → drone.target 이 안 뜸 → mavlink-router 없음
   → 14540 · 14541 · 14542 · 14543 · 5760 전부 없음
   → arm_disarm_test.py 포함 모든 스크립트가 연결 실패
```

**결과: 0단계로 회귀.** 3단계 코드는 멀쩡한데 실행할 수가 없다.

### 왜 조용히 일어나는가

`StartLimitIntervalSec=0` 이 붙어 있다 ([drone-detect.service](../drone/systemd/drone-detect.service)).
이건 "hang 이 반복될 때 유닛이 failed 로 굳는 게 제일 나쁘다" 는 판단으로 **의도적으로** 넣은 값이다.
평상시엔 옳지만, **이 경우엔 고장을 감춘다** — 유닛이 `failed` 로 멈추지 않고 계속
`activating ↔ 재시작` 을 반복하므로 `systemctl is-active` 가 순간적으로
"뭔가 돌고는 있다" 처럼 보일 수 있다.

**판정은 `cat ~/drone/state/mode` 로 한다.** 체크리스트 0단계가 이미 그렇게 시킨다.

---

## 4. 부차 위험 세 가지

### 4-1. `linkmon.py` 수정 (계획 2단계) — 영향 제한적

[drone-linkmon.service](../drone/systemd/drone-linkmon.service) 를 읽어 확인한 것:

| 항목 | 값 | 함의 |
|---|---|---|
| `Requires=drone-mavlink-router.service` | 단방향 | **linkmon 이 죽어도 라우터는 안 죽는다** |
| `Restart=on-failure`, `RestartSec=5` | — | 예외로 죽으면 5초 뒤 복귀 |
| `WatchdogSec` | **없음** | hang 은 못 잡는다 (detect·node 와 다름) |
| `ProtectSystem=strict` + `ReadWritePaths=.../logs` | — | 로그 외엔 못 쓴다 — 계획 2단계는 로그만 쓰므로 정책 안쪽 |

→ **linkmon 이 깨져도 1~3단계는 그대로 돌아간다.** 잃는 것은 링크 로그뿐이다.
단, `WatchdogSec` 이 없으므로 **hang 에 빠지면 아무도 못 깨운다.** 모드 디코딩을
heartbeat 마다 도는 루프 안에 넣을 때 예외를 삼키지 말고 터뜨려야 `Restart=on-failure` 가 작동한다.

### 4-2. `check_link.py` 수정 — 저장소 안에서는 위험 0, 밖은 확인 필요

grep 결과 **저장소 안에서 `check_link.py` 를 import 하거나 호출하는 곳은 0건**이다.
위험은 저장소 **밖의 브리지**뿐이고, 계획서가 요구한 re-export 한 줄을 지키면 막힌다.

### 4-3. `fc_state.py` 수정 — 위험 낮음, 다만 절차를 막을 수 있다

서비스가 아니라 수동 실행 도구다. 깨져도 아무것도 안 죽는다.
다만 **3단계 직전 arm 가능 판정에 쓰는 도구**라 깨지면 현장 절차가 한 칸 막힌다.

---

## 5. 검토 중 발견 — `check_link.py` 헤더의 사실 오류

[`check_link.py` L7](../drone/scripts/check_link.py#L7) 에 이렇게 적혀 있다:

> `# 4단계 drone-detect.service 가 이 스크립트의 종료 코드를 재사용한다.`

**사실이 아니다.** `fc_detect.py` 는 감지 로직을 독립적으로 구현하고 있고
`check_link` 를 호출하지 않는다 (grep 0건, [drone-detect.service](../drone/systemd/drone-detect.service) 의
`ExecStart` 도 `fc_detect.py` 하나).

이건 **좋은 소식**이다 — `check_link.py` 를 고쳐도 부팅 경로가 영향을 받지 않는다.
계획서가 `check_link.py` 를 ★★ 로 본 것은 이 헤더를 믿었기 때문이고, 실제로는 **★** 이 맞다.
([`FLIGHT_MODE_ANALYSIS_x500.md`](FLIGHT_MODE_ANALYSIS_x500.md) 5절 불일치 표에 한 줄 추가할 항목이다.)

---

## 6. ★ 더 큰 문제 — 회귀 기준선이 기록돼 있지 않다

침범 여부를 **판정할 근거가 저장소에 없다.**

| 저장소가 말하는 것 | 실제 |
|---|---|
| [`PROGRESS.md`](../drone/PROGRESS.md) 최신 기록: `arm` 이 **`COMMAND_DENIED`**, 사유 `Preflight Fail: heading estimate not stable` | **arm 성공, 모터 가동 확인** |
| [체크리스트 §7](../drone/FLIGHT_CHECKLIST_x500.md) "아직 모르는 것": *"PX4 가 `action.arm()` 을 수락하는가 — 3단계에서 밝혀짐"* | **이미 밝혀짐** |

**지금 상태로 코드를 고치면, 나중에 arm 이 안 될 때 원인을 가릴 수 없다.**
코드 수정 탓인지, 환경(실내/실외·GPS·heading) 탓인지, 원래 그랬던 건지 구분이 안 된다.
`heading estimate not stable` 은 **실내/실외에 따라 바뀌는 조건**이라 특히 그렇다.

> 이 저장소의 원칙 7 은 "판단 근거를 남긴다" 이다.
> **진행도가 기록되지 않으면 침범당했는지조차 알 수 없다.**

### 지금 당장 남겨야 할 것

```bash
cd ~/drone
./venv/bin/python scripts/fc_state.py    | tee /tmp/baseline_fc_state.txt
./venv/bin/python scripts/failsafe_audit.py | tee /tmp/baseline_failsafe.txt
```

그리고 `PROGRESS.md` 맨 뒤에: 3단계 통과 일시, **실내/실외 여부**, GPS fix·위성 수,
`system_status`, arm 까지 걸린 시간, 모터 4개 상태,
**안전 스위치를 눌렀는지**(`COM_PREARM_MODE` — 있다면 절차의 일부다).

`failsafe_audit.py` 는 [선행 조사 문서](FLIGHT_MODE_ANALYSIS_x500.md) 4-3 절에서
**실측값이 저장소에 없다**고 지적한 그 값들이다. 기준선 기록과 한 번에 해결된다.

> **2026-09-24 추가 — 한 번에 같이 얻어 두면 좋은 것.**
> [`MODE_INTEGRATION_PLAN_x500.md`](MODE_INTEGRATION_PLAN_x500.md) 5-3 절이 `failsafe_audit.py` 의
> `SPEC` 에 6개(`COM_DISARM_PRFLT`·`COM_RC_OVERRIDE`·`COM_RC_STICK_OV`·`COM_DISARM_LAND`·
> `MPC_TKO_SPEED`·`MIS_TAKEOFF_ALT`)를 추가하라고 한다. **줄만 더하면 되는 읽기 전용 변경**이므로,
> 기준선을 뜰 때 미리 넣어 두면 **한 번 돌려서 기준선과 3단계 설계값을 동시에 얻는다.**
> 이 6개는 전부 계획 3단계의 타임아웃·판정 기준을 정하는 값이라, 모르면 숫자를 지어내게 된다.

### ⚠ 4단계로 넘어가기 전 — 킬 스위치

[`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §5-4 는 **킬 스위치 채널이 아직 미설정**이라고 적었다.
3단계는 프로펠러 제거 상태라 없이도 통과할 수 있었지만,
**프로펠러를 다는 4단계부터는 없으면 안 된다** ([체크리스트 §2](../drone/FLIGHT_CHECKLIST_x500.md) 가 이미 요구).

진행도 관점에서는 **3단계 통과가 4단계 준비 완료를 뜻하지 않는다**는 뜻이다.

---

## 7. 안전한 진행 절차

> ⚠ **전 과정을 프로펠러 제거 상태에서 한다. arm 상태에서는 어떤 서비스도 재시작하지 않는다.**

### 1. 기준선 기록 (6절) — 코드를 건드리기 전에

### 2. 커밋해서 되돌릴 지점을 만든다

`drone/` 은 `.gitignore` 화이트리스트에 있어 추적된다. `git status` 가 현재 clean 이므로
**지금이 깨끗한 복귀 지점이다.**

### 3. `dronelink.py` 는 순수 추가만

기존 `load_env`, `make_cfg`, **`is_vehicle_heartbeat` 는 한 글자도 건드리지 않는다.**
세 서비스가 전부 `is_vehicle_heartbeat` 하나만 쓰고 있으므로, 추가만 하면 기존 동작이 바뀔 이유가 없다.

### 4. 배포 전 import 스모크 테스트

```bash
cd ~/drone/scripts
../venv/bin/python -c "import dronelink, fc_detect, linkmon, check_link; print('import ok')"
```

**이 명령이 유효한 근거** (확인함):
- `fc_detect.py` 는 `if __name__ == "__main__"` 가드가 있고, 모듈 수준에서는 설정 상수만 계산한다
- `load_env` 가 `OSError` 를 삼키므로 `/etc/drone-node.env` 가 없어도 기본값으로 뜬다
- `scripts/` 에 `__init__.py` 가 없다 — 전부 최상위 모듈이라 그 디렉터리에서 실행해야 한다

→ **import 가 통과하면 3절의 재시작 루프는 일어나지 않는다.**

### 5. 서비스는 한 번에 하나씩, 판정하며

```bash
sudo systemctl restart drone-detect
sleep 12 && cat ~/drone/state/mode        # ← drone 이어야 한다 (0단계 판정 기준)
systemctl is-active drone-mavlink-router drone-linkmon drone-node
```

### 6. 3단계 재확인

`arm_disarm_test.py` 를 **프로펠러 제거 상태로** 다시 한 번 돌려 회귀가 없음을 확인한다.
이걸 해야 "침범하지 않았다" 를 말할 수 있다.

### 7. 롤백

```bash
cd ~/drone && git checkout -- scripts/dronelink.py
sudo systemctl restart drone-detect
```

---

## 8. 최종 판정

| 계획 단계 | 진행도 침범 가능성 | 조건 |
|---|---|---|
| **0 — `dronelink.py` 승격** | ⚠ **있음 (부팅 경로)** | 순수 추가 + import 스모크 테스트로 **실질 0 에 가깝게 낮출 수 있다** |
| 0 — `check_link.py` re-export | 낮음 (저장소 밖만) | re-export 한 줄 유지 |
| 1 — `fc_state.py` 모드 출력 | 매우 낮음 | — |
| 2 — `linkmon.py` 모드 로깅 | 낮음 (로그만 잃음) | 예외를 삼키지 말 것 |
| **3 — `takeoff_land.py` 연동** | **없음** | 5단계는 아직 미검증 — 침범할 진행도가 없다 |
| 4 — 명시적 모드 명령 | 없음 | (권장하지 않음) |

**한 줄 요약**:
계획서 자체는 확인된 3단계를 건드리지 않는다. 위험은 **0단계가 `dronelink.py` 라는
세 서비스의 공통 의존성을 지난다**는 점 하나뿐이고, 순수 추가 + import 테스트 +
단계별 재시작으로 관리된다.
**정작 더 시급한 것은 코드가 아니라 6절 — 지금 확보한 진행도를 기록으로 남기는 일이다.**

---

## 9. 관련 문서

| 문서 | 언제 |
|---|---|
| [`MODE_INTEGRATION_PLAN_x500.md`](MODE_INTEGRATION_PLAN_x500.md) | **검토 대상** — 수정 계획 본문 |
| [`FLIGHT_MODE_ANALYSIS_x500.md`](FLIGHT_MODE_ANALYSIS_x500.md) | 모드 거동 조사 (5절 불일치 표 = 5절 항목 추가 대상) |
| [`drone/FLIGHT_CHECKLIST_x500.md`](../drone/FLIGHT_CHECKLIST_x500.md) | §7 "아직 모르는 것" 표 갱신 필요 |
| [`drone/PROGRESS.md`](../drone/PROGRESS.md) | 6절 기준선 기록 위치 (맨 뒤) |
