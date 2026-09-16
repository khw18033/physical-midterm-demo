// 이식: web-dashboard/src/transport/backoff.ts @ 605eb73 — 무수정
/**
 * src/transport/backoff.ts
 *
 * 지수 백오프 + 지터. 게이트웨이가 죽었다 살아날 때 모든 클라이언트가 같은 순간에
 * 몰려들지 않도록 지터를 섞는다(동시 사용자 1명 전제여도, 탭이 여럿이면 같은 문제가 난다).
 */

export const BACKOFF = {
  /** 첫 재시도까지. 목 서버 재기동 정도는 거의 즉시 붙어야 한다. */
  INITIAL_MS: 500,
  /** 한 번 실패할 때마다 곱하는 배수. */
  FACTOR: 2,
  /** 상한. 이보다 길어지면 사람이 새로고침하는 편이 빠르다. */
  MAX_MS: 15_000,
  /** 지터 폭(계산값의 ±비율). */
  JITTER_RATIO: 0.25,
} as const;

export function backoffDelayMs(attempt: number): number {
  const raw = BACKOFF.INITIAL_MS * BACKOFF.FACTOR ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, BACKOFF.MAX_MS);
  const jitter = capped * BACKOFF.JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(capped + jitter));
}
