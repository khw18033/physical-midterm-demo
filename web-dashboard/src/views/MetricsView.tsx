/**
 * src/views/MetricsView.tsx
 *
 * VZ-I-04 지표 질의 · VZ-C-03 집약 계층 표기.
 *
 * 이 화면이 존재하는 이유는 하나다 — **지금 보는 값이 요약인지 원본인지가 보여야 한다.**
 *
 * 평시에 올라오는 지표는 이미 구역 요약이다(BE-S-03). 그걸 모르고 보면 "원본을 보고 있다"고
 * 착각하게 되고, 그 착각 위에서 평균을 한 번 더 내면 틀린 숫자가 조용히 만들어진다.
 * 그래서 값 옆에 **계층과 창 크기**를 붙이고, 원본이 필요하면 다른 경로로 가야 한다는 것을
 * 화면이 말한다.
 *
 * 차트 라이브러리를 새로 들이지 않았다 — 필요한 것은 점 몇 개를 잇는 선 하나이고,
 * 그건 인라인 SVG로 충분하다.
 */

import { useState } from 'react';
import {
  METRICS_AUTO_REFRESH_MS,
  METRICS_MODE_LABEL,
  RANGE_OPTIONS,
  BLOCK_REASON_LABEL,
  aggregationBadge,
  guardedMean,
  heavyQueryNotice,
  playScenario,
  seriesExtent,
  type MetricPoint,
  type MetricsMode,
  type MetricsSeries,
} from '../data/index.ts';
import { getBlockLog } from '../data/index.ts';
import { useEntities, useMetricsQuery, useReaggregationBlocks } from '../data/hooks.ts';

/** 관측 지표를 내는 대상. 구역 요약의 출처다. */
const METRIC_ENTITY = 'edge-node-a';

const METRICS = [
  { id: 'cpu_pct', label: 'CPU 사용률', unit: '%' },
  { id: 'publish_latency_ms', label: '발행 지연', unit: 'ms' },
] as const;

export function MetricsView() {
  const [metric, setMetric] = useState<string>(METRICS[0].id);
  const [mode, setMode] = useState<MetricsMode>('summary');
  const [rangeMin, setRangeMin] = useState<number>(RANGE_OPTIONS[0].min);

  const { series, loading, error, reload } = useMetricsQuery({
    entity: METRIC_ENTITY,
    metric,
    mode,
    rangeMin,
  });

  const unit = METRICS.find((m) => m.id === metric)?.unit ?? '';
  const notice = heavyQueryNotice(mode, rangeMin);

  return (
    <main className="board">
      <header className="board__head">
        <div>
          <h1 className="board__title">지표 조회 — 요약과 원본은 다른 경로다</h1>
          <p className="board__sub">
            평시에 올라오는 것은 <strong>구역 요약</strong>이고 원본은 엣지에 남는다. 원본이 필요하면 질의 프록시가
            엣지로 <strong>중계</strong>하므로 느리다
          </p>
        </div>
        <div className="board__meta">
          <span>VZ-I-04 · VZ-C-03</span>
        </div>
      </header>

      <LiveSummaryCard />

      <section className="panel panel--wide">
        <header className="panel__head">
          <h2 className="panel__title">
            {METRICS.find((m) => m.id === metric)?.label} · {METRIC_ENTITY}
          </h2>
          <span className="panel__tag">VZ-I-04</span>
        </header>

        <div className="qbar">
          <span className="qbar__group">
            {METRICS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={'btn btn--small' + (metric === m.id ? ' btn--on' : '')}
                onClick={() => setMetric(m.id)}
              >
                {m.label}
              </button>
            ))}
          </span>

          <span className="qbar__group">
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.min}
                type="button"
                className={'btn btn--small' + (rangeMin === r.min ? ' btn--on' : '')}
                onClick={() => setRangeMin(r.min)}
              >
                {r.label}
              </button>
            ))}
          </span>

          {/* **원본 보기 전환.** 누르면 다른 경로로 다시 질의한다. */}
          <span className="qbar__group qbar__group--mode">
            {(['summary', 'raw'] as MetricsMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={'btn btn--small' + (mode === m ? ' btn--on' : '') + (m === 'raw' ? ' btn--raw' : '')}
                onClick={() => setMode(m)}
              >
                {m === 'raw' ? '원본 보기' : '요약 보기'}
              </button>
            ))}
            <button type="button" className="btn btn--tiny" onClick={reload}>
              다시 조회
            </button>
          </span>
        </div>

        {notice !== null && <p className="notice notice--warn">{notice}</p>}

        {/* **가져오는 중임이 반드시 보여야 한다** — 원본은 엣지 중계라 0.5~1초 걸린다. */}
        {loading && (
          <p className="notice notice--busy">
            <span className="spinner" aria-hidden="true" />
            {mode === 'raw'
              ? '원본을 가져오는 중 — 질의 프록시가 엣지 원본 저장소로 중계하고 있다 (BE-Q-01 → BE-T-05)'
              : '요약을 가져오는 중'}
          </p>
        )}

        {error !== null && <p className="notice notice--warn">{error}</p>}

        {series !== null && (
          <>
            <SeriesChart series={series} unit={unit} loading={loading} />
            <SeriesMeta series={series} unit={unit} />
          </>
        )}

        {series === null && !loading && error === null && <p className="muted">조회 결과가 없다.</p>}

        <p className="note">
          요약은 백엔드가 <strong>{METRICS_AUTO_REFRESH_MS / 1000}초 페더레이션 주기</strong>로 이미 당겨 둔 값이라
          그보다 촘촘히 물어도 새 점이 없다. 그래서 열린 패널의 자동 갱신도 같은 주기이고,
          <strong> 원본에는 자동 갱신을 걸지 않는다</strong> — 주기 갱신이 사설망 왕복을 계속 두드리는 일이 되기 때문이다.
        </p>
      </section>

      <ReaggregationPanel />
    </main>
  );
}

