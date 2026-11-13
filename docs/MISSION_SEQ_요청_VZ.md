# 복합 이동 미션 — 가시화 연동 규약 (pi3 → 가시화, 2026-11-13)

> 받는 쪽: 가시화 「비행 제어」 화면 담당.
> 드론(pi3) 쪽 구현은 끝났고 시험도 통과했다. 실기 설치(`install_seq.sh --install`)는 아직 하지 않았다.
> 기존 `rtk_test_*` · `flight_run` 규약(`261014_드론비행실행기_요청_VZ.md`)은 **그대로**다. 이 문서는 거기에 **더하는 것**만 다룬다.

---

## 1. 무엇이 생겼나

지금까지는 전후·좌우·회전 중 **한 가지 동작만** 골라 L↔X 를 왕복했다. 이제는 **단계 목록**을 하나의 미션으로 날릴 수 있다.

```
예) 5m 이륙 → 오른쪽 3m → 앞 1m → 착륙
    altitude_m=5, step_count=2, s1_kind=2(right), s1_value=3, s2_kind=0(forward), s2_value=1
```

| 단계 | 뜻 |
|---|---|
| 앞 · 뒤 · 오른쪽 · 왼쪽 (m) | **그 단계 시점의 기수 기준**으로 직선 이동. 이동 중 기수는 돌지 않는다(옆·뒤로 난다) |
| 시계 · 반시계 (°) | 제자리 회전. **이후 단계의 앞·오른쪽이 돌아간 기수 기준으로 바뀐다** |
| 대기 (초) | 제자리 정지 |

단계마다 고를 수 있는 것: **이 단계만 쓸 속도**(이동 단계만), **캡처 여부**.
미션 전체에서 고를 수 있는 것: **착륙 위치**(마지막 지점 / 이륙 지점 복귀) 등 §3 표.

**화면에서 선택지로 보여 줄 두 가지 (기본값 그대로 두면 아래처럼 난다)**

| 선택 | 기본값 | 다른 값 |
|---|---|---|
| 착륙 위치 `land` | 0 = **마지막 단계가 끝난 자리** | 1 = 이륙 지점(L)으로 돌아와 착륙 |
| 단계별 캡처 `s{k}_capture` | 0 = **안 함** | 1 = 그 단계 동안 레이더 캡처 |

---

## 2. action (Capability 로 선언됨)

| action | 하는 일 |
|---|---|
| `seq_mission_start` | `mission_seq.py` 를 별도 systemd 유닛으로 띄운다 |
| `seq_mission_stop` | 돌고 있는 스크립트의 주 프로세스에 SIGTERM(= Ctrl+C → 캡처 OFF → `abort` 동작) |
| (비상) `rtk_test_emergency` | **기존 것 그대로.** 어느 스크립트가 날든 같다. 새 화면에도 같은 비상 버튼을 둔다 |

- Capability 에 `seq_mission_start` 가 **있을 때만** 복합 미션 화면을 연다. 61 번 drop-in 이 설치되지 않은 기체에는 없다.
- **두 실행기는 서로 배제된다.** 한쪽(`rtk_test_start` 또는 `seq_mission_start`)이 돌고 있으면 다른 쪽 시작은
  `FAILED_PRECONDITION` / message `other_flight_running` 으로 거절된다. 같은 쪽을 또 시작하면 `already_running`.
  화면은 두 상태 토픽(`flight_run`, `mission_run`)의 `run.state` 를 모두 보고 시작 버튼을 막는 것이 좋다.

---

## 3. `seq_mission_start` 파라미터 (`map<string,double>` — 값은 모두 숫자)

