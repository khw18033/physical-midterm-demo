# 조치 체크리스트 — 2026-09-24

**근거 문서**: [`MODE_PLAN_REGRESSION_RISK_x500.md`](MODE_PLAN_REGRESSION_RISK_x500.md) §6·§7
**현재 상태**: [체크리스트](../drone/FLIGHT_CHECKLIST_x500.md) 3단계 통과 (프로펠러 제거, 모터 가동 확인)
**목표**: 진행도를 깨지 않고 모드 조회·연동을 넣는다

> 회귀 위험 문서 §7 은 [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) 반영 **전에** 쓴 절차다.
> 그 뒤 계획서에 0번 우선순위(감사 목록 확장)와 2-0 절(킬 스위치)이 생겼다.
> **이 문서가 둘을 합친 최종 순서다.**

---

## 0. 한 장 요약

| 단계 | 할 일 | 코드 수정 | FC 쓰기 | 게이트 |
|---|---|---|---|---|
| **A** | 기준선 확보 | 감사 도구만 | 없음(읽기) | A4 없이 B 로 가지 않는다 |
| **B** | `dronelink.py` 승격 | **부팅 경로** | 없음 | B4 통과해야 C |
| **C** | 관측 기능 추가 | 서비스 2개 | 없음 | — |
| **D** | 실기 준비 | — | QGC(사람) | 킬 스위치 없이 프로펠러 금지 |

**A 가 끝나기 전에는 `dronelink.py` 를 건드리지 않는다.** 기준선이 없으면 침범 여부를 판정할 수 없다.

---

## A. 기준선 확보 — 지금 당장, 코드 수정 전

### A1. 복귀 지점 확인

```bash
cd ~/drone && git status --short && git log --oneline -1
```

**통과 기준**: 출력이 비어 있다(clean). 그러면 **현재 HEAD 가 그대로 복귀 지점**이다.
`drone/` 은 `.gitignore` 화이트리스트에 있어 추적되므로 `git checkout` 으로 되돌릴 수 있다.

> 지저분하면 먼저 커밋하거나 stash 한다. **깨끗한 복귀 지점 없이 A2 로 가지 않는다.**

### A2. `failsafe_audit.py` 감사 목록 확장

계획 3단계의 타임아웃·판정 기준이 **전부 이 값들에 걸려 있다.** 모르면 숫자를 지어내게 된다.

