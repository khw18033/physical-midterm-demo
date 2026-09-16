/**
 * src/canvas/zoomState.ts (260903 — 3단계)
 *
 * **지금 확대된 뷰 노드 하나.** 캔버스의 상태이지만 캔버스 밖에서도 읽어야 해서 모듈에 둔다.
 *
 * 읽는 곳이 둘이다:
 *  - 캔버스(`main.tsx` 의 GraphScreen) — 오버레이를 그린다.
 *  - 셸의 `?` 설명서(`HelpOverlay`) — **확대가 열려 있으면 그 노드의 설명서**를 보인다
 *    (지시서 §3 — 탭 제거가 떨어뜨리는 셸 5개소 중 넷째).
 *
 * 셸에 프롭으로 올리지 않는 이유: 셸은 캔버스 안을 몰라야 한다(탭을 걷어낸 이유가 그것이다).
 * 상태를 두 곳에 복제하면 갈라지므로 **원천을 여기 하나**로 두고 양쪽이 구독한다.
 *
 * **이것은 `activeTab` 류가 아니다.** 「몇 번째 탭」이 아니라 「어느 노드가 확대됐나」이고,
 * 값이 하나라 둘이 열릴 수 없다(지시서 §6 · `verify:no-tabs`).
 */

import { useSyncExternalStore } from 'react';

export type ZoomTarget = { id: string; kind: string } | null;

let target: ZoomTarget = null;
const listeners = new Set<() => void>();

export function getZoomTarget(): ZoomTarget {
  return target;
}

/** 확대를 열거나(값) 닫는다(null). 여는 것도 닫는 것도 이 한 곳을 지난다. */
export function setZoomTarget(next: ZoomTarget): void {
  if (target === next) return;
  if (target !== null && next !== null && target.id === next.id) return;
  target = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useZoomTarget(): ZoomTarget {
  return useSyncExternalStore(subscribe, getZoomTarget, () => null);
}
