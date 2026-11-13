"""
피지컬팀 mk2 — X500 v2 드론 온보드 노드 (pi3)
==================================================
공통 코어(`common/node.py` BaseNode)를 **무수정으로** 상속하고 드론 고유의 수집·보고만
채운다. 브로커 접속·clientId·LWT·Capability 발행·명령 멱등·미선언 거부·재접속·버퍼는
전부 공통 층이 이미 한다.

  실행: python3 -m drone.drone_node      (pi/ 디렉터리에서)

## 이 노드가 하는 일과 하지 않는 일

| 한다 | 하지 않는다 |
|---|---|
| FC 스트림을 구독해 연결·배터리·상태를 1Hz 로 발행 | FC 로 송신 (0바이트) |
| `ping` 하나만 Capability 에 선언 | arm·takeoff·land·모드변경·파라미터·스트림 요청 |
| FC 가 없어도 계속 돌며 "FC 링크 없음"을 보고 | 마지막 값을 현재값처럼 재사용 |

**`ACTIONS` 를 `BASE_ACTIONS` 로 시작하지 않는다.** 공통 어휘에는 `diag` 가 같이 들어
있는데, 이번 규칙은 "선언하는 action 은 `ping` 하나"다. 그래서 여기서 어휘를 직접
정의한다 — 공통 파일은 건드리지 않는다. 미선언 action(`arm` 등)은 규약 서버가
`UNIMPLEMENTED` 로 **실행 로직에 닿기 전에** 거부한다.

## 왜 RobotNode 를 상속하지 않는가

`RobotNode` 는 `go1_mission`·`media`·`controller_link` 에 묶여 있고, 그 `RobotState`
(battery_pct·x·y·heading_deg·speed_mps·mode)에는 전압·GPS fix·arm 여부·비행 모드를
담을 칸이 없다. `BaseNode` 를 직접 상속하면 공통 생애주기는 전부 재사용하면서 드론
필드는 자유롭게 싣는다. 공통 틀 수정이 한 줄도 필요 없다.

## 상태 보고 주기와 버퍼 정책

  주기 발행(1Hz)   QoS 1, **버퍼에 넣지 않는다**(allow_spool=False)
  이산 사건        QoS 1, 버퍼 대상 — 링크 전환·arm 전환·모드 전환·배터리 경보

주기 상태는 "지금"의 값이다. 두절 중 쌓아 뒀다 나중에 보내면 낡은 상태가 현재처럼
보인다(공통 층이 `status` 를 버퍼에서 빼는 것과 같은 이유). 반대로 이산 사건은 빠지면
인과가 끊기므로 전량 재전송한다.

## 카메라 프레임 동기 (2026-10-01)

카메라(drone_rpi/agent.py, 8fps)가 프레임마다 루프백 UDP로 `captured_at` 을 알려 준다.
그걸 받을 때마다 스냅샷을 새로 떠서 상태를 발행하고 **`ts` 에 그 `captured_at` 을
그대로 싣는다** — 드론 상태와 이미지가 같은 주기·같은 시각 기준을 가져 프레임 단위로
짝지을 수 있다. 신호가 `FRAME_TIMEOUT` 동안 끊기면(카메라 정지) 위 1Hz 주기 발행으로
돌아가고 `ts` 는 null 이다 — 이미지가 없는데 이미지 시각을 지어내지 않는다.
"""
import json
import os
import socket
import threading
import time

from common import node, schema
from common.node import BaseNode
from common.schema import envelope
from common.spool import EVENT
from drone.drone_link import DroneLink


def _f(name, default):
    try:
        return float(os.environ.get(f"HW_DRONE_{name}", default))
    except (TypeError, ValueError):
        return float(default)


STATE_INTERVAL = _f("STATE_INTERVAL", 1.0)      # 요구 1~2Hz
SAMPLE_INTERVAL = _f("SAMPLE_INTERVAL", 0.2)    # 이산 사건 감지 주기
BATTERY_WARN = _f("BATTERY_WARN", 20.0)         # % — 이산 경보 임계
FRAME_SYNC_PORT = int(_f("FRAME_SYNC_PORT", 14600))  # 0 이면 프레임 동기 끔
FRAME_TIMEOUT = _f("FRAME_TIMEOUT", 2.0)        # 이만큼 프레임이 없으면 1Hz 로 복귀


