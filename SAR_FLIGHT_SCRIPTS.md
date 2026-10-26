# SAR 비행 스크립트 4종 — 통합 설명

`sar_test.py` · `sar_test_rtk.py` · `test_sar.py` · `test_sar_rtk.py` 는 PX4 기체(x500)를 정해진 직선(또는 제자리 회전)으로 여러 번 날리면서 레이더 캡처를 켜고 끄는 스크립트입니다.
네 개 모두 **미션 방식**으로 동작합니다. 비행 경로 전체를 이륙 전에 FC 에 올려 두고, 비행 중에는 Pi 가 명령을 보내지 않습니다.

> ⚠ **기체가 실제로 이륙합니다.** 사람이 조종기를 들고 직접 실행합니다. systemd·cron 같은 자동 실행에 넣지 않습니다.
> ⚠ **스크립트로 나는 동안에는 조종기로 개입하기가 생각보다 어렵습니다.** 비행 전에 [5장](#5-조종기-개입이-어렵다)과 [6장 비상 착륙](#6-비상-착륙--emergency_landpy)을 꼭 읽으세요.

---

## 1. 한눈에 보기

| | `sar_test.py` | `sar_test_rtk.py` | `test_sar.py` | `test_sar_rtk.py` |
|---|---|---|---|---|
| 용도 | 본 측정 | 본 측정 (RTK) | 단거리 시험 | 단거리 시험 (RTK) |
| 기본 고도 | 20 m | 20 m | 5 m | 5 m |
| 기본 경로(L→X) | 100 m (가속 20 + **캡처 60** + 감속 20) | 100 m (같음) | 5 m (**전 구간 캡처**) | 5 m (**전 구간 캡처**) |
| 기본 속도 | 5 m/s (3~5 만 허용) | 5 m/s (3~5) | 1 m/s (0.5~5) | 1 m/s (0.5~5) |
| 패스 수 | `--passes` 기본 2, 2 이상 | 같음 | 실행 때 입력 (1~10, 기본 2) | 실행 때 입력 (1~10, 기본 2) |
| 이동 방향 | 기수 방향(전진)만 | 기수 방향만 | 전후(앞·뒤 먼저) / 좌우(오른쪽·왼쪽 먼저) / 회전 | 전후(앞·뒤 먼저) / 좌우(오른쪽·왼쪽 먼저) / 회전 |
| 실행 때 묻는 것 | 없음 (`yes` 확인만) | 없음 | 방향·먼저 갈 쪽·고도·이동거리·속도·왕복 횟수 | 방향·먼저 갈 쪽·고도·이동거리·속도·왕복 횟수 |
| RTK Fixed 확인 | 없음 | 이륙 전·매 패스 전 | 없음 | 이륙 전·매 패스 전 |
| 로그 파일 | `sar_test_*.log` | `sar_test_rtk_*.log` | `test_sar_*.log` | `test_sar_rtk_*.log` |

권장 순서: `test_sar` 또는 `test_sar_rtk` 로 5 m·저속 시험 → 경로·헤딩·캡처 로그를 확인 → `sar_test` 또는 `sar_test_rtk` 로 본 측정.

---

## 2. 공통 — 미션 방식

### 2-1. 왜 바꿨나

예전에는 Pi 가 지점마다 `goto` 명령을 보냈습니다. 2026-10-08 13:18 에 비행 중 명령 통로(mavsdk_server)가 죽자, FC 는 마지막 명령을 끝낸 뒤 **18 m 상공에서 HOLD 로 떠 있었습니다.** 귀환(rtl) 명령도 같은 통로로 나가야 해서 보내지 못했습니다. 그때 기체는 별도 연결로 LAND 를 보내 내렸고, 이 방법이 [6장](#6-비상-착륙--emergency_landpy) `emergency_land.py` 가 되었습니다.

이 사고에서 드러난 구멍 세 가지와, 지금 막는 방법:

| 구멍 | 막는 곳 |
|---|---|
| 이전 실행이 남긴 mavsdk_server 가 포트를 쥔 채 살아 있으면, 새 스크립트가 **그 남의 서버에 붙는다**(언제 죽을지 모름) | `mavsdk_guard.connect()` — 연결 전 UDP 14540·TCP 50051 이 비었는지 검사, 연결 뒤 내 서버가 살아 있는지 확인 |
| 스크립트가 `[종료]` 를 찍고도 프로세스가 안 끝나 서버가 기체 연결·포트를 계속 쥠 | `mavsdk_guard.stop()` — 어떤 경로로 끝나든 내 mavsdk_server 를 직접 죽임 |
| 명령 통로가 죽으면 rtl 도 같은 통로라 못 보냄 | ① 비행 전체를 미션으로 FC 에 미리 넣음 ② `mavsdk_guard.abort()` — 실패하면 새 서버를 다른 포트로 띄워 한 번 더 보냄 |

지금은 **이륙부터 착륙까지 모든 명령을 비행 전에 FC 에 넣어 둡니다.** 비행 중에 Pi·SSH·mavsdk_server 가 죽어도 **FC 가 혼자 끝까지 날고 L 에 착륙합니다.**

### 2-2. 흐름

```
연결 → 이미 arm 이면 중단 → GPS·home 정상 확인 → (RTK 판: Fixed 30초 연속 대기)
→ 지금 서 있는 자리를 L, 지금 기수 방향을 고정 헤딩으로 경로 계산
→ 미션 업로드 → FC 에서 다시 내려받아 한 항목씩 대조 (다르면 arm 하지 않음)
→ 경로를 잡은 뒤 기체가 5° 넘게 돌았거나 1 m 넘게 움직였으면 중단
→ arm → 미션 시작  ─── 여기서부터 FC 가 스스로 비행 ───
→ Pi 는 감시만: 캡처 켜고 끄기, (RTK 판) 패스 전 RTK 확인, 착륙 확인
→ 착륙 확인 뒤 FC 의 미션 삭제
```

FC 에 올라가는 미션 (직선 패턴, 2 패스 예):

```
#0  TAKEOFF   이륙 (목표 고도)
#1  WAYPOINT  yaw 정렬 — L 상공에서 고정 헤딩으로 돌리고 --align-hold(3초) 머묾
#2  SPEED     속도 지정
#3  WAYPOINT  L 대기
#4  SPEED  →  #5  WAYPOINT  패스 1: L → X
#6  SPEED  →  #7  WAYPOINT  L 복귀, 다음 패스까지 max(settle, gap) 초 대기
#8  SPEED  →  #9  WAYPOINT  패스 2: L → X
#10 SPEED  →  #11 WAYPOINT  L 복귀
#12 LAND      L 에 착륙
```

- 모든 waypoint 에 **같은 헤딩**을 넣어 기수를 고정합니다. 그래서 X→L 복귀는 **후진**, 좌우 패턴은 **옆으로** 납니다.
- PX4 는 미션을 멈췄다가 다시 시작하면 속도를 기본값으로 되돌리므로, waypoint 앞마다 `SPEED` 를 둡니다.
- 회전 패턴은 L 상공에서 헤딩만 90° 씩 바꾼 waypoint 4개를 이어 붙여 시계방향으로 360° 돕니다.
- 고도는 home(=arm 한 자리) 기준 상대 고도입니다.

### 2-3. 비행 중 문제가 생기면 스크립트는

| 상황 | 스크립트 동작 | 기체 |
|---|---|---|
| Pi 쪽 오류(통신 끊김 등) | 캡처 OFF, **명령 안 보냄** | 미션대로 계속 날고 L 에 착륙 |
| Pi·SSH·mavsdk_server 가 죽음 | (스크립트도 멈춤) | 미션대로 계속 날고 L 에 착륙 |
| 조종기 개입·FC 페일세이프로 모드가 MISSION 밖으로 바뀜 | 캡처 OFF, **더는 명령 안 함** | 조종기/FC 를 따름 |
| Ctrl+C · SIGTERM | 캡처 OFF → `--abort` (기본 rtl) | RTL: 30 m 까지 올라간 뒤 귀환·착륙 |
| 미션이 예상 시간의 2배 + 60초를 넘김 | 캡처 OFF → `--abort` | 같음 |
| (RTK 판) 패스 전 RTK 대기가 `--rtk-timeout` 초과 | 캡처 OFF → `--abort` | 같음 |

`--abort` 는 명령 통로가 죽어 있으면 mavsdk_server 를 새로 띄워 한 번 더 보냅니다(`mavsdk_guard.py`).
Pi 쪽 오류에 rtl 을 보내지 않는 이유: 미션이 FC 에 있으니 그대로 두는 편이 안전하고, rtl 은 30 m(`RTL_RETURN_ALT`)까지 올라가기 때문입니다.

### 2-4. 레이더 캡처

`cansar.service` 가 `/home/physical/CAP_ON` 파일이 있는 동안 캡처합니다. 스크립트는 이 파일을 만들고 지우기만 합니다.

| | 켜는 때 | 끄는 때 |
|---|---|---|
| `sar_test` · `sar_test_rtk` | 패스(L→X) 중 **S 통과** | **E 통과** |
| `test_sar` · `test_sar_rtk`(전후·좌우) | 패스(L→X) **시작** | **X 도달**(도달 반경 안) — 가속·감속 구간 포함 |
| `test_sar` · `test_sar_rtk`(회전) | 회전 시작 | 회전 끝 |

- X→L 복귀 중에는 캡처하지 않습니다.
- 예외·Ctrl+C·모드 이탈·종료 등 어떤 경우에도 파일을 지웁니다. 시작할 때 이전 실행의 파일이 남아 있으면 지우고 경고합니다.
- 캡처 OFF 부터 다음 캡처 ON 까지 최소 `--gap`(10초)을 둡니다(L 에서 그만큼 머묾). 그동안 cansar 가 SDR 데이터를 옮깁니다.
- `physical` 사용자로 실행합니다. root 로 실행하면 root 소유 `CAP_ON` 이 생깁니다.

---

## 3. 스크립트별 차이

### 3-1. `sar_test.py` — 본 측정

```
 L ──── 가속 20 m ──── S ════════ 등속 60 m (캡처) ════════ E ──── 감속 20 m ──── X
(이륙)
```

- 실행 때 묻는 것 없이 옵션 값으로 납니다. `yes` 확인만 받습니다.
- 제한: 속도 3~5 m/s, 캡처 구간 60 m 이상, 패스 2회 이상, `--gap` 10초 이상.
- 캡처 시작 때 속도가 목표와 `--speed-tol`(0.5 m/s) 넘게 다르면 `S 진입 속도` 경고를 남깁니다. 반복되면 `--lead-in` 을 늘리세요(예: 30).

### 3-2. `sar_test_rtk.py` — 본 측정 + RTK

`sar_test.py` 와 같고 RTK 확인이 더해졌습니다.

- **이륙 전**: RTK Fixed 가 `--rtk-min`(30초) 연속 유지될 때까지 기다립니다. `--rtk-timeout`(120초) 안에 안 되면 arm 하지 않고 끝냅니다.
- **경로 기준점(L)은 RTK 가 안정된 뒤에** 잡습니다(Fixed 직후 위치가 수십 cm~1 m 움직이므로).
- **매 패스 전**: L 에서 대기할 때 Fixed 가 모자라면 **미션을 일시정지(HOLD)** 하고 기다렸다가 다시 시작합니다. 시간을 넘기면 `--abort`.
- 캡처 중 Fixed 가 풀리면 경고와 함께 SUMMARY 에 `rtk=LOST` 를 붙입니다. 그 패스는 다시 날아야 합니다.
- 보정 경로: 지상 노트북 `cansar_rtcm_send.py` → Pi `cansar.service`(UDP 14660) → FC. 비행 내내 켜 둡니다.
- RTK 없이 날려면 `--rtk-min 0`.

### 3-3. `test_sar.py` — 단거리 시험

- **`test_sar_rtk.py` 에서 RTK 확인만 뺀 판입니다(2026-10-22).** 옵션 · 실행 때 묻는 것 · 경로 · 미션 · 캡처 · 중단 처리가
  `test_sar_rtk.py` 와 같고, `--rtk-min` · `--rtk-timeout` 만 없습니다. SUMMARY 줄은 `rtk=OFF` 로 끝납니다.
- 비행 실행기(가시화의 「비행 시작」)는 그때 RTK 보정이 FC 로 들어오고 있지 않으면 `test_sar_rtk.py` 대신 이것을 띄웁니다.
- `test_sar_rtk.py` 를 고치면 이 파일도 같이 고칩니다. 예전 판(가속 20%·캡처 60%·감속 20%)은 git `a5494f0` 에 있습니다.
- 일반 GPS 는 위치 오차가 1 m 안팎이라 5 m 경로에서는 흔들림이 크게 보일 수 있습니다.

### 3-4. `test_sar_rtk.py` — 단거리 시험 + RTK

```
 L ════════════════ 캡처 ════════════════ X
(이륙)        ←── --length(이동거리) ──→
```

- 실행하면 **이동 방향 → 먼저 갈 쪽(앞/뒤 · 오른쪽/왼쪽) → 고도 → 이동거리 → 속도 → 왕복 횟수(1~10)** 를 묻습니다. Enter 는 기본값입니다.
- 범위: 고도 2~30 m, 이동거리 2~150 m(입력 때), 속도 0.5~5 m/s, 왕복 1~10 회, `--gap` 10초 이상, `--accept-radius` 는 이동거리보다 작아야 함.
- 이동선 방향 = 고정 헤딩 + 먼저 갈 쪽(앞 0° · 오른쪽 90° · 뒤 180° · 왼쪽 270°). 기수는 언제나 고정 헤딩입니다.
- **가속·감속 구간이 없습니다.** L 출발부터 X 도달까지 전부 캡처합니다(처음·끝은 등속이 아님 — 수평 가속도 3 m/s² 기준 4 m/s 면 약 1.3초·2.7 m 씩).
- RTK 확인은 `sar_test_rtk.py` 와 같습니다.
- `--heading` 을 지금 기수 방향과 다르게 주면 arm 직전 확인(기체가 5° 넘게 돌았나)에 걸려 멈춥니다. **기체를 원하는 방향으로 놓고 실행하세요.**

### 3-5. 공통 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--dry-run` | — | 연결·위치 확인 → 경로 계산 → **미션 업로드·대조 → 삭제**까지만. arm·캡처 안 함 |
| `--heading DEG` | 실행 시 기수 방향 | 고정 헤딩(0=북, 시계방향) |
| `--altitude M` | 20 / 5 | 비행 고도(home 기준) |
| `--speed M/S` | 5 / 1 | 수평 속도 |
| `--passes N` | 2 | 패스(왕복·회전) 횟수 |
| `--gap SEC` | 10 | 패스 사이 L 에서 머무는 최소 시간, 10 이상 |
| `--accept-radius M` | 1 / 0.5 | waypoint 도달 반경 |
| `--align-hold SEC` | 3 | 이륙 후 헤딩 정렬하고 머무는 시간 |
| `--settle SEC` | 2 | 각 지점 도달 후 정지 시간 |
| `--abort` | rtl | Ctrl+C·시간 초과(·RTK 대기 초과) 때 보낼 명령: `rtl` / `hold` / `land` |
| `--log-dir DIR` | /home/physical/cansar_logs | 로그 폴더 |
| `--yes` | — | 확인 입력 생략(안전을 이미 확인한 경우에만). 시험판은 입력 질문도 건너뜀. 터미널이 아닌 곳(비행 실행기 등)에서는 이것이 없으면 거부 |
| `--address` | `udpin://0.0.0.0:14540` | MAVSDK 연결 주소(mavlink-router 가 내보내는 UDP) |
| `--connect-timeout SEC` | 30 | FC 연결 대기 |
| `--position-timeout SEC` | 60 | GPS·home 정상 대기 |

스크립트별로 더 있는 옵션:

| 옵션 | 스크립트 | 기본값 | 설명 |
|---|---|---|---|
| `--length M` | 전부 | 60 / 5 | `sar_test` 계열: 캡처(등속) 구간 S→E, 60 이상. 시험판: 이동거리 L→X 전체 |
| `--lead-in M` · `--lead-out M` | `sar_test` 계열 | 20 · 20 | 가속 구간 L→S · 감속 구간 E→X |
| `--speed-tol M/S` | `sar_test` 계열 | 0.5 | 캡처 구간 속도 허용 오차(넘으면 경고) |
| `--pattern` | 시험판 | `fb` | `fb` 전후 · `lr` 좌우 · `rotate` 제자리 회전 |
| `--side` | 시험판 | (묻는다) | 먼저 갈 쪽. `fb` 면 `forward`/`back`, `lr` 이면 `right`/`left` |
| `--rtk-min SEC` | RTK 판 | 30 | 이륙 전·매 패스 전 RTK Fixed 연속 유지 시간. 0 = 확인 안 함 |
| `--rtk-timeout SEC` | RTK 판 | 120 | RTK 대기 최대 시간. 이륙 전이면 중단, 비행 중이면 `--abort` |

`--help` 로도 확인할 수 있습니다.
미션 방식으로 바뀌면서 `--land-timeout` 은 없어졌습니다(착륙 확인은 미션 시간 초과 판정에 포함).

---

## 4. 실행 절차

### 4-1. 준비

1. **장소**: 이륙 지점에서 이동 방향으로 경로 길이 이상, 비행 고도 이상이 비어 있는 야외. 사람·장애물과 충분한 거리. RTL 은 30 m 까지 올라가므로 그 위도 비어 있어야 합니다.
2. **FC 파라미터(QGC)**: 지오펜스 `GF_MAX_HOR_DIST`·`GF_MAX_VER_DIST` 가 경로·고도보다 넉넉한지.
3. **서비스 상태**
   ```bash
   systemctl status drone.target      # FC 링크
   systemctl status cansar.service    # 레이더 캡처
   ls /home/physical/CAP_ON           # "No such file" 이어야 정상
   pgrep -a mavsdk_server             # 비어 있어야 정상
   ```
4. **RTK 판이면**: 지상 노트북 `cansar_rtcm_send.py` 를 켜고 QGC 에서 RTK Fixed 를 확인합니다.
5. **배터리**: 이 기체는 배터리가 부족해도 **경고만 하고 스스로 내려오지 않습니다**(`COM_LOW_BAT_ACT=0`). 넉넉히 충전하고 비행 중 잔량을 계속 봅니다.
6. **터미널 두 개**: 비행 스크립트용 하나, **[비상 착륙](#6-비상-착륙--emergency_landpy) 명령을 미리 입력해 둔 창** 하나.

### 4-2. tmux 안에서 실행

SSH 가 끊겨도 스크립트(캡처·감시)가 계속 돌고, 다시 붙을 수 있습니다.

```bash
tmux new -s fly            # 끊긴 뒤 다시 붙기: tmux attach -t fly
cd ~/drone
```

### 4-3. dry-run (먼저 반드시)

```bash
./venv/bin/python scripts/test_sar_rtk.py --dry-run
```

경로 좌표·헤딩·미션 항목 목록을 출력하고, 미션을 실제로 올려 **FC 에서 내려받은 것과 대조**한 뒤 지웁니다. arm 하지 않습니다.
`[미션] 대조 일치 ✔` 와 좌표·헤딩이 현장(지도)과 맞는지 확인합니다.

### 4-4. 비행

```bash
./venv/bin/python scripts/test_sar_rtk.py
```

설정을 묻고(시험판), 안전 확인 문구가 나오면 **직접 `yes`** 를 입력해야 진행합니다.
비행 중 2초마다 `#항목 진행거리 속도 고도 헤딩` 이 찍히고, 캡처 중이면 `CAP` 이 붙습니다.

### 4-5. 비행 후

1. `[확인] 착륙 완료 ✔` 와 `[미션] FC 의 미션을 지웠다` 를 확인합니다.
2. `ls /home/physical/CAP_ON` 이 없어야 정상입니다.
3. QGC 에서 `.ulg` 로그를 받습니다(Analyze Tools → Log Download).
4. 정리할 파일: 스크립트 로그 `cansar_logs/<스크립트>_<날짜시각>.log`, cansar 로그 `cansar_logs/<날짜시각>/`, 레이더 데이터 `flight/iq_N.bin`·`meta_N.txt`.

---

## 5. 조종기 개입이 어렵다

스크립트로 나는 동안 조종사는 **직접 조종하고 있지 않습니다.** 그래서 "이상하면 조종기로 잡는다"는 말처럼 쉽지 않습니다.

**어려운 이유**

- **손이 스틱 위에 있지 않습니다.** 기체가 이상하다고 알아챈 뒤 조종 자세를 잡기까지 시간이 걸립니다. 5 m/s 면 1초에 5 m 갑니다.
- **기체 방향이 헷갈립니다.** 기수를 고정한 채 X→L 복귀는 후진, 좌우 패턴은 옆으로 납니다. 100 m 떨어져 20 m 높이에 있으면 기수가 어디를 보는지 눈으로 알기 어렵고, 스틱 방향이 눈에 보이는 진행 방향과 다릅니다.
- **스로틀 스틱 위치.** 개입하면 Position 모드로 넘어가는데, 이 모드에서 스로틀 스틱은 상승·하강 명령입니다. 스틱이 바닥에 있으면 **넘어가는 순간 하강합니다.** 먼저 스로틀을 가운데에 둡니다.
- **모드 스위치는 "바뀔 때"만 먹힙니다.** 스위치가 이미 Position 자리에 있었다면 한 번 다른 자리로 갔다가 돌아와야 모드가 바뀝니다.
- **FC 가 대신 지켜 주지 않는 것들**(2026-09-24 에 FC 에서 읽은 페일세이프 파라미터. 지금 값은 QGC 에서 다시 확인)
  - Pi 연결이 끊겨도 아무 동작 안 함(`NAV_DLL_ACT=0`) — 미션 방식이라 착륙까지는 가지만, 중간에 바꾸려면 사람이 해야 합니다.
  - 배터리가 부족해도 경고만 함(`COM_LOW_BAT_ACT=0`).
  - 조종기 신호가 끊기면 RTL(`NAV_RCL_ACT=2`) — `RTL_RETURN_ALT=30` m 까지 올라간 뒤 돌아옵니다.

**개입하는 방법** (쉬운 순서)

1. **스틱 개입**: 이 기체는 자동 모드에서 스틱을 움직이면 Position 모드로 넘어갑니다(`COM_RC_OVERRIDE=1`, 민감도 `COM_RC_STICK_OV=30%`). **먼저 스로틀을 가운데로** 놓고 움직입니다.
2. **모드 스위치**: Position(또는 Hold) 자리로 바꿉니다.
3. 조종기로 하기 어려우면 → **6장 비상 착륙 스크립트**.

스크립트는 모드가 MISSION 밖으로 바뀐 것을 보면 캡처만 끄고 손을 뗍니다. 조종기와 다투지 않습니다.
조종기로 잡은 뒤 착륙까지 마쳤다면 FC 에 미션이 남아 있을 수 있습니다. 다음에 Mission 모드로 들어가면 다시 날 수 있으니 QGC 에서 지우거나 `emergency_land.py` 를 한 번 실행합니다(지상이면 명령 없이 끝나므로, 미션을 지우려면 `--force --hold`).

---

## 6. 비상 착륙 — `emergency_land.py`

2026-10-08 사고 때 18 m 에 떠 있던 기체를 내린 방법(별도 연결로 LAND 전송)을 스크립트로 만든 것입니다.

**언제 쓰나**

- 비행 스크립트가 멈췄거나 SSH 가 끊겨 Ctrl+C 를 누를 수 없을 때
- 스크립트의 rtl 도 실패했을 때(`[오류] 새 연결로도 rtl 실패`)
- 미션을 지금 바로 끝내고 내려야 하는데 조종기로 하기 어려울 때

**사용법** — 다른 SSH 창(또는 tmux 의 다른 창)에서:

```bash
cd ~/drone
./venv/bin/python scripts/emergency_land.py           # 그 자리에 착륙 (기본)
./venv/bin/python scripts/emergency_land.py --rtl     # 이륙 지점으로 귀환 후 착륙 (30 m 까지 상승)
./venv/bin/python scripts/emergency_land.py --hold    # 그 자리에 정지(호버)만
```

**확인 질문 없이 바로 보냅니다.** 비행 전에 이 명령을 두 번째 창에 **미리 입력해 두고** Enter 만 누르면 되게 해 두세요.

**하는 일**

```
mavlink-router TCP 5760 으로 연결 (비행 스크립트가 UDP 14540 을 쥐고 있어도 붙는다)
→ 상태 출력: armed · 공중 · 모드 · 고도
→ 이미 지상·disarm 이면 아무것도 안 보내고 끝 (--force 로 강제)
→ LAND / RTL / HOLD 전송 (실패하면 3번까지)
→ CAP_ON 삭제(캡처 OFF), FC 의 미션 삭제(--keep-mission 이면 생략)
→ 착륙·disarm 까지 1초마다 상태 출력 (최대 --watch 120초)
```

- 비행 스크립트와 섞이지 않게 MAVLink 컴포넌트 ID 191, 빈 gRPC 포트를 씁니다.
- 비행 스크립트는 모드가 LAND/RTL 로 바뀐 것을 보고 스스로 캡처를 끄고 명령을 멈춥니다. 따로 끌 필요가 없습니다.
- `--hold` 는 RTK 판이 패스 전 RTK 를 기다리느라 미션을 일시정지한 동안에는 비행 스크립트가 알아채지 못해 미션을 다시 시작할 수 있습니다. 내리려면 기본(land)이나 `--rtl` 을 쓰세요.
- 로그: `cansar_logs/emergency_land_<날짜시각>.log`

**이 스크립트로도 안 되는 경우** — `[오류] … FC 와 연결되지 않았다`:
mavlink-router 나 Pi↔FC 연결 자체가 죽은 것입니다. **조종기로 내립니다.** 지상국(Mission Planner/QGC)이 텔레메트리로 붙어 있다면 거기서 Land/RTL 을 눌러도 됩니다.

---

## 7. 로그

`/home/physical/cansar_logs/<스크립트>_<날짜시각>.log`. 모든 줄 앞에 `[time.time()]` 이 붙어 cansar `pi.log` 와 시각으로 맞춰 볼 수 있습니다.

```
[미션] 대조 일치 ✔ (13개 항목 모두 같다)
[미션] 진행 #5  WAYPOINT 패스 1 L→X ...
PASS 1 START t=1790857072.516 속도 4.98m/s 고도 20.1m
PASS 1 END   t=1790857084.533 속도 5.01m/s 고도 19.9m
PASS 1 SUMMARY start=... end=... dur=12.02s speed min/mean/max=4.81/4.99/5.12m/s alt min/max=19.8/20.2m cross-track max=0.6m rtk=OK
[확인] 착륙 완료 ✔
[미션] FC 의 미션을 지웠다
```

- **START / END**: 캡처 ON / OFF 시각.
- **SUMMARY**: 캡처 구간의 속도·고도 범위, 직선에서 옆으로 벗어난 최대 거리(`cross-track`).
  시험판(`test_sar`·`test_sar_rtk`)은 기수 오차(`yaw-err`)도 남깁니다. 끝의 RTK 표시는 RTK 판이 `rtk=OK/LOST`, `test_sar` 는 `rtk=OFF`, `sar_test` 는 없음.
- **경고 확인**: `속도가 …를 벗어났다`, `S 진입 속도`, `RTK Fixed 풀림`, `정렬 단계가 끝났는데 기수 오차가` 가 있으면 그 패스를 다시 봅니다.

---

## 8. 코드 구조

### 8-1. 파일

모두 `~/drone/` 아래에 있고, `~/drone/venv/bin/python`(MAVSDK-Python 설치됨)으로 실행합니다.

| 파일 | 하는 일 |
|---|---|
| `scripts/sar_test.py` | 본 측정 (가속·캡처·감속 직선) |
| `scripts/sar_test_rtk.py` | `sar_test.py` + RTK 확인 |
| `scripts/test_sar_rtk.py` | 단거리 시험 (전후·좌우·회전, 전 구간 캡처) + RTK 확인 |
| `scripts/test_sar.py` | `test_sar_rtk.py` 에서 RTK 확인만 뺀 판 |
| `scripts/mavsdk_guard.py` | 위 4개가 같이 쓰는 연결·종료·중단 안전장치 |
| `scripts/emergency_land.py` | 비상 착륙 (6장) |
| `flight_runner/` | 가시화 화면에서 `test_sar_rtk.py`/`test_sar.py`·`emergency_land.py` 를 띄우는 실행기 (9장) |

비행 스크립트 4개는 **한 파일 안에 모든 것이 들어 있는 독립 스크립트**입니다(서로 import 하지 않고 `mavsdk_guard` 만 씀). 그래서 같은 함수가 파일마다 따로 있습니다. 한 파일을 고치면 짝 파일도 같이 고칩니다(`sar_test` ↔ `sar_test_rtk`, `test_sar_rtk` ↔ `test_sar`).

### 8-2. 연결

```
FC ──시리얼── mavlink-router (drone.target) ─┬─ UDP 14540 ──▶ 비행 스크립트 (MAVSDK, 컴포넌트 ID 190, gRPC 50051)
                                             └─ TCP 5760  ──▶ emergency_land.py (컴포넌트 ID 191, 빈 gRPC 포트)
```

MAVSDK-Python 은 `System()` 을 만들 때 mavsdk_server 프로세스를 띄우고, 파이썬은 gRPC(TCP 50051)로 그 서버에 명령합니다. 서버가 죽으면 "명령 통로"가 끊깁니다.

### 8-3. 실행 흐름 (네 스크립트 공통 뼈대)

| 함수 | 하는 일 |
|---|---|
| `main()` | 옵션 읽기 → (시험판) `ask_flight()` 로 설정 묻기 → 범위 검사(`ap.error`) → `confirm()` 로 점검 목록과 `yes` 확인 → 로그 파일 열기 → 남은 `CAP_ON` 지우기 → `asyncio.run(run(args))` |
| `run()` | SIGTERM 을 Ctrl+C 와 같게(현재 태스크 취소) → `guard.connect()` → `_run()` → 끝나면 언제나 `guard.stop()` |
| `_run()` | 연결 대기 → 이미 arm 이면 중단 → `wait_position_ok()`(GPS·home 정상) → `Telem.start()` → `fly()` |
| `fly()` | (RTK 판) `wait_rtk()` → 경로(`Line`) 계산 → `build_plan()` → `upload_verified()` → (dry-run 이면 삭제하고 끝) → arm 직전 기수·위치 재확인 → `arm` → `start_mission` → MISSION 모드 확인 → `monitor()` → 예외별 처리(2-3 표) → `clear_mission()` |
| `monitor()` | 0.05초마다: 착륙 완료 확인 → 모드 이탈 확인(`ModeLost`) → 시간 초과 확인 → 정렬 단계 오차 기록 → (RTK 판) 패스 앞 `rtk_gate()` → 캡처 ON/OFF·표본 수집 → 2초마다 진행 줄 출력 |

### 8-4. 주요 클래스

- **`Telem`** — MAVSDK 텔레메트리 스트림(위치·속도 10 Hz, 모드, 헤딩, GPS, in_air, 미션 진행)을 백그라운드 태스크로 받아 최신값만 들고 있습니다. `allowed` 에 모드 집합을 넣으면, 그 밖의 모드가 들어온 순간을 기록하고 `check()` 에서 `ModeLost` 를 던집니다. RTK 판은 `rtk_since` 로 Fixed 가 이어진 시간(`rtk_fixed_for()`)을 셉니다.
- **`Line`** — L 을 원점, 이동 방향을 +축으로 하는 직선 좌표. `pts` 에 L·(S·E)·X 위경도, `along_cross(pos)` 가 (진행 거리, 옆으로 벗어난 거리)를 돌려줍니다. 위경도 계산은 평면 근사(WGS84 장반경)입니다.
- **`Plan`** — FC 에 올릴 `MissionItem` 목록 `items` 와 항목별 역할 `roles[seq] = (종류, 패스 번호)`. 종류는 `takeoff`·`align`·`speed`·`hold`(L 대기)·`pass`(L→X)·`rot`(회전 단계)·`land`. `monitor()` 는 FC 가 알려 주는 현재 항목 번호로 `roles` 를 찾아 지금 무슨 단계인지 압니다.
- **`PassLog`** — 패스 하나의 캡처 시작·끝 시각과 속도·고도·cross-track(·yaw 오차) 표본. `start()` 가 `CAP_ON` 을 만들고 `end()` 가 지우며, `summary()` 가 SUMMARY 줄을 씁니다.

### 8-5. 미션 항목 만드는 법 (`build_plan`)

| 항목 | MAVLink 명령 | 좌표계 | 파라미터 |
|---|---|---|---|
| 이륙 | `NAV_TAKEOFF`(22) | GLOBAL_RELATIVE_ALT(3) | p4 헤딩(PX4 는 이륙 중 무시), z 고도 |
| 지점 | `NAV_WAYPOINT`(16) | GLOBAL_RELATIVE_ALT(3) | p1 머무는 시간, p2 도달 반경, p4 **고정 헤딩** |
| 속도 | `DO_CHANGE_SPEED`(178) | MISSION(2) | p1=1(대지속도), p2 속도, p3=-1 |
| 착륙 | `NAV_LAND`(21) | GLOBAL_RELATIVE_ALT(3) | L 좌표, p4 헤딩 |

- 위경도는 1e7 을 곱한 정수(`MISSION_ITEM_INT`)로 넣습니다.
- PX4 1.16 은 ROI 가 없으면 waypoint 의 p4 헤딩을 그대로 쓰고, 헤딩이 `MIS_YAW_ERR`(12°) 안에 들어와야 도달로 칩니다.
- 회전 패턴은 헤딩을 90°(`ROTATE_STEP`)씩 바꾼 waypoint 4개입니다. PX4 는 최단 방향으로 돌기 때문에 180° 미만으로 나눠야 시계방향이 보장됩니다.
- **대조**(`upload_verified` → `same_item`): 올린 뒤 내려받아 seq·명령·좌표계·정수 좌표는 정확히, 실수는 1e-3 안으로 같아야 합니다. PX4 는 좌표계 0·3 을 `_INT` 짝 5·6 으로 돌려주므로 같은 것으로 봅니다. 하나라도 다르면 arm 하지 않습니다.
- **예상 시간**(`estimate_s`)은 이륙(1 m/s)·정렬·첫 대기·착륙(0.7 m/s)·여유 10초에, 패스마다 왕복 이동(가감속 여유 4초씩, 회전은 30°/s) + 대기 시간을 더한 대략값입니다. `monitor()` 는 그 2배 + 60초를 넘으면 시간 초과로 봅니다. RTK 판은 패스 전 RTK 를 기다린 시간만큼 기한을 늘립니다.

### 8-6. 캡처 판정 (`monitor` 안)

- `sar_test` 계열: 현재 항목이 그 패스의 `pass` 이고 진행 거리 ≥ S 이면 ON. 진행 거리가 E 에 닿거나 항목이 넘어가면 OFF.
- 시험판 전후·좌우: 그 패스의 `pass` 항목이 시작되면 ON. 진행 거리가 X − 도달 반경에 닿거나 항목이 넘어가면 OFF. (패스 항목은 X 에서 `--settle` 초 머무는 동안에도 현재 항목이라, 항목이 넘어가기를 기다리면 정지 비행까지 캡처됩니다.)
- 시험판 회전: 그 패스의 `rot` 항목이 시작되면 ON, `rot` 이 아닌 항목으로 넘어가면 OFF.
- (RTK 판) 패스 앞 `hold` 항목이면서 L 에서 max(1 m, 도달 반경 × 2) 안에 들어오면 `rtk_gate()` 를 한 번 부릅니다. Fixed 가 모자라면 `pause_mission`(HOLD) → `wait_rtk` → `start_mission`. 그동안은 HOLD 도 허용 모드로 둡니다.

### 8-7. `mavsdk_guard.py`

| 함수 | 하는 일 |
|---|---|
| `connect(address, log)` | `busy_ports()` 로 UDP 14540·TCP 50051 을 bind 해 보고, 쓰는 프로세스가 있으면 `ss` 출력과 함께 `StaleServer`(→ 스크립트는 아무 명령도 보내지 않고 끝). 연결 0.5초 뒤 내 서버가 죽었으면 역시 `StaleServer` |
| `stop(drone)` | 내 mavsdk_server 프로세스를 kill. 이것이 없으면 서버 출력을 읽는 non-daemon 스레드 때문에 프로세스가 안 끝납니다 |
| `abort(drone, how, address, log)` | `rtl`/`land`/`hold` 를 5초 안에 보냄. 실패하면 서버를 내리고 빈 gRPC 포트로 새 서버를 띄워 다시 연결해 한 번 더 보냄 |

포트 검사가 TIME_WAIT 은 통과시키므로(SO_REUSEADDR), 스크립트가 끝난 직후 다시 실행해도 됩니다. `[오류] ... 를 이미 다른 프로세스가 쓰고 있다` 가 나오면 다른 창에서 비행 중인 스크립트가 없는지 확인한 뒤 `pkill -f mavsdk_server`.

### 8-8. `emergency_land.py` 내부

`run()` → TCP 5760 으로 연결(10초) → `status()`(armed·in_air·모드·고도) → 지상·disarm 이면 끝(`--force` 제외) → `send()` 를 5초 제한으로 최대 3번 → `CAP_ON` 삭제 → `clear_mission()`(`--keep-mission` 제외) → hold 면 끝, 아니면 1초마다 상태를 찍으며 착륙·disarm 대기(`--watch`).

---

## 9. 비행 실행기 — `flight_runner/`

가시화 화면의 「비행 제어」 탭에서 비행을 시작·중단하기 위한 부분입니다. **비행 스크립트를 고치지 않고** 옵션을 붙여 띄운 뒤 출력을 그대로 전달합니다.

| 파일 | 하는 일 |
|---|---|
| `core.py` | `FlightRunner` 본체: 파라미터 → 명령줄, 실행, 출력 따라 읽기, 상태 발행 |
| `node.py` | 드론 노드(`drone.drone_node:DroneNode`, `~/hw/pi`)를 감싸 action 세 개를 붙임 |
| `cli.py` | 노드 없이 손으로 시험하는 입구(`python -m flight_runner …`) |
| `deploy/` | `60-flight-runner.conf`(drone-node.service 덮어쓰기), `install.sh --install/--uninstall` |

**action** (`node.py` 가 선언 → 가시화 버튼이 열림)

| action | 하는 일 |
|---|---|
| `rtk_test_start` | 그때 RTK 보정이 FC 로 들어오고 있으면 `test_sar_rtk.py`, 아니면 `test_sar.py` 를 띄움(`--rtk-*` 는 뺌) |
| `rtk_test_stop` | 돌고 있는 스크립트의 **주 프로세스에만** SIGTERM (= Ctrl+C → 캡처 OFF → `--abort`). 그룹 전체에 보내면 mavsdk_server 가 먼저 죽어 abort 를 못 보냅니다 |
| `rtk_test_emergency` | `emergency_land.py` 실행. `mode` 0 land · 1 rtl · 2 hold |

**`rtk_test_start` 파라미터** (값은 모두 숫자)

| 키 | 옵션 | |
|---|---|---|
| `pattern` | `--pattern` | 0 fb · 1 lr · 2 rotate (필수) |
| `side` | `--side` | 0 forward · 1 back · 2 right · 3 left (회전 아니면 필수) |
| `dry_run` | `--dry-run` | 0/1 (필수). 0 이면 `confirmed=1` 이 있어야 받음 |
| `altitude_m` · `passes` | `--altitude` · `--passes` | 필수, passes 는 정수 |
| `length_m` · `speed_mps` | `--length` · `--speed` | 회전 아니면 필수 |
| `gap_s` · `heading_deg` · `accept_radius_m` · `align_hold_s` · `settle_s` · `rtk_min_s` · `rtk_timeout_s` | 같은 이름의 옵션 | 선택 |
| `abort` | `--abort` | 0 rtl · 1 hold · 2 land (선택) |

언제나 `--yes` 를 붙입니다(사람의 확인은 화면이 받음). 범위 검사는 스크립트에 맡깁니다.

**지키는 것**

- 스크립트는 `systemd-run --user` 로 **별도 유닛**에서 돕니다. 실행기·노드가 재시작돼도 비행은 계속되고, 재시작하면 `cansar_logs/runner/runner_state.json` 으로 같은 유닛·출력 파일(`cansar_logs/runner/<run_id>.out`)에 다시 붙습니다.
- 출력은 가공하지 않고 최근 200줄을 `<토픽 base>/flight_run` 에 retain 으로 냅니다(새 줄이 있으면 최대 2 Hz, 없으면 5초마다).
- 이미 돌고 있으면 새 시작은 거절(`already_running`). 자동 실행·재시도 경로는 없습니다.

**손으로 시험** (`cd ~/drone`)

```bash
./venv/bin/python -m flight_runner start pattern=0 side=0 altitude_m=3 length_m=3 speed_mps=1 passes=1 dry_run=1
./venv/bin/python -m flight_runner start --no-rtk …   # test_sar.py 로 (노드 밖에서는 RTK 를 판정하지 않아 기본은 test_sar_rtk.py)
./venv/bin/python -m flight_runner status | follow | stop
./venv/bin/python -m flight_runner emergency land
```

드론 노드에 실행기가 설치돼 있으면 노드가 주인이라, `cli` 는 `status`·`follow`·`stop` 만 하고 `start`·`emergency` 는 거절합니다(`--owner` 로 강제, 노드가 꺼져 있을 때만).

---

## 10. 알려진 한계

- **실비행 미검증**: `sar_test`·`sar_test_rtk`·`test_sar` 의 미션 방식은 지상에서 실제 FC 로 업로드·대조·삭제(dry-run)와 감시 로직 모의 비행까지만 확인했습니다. **처음에는 `test_sar` 를 5 m·저속으로 날려** 기수 고정과 캡처 시점을 확인하세요.
- **등속은 FC 가 정합니다**: 가속·감속은 PX4 가 계획합니다. 20 m 여유 안에서 등속에 들어간다는 것은 가정이고, SUMMARY 의 속도로 확인해야 합니다.
- **캡처 시점 지연**: cansar 가 파일을 보고 SDR 에 지시하므로 실제 SDR 시작·정지는 파일보다 조금 늦습니다. 정확한 시각은 cansar `events.csv` 에 있습니다.
- **연속 실행**: 스크립트가 끝난 직후 바로 다시 실행해도 됩니다(예전에는 약 1분 동안 `TCP 50051 을 이미 다른 프로세스가 쓰고 있다` 로 거부됐는데, 2026-10-09 `mavsdk_guard.py` 에서 고쳤습니다).
