/**
 * src/generate/fewshot.ts (260907 신설 — 9단계 · 지시서 §6)
 *
 * **화면이 생성 서비스에 보낼 few-shot 예시를 만든다.**
 *
 * ## 왜 화면도 예시를 보내는가
 *
 * 8단계가 프롬프트를 B 로 확정했고, B 는 「장비 목록 + 예시 2편」이다. 예시를 빼면 그것은
 * 확정한 프롬프트가 아니라 7단계 C 판이 되고, C 판의 숫자는 개수 일치 **7%** 다
 * (한 발화는 마일스톤 1개를 냈다 — 발화를 통째로 옮겨 적은 것이다).
 * **화면은 잰 것과 같은 조건으로 돌아야 한다.** 아니면 표의 숫자가 화면을 설명하지 못한다.
 *
 * ## 화면에서도 leave-one-out 을 지킨다
 *
 * 재료는 대본 라이브러리다 — 정답셋(`gen-lab/goldset/`)이 애초에 이 대본에서 뽑혀 나왔고
 * (`scripts/extract-goldset.mjs`), 그래서 **같은 내용이 이미 번들에 있다.** 새로 싣는
 * 데이터가 없다.
 *
 * 그런데 그 때문에 누출의 자리가 하나 생긴다. 화면의 시연 문장이 곧 대본의 기준 문장이라,
 * 그 문장을 그대로 넣으면 **정답을 예시로 주고 정답을 맞히라고 하는 것**이 된다. 채점하는
 * 자리가 아니라 해도 시연에서 그 일이 일어나면 보는 사람은 그것을 「모델이 해냈다」로
 * 읽는다. 그래서 **키워드 대조가 맞힌 편은 예시에서 뺀다** — 측정 경로의 leave-one-out
 * (`scripts/lib/fewshot.mjs`)과 같은 규칙을, 화면에서는 대본 매처가 고르게 한 것이다.
 *
 * ## 두 벌이 갈라지지 않게 하는 법
 *
 * 예시의 **모양**은 두 곳에 있다 — 여기(대본 camelCase 에서)와 측정 경로
 * (정답셋 snake_case 에서). 원천의 표기가 달라서 함수를 공유할 수 없다.
 * 그래서 주석으로 「같다」고 적지 않고 **`verify:proposal-gate` 가 세 편을 실제로 만들어
 * 두 결과가 글자까지 같은지 대조한다.** 갈라지면 검사가 죽는다.
 */

import type { ScriptLibraryEntry, ScriptScenario } from '../scenarios/types.ts';

/**
 * 프롬프트에 실리는 예시 한 편. **계약(`mission.schema.json`)의 표기와 차례를 따른다** —
 * 문법이 그 순서를 고정하므로(`gbnf.ts`) 예시가 다른 순서면 모델이 예시와 문법 사이에서
 * 싸운다.
 */
export type MissionExample = {
  mission_id: string;
  /** 항목 차례는 측정 경로와 같다 — 아래 `scriptAsExample` 의 머리말이 그 이유다. */
  utterance: { text: string; engine: string; confidence: number; audio_ref: string | null };
  milestones: Array<{
    milestone_id: string;
    title: string;
    order: number;
    status: 'pending';
    /**
     * 태스크를 보이는가는 **판이 정한다** (10단계). 기본은 빈 배열이고, 태스크를 내게
     * 하는 판에서는 규칙과 **함께** 켜야 한다 — 규칙만 바꾸면 예시가 이긴다.
     * `deps` 는 어느 판에서도 빈 배열이다: 의존은 예시가 아니라 규칙이 만든다.
     */
    tasks: MissionExampleTask[];
    assigned_targets: string[];
    /** 분기·되풀이 주석 (260908). **판이 켜졌을 때만 실린다.** */
    branch?: { from: string; when: 'pass' | 'fail' };
    repeat_of?: { to: string; when: 'pass' | 'fail' };
  }>;
};

/** 예시의 태스크 하나. 항목 차례는 계약의 `properties` 차례다 (문법이 그 순서를 고정한다). */
export type MissionExampleTask = {
  task_id: string;
  title: string;
  /** **언제나 빈 배열이다.** 정답의 의존을 보이면 모델이 흉내 내고, 그것이 §5 가 막는 것이다. */
  deps: [];
  status: 'pending';
  attempt: 1;
  derived_from: null;
  node_kind?: string;
  target?: string | null;
  action_items: [];
  evaluation: null;
};

