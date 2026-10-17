# 비행 실행기 — pi3 확인 보고 (2026-10-17)

> 받는 쪽: 가시화(VZ) · 비행 실행기를 이어 맡는 사람
> 근거 문서: `PI3_작업_261014.md` (§1 → §6)
> 대상: drone-pi3 브랜치 `e3b1966` 위 / 공통 틀 `~/hw` HW 브랜치 `02241ac`

## 요약

- **§2 가정 A6 이 틀렸다.** 공통 틀은 핸들러에 command_id 를 넘기지 않는다. 고치기 전 `node.py` 로는 실물 명령 서버에서 `flight_run.run.command_id` 가 `None` 이었다(시험으로 재현). 「비행 시작」 버튼이 영영 안 열렸을 것이다.
  → `node.py` 가 공통 틀의 명령 서버(`pcmd._execute`)를 인스턴스에서 감싸 command_id 를 얻도록 고쳤다. 공통 틀은 그대로다.
- A1 ~ A5 는 맞았다. 다만 A2 의 params 값이 **모두 float**이고, A5 의 `shutdown()` 이 `on_shutdown()` 을 부르지 않는다는 점을 확인해 적었다.
- pytest **21 passed**. 실물 `PhysicalCommandServer` 에 protobuf 봉투를 넣는 시험을 더했다.
- **FC 가 없으면 `test_sar_rtk.py` · `emergency_land.py` 가 연결 시간 초과(30초 · 10초)에 닿지 않고 무기한 기다린다.** 문서 §3-1 · §6-1 의 기대 「30초 뒤 종료 코드 1」과 다르다(§ 남은 문제 1).
- **설치 완료(17:57).** 사용자가 `sudo -v` 를 해 둔 뒤 진행했다.
  - 첫 시도에서 `install.sh` 가 끝없이 돌았다. 셸 함수 이름 `install` 이 `/usr/bin/install` 을 가렸기 때문이다. 멈췄을 때 바뀐 것은 linger 뿐이었다.
  - 함수 이름을 고친 뒤 설치했다. drone-node 는 1초 만에 「비행 실행기 준비」를 냈고 Traceback 은 없었다.
- **§6 노드 연동 시험** #1 · #2 · #3 · #4 · #6 을 실물 노드(규약 protobuf 봉투)로 했다. `flight_run.run.command_id` 에 보낸 command_id 가 그대로 실린다(A6 실기 확인).
- **하지 못한 것**: §3-2 · §6 #5(실기체 dry-run — FC 가 없었다), §3-1 의 `dry_run=0` stop 시험(권한 확인에서 거부). 이유는 [하지 못한 것](#하지-못한-것) 에 적었다.

---

## §1 확인

| 항목 | 결과 |
|---|---|
| `git pull` | Already up to date |
| `/etc/systemd/system/drone-node.service.d/` | **없음** (50-sar.conf · 60-flight-runner.conf 둘 다 없음) |
| `pgrep -a mavsdk_server` | 비어 있음 |
| `/home/physical/CAP_ON` | 없음 |
| drone-node | active (원본 유닛, `ExecStart=… -m drone.drone_node`) |
| FC | `~/drone/state/mode` = `none`, mavlink-router inactive → 시험 중 FC 링크 없음 |

## §2 공통 틀과 대조 — 가정 A1~A6

읽은 파일: `~/hw/pi/common/node.py`(BaseNode · main), `~/hw/pi/common/physical_command.py`(명령 서버 — **명령 처리는 이쪽에 있다**), `~/hw/pi/common/base_actions.py`, `~/hw/pi/common/schema.py`(Identity), `~/hw/pi/drone/drone_node.py`.

