"""
피지컬팀 mk2 — 명령 경로 trace (v8 §5-7·§5-8 / BACKEND_AGENDA 10-3)
=====================================================================
v8 §5-8 이 "말단에서 어디까지 계측할지는 구현 단계에서 정한다"고 하드웨어에 위임했다.
여기서 정한다: **span 은 명령 경로에만 만든다.**

    cmd.receive   수신·검증 — accepted / rejected 와 사유
      └ cmd.execute   수행 — 단계 승격은 event 로, 실패는 status=ERROR 로
          └ cmd.result    결과 회신 발행 (단계마다 짧게)

계측·하트비트 같은 고빈도 경로에는 span 을 만들지 않는다. 초당 수십 건에 span 을
붙이면 저사양 말단에 부담이고, 그 경로의 문제는 이미 metric 5종으로 보인다.
반면 명령은 드물고 한 건 한 건이 중요하다 — "장치 span 이 없으면 명령이 도달하지
못한 것"(v8 §5-7)이 이 범위로 성립한다.

## 상관: 백엔드 trace 에 잇는다

백엔드가 명령 페이로드에 W3C `traceparent` 를 실어 보내면 우리 span 이 그 trace 의
자식으로 붙는다 — 관제 클릭부터 물리 동작까지 한 사슬로 보인다. 없으면 새 trace 를
시작한다(형식은 BACKEND_AGENDA 10-3 에서 확인 요청 중). `command_id` 는 별도
속성으로 항상 붙는다 — trace 가 끊겨도 업무 평면의 상관 사슬(BE-X-01)은 남는다.

## metric 과 같은 규율

- 평면 분리: 업무(MQTT)와 관측(OTLP)은 같은 통로를 쓰지 않는다.
- SDK 미설치·엔드포인트 미설정이면 조용히 no-op — 관측은 업무의 전제조건이 아니다.
- Resource 속성은 otel_metrics 와 동일한 키를 쓴다. 같은 노드의 metric 과 trace 가
  Collector 에서 같은 주체로 묶여야 하기 때문이다.
"""
from common import config


class _NoopCmdTrace:
    """tracer 가 없을 때의 명령 추적. 모든 호출이 즉시 반환한다."""

    def received(self, action, cid, result, error=None):
        pass

    def execute(self):
        return self

    def stage(self, stage, detail=None):
        pass

    def failed(self, error):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Noop:
    enabled = False

    def begin(self, cmd):
        return _NoopCmdTrace()

    def shutdown(self):
        pass


class _CmdTrace:
    """명령 한 건의 span 사슬. 규약 서버 스레드 경계(수신 콜백 → 실행 워커)를
    큐에 실려 넘어가므로, 컨텍스트를 스레드 로컬이 아니라 이 객체가 든다."""

    def __init__(self, tracer, cmd):
        from opentelemetry import trace as ot
        from opentelemetry.trace.propagation.tracecontext import (
            TraceContextTextMapPropagator,
        )
        self._ot = ot
        self._tracer = tracer
        # 백엔드가 traceparent 를 실어 보냈으면 그 trace 의 자식으로 붙는다
        parent = TraceContextTextMapPropagator().extract(carrier=cmd)
        self._receive = tracer.start_span(
            "cmd.receive", context=parent, kind=ot.SpanKind.SERVER)
        self._receive_ctx = ot.set_span_in_context(self._receive)
        self._exec = None
        self._exec_ctx = None

    def received(self, action, cid, result, error=None):
        """수신·검증 종료. rejected 면 여기서 사슬이 끝난다 — 그것 자체가 기록이다."""
        s = self._receive
        if action:
            s.set_attribute("hw.command.action", action)
        if cid:
            s.set_attribute("hw.command.id", cid)
        s.set_attribute("hw.command.result", result)
        if error:
            s.set_attribute("hw.command.error", error)
            s.set_status(self._ot.Status(self._ot.StatusCode.ERROR, error))
        s.end()

    def execute(self):
        """수행 span. with 문으로 감싼다 — 워커 스레드에서."""
        self._exec = self._tracer.start_span("cmd.execute", context=self._receive_ctx)
        self._exec_ctx = self._ot.set_span_in_context(self._exec)
        return self

    def stage(self, stage, detail=None):
        """단계 승격. executing/state_changed 는 event 로 충분하다 — span 을 단계마다
        만들면 4배로 늘 뿐 정보가 없다. 회신 발행만 cmd.result 로 짧게 잰다."""
        self._exec.add_event(f"stage.{stage}")
        with self._tracer.start_as_current_span("cmd.result", context=self._exec_ctx) as r:
            r.set_attribute("hw.command.stage", stage)

    def failed(self, error):
        self._exec.set_status(self._ot.Status(self._ot.StatusCode.ERROR, error))

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._exec is not None:
            self._exec.end()
        return False


class Traces:
    enabled = True

    def __init__(self, identity, exporter=None):
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import (BatchSpanProcessor,
                                                    SimpleSpanProcessor)

        if exporter is None:
            try:
                from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
                    OTLPSpanExporter,
                )
            except ImportError:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                    OTLPSpanExporter,
                )
            exporter = OTLPSpanExporter(endpoint=config.OTEL_ENDPOINT)
            processor = BatchSpanProcessor(exporter)   # 명령은 드물다 — 배치로 충분
        else:
            processor = SimpleSpanProcessor(exporter)  # 시험용: 즉시 export

        # otel_metrics 와 동일한 Resource 키 — 같은 노드의 metric·trace 가
        # Collector 에서 같은 주체로 묶여야 한다.
        resource = Resource.create({
            "service.name": f"hw-{identity.entity_type}-node",
            "service.version": config.FW_VERSION,
            "service.instance.id": identity.entity_id,
            "hw.entity_id": identity.entity_id,
            "hw.node_id": identity.node_id,
            "hw.zone_id": identity.zone_id,
        })
        # 전역 provider 는 건드리지 않는다 — otel_metrics 가 이미 전역 meter 를
        # 설정하고 있고, trace 는 이 모듈 밖에서 쓸 일이 없다.
        self._provider = TracerProvider(resource=resource)
        self._provider.add_span_processor(processor)
        self._tracer = self._provider.get_tracer("hw.node.commands")

    def begin(self, cmd):
        return _CmdTrace(self._tracer, cmd)

    def shutdown(self):
        try:
            self._provider.shutdown()
        except Exception:
            pass


def create(identity, exporter=None):
    """설정·의존성이 갖춰졌을 때만 실제 계측기를 만들고, 아니면 no-op.
    (otel_metrics.create 와 같은 규율)"""
    if exporter is None and not config.OTEL_ENDPOINT:
        return _Noop()
    try:
        t = Traces(identity, exporter=exporter)
        if exporter is None:
            print(f"[otel] trace → {config.OTEL_ENDPOINT} (명령 경로만)")
        return t
    except Exception as e:
        print(f"[otel] trace 초기화 실패({type(e).__name__}: {e}) — 추적 없이 계속 동작")
        return _Noop()
