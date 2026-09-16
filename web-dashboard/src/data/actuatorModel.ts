/**
 * src/data/actuatorModel.ts
 *
 * 액추에이터 **도메인 어휘** (VZ-U-01).
 *
 * 수문·펌프는 대기 / 동작 중 / 완료 / 오류 / 확인 불가라는 자기만의 상태를 갖는다.
 * 이건 표준 3층(device_status·availability·deployment)과 **별개**이며, 공통 컴포넌트가
 * 하드코딩해서는 안 된다 — 그래서 statusModel.ts가 아니라 여기에 따로 둔다.
 *
 * 두 어휘는 같은 카드에 나란히 표시된다. 3층은 "이 장비의 소식을 듣고 있는가"를 말하고,
 * 도메인 어휘는 "이 장비가 지금 무엇을 하고 있는가"를 말한다. 겹치지 않는다.
 */

import type { ActuatorState } from '../transport/index.ts';

export type ActuatorPhase = ActuatorState['phase'];

export const ACTUATOR_PHASE_LABEL: Record<ActuatorPhase, string> = {
  idle: '대기',
  moving: '동작 중',
  completed: '완료',
  error: '오류',
  unverified: '확인 불가',
};

/**
 * 명령 3상태 표시(REQ-903)는 이 파일이 아니라 `commands.ts`가 갖는다.
 * 액추에이터 도메인 어휘와 명령 결과는 층이 다르다 — 전자는 "이 장비가 지금 무엇을
 * 하고 있나", 후자는 "내가 보낸 명령이 어디까지 갔나"다. 한 파일에 두면 액추에이터가
 * 아닌 대상에 명령을 보낼 때 어휘가 딸려 온다.
 */

export function describeActuator(state: ActuatorState | null): string {
  if (state === null) return '상태 미수신';
  if (state.control_locked) return state.lock_reason ?? '제어 잠금';
  if (state.phase === 'moving' && state.progress_pct !== null) {
    return '진행 ' + state.progress_pct.toFixed(0) + '% · 개도 ' + (state.position_pct ?? 0).toFixed(0) + '%';
  }
  return '개도 ' + (state.position_pct ?? 0).toFixed(0) + '%';
}
