# MAVSDK 포트 충돌로 test_sar.py 시작 실패 — 2026-10-08

- 발생: 2026-10-08 11:39:49 KST (pi3, 이전 부팅 `35a4b388…`)
- 스크립트: `drone/scripts/test_sar.py` (회전 패턴, 고도 5m)
- 로그: `/home/physical/cansar_logs/test_sar_20261008_113949.log`
- 기체 영향: **없음** — arm 전(위치 추정 대기 중)에 종료됐다.

## 결론

UDP **14540**(mavlink-router `local_ctrl` → MAVSDK 제어 코드 자리)을 **이미 다른 mavsdk_server가 잡고 있었다.**
새로 띄운 mavsdk_server는 bind에 실패해 죽었고, 스크립트는 기존 서버의 gRPC 50051에 붙었다가
그 서버가 4초 뒤 사라지면서 `Socket closed` 로 끝났다.
어느 프로세스였는지는 **확정하지 못했다** — 11:42에 Pi 전원이 꺼졌다 켜져 이전 부팅의 프로세스 목록이 남아 있지 않다.

## 증상

```
[1791427189.375] [연결] udpin://0.0.0.0:14540 ...
[1791427189.391] [연결] 완료
bind error: Address in use (udp_connection.cpp:93)
Connection failed: Bind error (connection_initiator.h:47)
[1791427189.866] [확인] 위치 추정 대기 (최대 60.0초)...
[1791427193.908] [종료]
...
grpc.aio._call.AioRpcError: status = StatusCode.UNAVAILABLE
        details = "Stream removed (Socket closed)"
```

## 근거

| 실행 | 시작 | 끝 | 연결까지 | 결과 |
|---|---|---|---:|---|
| `sar_test_rtk --dry-run` | 11:39:12 | 11:39:23 | 1.08 s | 정상 |
| `sar_test_rtk --dry-run` | 11:39:31 | 11:39:44 | 1.00 s | 정상 |
| **`test_sar` (회전)** | **11:39:49** | **11:39:53** | **0.016 s** | **bind error → Socket closed** |

- **연결 16 ms** — mavsdk_server를 새로 띄우면 약 1초가 걸린다. 16 ms면 이미 떠 있던 gRPC 서버(50051)에 붙은 것이다.
- `bind error: Address in use` — 이 실행이 띄운 mavsdk_server가 UDP 14540을 열지 못했다. 이 포트는 mavlink-router가 **보내는** 쪽(`Mode = Normal`, UDP Client)이라 router가 bind하지 않는다. 즉 14540을 bind하는 것은 MAVSDK 제어 스크립트뿐이다.
- 4초 뒤 `Stream removed (Socket closed)` — 붙어 있던 기존 서버가 종료됐다.

### 기존 서버 후보 (미확정)

MAVSDK-Python(`mavsdk/system.py`)은 mavsdk_server를 자식 프로세스로 띄우고 **`atexit` 에서만** kill 한다.
그래서 아래 경우에는 서버가 남는다.

1. 다른 SSH 창에서 MAVSDK 스크립트가 아직 실행 중이었다.
2. SSH 끊김(SIGHUP)·`kill -9` 등으로 스크립트가 죽어 `atexit` 가 돌지 않았고, mavsdk_server만 고아로 남았다.

정상 종료(`[종료]` 로그 후 exit)라면 SIGKILL로 즉시 정리되므로 11:39:44 dry-run의 서버가 5초 뒤까지 남았을 가능성은 낮다.

## 같은 시간대의 다른 기록

- **11:40:47 `[드론] arm 상태 → ARMED`** (drone-agent) — test_sar.py는 11:39:53에 이미 끝났으므로 스크립트가 arm한 것이 아니다. QGC·조종기로 arm했는지 확인 필요.
- 11:42:15 이전 부팅 로그가 끊김 → 11:41:42(보정 전 시각) 새 부팅. 11:44:04 NTP 보정으로 시계가 2분 3초 앞으로 점프.
  (로그 시각이 부팅 사이에서 겹쳐 보이는 것은 이 때문이다.)
- 재부팅 후 11:44 확인 시 14540·50051 을 잡은 프로세스 없음.

## 대처

실행 전에 확인하고, 남아 있으면 정리한 뒤 실행한다.

```bash
ss -ulpn | grep 14540        # 비어 있어야 한다
pgrep -a mavsdk_server       # 비어 있어야 한다
pkill mavsdk_server          # 남아 있으면 (다른 창에서 비행 중인 스크립트가 없는지 먼저 확인!)
```

⚠ 기존 서버에 붙은 채로 진행되면 **다른 스크립트의 연결로 기체에 명령을 보내게 된다.** 이번에는 서버가 바로 죽어 위치 확인 단계에서 끝났다.

## 남은 일 (제안, 미적용)

- `test_sar.py` · `test_sar_rtk.py` · `sar_test.py` · `sar_test_rtk.py` 시작 시 UDP 14540 또는 TCP 50051 이 이미 쓰이고 있으면
  **연결하지 않고 중단**하고, 잡고 있는 프로세스(PID·명령)를 출력한다.
