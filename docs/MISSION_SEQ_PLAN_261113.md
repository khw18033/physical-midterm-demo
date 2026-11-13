# 복합 이동 미션(전후·좌우·회전 섞기) — 구현 계획 (2026-11-13)

> 상태: **구현 완료(2026-11-13), 실비행 미검증.** FC 없는 시험 통과(scripts/test_seq_plan.py 68 · flight_runner 61). 실기 설치(`install_seq.sh --install`)는 아직.
> 구현하면서 바뀐 점은 §9. 사용 설명은 `MISSION_SEQ.md`, 가시화 규약은 `MISSION_SEQ_요청_VZ.md`.
> 원칙: **기존 파일은 한 줄도 고치지 않는다.** 새 파일만 더한다(배포는 systemd drop-in 을 하나 더 얹는 방식).

---

## 0. 요약

| 지금 | 바꾼 뒤 |
|---|---|
| `test_sar(_rtk).py` 는 **전후 / 좌우 / 회전 중 하나**만 고르고, 그 한 동작을 L↔X 로 왕복 | 새 스크립트 `mission_seq.py` 가 **단계 목록**(예: `우 3m → 앞 1m → 시계 90° → 대기 5초`)을 받아 이어 붙인 하나의 미션으로 만든다 |
| 끝나면 언제나 L(이륙 지점)에 착륙 | 기본은 **마지막 단계가 끝난 자리에 착륙**, 옵션으로 L 복귀 후 착륙 |
| 가시화 「비행 제어」 탭: `rtk_test_start` 파라미터(고정 키) | 새 action `seq_mission_start` · `seq_mission_stop`, 단계는 평평한 숫자 키로 실어 보냄(규약이 `map<string,double>` 이라) |

예: 「5 m 이륙 → 오른쪽 3 m → 앞 1 m → 착륙」

```
mission_seq.py --altitude 5 --step right:3 --step forward:1
```

FC 에 올라가는 미션:

```
#0 TAKEOFF   L, 5m
#1 WAYPOINT  yaw 정렬 — L 상공, 헤딩 H0, align_hold 3초       (기존과 같음)
#2 SPEED     1 m/s
#3 WAYPOINT  단계 1 오른쪽 3m → P1 (= L 에서 H0+90° 방향 3m), 헤딩 H0, settle 2초
#4 SPEED     1 m/s
#5 WAYPOINT  단계 2 앞 1m    → P2 (= P1 에서 H0 방향 1m),     헤딩 H0, settle 2초
#6 LAND      P2
```

---

## 1. 기존 코드에서 그대로 가져가는 것 (근거)

`drone/scripts/test_sar.py` 의 뼈대가 이미 이 일에 맞다. 바뀌는 것은 `build_plan()` 이 만드는 **waypoint 목록** 뿐이다.

| 가져가는 것 | 위치 | 이유 |
|---|---|---|
| 미션 방식(전체를 FC 에 올리고 대조 후 arm) | `upload_verified`, `same_item`, `clear_mission` | 10-08 사고 대책. 복합 미션도 Pi 가 죽으면 FC 가 혼자 끝까지 가야 한다 |
| 연결·종료 안전장치 | `mavsdk_guard.connect/stop/abort` (import 만) | 공용 모듈이라 고치지 않고 쓴다 |
| `Telem`(모드 이탈 `ModeLost`), `LandWatch` | `test_sar.py:168-385` | 감시·착륙 판정 로직 동일 |
| arm 직전 yaw·위치 재확인, 이륙 후 yaw 정렬 항목 | `fly()`, `build_plan()` 의 `align` | 단계 방향이 전부 H0 기준이라 더 중요해진다 |
| waypoint 앞마다 `DO_CHANGE_SPEED` | `Plan.speed` | PX4 가 재개 시 속도를 되돌리는 문제 |
| 회전은 ≤90° 조각으로 나눈다 | `ROTATE_STEP` | PX4 는 최단 방향으로 돈다 — 방향 보장 |
| 중단 처리 표(Ctrl+C·시간 초과 → `--abort`, Pi 오류 → 명령 안 함) | `fly()` 의 except 들 | 그대로 |
| CAP_ON 캡처 | `cap_on/off`, `PassLog` | 단계별로 선택(§3-4) |