/**
 * 푸시로 들어오는 평시 지표. **여기 붙은 표기가 이번 수정의 요점이다** —
 * 이 값은 원본이 아니라 15초 창의 구역 요약이다.
 */
function LiveSummaryCard() {
  const entities = useEntities();
  const slot = entities.get(METRIC_ENTITY)?.metrics ?? null;

  if (slot === null) {
    return (
      <section className="panel">
        <p className="muted">
          평시 지표 봉투를 아직 받지 못했다. 페더레이션 주기가 {METRICS_AUTO_REFRESH_MS / 1000}초이므로 잠시 기다릴 것.
        </p>
      </section>
    );
  }

  const payload = slot.payload as {
    cpu_pct?: { value: number };
    publish_latency_ms?: { value: number };
    sample_count?: number;
  };
  // 표기 해석은 데이터 레이어가 이미 끝냈다. 컴포넌트는 표시용 형태만 받는다.
  const badge = aggregationBadge(slot.aggregation);

  return (
    <section className="panel panel--wide">
      <header className="panel__head">
        <h2 className="panel__title">평시 지표 (푸시) — {METRIC_ENTITY}</h2>
        <span className="panel__tag">VZ-C-03</span>
      </header>

      <div className="statrow">
        <div className="stat">
          <span className="stat__value">{payload.cpu_pct?.value.toFixed(1) ?? '—'}</span>
          <span className="stat__unit">%</span>
          <span className="stat__label">CPU 사용률</span>
          <span className={'aggbadge aggbadge--' + badge.state} title={badge.title}>
            {badge.short}
          </span>
        </div>
        <div className="stat">
          <span className="stat__value">{payload.publish_latency_ms?.value.toFixed(1) ?? '—'}</span>
          <span className="stat__unit">ms</span>
          <span className="stat__label">발행 지연</span>
          <span className={'aggbadge aggbadge--' + badge.state} title={badge.title}>
            {badge.short}
          </span>
        </div>
      </div>

      {/* 세 갈래로 갈라 쓴다. 'unknown'을 원본 쪽에 묶으면 화면이 "원본 측정값이다"라고
          거짓을 말하게 된다 — 실은 원본인지 아닌지 모르는 상태다. */}
      <p className={'note' + (badge.state === 'unknown' ? ' note--unknown' : '')}>
        {badge.state === 'aggregated' && (
          <>
            이 값은 <strong>원본이 아니다.</strong> 엣지가 raw를 로컬 보관하고 구역 요약만 백엔드로 올린다(BE-S-03).
            {payload.sample_count !== undefined && <> 이 요약은 원본 {payload.sample_count}개 표본에서 나왔다.</>}
          </>
        )}
        {badge.state === 'raw' && <>원본 측정값이다.</>}
        {badge.state === 'unknown' && (
          <>
            <strong>집약 표기를 읽을 수 없다.</strong> 이 값이 원본인지 집약인지 판단할 수 없으므로 집약 연산이
            차단된다. 생산자의 표기 형식이 계약(BE-S-06)과 어긋났다는 신호다.
          </>
        )}
      </p>
    </section>
  );
}

