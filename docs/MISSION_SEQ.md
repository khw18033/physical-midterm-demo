# 복합 이동 미션 — `mission_seq.py`

전후·좌우·회전·대기를 **섞은 단계 목록**을 하나의 미션으로 FC 에 올려 날린다.
`test_sar(_rtk).py` 와 같은 **미션 방식**(올리고 → 내려받아 대조 → arm, Pi 가 죽어도 FC 가 끝까지 감)이다.
안전 수칙(조종기 개입, 비상 착륙 `emergency_land.py`, tmux 실행)은 [`SAR_FLIGHT_SCRIPTS.md`](../SAR_FLIGHT_SCRIPTS.md) 4~6장과 같다.

> ⚠ **기체가 실제로 이륙한다.** 사람이 조종기를 들고 직접 실행한다. 자동 실행에 넣지 않는다.
> ⚠ **실비행 미검증**(2026-11-13): FC 없는 시험(계산 · 모의 감시 · 실행기)만 통과했다. 처음에는 dry-run → 3 m · 저속 · 짧은 단계로.

---

## 1. 쓰는 법

```bash
cd ~/drone
# 5m 이륙 → 오른쪽 3m → 앞 1m → 그 자리 착륙
./venv/bin/python scripts/mission_seq.py --altitude 5 --step right:3 --step forward:1 --dry-run   # 먼저
./venv/bin/python scripts/mission_seq.py --altitude 5 --step right:3 --step forward:1

# 대화형 — 단계 없이 터미널에서 실행하면 고도 · 속도 · 단계(한 줄에 하나) · 착륙 위치를 묻는다
./venv/bin/python scripts/mission_seq.py

# 파일로
./venv/bin/python scripts/mission_seq.py --mission ~/missions/square.json
```

`square.json` 예:

```json
{"altitude": 5, "speed": 1, "land": "here",
 "steps": ["forward:3", "right:3", "back:3", {"kind": "left", "value": 3, "capture": true}]}
```

## 2. 단계

| 쓰기 | 한국어 | 뜻 | 범위 |
|---|---|---|---|
| `forward:M` `back:M` `right:M` `left:M` | `앞 3` `뒤 3` `오른쪽 3`(`우 3`) `왼쪽 3`(`좌 3`) | 직선 이동. 기수는 돌지 않는다 | 1~50 m |
| `cw:DEG` `ccw:DEG` | `시계 90` `반시계 45` | 제자리 회전(≤90° 조각으로 나눠 방향 보장) | 1~360° |
| `hover:SEC` | `대기 5` | 제자리 정지 | 1~60 초 |
| 꼬리 `@SPEED` | `앞 3 @0.5` | 이 이동 단계만의 속도 | 0.5~5 m/s |
| 꼬리 `+cap` | `오른쪽 2 +캡처` | 이 단계 동안 레이더 캡처 | |

- **앞·오른쪽은 그 단계 시점의 기수 기준이다.** `cw:90` 다음의 `forward:2` 는 처음 기수에서 오른쪽으로 2 m.
- 단계 1~20개. 각 이동은 도달 반경(`--accept-radius`, 0.5 m)보다 길어야 한다.

## 3. 옵션

| 옵션 | 기본 | |
|---|---|---|
| `--step` · `--mission` | — | 단계 (둘 중 하나) |
| `--altitude M` | 5 | 2~30 |
| `--speed M/S` | 1 | 기본 수평 속도 |
| `--land here\|home` | here | 마지막 단계 끝난 자리 / 이륙 지점 복귀 후 착륙 |
| `--max-radius M` | 30 | 경로가 이륙 지점에서 갈 수 있는 최대 거리(≤100). FC 지오펜스 `GF_MAX_HOR_DIST` 가 켜져 있으면 그보다도 안쪽이어야 한다 |
| `--rtk-min SEC` · `--rtk-timeout SEC` | 0 · 120 | 0 이 아니면 이륙 전 RTK Fixed 연속 유지 대기 |
| `--gap SEC` | 10 | 캡처 단계 사이 최소 쉼(≥10) |
| `--abort rtl\|hold\|land` | rtl | Ctrl+C · 시간 초과 때 |
| `--heading` · `--accept-radius` · `--align-hold` · `--settle` · `--dry-run` · `--yes` · `--log-dir` · `--address` · `--connect-timeout` · `--position-timeout` | | `test_sar` 와 같다 |