**재사용 방식**: `import test_sar` 하지 않고 **필요한 부분을 새 파일에 복사**한다.
저장소 규칙(SAR_FLIGHT_SCRIPTS.md §8-1 「스크립트끼리 import 하지 않고 `mavsdk_guard` 만 쓴다」)과 맞고,
나중에 `test_sar.py` 를 고쳐도 새 스크립트가 같이 깨지지 않는다. 대가는 중복(약 500줄)이다.

---

## 2. 새로 만드는 파일

| 파일 | 하는 일 |
|---|---|
| `drone/scripts/mission_seq.py` | 복합 미션 비행 스크립트 (단독 실행 가능, RTK 선택) |
| `drone/scripts/seq_plan.py` | **순수 함수만**: 단계 해석 · 좌표 계산 · 미션 항목 생성 · 예상 시간. MAVSDK 없이 import 된다 → 시험·가시화 미리보기 기준 |
| `drone/scripts/test_seq_plan.py` | `seq_plan` 단위 시험 (FC 없이) |
| `drone/flight_runner/seq.py` | `SeqRunner` — `FlightRunner` 를 **상속**(수정 아님)해 파라미터 → `--step` 옵션, 출력에서 `[계획]` 줄을 뽑아 상태에 실음 |
| `drone/flight_runner/node_seq.py` | `with_flight_runner(DroneNode)` 를 한 겹 더 감싸 `seq_mission_*` action 을 붙임, 두 실행기 사이 상호 배제 |
| `drone/flight_runner/test_seq.py` | 위 둘 시험 (가짜 스크립트·`LocalLauncher`) |
| `drone/flight_runner/deploy/61-mission-seq.conf` | drone-node 의 `ExecStart` 를 `-m flight_runner.node_seq` 로 덮는 drop-in (60 번 위에 얹힘, 지우면 원래대로) |
| `docs/MISSION_SEQ.md` | 사용 설명 (SAR_FLIGHT_SCRIPTS.md 형식) |
| `docs/MISSION_SEQ_요청_VZ.md` | 가시화 쪽에 보낼 규약 문서 (§5) |

`seq_plan.py` 를 따로 두는 것은 「스크립트끼리 import 금지」의 예외가 아니라, **새 스크립트 전용 부품**이다(`mavsdk_guard` 와 같은 위상).

---

## 3. 비행 스크립트 `mission_seq.py`

### 3-1. 단계(step) 종류

| 종류 | 명령줄 | 뜻 | 범위(초안) |
|---|---|---|---|
| 이동 | `forward:M` `back:M` `right:M` `left:M` | 지금 기수 기준 그 방향으로 M 미터 직선 이동. 기수는 안 돈다(옆·뒤로 비행) | 0.5~50 m |
| 회전 | `cw:DEG` `ccw:DEG` | 제자리에서 시계/반시계 회전. 이후 단계의 「앞」이 바뀐다 | 1~360°, 90° 조각으로 나눔 |
| 대기 | `hover:SEC` | 그 자리에서 정지 | 0~60 초 |
| (2차) 고도 | `up:M` `down:M` | 제자리 상승·하강 | 결과 고도 2~30 m |

- 단계마다 선택 꼬리: `right:3@0.5` (이 단계만 속도 0.5 m/s), `right:3+cap` (이 단계 동안 캡처).
- 단계 수 1~20.
- 입력 경로 세 가지 — 모두 같은 `seq_plan.parse_steps()` 로 들어간다:
  1. `--step KIND:VALUE` 반복 (실행기가 쓰는 형식)
  2. `--mission FILE.json` (`{"altitude":5,"steps":[{"kind":"right","value":3}, …]}`) — 자주 쓰는 미션 저장
  3. 터미널 대화형: 고도 → 단계를 한 줄씩 (`우 3`, `앞 1`, `시계 90`, `대기 5`, 빈 줄로 끝) → 요약 표 → `yes`

### 3-2. 방향 기준 — **기체 기준(누적)** 을 기본으로

「오른쪽」은 **그 단계 시점의 기수** 기준이다. `cw:90` 뒤의 `forward:2` 는 처음 기수에서 오른쪽으로 2 m 가 된다.
조종기 감각과 같고, 「돌고 나서 앞으로」 같은 미션을 자연스럽게 쓸 수 있다.

