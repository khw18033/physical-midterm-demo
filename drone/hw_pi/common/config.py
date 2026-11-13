"""
피지컬팀 mk2 — 말단 노드 설정 (주기·임계값·경로 단일 지점)
==============================================================
협의로 값이 바뀔 때 코드가 아니라 이 파일(또는 환경변수) 한 곳만 고치면 되도록
임시값·주기 상수를 전부 모았다. 모든 값은 `HW_*` 환경변수로 덮어쓸 수 있어서
파이에 배포한 뒤에도 systemd unit의 `Environment=` 만으로 주기를 바꿀 수 있다.

주기 근거는 요구사항 정의서(xlsx) 기준. 계획서와 상충하는 값은 아래에 명시했다.
"""
import os

def _s(name, default):
    return os.environ.get(f"HW_{name}", default)

def _f(name, default):
    return float(os.environ.get(f"HW_{name}", default))

def _i(name, default):
    return int(os.environ.get(f"HW_{name}", default))

def _b(name, default):
    return str(os.environ.get(f"HW_{name}", default)).lower() in ("1", "true", "yes", "on")

# ---------------- 브로커 접속 (HW-C-01) ----------------
BROKER_HOST = _s("BROKER_HOST", "192.168.50.244")   # 임시: 노트북. 엣지노드 구축 후 교체
BROKER_PORT = _i("BROKER_PORT", 1883)
# BE-T-01이 말단↔엣지를 MQTT 5.0 + TLS로 확정. 5.0은 지금 적용하고,
# TLS는 엣지 브로커에 인증서가 준비되면 아래 3개만 채우면 켜진다.
MQTT_V5 = _b("MQTT_V5", "1")
TLS_CA = _s("TLS_CA", "")           # 예: /etc/hw/ca.crt  (비어있으면 TLS 미사용)
TLS_CERT = _s("TLS_CERT", "")
TLS_KEY = _s("TLS_KEY", "")
MQTT_USER = _s("MQTT_USER", "")
MQTT_PASS = _s("MQTT_PASS", "")
# 하트비트가 5초가 되면서 하트비트 타임아웃 판정이 20초로 늘었다. 그래서 급사 감지의
# **주 경로가 LWT 로 바뀐다** — 브로커는 keepalive*1.5 에 LWT 를 띄우므로 10초면 15초다.
# 하트비트 주기(5초)보다 커야 정상 트래픽을 끊김으로 오인하지 않는다.
KEEPALIVE = _i("KEEPALIVE", 10)
# 재접속 백오프 상한(초). paho 기본 120초는 두절이 길수록 복구가 늦어져
# 재난 대응과 방향이 반대다.
RECONNECT_MAX_DELAY = _f("RECONNECT_MAX_DELAY", 10.0)

# ---------------- 식별자 (HW-C-07, BE-C-02) ----------------
# Entity(논리 개체) / Node(물리 노드) / Zone(구역) 3계층. 지금은 센서 1:1이라
# entity == node 로 보이지만, 로봇처럼 한 노드가 여러 개체를 대리할 때 갈라진다.
ENTITY_ID_FILE = _s("ENTITY_ID_FILE", "/etc/device_id")
NODE_ID_FILE = _s("NODE_ID_FILE", "/etc/node_id")     # 없으면 hostname 사용
ZONE_ID_FILE = _s("ZONE_ID_FILE", "/etc/zone_id")     # 없으면 ZONE_ID 기본값
ZONE_ID = _s("ZONE_ID", "zoneA")                      # 임시: 도메인 체계 확정 대기
ENTITY_TYPE = _s("ENTITY_TYPE", "")                   # 토픽 2번째 칸.
# 비워 두면 노드 클래스의 ENTITY_TYPE(sensor/robot/actuator)을 쓴다.
# 값을 넣으면 그 값이 이긴다 — 한 대에서 여러 역할을 검증할 때의 탈출구.
DEVICE_TYPE = _s("DEVICE_TYPE", "water_level")        # 등록 메시지의 장치 종류
FW_VERSION = _s("FW_VERSION", "0.3.0")
# HW-C-07: 네트워크·구역 변경 시 갱신 → 이 주기로 MAC/IP/zone 변화를 확인
IDENTITY_CHECK_INTERVAL = _f("IDENTITY_CHECK_INTERVAL", 10)

