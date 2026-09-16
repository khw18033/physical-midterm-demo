// 이식: web-dashboard/src/views/MetricsView.tsx @ 700ed91 — 대본 재생(260831): 도메인 지표 3종 + 위험 수위 선
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

import { useEffect, useState } from 'react';
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
import { useMission } from '../../data/scenario.ts';
import { PendingSource } from '../../shared/PendingSource.tsx';
import { PanelGate } from '../ScenarioGate.tsx';
import { useScenarioCast, useScenarioRender } from '../../shared/renderMode.ts';
import { Explain } from '../../shared/Explain.tsx';

/** 관측 지표를 내는 대상. 구역 요약의 출처다. */
const METRIC_ENTITY = 'edge-node-a';

/**
 * `source` 는 이 지표의 **원천 장비** — scenario 모드에서 그 장비가 대본 cast 에 있을 때만
 * 그래프가 그려진다(자리표시 분기). 도메인 지표 3종(260831)은 관측 지표와 **같은 질의
 * 경로**(/metrics/query · BE-Q-01)로 온다 — 별도 경로를 만들지 않는다.
 */
export const METRICS = [
  { id: 'cpu_pct', label: 'CPU 사용률', unit: '%', source: 'edge-node-a' },
  { id: 'publish_latency_ms', label: '발행 지연', unit: 'ms', source: 'edge-node-a' },
  { id: 'water_level_m', label: '수위', unit: 'm', source: 'sensor-01' },
  { id: 'coverage_pct', label: '커버리지', unit: '%', source: 'camera-02' },
  { id: 'robot_speed_mps', label: '로봇 속도', unit: 'm/s', source: 'robot-01' },
] as const;

export function MetricsView() {
  const [metric, setMetric] = useState<string>(METRICS[0].id);
  const [mode, setMode] = useState<MetricsMode>('summary');
  const [rangeMin, setRangeMin] = useState<number>(RANGE_OPTIONS[0].min);

  // 시나리오 진입 시 **기본 지표를 대본 지표로 자동 전환** (260831 요구 2).
  // 기본 cpu_pct 의 원천(edge-node-a)은 어느 대본 cast 에도 없어, 그대로 두면
  // 시나리오로 들어가도 탭④ 첫 화면이 자리표시다. 축에서 유도한다:
  // 2편(coverage) → 커버리지, 3편(water) → 수위, 1편(speed) → 로봇 속도.
  const scenarioRender = useScenarioRender();
  const scenarioCast = useScenarioCast();
  useEffect(() => {
    if (scenarioCast === null || scenarioRender === null) return;
    const preferred = scenarioRender.axes.has('coverage')
      ? 'coverage_pct'
      : scenarioRender.axes.has('water')
        ? 'water_level_m'
        : scenarioRender.axes.has('speed')
          ? 'robot_speed_mps'
          : null;
    if (preferred !== null) setMetric(preferred);
  }, [scenarioRender?.missionId, scenarioCast === null]);

  const { series, loading, error, reload } = useMetricsQuery({
    entity: METRIC_ENTITY,
    metric,
    mode,
    rangeMin,
  });

  const unit = METRICS.find((m) => m.id === metric)?.unit ?? '';
  const source = METRICS.find((m) => m.id === metric)?.source ?? METRIC_ENTITY;
  const notice = heavyQueryNotice(mode, rangeMin);
  // 위험 수위 선 — 대본 params 에서 읽는다 (3편 danger_level_m · 지어내지 않는다).
  const mission = useMission();
  const dangerLevel = metric === 'water_level_m'
    ? ((mission.current.params.danger_level_m as number | undefined) ?? null)
    : null;

  return (
    <main className="board">
      <header className="board__head">
        <div>
          <h1 className="board__title">지표 조회 — 요약과 원본은 다른 경로다</h1>
          <Explain id="met-1" className="board__sub">
            평시에 올라오는 것은 <strong>구역 요약</strong>이고 원본은 엣지에 남는다. 원본이 필요하면 질의 프록시가
            엣지로 <strong>중계</strong>하므로 느리다
          </Explain>
        </div>
        <div className="board__meta">
          <span>VZ-I-04 · VZ-C-03</span>
        </div>
      </header>

      {/* 관측 지표(observability)는 어느 대본도 몰지 않는다 — 시나리오 모드에서는 패널째 접힌다
          (260901 층 2). 8/31까지는 안쪽 칸만 「해당 없음」이고 제목·표기 각주는 남아 있었다. */}
      <PanelGate id="metrics-push"><LiveSummaryCard /></PanelGate>

      <PanelGate id="metrics-query">
      <section className="panel panel--wide">
        <header className="panel__head">
          <h2 className="panel__title">
            {METRICS.find((m) => m.id === metric)?.label} · {METRIC_ENTITY}
          </h2>
          <span className="panel__tag">VZ-I-04</span>
        </header>

        <div className="qbar">
          <span className="qbar__group">
            {METRICS.map((m) => {
              // 대본과 무관한 지표(원천이 cast 밖)는 흐리게 — 누르면 자리표시가 뜰 자리다.
              const dimmed = scenarioCast !== null && !scenarioCast.has(m.source);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={'btn btn--small' + (metric === m.id ? ' btn--on' : '') + (dimmed ? ' btn--dim' : '')}
                  title={dimmed ? '이 대본이 몰지 않는 지표입니다 — 원천 ' + m.source : undefined}
                  onClick={() => setMetric(m.id)}
                >
                  {m.label}
                </button>
              );
            })}
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

        <PendingSource id="metrics-query" minHeight={260} entity={source} axis={source === METRIC_ENTITY ? 'observability' : undefined}>
          {series !== null && (
            <>
              <SeriesChart series={series} unit={unit} loading={loading} dangerLevel={dangerLevel} />
              <SeriesMeta series={series} unit={unit} />
            </>
          )}

          {series === null && !loading && error === null && <p className="muted">조회 결과가 없다.</p>}
        </PendingSource>

        <Explain id="met-2" className="note">
          요약은 백엔드가 <strong>{METRICS_AUTO_REFRESH_MS / 1000}초 페더레이션 주기</strong>로 이미 당겨 둔 값이라
          그보다 촘촘히 물어도 새 점이 없다. 그래서 열린 패널의 자동 갱신도 같은 주기이고,
          <strong> 원본에는 자동 갱신을 걸지 않는다</strong> — 주기 갱신이 사설망 왕복을 계속 두드리는 일이 되기 때문이다.
        </Explain>
      </section>
      </PanelGate>

      <BlindspotAges />

      <ReaggregationPanel />
    </main>
  );
}