내부 계산(평면 근사, `test_sar.offset/ne` 와 같은 식):

```
상태 (n, e, yaw) = (0, 0, H0)            # L 원점, H0 = 경로를 잡을 때의 기수
이동  dir∈{0,90,180,270}:  bearing = yaw + dir;  n += d·cos(bearing); e += d·sin(bearing)
회전  ±θ:                  yaw += ±θ  (waypoint 는 90° 조각마다 하나, 위치는 그대로)
대기  t:                   같은 (n,e,yaw) 에 hold=t 인 waypoint
```

~~옵션 `--frame fixed`~~ — 만들지 않았다(§8 결정).

### 3-3. 미션 항목 만들기 (`seq_plan.build_items`)

```
TAKEOFF(L, alt) → WAYPOINT align(L, H0, align_hold)
→ 단계마다:
     이동:  SPEED(v) → WAYPOINT(Pk, yaw, settle)
     회전:  WAYPOINT(Pk, yaw+90) … (조각 수만큼, hold 0) → 마지막 조각에 settle
     대기:  WAYPOINT(Pk, yaw, hold=t)
→ 착륙:  --land here(기본): LAND(P_last)
         --land home:      SPEED → WAYPOINT(L) → LAND(L)
```

- 역할표 `roles[seq] = (종류, 단계 번호)` — 종류: `takeoff · align · speed · move · rot · hover · return · land`.
  `monitor()` 는 FC 가 알려 주는 현재 항목 번호로 지금 몇 번째 단계인지 안다(기존과 같은 방식).
- 모든 waypoint p4 에 **그 시점 yaw** 를 넣는다(기존은 전부 H0 하나).
- 같은 자리 연속 waypoint(회전 조각)는 도달 반경 안이라 PX4 가 yaw 만 맞추고 넘어간다 — 기존 회전 패턴과 같은 동작이고 실기에서 확인된 경로다.

### 3-4. 캡처

- 기본은 **캡처 안 함**(복합 미션은 SAR 측정이 아닐 수 있다).
- `+cap` 붙은 단계만: 그 단계 항목이 시작되면 ON, 목표점 도달(반경 안) 또는 항목이 넘어가면 OFF — 기존 `test_sar` 판정과 같은 규칙.
- 캡처 단계 사이에는 `--gap`(10초) 이상 쉬도록 `seq_plan` 이 검사하고, 모자라면 앞 단계 settle 을 늘리거나 거부한다(cansar 가 데이터를 옮길 시간).

### 3-5. 안전 검사 (arm 전, 하나라도 걸리면 이륙하지 않음)

| 검사 | 기준(초안) |
|---|---|
| 모든 waypoint 의 L 로부터 수평 거리 최대값 | ≤ `--max-radius`(기본 30 m) **그리고** FC `GF_MAX_HOR_DIST` 가 0 이 아니면 그보다 작게 (param 읽기만) |
| 총 이동 거리 | ≤ 300 m |
| 예상 시간 | 표시 + 시간 초과 기준(×2 + 60초) |
| 단계 수·각 값 범위 | §3-1 |
| 확인 화면 | 단계 표 + **글자 그림 평면도**(L·각 점·착륙점, 위가 처음 기수) + 최대 거리 + 착륙 위치 |

나머지(이미 arm, 위치 추정, 경로 잡은 뒤 5°/1 m 이상 움직임, 업로드 대조, 모드 이탈, Ctrl+C·SIGTERM)는 `test_sar.py` 와 같다.

### 3-6. RTK — 한 파일에서 선택

`test_sar` / `test_sar_rtk` 처럼 두 파일로 나누지 않고 `--rtk-min SEC`(0 = 확인 안 함, 기본 0) 하나로 둔다.
`>0` 이면 이륙 전 Fixed 연속 유지 대기와 경로 기준점 늦게 잡기만 한다. (단계 전 RTK 게이트는 캡처 단계 앞에서만 — 2차)

### 3-7. 로그 문구 (가시화가 읽는 원문 — 바뀌면 §5 문서도 고친다)

