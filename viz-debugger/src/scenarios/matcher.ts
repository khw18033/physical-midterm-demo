/**
 * src/scenarios/matcher.ts
 *
 * 문장 → 대본 매칭. **이것은 LLM이 아니다 — 키워드 대조다.**
 *
 * 게이트웨이(`gateway/script-engine.ts`) · 브라우저(발화 패널 배지·단독 빌드 재생기) ·
 * 검증(`scripts/verify-script-library.mjs`)이 **전부 이 파일 하나**를 import 한다.
 * 매칭 규칙이 두 벌이면 게이트웨이와 화면이 다른 대본을 고르는 날이 온다.
 *
 * 규칙:
 *   - must: 바깥 배열 AND · 안쪽 배열 OR (동의어·오인식 변형)
 *   - any : 비어 있지 않으면 하나는 맞아야 한다
 *   - 정규화: 공백 제거 · 소문자 — 이 한 줄이 대본 파일 match.normalize 문구의 실체다
 *   - **맞는 대본이 없으면 없다고 한다.** 둘 이상 맞아도 고르지 않는다(모호 = 거부).
 *     비슷한 것을 억지로 고르면 「대본 조회」가 LLM 흉내가 된다.
 */

import type { ScriptLibraryEntry, ScriptMatch } from './types.ts';

export function normalize(text: string): string {
  return String(text).replace(/\s+/g, '').toLowerCase();
}

/** 문장이 규칙 하나에 맞는가. */
export function matchesRule(sentence: string, match: ScriptMatch | undefined): boolean {
  if (!match || !Array.isArray(match.must) || match.must.length === 0) return false;
  const text = normalize(sentence);
  const mustOk = match.must.every(
    (group) => Array.isArray(group) && group.some((word) => text.includes(normalize(word))),
  );
  if (!mustOk) return false;
  if (Array.isArray(match.any) && match.any.length > 0) {
    return match.any.some((word) => text.includes(normalize(word)));
  }
  return true;
}

/** 문장에 맞은 must·any 키워드 — 화면이 「어느 키워드가 맞아서 골라졌는지」를 보여줄 재료. */
export function matchedKeywords(sentence: string, match: ScriptMatch): string[] {
  const text = normalize(sentence);
  const hits: string[] = [];
  for (const group of match.must) {
    const hit = group.find((word) => text.includes(normalize(word)));
    if (hit !== undefined) hits.push(hit);
  }
  for (const word of match.any ?? []) {
    if (text.includes(normalize(word))) hits.push(word);
  }
  return hits;
}

export type MatchOutcome =
  | { kind: 'matched'; entry: ScriptLibraryEntry; keywords: string[] }
  | { kind: 'none'; reason: string }
  | { kind: 'ambiguous'; candidates: string[]; reason: string };

/**
 * 라이브러리 전체 대조. 정확히 하나면 그 하나, 없거나 둘 이상이면 고르지 않는다.
 * 거부 사유 문구까지 여기서 만든다 — 게이트웨이와 화면이 같은 말을 해야 한다.
 */
export function matchLibrary(sentence: string, library: readonly ScriptLibraryEntry[]): MatchOutcome {
  const hits = library.filter((entry) => matchesRule(sentence, entry.match));
  if (hits.length === 1) {
    return { kind: 'matched', entry: hits[0], keywords: matchedKeywords(sentence, hits[0].match) };
  }
  if (hits.length === 0) {
    return { kind: 'none', reason: '맞는 대본이 없다 — 억지로 고르지 않는다 (대본 조회는 LLM이 아니다)' };
  }
  return {
    kind: 'ambiguous',
    candidates: hits.map((entry) => entry.missionId),
    reason: '문장이 대본 ' + hits.map((entry) => entry.missionId).join(', ') + ' 에 함께 맞아 고르지 않았다',
  };
}
