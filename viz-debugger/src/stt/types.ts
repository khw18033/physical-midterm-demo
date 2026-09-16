/**
 * src/stt/types.ts
 *
 * STT 서비스 응답의 클라이언트 측 정의. **수치를 요약하지 않는다.**
 *
 * Whisper 계열은 명령 수락 여부를 바로 정할 단일 confidence 를 주지 않는다.
 * `avg_logprob`·`no_speech_prob`·평균 단어 확률을 임의로 가중합해 0~1 점수 하나로
 * 뭉개면 `VZ-L-03` 임계를 실측할 근거가 사라지므로, 셋을 **각각 그대로** 들고 다닌다.
 * 판정은 confidence.ts 한 곳에서만 한다.
 */

export type SttSegment = {
  index: number;
  start: number;
  end: number;
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio: number;
};

export type SttWord = {
  segment: number;
  start: number;
  end: number;
  word: string;
  probability: number;
};

/** 서비스 응답 한 건. 필드 이름과 구조를 서비스와 같게 둔다. */
export type SttResult = {
  /** 보관된 녹음의 참조. `contracts/mission.schema.json` 의 `utterance.audio_ref`. */
  audio_ref: string;
  text: string;
  segments: SttSegment[];
  words: SttWord[];
  engine: string;
  model: string;
  device: string;
  compute_type: string;
  duration_sec: number;
  elapsed_sec: number;
  load_sec: number;
  rtf: number;
  /** 요청했지만 안 먹은 옵션까지 드러난다 (engines/base.py 의 규칙). */
  applied_options: Record<string, unknown>;
  extra: Record<string, unknown>;
  /** 세그먼트 중 **최소**. 평균을 내면 한 구간의 오인식이 나머지에 묻힌다. */
  avg_logprob: number | null;
  /** 세그먼트 중 **최대**. 무음·잡음 구간이 하나라도 있으면 그것이 대표값이다. */
  no_speech_prob: number | null;
  mean_word_prob: number | null;
  min_word_prob: number | null;
  word_count: number;
  segment_count: number;
};

/** 서비스가 그대로 넘겨 준 실패. 화면은 이 문장을 감추지 않고 보여준다. */
export class SttUnavailableError extends Error {
  // 파라미터 프로퍼티(`constructor(readonly detail)`)를 쓰지 않는다 —
  // tsconfig 의 erasableSyntaxOnly 와 Node 의 타입 스트리핑이 둘 다 거부한다.
  /** `offline` = 프로세스에 닿지 못함(기능을 끈다). `service` = 닿았는데 그 요청이 실패함(다시 시도할 수 있다). */
  kind: 'offline' | 'service';
  detail?: string;

  constructor(kind: 'offline' | 'service', message: string, detail?: string) {
    super(message);
    this.name = 'SttUnavailableError';
    this.kind = kind;
    this.detail = detail;
  }
}
