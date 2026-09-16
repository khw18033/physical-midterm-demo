"""
피지컬팀 mk2 — 노드 자기 관측 metric 5종 (HW-C-05 / BE-S-02)
=============================================================
업무 데이터(MQTT)와 관측 데이터(OTLP)는 평면을 나눈다. 업무 경로가 막혀도 "왜
막혔는지"는 관측 경로로 보여야 하기 때문에, 같은 통로로 보내면 장애 시 둘 다 눈이 먼다.

발신 대상은 구역 엣지의 Collector(Agent)이고, 엣지가 가공해 백엔드 Collector
(Gateway)로 모은다 — BE-S-02의 Agent+Gateway 구조.

metric 5종 (노드 공통) — 여기에 더해 노드가 자기 도메인 지표를 등록한다(observe/counter/histogram)
  1) system.cpu.utilization      CPU 사용률
  2) system.memory.utilization   메모리 사용률
  3) system.filesystem.free      디스크 여유 공간 — HW-R-09 버퍼가 먹는 자원이라 포함
  4) hw.publish.count            발행 성공/실패 (outcome 속성으로 구분)
  5) hw.publish.duration         발행 지연(ms)

export 주기 60초(HW-C-05). 계획서 초안의 15초와 상충하여 요구사항 정의서를 따랐다.

SDK 미설치·엔드포인트 미설정이면 조용히 no-op으로 떨어진다. 관측이 없다고 해서
말단이 계측을 멈추면 안 되기 때문이다(관측은 업무의 전제조건이 아니다).
"""
import shutil

from common import config

try:
    import psutil
except ImportError:
    psutil = None


class _NoopInstrument:
    """관측이 꺼져 있을 때의 계측기. 노드 코드에 if 를 넣지 않기 위해 존재한다."""

    def add(self, *a, **kw):
        pass

    def record(self, *a, **kw):
        pass


class _Noop:
    enabled = False

    def record_publish(self, ok, latency_ms=None):
        pass

    def observe(self, name, callback, unit="1", description=""):
        pass

    def counter(self, name, unit="1", description=""):
        return _NoopInstrument()

    def histogram(self, name, unit="1", description=""):
        return _NoopInstrument()

    def shutdown(self):
        pass


class Metrics:
    enabled = True

    def __init__(self, identity):
        from opentelemetry import metrics
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource

        try:
            from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
                OTLPMetricExporter,
            )
        except ImportError:
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
                OTLPMetricExporter,
            )

        # Resource 속성으로 어느 노드의 지표인지 식별한다. 지표 이름에 장치 ID를
        # 넣으면 시계열이 장치 수만큼 폭발하므로 속성으로 붙이는 것이 정석이다.
        resource = Resource.create({
            # 노드 종류별로 갈라야 Collector 에서 센서/로봇/액추에이터를 구분한다.
            # 고정값이면 로봇 지표까지 hw-sensor-node 로 들어온다(실측에서 확인).
            "service.name": f"hw-{identity.entity_type}-node",
            "service.version": config.FW_VERSION,
            "service.instance.id": identity.entity_id,
            "hw.entity_id": identity.entity_id,
            "hw.node_id": identity.node_id,
            "hw.zone_id": identity.zone_id,
        })
        reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(endpoint=config.OTEL_ENDPOINT),
            export_interval_millis=int(config.OTEL_EXPORT_INTERVAL * 1000),
        )
        self._provider = MeterProvider(resource=resource, metric_readers=[reader])
        metrics.set_meter_provider(self._provider)
        meter = metrics.get_meter("hw.node")

        from opentelemetry.metrics import Observation

        if psutil:
            psutil.cpu_percent(interval=None)   # 첫 호출은 항상 0.0 — 미리 태워 둔다

        def cpu(_):
            yield Observation(psutil.cpu_percent(interval=None) / 100.0)

        def mem(_):
            yield Observation(psutil.virtual_memory().percent / 100.0)

        def disk(_):
            yield Observation(float(shutil.disk_usage(_spool_dir()).free))

        if psutil:
            meter.create_observable_gauge("system.cpu.utilization", callbacks=[cpu],
                                          unit="1", description="CPU 사용률")
            meter.create_observable_gauge("system.memory.utilization", callbacks=[mem],
                                          unit="1", description="메모리 사용률")
        meter.create_observable_gauge("system.filesystem.free", callbacks=[disk],
                                      unit="By", description="버퍼가 쓰는 파티션의 여유 공간")
        self._count = meter.create_counter(
            "hw.publish.count", unit="1", description="MQTT 발행 성공/실패 건수")
        self._latency = meter.create_histogram(
            "hw.publish.duration", unit="ms", description="MQTT 발행 지연")

    # ---- 도메인 지표 등록 -------------------------------------------------
    # 전송(OTLP)은 여기가 알고, **무엇을 재는지는 노드가 안다.** 로봇 지표를 이 파일에
    # 박으면 센서 노드가 로봇 개념을 끌고 다니게 된다.
    #
    # callback 은 값 하나를 돌려주거나, **모르면 None 을 돌려준다.** None 이면 그 주기에는
    # 아무것도 내보내지 않는다 — 0 을 내보내면 "쟀더니 0" 과 구별되지 않기 때문이다
    # (common/schema.py 의 결측 표현 규칙).
    def observe(self, name, callback, unit="1", description=""):
        from opentelemetry import metrics
        from opentelemetry.metrics import Observation

        meter = metrics.get_meter("hw.node")

        def _cb(_):
            try:
                v = callback()
            except Exception:
                return
            if v is None:
                return
            yield Observation(float(v))

        meter.create_observable_gauge(name, callbacks=[_cb],
                                      unit=unit, description=description)

    def counter(self, name, unit="1", description=""):
        from opentelemetry import metrics
        return metrics.get_meter("hw.node").create_counter(
            name, unit=unit, description=description)

    def histogram(self, name, unit="1", description=""):
        from opentelemetry import metrics
        return metrics.get_meter("hw.node").create_histogram(
            name, unit=unit, description=description)

    def record_publish(self, ok, latency_ms=None):
        outcome = {"outcome": "ok" if ok else "fail"}
        self._count.add(1, outcome)
        # QoS 0 발행과 실패에는 왕복이 없다. 0ms 로 기록하면 지연 분포가 0 쪽으로
        # 쏠려 "빠르다"는 거짓 신호를 준다 — 측정된 것만 넣는다.
        if latency_ms is not None:
            self._latency.record(latency_ms, outcome)

    def shutdown(self):
        try:
            self._provider.shutdown()
        except Exception:
            pass


def _spool_dir():
    import os
    return os.path.dirname(config.SPOOL_PATH) or "."


def create(identity):
    """설정·의존성이 갖춰졌을 때만 실제 계측기를 만들고, 아니면 no-op."""
    if not config.OTEL_ENDPOINT:
        print("[otel] HW_OTEL_ENDPOINT 미설정 — 관측 발신 비활성")
        return _Noop()
    try:
        m = Metrics(identity)
        print(f"[otel] {config.OTEL_ENDPOINT} 로 {config.OTEL_EXPORT_INTERVAL:.0f}초마다 export")
        return m
    except Exception as e:
        print(f"[otel] 초기화 실패({type(e).__name__}: {e}) — 관측 없이 계속 동작")
        return _Noop()
