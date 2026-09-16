# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 문 탐색 미션 클라이언트 (HW-R-05 / HW-R-06)
=============================================================
규약 명령(`scan_mission`)을 **실행 주체**인 `go1_sdk_pc`(C++, 같은 파이에서 상주)로
옮기고, 그 진행(ACK)을 되받아 상위로 돌려주기 위한 얇은 어댑터다.

왜 UDP 한 줄인가
  제어 루프는 500Hz C++ 안에 있고, 파이썬 노드는 통신·보고를 맡는다. 둘 사이는
  이미 있는 UDP 텔레옵 포트(15100)를 그대로 쓴다 — 새 IPC 를 만들 이유가 없고,
  Unity·수동 조작과 같은 입구를 공유해야 "누가 걸었든 같은 미션"이 된다.

  보냄   127.0.0.1:15100  "MISSION SCAN <steps> <step_deg> <forward_m> <vx>"
                          "MISSION FORWARD <m> [vx]" / "MISSION TURN <deg>"
                          "MISSION CONTINUE <step>"  (촬영 뒤 대기 해제)
                          "MISSION CANCEL" / "MISSION PING"
  받음   127.0.0.1:15106  ACK JSON 1건/1단계 (go1_sdk_pc --ack_ip/--ack_port)

ACK 는 스캔 회전 steps 건 + 직진 1건 = steps+1 건이다(forward_m=0 이면 steps 건).
마지막(event="forward")을 받으면 미션이 끝난 것으로 본다.
"""
import json
import socket
import time


class MissionError(RuntimeError):
    """미션을 걸 수 없거나 중간에 끊긴 경우. 상위(노드)가 규약 코드로 번역한다."""


class MissionClient:
    def __init__(self, host="127.0.0.1", cmd_port=15100, ack_port=15106):
        self.host = host
        self.cmd_port = cmd_port
        self.ack_port = ack_port
        self._ack = None
        self._tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._canceled = False

    # ---------- 전제 확인 ----------
    def probe(self, timeout=1.0):
        """(sdk_up, robot_state_ok) 를 돌려준다.

        둘을 갈라 보는 이유: SDK 가 떠 있어도 **로봇이 상태를 안 올려보내면** 회전을
        닫을 각이 없어 미션이 열린 루프가 된다(실측: 로봇 재부팅 후 HighState 가
        전부 0). 수락 전에 둘 다 확인해야 "수락해 놓고 이상하게 도는" 일이 없다."""
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(timeout)
            s.sendto(b"MISSION PING", (self.host, self.cmd_port))
            data, _ = s.recvfrom(64)
            if not data.startswith(b"MISSION PONG"):
                return False, False
            return True, (b"state=ok" in data)
        except OSError:
            return False, False
        finally:
            s.close()

    def sdk_alive(self, timeout=1.0):
        return self.probe(timeout)[0]

    # ---------- 미션 ----------
    def _open_ack(self):
        """ACK 수신 소켓을 **먼저** 연다 — 미션을 건 뒤에 열면 첫 ACK 를 놓친다."""
        self._canceled = False
        self._ack = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._ack.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._ack.bind(("127.0.0.1", self.ack_port))

    def start(self, steps=8, step_deg=45.0, forward_m=1.0, vx=0.0, hold_s=0.0):
        """스캔 미션. forward_m=0 이면 스캔만 하고 전진하지 않는다.

        hold_s>0 이면 촬영 자리(출발 방향 포함 steps 곳)마다 멈춰 `continue_scan(step)` 을
        기다린다. hold_s 는 브리지 쪽 최후 시한이다 — 이 노드가 죽어도 영영 서 있지 않게."""
        self._open_ack()
        msg = "MISSION SCAN %d %g %g %g" % (steps, step_deg, forward_m, vx)
        if hold_s > 0:
            msg += " %g" % hold_s
        self._tx.sendto(msg.encode(), (self.host, self.cmd_port))
        return msg

    def continue_scan(self, step):
        """step 번 촬영 뒤 대기를 푼다. 브리지는 대기 진입 전에 와도 기억해 둔다."""
        self._tx.sendto(b"MISSION CONTINUE %d" % step, (self.host, self.cmd_port))

    @property
    def canceled(self):
        return self._canceled

    def start_forward(self, distance_m, vx=0.0):
        """전진만. 스캔 회전 없이 곧바로 직진한다(ACK 1건)."""
        self._open_ack()
        msg = "MISSION FORWARD %g %g" % (distance_m, vx)
        self._tx.sendto(msg.encode(), (self.host, self.cmd_port))
        return msg

    def start_turn(self, deg):
        """제자리 회전만. **오른쪽(시계)이 +** 다(ACK 1건).

        스캔의 회전과 달리 **되돌아오지 않는다** — 돈 방향에 그대로 선다.
        `scan_mission` 의 회전은 문 탐색 절차의 일부라 마지막에 원위치로 돌아오게
        되어 있어서, "45도만 돌려"를 표현할 수단이 없었다."""
        self._open_ack()
        msg = "MISSION TURN %g" % deg
        self._tx.sendto(msg.encode(), (self.host, self.cmd_port))
        return msg

    def cancel(self):
        self._canceled = True
        self._tx.sendto(b"MISSION CANCEL", (self.host, self.cmd_port))

    def stop_all(self):
        """**진행 중인 모든 구동을 멈춘다.** 상위의 abort 명령이 쓴다.

        미션 취소만으로는 부족하다 — 촬영 도구나 Unity 가 텔레옵을 흘리고 있으면
        로봇은 계속 움직인다. 그래서 세 가지를 순서대로 한다.

          ① MISSION CANCEL   진행 중인 미션 중단
          ② 0속도 estop 프레임  지금 흘러가던 속도 명령을 덮어써 즉시 정지
          ③ MODE 0           SDK 를 외부 명령 모드에서 빼낸다. 이걸 해야 **다른 쪽이
                             계속 보내고 있어도** 그 명령이 무시된다(핵심).

        ※ 이것은 규약 경로의 정지이지 안전 E-stop 이 아니다. E-stop 은 통신과 독립인
          장치 자체 안전장치다(규약 §7). 통신이 끊긴 상황에서는 이 명령이 닿지 않는다."""
        addr = (self.host, self.cmd_port)
        self._canceled = True
        self._tx.sendto(b"MISSION CANCEL", addr)
        for _ in range(5):                     # estop=1 -> SDK 는 mode=1(force stand)
            self._tx.sendto(b"0.000 0.000 0.000 1", addr)
            time.sleep(0.02)
        self._tx.sendto(b"MODE 0", addr)

    def acks(self, expected, timeout_s):
        """ACK 를 오는 대로 흘려보낸다(제너레이터). 마지막 ACK(event="forward") 또는
        expected 건을 채우면 끝난다. 조용히 끊기는 것을 막으려고 전체 시한을 둔다."""
        deadline = time.time() + timeout_s
        got = 0
        while got < expected:
            if self._canceled:
                # 취소되면 ACK 가 더는 오지 않는다. 전체 시한을 다 기다리면 상위의
                # CANCELED 보고가 몇 분 늦어지므로 즉시 끊는다(규약 §5-3).
                raise MissionError("canceled")
            left = deadline - time.time()
            if left <= 0:
                raise MissionError("mission_timeout")
            self._ack.settimeout(min(left, 5.0))
            try:
                data, _ = self._ack.recvfrom(2048)
            except socket.timeout:
                continue
            try:
                ack = json.loads(data.decode("utf-8", "replace"))
            except ValueError:
                continue
            got += 1
            yield ack
            # 종료 ACK 두 가지: 정상 완료(forward)와 중단(aborted). 중단을 여기서
            # 끊지 않으면 더 오지 않을 ACK 를 전체 시한만큼 기다린다.
            if ack.get("event") in ("forward", "aborted"):
                return

    def close(self):
        if self._ack is not None:
            self._ack.close()
            self._ack = None

    # ---------- 시한 산정 ----------
    @staticmethod
    def turn_budget():
        """회전 1건의 시한. go1_sdk_pc 의 회전 상한(15s)과 정지 구간(settle)에
        여유를 더한다. 여기가 짧으면 정상 회전을 실패로 만든다."""
        return 15.0 + 4.0 + 10.0

    @staticmethod
    def budget(steps, step_deg, forward_m, vx=0.15):
        """단계별 최악 시간의 합. go1_sdk_pc 쪽 상한(회전 15s, 직진 거리/vx*4+5s)과
        정지 구간(settle)을 그대로 반영한다. 여기가 짧으면 정상 미션을 실패로 만든다."""
        vx = vx or 0.15
        turn = 15.0 + 4.0                      # 회전 상한 + settle/점멸
        forward = forward_m / vx * 4.0 + 5.0 + 4.0
        return steps * turn + forward + 10.0
