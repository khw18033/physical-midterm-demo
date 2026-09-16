/**
 * src/data/trace.ts (260904 신설 — 기록 → 되감기 고리)
 *
 * **기록 열 하나와 그 유일한 입구.**
 *
 * 전까지 화면으로 흘러드는 길이 셋이었고 셋 다 목적지가 달랐다.
 *
 * ```
 * 게이트웨이 trace_event ──▶ 재생 머리(headSec)만 밀었다. 열에는 넣되 아무도 안 읽었다
 * 로컬 재생기(단독 빌드) ──▶ 재생 머리만 밀었다. 열에는 넣지도 않았다
 * 사람 조작(recordHuman) ──▶ 별도 배열 + console.log. 되감기에 안 들어갔다
 * 화면                   ──▶ 대본 JSON(view.events)을 접었다
 * ```
 *
 * 즉 **받은 기록이 아니라 대본을 접고 있었다.** 목 데이터에서는 대본이 곧 정답이라 티가
 * 안 나지만, 실제 백엔드가 붙으면 화면은 여전히 대본을 접는다.
 *
 * 이제 셋이 전부 `appendTrace()` 하나로 들어오고 화면은 흘러온 것만 접는다.
 * 입구가 둘이면 **단독 빌드와 통합 빌드의 되감기가 달라지고, 그게 곧 논문 측정축 D의
 * 오염이다** — 같은 대본을 같은 시각으로 되감았는데 빌드마다 다른 화면이 나오면 무엇을
 * 잰 숫자인지 말할 수 없다.
 *
 * ## 이 파일이 `scenario.ts` 밖에 있는 이유
 *
 * `scenario.ts` 는 옛 편 JSON 을 `import` 하고 있어 Node ESM 에서 그대로 열리지 않는다.
 * 열과 입구가 그 안에 있으면 `verify:trace-append`·`verify:replay`·`verify:human-trace`
 * 가 규칙을 **직접 돌려 볼 수 없고** 소스 문자열 검사로 내려앉는다. 여기는 타입과
 * `TraceStore` 만 끌어오므로 Node 가 그대로 연다 (`fold.ts` 를 갈라 둔 것과 같은 이유).
 *
 * 임무 상태(현재 임무·재생 머리)는 여기 없다 — 그것은 `scenario.ts` 몫이고, 이 파일을
 * 그쪽에서 부른다. 반대로 하면 순환이 된다.
 */

import type { ScenarioEvent } from '../model/types.ts';
import { TraceStore, type TraceStats } from '../shared/stores/traceStore.ts';

export type { TraceStats };

/**
 * 사람 조작의 `seq` 대역.
 *
 * 대본·백엔드 사건은 1부터 오르므로 대역을 갈라 두지 않으면 **사람 조작 하나가 대본
 * 사건 하나를 중복으로 지운다.** 대역이 갈려 있으면 둘은 절대 부딪히지 않는다.
 */
export const HUMAN_SEQ_BASE = 1_000_000;

/**
 * AI 가 만든 것의 `seq` 대역 (260907 · 9단계).
 *
 * 사람 대역을 가른 것과 **같은 이유**다 — 생성 근거 하나가 대본 사건 하나를 중복으로
 * 지우면, 그 사건이 조용히 사라진 채 되감기가 돈다. 대역이 셋이면 셋은 절대 부딪히지
 * 않는다: 백엔드 1부터 · **AI 500,000부터** · 사람 1,000,000부터.
 *
 * ## 왜 사람 대역보다 **아래**인가 — 순서가 뜻이기 때문이다
 *
 * 열은 `(atSec, seq)` 오름차순이다(`TraceStore`). 생성과 승인은 **같은 순간**(둘 다
 * `atSec` 0)에 들어가므로 그때는 `seq` 가 순서를 가른다. AI 대역이 사람 대역보다 위면
 * 열의 첫 줄이 「사람이 승인했다」가 되고 그 다음이 「무엇이 만들었나」가 된다 —
 * 역추적이 거꾸로 읽힌다. 대역 값 하나가 그 순서를 정한다.
 */
export const AI_SEQ_BASE = 500_000;

/** 아무 임무도 안 올라온 상태. 기동 직후와 임무 교체 사이의 한순간이다. */
const NO_MISSION = '';

let column = new TraceStore(NO_MISSION);
let humanCount = 0;
let aiCount = 0;

/**
 * 임무가 바뀌면 **새 열**이다. 지우는 것이 아니라 새로 만드는 것이다 —
 * `TraceStore` 에는 수정·삭제 경로가 없다 (REQ-1404).
 */
