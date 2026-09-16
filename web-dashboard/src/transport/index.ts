/**
 * src/transport/index.ts
 *
 * 전송 계층의 **유일한 출입구**. 상위 코드는 여기서만 import 한다.
 * (`src/transport/WsTransport.ts`를 직접 import 하는 순간 격리가 깨진다.)
 *
 * 진짜 백엔드 게이트웨이가 나오면 두 경우가 있다.
 *   - 같은 논리 구독 방식 → `VITE_GATEWAY_WS` 환경변수만 바꾼다. 코드 변경 없음.
 *   - 토픽 문자열 방식   → 이 폴더에 TopicTransport.ts 를 추가하고 아래 팩토리만 바꾼다.
 *                          상위 코드(src/data, src/views)는 한 줄도 건드리지 않는다.
 */

import { WsTransport } from './WsTransport.ts';
import type { Transport } from './Transport.ts';

export type { Transport, Unsubscribe } from './Transport.ts';
export type {
  ActionSpec,
  ActuatorState,
  AiFailure,
  Channel,
  CommandAck,
  CommandRequest,
  CommandResult,
  ControlLock,
  ConnectionState,
  ConnectionStatus,
  Envelope,
  Quality,
  RoleInfo,
  RiskState,
  RoleScope,
  ScopeSpec,
  Selector,
  StateLayers,
  WireAggregation,
  WireMetricsQuery,
} from './types.ts';

/**
 * 접속 주소. 목 게이트웨이 → 실제 게이트웨이 전환은 이 두 값 교체가 전부다.
 * import.meta.env 접근을 한 번만 하고 방어적으로 읽는다 — Vite 밖(검증 하네스)에서도
 * 이 모듈이 그대로 돌아가야 전송 계층을 브라우저 없이 실측할 수 있다.
 */
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const GATEWAY = {
  ws: env.VITE_GATEWAY_WS ?? 'ws://127.0.0.1:8787',
  http: env.VITE_GATEWAY_HTTP ?? 'http://127.0.0.1:8787',
} as const;

let singleton: Transport | null = null;

export function getTransport(): Transport {
  if (singleton === null) {
    singleton = new WsTransport({ url: GATEWAY.ws, httpBase: GATEWAY.http });
    singleton.connect();
  }
  return singleton;
}
