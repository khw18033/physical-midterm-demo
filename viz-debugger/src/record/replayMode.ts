/**
 * src/record/replayMode.ts (260914 신설)
 *
 * **지금 화면이 저장된 기록을 다시 보는 중인가.** 값 하나와 그 구독이다.
 *
 * 다시보기는 지난 판의 기록 열 · 로봇 명령 · 탐지 결과를 **실제 저장소에 도로 채워** 같은 화면이
 * 그리게 한다. 그러면 그 값을 보고 움직이는 것들이 깨어난다 — 탐지 결과가 들어오면 여덟 칸을
 * 칠하고 노드를 미는 구독, 로봇 응답을 받아 칸을 켜는 수신기, 시작을 보고 도면을 받는 준비 단계,
 * 끝난 판을 이력에 적는 감시. 다시보기 중에는 그들이 **아무것도 안 하고**, 기록기도 안 적는다.
 * 그 문지기가 이 값이다.
 *
 * 다른 임무를 올리거나 초기화하면 풀린다(`data/scenario.ts`).
 */

import { useSyncExternalStore } from 'react';

export type ReplayTarget = {
  /** `260914` */
  date: string;
  /** `153012_MSN-260909-01` */
  run: string;
  /** 같은 판을 다시 불러도 화면이 다시 서도록 — 부를 때마다 오른다. */
  loadSerial: number;
};

let current: ReplayTarget | null = null;
let serial = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function replayTarget(): ReplayTarget | null {
  return current;
}

/** 다시보기 중이면 참. 기록을 보고 움직이는 쪽이 이것을 먼저 본다. */
export function isReplayingRecord(): boolean {
  return current !== null;
}

export function enterRecordReplay(date: string, run: string): ReplayTarget {
  serial += 1;
  current = { date, run, loadSerial: serial };
  notify();
  return current;
}

export function leaveRecordReplay(): void {
  if (current === null) return;
  current = null;
  notify();
}

export function subscribeReplayMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReplayTarget(): ReplayTarget | null {
  return useSyncExternalStore(subscribeReplayMode, replayTarget, replayTarget);
}
