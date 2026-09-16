/**
 * src/generate/planShape.ts (260908 신설 — 11단계)
 *
 * **발화가 요구한 모양과 계획의 모양이 맞는가.**
 *
 * ## 왜 이 파일이 생겼나 — 실패가 조용했다
 *
 * 10단계 §7 에서 틀 밖 발화 셋을 넣어 봤다. 「사람을 **찾을 때까지** 계속 이동해」에
 * 모델은 분기를 알아봤는데(「탐지 시 멈춤」과 「탐지 없음」을 갈라 냈다) 그 둘이
 * **순차로 꿰였다** — 읽으면 「멈추고 → 그 다음 계속 이동하고 → 끝낸다」다.
 * 되돌아가는 길도 없다.
 *
 * 그런데 그 계획은 **스키마를 통과하고 순환도 없고 `verify:*` 27개가 전부 초록이다.**
 * 틀렸다는 것을 기계가 아는 자리가 없었다. 지금 이것을 잡는 것은 승인 화면을 보는 사람의
 * 눈 하나뿐이고, 그것은 승인 선의 **마지막** 방어선이지 첫 방어선이어서는 안 된다.
 *
 * ## 이 파일은 고치지 않는다. 못 한다고 말할 뿐이다
 *
 * 분기와 루프를 **실제로 만드는** 것은 계약·규칙·화면이 같이 움직여야 하는 일이다
 * (10단계 §8 의 5번). 그 전에 먼저 할 것은 **못 한다는 사실을 화면과 기록에 남기는
 * 것**이고, 이 파일이 그것만 한다. 경고는 생성을 막지 않는다 — 사람이 승인을 판단할
 * 재료를 하나 더 주는 것이다.
 *
 * ## 판별은 완벽하지 않다 — 그렇게 적어 둔다
 *
 * 표지는 한국어 문자열이다. 「~할 때까지」를 잡고 「엘리베이터**까지**」는 안 잡는 식의
 * 구분이라 놓치는 것도 있고 잘못 잡는 것도 있다. **그래도 0보다 낫다** — 지금은 못
 * 한다는 사실조차 아무 데도 안 적힌다. 놓친 것은 `note` 가 적고, 잘못 잡은 것은 사람이
 * 무시하면 된다(경고이지 차단이 아니다).
 *
 * 순수 함수다. `verify:plan-shape` 가 Node 에서 그대로 돌린다.
 */

/** 계획의 모양이 발화와 어긋난 자리. 화면과 기록이 이 문장을 그대로 쓴다. */
export type PlanShapeWarning = {
  /** `loop` = 되돌아가는 길이 필요한데 없다. `branch` = 갈라지는 길이 필요한데 일렬이다. */
  kind: 'loop' | 'branch';
  /** 발화에서 잡힌 표지. **무엇 때문에 경고했는지**를 사람이 볼 수 있어야 한다. */
  markers: string[];
  /** 사람이 읽는 한 줄. */
  message: string;
};

/**
 * 루프를 요구하는 표지.
 *
 * `때까지` 를 한 덩어리로 본다 — 「찾을 **때까지**」는 루프이고 「엘리베이터**까지**」는
 * 아니다. 조사 하나가 그 둘을 가른다.
 */
const LOOP_MARKERS = ['때까지', '반복', '계속', '재탐색', '주기적', '다시 시도', '재시도', '할 때마다', '매번'];

/**
 * 배타 분기를 요구하는 표지.
 *
 * 「있으면 … 없으면」처럼 **둘 중 하나**를 고르라는 말이다. 단순한 조건(「위험 수위에
 * 도달하면 닫아라」)은 갈라지는 것이 아니라 순서라서 여기 넣지 않는다 — 그것은 지금
 * 구조로도 옳게 표현된다.
 */
const BRANCH_MARKERS = ['없으면', '아니면', '그렇지 않으면', '안 되면', '못 하면', '실패하면', '중 하나'];

function found(text: string, markers: readonly string[]): string[] {
  return markers.filter((marker) => text.includes(marker));
}

/**
 * 이 계획이 **순수 사슬**인가 — 갈라지는 자리가 하나도 없는가.
 *
 * 갈라진다는 것은 **한 노드가 후속을 둘 이상 갖는 것**이다. `solveDeps` 는 제약이 없는
 * 노드를 안 매달아서 병렬을 남기므로, 갈라짐 자체는 만들 수 있다 — 못 만드는 것은
 * 「조건에 따라 **둘 중 하나만**」이다. 그래도 사슬인지 아닌지가 첫 신호다:
 * 배타 분기를 요구한 발화에 사슬이 나왔다면 그 둘은 확실히 안 맞는다.
 */
export function isPureChain(deps: Readonly<Record<string, readonly string[]>>): boolean {
  const successors = new Map<string, number>();
  for (const [id, list] of Object.entries(deps)) {
    if (list.length > 1) return false; // 합류가 있으면 사슬이 아니다
    void id;
    for (const dep of list) successors.set(dep, (successors.get(dep) ?? 0) + 1);
  }
  return [...successors.values()].every((count) => count <= 1);
}

/**
 * 발화와 계획을 대조한다.
 *
 * @param utterance 사람이 말한 문장.
 * @param deps      규칙이 매단 의존 (`solveDeps` 의 결과).
 * @param loopEdges 되돌아가는 엣지의 수. **지금 생성 경로는 언제나 0이다** — 그것이
 *                  이 경고가 루프를 늘 잡는 이유이고, 인자로 받아 두는 것은 만들게 되는
 *                  날 이 함수가 저절로 조용해지게 하기 위해서다.
 */
export function planShapeWarnings(
  utterance: string,
  deps: Readonly<Record<string, readonly string[]>>,
  loopEdges = 0,
): PlanShapeWarning[] {
  const warnings: PlanShapeWarning[] = [];
  // 노드가 없으면 대조할 계획이 없다. 「모양이 틀렸다」가 아니라 「아직 없다」다.
  if (Object.keys(deps).length === 0) return warnings;

  const loop = found(utterance, LOOP_MARKERS);
  if (loop.length > 0 && loopEdges === 0) {
    warnings.push({
      kind: 'loop',
      markers: loop,
      message: '발화가 되풀이를 요구하는데 이 계획에는 되돌아가는 길이 없습니다 —'
        + ' 지금 생성 경로는 순환 없는 계획만 만들 수 있어, 조건이 안 맞아도 다시 돌아가지 않고 다음 단계로 갑니다.',
    });
  }

  const branch = found(utterance, BRANCH_MARKERS);
  if (branch.length > 0 && isPureChain(deps)) {
    warnings.push({
      kind: 'branch',
      markers: branch,
      message: '발화가 둘 중 하나를 고르라고 하는데 이 계획은 한 줄로 이어져 있습니다 —'
        + ' 갈라져야 할 두 갈래가 순서대로 붙어 「둘 다 차례로 한다」로 읽힙니다.',
    });
  }
  return warnings;
}

/**
 * 기록에 싣는 모양 (snake_case). `provenancePayload` 와 같은 규칙이다 —
 * 화면 표기가 그대로 기록에 들어가면 기록의 표기가 화면을 따라 흔들린다.
 */
export function warningsPayload(warnings: readonly PlanShapeWarning[]): Array<Record<string, unknown>> {
  return warnings.map((warning) => ({ kind: warning.kind, markers: [...warning.markers], message: warning.message }));
}
