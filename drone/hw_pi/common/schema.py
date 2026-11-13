"""
피지컬팀 mk2 — 메시지 스키마 어댑터 (HW-C-02 / BE-C-01·BE-C-02 정렬)
=====================================================================
백엔드 공통 규약이 확정되기 전에 필드명이 코드 곳곳에 흩어지면, 확정 후 전 파일을
고쳐야 한다. 그래서 "봉투(envelope) 만드는 곳"을 여기 한 군데로 모았다.
필드명이 바뀌면 `envelope()` 한 함수만 고치면 된다.

BE-C-01 공통 필드: source_id, node_id, zone_id, timestamp, schema_version, correlation_id
BE-C-02 식별자 계층: Entity(개체) / Node(물리 노드) / Zone(구역) — IP·MAC 같은
        가변값이 아니라 논리 식별자로 참조한다. MAC은 등록 메시지의 참고 필드이자
        BE-T-05(사설 IP 라우팅)의 매핑 근거로만 싣는다.

## 결측 표현 규칙 — **모르는 값을 0 으로 채우지 않는다**

디지털 트윈은 데이터 소스를 몰라야 하고(SAR·드론·CCTV·로봇 무관), 그래서 서버가
스키마를 소유하며 **채워지지 않은 필드는 비워서** 내려보낸다. 말단도 같은 규칙을 진다.

| 상태 | 표현 | 금지 |
|---|---|---|
| 값이 있다 | 그 값 | — |
| 아직 없다 / 센서가 안 준다 | `null` (파이썬 `None`) | `0`, `-1`, `""` 로 대체 |
| 값이 오래됐다 | 값 + 나이(`*_age_s`) | 최신값인 척 |

규약 `CommandResult.result` 처럼 **null 을 실을 수 없는 자리**(map<string,double>)에서는
**키를 아예 넣지 않는다.** 0 을 넣으면 "측정했더니 0" 과 구별되지 않는다.

이 규칙은 실패에서 나왔다(2026-09-10). Go1 이 전부 0 인 텔레메트리 프레임을 발행했는데
파서가 그대로 읽어 "배터리 0%·자세 0°·위치 원점" 이라는 그럴듯한 거짓값을 올렸고,
배터리 경보가 오발동했으며 임무가 `battery_too_low` 로 거부될 뻔했다. 값이 없는 것과
값이 0 인 것은 다른 사실이다. 자세한 배경은 `docs/ARCHITECTURE_ALIGNMENT.md` §1-3.
"""
import os
import socket
import uuid
from datetime import datetime, timezone

from common import config

SCHEMA_VERSION = "1.1"

# 프로세스 1회 기동을 가리키는 값. 순번 리셋의 경계를 정확히 가른다(백엔드 회신 §6-2).
# 파일에 저장하지 않는다 — 저장하면 재시작해도 같은 값이 되어 의미가 사라진다.
SESSION_ID = uuid.uuid4().hex[:12]

# 백엔드가 source_id 단일 필드로 확정(2026-09-07 회신 §1-1 ③) — 별칭 발행 중단.
# 소비자(monitor.py:56·analyzer.py:92)는 source_id 우선이라 안전하다.
LEGACY_DEVICE_ID = False

# BE-T-04 / [G3]: 장치 자기보고 상태. 서버 판정 가용성(availability)과는 다른 층이다.
STATUS_OK = "ok"
STATUS_DEGRADED = "degraded"
STATUS_FAULT = "fault"


def iso_now():
    """HW-S-08: 모든 메시지에 타임스탬프. chrony로 엣지와 시각을 맞춘 뒤라야 의미가 있다.

    콜론 있는 오프셋(+09:00) + 밀리초. RFC3339 / 계약 date-time 정합(백엔드 회신 §1-1 ② · §6-9).
    strftime("%z")가 내는 +0900 은 계약이 거부한다 — 전량 격리된다."""
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def _mac(ip=""):
    """이 노드의 MAC. **BE-T-05 가 MAC↔구역 매핑을 라우팅 근거로 쓰므로 값이
    흔들리면 안 된다.**

    원래는 `uuid.getnode()` 하나였는데, 컨테이너 안에서 실제 인터페이스를 못 찾으면
    **난수를 만들어 돌려준다**(locally-administered 비트가 선 값). 실측(pi1, 2026-09-14):
    같은 파이에서 센서 노드는 2c:cf:67:9d:10:4c, 컨테이너 로봇 노드는 46:fa:28:cd:e2:c0
    를 보고했고 후자는 프로세스마다 바뀐다. 대장이 한 노드를 여럿으로 본다.

    그래서 **우리가 실제로 쓰는 인터페이스**의 MAC 을 찾는다 — `_ip()` 가 고른,
    브로커로 나가는 그 인터페이스다. 못 찾으면 단계적으로 물러난다.
    """
    forced = os.environ.get("HW_MAC", "").strip()
    if forced:
        return forced

    if ip:
        try:
            import psutil
            for name, addrs in psutil.net_if_addrs().items():
                if name == "lo":
                    continue
                if not any(getattr(a, "address", "") == ip for a in addrs):
                    continue
                for a in addrs:
                    if getattr(a, "family", None) != psutil.AF_LINK:
                        continue
                    addr = (a.address or "").lower()
                    # 루프백·가상 인터페이스는 전부 0 을 돌려준다. 그건 주소가 아니다.
                    if len(addr) == 17 and addr != "00:00:00:00:00:00":
                        return addr
        except Exception:
            pass                      # psutil 이 없거나 형태가 다르면 아래로 내려간다

    # 물리 인터페이스를 직접 뒤진다. 가상(docker0·veth·usb0)과 난수 MAC 은 뺀다.
    try:
        for name in sorted(os.listdir("/sys/class/net")):
            if name == "lo" or name.startswith(("docker", "veth", "br-", "usb")):
                continue
            addr = _read(f"/sys/class/net/{name}/address").lower()
            if len(addr) == 17 and addr != "00:00:00:00:00:00" \
                    and not int(addr[:2], 16) & 0x02:      # locally-administered 제외
                return addr
    except OSError:
        pass

    # 마지막 수단. 여기까지 오면 값이 난수일 수 있다 — 그래서 순서가 마지막이다.
    return ":".join(f"{(uuid.getnode() >> i) & 0xff:02x}" for i in range(40, -1, -8))