# ---------------- 주기 (HW-S-05, HW-C-04, HW-S-02/03) ----------------
# 아키텍처 v8 §5-1 에 맞춘다(백엔드 기준). 요구사항 정의서의 1 Hz 와 다르며,
# 그 결과 HW-S-07 의 오프라인 판정이 4초 -> **20초**가 된다.
HB_INTERVAL = _f("HB_INTERVAL", 5.0)          # HW-S-05 / v8 §5-1
MISS_LIMIT = _i("MISS_LIMIT", 4)              # HW-S-07: 4회 미수신 → 20초
STATUS_SUMMARY_INTERVAL = _f("STATUS_SUMMARY_INTERVAL", 10.0)   # HW-C-04: 10초 요약
SAMPLE_INTERVAL = _f("SAMPLE_INTERVAL", 1.0)  # HW-S-01: 센서 데이터시트 확정 시 교체
REPORT_INTERVAL_NORMAL = _f("REPORT_INTERVAL_NORMAL", 60.0)     # HW-S-02: 평시 1분
REPORT_INTERVAL_EVENT = _f("REPORT_INTERVAL_EVENT", 1.0)        # HW-S-03: 이벤트 1 Hz

# ---------------- 계측 판정 (HW-S-02) ----------------
THRESHOLD = _f("THRESHOLD", 3.0)      # 임계 수위(m)
HYST = _f("HYST", 0.1)                # 해제 여유: 경계에서 알림이 떨리는 것 방지
# "급변 시 즉시 발행" — 임계 미만이라도 빠르게 오르면 그 자체가 사건이다.
# 잔물결을 사건으로 오인하지 않도록 창(window) 양끝 차이로 판정한다.
RAPID_WINDOW_S = _f("RAPID_WINDOW_S", 10.0)
RAPID_DELTA_M = _f("RAPID_DELTA_M", 0.3)
RAPID_MIN_GAP_S = _f("RAPID_MIN_GAP_S", 10.0)   # 급변 보고 자체의 최소 간격

# ---------------- 관측 (HW-C-05, BE-S-02) ----------------
# 엣지 Collector(Agent)의 OTLP 수신 주소. 비우면 관측 발신을 끈다(노드는 정상 동작).
OTEL_ENDPOINT = _s("OTEL_ENDPOINT", "")       # 예: http://192.168.50.244:4317
# 아키텍처 v8 §5-1 에 맞춘다(백엔드 기준). 요구사항 정의서는 60초였다.
OTEL_EXPORT_INTERVAL = _f("OTEL_EXPORT_INTERVAL", 15.0)

# ---------------- 두절 대비 버퍼 (HW-R-09) ----------------
SPOOL_PATH = _s("SPOOL_PATH", "/var/lib/hw-node/spool.jsonl")
SPOOL_MAX = _i("SPOOL_MAX", 5000)             # 초과분은 오래된 것부터 폐기
SPOOL_REPLAY_BATCH = _i("SPOOL_REPLAY_BATCH", 50)   # 복구 시 한 번에 밀어넣는 양
# 연속 상태값(로봇 위치·속도 등)의 재전송 해상도. 20Hz로 10분 두절이면 12,000건인데
# 전량을 쏟으면 막 복구된 링크가 과거 데이터로 막혀 현재 상태와 명령 ACK가 밀린다.
# 이산 이벤트는 전량 재전송하고 연속값만 이 간격으로 솎는다 (SDD 5.4).
SPOOL_DOWNSAMPLE_S = _f("SPOOL_DOWNSAMPLE_S", 1.0)

