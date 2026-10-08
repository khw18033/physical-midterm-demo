# 남은 mavsdk_server 에 붙어 비행 → 18m 에서 명령 통로 상실 — 2026-10-08 13:18

- 스크립트: `drone/scripts/test_sar_rtk.py` (좌우, 고도 18m, 85m, 4m/s)
- 로그: `/home/physical/cansar_logs/test_sar_rtk_20261008_131746.log`
- 기체 영향: **이륙 후 18m 에서 HOLD 로 떠 있었다.** 스크립트의 rtl 도 실패했다. 13:2x 에 별도 연결로 LAND 를 보내 착륙·disarm 확인.
- 앞선 기록 [REPORT_mavsdk_port_conflict_261008.md](REPORT_mavsdk_port_conflict_261008.md)(11:39)와 **같은 원인**이다. 이번에는 서버가 늦게 죽어 비행 중에 끊겼다.

## 결론

1. 13:07 `test_sar_rtk`(5m 시험)가 정상 착륙하고 `[종료]` 를 찍은 뒤 **프로세스가 끝나지 않았다.**
   그 mavsdk_server 가 UDP 14540·gRPC 50051 을 쥐고 기체와 연결된 채 남았다.
2. 그 SSH 창(session 7)이 끊겼지만(`client_loop: send disconnect`) sshd 가 알아채기 전이라 세션은 살아 있었다.
3. 13:17:46 새 실행의 mavsdk_server 는 `bind error` 로 죽었고, 스크립트는 **session 7 의 서버(50051)에 붙어** arm·takeoff 까지 했다.
4. **13:18:35.634** sshd 가 session 7 을 정리 → 그 서버가 죽음 → 같은 시각 `Socket closed`.
   rtl 도 같은 gRPC 로 보내므로 `Connection refused` 로 실패 → 기체는 마지막 모드(HOLD)로 정지.

| 근거 | 값 |
|---|---|
| `systemd-logind: Session 7 logged out` | 13:18:35.634 |
| 로그 `속도 설정 실패 … Socket closed` | 1791433115.634 = 13:18:35.634 |
| `[연결] 완료` 까지 | 18 ms (새 서버를 띄우면 약 1초 — 기존 서버에 붙었다는 뜻) |

## 왜 `[종료]` 뒤에 안 끝났나 (재현됨)

MAVSDK-Python 3.17.4 `mavsdk/system.py`:

- mavsdk_server stdout 을 읽는 `_LoggingThread` 가 **non-daemon** — 서버가 죽어 EOF 가 와야 끝난다.
- 서버는 **`atexit`** 에서만 kill 한다.
- 파이썬 종료 순서는 non-daemon 스레드 join → atexit. **서로 기다리며 멈춘다.**

수정 전 `--dry-run` 재현: `[종료]` 후 40초 넘게 python·mavsdk_server 가 살아 있었고 `timeout` 으로만 끝났다(exit 124).
사용자 화면의 `^C … threading._shutdown KeyboardInterrupt` 도 이 상태다.

## 수정 — `drone/scripts/mavsdk_guard.py` (4개 스크립트 공용)

`sar_test.py` · `sar_test_rtk.py` · `test_sar.py` · `test_sar_rtk.py` 가 쓴다.

| 구멍 | 대책 |
|---|---|
| 남의 서버에 붙음 | `guard.connect()` — 연결 전 UDP 14540·TCP 50051 bind 시험, 쓰이고 있으면 **연결하지 않고 중단**하며 잡은 프로세스(PID)를 로그에 남김. 연결 뒤 내 서버가 0.5초 안에 죽었으면 역시 중단 |
| `[종료]` 뒤 멈춤 | `run()` 의 `finally` 에서 `guard.stop()` 으로 서버를 직접 kill → 로그 스레드가 끝나고 프로세스 정상 종료 |
| 통로가 죽으면 rtl 도 실패 | `guard.abort()` — 5초 안에 실패하면 내 서버를 내리고 **새 mavsdk_server(빈 gRPC 포트)로 재연결**해 한 번 더 보냄 |

### 검증 (기체 지상·disarm 상태)

| 시험 | 결과 |
|---|---|
| 4개 스크립트 `--dry-run` | 모두 `[종료]` 직후 exit 0, 남은 서버 없음 |
| 서버를 먼저 띄워 두고 `test_sar_rtk --dry-run` | 연결 전에 중단, `mavsdk_server pid=…` 출력, exit 1 |
| 연결 후 서버 강제 종료 → `guard.abort(hold)` | 1차 `Connection refused`(사고와 같은 오류) → 새 연결로 2.1초 뒤 전송 성공 |

## 운용 수칙

- 실행 전 `pgrep -a mavsdk_server` 가 비어 있어야 한다(스크립트가 이제 직접 막지만 습관으로).
- **비행 스크립트는 SSH 끊김에 약하다.** 비행 중 SSH 가 끊기면 스크립트는 sshd 가 세션을 정리할 때(이번엔 수 분 뒤) 죽고, 기체는 그 시점 모드로 남는다.
  `tmux`(미설치: `sudo apt install tmux`) 안에서 실행하면 SSH 가 끊겨도 스크립트가 계속 돌고 다시 붙을 수 있다.
- 명령 통로가 완전히 죽은 경우를 대비해 **조종기는 항상 손에** — 새 연결 재시도도 실패할 수 있다.

## 후속: test_sar_rtk.py 미션 방식 전환 (같은 날)

명령 통로가 죽어도 기체가 공중에 남지 않도록 `test_sar_rtk.py` 를 goto 방식에서 **미션 방식**으로 바꿨다.

- 이륙~왕복~착륙 전체를 MISSION_ITEM_INT 로 FC 에 올리고 **내려받아 한 항목씩 대조**한 뒤에만 arm·시작한다.
  비행 중 Pi·SSH·mavsdk_server 가 죽어도 FC 가 끝까지 날고 L 에 착륙한다.
- Pi 는 캡처(CAP 파일)·패스 전 RTK 확인(모자라면 미션 일시정지)·착륙 확인만 한다.
  Pi 쪽 예외로는 abort 하지 않는다(미션을 그대로 두는 편이 안전). Ctrl+C·시간 초과·RTK 대기 초과만 `--abort`.
- 시작 전 왕복(회전) 횟수를 묻는다(1~10).
- PX4 1.16 소스로 확인한 것: waypoint param4 헤딩은 ROI 가 없으면 그대로 쓰인다(MPC_YAW_MODE=0 이어도 기수 고정),
  재개 시 순항 속도가 초기화되므로 waypoint 마다 DO_CHANGE_SPEED 를 둔다, 미션 이륙 고도는 MIS_TAKEOFF_ALT 가 아니라 항목 z.
- 검증: 지상 `--dry-run` 3종(좌우 3회·전후 1회·회전 2회) 업로드·대조 일치·삭제, 감시 로직 모의 비행(캡처 ON/OFF·RTK 일시정지/재개·착륙 판정).
  **실비행 미검증** — 5m·저속으로 먼저 확인할 것(특히 좌우 비행 중 기수 고정, 패스 SUMMARY 의 yaw-err).
- goto 방식 원본은 git 이력(399598a)에 있다.
