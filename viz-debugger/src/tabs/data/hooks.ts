// 이식: web-dashboard/src/data/hooks.ts @ 700ed91 — 무수정 (transport 경로만 조정)
/**
 * src/data/hooks.ts
 *
 * React 바인딩. `useSyncExternalStore`만 쓰고 상태 관리 라이브러리는 도입하지 않는다.
 *
 * 여기서 리렌더가 결정되므로 규칙이 하나 있다 —
 * **store가 알릴 때만 리렌더한다.** store는 병합 창(100ms)에서만 알리므로,
 * 20Hz로 들어오는 값이 20Hz 리렌더가 되지 않는다.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getTransport } from '../../transport/index.ts';
import type { ControlLock, ConnectionStatus, RoleInfo } from '../../transport/index.ts';
import { store } from './index.ts';
import { commandTracker, type TrackedCommand } from '../../shared/commandCenter.ts';
import { getBlockLog, subscribeBlocks, type BlockRecord } from './aggregation.ts';
import {
  checkScope,
  refreshRole,
  resolveControlGate,
  roleFeed,
  type ControlGate,
} from './permissions.ts';
import {
  queryMetrics,
  type MetricsMode,
  type MetricsSeries,
} from './metrics.ts';
import { METRICS_AUTO_REFRESH_MS } from './constants.ts';
import type { EntityRecord } from './store.ts';
import { ZoneSummaryFeed, type ZoneSummary } from './summary.ts';

/** 구독 결과 전체. 병합 창이 닫힐 때만 새 스냅샷이 나온다. */
export function useEntities(): ReadonlyMap<string, EntityRecord> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * 발행한 명령의 단계 이력 (VZ-O-02).
 * store가 아니라 추적기를 보는 이유 — store는 채널별 **마지막 값**만 갖는다.
 * 명령 결과는 네 단계가 각각 의미를 갖는 이산 이벤트라 마지막 값만으로는 부족하다.
 */
export function useCommands(): readonly TrackedCommand[] {
  return useSyncExternalStore(commandTracker.subscribe, commandTracker.getSnapshot, commandTracker.getSnapshot);
}

export function useConnectionStatus(): ConnectionStatus {
  const transport = getTransport();
  const [status, setStatus] = useState<ConnectionStatus>(() => transport.getStatus());
  useEffect(() => transport.onStatus(setStatus), [transport]);
  return status;
}

/**
 * VZ-C-01 · VZ-C-04 — 역할과 **그 적용 범위**.
 *
 * 조회 시점은 둘뿐이다 — 연결 수립(로그인)과 명시적 재조회(토큰 갱신).
 * **인터벌이 없는 것이 요구사항 그 자체다.** 역할은 세션 중 거의 바뀌지 않고,
 * 실제 방어선이 백엔드에 있어 화면이 조금 늦게 알아도 보안 위험이 없다.
 */
export function useRole(): RoleInfo | null {
  const role = useSyncExternalStore(roleFeed.subscribe, roleFeed.getSnapshot, roleFeed.getSnapshot);
  const status = useConnectionStatus();

  useEffect(() => {
    if (status.state !== 'open') return;
    void refreshRole();
  }, [status.state]);

  return role;
}

/** 토큰 갱신 상황을 흉내 내는 재조회. 시연에서 범위 변경을 반영할 때 쓴다. */
export function useRoleRefresh(): () => void {
  return useCallback(() => {
    void refreshRole();
  }, []);
}

/**
 * VZ-O-05 + VZ-C-04 — 이 대상을 지금 제어할 수 있는가와 **그 사유들**.
 *
 * 통신 두절 잠금과 권한 범위 밖을 한 판정으로 합쳐 돌려준다. 컴포넌트가 두 조건을
 * 따로 조합하면 대상이 늘 때마다 화면마다 조건이 갈라진다.
 */
export function useControlGate(entityId: string): ControlGate {
  const entities = useEntities();
  const role = useRole();

  const lock = (entities.get(entityId)?.controlLock?.payload as ControlLock | undefined) ?? null;
  const registry = store.getRegistry();

  return useMemo(
    () => resolveControlGate({ lock, scope: checkScope(role, entityId, registry) }),
    [lock, role, entityId, registry],
  );
}

/**
 * VZ-C-03 — 재집약 **차단** 이력.
 * 콘솔이 아니라 화면에 보여야 "계산이 수행되지 않았다"가 확인된다.
 */
export function useReaggregationBlocks(): readonly BlockRecord[] {
  return useSyncExternalStore(subscribeBlocks, getBlockLog, getBlockLog);
}

/**
 * VZ-I-04 — 지표 질의. **요약과 원본이 다른 경로이므로 로딩 상태가 필수다.**
 *
 * 요약은 즉시 오지만 원본은 엣지 중계라 0.5~1초 걸린다. `loading`을 화면이 반드시
 * 표시해야 사용자가 "눌렀는데 아무 일도 안 일어난다"고 느끼지 않는다.
 *
 * 요약 모드에서만 15초 자동 갱신을 건다 — 그게 백엔드 페더레이션 주기와 같아서
 * 그보다 자주 물어도 새 점이 없기 때문이다. 원본은 **사용자가 누를 때만** 간다.
 */
export function useMetricsQuery(params: { entity: string; metric: string; mode: MetricsMode; rangeMin: number }): {
  series: MetricsSeries | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const { entity, metric, mode, rangeMin } = params;
  const [series, setSeries] = useState<MetricsSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let alive = true;

    const run = () => {
      setLoading(true);
      void queryMetrics({ entity, metric, mode, rangeMin, signal: abort.signal }).then((r) => {
        if (!alive) return;
        setLoading(false);
        setError(r.error);
        if (r.series !== null) setSeries(r.series);
      });
    };

    run();

    // 요약만 자동 갱신. 원본을 주기 갱신하면 엣지 중계를 계속 두드리게 된다.
    const timer =
      mode === 'summary'
        ? setInterval(run, METRICS_AUTO_REFRESH_MS)
        : null;

    return () => {
      alive = false;
      abort.abort();
      if (timer !== null) clearInterval(timer);
    };
  }, [entity, metric, mode, rangeMin, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { series, loading, error, reload };
}

/** 구역 요약 — 5초 주기(단, 오프라인 전이 시 즉시). */
export function useZoneSummary(zoneId: string | null): ZoneSummary {
  const feed = useMemo(() => new ZoneSummaryFeed(store, zoneId), [zoneId]);
  return useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
}

/**
 * 리렌더 실측 (검증 항목 2).
 * 렌더될 때마다 세고, 최근 1초 동안의 렌더 횟수를 돌려준다.
 * Profiler를 열지 않고도 "초당 10회를 넘지 않는가"를 화면에서 바로 볼 수 있어야 한다.
 */
export function useRenderRate(): { total: number; perSecond: number } {
  const marks = useRef<number[]>([]);
  const total = useRef(0);

  total.current += 1;
  const now = performance.now();
  marks.current.push(now);
  while (marks.current.length > 0 && now - marks.current[0] > 1000) marks.current.shift();

  return { total: total.current, perSecond: marks.current.length };
}