```
[계획] {"v":1,"L":[lat,lon],"h0":123.4,"alt":5,"land":"here","pts":[{"step":1,"kind":"right","value":3,"seq":3,"n":-2.4,"e":1.8,"lat":..,"lon":..,"yaw":123.4}, …],"land_pt":[lat,lon],"est_s":42,"hash":"…"}
[미션] #3  WAYPOINT 단계 1 오른쪽 3m …          (기존 [미션] 줄과 같은 꼴)
[미션] 진행 #3  WAYPOINT 단계 1 오른쪽 3m …      (기존과 같음)
STEP 1/2 START t=… kind=right value=3 속도 0.0m/s 고도 5.0m 헤딩 123.4°
STEP 1/2 END   t=… 목표 오차 0.31m 고도 5.0m 헤딩 123.1° dur=4.2s
       #3 단계 1/2 진행 2.1/3.0m  속도 1.0m/s  고도 5.0m  헤딩 123.4°  CAP    (2초마다)
[확인] 착륙 완료 ✔
```

- `[계획]` 은 **한 줄 JSON**. dry-run·실비행 둘 다 업로드 전에 한 번 찍는다.
- `hash` = 정규화한 단계 목록 + 고도 + 착륙 방식의 해시. 가시화가 「dry-run 한 미션과 지금 시작하는 미션이 같은가」를 맞춰 본다.
- `STEP k END` 의 목표 오차는 실제 위치와 계획점 사이 거리 — 미션이 제대로 따라갔는지 사후 확인용.

---

## 4. 비행 실행기 연동 (`flight_runner/seq.py`, `node_seq.py`)

### 4-1. action

| action | 하는 일 |
|---|---|
| `seq_mission_start` | `mission_seq.py --yes --step …` 를 별도 systemd 유닛으로 띄움(기존 `SystemdLauncher` 그대로) |
| `seq_mission_stop` | 주 프로세스에만 SIGTERM (기존과 같은 이유) |
| 비상 | 새로 만들지 않는다 — 기존 `rtk_test_emergency`(emergency_land.py) 를 그대로 쓴다. 어느 스크립트가 날든 같다 |

### 4-2. 파라미터 (`map<string,double>` 이라 문자열·배열을 못 싣는다 → 평평한 숫자 키)

| 키 | 뜻 |
|---|---|
| `altitude_m` | 필수 |
| `step_count` | 필수, 1~20 |
| `s{k}_kind` | 필수. 0 forward · 1 back · 2 right · 3 left · 4 cw · 5 ccw · 6 hover · (7 up · 8 down) |
| `s{k}_value` | 필수. m / 도 / 초 |
| `s{k}_speed_mps` | 선택 (이동 단계만) |
| `s{k}_capture` | 선택 0/1 |
| `speed_mps` · `heading_deg` · `accept_radius_m` · `align_hold_s` · `settle_s` · `gap_s` · `max_radius_m` · `rtk_min_s` | 선택, 같은 이름 옵션 |
| `land` | 선택 0 here · 1 home |
| `frame` | 선택 0 body · 1 fixed |
| `abort` | 선택 0 rtl · 1 hold · 2 land |
| `dry_run` · `confirmed` | 기존과 같은 규칙 (dry_run=0 이면 confirmed=1 필수) |

- `k` 가 1..step_count 에 빠짐없이 있어야 하고, 그 밖의 `s*` 키가 있으면 `INVALID_ARGUMENT`. 범위 검사는 스크립트(`ap.error`, 종료 코드 2)에 맡긴다 — 기존 원칙.
- `rtk_min_s` 는 실행기가 RTK 보정이 안 들어오면 0 으로 바꿔 넣는다(기존 `rtk_ok` 판정 재사용).

### 4-3. 상태 토픽 — `<base>/mission_run` (새 토픽, retain)

기존 `flight_run` 본문과 **같은 모양** + 두 필드:

```json
{ "...flight_run 과 같은 필드...",
  "run": { "...", "script": "mission_seq.py",
           "plan": { "[계획] 줄의 JSON 그대로" },
           "steps_hash": "…" } }
```

- 기존은 최근 200줄만 싣는다 — 긴 미션이면 `[계획]` 줄이 밀려 나간다. 그래서 `SeqRunner` 가 그 줄을 **따로 붙잡아** `plan` 에 둔다.
  실행기가 재시작해도 출력 파일을 처음부터 다시 읽으므로(`_restore` → `_read`) 다시 채워진다.
- 출력 폴더는 `cansar_logs/runner_seq/` — 기존 `runner_state.json` 과 섞이지 않게.

