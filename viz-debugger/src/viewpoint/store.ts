/**
 * src/viewpoint/store.ts (260909 신설 — 시연 대본 §6)
 *
 * **뷰포인트 프레임 열 하나와 그 유일한 입구.** `src/data/trace.ts` 와 같은 자리·같은 이유다.
 *
 * 처음에 이 화면을 대본(`viewpointTimeline`)에서 곧바로 접게 만들었다가 되돌렸다.
 * `trace.ts` 머리말이 260904 에 고쳐 둔 실패가 정확히 그것이기 때문이다 —
 * **받은 기록이 아니라 대본을 접는 것.** 목 데이터에서는 대본이 곧 정답이라 티가 안 나지만,
 * 실제 로봇이 붙으면 화면은 여전히 대본을 접고 있게 된다. 그러면 §6 의 「갈아끼우면 끝」이
 * 거짓이 된다 — 갈아끼울 자리가 화면 안쪽까지 번져 있으니까.
 *
 * 그래서 대본이든 라이브든 **여기 하나로 들어오고**, 화면은 흘러온 것만 접는다.
 *
 * ```
 * 대본 재생(로컬·게이트웨이) ─┐
 *                            ├─▶ appendViewpoint() ─▶ 열 ─▶ 화면이 headSec 까지 접는다
 * 실제 로봇·탐지 채널 ────────┘   (아직 부르는 곳 없음)
 * ```
 *
 * 시각을 함께 싣는 이유는 **되감기**다. 슬라이더를 뒤로 끌면 그 시각 이후의 프레임은
 * 아직 안 온 것으로 접혀야 하고, 그러려면 프레임마다 「몇 초의 것인가」가 있어야 한다.
 * 열에서 지우지 않는다 — 기록 열이 되감기로 사건을 지우지 않는 것과 같다.
 */

import type { ViewpointFrame } from './fill.ts';

/** 열에 쌓이는 한 줄 — 언제의 프레임인가와 프레임 자체. */
export type ArrivedFrame = { atSec: number; frame: ViewpointFrame };

let missionId = '';
let column: ArrivedFrame[] = [];

/** 임무가 바뀌면 열을 비운다. 남은 프레임이 다음 임무의 노드를 칠하면 안 된다. */
export function resetViewpoint(id: string): void {
  missionId = id;
  column = [];
}

/**
 * **유일한 입구.** 다른 임무의 프레임은 버린다 — 승인 전에는 애초에 오지 않지만,
 * 재접속 직후에 이전 임무의 것이 늦게 닿을 수 있다.
 */
export function appendViewpoint(id: string, atSec: number, frame: ViewpointFrame): boolean {
  if (id !== missionId) return false;
  column.push({ atSec, frame });
  return true;
}

/** 지금까지 흘러온 전부. 화면은 이 중 머리까지를 접는다. */
export function arrivedFrames(): readonly ArrivedFrame[] {
  return column;
}

/**
 * 재생 머리까지 흘러온 프레임. **정렬하지 않는다** — 각 프레임이 제 인덱스로 찾아가므로
 * 도착 순서가 뒤집혀도 결과가 같아야 하고, 여기서 몰래 정렬해 주면 그 성질이 가려진다
 * (`verify:viewpoint-fill` 의 뒤섞기 검사).
 */
export function framesUpTo(headSec: number): ViewpointFrame[] {
  return column.filter((entry) => entry.atSec <= headSec).map((entry) => entry.frame);
}

export function viewpointMissionId(): string {
  return missionId;
}