/** 인라인 SVG 선 하나. 라이브러리를 들일 만한 그림이 아니다. */
function SeriesChart({ series, unit, loading }: { series: MetricsSeries; unit: string; loading: boolean }) {
  const W = 900;
  const H = 200;
  const PAD = 8;

  const points: MetricPoint[] = series.points;
  const { min, max } = seriesExtent(points);

  const path = points
    .map((p, i) => {
      const x = PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
      const y = H - PAD - ((p.value - min) / (max - min)) * (H - PAD * 2);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    })
    .join(' ');

  return (
    <div className={'chart' + (loading ? ' chart--loading' : '')}>
      <div className="chart__head">
        <span className={'aggbadge aggbadge--' + series.badge.state} title={series.badge.title}>
          {series.badge.short}
        </span>
        <span className="chart__scale">
          {min.toFixed(1)} ~ {max.toFixed(1)} {unit} · 점 {points.length}개 · 간격 {series.pointIntervalSec}초
        </span>
      </div>
      <svg className="chart__svg" viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio="none" role="img">
        <path className={'chart__line chart__line--' + series.badge.state} d={path} />
      </svg>
    </div>
  );
}

/** 이 시계열이 **어디서 어떻게** 왔는지. 요약과 원본을 가르는 근거를 화면에 남긴다. */
function SeriesMeta({ series, unit }: { series: MetricsSeries; unit: string }) {
  const extent = seriesExtent(series.points);
  return (
    <>
      <dl className="kv kv--wide">
        <dt>조회 경로</dt>
        <dd>{series.via}</dd>
        <dt>표기</dt>
        <dd>
          <strong>{METRICS_MODE_LABEL[series.mode]}</strong>
          {/* 원본은 계층·창이 없으므로 뱃지를 덧붙이면 같은 말이 두 번 나온다. */}
          {series.badge.state === 'aggregated' && <> · 집약 계층 {series.badge.short.replace('요약 · ', '')}</>}
          {series.badge.state === 'unknown' && <> · <strong>표기를 읽을 수 없다</strong></>}
        </dd>
        <dt>중계 지연</dt>
        <dd>
          {series.relayMs === 0 ? (
            <span className="muted">0 ms — 백엔드가 이미 당겨 둔 값이라 중계가 없다</span>
          ) : (
            <strong>{series.relayMs} ms</strong>
          )}
        </dd>
        <dt>마지막 값</dt>
        <dd>
          {extent.last === null ? '—' : extent.last.toFixed(1) + ' ' + unit}
        </dd>
      </dl>

      {series.heavy && series.heavyReason !== null && (
        <p className="notice notice--warn">무거운 질의 — {series.heavyReason}</p>
      )}
    </>
  );
}

/**
 * VZ-C-03 검증 — 집약값에 평균을 적용해 본다.
 *
 * **경고가 아니라 차단이다.** 누르면 계산이 수행되지 않고, 그 사실이 콘솔이 아니라
 * 화면에 남는다. 재집약 오류는 화면상으로 드러나지 않아 발견이 늦으므로,
 * 차단됐다는 것 자체가 보여야 검증이 성립한다.
 */
