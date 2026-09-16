/**
 * src/data/env.ts
 *
 * 개발 모드 판정 한 곳. Vite 밖(검증 하네스·Node 실행)에서도 모듈이 그대로 돌아가야
 * 데이터 레이어를 브라우저 없이 실측할 수 있으므로, import.meta.env 접근을 여기로 모은다.
 */

const meta = import.meta as unknown as { env?: { DEV?: boolean } };

export const IS_DEV: boolean = meta.env?.DEV ?? true;