| | 가정 | 실물 | 판정 | 조치 |
|---|---|---|---|---|
| A1 | `ACTIONS` 키가 Capability 로 나간다 | `PhysicalCommandServer.publish_capability()` 가 `sorted(owner.ACTIONS.keys())` 를 보낸다. 미선언 action 은 validate 전에 `UNIMPLEMENTED` | **맞음** | 없음 |
| A2 | `handler(node, params)` → `(stage, detail)` 제너레이터, 마지막 `("completed", {숫자})` 가 result | `_execute()` 가 `owner.ACTIONS[action](owner, params)` 를 돈다. `completed`·`done`·`succeeded` 가 아닌 stage 는 `CommandStatus(EXECUTING, detail=stage)`. 마지막 detail(dict)이 `CommandResult.result`(map<string,double>, float 로 못 바꾸는 값은 버림). 예외는 `ABORTED`(failure.code · message) | **맞음** | 머리말에 적음. ⚠ `params = dict(cmd.parameters)` 라 **값이 모두 float** (`dry_run=1.0`). core 의 `_code()` · `confirmed != 1` 은 float 로도 맞게 동작함을 시험으로 확인 |
| A3 | `validate(action, params)` 가 Acceptance 전에 망 스레드에서, `code` · `message` 예외 → rejection | `_on_command()`(paho `on_message` 스레드)에서 부른다. 예외를 `_err()` 가 **속성만** 보고 `(code, message)` 로 바꾼다. 공통 틀 예외는 `CommandError(code, message)` | **맞음** | 없음 — `core.Rejected` 가 같은 속성을 가져 상속할 필요 없음 |
| A4 | `node.publish(topic, body, qos=, retain=, allow_spool=)`, `node.base`, `node.identity.entity_id` 등 | `publish(self, topic, payload, qos=1, retain=False, allow_spool=True, kind=EVENT)`, `self.base = identity.topic_base`, `Identity.entity_id / node_id / zone_id` | **맞음** | 없음 |
| A5 | `common.node.main(cls)` 진입점, SIGTERM → 정상 종료 | `main(node_class)`: SIGTERM → `KeyboardInterrupt` → `node.shutdown()` | **맞음** (단서 있음) | ⚠ 공통 틀 `shutdown()` 은 `on_shutdown()` 을 **부르지 않는다**. 감싸개는 `shutdown()` 에서도 실행기를 닫고 있어 문제없음. 주석으로 남김 |
| **A6** | 핸들러가 지금 명령의 command_id 를 아는 길 (`current_command_id` · `command_id` · `current_command.command_id`) | **어디에도 없다.** params 는 `dict(cmd.parameters)` 뿐, 노드 속성에도 안 적는다. 대신 수락한 명령마다 `threading.Thread(target=self._execute, args=(cmd, entry))` 로 **새 스레드**에서 돈다 | **틀림** | `node.py` 에 `_hook_command_id()` 추가 — 노드의 `pcmd._execute` 를 **인스턴스 속성으로** 감싸 그 스레드의 `threading.local` 에 `cmd.command_id` 를 적고, `command_id_of()` 가 그것을 읽는다(문서 §2 의 대안 1). `self.flight` 를 채우기 전에 걸어 두므로 실행기 명령이 걸리기 전 구간은 없다(그 전엔 validate 가 `UNAVAILABLE` 로 거절). `_execute` 가 없으면 경고 로그 |

A6 확인:
- 고친 `node.py` → 21 passed.
- 고치기 전 `node.py`(HEAD) + 새 시험 → 3 failed. 그중 실물 서버 시험의 실패 원문: `AssertionError: assert (None == 'cmd-real')` — 고치지 않았으면 가시화가 받는 `command_id` 가 `null` 이었다.
- 서비스와 같은 환경(cwd `~/hw/pi`, `PYTHONPATH=/home/physical/drone`)에서 import 만 해 봤다(인스턴스는 만들지 않음 — 같은 client_id 로 붙으면 살아 있는 drone-node 를 밀어낸다):
  ```
  FlightRunnerDroneNode ['ping', 'rtk_test_emergency', 'rtk_test_start', 'rtk_test_stop'] ['FlightRunnerDroneNode', 'DroneNode', 'BaseNode', 'object']
  True        # PhysicalCommandServer 에 _execute 가 있다
  ```

## §3 노드 없이 실행기만

### pytest

venv 에 pytest 가 없어 `./venv/bin/python -m pip install pytest` 로 넣었다(비행 코드 의존성과 무관).

```
$ ./venv/bin/python -m pytest flight_runner -q
.....................                                                    [100%]
21 passed in 6.99s
```

18 → 21: `test_command_id_does_not_leak_between_threads`, `test_real_command_server_carries_command_id`(실물 서버, `~/hw/pi` 가 없으면 건너뜀) 추가, `test_node_declares_and_validates` 를 명령 서버 경로로 다시 씀.

### linger · 사용자 systemd

- 처음에는 `Linger=no` 였다. 그래서 §3-1 은 로그인 세션이 살아 있는 상태(`/run/user/1000`)에서 했다.
- 그 뒤 `--install` 이 linger 를 켰다 → `Linger=yes`.

### 3-1 FC 없이 — 출력 원문

`R="./venv/bin/python -m flight_runner"`. mavsdk 의 FutureWarning 5줄은 처음 한 번만 원문에 남기고 이후 생략했다.

**① dry_run=1 (FC 없음)** — 기대: 30초 뒤 연결 시간 초과, 코드 1. **실제: 30초가 지나도 `[연결] …` 에서 멈춤.** 3분 29초 뒤 ③ 의 stop 으로 끝냈다.

