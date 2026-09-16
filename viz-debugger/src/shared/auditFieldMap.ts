// 이식: web-dashboard/src/data/auditFieldMap.ts @ 700ed91 — 음성 감사 필드 합류
// 위치를 data/ 에서 shared/ 로 옮겼다. 감사 필드 이름을 한 파일에 가두는 것이 이 파일의 목적인데,
// 탭 안에 두면 탭①(음성)과 탭③(제어)이 각자 이름을 만들게 된다.
/**
 * src/data/auditFieldMap.ts
 *
 * 감사 필드 이름을 **이 파일 하나에 가둔다** (VZ-O-03 · VZ-I-05).
 *
 * 왜 격리하는가 —
 * 음성으로 말했고 LLM이 해석한 경우, 현재 어휘로는 "입력 수단"과 "판단 주체" 중
 * **하나만 골라야 한다.** 어느 쪽을 버려도 사고 원인(잘못 들었나 / 잘못 해석했나)을
 * 구분할 수 없어서, 두 축으로 나누자고 백엔드에 요청 중이다.
 *
 * 즉 **필드 이름이 바뀔 것이 예정되어 있다.** 컴포넌트가 `record.input_mode` 같은 이름을
 * 직접 읽으면 확정되는 날 화면 전체를 뒤져야 한다. 그래서 컴포넌트는 아래 `AuditEntry`라는
 * 표시용 형태만 알고, 이름 매핑은 여기서만 한다. 확정되면 이 파일만 고치면 된다.
 *
 * 후보 이름을 배열로 둔 이유: 백엔드가 `input.mode` / `input_mode` / 그 밖의 무엇을 고르든
 * 코드 변경 없이 받아지게 하려는 것이다. 확정되면 배열을 하나로 줄인다.
 */

/**
 * 음성 감사 필드의 내용물 (REQ-1305). **세 수치를 하나로 합치지 않는다** —
 * 합치면 VZ-L-03 임계를 실측할 근거가 사라진다. 값이 null 인 것은 정상이고
 * (무음이라 세그먼트가 0건인 경우 등) 키가 없는 것은 정상이 아니다.
 */
export type VoiceAuditPayload = {
  transcript: string;
  transcript_edited: string;
  avg_logprob: number | null;
  no_speech_prob: number | null;
  mean_word_prob: number | null;
  engine: string;
  model: string;
  audio_ref: string;
};

/** 화면이 아는 유일한 형태. 여기에는 와이어 필드 이름이 없다. */
export type AuditEntry = {
  commandId: string | null;
  /** 서버 시각 ISO. 표시 문자열 변환은 화면이 한다. */
  occurredAt: string | null;
  actorName: string | null;
  actorRole: string | null;
  entity: string | null;
  action: string | null;
  result: string | null;
  /** 기록 작성 주체. "가시화가 쓰지 않는다"를 화면에서 보이기 위해 표시한다. */
  writtenBy: string | null;
  /**
   * 화면에 그대로 늘어놓을 표시행. 라벨까지 여기서 만든다 —
   * 컴포넌트가 라벨을 만들면 필드가 늘어날 때 컴포넌트를 또 고쳐야 한다.
   */
  rows: Array<{ label: string; value: string; muted?: boolean }>;
};

/**
 * 후보 이름 목록. 앞에 있는 것부터 찾는다.
 * ※ 확정 대기 — 백엔드에 `input.mode`(입력 수단)와 `decision.source`(판단 주체)
 *   **두 축 분리**를 요청해 둔 상태다.
 */
