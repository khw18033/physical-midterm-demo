// 이식: web-dashboard/src/data/selfObservability.ts @ 700ed91 — 무수정 (transport 경로만 조정)
/** VZ-O-04 — 가시화가 자기 성능을 60초마다 관측 경로에 직접 발행한다. */

import { GATEWAY, type Envelope } from '../../transport/index.ts';

const PERIOD_MS = 60_000;
let received = 0;
let delayTotal = 0;
let delayMax = 0;
let started = false;

export function observeEnvelope(env: Envelope): void {
  const delay = Math.max(0, Date.now() - Date.parse(env.ts));
  if (!Number.isFinite(delay)) return;
  received += 1;
  delayTotal += delay;
  delayMax = Math.max(delayMax, delay);
}

function snapshot() {
  const payload = {
    source: 'web-dashboard',
    period_sec: PERIOD_MS / 1000,
    measured_at: new Date().toISOString(),
    envelope_count: received,
    apply_delay_avg_ms: received === 0 ? null : Math.round(delayTotal / received),
    apply_delay_max_ms: received === 0 ? null : Math.round(delayMax),
  };
  received = 0;
  delayTotal = 0;
  delayMax = 0;
  return payload;
}

export function startSelfObservability(): () => void {
  if (started) return () => undefined;
  started = true;
  const publish = () => {
    const body = JSON.stringify(snapshot());
    void fetch(GATEWAY.http + '/observability/client-metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  };
  const timer = window.setInterval(publish, PERIOD_MS);
  return () => {
    window.clearInterval(timer);
    started = false;
  };
}