def act_ping(node_, params):
    """Go1 과 같은 형식(`uptime_s`) + FC 링크 유무.

    규약 `CommandResult.result` 는 `map<string,double>` 라 문자열도 null 도 못 싣는다.
    그래서 링크는 1.0/0.0 으로, **모르는 값은 키를 아예 넣지 않는다**(0 을 넣으면
    "쟀더니 0" 과 구별되지 않는다)."""
    yield "executing", None
    link = node_.link.fc_link()
    out = {"uptime_s": round(time.time() - node_.started, 1),
           "fc_link": 1.0 if link else 0.0}
    age = node_.link.hb_age()
    if age is not None:
        out["fc_link_age_s"] = round(age, 2)
    yield "completed", out


class DroneNode(BaseNode):
    ENTITY_TYPE = "drone"                 # 토픽 2번째 칸 → zoneA/drone/x500-001/...
    ACTIONS = {"ping": act_ping}          # 선언은 ping 하나뿐 (규칙 2)
    PHYSICAL_ACTIONS = frozenset()        # 물리 동작 없음

    def __init__(self):
        self.link = DroneLink()
        self.snap = None
        self.last_state_pub = 0.0
        self.prev_fc_link = None
        self.prev_armed = None
        self.prev_mode = None
        self.battery_warned = False
        # 프레임 수신 스레드와 메인 루프가 둘 다 발행한다 — seq 가 꼬이지 않게 묶는다.
        self._pub_lock = threading.Lock()
        self.last_frame_at = 0.0          # 마지막 프레임 신호를 받은 시각(수신 측 시계)
        self.frames_in = 0
        super().__init__()
        self._register_metrics()
        if FRAME_SYNC_PORT:
            threading.Thread(target=self._frame_sync_loop, daemon=True).start()

    # ================= 관측 지표 =================
    def _register_metrics(self):
        """모르면 None 을 돌려준다 — 0 을 내보내면 '쟀더니 0' 과 구별되지 않는다."""
        m = self.metrics
        m.observe("drone.fc.link", lambda: 1.0 if self.link.fc_link() else 0.0,
                  description="FC 링크 생존(0/1)")
        m.observe("drone.battery.voltage",
                  lambda: (self.snap or {}).get("battery", {}).get("voltage_v")
                  if (self.snap or {}).get("battery") else None,
                  unit="V", description="배터리 전압. 모르면 발행하지 않는다")
        m.observe("drone.battery.percent",
                  lambda: (self.snap or {}).get("battery", {}).get("remaining_pct")
                  if (self.snap or {}).get("battery") else None,
                  unit="%", description="배터리 잔량. 모르면 발행하지 않는다")
        m.observe("drone.bridge.tx_bytes", lambda: float(self.link.tx_bytes()),
                  unit="By", description="브리지가 FC 로 보낸 바이트 — 0 이어야 한다")

    # ================= 수집·보고 =================
    def sample_interval(self):
        return SAMPLE_INTERVAL

    def next_wakeup(self):
        return self.last_state_pub + STATE_INTERVAL

    def on_sample(self, now):
        self.snap = self.link.snapshot()
        self._check_discrete_events(now)

    def frame_synced(self, now=None):
        now = time.time() if now is None else now
        return now - self.last_frame_at < FRAME_TIMEOUT

    def on_tick(self, now):
        if self.snap is None or self.frame_synced(now):
            return                   # 프레임이 들어오는 동안은 프레임이 발행을 이끈다
        if now - self.last_state_pub >= STATE_INTERVAL:
            self._publish_state(now, "periodic")
            self.last_state_pub = now

    def _frame_sync_loop(self):
        """카메라 프레임 신호를 받아 그 프레임 시각으로 상태를 발행한다."""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", FRAME_SYNC_PORT))
        print(f"[드론] 프레임 동기 수신 127.0.0.1:{FRAME_SYNC_PORT}")
        while True:
            data, _ = sock.recvfrom(4096)
            try:
                ts = float(json.loads(data)["captured_at"])
            except (ValueError, KeyError, TypeError):
                continue
            now = time.time()
            self.last_frame_at = now
            self.frames_in += 1
            # 1Hz 일 때의 0.2s 샘플을 재사용하면 프레임 시각보다 최대 0.2s 낡는다.
            self.snap = self.link.snapshot()
            self._publish_state(now, "frame", ts=ts)

    def _publish_state(self, now, reason, qos=1, allow_spool=False, kind=EVENT, ts=None):
        with self._pub_lock:
            s = self.snap or {}
            payload = envelope(self.identity, seq=self.seq)
            payload.update({
                "channel": "state",
                "reason": reason,
                # 이 상태와 짝인 카메라 이미지의 생성 시각(epoch 초, 이미지 메타
                # captured_at 과 같은 값). 프레임에서 나온 발행이 아니면 null.
                "ts": ts,
                "device_status": self.device_status(),
                "link": self.link.link_health(),
            })
            payload.update(s)        # fc_link·battery·flight·gps·rtk·attitude·altitude·warnings
            self.publish(f"{self.base}/state", payload, qos=qos,
                         allow_spool=allow_spool, kind=kind)
            self.seq += 1
            self.last_state_pub = now

    def _check_discrete_events(self, now):
        """놓치면 인과가 끊기는 전환들. QoS 1 + 버퍼 대상."""
        s = self.snap or {}
        link = s.get("fc_link")
        if link != self.prev_fc_link:
            first = self.prev_fc_link is None
            self.prev_fc_link = link
            if not first:
                self._publish_state(now, "fc_link_up" if link else "fc_link_lost",
                                    allow_spool=True)
                print(f"[드론] FC 링크 {'복구' if link else '끊김'} "
                      f"(router_mode={s.get('router_mode')})")
            if not link:
                # 링크가 없으면 기체 상태를 '모른다'. 다음 복구 때 전환을 다시 알린다.
                self.prev_armed = self.prev_mode = None
                self.battery_warned = False
                return

        flight = s.get("flight") or {}
        armed, mode = flight.get("armed"), flight.get("mode")
        if armed is not None and armed != self.prev_armed:
            first = self.prev_armed is None
            self.prev_armed = armed
            if not first:
                self._publish_state(now, "armed_changed", allow_spool=True)
                print(f"[드론] arm 상태 → {'ARMED' if armed else 'DISARMED'}")
        if mode is not None and mode != self.prev_mode:
            first = self.prev_mode is None
            self.prev_mode = mode
            if not first:
                self._publish_state(now, "mode_changed", allow_spool=True)
                print(f"[드론] 비행 모드 → {mode}")

        pct = (s.get("battery") or {}).get("remaining_pct")
        if pct is None:
            return                   # 모르는 동안은 경보도 해제도 하지 않는다
        low = pct <= BATTERY_WARN
        if low and not self.battery_warned:
            self.battery_warned = True
            self._publish_state(now, "battery_low", allow_spool=True)
            print(f"[드론] 배터리 경보 {pct}%")
        elif not low and self.battery_warned:
            self.battery_warned = False

    # ================= 공통 코어 훅 =================
    def device_status_extra(self):
        health = self.link.link_health()
        if health == "fault":
            return schema.STATUS_FAULT
        if health == "degraded":
            return schema.STATUS_DEGRADED
        return None

    def status_extra(self):
        """retained status 에 실린다 — 늦게 붙은 구독자가 구독 즉시 받는 요약."""
        s = self.snap or {}
        # 링크 상태는 snap 이 아직 없을 때(birth 직후)도 답할 수 있어야 한다.
        # retained status 의 fc_link 가 null 이면 구독자는 "모른다"로 읽는다.
        age = self.link.hb_age()
        d = {"fc_link": self.link.fc_link(),
             "fc_link_age_s": None if age is None else round(age, 2),
             "router_mode": self.link.router_mode(),
             "link": self.link.link_health(),
             "udp_port": self.link.port,
             "tx_bytes": self.link.tx_bytes(),      # 0 이어야 한다
             "state_interval_s": STATE_INTERVAL,
             "frame_synced": self.frame_synced(),
             "frames_in": self.frames_in,
             "battery": s.get("battery"),
             "flight": s.get("flight")}
        return d

    def diagnostics(self):
        d = super().diagnostics()
        d["drone_link"] = self.link.diagnostics()
        return d

    def on_shutdown(self):
        self.link.close()


if __name__ == "__main__":
    node.main(DroneNode)
