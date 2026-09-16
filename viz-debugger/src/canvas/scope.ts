/**
 * src/canvas/scope.ts (260903 — 1단계)
 *
 * **연결이 곧 범위** (`VZ-N-02`) 의 계산. 계약 하나로 못박는 자리다 — 뷰 노드가 저마다
 * 「내 범위는 이렇다」를 정하기 시작하면 연결선이 곧 거짓말이 된다.
 *
 * 순수 함수만 둔다. React 도 저장소도 모르므로 `verify:*` 가 Node 에서 그대로 돌린다.
 */

import type { MissionView } from '../data/scenario.ts';
import { CURRENT_ZONE_ID } from '../shared/registry.ts';
import type { ViewScope } from './types.ts';

/**
 * 더 나올 사건이 없는 상태. 이 상태로 끝난 태스크는 **마지막 사건 시각이 구간의 끝**이고,
 * 그 밖(running·rerunning·awaiting_evaluation·pending)이면 아직 흐르는 중이라 임무 끝까지다.
 */
const TERMINAL = new Set(['done', 'failed', 'skipped', 'not_executed']);

/**
 * 태스크 하나의 실행 구간. 사건이 하나도 없으면(아직 시작 전) 0 ~ durationSec —
 * **구간을 0폭으로 만들지 않는다.** 0폭이면 뷰 노드가 "받은 게 없다"가 아니라
 * "볼 시간이 없다"가 되어, 자리표시와 구별되지 않는다.
 */
export function taskSpan(taskId: string, view: MissionView): { fromSec: number; toSec: number } {
  const own = view.events.filter((event) => event.nodeId === taskId);
  if (own.length === 0) return { fromSec: 0, toSec: view.durationSec };
  const last = own[own.length - 1];
  return {
    fromSec: own[0].atSec,
    toSec: TERMINAL.has(last.status) ? last.atSec : view.durationSec,
  };
}

/**
 * 뷰 노드 하나의 범위. `taskId` 가 null 이면 **전역 노드** — 대상 장비 없이 임무 전체
 * 구간을 본다. 전역은 허용된 상태이지 오류가 아니다(확정된 결정 3).
 *
 * 연결한 태스크가 지금 보이는 범위 밖이면(마일스톤을 옮겼다) `tasks` 에서 찾지 못한다 —
 * 그때도 전역과 같은 값을 돌려주되, 화면은 그 노드를 전역으로 **강등**해 사유를 적는다
 * (`persist.ts` 의 reconcile — 지우지 않는다).
 */
export function viewScopeFor(taskId: string | null, view: MissionView, headSec: number): ViewScope {
  const task = taskId === null ? null : view.tasks.find((item) => item.id === taskId) ?? null;
  if (task === null) {
    return { deviceId: null, zoneId: CURRENT_ZONE_ID, fromSec: 0, toSec: view.durationSec, headSec };
  }
  const span = taskSpan(task.id, view);
  return { deviceId: task.target, zoneId: CURRENT_ZONE_ID, fromSec: span.fromSec, toSec: span.toSec, headSec };
}