| 키 | 필수 | 값 |
|---|---|---|
| `dry_run` | ✔ | 0 · 1. 0 이면 `confirmed=1` 이 있어야 받는다(없으면 `not_confirmed`) |
| `confirmed` | 실비행 | 1 |
| `altitude_m` | ✔ | 2~30 |
| `step_count` | ✔ | 1~20 정수 |
| `s{k}_kind` | ✔ (k=1..step_count) | 0 forward · 1 back · 2 right · 3 left · 4 cw · 5 ccw · 6 hover |
| `s{k}_value` | ✔ | 이동 1~50 m · 회전 1~360 ° · 대기 1~60 초 |
| `s{k}_speed_mps` | | 이 단계만의 속도 0.5~5 (이동 단계만. 회전·대기에 주면 종료 코드 2) |
| `s{k}_capture` | | 0 · 1 (기본 0) |
| `land` | | 0 here(기본) · 1 home |
| `speed_mps` | | 기본 수평 속도 0.5~5, 기본 1 |
| `max_radius_m` | | 경로가 이륙 지점에서 갈 수 있는 최대 거리, 1~100, 기본 30 |
| `abort` | | 0 rtl(기본) · 1 hold · 2 land — 중단·시간 초과 때 |
| `heading_deg` · `accept_radius_m` · `align_hold_s` · `settle_s` · `gap_s` · `rtk_min_s` · `rtk_timeout_s` | | 같은 이름 옵션. 보통 비워 둔다 |

- 모양 검사(빠진 키 · 모르는 키 · 정수여야 하는 값 · `step_count` 를 넘는 `s{k}_*`)는 **수락 전에 거절**(INVALID_ARGUMENT)된다.
- 범위 검사는 스크립트가 한다 → 수락은 되고 스크립트가 **종료 코드 2** 로 끝나며 이유가 `lines` 에 `mission_seq.py: error: …` 로 온다.
  거리 제한(`max_radius_m`, 총 이동 300 m)도 여기서 걸린다. 화면 미리보기에서 미리 막아 두면 좋다(§6 식).
- RTK 보정이 FC 로 안 들어오고 있으면 실행기가 `rtk_*` 를 버리고 `--rtk-min 0` 으로 띄운다(`run.rtk=false`).

---

## 4. 상태 토픽 `<base>/mission_run` (retain, `flight_run` 과 같은 주기·규칙)

`flight_run` 본문과 같은 모양이고, 다른 점은 아래뿐이다.

```jsonc
{
  "schema_version": "1", "source_id": "x500-001", "node_id": "…", "zone_id": "zoneA", "timestamp": "…",
  "runner": "mission_seq",                // 새 필드. emergency 필드는 없다(비상은 flight_run 쪽)
  "run": {
    "run_id": "…", "command_id": "…", "state": "running|exited", "dry_run": true, "exit_code": 0,
    "argv": ["--yes", "--step", "right:3", …], "started_at": …, "ended_at": …, "out_path": "…",
    "script": "mission_seq.py", "rtk": false,
    "lines": [{"seq": 1, "text": "…"}, …],       // 최근 200줄 원문
    "steps": ["right:3", "forward:1"],          // 새 필드: 띄운 단계(정규형)
    "plan": { … },                              // 새 필드: §5 [계획] JSON. 스크립트가 찍기 전(연결·위치 대기 중)이나 범위 오류면 null
    "mission_key": "v1|alt=5|spd=1|land=here|right:3;forward:1",   // = plan.key
    "mission_hash": "2dd3a3eb1614f461"                              // = plan.hash
  }
}
```

- `plan` 은 `lines` 와 따로 붙잡아 둔 것이라 **긴 비행에서도 사라지지 않는다.** 실행기가 재시작해도 다시 채워진다.

---

## 5. 스크립트 출력 (원문을 읽어 단계를 판정한다)

### 5-1. `[계획]` 한 줄 — 업로드 직전, dry-run · 실비행 모두

```jsonc
{
  "v": 1, "key": "v1|alt=5|spd=1|land=here|right:3;forward:1", "hash": "2dd3a3eb1614f461",
  "L": [lat, lon],          // 이륙 지점 = 원점
  "h0": 123.4,              // 이륙 직전 기수(도, 0=북, 시계방향)
  "alt": 5, "speed": 1, "land": "here",
  "est_s": 47, "timeout_s": 154,       // 예상 시간 · 이 시간을 넘기면 스크립트가 abort
  "max_r": 3.16, "path_m": 4.0, "n_items": 7,
  "roles": [["takeoff",0],["align",0],["speed",1],["move",1],["speed",2],["move",2],["land",0]],   // 미션 항목 seq 별 역할
  "steps": [
    {"k": 1, "kind": "right", "value": 3, "speed": null, "cap": false, "label": "오른쪽 3m", "text": "right:3",
     "seq": [2, 3],                    // 이 단계에 속한 미션 항목 seq 범위
     "yaw": 123.4,                     // 이 단계 끝의 기수
     "from": {"n":0,"e":0,"fwd":0,"right":0,"lat":…,"lon":…},
     "to":   {"n":-2.504,"e":-1.651,"fwd":0,"right":3,"lat":…,"lon":…}},   // h0 123.4° 의 오른쪽 = 방위 213.4°
    …
  ],
  "land_pt": {"n":…, "e":…, "fwd":…, "right":…, "lat":…, "lon":…}
}
```

