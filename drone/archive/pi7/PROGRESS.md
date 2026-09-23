# 드론 연동 환경 세팅 — 진행 기록

대상: Raspberry Pi 5 (hostname `pi7`) / Debian 13 trixie
시작: 2026-09-21

## 0단계 — 현재 상태 파악 (완료, 무변경)

2026-09-21 15:15 KST 완료. **시스템 설정·Go1 자산을 일절 변경하지 않았다.**
새로 만든 것은 `~/drone/baseline/`(스냅샷)과 이 파일뿐이다.

### 확인된 핵심 사실
- Go1 자동 실행 = **systemd** (`robot-node`, `robot-relay`, `sensor-node`,
  `detect-bridge`, `go1-camview` + `go1-watchdog.timer`). `go1-sdk.service`는
  **의도적으로 disabled**(기동 시 로봇이 기립하기 때문) — 사람이 수동 시작한다.
- Go1 스택은 **UART를 쓰지 않는다**. 시리얼/pyserial 참조 0건.
- Pi 5 블루투스는 `ttyS0`(내부 전용 UART)에 붙어 있어 GPIO14/15와 무관.
  `disable-bt` / `hciuart` 작업은 **불필요하며 하면 안 된다**.
- 드론용 포트 14540 / 14550 / 5760 — **전부 비어 있음**.
- GPIO14/15(uart0, RP1 serial@30000)는 현재 **device-tree status=disabled**.
  `/dev/serial0`는 지금 **디버그 UART(ttyAMA10)** 를 가리킨다 — FC 포트가 아니다.

### 보고서
전체 조사 결과: **`~/drone/STEP0_REPORT.md`**
기준 스냅샷: `~/drone/baseline/` (대조 방법은 `baseline/README.md`)

### 프롬프트 개정 2 반영 (2026-09-21)
배선이 TELEM2 → **TELEM1**, 읽을 파라미터가 `MAV_1_*` → **`MAV_0_CONFIG`/`MAV_0_MODE`/`SER_TEL1_BAUD`**
로 바뀌었다. TELEM2에는 무선 Air Unit이 붙으므로 건드리지 않는다.
라즈베리파이 쪽 핀은 GPIO14/15로 동일 → **0단계 결론은 그대로 유효**.
3단계 `check_link.py`는 개정 2 기준으로 작성할 것.

### 다음 단계
1단계(UART 설정) 진행을 위해 **사용자 승인 대기 중**.
승인 필요: ① `do_serial_cons 1` + `do_serial_hw 0` 적용 ② 시리얼 콘솔 처리 방식 (완전 제거 vs `ttyAMA10` 고정)

## 1단계 — UART 설정
(미착수 — 승인 대기)
