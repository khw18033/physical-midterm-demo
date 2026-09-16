/**
 * src/scenarios/library.ts
 *
 * **브라우저용** 대본 라이브러리 — 대본 네 편과 옛 편 사이드카를 번들에 싣는다.
 *
 * 단독 빌드(게이트웨이 없음)에서도 문장 → 탭① 전환이 동작해야 하므로(지시서 §흐름)
 * 대본이 번들에 들어간다. 번들 크기 전후는 보고서에 기록한다(논문 측정축 D).
 *
 * 게이트웨이는 같은 JSON 파일을 readFileSync 로 읽는다(`gateway/script-engine.ts`) —
 * Node ESM 의 JSON import 제약 때문에 적재 경로만 다르고, **목록은 manifest.ts,
 * 매칭은 matcher.ts 하나**를 같이 쓴다. 아래 기동 검사가 목록과 실물의 어긋남을 잡는다.
 */

import legacySidecar from '../../scenarios/MSN-260826-01.match.json' with { type: 'json' };
import script01 from '../../scenarios/MSN-260831-01.json' with { type: 'json' };
import script02 from '../../scenarios/MSN-260831-02.json' with { type: 'json' };
import script03 from '../../scenarios/MSN-260831-03.json' with { type: 'json' };
import script04 from '../../scenarios/MSN-260909-01.json' with { type: 'json' };
import { LEGACY_ID, SCRIPT_IDS } from './manifest.ts';
import type { ScriptLibraryEntry, ScriptScenario } from './types.ts';

const scripts = [script01, script02, script03, script04] as unknown as ScriptScenario[];

// 목록(manifest)과 실물(import)의 대조 — 대본을 더할 때 한쪽만 늘면 여기서 즉시 죽는다.
{
  const imported = scripts.map((s) => s.missionId).join(',');
  const listed = SCRIPT_IDS.join(',');
  if (imported !== listed) {
    throw new Error('대본 라이브러리 불일치 — manifest [' + listed + '] vs import [' + imported + ']');
  }
  if ((legacySidecar as { missionId: string }).missionId !== LEGACY_ID) {
    throw new Error('옛 편 사이드카의 missionId 가 manifest 와 다르다');
  }
}

export const SCRIPT_LIBRARY: readonly ScriptLibraryEntry[] = [
  ...scripts.map((script) => ({
    missionId: script.missionId,
    world: 'registry' as const,
    match: script.match,
    script,
  })),
  {
    missionId: LEGACY_ID,
    world: 'legacy' as const,
    match: (legacySidecar as { match: ScriptLibraryEntry['match'] }).match,
    // legacy 편의 본문은 기존 경로(src/data/scenario.ts 의 번들 Scenario)가 갖고 있다.
    script: null,
  },
];

export function libraryEntry(missionId: string): ScriptLibraryEntry | null {
  return SCRIPT_LIBRARY.find((entry) => entry.missionId === missionId) ?? null;
}
