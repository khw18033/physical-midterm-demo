/**
 * src/shared/voiceAudit.ts
 *
 * 음성 명령의 **가드**다 (REQ-1305 / VZ-O-03). 발행 전에 막는 자리라 추적기 앞에 있다.
 *
 * **이름을 붙이는 일은 여기서 하지 않는다.** 통합 때 `auditFieldMap.ts`로 합류시켰다 —
 * 감사 필드 이름을 한 파일에 가두는 것이 그 파일의 목적인데, 음성 경로만 따로 이름을 만들면
 * 두 벌이 되고 백엔드가 철자를 확정하는 날 두 곳을 고쳐야 한다.
 * 그래서 이 파일에 남은 것은 **검사뿐**이고, 통과한 값은 `buildAuditPayload()`로 넘어간다.
 *
 * 의존은 여전히 타입 하나뿐이다 — `verify:voice-audit`이 브라우저 없이 이 함수를 실제로
 * 불러 보고, `voice`가 빠진 요청이 정말 거부되는지 **런타임에서** 확인할 수 있어야 한다.
 *
 * 타입만으로 막지 않는 이유: 나중에 다른 사람이 음성 경로를 하나 더 붙일 때 `as any`
 * 한 번이면 타입 검사는 통과한다. 조용히 빠지는 곳이라 런타임에서도 막는다.
 *
 * **기록은 백엔드 audit-writer가 한다.** 브라우저는 감사 필드를 만들어 전달만 한다.
 */

import type { VoiceAuditPayload } from './auditFieldMap.ts';

export type InputModality = 'pointer' | 'voice';

/**
 * 음성으로 들어온 명령의 출처. **정의는 `auditFieldMap.ts`에 하나뿐이다** — 여기서 다시 만들지 않는다.
 *
 * `transcript`와 `transcript_edited`를 둘 다 남기는 이유와 세 수치를 합치지 않는 이유는
 * 그 파일의 타입 주석에 있다.
 */
export type VoiceAudit = VoiceAuditPayload;

/** 키가 반드시 있어야 하는 항목. 값의 null 여부는 따지지 않는다. */
export const VOICE_AUDIT_KEYS = [
  'transcript',
  'transcript_edited',
  'avg_logprob',
  'no_speech_prob',
  'mean_word_prob',
  'engine',
  'model',
  'audio_ref',
] as const;

/** 문자열이어야 하는 항목. 비어 있으면 채우지 않은 것으로 본다. */
const REQUIRED_TEXT_KEYS = ['transcript', 'transcript_edited', 'engine', 'model', 'audio_ref'] as const;

export class CommandAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandAuditError';
  }
}

/** 가드를 통과한 값. `auditFieldMap.buildAuditPayload()`가 여기에 이름을 붙인다. */
export type CheckedAudit = {
  /** `auditFieldMap`의 입력 수단 어휘. `pointer`는 그쪽에서 `click`이다. */
  inputMode: 'click' | 'voice';
  voice?: VoiceAudit;
};

/**
 * 감사 필드로 넘길 값을 검사한다. 통과하지 못하면 **던진다** — 발행하지 않는다.
 *
 * `input_modality: 'voice'`인데 `voice`가 비어 있으면 거부한다. 빈 채로 내보내면
 * 그 명령은 "사람이 냈다"는 것 말고는 아무것도 되짚을 수 없는 기록이 된다.
 */
export function buildAudit(modality: InputModality, voice?: VoiceAudit): CheckedAudit {
  if (modality !== 'voice') {
    if (voice) throw new CommandAuditError(`input_modality='${modality}' 인데 voice 필드가 실려 있습니다`);
    return { inputMode: 'click' };
  }
  if (!voice || typeof voice !== 'object') {
    throw new CommandAuditError("input_modality='voice' 인데 voice 감사 필드가 없습니다 (REQ-1305)");
  }
  const missing = VOICE_AUDIT_KEYS.filter((key) => !(key in voice));
  if (missing.length) {
    throw new CommandAuditError(`voice 감사 필드 누락: ${missing.join(', ')} (REQ-1305)`);
  }
  const blank = REQUIRED_TEXT_KEYS.filter((key) => typeof voice[key] !== 'string' || !voice[key].trim());
  if (blank.length) {
    throw new CommandAuditError(`voice 감사 필드가 비어 있습니다: ${blank.join(', ')} (REQ-1305)`);
  }
  return { inputMode: 'voice', voice: { ...voice } };
}
