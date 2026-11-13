"""
피지컬팀 mk2 — X500 v2 (PX4) 드론 링크 (pi3)
=================================================
`robot/go1_link.py` 와 같은 자리의 드론판이다. **읽기 전용이다** — FC 로 한 바이트도
보내지 않는다.

## 왜 읽기만 하는가

Go1Link 가 SDK UDP 를 피한 이유(제어권 탈취로 로봇이 주저앉는다)와 동기가 같다.
드론 쪽 사정은 이렇다.

  - FC(코아 H743 / PX4)의 TELEM2 는 `MAV_1_MODE=Onboard` 로 잡혀 있어 **요청 없이도**
    필요한 스트림을 전부 흘려 준다(실측 21종: ATTITUDE 100Hz, SYS_STATUS 5Hz,
    GPS_RAW_INT 10Hz, HEARTBEAT 1Hz, BATTERY_STATUS 0.5Hz …).
  - 그래서 스트림 요청(SET_MESSAGE_INTERVAL / REQUEST_DATA_STREAM)조차 필요 없다.
  - 보내지 않으면 arm·takeoff·모드변경이 **코드가 아니라 구조로** 불가능해진다.

`mavutil` 의 udpin 소켓은 우리가 `mav.send()` 를 호출하지 않는 한 아무것도 내보내지
않는다. 그 사실을 믿지 말고 재도록 `tx_bytes`(pymavlink 자체 카운터)를 상태에 싣는다 —
0 이 아니면 그 자체가 사건이다.

## 값이 없을 때

`common/schema.py` 의 결측 규칙을 그대로 따른다. **모르는 값은 `None`**, 0 이나 -1 로
채우지 않는다. 특히 FC 링크가 끊기면 마지막 배터리 값을 계속 내보내지 않고 전부
`None` 으로 떨어뜨린다 — 낡은 값이 현재값처럼 보이는 것이 값이 없는 것보다 나쁘다.
PX4 가 "모름"을 뜻하는 방식(배터리 잔량 -1, 전압 UINT16_MAX, fix_type 0)도 같이
`None` 으로 옮긴다.

## 재사용

  ~/drone/scripts/dronelink.py  is_vehicle_heartbeat()  — FC heartbeat 판별(sysid+compid,
                                autopilot!=INVALID). QGC·MAVSDK heartbeat 를 FC 로 오인하지 않는다
  ~/drone/scripts/check_link.py decode_px4_custom_mode() — PX4 custom_mode → "AUTO.LOITER"
"""
import os
import sys
import threading
import time
from collections import Counter, deque

from pymavlink import mavutil

# pi3 의 드론 스크립트를 그대로 가져다 쓴다(다시 짜지 않는다).
DRONE_SCRIPTS = os.environ.get("HW_DRONE_SCRIPTS", "/home/physical/drone/scripts")
if DRONE_SCRIPTS not in sys.path:
    sys.path.insert(0, DRONE_SCRIPTS)
from dronelink import is_vehicle_heartbeat          # noqa: E402
from check_link import decode_px4_custom_mode       # noqa: E402


def _f(name, default):
    try:
        return float(os.environ.get(f"HW_DRONE_{name}", default))
    except (TypeError, ValueError):
        return float(default)


# 라우터가 이 포트로 중계한다(mavlink-router.conf 의 [UdpEndpoint bridge]).
# 14540 은 MAVSDK 제어 코드 자리라 쓰지 않는다.
UDP_PORT = int(os.environ.get("HW_DRONE_UDP_PORT", "14543"))
# drone-detect 가 기록하는 현재 모드. "drone" 이면 라우터가 떠 있다는 뜻이다.
MODE_FILE = os.environ.get("HW_DRONE_MODE_FILE", "/home/physical/drone/state/mode")

# 나이 상한 — 이보다 오래된 표본은 값이 아니라 흔적이다.
FC_TIMEOUT = _f("FC_TIMEOUT", 3.0)        # HEARTBEAT 1Hz → 3초면 3회 결번
BATT_STALE = _f("BATT_STALE", 5.0)        # SYS_STATUS 5Hz
ATT_STALE = _f("ATT_STALE", 1.0)          # ATTITUDE 100Hz
GPS_STALE = _f("GPS_STALE", 3.0)          # GPS_RAW_INT 10Hz
# RTK 보정(GPS_RTCM_DATA)은 QGC 가 ~7Hz 로 주입한다. 이보다 오래 끊기면 "보정 없음".
RTCM_STALE = _f("RTCM_STALE", 3.0)
RTCM_WINDOW = _f("RTCM_WINDOW", 5.0)      # 수신률 계산 창(초)
WARN_KEEP = int(os.environ.get("HW_DRONE_WARN_KEEP", "5"))     # STATUSTEXT 보관 줄 수
WARN_MAX_AGE = _f("WARN_MAX_AGE", 120.0)  # 이보다 오래된 경고는 흘려보낸다

