/**
 * src/detect/detectLog.ts (260914 신설)
 *
 * **탐지 쪽에서 오간 것을 한 줄씩.** 액션 아이템이 태스크별로 골라 읽는다.
 *
 * ## 왜 생겼나 — 실제로 겪은 일
 *
 * 로봇이 한 바퀴를 도는 동안 탐지 그림이 하나도 안 왔다. 데스크톱을 열어 보니 수신기는
 * 브로커에 붙어 있었는데 **프레임을 한 장도 못 받았고**, 화면은 시작 때 남아 있던 지난 판을
 * 거르며 조용히 기다리고 있었다. 화면 어디에도 그 사실이 없었다 — 「로봇이 안 보냈다」인지
 * 「탐지가 못 받았다」인지 「화면이 거르고 있다」인지 가를 수가 없었다.
 *
 * 그래서 탐지 경로의 **세 구간**을 따로 적는다.
 *
 *   robot    로봇 → 탐지   브로커의 `/frame` · `/scan` 을 **화면도 같이 듣는다**. 탐지가 받을
 *                          것을 로봇이 실제로 보냈는지가 여기 남는다
 *   detect   탐지 → 화면   HTTP 창구가 무엇을 내줬나. 각도 결과 · 근거 · 자세 · 경로 · 실패
 *   screen   화면           화면이 내린 판단. 지난 판 거르기 · 준비 단계(T-A1·T-A2) · 대기 사유
 *
 * 탐지 프로그램 **안쪽**의 출력(모델 로드 · 프레임 처리)은 여기 없다 — 그건 탐지 PC 의
 * 콘솔에 있고, 화면으로 가져오려면 탐지 쪽에 창구가 하나 더 있어야 한다.
 *
 * **지어 쓰지 않는다.** 문장의 값은 받은 값뿐이다.
 */

import { useSyncExternalStore } from 'react';

export type DetectLogLane = 'robot' | 'detect' | 'screen';

export type DetectLogLine = {
  atIso: string;
  lane: DetectLogLane;
  level: 'info' | 'warn' | 'error';
  /** 한 줄 요약. */
  text: string;
  /** 받은 원문에서 뽑은 값들. 없으면 빈 문자열. */
  detail: string;
  /** 이 줄을 보여 줄 태스크. 액션 아이템이 이것으로 고른다. */
  tasks: readonly string[];
};

/** 구간 이름 — 화면이 줄 머리에 적는다. */
export const LANE_WORDS: Record<DetectLogLane, string> = {
  robot: '로봇 → 탐지',
  detect: '탐지 → 화면',
  screen: '화면',
};

/**
 * 탐지 경로에 걸린 태스크들. 대본(`MSN-260909-01`)의 id 이고, 태스크 노드를 미는
 * `detectTrace.ts` 와 같은 이름을 쓴다.
 */
export const DETECT_TASKS = {
  map: 'T-A1',
  pose: 'T-A2',
  sweep: 'T-A3',
  judge: 'T-A5',
  evidence: 'T-A6',
  path: 'T-B1',
  /** 산출된 경로로 이동 — 경로가 로봇 명령으로 바뀌는 계산과 실제로 나간 명령이 여기 붙는다. */
  approach: 'T-B2',
} as const;

/** 각도 칸의 태스크 id. 인덱스를 id 로 옮기는 규칙은 `physical/missionLink.ts` 의 역이다. */
export function angleTask(index: number): string {
  return `T-A4-${index}`;
}

/** 탐지 경로 전체에 걸친 줄(연결 실패 등)을 붙일 태스크. */
export const WHOLE_DETECT_PATH: readonly string[] = [
  DETECT_TASKS.sweep, DETECT_TASKS.judge, DETECT_TASKS.evidence, DETECT_TASKS.path,
];

/** 한 판이면 넘칠 일이 없고, 종일 켜 두어도 안 부푼다. */
const KEEP = 400;

let lines: readonly DetectLogLine[] = [];
const listeners = new Set<() => void>();

/**
 * 한 줄 쌓는다. **직전과 같은 구간·같은 문장이면 삼킨다** — 폴링은 1.5초마다 같은 실패를
 * 되풀이한다. 그대로 쌓으면 정작 한 번뿐인 줄이 묻힌다(알림의 `noteIssue` 와 같은 규칙).
 */
export function appendDetectLog(line: Omit<DetectLogLine, 'atIso'> & { atIso?: string }): boolean {
  const last = lines.at(-1);
  if (last !== undefined && last.lane === line.lane && last.text === line.text && last.detail === line.detail) return false;
  const next: DetectLogLine = { ...line, atIso: line.atIso ?? new Date().toISOString() };
  lines = [...lines, next].slice(-KEEP);
  for (const listener of listeners) listener();
  return true;
}

export function detectLog(): readonly DetectLogLine[] {
  return lines;
}

/** 그 태스크에 붙은 줄만. 받은 순서 그대로. */
export function detectLogOf(taskId: string): readonly DetectLogLine[] {
  return lines.filter((line) => line.tasks.includes(taskId));
}

export function subscribeDetectLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDetectLog(): readonly DetectLogLine[] {
  return useSyncExternalStore(subscribeDetectLog, detectLog, detectLog);
}

/** 다시보기 — 지난 판의 줄을 그대로 채운다 (260914). */
export function restoreDetectLog(saved: readonly DetectLogLine[]): void {
  lines = saved.slice(-KEEP);
  for (const listener of listeners) listener();
}

/** 임무를 새로 올릴 때. 지난 판의 줄이 새 판 노드에 붙으면 안 된다. */
export function resetDetectLog(): void {
  lines = [];
  for (const listener of listeners) listener();
}