const FIELD_CANDIDATES = {
  commandId: ['command_id', 'commandId', 'correlation_id'],
  occurredAt: ['occurred_at', 'occurredAt', 'ts', 'timestamp'],
  actorName: ['actor_display_name', 'actor.display_name', 'operator_name', 'actor'],
  actorRole: ['actor_role', 'actor.role', 'role'],
  entity: ['entity', 'target', 'target_id'],
  action: ['action', 'command_action'],
  result: ['result', 'status', 'outcome'],
  writtenBy: ['written_by', 'writer', 'recorded_by'],
  /** 축 1 — 무엇으로 입력했나 (클릭/음성/API). */
  inputMode: ['input.mode', 'input_mode', 'inputMode', 'input_channel'],
  /** 축 2 — 누가 판단했나 (사람/LLM 제안 수락/자동). */
  decisionSource: ['decision.source', 'decision_source', 'decisionSource', 'authority'],
  /** LLM 제안을 사람이 고쳤는가. 두 축만으로는 안 잡히는 세 번째 정보. */
  suggestionModified: ['suggestion_modified', 'decision.modified', 'modified'],
  transcript: ['voice.transcript', 'voice_transcript', 'transcript', 'input.transcript'],
  transcriptEdited: ['voice.transcript_edited', 'voice_transcript_edited'],
  sttEngine: ['voice.engine', 'stt_engine'],
  sttModel: ['voice.model', 'stt_model'],
  audioRef: ['voice.audio_ref', 'audio_ref'],
  llmModel: ['llm_model', 'model', 'decision.model'],
} as const;

