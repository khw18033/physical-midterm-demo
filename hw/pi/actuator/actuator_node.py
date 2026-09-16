"""
피지컬팀 mk2 — 액추에이터 제어노드 (HW-A 계열)
================================================
  HW-A-01  상태 수집 20 Hz — 대기/동작중/동작완료/오류/상태확인불가 5종 구분
  HW-A-02  물리 제어 명령 수신 (수문 개방·폐쇄, 차수벽, 펌프)
  HW-A-03  즉시 ACK. 수행 불가 시 거부 사유 반환
  HW-A-04  ACK와 실제 물리 동작 완료를 구분. 동작 중 20Hz 진행 보고 + 완료·실패 즉시
  HW-A-05  통신 두절·오류 시 신규 원격 제어 차단 + 안전 상태 유지.
           복구 후 **실제 상태를 먼저 재확인한 뒤** 제어 재개

이 노드의 두 가지 원칙

1) **ACK 는 "받았다"이지 "했다"가 아니다.**
   수문·펌프는 되돌리기 어렵다. 확정 근거는 ACK 가 아니라 피드백으로 확인한
   `state_changed` 다(BE-X-03). 4단계를 끝까지 보내야 관제가 "명령은 갔는데 실제로
   움직였는지 모르는" 상태에 빠지지 않는다.

2) **모르는 것은 모른다고 말한다.**
   피드백이 끊기면 위치를 `unknown` 으로 보고하고 제어를 잠근다. "닫혀 있다"와
   "닫혔는지 모른다"를 뭉치면 시스템이 열린 수문을 닫힘으로 오인한다.

실행: python3 -m actuator.actuator_node   (pi/ 디렉터리에서)
"""
import time

from actuator import actuator_link
from actuator.actuator_link import DONE, ERROR, IDLE, MOVING, UNKNOWN
from common import config, node, schema
from common.base_actions import BASE_ACTIONS
from common.physical_command import CommandError
from common.node import BaseNode
from common.schema import envelope
from common.spool import CONTINUOUS, EVENT

# 사전에 정의된 물리 제어 어휘 (HW-A-02). 여기 없는 것은 받지 않는다 —
# 임의 문자열을 구동부로 흘리면 되돌리기 어려운 사고가 난다.
DEVICES = {
    "gate":    ("open", "close"),      # 수문
    "barrier": ("up", "down"),         # 차수벽
    "pump":    ("on", "off"),          # 펌프
}