export function resetTrace(missionId: string): void {
  column = new TraceStore(missionId);
  humanCount = 0;
  aiCount = 0;
}

/** 지금 열이 누구의 기록인가. */
export function traceMissionId(): string {
  return column.missionId;
}

/**
 * 지금까지 흘러온 기록. **복사본**이고, 덧붙이기 전까지는 같은 배열이다 —
 * 화면이 이것을 `useMemo` 의존값으로 쓴다 (`TraceStore.snapshot()` 주석).
 */
export function traceEvents(): readonly ScenarioEvent[] {
  return column.snapshot();
}

export function traceStats(): TraceStats {
  return column.stats();
}

/**
 * **기록 열의 유일한 입구.** 게이트웨이·로컬 재생기·사람 조작이 전부 여기로 온다.
 *
 * 다른 임무의 사건은 버린다 — 승인 전에는 애초에 오지 않지만(게이트웨이 규칙), 임무를
 * 갈아탄 직후 늦게 도착한 옛 임무의 사건은 실제로 올 수 있다.
 *
 * 돌려주는 값은 「열이 자랐는가」다. 중복(같은 `seq`)이면 `false` — 부르는 쪽은 그때
 * 화면을 다시 그리지 않아도 된다.
 */
export function appendTrace(missionId: string, event: ScenarioEvent): boolean {
  if (missionId !== column.missionId) return false;
  return column.append(event);
}

/**
 * 사람 조작 기록 (`VZ-D-08` — 「모든 조작은 `produced_by=human` 으로 기록된다」).
 *
 * 전까지는 별도 배열에 넣고 `console.log` 가 끝이라 **기록이라고 부를 수 없었다.**
 * 이제 대본·백엔드 사건과 **같은 열**에 들어가므로 되감기 화면에서 보인다 — 그것이
 * `VZ-D-08` 이 화면에서 확인 가능해지는 지점이다.
 *
 * `atSec` 는 **조작한 그 시각의 재생 머리**다. 임무 끝(`durationSec`)에 몰아 두면 모든
 * 조작이 타임라인 오른쪽 끝에 겹쳐 쌓여 "언제 눌렀는지"를 잃는다.
 */
export function appendHuman(
  missionId: string,
  kind: string,
  nodeId: string,
  atSec: number,
  payload: Record<string, unknown> = {},
): ScenarioEvent | null {
  const event: ScenarioEvent = {
    seq: HUMAN_SEQ_BASE + humanCount,
    atSec,
    nodeId,
    status: 'rerunning',
    kind,
    // 이 한 줄이 `VZ-D-08` 이다. 여기가 아닌 곳에서 사람 사건을 만들면 그 규칙이 갈라진다.
    producedBy: 'human',
    payload,
  };
  if (!appendTrace(missionId, event)) return null;
  humanCount += 1;
  return event;
}

/**
 * AI 가 만든 것의 기록 (`VZ-G-01` — 「역추적이 맨 위까지 닿는다」 · 260907 · 9단계).
 *
 * `appendHuman` 과 **같은 모양**이다. 사람 조작에 `produced_by=human` 이 붙어야 하는
 * 이유가 그대로 여기에도 있다 — 화면에 뜬 마일스톤을 보고 「이건 누가 썼나」를 물었을 때
 * 답이 기록 안에 있어야 한다. 대본에서 읽은 것 · 사람이 쓴 것 · 모델이 낸 것이 갈리지
 * 않으면 그 물음에 답이 없다.
 *
 * ## 승인 전에는 부르지 않는다
 *
 * 제안 상태의 임무는 **열이 비어 있는 것이 곧 「아직 아무 일도 없었다」**이고
 * (`scenario.ts` 의 `displayMission`), 여기에 근거를 미리 넣으면 그 사실이 깨진다.
 * 근거는 승인 전에는 제안이 들고 화면이 보여주며, 열에는 **승인된 뒤에** 들어간다.
 * 그래서 이 열의 첫 줄은 언제나 「무엇이 이 임무를 만들었나」이고 그 다음이 승인이다.
 */
export function appendGenerated(
  missionId: string,
  kind: string,
  nodeId: string,
  atSec: number,
  payload: Record<string, unknown> = {},
): ScenarioEvent | null {
  const event: ScenarioEvent = {
    seq: AI_SEQ_BASE + aiCount,
    atSec,
    nodeId,
    // 생성은 실행이 아니다 — 아무것도 돌지 않았다. 계획이 선 상태가 `pending` 이다.
    status: 'pending',
    kind,
    producedBy: 'ai',
    payload,
  };
  if (!appendTrace(missionId, event)) return null;
  aiCount += 1;
  return event;
}