/** 점 표기(`input.mode`)를 중첩 객체 접근으로도 시도한다. */
function pick(record: Record<string, unknown>, candidates: readonly string[]): unknown {
  for (const key of candidates) {
    if (key in record && record[key] != null) return record[key];
    if (key.includes('.')) {
      let cursor: unknown = record;
      for (const part of key.split('.')) {
        if (typeof cursor !== 'object' || cursor === null) {
          cursor = undefined;
          break;
        }
        cursor = (cursor as Record<string, unknown>)[part];
      }
      if (cursor != null) return cursor;
    }
  }
  return undefined;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** 코드값 → 사람이 읽는 말. 여기 말고 컴포넌트에 두면 화면마다 다른 말이 나온다. */
const INPUT_MODE_LABEL: Record<string, string> = {
  click: '클릭',
  voice: '음성',
  api: 'API',
  keyboard: '키보드',
};

const DECISION_SOURCE_LABEL: Record<string, string> = {
  human: '사람',
  llm_suggestion_accepted: 'LLM 제안 수락',
  llm_suggestion_modified: 'LLM 제안 수정 후 수락',
  automatic: '자동',
};

const RESULT_LABEL: Record<string, string> = {
  completed: '완료',
  failed: '실패',
  rejected: '거부',
  timeout: '시간 초과',
  accepted: '진행중',
};

export function toAuditEntry(raw: unknown): AuditEntry {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const inputMode = str(pick(record, FIELD_CANDIDATES.inputMode));
  const decisionSource = str(pick(record, FIELD_CANDIDATES.decisionSource));
  const modified = pick(record, FIELD_CANDIDATES.suggestionModified);
  const transcript = str(pick(record, FIELD_CANDIDATES.transcript));
  const llmModel = str(pick(record, FIELD_CANDIDATES.llmModel));
  const entity = str(pick(record, FIELD_CANDIDATES.entity));
  const result = str(pick(record, FIELD_CANDIDATES.result));

  const rows: AuditEntry['rows'] = [];

  // 두 축을 **각각** 보여준다. 하나로 합치면 "잘못 들었나 / 잘못 해석했나"를 구분할 수 없다.
  rows.push({
    label: '입력 수단',
    value: inputMode === null ? '미기록' : (INPUT_MODE_LABEL[inputMode] ?? inputMode),
    muted: inputMode === null,
  });
  rows.push({
    label: '판단 주체',
    value: decisionSource === null ? '미기록' : (DECISION_SOURCE_LABEL[decisionSource] ?? decisionSource),
    muted: decisionSource === null,
  });

  if (modified != null) {
    rows.push({ label: '제안 수정', value: modified === true || modified === 'true' ? '있음' : '없음' });
  }
  if (transcript !== null) rows.push({ label: '전사(원문)', value: transcript });
  // 원문과 수정본을 **둘 다** 보인다. 원문만 남기면 사람이 고친 오인식을 놓치고,
  // 수정본만 남기면 STT 성능을 나중에 평가할 수 없다 (REQ-1303 · REQ-1305).
  const transcriptEdited = str(pick(record, FIELD_CANDIDATES.transcriptEdited));
  if (transcriptEdited !== null && transcriptEdited !== transcript) {
    rows.push({ label: '전사(수정본)', value: transcriptEdited });
  }
  const sttEngine = str(pick(record, FIELD_CANDIDATES.sttEngine));
  const sttModel = str(pick(record, FIELD_CANDIDATES.sttModel));
  if (sttEngine !== null) rows.push({ label: 'STT 엔진', value: sttModel === null ? sttEngine : sttEngine + ' · ' + sttModel });
  const audioRef = str(pick(record, FIELD_CANDIDATES.audioRef));
  if (audioRef !== null) rows.push({ label: '녹음', value: audioRef });
  if (llmModel !== null) rows.push({ label: 'LLM', value: llmModel });
  if (entity !== null) rows.push({ label: '대상', value: entity });
  rows.push({
    label: '결과',
    value: result === null ? '미기록' : (RESULT_LABEL[result] ?? result),
    muted: result === null,
  });

  return {
    commandId: str(pick(record, FIELD_CANDIDATES.commandId)),
    occurredAt: str(pick(record, FIELD_CANDIDATES.occurredAt)),
    actorName: str(pick(record, FIELD_CANDIDATES.actorName)),
    actorRole: str(pick(record, FIELD_CANDIDATES.actorRole)),
    entity,
    action: str(pick(record, FIELD_CANDIDATES.action)),
    result,
    writtenBy: str(pick(record, FIELD_CANDIDATES.writtenBy)),
    rows,
  };
}

/**
 * 명령에 동봉할 책임소재 필드를 만든다 (VZ-O-03).
 * **이름을 만드는 곳도 여기 하나뿐이다.** 컴포넌트는 '클릭이었다'는 사실만 넘긴다.
 *
 * 조작자와 시각은 넣지 않는다 — 백엔드가 토큰과 서버 시각에서 주입한다.
 * 브라우저가 넣으면 조작자는 자기신고가 되고 시각은 사용자 PC 시계가 된다.
 */
export function buildAuditPayload(input: {
  inputMode: 'click' | 'voice' | 'api' | 'keyboard';
  decisionSource: 'human' | 'llm_suggestion_accepted' | 'llm_suggestion_modified' | 'automatic';
  transcript?: string;
  llmModel?: string;
  suggestionModified?: boolean;
  /**
   * 음성으로 발행된 명령의 출처 (REQ-1305). 검증은 shared/voiceAudit.ts 의 가드가 하고
   * **이름을 붙이는 것은 여기서만** 한다 — 그것이 이 파일의 목적이다.
   */
  voice?: VoiceAuditPayload;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // 확정 전이므로 요청 중인 두 축 이름을 쓴다. 바뀌면 이 두 줄만 고친다.
    input_mode: input.inputMode,
    decision_source: input.decisionSource,
  };
  if (input.suggestionModified !== undefined) payload.suggestion_modified = input.suggestionModified;
  if (input.transcript !== undefined) payload.voice_transcript = input.transcript;
  if (input.llmModel !== undefined) payload.llm_model = input.llmModel;
  if (input.voice !== undefined) {
    // REQ-1305 의 문구가 `voice.transcript` 이므로 중첩 객체로 싣는다.
    payload.voice = { ...input.voice };
    // 평면 이름으로도 한 번 더 싣는다 — 위 toAuditEntry 의 후보 목록이 둘 다 받도록
    // 되어 있고, 백엔드가 어느 철자를 고를지 아직 확정 전이기 때문이다.
    payload.voice_transcript = input.voice.transcript;
  }
  return payload;
}