# ---------------- 로봇 온보드 (HW-R) ----------------
# 제어기 -> 온보드 내부 수집. ROS 2 Control state_publish_rate 기본 50Hz 기준 (HW-R-01)
ROBOT_INTERNAL_INTERVAL = _f("ROBOT_INTERNAL_INTERVAL", 0.02)
# 온보드 -> 엣지 상태 보고. 임무 중 20Hz / 대기 1Hz (HW-R-03)
# ⚠ 20Hz의 근거(Nav2 controller_frequency)는 내부 제어 루프 주기이지 네트워크 전송
# 주기가 아니다(SRS O-11). 실물 확보 후 무선망 실측으로 재산정한다 — 그래서 설정값이다.
ROBOT_STATE_INTERVAL_MISSION = _f("ROBOT_STATE_INTERVAL_MISSION", 0.05)
# v8 §5-1: 대기 중 5초 (정의서는 1초였다)
ROBOT_STATE_INTERVAL_IDLE = _f("ROBOT_STATE_INTERVAL_IDLE", 5.0)
# 20Hz 상태 스트림은 QoS 0. 다음 샘플이 50ms 뒤 오므로 유실을 상쇄하며, QoS 1은
# 무선 왕복(실측 ~150ms)이 주기보다 길어 부적합하다 (SRS 9.4). 이산 이벤트만 QoS 1.
ROBOT_STATE_QOS = _i("ROBOT_STATE_QOS", 0)
ROBOT_BATTERY_WARN = _f("ROBOT_BATTERY_WARN", 20.0)     # % — 이산 경보 임계
CONTROLLER_LINK = _s("CONTROLLER_LINK", "sim")          # sim | go1 | ep | can | eth
# Unitree Go1 내부 MQTT 브로커. 구독 전용 경로다 — SDK 의 UDP(8082)는 요청/응답이라
# 상태를 받으려면 명령을 보내야 하고, 그 순간 sport mode 에서 제어권을 가져와
# 서 있던 로봇이 주저앉을 수 있다. 그래서 쓰지 않는다.
GO1_MQTT_HOST = _s("GO1_MQTT_HOST", "192.168.123.161")
GO1_STALE_S = _f("GO1_STALE_S", 2.0)          # robot/state 12.5Hz 기준
GO1_BMS_STALE_S = _f("GO1_BMS_STALE_S", 15.0) # bms/state 0.5Hz 기준
GO1_CAM_ID = _i("GO1_CAM_ID", 1)

# RoboMaster EP. Go1 과 달리 명령 경로를 연다(바퀴형이라 제어권 탈취 위험이 없다).
# 대신 링크에서 속도를 클램프하고 워치독으로 정지시킨다 — robot/ep_link.py 참조.
EP_CONN_TYPE = _s("EP_CONN_TYPE", "rndis")    # rndis(USB) | sta(공유기) | ap(직결)
# SDK 구독 주기(허용값 1/5/10/20/50). 50 은 쓰지 마라 — position·attitude·velocity
# 셋을 50Hz 로 함께 걸면 RNDIS 위에서 DDS 가 밀려 **값이 조용히 썩는다.**
# 실측(pi1 + EP, 2026-09-14): 위치가 계속 0.0 으로 고정되고 배터리가 6·11 같은
# 거짓값으로 읽혔다(실제 46). 오류가 나지 않아 알아채기 어렵다 — 10 에서는 24초간
# 배터리 31.0 고정, 3초 전진에 x=0.558m 로 정상이었다.
# 로봇 20Hz 보고(HW-R-03)에 10Hz 수집이면 표본이 부족해 보이지만, 부족한 표본보다
# 썩은 표본이 나쁘다. 20 이 필요해지면 그 주기에서 위 두 값을 다시 실측하고 올린다.
EP_SUB_FREQ = _i("EP_SUB_FREQ", 10)
EP_STALE_S = _f("EP_STALE_S", 1.0)            # 위치 표본이 이보다 오래되면 fault
EP_BATTERY_STALE_S = _f("EP_BATTERY_STALE_S", 15.0)
EP_MISSION_SPEED = _f("EP_MISSION_SPEED", 0.3)  # start_mission 기본 전진 속도
EP_MAX_SPEED = _f("EP_MAX_SPEED", 0.5)        # 링크 클램프 상한. 상위가 뭘 보내든 이 값
EP_CMD_TIMEOUT_S = _f("EP_CMD_TIMEOUT_S", 1.0)  # 워치독 — 갱신 없으면 정지