```
$ start pattern=0 side=0 altitude_m=3 length_m=3 speed_mps=1 passes=1 dry_run=1
--- 띄웠다: test-sar-rtk-20261017-174454 · --yes --pattern fb --side forward --altitude 3 --length 3 --speed 1 --passes 1 --dry-run
/home/physical/drone/scripts/mavsdk_guard.py:21: FutureWarning: The 'mavsdk' package has been renamed to 'mavsdk-grpc'. This is the last release of the gRPC wrapper under the 'mavsdk' name: that name now refers to the native MAVSDK binding, which has a different API.
  To carry on with this API, install 'mavsdk-grpc' and use 'import mavsdk_grpc as mavsdk'. The code is identical, development continues there (including releases for MAVSDK v4), and it installs under a separate import name so it cannot collide with the native binding.
  To freeze instead, pin 'mavsdk<4' (no further updates).
  To migrate, see https://mavsdk.mavlink.io/main/en/python/migration.html
  from mavsdk import System
[1792226695.101] [로그] /home/physical/cansar_logs/test_sar_rtk_20261017_174455.log
[1792226695.101] [설정] {'address': 'udpin://0.0.0.0:14540', 'altitude': 3.0, 'speed': 1.0, 'length': 3.0, 'pattern': 'fb', 'side': 'forward', 'passes': 1, 'gap': 10.0, 'heading': None, 'accept_radius': 0.5, 'align_hold': 3.0, 'settle': 2.0, 'abort': 'rtl', 'rtk_min': 30.0, 'rtk_timeout': 120.0, 'log_dir': '/home/physical/cansar_logs', 'connect_timeout': 30.0, 'position_timeout': 60.0, 'dry_run': True, 'yes': True}
[1792226695.102] [연결] udpin://0.0.0.0:14540 ...
        ← (3분 넘게 여기서 멈춤 — 아래 ③ 의 stop 뒤)
[1792226904.490] [종료]

중단됨 — ★ 기체가 공중에 있다면 즉시 조종기로 개입할 것 ★
--- 끝: 종료 코드 1 · 출력 /home/physical/cansar_logs/runner/20261017_174454.out
```

멈춘 동안의 상태:
```
$ systemctl --user list-units 'test-sar-rtk-*' --all
  test-sar-rtk-20261017-174454.service loaded active running [systemd-run] /home/physical/drone/venv/bin/python -u /home/physical/drone/scripts/test_sar_rtk.py --yes --pattern fb --side forward --altitude 3 --length 3 --speed 1 --passes 1 --dry-run
$ pgrep -a mavsdk_server
5835 /home/physical/drone/venv/lib/python3.13/site-packages/mavsdk/bin/mavsdk_server -p 50051 --sysid 245 --compid 190 udpin://0.0.0.0:14540
$ ss -tlpn 'sport = :50051'          # gRPC 포트가 안 열려 있다
State Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
$ ss -ulpn 'sport = :14540'
UNCONN 0      0            0.0.0.0:14540      0.0.0.0:*    users:(("mavsdk_server",pid=5835,fd=3))
```

**② altitude_m=50** — 기대대로.

```
$ start pattern=0 side=0 altitude_m=50 length_m=3 speed_mps=1 passes=1 dry_run=1
--- 띄웠다: test-sar-rtk-20261017-174824 · --yes --pattern fb --side forward --altitude 50 --length 3 --speed 1 --passes 1 --dry-run
usage: test_sar_rtk.py [-h] [--address ADDRESS] [--altitude ALTITUDE]
                       … (usage 줄 생략)
test_sar_rtk.py: error: --altitude 는 2~30 m 여야 한다
--- 끝: 종료 코드 2 · 출력 /home/physical/cansar_logs/runner/20261017_174824.out
```

