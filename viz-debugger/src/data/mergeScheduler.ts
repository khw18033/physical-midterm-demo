// 이식: web-dashboard/src/data/mergeScheduler.ts @ 605eb73 — 무수정
/**
 * src/data/mergeScheduler.ts
 *
 * 렌더 병합 계층 (VZ-I-01). **명시적 모듈로 둔 이유**: 병합을 store 안에 숨겨 두면
 * "왜 화면이 100ms 늦나"를 나중에 아무도 못 찾고, 창 크기를 바꾸려 할 때 어디를 고칠지 모른다.
 *
 * 규칙 셋.
 *  1. **데이터는 전량 받는다.** 병합은 수신을 버리는 것이 아니라 *알림*만 묶는 것이다.
 *     store는 매 수신마다 갱신되고, 구독자에게 알리는 시점만 창으로 모은다.
 *  2. 창이 열려 있는 동안 몇 건이 오든 알림은 1회다. → 초당 최대 10회.
 *  3. **즉시 반영이 필요한 전이는 창을 건너뛴다.** 오프라인 감지가 100ms 늦는 것은
 *     상관없지만, 규칙을 코드에 남겨 두어야 나중에 창을 늘릴 때 실수하지 않는다.
 */

import { RENDER_MERGE_WINDOW_MS } from './constants.ts';

export class MergeScheduler {
  private readonly windowMs: number;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** 관측용 카운터. 화면 하단 계측 배지가 읽는다. */
  private received = 0;
  private flushed = 0;
  private immediate = 0;

  constructor(windowMs: number = RENDER_MERGE_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 수신 1건을 표시. 창이 닫혀 있으면 연다. */
  mark(): void {
    this.received += 1;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit();
    }, this.windowMs);
  }

  /**
   * 창을 기다리지 않고 지금 알린다.
   * 오프라인·stale 전이처럼 **늦게 알면 관제 판단이 틀어지는** 변화에만 쓴다.
   */
  flushNow(): void {
    this.received += 1;
    this.immediate += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit();
  }

  private emit(): void {
    this.flushed += 1;
    for (const l of this.listeners) l();
  }

  stats(): { received: number; flushed: number; immediate: number; windowMs: number } {
    return { received: this.received, flushed: this.flushed, immediate: this.immediate, windowMs: this.windowMs };
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
