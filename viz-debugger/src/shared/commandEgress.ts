/**
 * src/shared/commandEgress.ts
 *
 * 앱 전체의 유일한 명령 출구 — 의 **얇은 껍데기**다.
 *
 * 실제 발행·추적은 `commandCenter.ts`의 `CommandTracker`가 한다. 이 파일이 남아 있는 이유는
 * 두 가지다.
 *   1. 탭①·셸·`ActionModal`·`UtterancePanel`의 호출부가 `issueCommand({action, entity, params})`
 *      형태로 이미 쓰여 있고, **그 호출부를 한 줄도 고치지 않기 위해서**다.
 *   2. 음성 감사 필드의 가드(`voiceAudit.ts`)를 통과시키는 자리가 필요하다. 발행 전에
 *      막아야 하므로 추적기 안이 아니라 그 앞이어야 한다.
 *
 * **전송 계층 호출은 여기에 없다.** 통합 전에는 여기 있었지만, 탭②~⑥이 들어오면서
 * 4단계 추적·상관 키 매핑·만료 처리를 가진 `CommandTracker`가 출구 본체가 됐다.
 * 반대로 접었다면 `VZ-O-02`(4단계 추적)와 `VZ-O-03`(감사)이 통째로 사라졌을 것이다.
 */

import { currentMission } from '../data/scenario.ts';
import type { ActionSpec } from '../transport/index.ts';
import { commandTracker, type TrackedCommand } from './commandCenter.ts';
import { pushNotification } from './notifications.ts';
import { buildAudit, CommandAuditError, type InputModality, type VoiceAudit } from './voiceAudit.ts';

export type AppCommand = {
  action: string;
  entity?: string;
  params?: Record<string, unknown>;
  /** 무엇으로 낸 명령인가. 생략하면 화면 조작(`pointer`)이다. */
  inputModality?: InputModality;
  /** `inputModality: 'voice'` 일 때 **반드시** 있어야 한다 (REQ-1305). */
  voice?: VoiceAudit;
};

/**
 * 액션 카탈로그 없이 나가는 명령의 최소 명세.
 *
 * 탭③은 게이트웨이가 내려준 `ActionSpec`을 그대로 넘기지만, 셸의 임무 제어와 발화 발행은
 * 카탈로그에 없는 명령이다. 그렇다고 추적기에 두 번째 입구를 내면 출구가 둘이 되므로,
 * **여기서 최소 명세를 만들어 같은 입구로 보낸다.**
 */
function specFor(action: string): ActionSpec {
  return { action, label: action, targetPct: 0, irreversible: false, resultingState: '' };
}

/** 앱 전체의 유일한 명령 출구. 셸과 모든 탭은 이 함수 또는 `commandTracker.issue()`를 부른다. */
export async function issueCommand(command: AppCommand): Promise<TrackedCommand> {
  // 대상 없는 명령(임무 제어·발화)은 **현재 임무**가 대상이다 — 한 편이 박혀 있던 자리.
  const entity = command.entity ?? currentMission().missionId;
  const modality = command.inputModality ?? 'pointer';
  let audit: { inputMode: 'click' | 'voice'; voice?: VoiceAudit };
  try {
    // 감사 필드를 **만들 수 없으면 발행하지 않는다.** 절반만 남은 기록이 아무 기록도 없는 것보다 나쁘다.
    audit = buildAudit(modality, command.voice);
  } catch (error) {
    if (error instanceof CommandAuditError) {
      pushNotification({ id: `audit-${Date.now()}`, source: 'command', message: `${command.action} 발행 거부 — ${error.message}`, occurredAt: new Date().toISOString() });
    }
    throw error;
  }
  // 사람 조작 기록(`VZ-D-08`)은 **출구 본체**가 한다 (260904 — commandCenter.issue).
  // 여기서 하면 추적기를 직접 부르는 화면이 기록 없이 샌다.
  const tracked = await commandTracker.issue(entity, specFor(command.action), {
    params: command.params ?? {},
    inputMode: audit.inputMode,
    voice: audit.voice,
  });
  if (tracked.display === 'failed') {
    pushNotification({ id: tracked.requestId, source: 'command', message: `${command.action}: ${tracked.lastDetail}`, occurredAt: new Date().toISOString() });
  }
  return tracked;
}