class ActuatorNode(BaseNode):
    ENTITY_TYPE = "actuator"

    def __init__(self):
        self.link = actuator_link.create(config.ACTUATOR_LINK)
        self.state = None
        self.prev_state = None
        self.last_pub = 0.0
        # HW-A-05 안전 잠금
        self.locked = False
        self.lock_reason = None
        self.disconnected_since = None
        super().__init__()

    # ================= 수집·보고 (HW-A-01 / HW-A-04) =================
    def sample_interval(self):
        return config.ACTUATOR_SAMPLE_INTERVAL

    def report_interval(self):
        """동작 중에는 20Hz 로 진행을 보고하고(HW-A-04), 대기 중에는 저주기로 낮춘다.
        가만히 있는 수문을 초당 20번 보고할 이유가 없다."""
        moving = self.state is not None and self.state.state == MOVING
        return (config.ACTUATOR_REPORT_INTERVAL_MOVING if moving
                else config.ACTUATOR_REPORT_INTERVAL_IDLE)

    def next_wakeup(self):
        return self.last_pub + self.report_interval()

    def on_tick(self, now):
        if self.state is None:
            return
        if now - self.last_pub >= self.report_interval():
            kind = CONTINUOUS if self.state.state == MOVING else EVENT
            self._publish_state(now, "progress" if self.state.state == MOVING
                                else "periodic", kind, qos=1)
            self.last_pub = now

    def on_sample(self, now):
        try:
            self.state = self.link.read_state()
        except Exception as e:
            print(f"[액추에이터 링크 오류] {type(e).__name__}: {e}")
            return
        self._check_lock(now)
        self._check_transitions(now)

    def _publish_state(self, now, reason, kind, qos):
        s = self.state
        payload = envelope(self.identity, seq=self.seq)
        payload.update({
            "channel": "state",
            "reason": reason,
            "actuator_state": s.state,        # HW-A-01 5종
            "position": s.position,
            "progress": s.progress,
            "feedback_ok": s.feedback_ok,
            "control_locked": self.locked,    # VZ-O-05: 제어 UI 잠금 표시 근거
            "lock_reason": self.lock_reason,
            "device_status": self.device_status(),
        })
        if s.detail:
            payload["detail"] = s.detail
        self.publish(f"{self.base}/state", payload, qos=qos, kind=kind)
        self.seq += 1

    def _check_transitions(self, now):
        """상태 전이는 이산 사건이다. 주기를 기다리지 않고 즉시 보고한다 —
        '완료·실패 판정 시 즉시 최종 보고'가 HW-A-04 의 요구다."""
        cur = self.state.state
        if self.prev_state is None:
            self.prev_state = cur
            return
        if cur != self.prev_state:
            print(f"[액추에이터] {self.prev_state} → {cur} ({self.state.position})")
            self.prev_state = cur
            self._publish_state(now, f"state_{cur}", EVENT, qos=1)
            self.last_pub = now

    # ================= 안전 잠금 (HW-A-05) =================
    def _check_lock(self, now):
        """통신 두절·피드백 상실 시 원격 제어를 잠그고 안전 상태를 유지한다.
        **복구만으로 풀지 않는다** — 두절 중 물리 상태가 바뀌었을 수 있으므로
        실제 상태를 먼저 읽어 내부 모델과 맞춘 뒤에 푼다."""
        # --- 잠금 조건 ---
        if not self.connected:
            if self.disconnected_since is None:
                self.disconnected_since = now
            elif not self.locked and now - self.disconnected_since >= config.ACTUATOR_LOCK_AFTER_S:
                self._lock("comm_loss")
                self.link.safe_state()       # 사전 정의된 안전 상태로
            return                            # 두절 중에는 해제 판정을 하지 않는다
        self.disconnected_since = None

        if not self.locked:
            if self.state.state == UNKNOWN:
                self._lock("feedback_lost")
            elif self.state.state == ERROR:
                self._lock("device_error")
            return

        # --- 해제 조건: 사유가 무엇이었든 동일하다 ---
        # 통신이 돌아왔다는 것만으로는 풀지 않는다. 두절·피드백 상실 중에 물리 상태가
        # 바뀌었을 수 있으므로, **실제 상태를 다시 읽어 확정적인 값이 나올 때만** 푼다.
        self._try_resync()

    def _lock(self, reason):
        self.locked = True
        self.lock_reason = reason
        print(f"[안전 잠금] 원격 제어 차단 — 사유 {reason}")
        self.publish_status("summary")       # 잠금은 즉시 알린다(VZ-O-05)

    def _try_resync(self):
        """복구 후 재동기화. 피드백이 살아 있고 상태가 확정적(대기·완료)이어야 푼다.
        moving·unknown·error 인 동안에는 계속 잠긴 채로 둔다."""
        s = self.state
        if s.feedback_ok and s.state in (IDLE, DONE):
            self.locked = False
            self.lock_reason = None
            print(f"[안전 잠금 해제] 실제 상태 재확인 완료 — position={s.position}")
            self.publish_status("summary")

    # ================= 공통 코어 훅 =================
    def device_status_extra(self):
        if self.state is None:
            return schema.STATUS_DEGRADED
        if self.state.state == ERROR or not self.state.feedback_ok:
            return schema.STATUS_FAULT
        if self.locked:
            return schema.STATUS_DEGRADED
        return None

    def status_extra(self):
        d = {"control_locked": self.locked, "lock_reason": self.lock_reason}
        if self.state:
            d.update({"actuator_state": self.state.state,
                      "position": self.state.position,
                      "feedback_ok": self.state.feedback_ok})
        return d

    # ================= 명령 어휘 (HW-A-02 / A-03 / A-04) =================
    def _guard(self, device, target):
        """HW-A-03: 수행할 수 없으면 즉시 거부 사유를 돌려준다."""
        if self.locked:
            raise CommandError("FAILED_PRECONDITION", f"control_locked:{self.lock_reason}")
        if device not in DEVICES:
            raise CommandError("INVALID_ARGUMENT", "unknown_device")
        if target not in DEVICES[device]:
            raise CommandError("INVALID_ARGUMENT", "invalid_target")
        if self.state is None or not self.state.feedback_ok:
            raise CommandError("FAILED_PRECONDITION", "feedback_unavailable")
        if self.state.state == MOVING:
            raise CommandError("FAILED_PRECONDITION", "busy")

    def validate(self, action, params):
        """ACK 전에 막는다. 수문·펌프는 되돌리기 어려워서, 받아 놓고 나중에 실패를
        알리는 것과 처음부터 거부하는 것의 차이가 크다(HW-A-03)."""
        if action == "actuate":
            self._guard(params.get("device"), params.get("target"))

    def _act_actuate(self, params):
        device = params.get("device")
        target = params.get("target")

        yield "executing", {"device": device, "target": target}
        self.link.command(device, target)

        # HW-A-04: ACK 가 아니라 **피드백으로 확인한 물리 도달**이 확정 근거다.
        deadline = time.time() + config.ACTUATOR_TIMEOUT_S
        while time.time() < deadline:
            s = self.state
            if s is None:
                time.sleep(0.05)
                continue
            if s.state == DONE and s.position == target:
                yield "state_changed", {"device": device, "position": s.position}
                yield "completed", {"device": device, "position": s.position}
                return
            if s.state == ERROR:
                raise CommandError("INTERNAL", f"device_error:{s.detail}")
            if s.state == UNKNOWN:
                raise CommandError("INTERNAL", "feedback_lost_during_motion")
            time.sleep(0.05)
        # 시간 안에 도달하지 못했다. 도달했는지 모르는 상태이므로 완료로 처리하지 않는다.
        raise CommandError("DEADLINE_EXCEEDED", "travel_timeout")

    def _act_safe_state(self, params):
        """관제·자동 판정이 강제로 안전 상태를 요구할 때. 잠금 중에도 허용한다 —
        안전 상태로 가는 것은 위험을 늘리지 않는다."""
        yield "executing", None
        self.link.safe_state()
        deadline = time.time() + config.ACTUATOR_TIMEOUT_S
        while time.time() < deadline:
            if self.state and self.state.state == DONE:
                yield "state_changed", {"position": self.state.position}
                yield "completed", {"position": self.state.position}
                return
            time.sleep(0.05)
        raise CommandError("DEADLINE_EXCEEDED", "safe_state_timeout")

    def _act_unlock(self, params):
        """잠금 해제는 자동 재동기화가 원칙이고, 이건 수동 개입 경로다.
        실제 상태가 확정적이지 않으면 거부한다 — 사람이 눌렀다고 위험이 사라지지 않는다."""
        yield "executing", None
        if not self.locked:
            yield "completed", {"locked": False}
            return
        self._try_resync()
        if self.locked:
            raise CommandError("INTERNAL", f"resync_failed:{self.state.state if self.state else 'no_state'}")
        yield "completed", {"locked": False, "position": self.state.position}

    ACTIONS = dict(BASE_ACTIONS, **{
        "actuate": _act_actuate,
        "safe_state": _act_safe_state,
        "unlock": _act_unlock,
    })
    PHYSICAL_ACTIONS = frozenset({"actuate", "safe_state"})


if __name__ == "__main__":
    node.main(ActuatorNode)