# 토픽 도메인 체계(BACKEND_AGENDA #2)는 백엔드 회신 대기 중이다. 확정을 기다리며
# 멈추지 않도록 체계를 설정으로 뺐다 — 어떤 체계가 오든 여기 한 줄만 바뀐다.
# 자리표시자: {zone} {etype} {eid}
TOPIC_TEMPLATE = _s("TOPIC_TEMPLATE", "{zone}/{etype}/{eid}")              # go1_relay 가 중계할 카메라 (1=정면)

# ---------------- 영상 송출 (HW-R-07 / HW-S-06, 아키텍처 v8 §5-10) ----------------
# 홉1(말단→엣지)은 JPEG/RTP over UDP 로 확정됐다. frame_ref 는 엣지가 디코드 시점에
# 발급하므로(v8 §6-9) 말단은 만들지 않는다.
MEDIA_SENDER = _s("MEDIA_SENDER", "rtp_jpeg")           # rtp_jpeg | go1_relay | none
# 카메라 미확보 시 "test"(테스트 패턴)로 경로만 검증한다. 입고 후 /dev/videoN 으로 교체.
MEDIA_SOURCE = _s("MEDIA_SOURCE", "test")
MEDIA_SIZE = _s("MEDIA_SIZE", "1280x720")
MEDIA_FPS = _i("MEDIA_FPS", 15)                          # HW-R-07·HW-S-06 모두 15 fps
# JPEG 품질 2(최고)~31(최저). 실측상 q 는 대역폭을 크게 바꾸고 CPU 는 거의 그대로다 —
# 무선 홉의 로봇은 해상도를 낮추기 전에 q 를 올리는 편이 손해가 적다.
MEDIA_QUALITY = _i("MEDIA_QUALITY", 5)
MEDIA_DEST_HOST = _s("MEDIA_DEST_HOST", "")             # 비우면 브로커 주소를 쓴다
MEDIA_DEST_PORT = _i("MEDIA_DEST_PORT", 5004)

# ---------------- 액추에이터 제어노드 (HW-A) ----------------
ACTUATOR_LINK = _s("ACTUATOR_LINK", "sim")              # sim | modbus | gpio
ACTUATOR_SAMPLE_INTERVAL = _f("ACTUATOR_SAMPLE_INTERVAL", 0.02)   # 내부 수집
# HW-A-04: 동작 중 50ms(20Hz) 진행 보고. 대기 중에는 낮춘다 —
# 가만히 있는 수문을 초당 20번 보고할 이유가 없다.
ACTUATOR_REPORT_INTERVAL_MOVING = _f("ACTUATOR_REPORT_INTERVAL_MOVING", 0.05)
ACTUATOR_REPORT_INTERVAL_IDLE = _f("ACTUATOR_REPORT_INTERVAL_IDLE", 10.0)
ACTUATOR_TIMEOUT_S = _f("ACTUATOR_TIMEOUT_S", 10.0)     # 구동 완료 대기 상한
# HW-A-05: 세션 단절이 확인된 뒤 이 시간을 넘으면 원격 제어를 잠그고 안전 상태로 간다.
# 단절 자체는 LWT(keepalive 기준 약 15초) 또는 하트비트 4회(20초)로 잡히므로,
# 이 값은 "단절 확인 후 얼마나 더 기다릴까"이지 절대 시간이 아니다.
ACTUATOR_LOCK_AFTER_S = _f("ACTUATOR_LOCK_AFTER_S", 4.0)
# 시연·시험용 피드백 상실 주입구. 이 파일이 있으면 위치를 알 수 없는 상태가 된다.
# (강우 스위치 RAIN_FLAG 와 같은 방식 — 실물 결선 후 제거)
FEEDBACK_LOSS_FLAG = _s("FEEDBACK_LOSS_FLAG", "/tmp/feedback_loss")

# ---------------- 가짜 센서 스위치 (실센서 입고 시 제거) ----------------
RAIN_FLAG = _s("RAIN_FLAG", "/tmp/rain")
