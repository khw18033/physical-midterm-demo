"""
피지컬팀 mk2 — 최소 OTLP/gRPC metric 수신단 (HW-C-05 검증용)
==============================================================
엣지 Collector(Agent) 실물이 없을 때 **말단이 실제로 무엇을 보내는지** 확인하기 위한
대체 수신단이다. 운영 구성요소가 아니다 — BE-S-02 의 Agent→Gateway 구조는 별개다.

이게 필요했던 이유: OTel 코드가 예외 없이 도는 것은 "발신을 시도했다"일 뿐
"무엇이 도착했나"가 아니다. 수신단을 세우고 나서야 아래 두 결함이 드러났다.
  - service.name 이 로봇 지표까지 `hw-sensor-node` 로 고정되어 노드 구분 불가
  - QoS 0 발행에 지연 0 ms 를 기록해 히스토그램이 0 으로 쏠림("빠르다"는 거짓 신호)

사전 조건:
    pip install grpcio opentelemetry-proto

사용:
    python3 -m bench.otlp_sink [수신초]        # 기본 120초

말단 쪽 설정:
    /etc/hw-node.env 에  HW_OTEL_ENDPOINT=http://<이 호스트IP>:4317
    (검증 중에는 HW_OTEL_EXPORT_INTERVAL 을 낮춰 빨리 확인한다)
"""
import collections
import sys
import time
from concurrent import futures

import grpc
from opentelemetry.proto.collector.metrics.v1 import (
    metrics_service_pb2 as pb,
    metrics_service_pb2_grpc as pb_grpc,
)

RESOURCE_KEYS = ("service.name", "service.version", "service.instance.id",
                 "hw.entity_id", "hw.node_id", "hw.zone_id")


class MetricsSink(pb_grpc.MetricsServiceServicer):
    def __init__(self):
        self.seen = collections.Counter()          # (service, metric) -> 수신 횟수
        self.latest = {}                           # (service, metric) -> 최근 요약
        self.resources = {}                        # service -> resource 속성

    def Export(self, request, context):
        for rm in request.resource_metrics:
            attrs = {kv.key: kv.value.string_value for kv in rm.resource.attributes}
            svc = attrs.get("service.name", "?")
            self.resources[svc] = attrs
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    key = (svc, m.name)
                    self.seen[key] += 1
                    self.latest[key] = self._summarize(m)
        return pb.ExportMetricsServiceResponse()

    @staticmethod
    def _summarize(m):
        kind = m.WhichOneof("data")
        if kind == "histogram":
            pts = m.histogram.data_points
            if not pts:
                return "히스토그램 (표본 없음)"
            # 지연은 여기서만 보인다 — count 만 있고 sum 이 0 이면 0ms 를 기록하고 있다는 뜻
            parts = []
            for p in pts:
                at = {kv.key: kv.value.string_value for kv in p.attributes}
                lo = f"{p.min:.2f}" if p.HasField("min") else "-"
                hi = f"{p.max:.2f}" if p.HasField("max") else "-"
                parts.append(f"{at or ''} count={p.count} sum={p.sum:.2f} min={lo} max={hi}")
            return " | ".join(parts)
        if kind == "sum":
            return " | ".join(
                f"{ {kv.key: kv.value.string_value for kv in p.attributes} }={p.as_int}"
                for p in m.sum.data_points)
        if kind == "gauge":
            vals = []
            for p in m.gauge.data_points:
                vals.append(f"{p.as_double}" if p.HasField("as_double") else f"{p.as_int}")
            return " | ".join(vals)
        return f"({kind})"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 120.0

    sink = MetricsSink()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    pb_grpc.add_MetricsServiceServicer_to_server(sink, server)
    server.add_insecure_port("0.0.0.0:4317")
    server.start()
    print(f"OTLP/gRPC 수신 대기 0.0.0.0:4317 — {duration:.0f}초")

    try:
        time.sleep(duration)
    except KeyboardInterrupt:
        pass
    server.stop(0)

    if not sink.seen:
        print("\n수신 없음 — 말단의 HW_OTEL_ENDPOINT 와 방화벽을 확인할 것")
        return

    for svc in sorted(sink.resources):
        print(f"\n=== {svc} — resource 속성 ===")
        for k in RESOURCE_KEYS:
            if k in sink.resources[svc]:
                print(f"  {k:22s} = {sink.resources[svc][k]}")
        print(f"=== {svc} — 수신 metric ===")
        for (s, name), n in sorted(sink.seen.items()):
            if s != svc:
                continue
            print(f"  {name:28s} 수신 {n:3d}회")
            print(f"      {sink.latest[(s, name)]}")


if __name__ == "__main__":
    main()
