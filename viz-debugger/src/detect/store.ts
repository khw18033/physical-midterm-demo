/**
 * src/detect/store.ts (260912 신설)
 *
 * **탐지 한 판의 상태.** `physical/robotSession.ts` 와 같은 자리·같은 모양이다 —
 * 화면은 이걸 읽고 결과는 이리로 들어온다.
 *
 * 로봇과 탐지는 **다른 경로로 들어온다.** 로봇은 MQTT 로 밀어 주고 탐지는 우리가 HTTP 로
 * 받아 간다. 둘이 같은 여덟 칸을 채우므로 누가 무엇을 채우는지 갈라 둔다.
 *
 *   로봇   「회전이 지나갔다」   — `scan_turn`
 *   탐지   「거기 문이 있나」    — `found`
 */

import { useSyncExternalStore } from 'react';
import { resetDetectLog } from './detectLog.ts';
import { resetDetectTrace } from './detectTrace.ts';
import type {
  DetectFeatures, DetectFrame, DetectFrameEvidence, DetectLocalization, DetectPath,
} from './types.ts';

export type DetectState = {
  /** 연결 관리의 「테스트」가 켜져 있는가. 켜면 받아 둔 실제 산출물을 읽는다. */
  testMode: boolean;
  /** 각도별 결과. **한 각도 스캔이 끝날 때마다 늘어난다** (260912 확인). */
  frames: readonly DetectFrame[];
  /** 각도별 근거. 키는 `frame_000113.jpg`. 못 찾은 각도에는 없다. */
  evidence: Readonly<Record<string, DetectFrameEvidence>>;
  /**
   * 자세 역산 — **도는 것보다 먼저 온다.** 도면상 문의 자리(`T-A1`)와 로봇 자신의
   * 자리·방위(`T-A2`)가 여기 있다. 스캔 결과와 다른 파일이라 따로 둔다.
   */
  localization: DetectLocalization | null;
  /** 경로 산출. 스캔이 끝나야 나온다 — 그 전에는 null 이고, 그것이 정상이다. */
  path: DetectPath | null;
  /**
   * **경로 산출 실패의 사유** (260914). 대체 경로(A 단상 → B 문만 위치 → C 문 관측만)가 전부
   * 안 됐다는 뜻이다. 있으면 `T-B1` 이 실패로 뜨고 이동은 열리지 않는다.
   */
  pathFailure: string | null;
  /** 실패 산출물 원본 — 어디서 왜 끊겼는지(fallback_chain)를 액션 아이템이 그린다. */
  pathFailureDetail: DetectPath | null;
  /** 무엇을 문이라고 물었나. */
  features: DetectFeatures | null;
  /** 마지막으로 읽어 온 시각(ms). 0 이면 아직 한 번도 안 읽었다. */
  fetchedAtMs: number;
  /** 못 읽었으면 왜. 조용히 비워 두지 않는다. */
  error: string | null;
  /**
   * **지난 판 결과를 거르는 중이면 그 각도 수** (260914). 거를 것이 없으면 null.
   *
   * 탐지 서비스는 새 스캔이 **시작될 때** 지난 판 산출물을 지운다. 그 전까지는 지난 판을
   * 그대로 내준다 — 「임무 시작」을 눌렀을 때 이미 여덟이 다 와 있으면 그것은 이번 판이
   * 아니다(`poll.ts` 의 문). 화면은 거르고 있다는 사실을 숨기지 않고 적는다.
   */
  staleFrames: number | null;
  /**
   * **판 번호 — 그림 주소에 붙인다** (260914). 탐지의 그림 주소는 판마다 같다
   * (`frame_000001.jpg` · `/detect/path_overlay?target=door`). 서버가 `no-store` 를 줘도 브라우저는
   * 한 페이지 안에서 같은 주소의 그림을 다시 쓸 수 있어, 새로고침 없이 두 번째 판을 돌리면
   * 지난 판의 경로 그림이 남는다. 판이 바뀔 때마다 올려 주소를 가른다. 비울 때도 줄지 않는다.
   */
  imageRound: number;
  /**
   * **다시보기 중이면 그 판** (260914 — 임무 기록). 그림을 탐지 창구가 아니라 기록 폴더에서 읽는다.
   * 지난 판의 그림은 탐지 창구에 이미 없다 — 새 판이 시작될 때 지워진다.
   */
  recordRun: { date: string; run: string } | null;
};

const EMPTY: DetectState = {
  testMode: false,
  frames: [],
  evidence: {},
  localization: null,
  path: null,
  pathFailure: null,
  pathFailureDetail: null,
  features: null,
  fetchedAtMs: 0,
  error: null,
  staleFrames: null,
  imageRound: 0,
  recordRun: null,
};

let state: DetectState = EMPTY;
const listeners = new Set<() => void>();