### 4-4. 두 실행기의 상호 배제 (중요)

`FlightRunner`(기존)와 `SeqRunner`(새것)는 서로를 모른다. 둘 다 동시에 띄우면 기체 하나에 비행 스크립트 둘이 붙는다.

- `node_seq.py` 의 `validate()` 에서: `rtk_test_start` 가 오면 `SeqRunner.running` 이면 거절, `seq_mission_start` 가 오면 `FlightRunner.running` 이면 거절(`FAILED_PRECONDITION already_running`).
  상속한 클래스에서 하므로 기존 `node.py` 는 그대로다.
- 그래도 새면 `mavsdk_guard.connect()` 가 UDP 14540 이 쓰이고 있다고 두 번째 스크립트를 명령 없이 끝낸다 — 두 번째 방어선.

### 4-5. 배포

```
drone-node.service
 └─ 60-flight-runner.conf   (기존)  ExecStart=… -m flight_runner.node
 └─ 61-mission-seq.conf     (새것)  ExecStart= / ExecStart=… -m flight_runner.node_seq
```

`node_seq` 는 `with_mission_seq(with_flight_runner(DroneNode))` 를 띄우므로 기존 세 action 도 그대로 살아 있다.
되돌리기는 61 번 파일만 지우고 `daemon-reload` + 재시작.

---

## 5. 가시화 연동 (가시화 저장소에 보낼 요청 문서의 뼈대)

### 5-1. 화면 흐름

```
[미션 편집] ──▶ [미리보기] ──▶ [dry-run] ──▶ [지도 확인] ──▶ [비행 시작] ──▶ [진행 표시] ──▶ [결과]
 단계 표          기체 기준      seq_mission_   [계획].pts 를     confirmed=1      현재 단계 강조
 추가/삭제/순서    평면도(로컬)   start dry_run=1 실제 지도 위에     같은 mission_key  실시간 위치 겹쳐 그림
```

1. **미션 편집**: 행 = (종류, 값, [속도], [캡처]). 위·아래 이동, 복제, 삭제. 이름 붙여 저장(브라우저 쪽).
2. **미리보기 (FC 없이)**: §3-2 식으로 로컬 평면도를 그린다 — 위쪽 = 이륙 직전 기수. 점마다 화살표로 기수 방향, 최대 거리 원, 예상 시간.
   계산 식은 `seq_plan.py` 와 **같아야** 하므로 요청 문서에 식과 시험 벡터(입력 단계 → 기대 (n,e,yaw))를 같이 넣는다. 시험 벡터는 `test_seq_plan.py` 에서 뽑는다.
3. **dry-run**: 결과의 `run.plan.pts[].lat/lon` 이 정답 좌표다. 지도 위에 그리고, 미리보기와 다르면(기수가 예상과 다름 등) 사용자가 본다.
4. **비행 시작**: dry-run 이 코드 0 으로 끝났고 `mission_key`(§9) 가 지금 편집기 내용과 같을 때만 버튼이 열린다(기존 command_id 짝짓기 규칙에 hash 비교 추가).
5. **진행 표시**:
   - 현재 단계: `[미션] 진행 #n` → `plan.pts[].seq` 로 단계 번호, 또는 `STEP k/N START/END`.
   - 실시간 위치·기수: 기존 drone-node `state` 토픽(gps lat/lon, attitude) 을 같은 지도에 겹친다 — 새로 낼 것 없음.
   - 캡처 중이면 진행 줄의 `CAP`.
6. **결과**: `STEP k END … 목표 오차` 를 단계 표 옆에 붙인다. `[확인] 착륙 완료 ✔` / 종료 코드.

### 5-2. 기존 「비행 제어」 탭과의 관계

- 기존 탭(`rtk_test_*`, `flight_run`)은 그대로 둔다. 새 탭(또는 같은 탭의 「복합 미션」 모드)이 `seq_mission_*`, `mission_run` 을 쓴다.
- Capability 에 `seq_mission_start` 가 보이면 새 화면을 연다 — 61 번 drop-in 이 없는 기체에서는 자동으로 숨는다.
- 비상 버튼은 두 화면 모두 같은 `rtk_test_emergency`.

---

## 6. 시험 계획

