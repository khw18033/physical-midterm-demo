/**
 * src/data/fold.ts (260901 — scenario.ts 에서 갈라 나옴)
 *
 * **시각 t 의 계층 상태 접기** (REQ-1405 되감기 · 마일스톤은 태스크를 접은 결과).
 *
 * 규칙만 있고 저장소도 대본 파일도 모른다 — 순수 함수 하나다. 갈라 둔 이유는
 * `scenarios/nowPlaying.ts` 가 이 접기를 쓰는데 `verify:scenario-mode` 가 그것을 Node 에서
 * 직접 돌려 「안내줄이 재생 머리를 따라가는가」를 검사해야 하기 때문이다. `scenario.ts` 는
 * 옛 편 JSON 을 import 하고 있어 Node ESM 에서 그대로 열리지 않는다.
 *
 * `MissionView` 는 여전히 `scenario.ts` 가 정의한다 — 여기서는 **타입만** 가져오므로
 * 실행 시에는 아무것도 끌어오지 않는다.
 *
 * ## 260904 — 접는 대상이 대본에서 기록 열로
 *
 * 전까지 이 함수는 `view.events` 를 접었다. 그것은 **승인 시점에 읽은 대본 JSON** 이지
 * 받은 기록이 아니다. 이제 열을 **인자로 받는다** — `view.events` 는 대본의 정의로 남고,
 * 목 게이트웨이와 로컬 재생기가 그것을 읽어 기록으로 흘려보내며, 화면은 흘러온 것만 접는다
 * (`data/trace.ts`). 기본값을 두지 않은 것은 일부러다: 접는 대상을 말하지 않고 부를 수
 * 있으면 「대본을 접는」 자리가 조용히 되살아난다.
 */

import type { ScenarioEvent, TaskStatus } from '../model/types.ts';
import type { MissionView } from './scenario.ts';

export type FoldedStatuses = {
  tasks: Record<string, { status: TaskStatus; attempt: number }>;
  milestones: Record<string, TaskStatus>;
};

/**
 * 시각 t 의 계층 상태. **마일스톤도 함께 돌려준다** — 되감기하면 태스크와 마일스톤이
 * 같이 되돌아가야 한다.
 *
 * `trace` 는 `(atSec, seq)` 오름차순이라고 전제한다 — `TraceStore` 가 보장하는 성질이다.
 * 그래서 시각을 넘어서면 **끊는다**: 뒤는 전부 미래다.
 */
export function foldStatuses(second: number, view: MissionView, trace: readonly ScenarioEvent[]): FoldedStatuses {
  const tasks = Object.fromEntries(
    view.tasks.map((task) => [task.id, { status: 'pending' as TaskStatus, attempt: 1 }]),
  );
  /**
   * 이 임무의 태스크 집합. 열에는 **태스크가 아닌 사건도 있다** — 사람 조작은 장비나
   * 임무 자신을 가리킨다(`recordHuman`). 그것을 태스크 표에 넣으면 그래프에 없는 노드가
   * 상태를 갖게 되므로, 기록에는 남기되 접기에서는 건너뛴다.
   */
  const known = new Set(view.tasks.map((task) => task.id));
  for (const event of trace) {
    if (event.atSec > second) break;
    if (!known.has(event.nodeId)) continue;
    tasks[event.nodeId] = { status: event.status, attempt: event.attempt ?? tasks[event.nodeId]?.attempt ?? 1 };
  }

  const milestones: Record<string, TaskStatus> = {};
  for (const milestone of view.milestones) {
    const own = view.tasks.filter((task) => task.milestone === milestone.id);
    if (own.length === 0) {
      // 접을 재료가 없다 — 옛 파일의 정적 status 로만 그린다 (대본에는 이런 마일스톤이 없다).
      milestones[milestone.id] = milestone.staticStatus ?? 'pending';
      continue;
    }
    const statuses = own.map((task) => tasks[task.id]?.status ?? 'pending');
    if (statuses.every((s) => s === 'done')) milestones[milestone.id] = 'done';
    else if (statuses.some((s) => s === 'failed')) milestones[milestone.id] = 'failed';
    else if (statuses.every((s) => s === 'not_executed')) milestones[milestone.id] = 'not_executed';
    else if (statuses.every((s) => s === 'skipped')) milestones[milestone.id] = 'skipped';
    else if (statuses.every((s) => s === 'pending')) milestones[milestone.id] = 'pending';
    else milestones[milestone.id] = 'running';
  }

  return { tasks, milestones };
}
