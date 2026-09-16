/**
 * src/shared/provenance.ts (260907 신설 — 9단계 · 지시서 §6)
 *
 * **AI 가 만든 것의 생성 근거.** `produced_by=ai` 옆에 붙어 다니는 것들이다.
 *
 * ## 왜 별도 요구사항인가 — `VZ-G-01` 의 문장 그대로
 *
 * 「역추적이 맨 위까지 닿는다」가 성립하려면, 임무 객체 하나를 들고 **누가 왜 이렇게
 * 만들었는가**를 물었을 때 답이 그 기록 안에 있어야 한다. 모델 이름만으로는 모자란다 —
 * 같은 모델도 프롬프트가 다르면 다른 것을 낸다. 그래서 셋을 함께 든다:
 * **모델 · 프롬프트 지문 · 적용된 규칙 목록.**
 *
 * ## 이 파일이 `generate/` 밖에 있는 이유
 *
 * 이 타입을 `generate/` 에 두면 **`data/scenario.ts` 가 생성 계층을 import 하게 된다.**
 * 그러면 「생성 서비스가 없어도 대본 재생·되감기·캔버스가 돈다」의 구조적 근거가 무너지고,
 * `verify:no-llm` 의 넷째 검사가 지키려던 것이 사라진다. 타입만이라도 마찬가지다 —
 * 오늘 타입인 것이 내일 함수가 된다.
 *
 * 그래서 **근거의 모양은 중립 자리에 두고**, 생성 결과에서 이 모양을 만드는 일만
 * `generate/proposal.ts` 가 한다. 임무 저장소는 「AI 가 만든 것에는 근거가 붙는다」만 알고
 * 어떤 서비스가 만들었는지는 모른다.
 */

/**
 * 부르는 쪽 값으로 덮어쓴 자리 (9단계 · 서비스의 `_apply_caller_values`).
 *
 * **비어 있는 것이 정상이다** — 모델이 그대로 옮겨 적었다는 뜻이다. 비어 있지 않으면
 * 「모델이 되받아 적다가 틀렸고 우리가 고쳤다」이고, 그 사실을 감추지 않는다.
 */
export type OverwrittenField = { field: string; model: unknown; used: unknown };

/**
 * 발화가 요구한 모양과 계획의 모양이 어긋난 자리 (11단계).
 *
 * **경고이지 차단이 아니다.** 생성은 그대로 되고, 사람이 승인을 판단할 재료가 하나
 * 늘 뿐이다. 이 자리가 비어 있는 것과 「검사하지 않았다」는 다르므로, 검사한 결과
 * 없으면 빈 배열이다.
 */
export type PlanShapeNote = { kind: 'loop' | 'branch'; markers: readonly string[]; message: string };

export type AiProvenance = {
  /** `VZ-D-08` 의 `produced_by`. 이 값이 `human`·`backend` 와 화면에서 갈리는 근거다. */
  producedBy: 'ai';
  /** 무엇이 냈는가. 엔진이 없으면 `stub` 이고 `stub: true` 가 함께 선다 — 목을 감추지 않는다. */
  engine: string;
  model: string;
  stub: boolean;
  /**
   * 프롬프트 지문. 원문을 싣지 않는다 — 문법 지문과 같은 성질이고, 「같은 프롬프트였나」에
   * 답할 수 있으면 된다. 원문을 만드는 코드는 커밋에 있다(`gen-lab/server/prompt.py`).
   * 스텁에는 프롬프트가 없어 `null` 이다 — 빈 문자열이 아니다.
   */
  promptDigest: string | null;
  promptChars: number | null;
  /** 계약에서 뽑은 문법의 출처와 지문. 「계약 밖 출력을 요구하지 않았다」의 증거. */
  grammar: { source: string | null; digest: string | null; bytes: number } | null;
  /**
   * 적용된 규칙 목록. **서비스의 `rules_for()` 가 준 그대로다.**
   * 화면이 따로 적으면 모델이 지킨 규칙과 사람이 본 규칙이 갈라진다.
   * 스텁은 프롬프트가 없으므로 `null` — 빈 배열(「규칙이 0개였다」)과 다른 말이다.
   */
  rules: readonly string[] | null;
  overwritten: readonly OverwrittenField[];
  /**
   * 계약 검증 결과. **비어 있지 않아도 제안은 뜬다** — 사람이 보고 판단할 자리이지
   * 조용히 버릴 자리가 아니다. 문법은 구조와 타입을 고정하지만 값의 범위는 못 건다
   * (7단계 §5 — `confidence: 5` 가 문법을 통과하고 스키마에서 잡혔다).
   */
  schemaErrors: readonly string[];
  elapsedSec: number;
  /**
   * 발화와 계획의 모양이 어긋난 자리 (11단계). **빈 배열이 정상이다.**
   *
   * 근거에 함께 싣는 이유는 역추적이다 — 나중에 「이 임무는 왜 이렇게 생겼나」를 물었을 때
   * 「그때 이미 어긋난다고 적혀 있었고 사람이 그것을 보고 승인했다」가 기록에 남아야 한다.
   */
  shapeWarnings: readonly PlanShapeNote[];
  /** 프롬프트에 실제로 실린 재료. 「무엇을 주고 얻은 답인가」가 근거의 일부다. */
  examplesGiven: number;
  placesGiven: boolean;
  equipmentGiven: number;
  nodeKindsGiven: boolean;
};

/**
 * 기록 열에 싣는 모양. **계약·기록의 표기(snake_case)로 편다** —
 * 화면 타입(camelCase)이 그대로 기록에 들어가면 기록의 표기가 화면을 따라 흔들린다.
 *
 * 규칙 목록은 **줄이지 않는다.** 「길어서 앞 세 줄만」이 되는 순간 역추적이 그 자리에서
 * 끊긴다.
 */
export function provenancePayload(provenance: AiProvenance): Record<string, unknown> {
  return {
    produced_by: provenance.producedBy,
    engine: provenance.engine,
    model: provenance.model,
    stub: provenance.stub,
    prompt_digest: provenance.promptDigest,
    prompt_chars: provenance.promptChars,
    grammar: provenance.grammar,
    rules_applied: provenance.rules === null ? null : [...provenance.rules],
    overwritten: [...provenance.overwritten],
    schema_errors: [...provenance.schemaErrors],
    elapsed_sec: provenance.elapsedSec,
    shape_warnings: provenance.shapeWarnings.map((note) => ({ ...note, markers: [...note.markers] })),
    materials: {
      examples: provenance.examplesGiven,
      places: provenance.placesGiven,
      equipment: provenance.equipmentGiven,
      node_kinds: provenance.nodeKindsGiven,
    },
  };
}
