"""
피지컬팀 mk2 — 센서노드 (HW-S 계열)
=====================================
공통 코어(BaseNode)를 상속하고 센서 고유의 계측·보고 정책만 구현한다.

  HW-S-01  계측값 수집 — 센서 최대 속도로 상시 수집. 취사선택은 말단이 담당
  HW-S-02  평시 저주기 보고 + 임계 초과·해제·급변 즉시 발행 (report-by-exception)
  HW-S-03  이벤트 모드 1 Hz 고주기 보고
  HW-S-04  적응형 주기 전환 명령 수신 (엣지 원격 오버라이드)
  HW-S-05  하트비트 1 Hz (공통 코어)

주기 전환 3층 (SDD 4.2)
  1순위  로컬 자율 — 임계·급변을 스스로 판정해 즉시 전환. 브로커·엣지가 죽어도 동작
  2순위  MQTT 명령 — 엣지 오버라이드. mode_source="command" 인 동안 자율 전환을 억제
  3순위  K3s 배포 — 증강 기능(AI·영상 분석)의 기동/종료. 주기 전환의 실체가 아니다

가짜 센서: read_sensor() — 평시 2.5m 평균회귀 잔물결, HW_RAIN_FLAG 파일이 존재하면
  강우 모드로 상승. 실센서 입고 시 **이 함수 내부만** 교체한다 (HW-S-01).

실행: python3 -m sensor.sensor_node   (pi/ 디렉터리에서)
"""
import os
import random
import time
from collections import deque

from common import config, node
from common.base_actions import BASE_ACTIONS
from common.physical_command import CommandError
from common.node import BaseNode
from common.schema import envelope
from common.spool import CONTINUOUS, EVENT

# ---------- 가짜 센서 (실센서 입고 시 이 함수만 교체 — HW-S-01) ----------
_level = 2.5


def read_sensor():
    global _level
    if os.path.exists(config.RAIN_FLAG):                      # 강우 스위치 ON
        _level += random.uniform(0.05, 0.15)                  # 빠르게 상승
    else:
        _level += (2.5 - _level) * 0.05 + random.uniform(-0.02, 0.02)
    return round(_level, 3)


