/**
 * src/shared/notifications.ts
 *
 * **머리줄의 통합 알림.** 탭을 보고 있지 않을 때도 알아야 하는 것만 여기로 온다.
 *
 * ## 시작할 때 비어 있다 (260913 지시 — 「실제 사건이 아닌 목 데이터는 최소화」)
 *
 * 전에는 두 줄이 박혀 있었다.
 *
 *     AI-FAIL-01   외부 AI 분류 응답 지연 (VZ-I-10)      2026-08-27
 *     GEN-FAIL-01  마일스톤 생성 검증 1건 실패 (F15)     2026-08-27
 *
 * 구 대시보드에서 넘어온 예시이고 **일어난 적이 없는 일**이다. 그런데 뱃지는 늘 「알림 2」
 * 였고, 무대에서 그것을 보면 방금 무슨 일이 난 줄 안다. 실패 사유에서 지어낸 문장을 걷어낸
 * 것과 같은 이유로 지운다 — **없으면 0이라고 적는 편이 맞다.**
 *
 * 실제로 쌓이는 것은 둘이다.
 *
 *   command      명령 발행 거부·상태 (`shared/commandEgress.ts` · `transport/WsTransport.ts`)
 *   external-ai  외부 AI 실패 이벤트 (`tabs/aiFailureBridge.ts` — 게이트웨이가 줄 때)
 *
 * `mission-generation` 은 **올리는 코드가 아직 없다.** 종류만 자리로 남겨 둔다 — 생성 쪽이
 * 검증 실패를 내보내기 시작하면 그때 여기로 온다.
 */

import { useSyncExternalStore } from 'react';

export type NotificationSource =
  | 'external-ai' | 'mission-generation' | 'command'
  /** 붙었나 끊겼나 — 브로커·탐지 서비스. */
  | 'connection'
  /** 로봇이 거절했거나 태스크가 실패했다. **어느 태스크인지 문구에 적는다.** */
  | 'robot';

export type AppNotification = { id: string; source: NotificationSource; message: string; occurredAt: string };

export const SOURCE_WORDS: Record<NotificationSource, string> = {
  'external-ai': '외부 AI',
  'mission-generation': '임무 생성',
  command: '명령',
  connection: '연결',
  robot: '로봇',
};

/** **비어 있는 채로 시작한다.** 실제 사건이 와야 는다. */
const items: AppNotification[] = [];

/** 목록 길이. 시연 한 판이면 넘칠 일이 없고, 종일 켜 두어도 안 부푼다. */
const KEEP = 60;

/**
 * **같은 말을 되풀이하지 않는다.**
 *
 * 연결 상태는 초마다 다시 오고 탐지 폴링은 1.5초마다 실패한다. 그것을 그대로 쌓으면
 * 목록이 같은 줄로 가득 차서 **정작 하나뿐인 사건이 묻힌다.**
 *
 * 통로(`channel`)별로 **직전에 올린 문구**만 기억한다. 전역으로 한 번씩만 올리는 것과는
 * 다르다 — 끊겼다 붙었다 다시 끊기면 세 줄이 다 남아야 한다. 직전과 같을 때만 삼킨다.
 */
const lastOf = new Map<string, string>();

export function noteIssue(channel: string, source: NotificationSource, message: string): boolean {
  if (lastOf.get(channel) === message) return false;
  lastOf.set(channel, message);
  pushNotification({
    id: `${channel}-${Date.now()}`,
    source,
    message,
    occurredAt: new Date().toISOString(),
  });
  return true;
}

/** 판을 새로 시작할 때. 지난 판의 「직전 문구」가 새 판의 첫 줄을 삼키면 안 된다. */
export function armNotifications(): void {
  lastOf.clear();
}
const listeners = new Set<() => void>();

export function pushNotification(item: AppNotification) {
  items.unshift(item);
  if (items.length > KEEP) items.length = KEEP;
  listeners.forEach((listener) => listener());
}

/** 「초기화」가 부른다 — 화면을 처음 상태로 되돌리는 것이라 알림도 같이 비운다. */
export function resetNotifications(): void {
  lastOf.clear();
  if (items.length === 0) return;
  items.length = 0;
  listeners.forEach((listener) => listener());
}

/** 훅 없이 읽는 길. 검사와 훅이 **같은 배열**을 본다 — 두 벌이면 갈라진다. */
export function notificationsNow(): readonly AppNotification[] {
  return items;
}

export function useNotifications() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => items,
    () => items,
  );
}
