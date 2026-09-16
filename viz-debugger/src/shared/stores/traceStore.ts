import type { ScenarioEvent } from '../../model/types.ts';

/**
 * 탭①의 되감기용 **기록 열**.
 *
 * ## 상태 모델이 둘인 이유 — 합치지 않는다
 *
 * 통합 앱에는 상태 저장소가 둘 있고, 맡는 것이 다르다.
 *
 * | | 무엇을 담는가 | 누가 쓰는가 | 지우는가 |
 * |---|---|---|---|
 * | `TraceStore` (여기) | **일어난 일의 열.** 덧붙이기만 한다 | 탭① | 안 지운다. 실패해도 남는다 |
 * | `DataStore` (`tabs/data/store.ts`) | **채널별 최신값.** 같은 키가 오면 덮어쓴다 | 뷰 노드 | 덮어쓴다 |
 *
 * 되감기는 "그 시점의 값"이 아니라 **"그때까지 일어난 일을 접은 결과"**라서 최신값
 * 저장소로는 만들 수 없다. 반대로 구역 현황판은 지난 일이 아니라 **지금 값**만 필요하고,
 * 열을 매번 접으면 20 Hz 수신에서 렌더 예산을 넘긴다.
 *
 * 하나로 합치면 둘 중 하나가 반드시 손해를 본다. **transport 는 하나를 공유하고
 * 저장소만 둘**이라는 것이 지금의 경계다 (기술스택 §10 "두 상태 모델의 공존 방식").
 *
 * ## 260904 — 배열 래퍼에서 실제 저장소로
 *
 * 전까지는 `push` 하나짜리 배열 래퍼였고 `snapshot()` 을 부르는 곳이 **0** 이었다.
 * 화면은 받은 기록이 아니라 대본(`view.events`)을 접고 있었다. 이제 화면이 접는 것이
 * 이 열이므로 저장소가 **세 가지를 실제로 보장한다**.
 *
 *  1. **순서** — 열은 `(atSec, seq)` 오름차순이다. 수신 순서는 보장이 없다(재접속·중계).
 *     접기는 시각을 걸어 나가므로 시각이 먼저이고, 같은 시각이면 `seq` 가 가른다.
 *     대본 사건은 두 값이 같이 오르므로 이 순서가 곧 `seq` 순서다.
 *  2. **중복 무시** — `seq` 가 신원이다. 재접속하면 같은 사건이 다시 온다 (`VZ-I-02`).
 *  3. **덧붙이기 전용** — 수정·삭제 경로가 없다 (REQ-1404). 지우려면 저장소를 새로
 *     만드는 수밖에 없고, 그것이 「임무가 바뀌었다」와 같은 뜻이다.
 *
 * 넣은 사건은 **사본을 얼려서** 든다. 준 쪽(대본 JSON·전송 계층 봉투)이 나중에 그 객체를
 * 고쳐도 기록은 안 바뀐다 — 「덧붙이기 전용」이 호출자의 선의에 기대면 안 된다.
 */
export class TraceStore {
  /** 이 열이 누구의 기록인가. 다른 임무의 사건은 애초에 들어오지 않는다. */
  readonly missionId: string;

  private readonly events: ScenarioEvent[] = [];
  /** `seq` 신원 집합. 중복 판정이 O(1) 이어야 20 Hz 재접속 폭주를 견딘다. */
  private readonly seen = new Set<number>();
  private duplicates = 0;
  private outOfOrder = 0;
  /**
   * `snapshot()` 이 내주는 **얼린 사본**. 덧붙일 때만 버린다.
   *
   * 화면은 이 배열을 `useMemo` 의 의존값으로 쓴다 — 열이 자라면 신원이 바뀌어 다시 접고,
   * 안 자라면 그대로라 안 접는다. 매번 새 배열을 만들면 사건이 없어도 매 렌더마다 접는다.
   * 여럿이 같은 배열을 나눠 갖게 되므로 **얼린다** — 한 명이 흔들면 나머지가 다 틀어진다.
   */
  private cached: readonly ScenarioEvent[] | null = null;

  constructor(missionId: string) {
    this.missionId = missionId;
  }

  /**
   * 사건 하나를 덧붙인다. **중복(같은 `seq`)이면 아무 일도 하지 않고 `false`.**
   * 들어갔으면 `true` — 부르는 쪽은 이 값으로 「새 기록이 생겼는가」를 안다.
   */
  append(event: ScenarioEvent): boolean {
    if (this.seen.has(event.seq)) {
      this.duplicates += 1;
      return false;
    }
    this.seen.add(event.seq);
    const record = freezeEvent(event);
    const at = this.placeFor(record);
    if (at === this.events.length) {
      this.events.push(record);
    } else {
      this.events.splice(at, 0, record);
      this.outOfOrder += 1;
    }
    this.cached = null;
    return true;
  }

  /**
   * 들어갈 자리. **뒤에서 앞으로 훑는다** — 수신은 대개 순서대로라 첫 비교에서 끝나고,
   * 늦게 온 사건만 그만큼 되짚는다.
   */
  private placeFor(event: ScenarioEvent): number {
    let index = this.events.length;
    while (index > 0 && !precedes(this.events[index - 1], event)) index -= 1;
    return index;
  }

  /** 복사본. 저장소 밖에서 무엇을 하든 열은 안 바뀐다. */
  snapshot(): readonly ScenarioEvent[] {
    if (this.cached === null) this.cached = Object.freeze([...this.events]);
    return this.cached;
  }

  get length(): number {
    return this.events.length;
  }

  /** 자체 관측(`VZ-O-04`)이 읽는 값. 열 자체는 세지 않는다 — 세는 쪽이 들고 간다. */
  stats(): TraceStats {
    return {
      missionId: this.missionId,
      length: this.events.length,
      duplicates: this.duplicates,
      outOfOrder: this.outOfOrder,
      firstAtSec: this.events[0]?.atSec ?? null,
      lastAtSec: this.events[this.events.length - 1]?.atSec ?? null,
    };
  }
}

export type TraceStats = {
  missionId: string;
  length: number;
  /** 같은 `seq` 로 다시 온 건수. 재접속이 몇 번 있었는지의 그림자다 (`VZ-I-02`). */
  duplicates: number;
  /** 열 끝이 아닌 자리에 끼워 넣은 건수. 수신 순서 ≠ 기록 순서였던 횟수다. */
  outOfOrder: number;
  firstAtSec: number | null;
  lastAtSec: number | null;
};

/** `a` 가 `b` 보다 앞인가. 시각이 먼저이고, 같은 시각이면 `seq` 가 가른다. */
function precedes(a: ScenarioEvent, b: ScenarioEvent): boolean {
  if (a.atSec !== b.atSec) return a.atSec < b.atSec;
  return a.seq < b.seq;
}

function freezeEvent(event: ScenarioEvent): ScenarioEvent {
  const copy: ScenarioEvent = { ...event };
  if (copy.payload !== undefined) copy.payload = Object.freeze({ ...copy.payload });
  return Object.freeze(copy);
}