- `n`·`e`: L 원점 북·동(m). `fwd`·`right`: **이륙 직전 기수를 위로** 놓은 기체 기준(m) — 미리보기와 같은 좌표.
- `lat`·`lon` 이 정답 좌표다(dry-run 결과를 지도에 그린다).
- `roles` 종류: `takeoff` `align`(이륙 후 h0 로 정렬) `speed` `move` `rot` `hover` `rest`(캡처 단계 사이 쉼, k = 앞 단계) `return`(home 착륙일 때 L 복귀) `land`.
  `speed`·`move`·`rot`·`hover` 의 두 번째 값 k ≥ 1 이 단계 번호다.

### 5-2. 진행 줄

```
[미션] 진행 #3  WAYPOINT 단계 1 오른쪽 3m  36.35…, 127.30…  고도 5m  헤딩 123.4°  대기 2s  반경 0.5m
STEP 1/2 START t=1794576334.685 오른쪽 3m 고도 5.0m 헤딩 123.4°
       #3 단계 1/2 오른쪽 3m 진행  1.8/3.0m  속도  1.0m/s  고도   5.0m  헤딩 123.4°            ← 2초마다, 캡처 중이면 끝에 CAP
STEP 1/2 END   t=1794576338.088 dur=3.4s 목표 오차 0.31m 헤딩 123.1°(목표 123.4°, 오차 0.3°) 고도 5.0m
CAP 3 START t=… / CAP 3 END t=… / CAP 3 SUMMARY start=… end=… dur=…s alt … speed … cross-track … rtk=OFF
[확인] 착륙 완료 ✔
[결과] 단계 1 오른쪽 3m: 목표 오차 0.31m · 기수 오차 0.3°
[dry-run] 여기서 끝낸다. arm 하지 않았다.
```

- **현재 단계 판정**: `[미션] 진행 #n` 의 n → `plan.roles[n]` (k ≥ 1 이면 단계 k). 또는 `STEP k/N START/END`.
- 경고는 `[경고]` 로 시작한다(목표 오차 1.5 m 초과, 기수 오차 15° 초과, 지오펜스, RTK 풀림 등).
- 중단·오류 문구(`[중단]`, `[오류]`)와 종료 코드 의미는 기존 `test_sar` 와 같다: 0 정상 · 1 중단/오류 · 2 옵션 범위 오류.

---

## 6. 미리보기 계산 (FC 없이 화면에서) — 드론 쪽 `scripts/seq_plan.py` 와 같아야 한다

```
상태 (fwd, right, yaw) = (0, 0, 0)           // 기체 기준: 위 = 이륙 직전 기수, yaw 는 이륙 기수에서 돈 각도
이동  dir = {forward 0, right 90, back 180, left 270}
      b = yaw + dir;  fwd += d·cos(b);  right += d·sin(b)
회전  yaw += (cw ? +θ : −θ)
대기  변화 없음
착륙  here: 마지막 상태의 (fwd, right) / home: (0, 0)
최대 거리 = max over {L, 각 단계 끝} hypot(fwd, right)  ≤ max_radius_m (기본 30)
총 이동   = 꼭짓점 사이 거리 합(home 이면 마지막 → L 포함) ≤ 300
```

**미션 키**(dry-run 한 미션과 지금 편집기의 미션이 같은지 맞춰 볼 때):

```
key = "v1|alt=" + f(alt) + "|spd=" + f(speed) + "|land=" + ("here"|"home") + "|" + steps.join(";")
step = kind + ":" + f(value) + (speed ? "@" + f(speed) : "") + (capture ? "+cap" : "")
f(x) = Number(x.toFixed(3)).toString()          // 3 → "3", 0.5 → "0.5", 1.23456 → "1.235"
kind = forward | back | right | left | cw | ccw | hover
```

- `speed` 를 비워 두면 `spd=1`(기본값)이 들어간다 — 화면이 기본값을 보여 줄 때도 1 로 둔다.
- 해시는 `sha256(key)` 의 16진 앞 16자. 문자열 key 를 그대로 비교해도 된다.

