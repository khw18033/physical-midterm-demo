/**
 * src/data/index.ts
 *
 * 데이터 레이어의 출입구. 화면은 여기서만 import 한다.
 *
 * 화면은 전송 방식을 모른다 — 아래 startDataLayer()가 transport 폴더의
 * `getTransport()` 하나만 붙잡고, 그 위로는 Envelope과 EntityRecord만 흐른다.
 */

import { getTransport } from '../transport/index.ts';
import { DataStore } from './store.ts';
import { fetchRegistry } from './registry.ts';
import { observeEnvelope, startSelfObservability } from './selfObservability.ts';

export { DataStore } from './store.ts';
export type { ChannelSlot, EntityRecord } from './store.ts';
export * from './statusModel.ts';
export * from './actuatorModel.ts';
export * from './commands.ts';
export * from './audit.ts';
export * from './plans.ts';
export * from './vision.ts';
export * from './auditFieldMap.ts';
export * from './aggregation.ts';
export * from './metrics.ts';
export * from './pipelineEditor.ts';
export * from './permissions.ts';
export * from './constants.ts';
export * from './registry.ts';
export { ZoneSummaryFeed } from './summary.ts';
export type { ZoneSummary } from './summary.ts';

export const store = new DataStore();

let started = false;

/**
 * 데이터 레이어 기동.
 *
 * 순서에 의미가 있다 — **레지스트리를 먼저 심는다.** 존재해야 할 목록이 없으면
 * 미배포 대상은 값을 발행하지 않으므로 화면에 영원히 나타나지 않는다(VZ-I-03).
 *
 * 구독은 계약 축 하나로 끝난다. 전송 계층이 재연결과 구독 복원을 알아서 하므로
 * 여기에는 재시도 코드가 없다.
 */
export function startDataLayer(zoneId: string): () => void {
  if (started) return () => undefined;
  started = true;

  const transport = getTransport();
  const abort = new AbortController();

  void fetchRegistry(abort.signal).then(({ registry, error }) => {
    store.setRegistry(registry, error);
  });

  // {entity: '*', node: <zone>, channel: '*'} — 계약 축 구독.
  // node 축에 zone 식별자를 주면 그 zone의 모든 node에 매칭된다.
  const unsubscribe = transport.subscribe(
    { entity: '*', node: zoneId, channel: '*' },
    (envelope) => {
      observeEnvelope(envelope);
      store.apply(envelope);
    },
    // VZ-I-11 — 현 단계 'all' 고정. 대상이 늘면 여기를 좁힌다.
    'all',
  );
  const stopObservability = startSelfObservability();

  return () => {
    abort.abort();
    unsubscribe();
    stopObservability();
    started = false;
  };
}

/** 개발용 시나리오 트리거. 실제 게이트웨이에는 없는 경로다. */
export function playScenario(name: string): void {
  getTransport().playScenario?.(name);
}