def _ip():
    """기본 경로로 나가는 인터페이스의 IP. 실제 패킷은 보내지 않는다(UDP connect)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((config.BROKER_HOST, config.BROKER_PORT))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


class Identity:
    """Entity/Node/Zone 3계층 + 물리 주소. HW-C-07의 '변경 시 갱신'을 위해
    현재 값을 다시 읽어 이전과 비교하는 책임까지 여기서 진다."""

    def __init__(self, entity_id, node_id, zone_id, mac, ip, entity_type="node"):
        self.entity_type = entity_type
        self.entity_id = entity_id
        self.node_id = node_id
        self.zone_id = zone_id
        self.mac = mac
        self.ip = ip

    @classmethod
    def resolve(cls, entity_type="node"):
        # 우선순위: 명시적 환경변수 > 설정 파일 > 기본값.
        # 운용에서는 /etc/device_id 가 정본이지만, 한 대의 파이에서 센서 노드와 로봇
        # 노드를 함께 검증할 때처럼 명시적으로 지정한 값이 있으면 그쪽이 더 구체적이다.
        entity_id = os.environ.get("HW_ENTITY_ID", "") or _read(config.ENTITY_ID_FILE)
        if not entity_id:
            raise SystemExit(
                f"device_id를 찾을 수 없다: {config.ENTITY_ID_FILE} (HW-C-07 채번 필요). "
                "HW_ENTITY_ID 환경변수로도 지정할 수 있다."
            )
        node_id = (os.environ.get("HW_NODE_ID", "") or _read(config.NODE_ID_FILE)
                   or socket.gethostname())
        zone_id = (os.environ.get("HW_ZONE_ID", "") or _read(config.ZONE_ID_FILE)
                   or config.ZONE_ID)
        # 노드 클래스가 자기 타입을 안다. 환경변수는 명시적 덮어쓰기로만 이긴다.
        etype = config.ENTITY_TYPE or entity_type
        ip = _ip()
        return cls(entity_id, node_id, zone_id, _mac(ip), ip, etype)

    @property
    def topic_base(self):
        """통합정립본 v3의 {domain}/{type}/{id}/{channel} 체계.
        구조 자체를 config.TOPIC_TEMPLATE 로 뺐다 — 도메인 체계(AGENDA #2)가
        어떻게 확정되든 설정 한 줄로 전환되고 코드는 바뀌지 않는다."""
        return config.TOPIC_TEMPLATE.format(
            zone=self.zone_id, etype=self.entity_type, eid=self.entity_id)

    def fingerprint(self):
        """이 값이 달라지면 재등록 대상(HW-C-07: 네트워크 또는 구역 변경 시 갱신)."""
        return (self.zone_id, self.mac, self.ip)

    def registration(self):
        """등록(Birth)에 싣는 장치 정보. BE-T-04가 구역 단위 장치 목록으로 보관하고
        BE-T-05가 MAC↔구역 매핑을 라우팅 근거로 쓴다."""
        return {
            "entity_id": self.entity_id,
            "node_id": self.node_id,
            "zone_id": self.zone_id,
            "entity_type": self.entity_type,
            "device_type": config.DEVICE_TYPE,
            "fw_version": config.FW_VERSION,
            "mac": self.mac,
            "ip": self.ip,
        }


def envelope(identity, seq=None, correlation_id=None):
    """모든 발행 메시지의 공통 머리. 채널별 본문은 호출부에서 합친다."""
    env = {
        "schema_version": SCHEMA_VERSION,
        "source_id": identity.entity_id,   # BE-C-01
        "node_id": identity.node_id,       # BE-C-02
        "zone_id": identity.zone_id,
        "timestamp": iso_now(),            # HW-S-08
        "session_id": SESSION_ID,          # 백엔드 회신 §6-2: 순번 리셋 경계
    }
    if seq is not None:
        env["sequence_id"] = seq   # 계약 필드명(백엔드 회신 §1-1 ①). 인자 이름은 그대로.
    if correlation_id is not None:
        env["correlation_id"] = correlation_id   # BE-X-01: 백엔드 발급 command_id를 에코
    if LEGACY_DEVICE_ID:
        env["device_id"] = identity.entity_id
    return env
