/**
 * src/generate/types.ts (260904 신설 — 마일스톤 분리 지시서 §3)
 *
 * 생성 서비스 응답의 클라이언트 측 정의.
 *
 * **모델의 출력을 여기서 요약하지 않는다.** `SttClient` 가 `avg_logprob`·`no_speech_prob`·
 * 단어 확률 셋을 각각 그대로 들고 다니는 것과 같은 이유다 — 「스키마 통과 · 마일스톤 개수 ·
 * 장소 어휘 · 응답 시간」을 임의로 가중합해 점수 하나로 뭉개면 **네 축을 가른 의미가
 * 사라진다**(지시서 §2 · `scripts/score-generation.mjs`).
 */

/** `contracts/mission.schema.json` 의 임무 객체. 계약이 원본이므로 여기서는 얇게만 적는다. */
export type GeneratedMission = {
  mission_id: string;
  utterance: {
    audio_ref: string | null;
    text: string;
    engine: string;
    /** `confidence_signals.unit_mean` 과 같은 값이다. **가중합이 아니다** (§7.8 · 260906 결정). */
    confidence: number;
    /**
     * 엔진이 준 수치 셋. **선택 필드다** — 저작된 문장(`engine: 'script'`·스텁)에는 없다.
     * 자리를 채우는 규칙은 `stt/confidence.ts` 의 `toUtterance()` 한 곳에 있다.
     */
    confidence_signals?: { primary: number | null; no_speech: number | null; unit_mean: number | null };
  };
  milestones: Array<{
    milestone_id: string;
    title: string;
    order: number;
    status: string;
    assigned_targets: string[];
    /**
     * 계획 주석 (260908 · `milestone.schema.json` 의 선택 필드). **없는 것이 정상이다** —
     * 분기도 되풀이도 없는 계획이 대부분이고, 규칙은 안 주면 지금까지와 똑같이 돈다.
     */
    branch?: { from: string; when: 'pass' | 'fail' };
    repeat_of?: { to: string; when: 'pass' | 'fail' };
    tasks: Array<{
      task_id: string;
      title: string;
      deps: string[];
      status: string;
      attempt: number;
      derived_from: string | null;
      action_items: unknown[];
      evaluation: unknown;
      node_kind?: 'sense' | 'decide' | 'act' | 'verify' | 'report';
    }>;
  }>;
};

/**
 * 생성 한 건의 결과. **근거를 함께 돌려준다** — 어느 모델이 어느 문법으로 냈는지가
 * 없으면 `VZ-G-01` 의 「역추적이 맨 위까지 닿는다」가 성립하지 않는다(§6 이 이 값을
 * `produced_by=ai` 기록에 싣는다).
 */
export type GenerateResult = {
  mission: GeneratedMission;
  /** 어느 모델이 냈는가. 스텁이면 `stub`. */
  engine: string;
  model: string;
  /** 서비스가 실제로 강제한 문법의 이름과 지문. 「계약에서 뽑았다」의 증거다. */
  grammar: { source: string; digest: string; bytes: number } | null;
  /** 서비스가 응답을 계약으로 검증했는가. 스텁의 유일한 일이다. */
  schema_checked: boolean;
  schema_errors: string[];
  elapsed_sec: number;
  /** 서비스가 그대로 넘긴 나머지. 요약하지 않는다. */
  extra: Record<string, unknown>;
};

/** 서비스가 그대로 넘겨 준 실패. 화면은 이 문장을 감추지 않고 보여준다. */
export class LlmUnavailableError extends Error {
  // 파라미터 프로퍼티를 쓰지 않는다 — tsconfig 의 erasableSyntaxOnly 와 Node 의
  // 타입 스트리핑이 둘 다 거부한다 (`SttUnavailableError` 와 같은 제약).
  /** `offline` = 프로세스에 닿지 못함(기능을 끈다). `service` = 닿았는데 그 요청이 실패함(다시 시도할 수 있다). */
  kind: 'offline' | 'service';
  detail?: string;

  constructor(kind: 'offline' | 'service', message: string, detail?: string) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.kind = kind;
    this.detail = detail;
  }
}