function ReaggregationPanel() {
  const entities = useEntities();
  const blocks = useReaggregationBlocks();
  const [lastResult, setLastResult] = useState<string | null>(null);

  const slot = entities.get(METRIC_ENTITY)?.metrics ?? null;

  const probe = () => {
    if (slot === null) {
      setLastResult('아직 지표 봉투를 받지 못했다. 페더레이션 주기가 15초이므로 잠시 기다릴 것.');
      return;
    }
    const payload = slot.payload as { cpu_pct?: { value: number } };
    const value = payload.cpu_pct?.value ?? 0;
    const result = guardedMean(
      [{ value, aggregation: slot.aggregation }],
      METRIC_ENTITY + '/metrics.cpu_pct',
    );
    // 차단 사유는 데이터 레이어가 판정한다. 화면은 방금 남은 이력에서 읽어 표시만 한다.
    const reason = getBlockLog()[0]?.reason ?? null;
    setLastResult(
      result === null
        ? '계산이 수행되지 않았다 (반환값 null) — 차단 사유: ' +
          (reason === null ? '알 수 없음' : BLOCK_REASON_LABEL[reason])
        : '계산 수행됨 — 평균 ' + result.toFixed(2) + ' (원본 값이라 허용된다)',
    );
  };

  return (
    <section className="panel panel--wide">
      <header className="panel__head">
        <h2 className="panel__title">재집약 차단 확인</h2>
        <span className="panel__tag">VZ-C-03</span>
      </header>

      <button type="button" className="btn btn--probe" onClick={probe}>
        지금 값에 평균 적용 시도
      </button>

      {lastResult !== null && (
        <p className={'notice' + (lastResult.includes('수행되지 않았다') ? ' notice--blocked' : '')}>{lastResult}</p>
      )}

      {blocks.length > 0 && (
        <>
          <h3 className="devpanel__title">차단 이력 {blocks.length}건</h3>
          <ul className="blocklist">
            {/* 두 사유가 눈으로 갈려야 한다 — 통합 때 대응이 다르다.
                'aggregated'는 원본 질의로 우회하면 되고, 'unknown'은 계약을 맞춰야 한다. */}
            {blocks.slice(0, 5).map((b, i) => (
              <li key={i} className={'blocklist__item blocklist__item--' + b.reason}>
                <span className={'blockreason blockreason--' + b.reason}>{BLOCK_REASON_LABEL[b.reason]}</span>
                <code>{b.operation}</code> · {b.context}
                <div className="muted">{b.message}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="devpanel devpanel--inline">
        <h3 className="devpanel__title">계약 밖 표기 주입 — 가드가 실제로 도는지 확인</h3>
        <div className="devpanel__row">
          <button type="button" className="btn btn--small" onClick={() => playScenario('agg-unlabeled')}>
            kind 없이 발행
          </button>
          <button type="button" className="btn btn--small" onClick={() => playScenario('agg-odd-string')}>
            문자열 'aggregated' 로 발행
          </button>
          <button type="button" className="btn btn--small" onClick={() => playScenario('agg-normal')}>
            정식 표기로 복귀
          </button>
        </div>
        <p className="note note--dim">
          앞의 둘은 <strong>필드 이름이 어긋난 생산자</strong>를 흉내 낸다. 뱃지가 "원본"이 아니라
          <strong> "표기 불명"</strong> 으로 떠야 하고, 평균을 적용하면 사유가 <strong>"표기를 읽을 수 없음"</strong> 으로
          갈려야 한다. "원본"으로 뜬다면 가드가 조용히 꺼진 것이다.
        </p>
      </div>

      <p className="note">
        집약 연산은 반드시 <code>guardedMean()</code> / <code>guardedSum()</code> 을 거치게 해서 검사를 빠뜨릴 수
        없게 만들었다. 개발 모드 여부를 보지 않는다 — <strong>운영에서만 조용히 통과하는 것</strong>이 가장 위험한
        조합이기 때문이다. 못 읽는 표기도 같은 이유로 막는다 — <strong>판단이 안 되는 값에 계산하지 않는다.</strong>
      </p>
    </section>
  );
}