[`failsafe_audit.py` L48-66](../drone/scripts/failsafe_audit.py#L48) 의 `SPEC` 리스트 끝에 추가:

```python
    ("── 모드 전환·arm 타이밍 (2026-09-24 추가) ──", None, None),
    ("COM_DISARM_PRFLT", None, "★ arm 후 이륙 안 하면 자동 disarm 까지 (초)"),
    ("COM_DISARM_LAND",  None, "착지 후 자동 disarm 까지 (초)"),
    ("COM_RC_OVERRIDE",  None, "★ 자동 모드 스틱 오버라이드 — 비트마스크. 의미는 QGC 설명 참조"),
    ("COM_RC_STICK_OV",  None, "스틱 오버라이드 민감도 (%)"),
    ("MPC_TKO_SPEED",    None, "이륙 상승 속도 (m/s)"),
    ("MIS_TAKEOFF_ALT",  None, "기본 이륙 고도 (m) — 스크립트가 1.5 로 덮어쓴다"),
```

**왜 이것만은 A 단계에서 고쳐도 되는가** — 회귀 위험 문서 §7 은 "기준선을 뜬 뒤에 코드를 건드린다"
고 했는데, 그 취지는 **부팅 경로를 건드리지 말라**는 것이다. `failsafe_audit.py` 는

- systemd 서비스가 아니다 (수동 실행 전용)
- 저장소 안에서 아무도 import 하지 않는다 (grep 0건)
- `PARAM_REQUEST_READ` 만 보낸다 — **FC 에 쓰지 않는다**

→ **기준선을 훼손할 수 없다.** `SPEC` 에 줄만 더하는 것이라 `decode()` 도 손댈 필요가 없다
(int/float 를 `param_type` 으로 알아서 가른다).

**통과 기준**: `./venv/bin/python scripts/failsafe_audit.py --help` 가 에러 없이 뜬다.

### A3. 기준선 수집 — FC 연결, 프로펠러 제거 상태

> ⚠ **`logs/` 가 아니라 `baseline/` 이다.** `.gitignore` 가 `/drone/logs/` 를 제외하므로
> 거기 두면 **커밋되지 않고 이 장비에만 남는다.** 기준선은 기록이지 런타임 산출물이 아니다.

```bash
cd ~/drone
mkdir -p baseline/fc_260924
date -Is                                  | tee baseline/fc_260924/TIMESTAMP
systemctl is-active drone-detect drone-mavlink-router drone-linkmon drone-node \
                                          | tee baseline/fc_260924/services.txt
cat state/mode                            | tee baseline/fc_260924/mode.txt
vcgencmd get_throttled                    | tee baseline/fc_260924/throttled.txt
./venv/bin/python scripts/fc_state.py     | tee baseline/fc_260924/fc_state.txt
./venv/bin/python scripts/failsafe_audit.py | tee baseline/fc_260924/failsafe.txt
./venv/bin/python scripts/check_link.py --device udpin:0.0.0.0:14540 \
                                          | tee baseline/fc_260924/check_link.txt
git add baseline/fc_260924/ && git commit -m "P0-3: FC 기준선 스냅샷 (2026-09-24)"
```

**통과 기준**: 7개 파일이 전부 생기고, `mode.txt` 가 `drone`, `services.txt` 가 전부 `active`,
**그리고 커밋됐다**.

### A4. ★ 판정 — 기준선을 읽는다

수집만 하고 넘어가면 의미가 없다. **최소 두 값은 눈으로 확인한다.**

| 값 | 어디서 | 왜 |
|---|---|---|
| **`NAV_DLL_ACT`** | `failsafe.txt` | **0 이면** 파이가 죽어도 기체가 계속 호버 → 조종기 필수. **0 이 아니면** 기체가 스스로 RTL·착륙 → 놀라서 잘못 개입하면 위험. **5단계 시나리오가 통째로 갈린다** |
| **`COM_DISARM_PRFLT`** | `failsafe.txt` | 계획 3단계 (b) 의 첫 타임아웃을 이보다 **확실히 짧게** 잡아야 한다 (기본 10초 → 5초 제안) |

참고로 볼 것: `COM_RC_OVERRIDE`(스틱 개입이 실제로 켜져 있나), `COM_RC_STICK_OV`(오작동 abort 빈도),
`COM_DISARM_LAND`, `MPC_TKO_SPEED`.

### A5. ★★ `PROGRESS.md` 에 진행도 기록 — **가장 중요한 한 칸**

**이게 없으면 이후 무엇이 깨져도 원인을 가릴 수 없다.**

저장소는 아직 `arm` 이 `COMMAND_DENIED`(`Preflight Fail: heading estimate not stable`)라고
기록하고 있다. `heading` 은 **실내/실외에 따라 바뀌는 조건**이라, 나중에 arm 이 안 될 때
코드 탓인지 환경 탓인지 구분이 불가능해진다.

`PROGRESS.md` 맨 뒤에 덧붙일 것:

- [ ] 3단계 통과 일시
- [ ] **실내/실외 여부** ← 가장 중요
- [ ] GPS `fix_type`·위성 수, `system_status`(`STANDBY` 였나)
- [ ] arm 까지 걸린 시간, 모터 4개 상태
- [ ] **안전 스위치를 눌렀는지** (`COM_PREARM_MODE` 가 설정돼 있다면 절차의 일부다)
- [ ] A3 기준선 파일 경로

그리고 [체크리스트 §7](../drone/FLIGHT_CHECKLIST_x500.md) "아직 모르는 것" 표에서
**"PX4 가 `action.arm()` 을 수락하는가"** 를 "검증 끝" 으로 옮긴다.

> **A4·A5 를 끝내지 않았다면 B 로 넘어가지 않는다.**

---

## B. `dronelink.py` 승격 — 유일한 위험 구간

`dronelink.py` 는 **`drone-detect`·`drone-linkmon`·`drone-node` 세 서비스의 공통 의존성**이다.
오타 하나면 `drone-detect` 가 5초마다 영원히 재시작하고, `state/mode` 가 `none` 에서 멈추고,
라우터가 안 떠서 **`arm_disarm_test.py` 조차 연결하지 못한다** (= 0단계 회귀).

> ⚠ **전 과정을 프로펠러 제거 상태에서. arm 상태에서는 어떤 서비스도 재시작하지 않는다.**

### B1. 순수 추가만

기존 `load_env`·`make_cfg`·**`is_vehicle_heartbeat` 는 한 글자도 건드리지 않는다.**
세 서비스가 전부 `is_vehicle_heartbeat` 하나만 쓰므로, 추가만 하면 기존 동작이 바뀔 이유가 없다.

`check_link.py` 에는 **re-export 를 남긴다** — 저장소 밖 MQTT 브리지가 import 중이다.

```python
from dronelink import decode_px4_custom_mode, PX4_MAIN_MODE, PX4_SUB_MODE  # noqa: F401
```

### B2. import 스모크 테스트 — 배포 전 필수

```bash
cd ~/drone/scripts
../venv/bin/python -c "import dronelink, fc_detect, linkmon, check_link; print('import ok')"
```

**통과 기준**: `import ok` 출력. **이게 통과하면 B 구간의 재시작 루프는 일어나지 않는다.**

> 이 명령이 유효한 근거(확인함): `fc_detect.py` 는 `__main__` 가드가 있고 모듈 수준에서는
> 설정 상수만 계산한다. `load_env` 가 `OSError` 를 삼키므로 env 파일이 없어도 뜬다.
> `scripts/` 에 `__init__.py` 가 없어 전부 최상위 모듈이라 **그 디렉터리에서 실행해야 한다.**

### B3. 서비스 재시작 — 한 번에 하나, 판정하며

```bash
sudo systemctl restart drone-detect
sleep 12 && cat ~/drone/state/mode
systemctl is-active drone-mavlink-router drone-linkmon drone-node
```

**통과 기준**: `mode` 가 **`drone`**, 나머지 셋이 전부 `active`.

> `systemctl is-active drone-detect` 만으로 판정하지 않는다.
> `StartLimitIntervalSec=0` 때문에 유닛이 `failed` 로 굳지 않고 계속 재시작하므로
> **"뭔가 돌고는 있다" 처럼 보인다.** 판정은 `state/mode` 로 한다.

### B4. ★ 3단계 재확인 — "침범하지 않았다" 의 증명

```bash
cd ~/drone && ./venv/bin/python scripts/arm_disarm_test.py
```

**프로펠러가 제거돼 있는지 다시 확인한다.**
**통과 기준**: 모터 4개 회전 → `DISARMED ✔`. A5 에 기록한 것과 같은 결과.

**이걸 해야 회귀가 없다고 말할 수 있다.**

### B5. 실패 시 롤백

```bash
cd ~/drone && git checkout -- scripts/dronelink.py scripts/check_link.py
sudo systemctl restart drone-detect
sleep 12 && cat ~/drone/state/mode        # drone 으로 돌아오는지
```

---

## C. 관측 기능 — B4 통과 후

| # | 작업 | 통과 기준 |
|---|---|---|
| C1 | `linkmon.py` 모드 전환 로깅 (+ `time_boot_ms` 병기) | `logs/linkmon.log` 에 모드 전환 줄이 남는다. `systemctl is-active drone-linkmon` = `active` |
| C2 | `fc_state.py` 모드 출력 | `AUTO.LOITER` 같은 문자열이 찍힌다 |

**C1 이 깨져도 1~3단계는 그대로 돌아간다** — `Requires=` 가 단방향이라 linkmon 이 죽어도
라우터는 안 죽는다. 잃는 것은 로그뿐이다.

> C1 주의: `WatchdogSec` 이 없는 유닛이라 **hang 은 아무도 못 깨운다.**
> 모드 디코딩에서 예외를 삼키지 말 것 — 터져야 `Restart=on-failure` 가 작동한다.

---

## D. 실기 준비 — 4·5단계로 가기 전

### D1. ⚠ 킬 스위치 (필수)

[`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) §5-4 가 **미설정**이라고 적었다.
3단계는 프로펠러가 없어 통과할 수 있었지만, **프로펠러를 다는 4단계부터는 없으면 안 된다.**
[체크리스트 §2](../drone/FLIGHT_CHECKLIST_x500.md) 가 이미 요구하는 항목이다.

**QGC 에서 사람이 설정하고, 지상에서 동작을 확인한다.**

### D2. 지오펜스 `GF_*` (권장)

1.5m 이륙이라도 폭주 시 경계가 있는 편이 낫다.

### D3. 불필요 — 하지 않아도 된다

`COM_OF_LOSS_T`, `COM_OBL_RC_ACT` 는 **OFFBOARD 전용**이다. 우리는 쓰지 않는다.
원본 문서는 "넷을 정해야 한다" 고 했지만 **우리 구성은 D1·D2 둘만 해당**한다.

---

## 지금 하지 않아도 되는 것

| 항목 | 왜 미루나 |
|---|---|
| `takeoff_land.py` 모드 연동 (계획 3단계) | 5단계가 미검증이라 **침범할 진행도가 없다.** A4 에서 `COM_DISARM_PRFLT` 실측값을 얻은 뒤 설계해도 늦지 않다 |
| SITL 구축 | 값이 크지만 별도 작업. A~C 는 없어도 진행된다 |
| `state/mode` 이름 충돌 정리 | 동작에 문제 없음. 건드리면 세 서비스가 걸린다 |
| 명시적 모드 명령 (`hold`/`RTL`) | 권장하지 않음 |

---

## 관련 문서

| 문서 | 무엇 |
|---|---|
| [`MODE_PLAN_REGRESSION_RISK_x500.md`](MODE_PLAN_REGRESSION_RISK_x500.md) | **이 체크리스트의 근거** — 왜 이 순서인지 |
| [`MODE_INTEGRATION_PLAN_x500.md`](MODE_INTEGRATION_PLAN_x500.md) | B·C 에서 실제로 넣을 코드 |
| [`FLIGHT_MODE_ANALYSIS_x500.md`](FLIGHT_MODE_ANALYSIS_x500.md) | 왜 모드 조회가 필요한지 |
| [`PX4_동작정리_260924.md`](PX4_동작정리_260924.md) | A2 파라미터 목록의 출처 |
| [`drone/FLIGHT_CHECKLIST_x500.md`](../drone/FLIGHT_CHECKLIST_x500.md) | A5 §7 표 갱신, D1 킬 스위치 |
| [`drone/PROGRESS.md`](../drone/PROGRESS.md) | A5 기록 위치 (맨 뒤) |