/**
 * 사각지대별 「마지막 탐지 이후 경과」 (260831 · 2편 탭④ 요구 — 8/31 점검에서 채움).
 *
 * 커버리지 % 시계열과 같은 원천(coverage 채널)의 **현재 경과 판독**이다 — 지금이
 * 대본 시각으로 언제이고, 각 칸이 마지막으로 탐지된 지 얼마나 됐는지. 재탐색 임계
 * (600초)를 넘은 칸은 「경과 초과」로 갈린다. 대본이 커버리지를 몰 때만 그린다 —
 * 평소의 자리(A · 백엔드 DT-05 시의성)는 위 조회 자리표시가 이미 말하고 있다.
 */
function BlindspotAges() {
  const mission = useMission();
  const entities = useEntities();
  const scenarioActive = mission.current.map !== null;
  const camera = mission.current.map?.camera.entity ?? null;
  const coverage = camera !== null
    ? ((entities.get(camera)?.coverage?.payload ?? null) as {
        rescan_threshold_sec?: number | null;
        cells?: Array<{ cell: string; last_scan_at_sec: number | null }>;
      } | null)
    : null;

  if (!scenarioActive || coverage?.cells === undefined || coverage.cells.length === 0) return null;

  const threshold = coverage.rescan_threshold_sec ?? null;
  const nowSec = mission.headSec; // 대본 시각 — 재생 머리. 트윈 시의성(DT-05)의 축과 같다.

  return (
    <section className="panel panel--wide">
      <header className="panel__head">
        <h2 className="panel__title">사각지대별 마지막 탐지 이후 경과 — {mission.current.missionId}</h2>
        <span className="panel__tag">VZ-I-04 · 대본 합성 (실원천 DT-05)</span>
      </header>
      <table className="agestable">
        <thead>
          <tr><th>칸</th><th>마지막 탐지</th><th>경과 (대본 시각 T+{Math.round(nowSec)}s 기준)</th><th>판정</th></tr>
        </thead>
        <tbody>
          {coverage.cells.map((cell) => {
            const age = cell.last_scan_at_sec === null ? null : Math.max(0, Math.round(nowSec - cell.last_scan_at_sec));
            const over = age !== null && threshold !== null && age > threshold;
            return (
              <tr key={cell.cell} className={over ? 'agestable__row--over' : undefined}>
                <td><code>{cell.cell}</code></td>
                <td>{cell.last_scan_at_sec === null ? '미탐색' : `T+${cell.last_scan_at_sec}s`}</td>
                <td>{age === null ? '—' : `${age}s`}</td>
                <td>{cell.last_scan_at_sec === null ? '아직 탐색 전' : over ? `경과 초과 — 재탐색 대상 (임계 ${threshold}s)` : '최신'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Explain id="met-3" className="note note--dim">
        커버리지 % 시계열(위 조회)과 같은 coverage 채널에서 나온 현재 판독입니다. 경과가
        {threshold ?? 600}초를 넘으면 대본이 재탐색을 파생 2회차로 일으킵니다 — 탭①의
        derived 사건과 같은 이야기입니다. 실제 원천은 백엔드 트윈 시의성 판정(DT-05)입니다.
      </Explain>
    </section>
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

      {/* 관측 지표는 어느 대본도 몰지 않는다 — 평시 ObservabilityEmitter 의 몫 (260831 요구 2). */}
      <PendingSource id="metrics-push" minHeight={110} entity={METRIC_ENTITY} axis="observability">
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
      </PendingSource>

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
function SeriesChart({ series, unit, loading, dangerLevel = null }: { series: MetricsSeries; unit: string; loading: boolean; dangerLevel?: number | null }) {
  const W = 900;
  const H = 200;
  const PAD = 8;

  const points: MetricPoint[] = series.points;
  const extent = seriesExtent(points);
  // 위험 수위 선(260831 · 3편)이 화면 밖으로 나가지 않게 축에 포함한다.
  const min = dangerLevel === null ? extent.min : Math.min(extent.min, dangerLevel);
  const max = dangerLevel === null ? extent.max : Math.max(extent.max, dangerLevel);

  const yOf = (value: number) => H - PAD - ((value - min) / Math.max(1e-9, max - min)) * (H - PAD * 2);
  const path = points
    .map((p, i) => {
      const x = PAD + (i / Math.max(1, points.length - 1)) * (W - PAD * 2);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + yOf(p.value).toFixed(1);
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
          {dangerLevel !== null && <> · 위험 수위 {dangerLevel} {unit} (대본 params)</>}
        </span>
      </div>
      <svg className="chart__svg" viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio="none" role="img">
        {/* 위험 수위 선 — 상승 30초·유지 10초·하락 3분 구간이 이 선 기준으로 읽힌다 (3편). */}
        {dangerLevel !== null && (
          <line className="chart__danger" x1={PAD} x2={W - PAD} y1={yOf(dangerLevel)} y2={yOf(dangerLevel)} />
        )}
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
        <Explain id="met-4" className="note note--dim">
          앞의 둘은 <strong>필드 이름이 어긋난 생산자</strong>를 흉내 낸다. 뱃지가 "원본"이 아니라
          <strong> "표기 불명"</strong> 으로 떠야 하고, 평균을 적용하면 사유가 <strong>"표기를 읽을 수 없음"</strong> 으로
          갈려야 한다. "원본"으로 뜬다면 가드가 조용히 꺼진 것이다.
        </Explain>
      </div>

      <Explain id="met-5" className="note">
        집약 연산은 반드시 <code>guardedMean()</code> / <code>guardedSum()</code> 을 거치게 해서 검사를 빠뜨릴 수
        없게 만들었다. 개발 모드 여부를 보지 않는다 — <strong>운영에서만 조용히 통과하는 것</strong>이 가장 위험한
        조합이기 때문이다. 못 읽는 표기도 같은 이유로 막는다 — <strong>판단이 안 되는 값에 계산하지 않는다.</strong>
      </Explain>
    </section>
  );
}