**시험 벡터** (드론 쪽 코드에서 뽑았다. `fwd/right` 는 단계 끝)

| 단계 · land | key | hash | 단계 끝 (fwd, right, 끝 yaw) |
|---|---|---|---|
| `right:3; forward:1` · here | `v1\|alt=5\|spd=1\|land=here\|right:3;forward:1` | `2dd3a3eb1614f461` | (0, 3, 0) → (1, 3, 0) |
| `cw:90; forward:2; ccw:45; back:1.5` · home | `v1\|alt=5\|spd=1\|land=home\|cw:90;forward:2;ccw:45;back:1.5` | `80739eedc8f1640d` | (0,0,90) → (0, 2, 90) → (0, 2, 45) → (−1.061, 0.939, 45) |
| `forward:2+cap; hover:5; right:2@0.5+cap` · here | `v1\|alt=5\|spd=1\|land=here\|forward:2+cap;hover:5;right:2@0.5+cap` | `f64a7ad0a0b01e83` | (2, 0) → (2, 0) → (2, 2) |

(셋 다 alt 5, speed 1. 두 번째 예: 시계 90° 뒤의 「앞」은 처음 기수의 오른쪽, 반시계 45° 뒤의 「뒤」는 처음 기수 기준 왼쪽 뒤 45° 방향.)

---

## 7. 화면 흐름 (제안)

```
[미션 편집] → [미리보기] → [dry-run] → [지도 확인] → [비행 시작] → [진행 표시] → [결과]
```

1. **미션 편집**: 행 = (종류, 값, [속도], [캡처 ☐]). 추가 · 삭제 · 위/아래 · 복제. 고도 · 기본 속도 · **착륙 위치(마지막 지점 / 이륙 지점 복귀)** 선택.
   단계 1~20개, §3 범위를 입력 단계에서 막는다.
2. **미리보기**: §6 식으로 기체 기준 평면도(위 = 지금 기수). 점마다 기수 화살표, 최대 거리 원(`max_radius_m`), 착륙점, 예상 시간.
   회전 단계 뒤부터는 화살표가 돌아간 방향을 가리키게 — 사용자가 「돌고 나서 앞」을 눈으로 확인하는 곳이다.
3. **dry-run**: `seq_mission_start` + `dry_run=1`. `mission_run.run.command_id` 가 내가 보낸 것이고 `exit_code 0` 이면 성공.
   `run.plan.steps[].to.lat/lon` · `land_pt` 를 지도에 그린다. 미리보기와 모양이 다르면(기수 방향이 예상과 다름 등) 사용자가 본다.
4. **비행 시작**: dry-run 이 코드 0 으로 끝났고 **그 `mission_key` 가 지금 편집기의 key 와 같을 때만** 버튼을 연다.
   `dry_run=0, confirmed=1` + 같은 파라미터. (현장 위치·기수는 key 에 없다 — 기체를 옮겼으면 dry-run 을 다시 하는 편이 맞다.)
5. **진행 표시**: 현재 단계 강조(§5-2), 지도에 실시간 위치·기수는 **기존 drone-node `state` 토픽**(gps lat/lon, attitude)을 겹친다 — 새로 내는 것 없음. 캡처 중 표시(`CAP`).
6. **결과**: `STEP k END … 목표 오차` 를 단계 표 옆에. `[확인] 착륙 완료 ✔` · 종료 코드. 경고 줄은 눈에 띄게.
7. **중지 · 비상**: 중지 = `seq_mission_stop`, 비상 = 기존 `rtk_test_emergency`(land · rtl · hold).

---

## 8. 드론 쪽 파일 (참고)

| 파일 | |
|---|---|
| `drone/scripts/mission_seq.py` | 비행 스크립트 (터미널에서 직접도 실행 가능) |
| `drone/scripts/seq_plan.py` | 단계 해석 · 좌표 · 미션 항목 · 키 (§6 의 정본) |
| `drone/flight_runner/seq.py` · `node_seq.py` | 실행기 · 노드 감싸개 |
| `drone/flight_runner/deploy/61-mission-seq.conf` · `install_seq.sh` | 배포 |
| `docs/MISSION_SEQ.md` | 사용 설명 |