class SensorNode(BaseNode):
    ENTITY_TYPE = "sensor"

    def __init__(self):
        # 보고 주기 상태 (HW-S-03 / HW-S-04)
        self.mode = "normal"
        self.mode_source = "auto"      # auto | command — 명령 지정이 자율 전환보다 우선
        self.report_interval = config.REPORT_INTERVAL_NORMAL
        # 계측 판정 상태 (HW-S-02)
        self.alert = False
        self.samples = deque()         # 급변 판정용 (t, value) 창
        self.last_rapid = 0.0
        self.last_report = 0.0
        self.sensor_fail = 0
        self.last_value = None
        super().__init__()

    # ================= 계측·보고 (HW-S-01 / HW-S-02) =================
    def on_sample(self, now):
        try:
            value = read_sensor()
            self.sensor_fail = 0
        except Exception as e:
            self.sensor_fail += 1
            print(f"[센서 오류 {self.sensor_fail}회] {type(e).__name__}: {e}")
            return
        self.last_value = value

        self.samples.append((now, value))
        while self.samples and now - self.samples[0][0] > config.RAPID_WINDOW_S:
            self.samples.popleft()

        crossed_up = (not self.alert) and value >= config.THRESHOLD
        crossed_down = self.alert and value < config.THRESHOLD - config.HYST
        rapid = self._detect_rapid(now, value)
        periodic = now - self.last_report >= self.report_interval

        reason = ("threshold_exceeded" if crossed_up else
                  "threshold_cleared" if crossed_down else
                  "rapid_change" if rapid else
                  "periodic" if periodic else None)
        if reason is None:
            return                       # 수집은 매 주기, 발행은 사건이 있을 때만

        if crossed_up:
            self.alert = True
            self.auto_mode("event")      # HW-S-03: 사건이면 스스로 고주기로
        if crossed_down:
            self.alert = False
            self.auto_mode("normal")
        if rapid:
            self.last_rapid = now

        # 임계·급변은 이산 사건이라 두절 후에도 전량 재전송해야 한다. 평시 표본은
        # 연속값이라 복구 시 다운샘플 대상이다 (SDD 5.4).
        kind = CONTINUOUS if reason == "periodic" else EVENT
        payload = envelope(self.identity, seq=self.seq)
        payload.update({
            "channel": "state",
            "water_level_m": value,
            "unit": "m",
            "alert": self.alert,
            "reason": reason,
            "mode": self.mode,
            "device_status": self.device_status(),
        })
        ok = self.publish(f"{self.base}/state", payload, qos=1, kind=kind)
        print(f"state {value}m ({reason}, {self.mode})" + ("" if ok else " → 버퍼 적재"))
        self.seq += 1
        self.last_report = now

    def _detect_rapid(self, now, value):
        """HW-S-02 '급변 시 즉시 발행'. 인접 두 샘플을 비교하면 잔물결도 급변으로
        보이므로 창(기본 10초) 양끝의 차이로 본다. 상승이 계속되는 동안 매초
        알리지 않도록 급변 보고 자체에 최소 간격을 둔다."""
        if now - self.last_rapid < config.RAPID_MIN_GAP_S:
            return False
        if not self.samples:
            return False
        t0, v0 = self.samples[0]
        if now - t0 < config.RAPID_WINDOW_S * 0.5:
            return False                 # 창이 덜 찼으면 판단 보류
        return abs(value - v0) >= config.RAPID_DELTA_M

    # ================= 주기 전환 (HW-S-03 / HW-S-04) =================
    def auto_mode(self, mode):
        """1순위 경로. 엣지가 명령으로 주기를 지정해 둔 상태면 건드리지 않는다 —
        말단이 임의로 되돌리면 HW-S-04가 노리는 구역 단위 일관성이 깨진다."""
        if self.mode_source == "command":
            return
        self.set_mode(mode, "auto")

    def set_mode(self, mode, source, interval=None):
        self.mode = mode
        self.mode_source = source
        self.report_interval = interval if interval is not None else (
            config.REPORT_INTERVAL_EVENT if mode == "event" else config.REPORT_INTERVAL_NORMAL)
        print(f"[모드] {mode} / 보고주기 {self.report_interval}s ({source})")
        self.last_report = 0.0            # 전환 직후 한 번 즉시 보고
        self.publish_status("summary")    # 상태 변화는 주기를 기다리지 않고 즉시(BE-T-04)

    # ================= 공통 코어 훅 =================
    def device_status_extra(self):
        from common import schema
        return schema.STATUS_FAULT if self.sensor_fail >= 3 else None

    def status_extra(self):
        return {"mode": self.mode, "mode_source": self.mode_source,
                "report_interval_s": self.report_interval, "alert": self.alert,
                "last_value": self.last_value}

    # ================= 명령 어휘 (HW-S-04) =================
    def _act_set_mode(self, params):
        mode = params.get("mode")
        if mode not in ("normal", "event", "auto"):
            raise CommandError("INVALID_ARGUMENT", "invalid_mode")
        yield "executing", {"mode": mode}
        if mode == "auto":
            self.set_mode("event" if self.alert else "normal", "auto")
        else:
            self.set_mode(mode, "command")
        yield "completed", {"mode": self.mode, "report_interval_s": self.report_interval}

    def _act_set_report_interval(self, params):
        try:
            sec = float(params.get("seconds"))
        except (TypeError, ValueError):
            raise CommandError("INVALID_ARGUMENT", "invalid_seconds")
        if not 0.1 <= sec <= 3600:
            raise CommandError("OUT_OF_RANGE", "out_of_range")
        yield "executing", {"seconds": sec}
        self.set_mode("custom", "command", interval=sec)
        yield "completed", {"report_interval_s": sec}

    def _act_levee(self, params):
        """수문 개폐 — 액추에이터 자리표시자(HW-A-02~04). 액추에이터 제어노드 실물이
        확보되면 actuator/ 로 옮긴다. 되돌리기 어려운 명령이라 ACK가 아니라 물리
        상태 변화(state_changed)로 확정을 표시해야 한다(BE-X-03)."""
        pos = params.get("position")
        if pos not in ("open", "close"):
            raise CommandError("INVALID_ARGUMENT", "invalid_position")
        yield "executing", {"position": pos}
        time.sleep(2)                                  # 구동 시간 (HW-A-04 진행 보고 자리)
        yield "state_changed", {"position": pos}
        yield "completed", {"position": pos}

    ACTIONS = dict(BASE_ACTIONS, **{
        "set_mode": _act_set_mode,
        "set_report_interval": _act_set_report_interval,
        "levee": _act_levee,
    })
    PHYSICAL_ACTIONS = frozenset({"levee"})


if __name__ == "__main__":
    node.main(SensorNode)
