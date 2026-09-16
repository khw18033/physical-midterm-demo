/**
 * src/physical/robotFacts.ts (260910 신설)
 *
 * **장비 상태 → 연결 관리가 읽는 몇 줄.**
 *
 * `connectionCheck.ts` 는 토픽도 장비 id 도 모른다(`verify:physical-port`). 그쪽이 쓰는
 * 모양으로 바꿔 주는 자리가 여기다 — 경계 안이다.
 */

import { deviceState, isStale } from './deviceState.ts';
import { hardwareTarget } from './encode.ts';
import type { RobotFacts } from '../shared/connectionCheck.ts';

/** 우리 로봇의 지금. 아무것도 안 왔으면 null — 지어내지 않는다. */
export function robotFacts(vizEntityId = 'robot-01'): RobotFacts | null {
  const device = deviceState(hardwareTarget(vizEntityId));
  if (device === null) return null;
  const stale = isStale(device);
  return {
    online: device.online,
    link: device.link,
    health: device.health,
    batteryPct: device.batteryPct,
    stale,
    staleSec: Math.round((Date.now() - device.lastSeenMs) / 1000),
  };
}
