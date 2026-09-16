/**
 * src/data/missionHistory.ts (260912 신설 — 「임무 이력을 임시로 기능 활성화」)
 *
 * **끝난 판을 적어 둔다.** 지금까지 임무 이력 자리는 손으로 쓴 세 줄이었다
 * (`MSN-260826-01 · 실패 · 현재` …). 실제로 돌린 판이 무엇이었는지는 아무 데도 안 남아서,
 * 한 판 끝내고 「방금 게 끝난 건가 실패한 건가」를 화면에서 확인할 길이 없었다.
 *
 * ## 남기는 것은 우리가 본 것뿐이다
 *
 * 끝났다는 판정은 **기록 열을 접은 결과**에서 나온다 — 태스크가 다 완료면 완료, 하나라도
 * 실패면 실패, 사람이 정지를 눌렀으면 정지다. 사유는 로봇이 준 것을 그대로 옮기고
 * (`failureOfTask`), 없으면 빈 문자열이다. 지어 채우지 않는다.
 *
 * ## 이 목록은 이 세션 것이고, 판 전체는 파일로 남는다 (260914)
 *
 * `localStorage` 에 안 넣는다. 이 목록은 이 세션에서 끝난 판의 요약이다. 새로고침해도 남아야
 * 하는 것 — 어떤 임무였고 어떻게 진행됐는지, 받은 그림 — 은 기록기가 판마다 파일로 쓴다
 * (`src/record/recorder.ts` → 저장소 루트 `mission-history/`). DB 가 붙기 전까지의 자리다.
 *
 * 여기에는 기록기가 판의 경계를 알 수 있게 **판 번호**와 **봉인**을 둔다. 새 판을 올리면 저장소가
 * 비워지므로, 비우기 **전에** 지난 판의 마지막 모습을 적어야 한다.
 */

import { useSyncExternalStore } from 'react';

export type MissionOutcome = 'done' | 'failed' | 'stopped';

export type MissionHistoryEntry = {
  missionId: string;
  /** 임무 이름 한 줄. 목록에서 id 만으로는 무슨 편인지 모른다. */
  label: string;
  outcome: MissionOutcome;
  endedAtIso: string;
  /** 끝났을 때의 노드 셈. 실패로 끝났으면 어디까지 갔는지가 이 값이다. */
  done: number;
  of: number;
  /** 실패한 노드. 없으면 null. */
  failedTaskId: string | null;
  /** 왜 끝났나 — **로봇이 준 것만.** 없으면 빈 문자열이다. */
  reason: string;
};

export const OUTCOME_WORDS: Record<MissionOutcome, string> = {
  done: '완료',
  failed: '실패',
  stopped: '정지',
};

let entries: readonly MissionHistoryEntry[] = [];
const listeners = new Set<() => void>();

/**
 * 이 판에서 이미 적었는가. **한 판에 한 줄이다** — 접기 결과는 다시 그릴 때마다 나오므로
 * 표시가 없으면 같은 판이 목록을 채운다.
 */
let markedRun: string | null = null;

/** 판 번호 — 새 판이 설 때마다 오른다. 기록기가 「다른 판이 됐다」를 이것으로 안다. */
let runSerial = 0;
const sealListeners = new Set<() => void>();

export function currentRunSerial(): number {
  return runSerial;
}

/**
 * **판을 비우기 직전** (260914). 새 임무 · 처음부터 · 초기화 · 다시보기가 저장소를 비우기 전에 부른다.
 * 기록기가 여기서 지난 판의 마지막 모습을 동기로 떠 둔다 — 비운 뒤에는 뜰 것이 없다.
 */
export function sealRun(): void {
  for (const listener of sealListeners) listener();
}

export function onRunSeal(listener: () => void): () => void {
  sealListeners.add(listener);
  return () => sealListeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function missionHistory(): readonly MissionHistoryEntry[] {
  return entries;
}

export function subscribeMissionHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMissionHistory(): readonly MissionHistoryEntry[] {
  return useSyncExternalStore(subscribeMissionHistory, missionHistory, missionHistory);
}

/**
 * **새 판이 선다.** 임무를 올릴 때와 「처음부터」가 부른다 — 그래야 같은 편을 두 번 돌리면
 * 두 줄이 남는다.
 */
export function armMissionHistory(): void {
  markedRun = null;
  runSerial += 1;
}

/** 적는다. 이미 이 판을 적었으면 아무 일도 안 한다. */
export function noteMissionEnd(entry: MissionHistoryEntry): boolean {
  if (markedRun === entry.missionId) return false;
  markedRun = entry.missionId;
  // 스물까지만 들고 있는다. 이 세션에만 사는 목록이라 더 쌓을 이유가 없다.
  entries = [entry, ...entries].slice(0, 20);
  notify();
  return true;
}

/** 목록을 비운다. 「초기화」가 부른다. */
export function resetMissionHistory(): void {
  markedRun = null;
  if (entries.length === 0) return;
  entries = [];
  notify();
}