function commit(next: DetectState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function detectState(): DetectState {
  return state;
}

export function subscribeDetect(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDetect(): DetectState {
  return useSyncExternalStore(subscribeDetect, detectState, detectState);
}

/** 「테스트」를 켜고 끈다. **끄면 읽어 둔 것도 같이 버린다** — 시료가 실제 결과로 보이면 안 된다. */
export function setTestMode(on: boolean): void {
  resetDetectTrace();
  const imageRound = state.imageRound + 1;
  commit(on ? { ...state, testMode: true, imageRound } : { ...EMPTY, testMode: false, imageRound });
}

export function receiveFrames(frames: readonly DetectFrame[]): void {
  commit({ ...state, frames, fetchedAtMs: Date.now(), error: null });
}

export function receiveEvidence(frame: string, evidence: DetectFrameEvidence): void {
  commit({ ...state, evidence: { ...state.evidence, [frame]: evidence } });
}

export function receiveLocalization(localization: DetectLocalization | null): void {
  commit({ ...state, localization });
}

export function receivePath(path: DetectPath | null): void {
  commit({ ...state, path, ...(path !== null ? { pathFailure: null, pathFailureDetail: null } : {}) });
}

/** 경로 산출이 실패했다 — 탐지가 대체 경로를 다 해 보고도 못 냈다. */
export function receivePathFailure(detail: DetectPath): void {
  if (state.pathFailure !== null) return;
  commit({ ...state, path: null, pathFailure: detail.reason ?? '경로 산출 실패', pathFailureDetail: detail });
}

export function receiveFeatures(features: DetectFeatures | null): void {
  commit({ ...state, features });
}

export function noteDetectError(reason: string): void {
  commit({ ...state, error: reason });
}

/** 지난 판 결과를 거르기 시작한다. 받은 것은 없는 채로 둔다 — 각도 수만 적는다. */
export function markStale(count: number): void {
  if (state.staleFrames === count) return;
  commit({ ...state, staleFrames: count, fetchedAtMs: Date.now(), error: null });
}

/** 거를 것이 없어졌다 — 새 판이 시작됐거나 처음부터 비어 있었다. */
export function clearStale(): void {
  if (state.staleFrames === null) return;
  // 지난 판을 지웠다는 뜻이다 — 여기서부터 받는 그림은 새 판의 것이다.
  commit({ ...state, staleFrames: null, imageRound: state.imageRound + 1 });
}

/**
 * **도중에 판이 새로 시작됐다** — 받은 각도 수가 줄었다.
 *
 * 탐지는 카메라가 얼어 같은 그림이 섞인 판을 통째로 버리고 다시 스캔한다. 그때 새 판도
 * 프레임 이름이 `frame_000001.jpg` 부터라, 근거를 이름으로 기억해 두면 **버린 판의 근거가
 * 새 판 각도에 붙는다.** 받은 것을 비운다. 낸 사건 기억은 남긴다 — 끝난 노드를 되돌리지 않는다.
 */
export function discardRound(): void {
  commit({
    ...state, frames: [], evidence: {}, localization: null, path: null, pathFailure: null, pathFailureDetail: null,
    imageRound: state.imageRound + 1,
  });
}

/** 기록에 남기는 몫 — 받은 결과 전부. 폴링의 사정(오류 · 거르는 중)은 뺀다. */
export type RecordedDetect = Pick<DetectState,
  'testMode' | 'frames' | 'evidence' | 'localization' | 'path' | 'pathFailure' | 'pathFailureDetail' | 'features'>;

export function recordableDetect(): RecordedDetect {
  const { testMode, frames, evidence, localization, path, pathFailure, pathFailureDetail, features } = state;
  return { testMode, frames, evidence, localization, path, pathFailure, pathFailureDetail, features };
}

/**
 * **다시보기 — 지난 판의 탐지 결과를 도로 채운다** (260914). 그림은 그 판의 기록 폴더에서 읽는다.
 * 「테스트」 켬/끔은 사람이 정한 것이라 지금 값을 남긴다.
 */
export function restoreDetect(saved: Partial<RecordedDetect>, recordRun: { date: string; run: string }): void {
  resetDetectTrace();
  commit({
    ...EMPTY,
    testMode: state.testMode,
    frames: saved.frames ?? [],
    evidence: saved.evidence ?? {},
    localization: saved.localization ?? null,
    path: saved.path ?? null,
    pathFailure: saved.pathFailure ?? null,
    pathFailureDetail: saved.pathFailureDetail ?? null,
    features: saved.features ?? null,
    fetchedAtMs: Date.now(),
    imageRound: state.imageRound + 1,
    recordRun,
  });
}

/**
 * 임무가 바뀌면 판을 비운다. **테스트 켬/끔은 남긴다** — 그것은 임무의 성질이 아니라
 * 사람이 설정한 것이고, 임무를 다시 올릴 때마다 꺼지면 매번 다시 켜야 한다.
 */
export function resetDetect(): void {
  // 낸 사건 기억도 같이 비운다 — 안 그러면 다음 판에서 태스크가 처음부터 끝나 있다.
  resetDetectTrace();
  // 오간 줄도 비운다 — 지난 임무의 줄이 같은 이름의 노드에 붙으면 안 된다.
  resetDetectLog();
  commit({ ...EMPTY, testMode: state.testMode, imageRound: state.imageRound + 1 });
}