/**
 * 대본 한 편 → 예시 한 편. `order` 는 대본에 없다 — 배열 차례가 곧 그것이다.
 *
 * ## `utterance` 의 항목 차례를 측정 경로에 맞춘다 — 계약 차례가 아니다
 *
 * 이 자리는 계약(`audio_ref` · `text` · `engine` · `confidence`) 차례로 적고 싶어지는데,
 * **그러면 화면이 잰 적 없는 프롬프트로 돈다.** 측정 경로의 예시는 정답셋 파일을 그대로
 * 실으므로 `text` · `engine` · `confidence` · `audio_ref` 차례이고, JSON 을 문자열로 펴는
 * 순간 그 차이가 프롬프트의 바이트 차이가 된다.
 *
 * 그래서 여기서 고르는 것은 「어느 차례가 옳은가」가 아니라 **「표가 설명하는 프롬프트가
 * 무엇인가」**다. `verify:no-leak` 6번이 두 경로를 글자까지 대조하므로, 측정 경로가 언젠가
 * 계약 차례로 바뀌면 이 함수도 그때 따라 바뀐다 — 갈라진 채로는 통과하지 못한다.
 *
 * **남은 것 하나** (9단계에서 찾았고 이번 범위에서 안 고쳤다): 문법(`gbnf.ts`)은 객체
 * 항목 차례를 **계약의 `properties` 차례로 고정한다.** 즉 지금 예시가 보여주는 차례와
 * 문법이 강제하는 차례가 다르다 — `lib/fewshot.mjs` 가 「예시가 다른 순서면 모델이 예시와
 * 문법 사이에서 싸운다」고 적어 둔 바로 그 상황이 `utterance` 안쪽에서 일어나고 있다.
 * 고치려면 프롬프트가 바뀌므로 **다시 재야 한다.** 짐작으로 고치지 않는다.
 */
export function scriptAsExample(script: ScriptScenario, options: { tasks?: boolean; branch?: boolean } = {}): MissionExample {
  /**
   * 대본의 **태스크 단위** 되돌아감을 마일스톤 단위로 올린다 — 측정 경로의
   * `extract-goldset.mjs` 가 정답셋에 하는 것과 **같은 파생**이고, `when` 을 `fail` 로
   * 채우는 관례도 같다(거기 주석에 근거가 있다). 두 결과가 글자까지 같은지는
   * `verify:no-leak` 이 대조한다 — 갈라지면 화면과 표가 다른 프롬프트로 돈다.
   */
  const repeats = new Map<string, { to: string; when: 'fail' }>();
  for (const edge of script.refEdges ?? []) {
    const from = script.tasks.find((task) => task.id === edge.from)?.milestone;
    const to = script.tasks.find((task) => task.id === edge.to)?.milestone;
    if (from === undefined || to === undefined) continue;
    repeats.set(from, { to, when: 'fail' });
  }
  return {
    mission_id: script.missionId,
    utterance: {
      text: script.utterance.text,
      engine: script.utterance.engine,
      confidence: script.utterance.confidence,
      audio_ref: script.utterance.audioRef,
    },
    milestones: script.milestones.map((milestone, index) => ({
      milestone_id: milestone.id,
      title: milestone.title,
      order: index,
      status: 'pending',
      tasks: options.tasks === true
        ? script.tasks.filter((task) => task.milestone === milestone.id).map((task) => ({
          task_id: task.id,
          title: task.title,
          deps: [] as [],
          status: 'pending' as const,
          attempt: 1 as const,
          derived_from: null,
          ...(task.nodeKind == null ? {} : { node_kind: task.nodeKind }),
          ...(task.target === undefined ? {} : { target: task.target }),
          action_items: [] as [],
          evaluation: null,
        }))
        : [],
      assigned_targets: milestone.assignedTargets,
      ...(options.branch === true && repeats.has(milestone.id) ? { repeat_of: repeats.get(milestone.id)! } : {}),
    })),
  };
}

/**
 * 이 발화에 실을 예시. **매칭된 편은 뺀다** (화면의 leave-one-out).
 *
 * 옛 편(`world: 'legacy'`)은 애초에 들어오지 않는다 — `script` 가 null 이기도 하지만,
 * 그 편의 장소(415호)가 지금 지도에 없기 때문이다. 지도에 없는 장소를 예시로 보이면
 * 「목록에 없는 장소를 만들지 마라」는 규칙과 정면으로 부딪히고, 모델에게 없는 방을
 * 쥐여 주는 꼴이 된다 (`aaa209a` 가 4층을 지도에서 되돌린 것과 같은 이유).
 *
 * @param excludeMissionId 키워드 대조가 맞힌 편. 없으면 null.
 */
export function examplesForUtterance(
  library: readonly ScriptLibraryEntry[],
  excludeMissionId: string | null,
  options: { tasks?: boolean; branch?: boolean } = {},
): MissionExample[] {
  return library
    .filter((entry) => entry.world === 'registry' && entry.script !== null)
    .filter((entry) => entry.missionId !== excludeMissionId)
    .map((entry) => scriptAsExample(entry.script as ScriptScenario, options));
}