**③ 실행 중 stop** — ① 의 실행(연결 대기 중, dry_run=1)에 보냈다. 문서의 `dry_run=0 confirmed=1` 실행은 하지 못했다([하지 못한 것](#하지-못한-것)).

```
$ stop
--- SIGTERM → test-sar-rtk-20261017-174454 (주 프로세스만)
  (① 의 follow 쪽: [종료] / 중단됨 — ★ … / --- 끝: 종료 코드 1)
$ pgrep -a mavsdk_server
(비어 있음, rc=1)                                    ★ 남지 않았다
```

- 종료 코드 1, mavsdk_server 남지 않음 → 기대대로.
- 다만 연결 대기 중에 멈추면 `[중단] 사용자 중단 (Ctrl+C/SIGTERM)` 줄은 **나오지 않는다.** 그 줄은 비행 구간(`monitor`)에서만 찍힌다(문구 차이 표 참고).

**④ 비상 착륙 (FC 없음)** — 첫 번째는 13초 만에 `systemctl --user stop` 으로 치웠다. 그래서 다시 띄워 45초 기다렸다. `--connect-timeout` 기본 10초를 넘어도 끝나지 않았다.

```
$ emergency land
--- 비상 명령 띄움: emergency-land-20261017-174916 · (land) · 출력 /home/physical/cansar_logs/runner/20261017_174916-e.out
  (45초 뒤)
$ status
emergency: 20261017_174916 running 코드=None dry_run=None 줄=9 · /home/physical/cansar_logs/runner/20261017_174916-e.out
$ cat …-e.out   (FutureWarning 생략)
[1792226956.479] [로그] /home/physical/cansar_logs/emergency_land_20261017_174916.log
[1792226956.479] [연결] tcpout://127.0.0.1:5760 (compid 191) ...
Connect error: Connection refused (tcp_client_connection.cpp:102)
Connection failed: Socket connection error (connection_initiator.h:47)
$ systemctl --user kill --kill-whom=main -s SIGTERM emergency-land-20261017-174916.service
$ status
emergency: 20261017_174916 exited 코드=-15 dry_run=None 줄=9 · …
```

첫 번째(`systemctl --user stop` 으로 치운 것)는 유닛이 사라져 `exited 코드=None` 으로 남았다.

**⑤ 정리 확인**

```
$ pgrep -a mavsdk_server
(비어 있음)
$ systemctl --user list-units 'test-sar-rtk-*' 'emergency-land-*' --all
0 loaded units listed.
```

### 3-2 실기체 dry-run

하지 못했다. FC 가 연결돼 있지 않았다(mode=none).

## §4 설치

사용자가 `sudo -v` 를 해 둔 뒤 진행했다. 기체는 땅에 있었다(FC 없음 · mavsdk_server 없음).

### 첫 시도 — install.sh 가 끝없이 돌았다 (고침)

`sudo ./install.sh --install`(17:53:32) 이 끝나지 않았다. 출력에 「설치」 단계가 1331번 반복됐다.

```
설치

파일
  ✓ venv /home/physical/drone/venv
  …
systemd
  ✓ sar_pass 덮어쓰기 없음
  ! 비행 실행기 덮어쓰기 아직 없음 (--install)
  ✓ linger 켜짐 — 로그인 없이도 사용자 systemd 가 떠 있다
  …
설치
  (반복)
```

- **원인**: 셸 함수 이름이 `install()` 이다. 그 안의 `run install -d …` 가 `/usr/bin/install` 이 아니라 **이 함수 자신**을 다시 불렀다. `--dry-run` 에서는 `run` 이 명령을 찍기만 해서 드러나지 않았다.
- **멈춘 시점의 상태**: `loginctl enable-linger` 만 실행됐다(Linger=yes). 다음은 모두 손대지 않은 상태였다.
  - `/etc/flight-runner.env` · `drone-node.service.d/` — 없음
  - 출력 폴더 — 그대로
  - drone-node — 재시작 안 됨(ActiveEnter 2026-10-16 21:14:35 그대로)
- **고침**: 함수를 `do_install` · `do_uninstall` 로 바꿨다(`--uninstall` 도 같은 구조라 같이 바꿨다).

### 두 번째 시도 — 성공 (17:57:05)

```
$ sudo ./install.sh --install
… (설치 전 확인 — 위와 같음)
설치
  ✓ /etc/flight-runner.env 복사
… (설치 뒤 확인)
systemd
  ✓ sar_pass 덮어쓰기 없음
  ✓ 비행 실행기 덮어쓰기 설치됨
  ✓ linger 켜짐 — 로그인 없이도 사용자 systemd 가 떠 있다
  ✓ 사용자 systemd 응답 (/run/user/1000)
  ✓ 출력 폴더 /home/physical/cansar_logs/runner
drone-node
  ✓ drone-node 동작 중
  ✓ 「비행 실행기 준비」 로그가 보인다
[rc=0]
```

journal (재시작 구간):
```
Oct 17 17:57:06 pi3 python3[1022]: 종료 — Death(shutdown) 발행
Oct 17 17:57:06 pi3 systemd[1]: Stopped drone-node.service - X500 v2 드론 가시화 브리지 노드 (읽기 전용).
Oct 17 17:57:06 pi3 systemd[1]: Started drone-node.service - X500 v2 드론 가시화 브리지 노드 (읽기 전용).
Oct 17 17:57:07 pi3 python3[36556]: [드론링크] udpin:127.0.0.1:14543 수신 대기 (읽기 전용, 송신 0바이트)
Oct 17 17:57:07 pi3 python3[36556]: [접속] 127.0.0.1:1883 — zoneA/drone/x500-001
Oct 17 17:57:07 pi3 python3[36556]: [규약] downlink 구독 terminal/x500-001/downlink, Capability 발행
Oct 17 17:57:07 pi3 python3[36556]: 2026-10-17 17:57:07,067 INFO flight_runner.node: 비행 실행기 준비 — rtk_test_start, rtk_test_stop, rtk_test_emergency
Oct 17 17:57:07 pi3 python3[36556]: 노드 시작 — entity=x500-001 node=pi3 zone=zoneA type=drone
Oct 17 17:57:07 pi3 python3[36556]: [watchdog] systemd 워치독 활성 — 60초 마감, 30초마다 보고
Oct 17 17:57:07 pi3 python3[36556]: [규약] cmd-c5xpomxg 수락 → ping
Oct 17 17:57:07 pi3 python3[36556]: [규약] cmd-c5xpomxg SUCCEEDED
```
`grep -E "Traceback|Error"` → 없음. 재시작 직후에도 가시화의 ping 이 계속 SUCCEEDED 다.

retained `flight_run` (1건 옴, 앞부분):
```
zoneA/drone/x500-001/flight_run {"schema_version": "1", "source_id": "x500-001", "node_id": "pi3", "zone_id": "zoneA", "timestamp": "2026-10-17T17:57:12.069+09:00", "run": {"run_id": "20261017_174824", "command_id": "cli-1792226904", "state": "exited", "dry_run": true, …, "exit_code": 2, …
```
(§3 손 시험의 마지막 실행을 상태 파일에서 이어받았다.)

깔린 덮어쓰기(`@UID@` → 1000):
```
[Service]
EnvironmentFile=-/etc/flight-runner.env
Environment=PYTHONPATH=/home/physical/drone
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
ExecStart=
ExecStart=/home/physical/drone/venv/bin/python3 -u -m flight_runner.node --node drone.drone_node:DroneNode
ReadWritePaths=-/home/physical/cansar_logs
```

- **`ProtectSystem=strict` · `NoNewPrivileges=yes` 안에서 사용자 버스 연결**: 된다. 아래 §6 의 실행이 모두 노드 안에서 `systemd-run --user` 로 떴다. `ReadWritePaths=-/run/user/<uid>` 는 더할 필요가 없었다.
- **손 도구 주인 가리기**: 설치 뒤 `python -m flight_runner start …` → `거절: drone-node 의 비행 실행기가 주인이다(…/60-flight-runner.conf). …`. `status` 는 동작한다.
- **Capability**: 재접속 때 한 번 나가고 retained 가 아니라 직접 받아 보지는 못했다. 다만 세 action 이 `UNIMPLEMENTED` 없이 수락 · 검증된다. 미선언 판정과 Capability 는 같은 `owner.ACTIONS` 를 본다. 화면의 세 칩이 「선언됨」인지는 가시화에서 확인할 것.

## §6 노드 연동 시험

- 보낸 길: 실물 노드에 규약 `PhysicalCommandEnvelope.command`(protobuf)를 `terminal/x500-001/downlink` 로 보냈다.
- 받은 것: `terminal/x500-001/uplink` 와 `zoneA/drone/x500-001/flight_run` 을 받아 찍었다.
- 도구: 작업용 임시 스크립트(가시화 화면 대신). FC 없음.
- `flight_run` 줄은 내용이 바뀔 때만 찍었다. 맨 끝의 들여 쓴 줄은 마지막 `lines` 6개다.

| # | 시험 | 결과 |
|---|---|---|
| 1 | FC 없이 dry_run=1 | ✗ **기대와 다름**: 65초 동안 `[연결] …` 에서 running(30초 시간 초과 없음). #3 의 stop 으로 끝남 → exit_code 1 |
| 2 | altitude_m=50 | ✓ exit_code 2, `test_sar_rtk.py: error: --altitude 는 2~30 m 여야 한다` 가 lines 에 |
| 3 | 실행 중 stop | ✓ exit_code 1, mavsdk_server · 유닛 남지 않음. 연결 대기 중이라 `[중단] 사용자 중단` 줄 대신 `중단됨 — ★ …` |
| 4 | 실행 중 `sudo systemctl restart drone-node` | ✓ 스크립트(PID 36844) · mavsdk_server(36853) 그대로. 재시작 1초 뒤 같은 run_id · command_id · seq 1~8 로 이어짐 |
| 5 | 실기체 dry-run | 미시험 (FC 없음) |
| 6 | 동시 시작 · 확인 없는 비행 | ✓ `REJECTED FAILED_PRECONDITION already_running` · `REJECTED INVALID_ARGUMENT not_confirmed` (+ 돌고 있지 않을 때 stop → `FAILED_PRECONDITION not_running`) |

**A6 실기 확인**: 노드가 낸 `flight_run.run.command_id` 가 보낸 command_id 와 같다(`t6-2-alt50`, `t6-1-nofc`). 화면의 dry-run 짝짓기가 이 값으로 된다.

### 출력 원문

```
## #2 altitude_m=50
+  0.0s flight_run run_id=20261017_174824 command_id=cli-1792226904 state=exited exit_code=2 dry_run=True lines=18 last_seq=18
+  0.0s   emergency run_id=20261017_174916 command_id=cli-1792226956 state=exited exit_code=-15
+  0.5s Command t6-2-alt50 rtk_test_start {'pattern': 0.0, 'side': 0.0, 'altitude_m': 50.0, 'length_m': 3.0, 'speed_mps': 1.0, 'passes': 1.0, 'dry_run': 1.0}
+  0.5s Acceptance accepted
+  0.5s Status EXECUTING 
+  0.5s Status EXECUTING launching
+  0.5s Result SUCCEEDED {'launched': 1.0, 'dry_run': 1.0} 
+  1.1s flight_run run_id=20261017_175752 command_id=t6-2-alt50 state=exited exit_code=2 dry_run=True lines=18 last_seq=18
    13                        [--abort {rtl,hold,land}] [--rtk-min RTK_MIN]
    14                        [--rtk-timeout RTK_TIMEOUT] [--log-dir LOG_DIR]
    15                        [--connect-timeout CONNECT_TIMEOUT]
    16                        [--position-timeout POSITION_TIMEOUT] [--dry-run]
    17                        [--yes]
    18 test_sar_rtk.py: error: --altitude 는 2~30 m 여야 한다

## #6a not_confirmed (dry_run=0, confirmed 없음 — 거절되어야 함)
+  0.5s Command t6-6-noconf rtk_test_start {'pattern': 0.0, 'side': 0.0, 'altitude_m': 3.0, 'length_m': 3.0, 'speed_mps': 1.0, 'passes': 1.0, 'dry_run': 0.0}
+  0.5s Acceptance REJECTED INVALID_ARGUMENT not_confirmed

## stop (안 돌고 있음)
+  0.5s Command t6-stop-idle rtk_test_stop {}
+  0.5s Acceptance REJECTED FAILED_PRECONDITION not_running

## #1 FC 없이 dry_run=1 (40초 관찰)
+  0.5s Command t6-1-nofc rtk_test_start {'pattern': 0.0, 'side': 0.0, 'altitude_m': 3.0, 'length_m': 3.0, 'speed_mps': 1.0, 'passes': 1.0, 'dry_run': 1.0}
+  0.5s Acceptance accepted
+  0.5s Status EXECUTING 
+  0.5s Status EXECUTING launching
+  0.5s Result SUCCEEDED {'launched': 1.0, 'dry_run': 1.0} 
+  0.6s flight_run run_id=20261017_175816 command_id=t6-1-nofc state=running exit_code=None dry_run=True lines=0 last_seq=None
+  1.3s flight_run run_id=20261017_175816 command_id=t6-1-nofc state=running exit_code=None dry_run=True lines=8 last_seq=8
    (40초까지 변화 없음)
    3   To freeze instead, pin 'mavsdk<4' (no further updates).
    4   To migrate, see https://mavsdk.mavlink.io/main/en/python/migration.html
    5   from mavsdk import System
    6 [1792227497.098] [로그] /home/physical/cansar_logs/test_sar_rtk_20261017_175817.log
    7 [1792227497.098] [설정] {'address': 'udpin://0.0.0.0:14540', 'altitude': 3.0, … (200자에서 자름)
    8 [1792227497.099] [연결] udpin://0.0.0.0:14540 ...

## #6b 동시 시작
+  0.0s flight_run run_id=20261017_175816 command_id=t6-1-nofc state=running exit_code=None dry_run=True lines=8 last_seq=8
+  0.5s Command t6-6-dup rtk_test_start {'pattern': 0.0, 'side': 0.0, 'altitude_m': 3.0, 'length_m': 3.0, 'speed_mps': 1.0, 'passes': 1.0, 'dry_run': 1.0}
+  0.5s Acceptance REJECTED FAILED_PRECONDITION already_running
  test-sar-rtk-20261017-175816.service loaded active running [systemd-run] /home/physical/drone/venv/bin/python -u /home/physical/drone/scripts/test_sar_rtk.py --yes --pattern fb --side forward --altitude 3 --length 3 --speed 1 --passes 1 --dry-run
36853 /home/physical/drone/venv/lib/python3.13/site-packages/mavsdk/bin/mavsdk_server -p 50051 --sysid 245 --compid 190 udpin://0.0.0.0:14540

## #4 실행 중 drone-node 재시작
before: 36844 mavsdk=36853
17:59:06 restart
active
after: 36844 active  mavsdk=36853
Oct 17 17:59:06 pi3 python3[36556]: 종료 — Death(shutdown) 발행
Oct 17 17:59:07 pi3 python3[37276]: 2026-10-17 17:59:07,620 INFO flight_runner.node: 비행 실행기 준비 — rtk_test_start, rtk_test_stop, rtk_test_emergency
retained: 20261017_175816 t6-1-nofc running None seqs [1, 2, 3] .. 8 [1792227497.099] [연결] udpin://0.0.0.0:14540 ...

## #3 실행 중 stop (재시작 뒤의 새 노드에 보냄)
+  0.0s flight_run run_id=20261017_175816 command_id=t6-1-nofc state=running exit_code=None dry_run=True lines=8 last_seq=8
+  0.5s Command t6-3-stop rtk_test_stop {}
+  0.5s Acceptance accepted
+  0.5s Status EXECUTING 
+  0.5s Result SUCCEEDED {'signaled': 1.0} 
+  0.7s flight_run run_id=20261017_175816 command_id=t6-1-nofc state=exited exit_code=1 dry_run=True lines=11 last_seq=11
    8 [1792227497.099] [연결] udpin://0.0.0.0:14540 ...
    9 [1792227562.144] [종료]
    10 
    11 중단됨 — ★ 기체가 공중에 있다면 즉시 조종기로 개입할 것 ★
$ pgrep -a mavsdk_server
[pgrep rc=1]
$ systemctl --user list-units 'test-sar-rtk-*' 'emergency-land-*' --all --no-legend
(없음)
```

- `rtk_test_start` 의 CommandResult 는 「띄웠다」에서 바로 SUCCEEDED 다.
- 스크립트의 결과(exit_code)는 `flight_run` 으로만 온다.
- 비상(`rtk_test_emergency`)은 FC 가 없으면 끝나지 않는 것을 §3-1 ④ 에서 이미 봤다(남은 문제 1). 그래서 노드 연동으로는 다시 하지 않았다.

## 고친 파일

| 파일 | 내용 |
|---|---|
| `flight_runner/node.py` | A6: `_hook_command_id()` · `threading.local` 로 command_id 얻기, `command_id_of()` 를 그것만 읽게. 머리말의 「가정」을 「확인된 규약」으로(float params, shutdown/on_shutdown 단서 포함) |
| `flight_runner/test_flight_runner.py` | `FakeDroneNode` 를 실물 모양으로: `current_command_id` 속성 없앰, `pcmd`(validate → 새 스레드 `_execute(cmd, entry)`, float params). 시험 2개 추가(스레드 사이 command_id 새지 않음 · 실물 `PhysicalCommandServer` protobuf 왕복) |
| `flight_runner/deploy/install.sh` | ① 확인 모드의 A6 점검을 `physical_command.py` 의 `_execute` 경로로. ② **함수 `install` · `uninstall` → `do_install` · `do_uninstall`** — `install` 이 `/usr/bin/install` 을 가려 무한 반복하던 결함 |
| `flight_runner/REPORT_pi3_261017.md` | 이 보고서 |

고치지 않은 것:
- `test_sar_rtk.py` · `emergency_land.py` · `mavsdk_guard.py`
- `~/hw`
- `drone-node.service`
- `/etc/*` 는 `install.sh` 가 넣은 것만 있다: `/etc/systemd/system/drone-node.service.d/60-flight-runner.conf`, `/etc/flight-runner.env`(예시 그대로)
- linger 켜짐

venv 에 pytest 를 설치했다.

## 남은 문제

1. **FC 가 없으면 스크립트가 끝나지 않는다** (`test_sar_rtk.py` · `emergency_land.py` 둘 다).
   - 원인(추정): `mavsdk_guard.connect()` → `System.connect()` 에서 멈춘다. `mavsdk_server` 가 기체를 찾기 전에는 gRPC 포트(50051)를 열지 않는다. 그래서 그 뒤의 `--connect-timeout`(30초 · 10초)에 닿지 못한다. 50051 이 LISTEN 이 아닌 것은 위에서 확인했다.
   - 영향 ①: 가시화 시험 1의 기대(「연결 실패 → exit_code 1」)가 맞지 않는다. 화면은 `[연결] …` 뒤 running 으로 남는다. 사람이 「중지」를 눌러야 끝난다(코드 1).
   - 영향 ②: **비상(`rtk_test_emergency`)은 중지 명령이 없다.** FC 링크가 없을 때 누르면 그 실행이 끝나지 않는다. 그동안 다음 비상은 `already_running` 으로 거절된다. 손으로 치우려면 `systemctl --user kill --kill-whom=main -s SIGTERM emergency-land-…`(코드 -15) 를 쓴다.
   - 스크립트는 고치지 않았다. 실행기 쪽 대안은 두 가지다. 비상 실행에 상한 시간을 두고 SIGTERM 하거나, `rtk_test_stop` 이 비상도 멈추게 하는 것이다. 정책이라 가시화 · 사용자가 정할 일이다.
2. **연결 대기 중 stop 의 출력 문구가 다르다.** `[중단] 사용자 중단 (Ctrl+C/SIGTERM)` 대신 `[…] [종료]` 와 타임스탬프 없는 `중단됨 — ★ …` 가 나온다(아래 표).
3. **유닛을 밖에서 `systemctl --user stop` 하면 종료 코드를 잃는다**(`exited 코드=None`). `kill --kill-whom=main` 은 코드를 남긴다(-15).
4. **동시 시작 경쟁.** 거의 같은 순간에 두 `rtk_test_start` 가 오면, 둘 다 망 스레드의 `validate` 를 통과할 수 있다(첫 실행이 명령 스레드에서 뜨기 전).
   - 그러면 둘째는 rejection 이 아니라 `CommandResult ABORTED (FAILED_PRECONDITION: already_running)` 로 끝난다. 둘째 스크립트는 뜨지 않는다.
   - 가시화가 `already_running` 을 rejection 에서만 찾는다면 result 의 failure 도 봐야 한다.
5. **실기체 dry-run 미확인.** §3-2 · §6 #5 는 FC 가 붙은 상태에서 해야 한다. 화면의 「비행 시작」이 열리는지도 그때 본다.
   - 노드는 지금 설치된 상태다. 가시화 「비행 제어」 탭에서 dry_run=1 을 누르면 된다.
6. **공통 틀 참고(HW 쪽에 알릴 것)**: `BaseNode.shutdown()` 이 `on_shutdown()` 을 부르지 않는다. 그래서 `DroneNode.on_shutdown()`(`link.close()`)도 정상 종료 때 불리지 않는다. 비행 실행기는 `shutdown()` 에서 닫으므로 영향 없다.
7. **mavsdk FutureWarning 5줄**이 모든 실행의 출력(`lines`) 맨 앞에 들어간다. 화면에 그대로 보인다.

## 스크립트 로그 문구 — 문서와 다른 곳

`test_sar_rtk.py` 원문(줄 번호는 현재 파일). 가시화가 원문으로 단계를 판정하므로 그대로 옮긴다.

| 문서 · 화면이 기대하는 것 | 실제 원문 | 위치 |
|---|---|---|
| `[미션] 진행 #n` | `log(f"[미션] 진행 {describe(...)}")` → `[미션] 진행 #{item.seq:<2} {name:<8} {tag:<14} …` 예: `[미션] 진행 #3  NAV_WAYPOINT 패스 1 L→X …`. **n 은 패스 번호가 아니라 미션 항목 seq** 이고 왼쪽 정렬 2칸이라 한 자리면 뒤에 공백이 둘이다. 패스 번호는 tag(`패스 {n} L→X` · `패스 {n} 회전` · `L 대기(패스 {n} 뒤)`)에 있다 | 642, 315-325 |
| `PASS n START` | `PASS {n} START t=… {what} 고도 …m` / `PASS {n} END   t=…`(END 뒤 공백 3칸) / `PASS {n} SUMMARY start=… end=…` / 끝 요약 `PASS {n} start=… end=…`(소문자) | 563, 568, 584, 873 |
| `[미션] 대조 일치 ✔` | `[미션] 대조 일치 ✔ ({n}개 항목 모두 같다)` — 일치 | 356 |
| `[dry-run] 여기서 끝낸다` | `[dry-run] 여기서 끝낸다. arm 하지 않았다.` — 일치 | 797 |
| `[중단] 사용자 중단 (Ctrl+C/SIGTERM)` | 비행 구간에서만: `[중단] 사용자 중단 (Ctrl+C/SIGTERM) — 캡처 OFF`. **연결 · 준비 구간에서 멈추면** 이 줄 없이 `[…] [종료]` 다음 빈 줄, 그리고 타임스탬프 없는 `중단됨 — ★ 기체가 공중에 있다면 즉시 조종기로 개입할 것 ★` | 844, 967, 976 |
| 연결 시간 초과 | `[오류] 30.0초 안에 연결되지 않았다.` (float 그대로 `30.0`) — 단 FC 가 아예 없으면 이 줄에 닿지 않는다(남은 문제 1) | 729 |
| (비상) | `emergency_land.py` 는 FC 없을 때 mavsdk_server 의 C++ 출력이 타임스탬프 없이 섞인다: `Connect error: Connection refused (tcp_client_connection.cpp:102)` · `Connection failed: Socket connection error (connection_initiator.h:47)` | — |
| (모든 실행) | 맨 앞에 `…/mavsdk_guard.py:21: FutureWarning: The 'mavsdk' package has been renamed to 'mavsdk-grpc'. …` 외 4줄 | — |

## 하지 못한 것

| 항목 | 이유 | 다음에 할 사람 |
|---|---|---|
| §3-1 `dry_run=0 confirmed=1 --no-follow` → stop | FC 링크가 없는 것(mode=none)을 확인한 뒤 실행하려 했으나, 이 세션의 권한 확인에서 `dry_run=0` 실행이 거부됐다. stop 동작은 dry_run=1 실행으로 대신 확인했다(§3-1 ③, §6 #3) | 사용자 판단 |
| §3-2 실기체 dry-run, §6 #5 | FC 가 연결돼 있지 않았다 | 기체 전원 · 라우터 켜고 가시화에서 |
| 가시화 화면 확인(세 칩 「선언됨」 · 「비행 시작」 열림) | Pi 에서 볼 수 없다 | 가시화 |

되돌리려면 `sudo ~/drone/flight_runner/deploy/install.sh --uninstall`.