총 이동 거리 상한 300 m. 범위를 어기면 아무것도 하지 않고 종료 코드 2.

## 4. FC 에 올라가는 미션

```
TAKEOFF(L) → WAYPOINT yaw 정렬(L, h0, 3초)
→ 이동: SPEED → WAYPOINT(끝점, 그 시점 기수, 2초 정지)
  회전: WAYPOINT(같은 자리, 기수 + ≤90° 조각) × 조각 수
  대기: WAYPOINT(같은 자리, 정지 시간 = 값)
  (+cap 단계 뒤에 캡처 단계가 또 있으면) WAYPOINT 쉼(gap 초)
→ here: LAND(마지막 지점)  /  home: SPEED → WAYPOINT(L) → LAND(L)
```

비행 중 문제가 생겼을 때의 동작(모드 이탈 · Pi 오류 · Ctrl+C · 시간 초과)은 `SAR_FLIGHT_SCRIPTS.md` 2-3 표와 같다.

## 5. 로그

`/home/physical/cansar_logs/mission_seq_<날짜시각>.log`

```
[경로] … 평면도 (위 = 이륙 직전 기수)
[계획] {json}                       경로 · 항목 역할 · 좌표 (가시화가 읽는다)
[미션] 진행 #n …
STEP k/N START … / STEP k/N END … 목표 오차 0.31m 헤딩 …(목표 …, 오차 …)
CAP k START / END / SUMMARY …        (+cap 단계만)
[확인] 착륙 완료 ✔
[결과] 단계 k …: 목표 오차 …m · 기수 오차 …°
```

## 6. 가시화에서

드론 노드에 `seq_mission_start` · `seq_mission_stop` 이 붙어 있으면 가시화 화면에서 띄울 수 있다. 규약: [`MISSION_SEQ_요청_VZ.md`](MISSION_SEQ_요청_VZ.md).

```bash
~/drone/flight_runner/deploy/install_seq.sh              # 확인만
sudo ~/drone/flight_runner/deploy/install_seq.sh --install    # 61-mission-seq.conf 설치 → drone-node 재시작
sudo ~/drone/flight_runner/deploy/install_seq.sh --uninstall  # 원래대로(60 번만)
```

- 기존 `rtk_test_*` 는 그대로 산다. 둘은 서로 배제된다(한쪽이 날면 다른 쪽 시작 거절).
- 비상 착륙은 기존 `rtk_test_emergency`.
- 출력: `cansar_logs/runner_seq/<run_id>.out`, 상태 토픽 `<base>/mission_run`.

## 7. 시험

```bash
cd ~/drone
./venv/bin/python -m pytest scripts/test_seq_plan.py -q    # 계산 · 모의 감시 (scripts/ 폴더 통째로 넘기지 말 것)
./venv/bin/python -m pytest flight_runner -q               # 실행기 (기존 시험 포함)
```

## 8. 코드

| 파일 | |
|---|---|
| `scripts/seq_plan.py` | 순수 함수: 단계 해석 · 좌표 · 미션 항목 · 예상 시간 · 키 · 평면도. MAVSDK 없이 import |
| `scripts/mission_seq.py` | 비행 스크립트. `Telem` · `LandWatch` · 업로드 대조 · RTK 대기는 `test_sar_rtk.py` 에서 그대로 복사(저장소 규칙: 스크립트끼리 import 안 함) |
| `flight_runner/seq.py` | `SeqRunner(FlightRunner)` — 파라미터 → `--step`, `[계획]` 줄 붙잡기 |
| `flight_runner/node_seq.py` | `with_mission_seq(with_flight_runner(DroneNode))`, 두 실행기 배제 |

`test_sar_rtk.py` 의 복사해 온 부분(감시 · 착륙 판정)을 고치면 이 파일에도 같은 수정을 할지 본다.