UINT16_MAX = 65535
SEVERITY = {0: "EMERGENCY", 1: "ALERT", 2: "CRITICAL", 3: "ERROR",
            4: "WARNING", 5: "NOTICE", 6: "INFO", 7: "DEBUG"}


class DroneLink:
    """mavlink-router 의 UDP 엔드포인트를 구독만 한다. 명령 경로는 없다."""

    def __init__(self, port=UDP_PORT):
        self.port = port
        self._lock = threading.Lock()
        self._msg = {}          # 타입 → (수신시각, 메시지)
        self._hb_at = 0.0       # 마지막 **FC** heartbeat 시각
        self._hb = None
        self._warns = deque(maxlen=WARN_KEEP)
        # GPS_RTCM_DATA 수신 기록 (시각, 바이트). 라우터는 QGC 가 FC 로 주입하는 보정을
        # 출처 외 모든 엔드포인트로 중계하므로 이 포트에서도 같은 흐름이 보인다.
        self._rtcm = deque()
        self._rtcm_src = None
        self._counts = Counter()
        self._rx_total = 0
        self._started = time.time()
        self._open_error = None

        self._mav = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="dronelink",
                                        daemon=True)
        self._thread.start()

    # ---------- 수신 ----------
    def _loop(self):
        addr = f"udpin:127.0.0.1:{self.port}"
        while not self._stop.is_set():
            if self._mav is None:
                try:
                    self._mav = mavutil.mavlink_connection(addr)
                    self._open_error = None
                    print(f"[드론링크] {addr} 수신 대기 (읽기 전용, 송신 0바이트)")
                except Exception as e:      # 포트 선점 등 — 노드는 계속 살아 있어야 한다
                    self._open_error = f"{type(e).__name__}: {e}"
                    print(f"[드론링크] {addr} 열기 실패 — {self._open_error}")
                    self._stop.wait(5.0)
                    continue
            try:
                msg = self._mav.recv_match(blocking=True, timeout=1.0)
            except Exception as e:
                print(f"[드론링크] 수신 오류 {type(e).__name__}: {e}")
                self._stop.wait(1.0)
                continue
            if msg is None:
                continue
            t = msg.get_type()
            if t == "BAD_DATA":
                continue
            now = time.time()
            with self._lock:
                self._counts[t] += 1
                self._rx_total += 1
                self._msg[t] = (now, msg)
                if is_vehicle_heartbeat(msg):
                    self._hb_at, self._hb = now, msg
                elif t == "GPS_RTCM_DATA":
                    self._rtcm.append((now, int(msg.len)))
                    self._rtcm_src = f"{msg.get_srcSystem()}/{msg.get_srcComponent()}"
                    while self._rtcm and now - self._rtcm[0][0] > RTCM_WINDOW:
                        self._rtcm.popleft()
                elif t == "STATUSTEXT":
                    self._warns.append((now, getattr(msg, "severity", None),
                                        str(getattr(msg, "text", ""))))

    def close(self):
        self._stop.set()
        if self._mav is not None:
            try:
                self._mav.close()
            except Exception:
                pass

    # ---------- 도우미 ----------
    def _get(self, kind, max_age, now):
        """나이 상한 안에 들어온 표본만 돌려준다. 없으면 (None, None)."""
        rec = self._msg.get(kind)
        if rec is None:
            return None, None
        at, msg = rec
        age = now - at
        return (msg, age) if age <= max_age else (None, None)

    @staticmethod
    def _age(v):
        return None if v is None else round(v, 2)

    def router_mode(self):
        """drone-detect 가 남긴 현재 모드. 라우터 자체가 떠 있는지의 근거."""
        try:
            with open(MODE_FILE) as f:
                return f.read().strip() or "none"
        except OSError:
            return "none"

    # ---------- 상태 ----------
    def fc_link(self, now=None):
        now = now or time.time()
        with self._lock:
            at = self._hb_at
        return bool(at) and (now - at) <= FC_TIMEOUT

    def hb_age(self, now=None):
        now = now or time.time()
        with self._lock:
            at = self._hb_at
        return (now - at) if at else None

    def link_health(self):
        """ok | degraded | fault — Go1Link 과 같은 어휘.

        라우터가 드론 모드인데 heartbeat 가 없으면 **fault**(있어야 할 것이 없다).
        모드가 none 이면 기체 전원이 없는 정상 상황이므로 **degraded** 로 둔다 —
        기대된 상태를 장애로 보고하면 경보가 의미를 잃는다."""
        now = time.time()
        if self._open_error:
            return "fault"
        if not self.fc_link(now):
            return "fault" if self.router_mode() == "drone" else "degraded"
        # heartbeat 는 오는데 배터리·자세가 안 오면 반쪽이다.
        with self._lock:
            batt, _ = self._get("SYS_STATUS", BATT_STALE, now)
            att, _ = self._get("ATTITUDE", ATT_STALE, now)
        return "ok" if (batt is not None and att is not None) else "degraded"

    def snapshot(self):
        """웹으로 나갈 드론 상태 1건. **FC 링크가 없으면 전부 None 이다.**"""
        now = time.time()
        link = self.fc_link(now)
        hb_age = self.hb_age(now)
        snap = {
            "fc_link": link,
            "fc_link_age_s": self._age(hb_age),
            "router_mode": self.router_mode(),
            "battery": None, "flight": None, "gps": None, "rtk": None,
            "attitude": None, "altitude": None, "warnings": [],
        }
        if not link:
            # 마지막 값을 현재값처럼 보내지 않는다(결측 규칙). 경고만 남긴다 —
            # 끊기기 직전의 STATUSTEXT 가 끊긴 이유일 때가 많다.
            snap["warnings"] = self._recent_warnings(now)
            return snap

        with self._lock:
            hb = self._hb
            sysst, sys_age = self._get("SYS_STATUS", BATT_STALE, now)
            batt, batt_age = self._get("BATTERY_STATUS", 30.0, now)   # 0.5Hz
            gps, gps_age = self._get("GPS_RAW_INT", GPS_STALE, now)
            att, att_age = self._get("ATTITUDE", ATT_STALE, now)
            alt, alt_age = self._get("ALTITUDE", 3.0, now)
            ext, _ = self._get("EXTENDED_SYS_STATE", 5.0, now)
            snap["warnings"] = self._recent_warnings(now)
            rtcm, rtcm_src = list(self._rtcm), self._rtcm_src

        snap["battery"] = self._battery(sysst, sys_age, batt, batt_age)
        snap["flight"] = self._flight(hb, hb_age, ext)
        snap["gps"] = self._gps(gps, gps_age)
        snap["rtk"] = self._rtk(rtcm, rtcm_src, gps, now)
        if att is not None:
            import math
            snap["attitude"] = {
                "roll_deg": round(math.degrees(att.roll), 2),
                "pitch_deg": round(math.degrees(att.pitch), 2),
                "yaw_deg": round(math.degrees(att.yaw), 2),
                "age_s": self._age(att_age),
            }
        if alt is not None:
            snap["altitude"] = {
                "relative_m": round(alt.altitude_relative, 2),
                "amsl_m": round(alt.altitude_amsl, 2),
                "age_s": self._age(alt_age),
            }
        return snap

    def _recent_warnings(self, now):
        out = []
        for at, sev, text in list(self._warns):
            age = now - at
            if age > WARN_MAX_AGE:
                continue
            out.append({"severity": SEVERITY.get(sev, sev), "text": text,
                        "age_s": self._age(age)})
        return out

    @staticmethod
    def _battery(sysst, sys_age, batt, batt_age):
        """전압·잔량은 SYS_STATUS 가 기준, BATTERY_STATUS 는 보조(0.5Hz).
        PX4 가 '모름'을 뜻하는 값(-1, UINT16_MAX)은 None 으로 옮긴다."""
        if sysst is None and batt is None:
            return None
        d = {"voltage_v": None, "current_a": None, "remaining_pct": None,
             "consumed_mah": None, "source": None, "age_s": None}
        if sysst is not None:
            v, c, r = (sysst.voltage_battery, sysst.current_battery,
                       sysst.battery_remaining)
            d["voltage_v"] = round(v / 1000.0, 2) if v not in (0, UINT16_MAX) else None
            d["current_a"] = round(c / 100.0, 2) if c != -1 else None
            d["remaining_pct"] = float(r) if r >= 0 else None
            d["source"] = "SYS_STATUS"
            d["age_s"] = DroneLink._age(sys_age)
        if batt is not None:
            cons = getattr(batt, "current_consumed", -1)
            d["consumed_mah"] = float(cons) if cons >= 0 else None
            if d["voltage_v"] is None:
                volts = list(getattr(batt, "voltages", []) or [])
                v0 = volts[0] if volts else UINT16_MAX
                if v0 not in (0, UINT16_MAX):
                    d["voltage_v"] = round(v0 / 1000.0, 2)
                    d["source"] = "BATTERY_STATUS"
                    d["age_s"] = DroneLink._age(batt_age)
        return d

    @staticmethod
    def _flight(hb, hb_age, ext):
        if hb is None:
            return None
        armed = bool(hb.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
        landed = None
        if ext is not None:
            landed = {0: "UNDEFINED", 1: "ON_GROUND", 2: "IN_AIR",
                      3: "TAKEOFF", 4: "LANDING"}.get(ext.landed_state)
        return {
            "armed": armed,
            "mode": decode_px4_custom_mode(hb.custom_mode),
            "custom_mode": int(hb.custom_mode),
            "base_mode": int(hb.base_mode),
            # system_status 는 pi3 실측에서 0(UNINIT)으로 온다 — arm 판정에 쓰지 않는다.
            "system_status": int(hb.system_status),
            "landed_state": landed,
            "age_s": DroneLink._age(hb_age),
        }

    @staticmethod
    def _gps(gps, gps_age):
        if gps is None:
            return None
        fix = int(gps.fix_type)
        name = {0: "NO_GPS", 1: "NO_FIX", 2: "2D", 3: "3D", 4: "DGPS",
                5: "RTK_FLOAT", 6: "RTK_FIXED"}.get(fix, str(fix))
        d = {"fix_type": fix, "fix": name,
             "satellites": int(gps.satellites_visible),
             "lat": None, "lon": None, "eph_m": None,
             "age_s": DroneLink._age(gps_age)}
        if fix >= 2:        # fix 가 없으면 lat/lon 0 은 좌표가 아니라 데이터 부재다
            d["lat"] = gps.lat / 1e7
            d["lon"] = gps.lon / 1e7
            if gps.eph not in (0, UINT16_MAX, 9999):
                d["eph_m"] = round(gps.eph / 100.0, 2)
        return d

    @staticmethod
    def _rtk(rtcm, src, gps, now):
        """RTK 보정 주입 상태. `corrections` 는 "보정이 FC 쪽으로 흐르고 있다",
        `fix` 는 "FC 가 그 보정을 실제로 써서 RTK 해를 냈다"이다 — 둘은 따로 본다."""
        last = rtcm[-1][0] if rtcm else None
        age = (now - last) if last is not None else None
        win = [(t, n) for t, n in rtcm if now - t <= RTCM_WINDOW]
        fix = None
        if gps is not None:
            fix = {5: "RTK_FLOAT", 6: "RTK_FIXED"}.get(int(gps.fix_type), "NONE")
        return {
            "corrections": age is not None and age <= RTCM_STALE,
            "rtcm_age_s": DroneLink._age(age),
            "rtcm_msgs_per_s": round(len(win) / RTCM_WINDOW, 1),
            "rtcm_bytes_per_s": round(sum(n for _, n in win) / RTCM_WINDOW, 1),
            "rtcm_source": src,
            "fix": fix,
        }

    # ---------- 진단 ----------
    def tx_bytes(self):
        """이 링크가 FC 방향으로 내보낸 바이트. **항상 0 이어야 한다.**"""
        m = self._mav
        if m is None:
            return 0
        return int(getattr(m.mav, "total_bytes_sent", 0))

    def diagnostics(self):
        now = time.time()
        with self._lock:
            counts = dict(self._counts.most_common(8))
            rx = self._rx_total
        el = max(1e-6, now - self._started)
        return {
            "udp_port": self.port, "open_error": self._open_error,
            "router_mode": self.router_mode(),
            "fc_link": self.fc_link(now), "fc_link_age_s": self._age(self.hb_age(now)),
            "rx_total": rx, "rx_hz": round(rx / el, 1),
            "rx_top": counts, "tx_bytes": self.tx_bytes(),
            "link": self.link_health(),
        }

    def send_command(self, action, params):
        """**의도적으로 막아 둔다** (go1_link.py 와 같은 방어).

        이 브리지는 연결·배터리·상태 보고 전용이다. arm·takeoff·land·모드변경은
        물론이고 스트림 요청도 하지 않는다. FC 로 명령이 필요해지면 그때 멈추고
        보고한 뒤 별도 경로로 붙인다."""
        raise NotImplementedError(
            "drone_command_not_enabled — 이 브리지는 읽기 전용이다(FC 송신 0바이트)")
