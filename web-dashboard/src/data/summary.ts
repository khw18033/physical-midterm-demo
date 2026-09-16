/**
 * src/data/summary.ts
 *
 * 구역별 장치 현황판 **요약** 갱신 (VZ-U-01).
 *
 * 카드 하나하나는 100ms 병합 창으로 갱신되지만, 상단의 구역 집계(정상 N · 장애 N · …)는
 * 5초다. 엣지노드의 구역 단위 상태 요약이 5초 1회 갱신(HW-C-04)이고 센서노드 하트비트도
 * 5초(HW-S-05)라, 그보다 자주 그려도 값이 같기 때문이다.
 *
 * **단, 오프라인 감지는 즉시다.** 5초 주기를 기다리는 동안 관제사가 이미 끊긴 장비를 보고
 * 판단하게 두면 안 되므로, 즉시 반영 전이가 발생하면 주기를 건너뛰고 다시 센다.
 */

import { ZONE_BOARD_REFRESH_MS } from './constants.ts';
import { deriveDisplayStatus, type DisplayStatus } from './statusModel.ts';
import type { DataStore, EntityRecord } from './store.ts';

export type ZoneSummary = {
  counts: Record<DisplayStatus, number>;
  total: number;
  /** 이 집계를 만든 시각(클라이언트 로컬 시각 — 표시가 아니라 "언제 셌나"의 표시용). */
  countedAt: number;
  /** 마지막 집계가 주기 도래가 아니라 즉시 반영으로 일어났는가. */
  immediate: boolean;
};

function count(records: Iterable<EntityRecord>, zoneId: string | null): ZoneSummary['counts'] {
  const counts: ZoneSummary['counts'] = { normal: 0, fault: 0, not_deployed: 0, unknown: 0 };
  for (const rec of records) {
    if (zoneId !== null && rec.registry?.zone !== zoneId) continue;
    counts[deriveDisplayStatus(rec.state?.payload ?? null)] += 1;
  }
  return counts;
}

export class ZoneSummaryFeed {
  private readonly store: DataStore;
  private readonly zoneId: string | null;
  private readonly listeners = new Set<() => void>();

  private snapshot: ZoneSummary;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubStore: (() => void) | null = null;
  /** 직전에 본 즉시 반영 횟수. 늘어났으면 주기를 기다리지 않는다. */
  private seenImmediate = 0;

  constructor(store: DataStore, zoneId: string | null) {
    this.store = store;
    this.zoneId = zoneId;
    this.snapshot = this.compute(false);
  }

  private compute(immediate: boolean): ZoneSummary {
    const counts = count(this.store.getSnapshot().values(), this.zoneId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { counts, total, countedAt: Date.now(), immediate };
  }

  private recount(immediate: boolean): void {
    const next = this.compute(immediate);
    const prev = this.snapshot;
    // 값이 같으면 스냅샷을 갈지 않는다 — 5초마다 헛 리렌더를 만들 이유가 없다.
    const same =
      prev.total === next.total &&
      (Object.keys(next.counts) as DisplayStatus[]).every((k) => prev.counts[k] === next.counts[k]);
    if (same) return;

    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    if (this.listeners.size === 1) {
      this.timer = setInterval(() => this.recount(false), ZONE_BOARD_REFRESH_MS);
      this.unsubStore = this.store.subscribe(() => {
        // 오프라인·판단불가 전이로 즉시 플러시된 경우에만 주기를 앞당긴다.
        const immediate = this.store.merge.stats().immediate;
        if (immediate !== this.seenImmediate) {
          this.seenImmediate = immediate;
          this.recount(true);
        }
      });
      this.recount(false);
    }

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        this.unsubStore?.();
        this.unsubStore = null;
      }
    };
  };

  getSnapshot = (): ZoneSummary => this.snapshot;
}