| 단계 | 무엇을 | 어디서 | 통과 기준 |
|---|---|---|---|
| 1 | `test_seq_plan.py`: 단계 해석, (n,e,yaw) 계산, 회전 조각(270° → 90×3, ccw 방향), 착륙 here/home, 최대 거리·gap 검사, 예상 시간, hash 안정성 | Pi/PC, FC 불필요 | 전부 통과 |
| 2 | `test_seq.py`: 파라미터 → argv, 빠진/남는 `s*` 키 거절, `[계획]` 줄 붙잡기·재시작 후 복원, 상호 배제 | Pi, 가짜 스크립트 | 전부 통과. **기존 `test_flight_runner.py` 도 그대로 통과**(안 고쳤다는 확인) |
| 3 | `mission_seq.py --dry-run` (예: `right:3 forward:1`, `cw:90 forward:2`, `hover:5`) | 실제 FC, 지상 | `[미션] 대조 일치 ✔`, 좌표가 지도와 맞음 |
| 4 | 실행기 경유 dry-run, `mission_run` 토픽 확인 | drone-node + mosquitto_sub | `plan`·`mission_key`(§9)·exit 0 |
| 5 | 실비행 ①: 3 m 고도, `right:2 forward:1`, 0.5 m/s | 야외, 조종기·비상 창 준비 | STEP 오차 < 1 m(일반 GPS), 착륙 위치 = P2 |
| 6 | 실비행 ②: `cw:90 forward:2 ccw:90 back:2` (기체 기준 누적 확인) | 같음 | 기수·위치가 미리보기와 일치 |
| 7 | 중단 시험: 비행 중 `seq_mission_stop`, 모드 스위치 개입 | 같음 | 기존 중단 표대로 동작 |

---

## 7. 작업 순서와 크기(대략)

1. `seq_plan.py` + 시험 — 가장 먼저. 가시화 쪽 미리보기의 기준이 되므로 여기서 식·hash·`[계획]` 형식을 확정.
2. `mission_seq.py` — `test_sar.py` 에서 `Telem/LandWatch/upload_verified/fly/monitor` 를 복사해 단계 기반으로 바꿈. dry-run 까지.
3. `flight_runner/seq.py`, `node_seq.py` + 시험.
4. `docs/MISSION_SEQ.md`, `docs/MISSION_SEQ_요청_VZ.md` (가시화에 전달).
5. drop-in 설치 → 지상 시험(§6-3,4) → 실비행(§6-5~7) → 보고서.

---

## 8. 확정된 결정 (2026-11-13 사용자 확인)

| 항목 | 결정 |
|---|---|
| 「오른쪽/앞」의 기준 | **그 시점 기수(회전 반영)** 하나만. `--frame fixed` 는 만들지 않았다 |
| 착륙 위치 | 기본 **마지막 단계 끝난 자리**. 가시화에서 `land` 로 「이륙 지점 복귀」를 고를 수 있다 |
| 캡처 | 기본 **끔**. 가시화에서 단계별 `s{k}_capture` 로 켤 수 있다 |
| 최대 반경 | **30 m** (+ FC 지오펜스가 켜져 있으면 그 안쪽) |
| RTK | 한 파일, `--rtk-min`(기본 0) |
| 고도 변경 단계 | 2차 (미구현) |

## 9. 구현하면서 계획과 달라진 점

- `mission_key`(§9) 대신 상태에 `mission_key`(정규형 문자열)와 `mission_hash`(그 sha256 앞 16자)를 둘 다 싣는다 — 가시화가 문자열을 바로 비교할 수 있게.
- 대기(hover) 단계 범위는 1~60 초(0 초 대기는 의미가 없어 뺐다). 이동 최소 1 m(GPS 오차 · 도달 반경 고려).
- 캡처 단계 사이 쉼은 「앞 단계 settle 을 늘리기」 대신 별도 쉼 waypoint(`rest`)로 넣었다 — 회전·대기 캡처에서도 간격이 보장된다.
- 실행기 CLI(`python -m flight_runner.seq …`)는 만들지 않았다. 손 시험은 `mission_seq.py` 를 직접 돌린다.
- 단계 전 RTK 게이트는 넣지 않았다(이륙 전 대기만). 캡처 중 Fixed 가 풀리면 CAP SUMMARY 에 `rtk=LOST`.
