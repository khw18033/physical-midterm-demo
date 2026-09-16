// scripts/lib/fewshot.mjs (260906 신설 — 마일스톤 분리 지시서 §4-3)
//
// **채점 대상인 편을 예시에서 빼는 규칙이 사는 유일한 파일이다.**
//
// 이 규칙을 부르는 쪽마다 적으면 언젠가 한 곳이 빠지고, 그러면 정답을 보여주고 정답을
// 맞히라고 한 표가 나온다 — **논문에서 가장 먼저 찔리는 자리**다. 그래서 규칙을 한 곳에
// 두고 `verify:no-leak` 이 이 함수를 실제로 불러 검사한다.
//
// 실행 스크립트(`run-baseline.mjs`)에서 떼어 낸 이유는 하나 더 있다. 검사가 실행
// 스크립트를 import 하면 검사를 돌릴 때마다 모델이 20건을 생성한다.

/**
 * 예시 한 편의 태스크 하나. **항목 차례는 계약의 `properties` 차례다** —
 * 문법이 그 순서를 고정하므로(`gbnf.ts`) 예시가 다른 순서면 모델이 예시와 문법 사이에서
 * 싸운다.
 *
 * **`deps` 는 언제나 빈 배열이다.** 정답의 의존을 보여주면 모델이 그것을 흉내 내고,
 * 그 순간 지시서 §5 가 막으려던 것(근거 없는 `deps`)이 예시를 통해 들어온다. 의존은
 * 예시가 아니라 규칙이 만든다 — `src/generate/solveDeps.ts`.
 *
 * 실행이 채우는 자리(`status`·`attempt`·`derived_from`·`action_items`·`evaluation`)는
 * 프롬프트 규칙이 못박은 값 그대로 보인다. 예시와 규칙이 어긋나면 예시가 이긴다 —
 * 10단계 E 판이 그것을 15건 중 10건으로 보였다.
 */
function taskAsExample(task) {
  return {
    task_id: task.task_id,
    title: task.title,
    deps: [],
    status: 'pending',
    attempt: 1,
    derived_from: null,
    ...(task.node_kind == null ? {} : { node_kind: task.node_kind }),
    ...(task.target === undefined ? {} : { target: task.target }),
    action_items: [],
    evaluation: null,
  };
}

/**
 * few-shot 예시로 쓸 모양.
 *
 * ## 태스크를 보이는가 — **판이 정한다** (260907 · 10단계)
 *
 * 기본은 **마일스톤까지만**이다. `VZ-G-01` 단계에서는 태스크가 다음 단계의 몫이고,
 * 예시에 넣으면 모델이 이번 단계에서 하지 말아야 할 일을 배운다.
 *
 * 태스크를 내게 하는 판(`--tasks`)에서는 **반드시 같이 켜야 한다.** 규칙만 바꾸고
 * 예시를 그대로 두면 프롬프트가 서로 반대되는 지시 둘을 들게 되고, 실측에서 **예시가
 * 이겼다** — 10단계 E 판 15건 중 10건이 규칙을 무시하고 `tasks: []` 를 냈다.
 * 그래서 이 인자는 부르는 쪽이 규칙과 **함께** 넘긴다.
 *
 * 항목 순서는 **계약의 차례대로** 둔다. 문법이 그 순서를 고정하므로(`gbnf.ts`),
 * 예시가 다른 순서면 모델이 예시와 문법 사이에서 싸운다.
 */
export function asExample(mission, { tasks = false, branch = false } = {}) {
  return {
    mission_id: mission.mission_id,
    utterance: mission.utterance,
    milestones: mission.milestones.map((milestone) => ({
      milestone_id: milestone.milestone_id,
      title: milestone.title,
      order: milestone.order,
      status: 'pending',
      tasks: tasks
        ? (mission.tasks ?? []).filter((task) => task.milestone_id === milestone.milestone_id).map(taskAsExample)
        : [],
      assigned_targets: milestone.assigned_targets,
      // 분기·되풀이 주석 (260908 · 3단계). **판이 켜졌을 때만 보인다** — 규칙만 바꾸고
      // 예시를 그대로 두면 예시가 이긴다(10단계 E 판 15건 중 10건).
      ...(branch && milestone.branch !== undefined ? { branch: milestone.branch } : {}),
      ...(branch && milestone.repeat_of !== undefined ? { repeat_of: milestone.repeat_of } : {}),
    })),
  };
}

/**
 * 예시를 몇 편 싣는가. **이 목록이 규칙의 전부다** — `verify:no-leak` 이 기록의 예시 수를
 * 이 둘 중 하나로만 받아들이고, 한 실행 안에서 섞여 있으면 실패로 끝낸다.
 *
 * `none` 이 7단계에 생겼다. 6단계가 남긴 질문이 「개수 일치 45% 가 실력인가 예시를
 * 베낀 것인가」였고, 그것은 **예시를 빼고 같은 것을 재야** 답이 된다. 그래서 「언제나
 * 정답셋에서 하나 뺀 수」였던 규칙을 **0 또는 그 수**로 넓혔다 — 넓힌 것은 개수뿐이고,
 * 채점 대상 편이 예시에 드는 것은 여전히 어느 판에서도 금지다.
 */
export const SHOT_MODES = /** @type {const} */ (['leave-one-out', 'none']);

/**
 * **누출을 막는 유일한 자리.** 채점 대상 편을 예시에서 뺀다 (leave-one-out).
 *
 * @param missionId 지금 채점할 편. 이 편은 예시에 **절대** 들어가지 않는다.
 * @param missions  정답셋 전부.
 * @param shots     `'leave-one-out'`(기본) 또는 `'none'`(예시 0편 · 7단계 C 판).
 */
export function examplesFor(missionId, missions, shots = 'leave-one-out', { tasks = false, branch = false } = {}) {
  if (!SHOT_MODES.includes(shots)) throw new Error(`모르는 예시 방식: ${shots} — ${SHOT_MODES.join(' 또는 ')}`);
  // 0편은 **예시를 안 주는 것**이지 「없는 예시를 골랐다」가 아니다. 그래서 필터가 아니라
  // 이른 반환으로 가른다 — 정답셋이 1편이 되어도 0편은 0편이다.
  if (shots === 'none') return [];
  return missions
    .filter((mission) => mission.mission_id !== missionId)
    .map((mission) => asExample(mission, { tasks, branch }));
}

/**
 * 그 실행이 돈 편 수에서 **허용되는 예시 수.** 검사와 실행이 같은 함수를 본다.
 *
 * @param missionCount 그 실행이 돈 편 수.
 */
export function allowedExampleCounts(missionCount) {
  return [0, missionCount - 1];
}
