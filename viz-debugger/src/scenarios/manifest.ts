/**
 * src/scenarios/manifest.ts
 *
 * 대본 라이브러리의 **목록 원천.** 파일 이름이 여기 한 곳에만 있다.
 *
 * 데이터 적재 경로는 환경마다 다를 수밖에 없다 — 브라우저는 번들 import(`library.ts`),
 * 게이트웨이는 readFileSync(`gateway/script-engine.ts`), 검증도 readFileSync. 적재가
 * 세 곳이어도 **무엇을 적재하는지는 이 목록 하나**라서, 대본을 더할 때 한쪽만 늘어
 * 조용히 갈라지는 일을 막는다. `library.ts` 가 기동 시 목록과 실제 import 를 대조한다.
 */

/** registry 세계 대본. `scenarios/<id>.json`. */
export const SCRIPT_IDS = ['MSN-260831-01', 'MSN-260831-02', 'MSN-260831-03', 'MSN-260909-01'] as const;

/**
 * 옛 편 — HCI 전달본·논문용이라 파일은 한 글자도 고치지 않는다(verify:scenario).
 * 매칭 규칙은 사이드카 `scenarios/<id>.match.json` 에 있다.
 */
export const LEGACY_ID = 'MSN-260826-01' as const;
