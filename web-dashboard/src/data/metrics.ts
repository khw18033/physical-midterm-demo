/**
 * src/data/metrics.ts
 *
 * VZ-I-04 — 지표 질의 (BE-Q-01 질의 프록시).
 *
 * ── 15초의 의미가 바뀌었다
 *
 * 숫자는 그대로지만 근거가 다르다. 예전 근거는 "하드웨어가 15초마다 수집하니 그보다 자주
 * 물어도 새 점이 없다"였는데, 확정된 계약에서 15초는 **백엔드가 엣지에서 요약을 끌어오는
 * 페더레이션 주기**다(BE-S-03). 그리고 더 중요하게, 평시에 받는 것은 **원본이 아니라
 * 구역 요약**이다.
 *
 * ── 그래서 경로가 둘이다
 *
 *  - **요약 질의** : 백엔드가 이미 당겨 둔 구역 요약. 즉시 응답. `aggregated`.
 *  - **원본 질의** : raw는 엣지에 남아 있어 질의 프록시가 엣지로 **중계**한다(BE-T-05).
 *                    느리다. 그래서 화면은 "가져오는 중"을 반드시 표시해야 한다.
 *
 * 브라우저는 지표 저장소에 직접 접근하지 않는다 — 자격 증명 은닉·권한·rate limit이
 * 백엔드에 있기 때문이다. 그래서 여기에도 저장소 주소가 없다.
 */

import { GATEWAY } from '../transport/index.ts';
import type { WireMetricsQuery } from '../transport/index.ts';
import { aggregationBadge, normalizeAggregation, type Aggregation, type AggregationBadge } from './aggregation.ts';

export type MetricsMode = 'summary' | 'raw';

export const METRICS_MODE_LABEL: Record<MetricsMode, string> = {
  summary: '구역 요약',
  raw: '원본',
};

export type MetricPoint = { t: string; value: number };

export type MetricsSeries = {
  entity: string;
  metric: string;
  mode: MetricsMode;
  rangeMin: number;
  points: MetricPoint[];
  /** 이 시계열이 원본인지 요약인지. **화면은 이 값으로 재집약을 막는다.** */
  aggregation: Aggregation;
  /** 화면에 그대로 다는 표시용 표기. 컴포넌트가 문자열을 조립하지 않게 여기서 만든다. */
  badge: AggregationBadge;
  /** 어느 경로로 왔는가. 원본은 엣지 중계를 경유한다. */
  via: string;
  /** 중계에 걸린 시간(ms). 요약은 0이다. */
  relayMs: number;
  pointIntervalSec: number;
  /** 무거운 질의였는가. 화면이 안내를 띄우는 근거. */
  heavy: boolean;
  heavyReason: string | null;
  /** 조회 시각(서버가 기록한 요청 시각). */
  requestedAt: string;
};

export type MetricsQueryOutcome = {
  series: MetricsSeries | null;
  error: string | null;
};

/** 조회 범위 선택지. 원본 질의에서 넓은 범위가 무겁다는 것을 화면이 알려야 한다. */
export const RANGE_OPTIONS = [
  { min: 15, label: '15분' },
  { min: 60, label: '1시간' },
  { min: 180, label: '3시간' },
] as const;

/** 이 범위를 넘는 **원본** 질의는 무겁다. 서버 판정과 같은 기준을 화면도 미리 안내한다. */
export const HEAVY_RANGE_MIN = 60;

/**
 * 지표 질의.
 *
 * **원본 질의는 느리다.** 호출부는 이 Promise가 도는 동안 "가져오는 중"을 반드시
 * 화면에 표시해야 한다 — 엣지 중계 왕복이 실제로 0.5~1초 걸리기 때문이다.
 */
export async function queryMetrics(params: {
  entity: string;
  metric: string;
  mode: MetricsMode;
  rangeMin: number;
  signal?: AbortSignal;
}): Promise<MetricsQueryOutcome> {
  const url =
    GATEWAY.http +
    '/metrics/query?entity=' + encodeURIComponent(params.entity) +
    '&metric=' + encodeURIComponent(params.metric) +
    '&mode=' + params.mode +
    '&range_min=' + String(params.rangeMin);

  try {
    const res = await fetch(url, { signal: params.signal });
    if (!res.ok) return { series: null, error: '지표 질의 응답 ' + res.status };

    const body = (await res.json()) as WireMetricsQuery;
    // 표기 해석은 aggregation.ts 한 곳에서만. 컴포넌트는 정규화된 값과 뱃지만 받는다.
    const aggregation = normalizeAggregation(body.aggregation);

    return {
      series: {
        entity: body.query.entity,
        metric: body.query.metric,
        mode: body.query.mode,
        rangeMin: body.query.range_min,
        points: body.points,
        aggregation,
        badge: aggregationBadge(aggregation),
        via: body.route.via,
        relayMs: body.route.relay_ms,
        pointIntervalSec: body.point_interval_sec,
        heavy: body.heavy,
        heavyReason: body.heavy_reason,
        requestedAt: body.query.requested_at,
      },
      error: null,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return { series: null, error: null };
    // 지표 저장소에 닿지 못해도 화면 자체는 살아 있어야 한다 (VZ-C-02).
    return { series: null, error: '지표 질의 실패 — ' + String(e) };
  }
}

/**
 * 넓은 범위의 원본 질의에 대한 사전 안내.
 * 서버도 같은 판정을 하지만, **누르기 전에** 알려야 사용자가 범위를 줄일 기회가 있다.
 */
export function heavyQueryNotice(mode: MetricsMode, rangeMin: number): string | null {
  if (mode !== 'raw' || rangeMin <= HEAVY_RANGE_MIN) return null;
  return (
    '원본 질의를 ' + rangeMin + '분 범위로 걸면 무겁다 — 원본은 1초 간격이라 요약(15초)보다 ' +
    '점이 약 15배 많고, 엣지 원본 저장소까지 중계를 거친다.'
  );
}

/**
 * 요약 시계열의 통계값.
 *
 * **평균을 다시 내지 않는다.** 요약값의 평균은 가중치가 무너진 수라서, 여기서는
 * 최소·최대·마지막 값처럼 **재집약이 아닌** 값만 뽑는다. 평균이 필요하면 원본을 받아야 한다.
 */
export function seriesExtent(points: MetricPoint[]): { min: number; max: number; last: number | null } {
  if (points.length === 0) return { min: 0, max: 1, last: null };
  let min = points[0].value;
  let max = points[0].value;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  // 값이 평평하면 선이 축에 붙어 안 보이므로 여백을 준다.
  if (max - min < 1e-6) {
    min -= 1;
    max += 1;
  }
  return { min, max, last: points[points.length - 1].value };
}
