/**
 * src/physical/scanGate.ts (260914 신설 — 「한 바퀴 노드가 카메라 이미지보다 약간 빨라 싱크가 안 맞는다」)
 *
 * **각도 칸은 그 각도의 데이터가 다 온 뒤에 다음으로 넘어간다.**
 *
 * ## 무엇이 앞서 갔나
 *
 * 로봇의 한 걸음은 「회전 → 정지 → 0.6초 대기 → 촬영 → 전송」이다(`physical_demo/detection-protocol_0914.md` §4-③).
 * 화면은 **회전 보고(`scan_turn`)가 오는 순간** 그 칸을 켰다. 그 칸의 사진은 그 뒤에 찍히고, 탐지가 그
 * 사진을 판단해 창구에 올리고(한 장에 2초 안팎), 화면이 폴링으로 받기까지(1.5초) 더 걸린다. 그래서 칸은
 * k 를 가리키는데 탐지 영상은 아직 k-1 이었다. 정해진 1초 타이머가 있던 것이 아니라 **데이터보다 먼저
 * 오는 보고**에 칸이 걸려 있었다.
 *
 * ## 이제는
 *
 *   칸 k 가 켜지는 때   로봇이 k 를 **찍었고**(촬영 · 또는 탐지 결과 k 가 왔고)
 *                       **앞 칸 k-1 의 탐지 결과가 왔고, 그 그림이 탐지 영상 뷰 노드에 다 그려졌을 때**
 *
 * 로봇이 먼저 가 있으면 그 칸은 문 앞에서 기다린다(`pending`). 앞 칸의 그림이 뜨는 순간 열린다.
 * 그러면 칸이 켜진 동안 탐지 영상이 그 각도로 바뀌고, 그림이 뜨면 다음 칸으로 간다.
 *
 * ## 「그려졌다」의 판단 (260914)
 *
 * 결과가 온 것과 그림이 뜬 것 사이에는 그림을 받는 시간이 있다(탐지 창구 → 브라우저). 그래서
 * - 탐지 영상 뷰 노드가 떠 있으면 **그 img 의 로드 완료**(`noteScanImageShown`)를 기다린다. 뒤 각도의
 *   그림이 이미 떴으면 앞 각도도 지난 것으로 본다.
 * - 뷰 노드가 없거나 한 바퀴가 끝났으면(뷰는 고른 각도로 간다) 문지기가 **같은 주소를 미리 받아 본 완료**로 본다.
 * - 그림을 못 받으면(오류) 기다리지 않고 넘어가며 로그에 적는다.
 *
 * ## 기다리지 않는 경우 — 화면이 멈추면 안 된다
 *
 * - **촬영이 안 흐르는 판** — 이 판에서 로봇 촬영도 탐지 결과도 하나도 못 받았으면 예전처럼 회전 보고로
 *   켠다. 탐지 결과가 올 길이 없는데 기다리면 여덟이 영영 대기다.
 * - **탐지가 없거나 못 닿을 때** — 주소가 비었거나 창구 오류 중이면 촬영만으로 넘어간다.
 * - **15초** — 앞 칸 결과가 그만큼 안 오면 넘어가고, 그 사실을 탐지 로그에 적는다.
 *
 * 정지·일시정지 중에는 안 연다. 다시보기 중에는 받지 않는다.
 * 방위 기록(`seenYaw` · `litIndices`)은 여기와 무관하게 로봇이 보고한 즉시 남는다 — 늦추는 것은 **그리기**뿐이다.
 */

import { advanceRobotHead, currentMission } from '../data/scenario.ts';
import { detectBaseUrl, frameImageUrl, roundedImageUrl, viewSourceOf } from '../detect/DetectClient.ts';
import { angleTask, appendDetectLog, DETECT_TASKS } from '../detect/detectLog.ts';
import { indexOfRotation } from '../detect/parse.ts';
import { detectState, subscribeDetect } from '../detect/store.ts';
import { isReplayingRecord } from '../record/replayMode.ts';
import type { ViewpointFrame } from '../viewpoint/fill.ts';
import { appendViewpoint } from '../viewpoint/store.ts';
import { elapsedSec, registerTimer, robotSession } from './robotSession.ts';

/** 칸을 켜 달라는 근거. `turn` 은 데이터보다 먼저 오는 보고라 촬영이 흐르는 판에서는 안 쓴다. */
export type ScanOfferSource = 'turn' | 'image' | 'result';

/** 앞 칸의 탐지 결과를 이만큼 기다린다. 탐지 한 장 2초 + 폴링 1.5초의 네 배쯤. */
export const RESULT_WAIT_MS = 15_000;
const PUMP_MS = 500;

type Pending = { missionId: string; atSec: number; frame: ViewpointFrame; source: ScanOfferSource };

let runKey: string | null = null;
const pending = new Map<number, Pending>();
/** 켠 칸 → 켠 시각(ms). */
const litAt = new Map<number, number>();
/** 이 판에서 실제 데이터(촬영·결과)를 하나라도 받았나. */
let dataFlowing = false;
let stopTimer: (() => void) | null = null;
let subscribed = false;

/** 뷰 노드의 img 가 다 그린 주소 · 못 그린 주소. */
const shownUrls = new Set<string>();
const failedUrls = new Set<string>();
/** 뷰가 없을 때 문지기가 미리 받아 본 주소. */
const preloaded = new Map<string, 'loading' | 'done'>();
/** 떠 있는 탐지 영상 뷰 노드 수. */
let imageViews = 0;

/** 그림 한 장을 받아 본다. 끝나면(성공이든 실패든) 풀리는 약속, 받을 수단이 없으면 null(곧바로 끝난 것으로). */
export type ScanImageLoader = (url: string) => Promise<void> | null;

const browserLoader: ScanImageLoader = (url) => {
  if (typeof Image === 'undefined') return null;
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => { failedUrls.add(url); resolve(); };
    image.src = url;
  });
};
let loadImage: ScanImageLoader = browserLoader;

/** 그림이 떴거나 받아졌을 때 — 로봇에 다음 회전 신호를 보낼 쪽(`scanContinue.ts`)이 듣는다. */
const gateListeners = new Set<() => void>();
function notifyGate(): void {
  for (const listener of gateListeners) listener();
}

export function subscribeScanGate(listener: () => void): () => void {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
}

function geometry(): { stepDeg: number; count: number } {
  const params = currentMission().params;
  const count = typeof params?.viewpoint_count === 'number' ? params.viewpoint_count : 8;
  const stepDeg = typeof params?.viewpoint_step_deg === 'number' ? params.viewpoint_step_deg : 360 / count;
  return { stepDeg, count };
}

function keyOf(missionId: string): string {
  return `${missionId}:${robotSession().startedAtMs ?? 'none'}`;
}

/** 판이 바뀌었으면 비운다 — 지난 판의 대기열이 새 판 칸을 켜면 안 된다. */
function syncRun(missionId: string): void {
  const key = keyOf(missionId);
  if (runKey === key) return;
  runKey = key;
  pending.clear();
  litAt.clear();
  dataFlowing = false;
  shownUrls.clear();
  failedUrls.clear();
  preloaded.clear();
}

function hasResult(index: number): boolean {
  const { stepDeg, count } = geometry();
  return detectState().frames.some((frame) => indexOfRotation(frame.rotation_deg, stepDeg, count) === index);
}

/** 칸 k 의 탐지 영상 주소 — 뷰 노드가 그리는 것과 **같은 문자열**이다. 결과가 없으면 null. */
function imageUrlOf(index: number): string | null {
  const state = detectState();
  const { stepDeg, count } = geometry();
  const frame = state.frames.find((item) => indexOfRotation(item.rotation_deg, stepDeg, count) === index);
  if (frame === undefined) return null;
  return roundedImageUrl(frameImageUrl(viewSourceOf(state), frame.frame, frame.found ? 'target_overlay' : 'original'), state.imageRound);
}

/** 칸 k 의 그림이 떴다고 봐도 되나. 아니면 필요한 받기를 걸어 두고 false. */
function imageReady(index: number): boolean {
  const url = imageUrlOf(index);
  if (url === null) return false;
  if (shownUrls.has(url) || failedUrls.has(url)) return true;
  const { count } = geometry();
  // 뒤 각도의 그림이 이미 떴으면 이 각도는 지나갔다.
  for (let later = index + 1; later < count; later += 1) {
    const laterUrl = imageUrlOf(later);
    if (laterUrl !== null && shownUrls.has(laterUrl)) return true;
  }
  const swept = detectState().frames.length >= count;
  // 뷰가 떠 있고 아직 도는 중이면 **실제로 그려진 것**을 기다린다.
  if (imageViews > 0 && !swept) return false;
  const loadState = preloaded.get(url);
  if (loadState === 'done') return true;
  if (loadState === undefined) {
    const loading = loadImage(url);
    if (loading === null) { preloaded.set(url, 'done'); return true; }
    preloaded.set(url, 'loading');
    void loading.then(() => { preloaded.set(url, 'done'); pump(); notifyGate(); });
  }
  return false;
}

/** 탐지 결과를 기다릴 이유가 없는가 — 탐지가 없거나 못 닿는다. */
function detectAbsent(): boolean {
  const state = detectState();
  return (!state.testMode && detectBaseUrl().trim() === '') || state.error !== null;
}

/** 켠 칸 중 가장 뒤의 것. */
function lastLit(): number | null {
  let last: number | null = null;
  for (const index of litAt.keys()) if (last === null || index > last) last = index;
  return last;
}

/** 칸 k 를 끝났다고 봐도 되나 — 결과가 왔거나, 기다릴 이유가 없거나, 오래 기다렸다. */
function settled(index: number, now: number): 'result' | 'no-wait' | 'timeout' | null {
  if (!dataFlowing || detectAbsent()) return 'no-wait';
  if (hasResult(index) && imageReady(index)) return 'result';
  const at = litAt.get(index);
  if (at !== undefined && now - at >= RESULT_WAIT_MS) return 'timeout';
  return null;
}

function release(index: number, entry: Pending, atSec: number): number {
  pending.delete(index);
  litAt.set(index, Date.now());
  return appendViewpoint(entry.missionId, atSec, entry.frame) ? 1 : 0;
}

/**
 * 열 수 있는 칸을 연다. 연 프레임 수를 돌려준다. `atSec` 이 주어지면 그 시각으로(방금 온 것), 아니면 지금.
 *
 * 규칙은 하나다 — **가장 뒤에 켠 칸이 끝났으면, 그 뒤에서 가장 앞의 대기 칸을 연다.** 앞 칸보다 번호가
 * 작은 대기 칸(늦게 온 것)은 이미 지나간 자리라 곧바로 연다. 빠진 각도가 있어도 멈추지 않는다.
 */
function pump(atSec?: number): number {
  const session = robotSession();
  if (isReplayingRecord() || session.stopped !== null || session.paused !== null) return 0;
  // 판이 바뀐 뒤 남은 대기열은 버린다 — 같은 임무를 「처음부터」 돌리면 id 가 같아 새 판 칸을 켠다.
  const first = pending.values().next().value;
  if (first !== undefined && keyOf(first.missionId) !== runKey) {
    resetScanGate();
    return 0;
  }
  const now = Date.now();
  let put = 0;
  let missionId: string | null = null;
  for (;;) {
    const last = lastLit();
    const late = [...pending.keys()].filter((index) => last !== null && index < last).sort((a, b) => a - b);
    if (late.length > 0) {
      const entry = pending.get(late[0])!;
      missionId = entry.missionId;
      put += release(late[0], entry, atSec ?? Math.max(entry.atSec, elapsedSec()));
      continue;
    }
    const next = [...pending.keys()].sort((a, b) => a - b)[0];
    if (next === undefined) break;
    const why = last === null ? 'no-wait' : settled(last, now);
    if (why === null) break;
    if (why === 'timeout' && last !== null) {
      appendDetectLog({
        lane: 'screen', level: 'warn',
        text: hasResult(last)
          ? `${last}번 각도의 탐지 영상이 ${RESULT_WAIT_MS / 1000}초째 안 떠서 ${next}번 각도로 넘어갑니다`
          : `${last}번 각도의 탐지 결과가 ${RESULT_WAIT_MS / 1000}초째 없어 ${next}번 각도로 넘어갑니다`,
        detail: '각도 칸은 앞 칸의 탐지 결과가 온 뒤에 넘어갑니다 — 탐지 PC 콘솔의 mqtt_stream_receiver.py 출력을 볼 것',
        tasks: [DETECT_TASKS.sweep, angleTask(last), angleTask(next)],
      });
    }
    const entry = pending.get(next)!;
    missionId = entry.missionId;
    put += release(next, entry, atSec ?? Math.max(entry.atSec, elapsedSec()));
  }
  if (put > 0 && missionId !== null && atSec === undefined) advanceRobotHead(missionId, elapsedSec());
  if (pending.size === 0 && stopTimer !== null) { stopTimer(); stopTimer = null; }
  return put;
}

function ensurePumping(): void {
  if (!subscribed) {
    subscribed = true;
    // 탐지 결과가 들어오는 순간이 곧 다음 칸이 열리는 순간이다.
    subscribeDetect(() => { if (pending.size > 0) pump(); });
  }
  if (pending.size === 0 || stopTimer !== null) return;
  const timer = setInterval(() => pump(), PUMP_MS);
  (timer as { unref?: () => void }).unref?.();
  const unregister = registerTimer(() => { clearInterval(timer); stopTimer = null; });
  stopTimer = () => { clearInterval(timer); unregister(); };
}

/**
 * **칸을 켜 달라.** 로봇 회전 보고 · 로봇 촬영 · 탐지 결과가 부른다. 지금 연 프레임 수를 돌려준다 —
 * 0 이면 앞 칸을 기다리는 중이다(또는 촬영이 흐르는 판의 회전 보고라 버렸다).
 */
export function offerScanFrame(missionId: string, atSec: number, frame: ViewpointFrame, source: ScanOfferSource): number {
  if (frame.channel !== 'robot_state' || isReplayingRecord()) return 0;
  syncRun(missionId);
  const index = frame.payload.rotation_index;
  if (source !== 'turn') dataFlowing = true;
  // 촬영이 흐르는 판에서 회전 보고는 데이터보다 먼저 온 것이다 — 그 칸은 촬영이 켠다.
  if (source === 'turn' && dataFlowing) return 0;
  if (litAt.has(index)) {
    // 이미 켠 칸 — 같은 칸에 같은 상태를 한 번 더 쓰는 것은 무해하다(방위 표기가 갱신된다).
    return appendViewpoint(missionId, atSec, frame) ? 1 : 0;
  }
  if (!pending.has(index) || source !== 'turn') pending.set(index, { missionId, atSec, frame, source });
  const put = pump(atSec);
  ensurePumping();
  return put;
}

/** **탐지 영상 뷰 노드가 떴다.** 되돌려주는 함수를 부르면 내려간 것이다. */
export function registerScanImageView(): () => void {
  imageViews += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    imageViews -= 1;
    if (pending.size > 0) pump();
  };
}

/** 뷰 노드의 img 가 그 주소를 다 그렸다. */
export function noteScanImageShown(url: string): void {
  if (shownUrls.has(url)) return;
  shownUrls.add(url);
  if (pending.size > 0) pump();
  notifyGate();
}

/** 뷰 노드의 img 가 그 주소를 못 그렸다 — 기다리지 않고 넘어간다. */
export function noteScanImageFailed(url: string): void {
  if (failedUrls.has(url)) return;
  failedUrls.add(url);
  appendDetectLog({
    lane: 'screen', level: 'warn', text: '탐지 영상을 못 불러와 기다리지 않고 다음 각도로 넘어갑니다',
    detail: url, tasks: [DETECT_TASKS.sweep],
  });
  if (pending.size > 0) pump();
  notifyGate();
}

/**
 * **각도 하나가 화면에서 끝났나** — 로봇의 촬영 뒤 대기를 풀어도 되나 (260914 · pi7 `scan_hold`).
 *
 * 칸이 넘어가는 규칙(`settled`)과 같은 재료다. 탐지 결과가 왔고 그 그림이 탐지 영상 뷰에 다 그려졌으면 `result`,
 * 탐지가 없거나 못 닿으면 `no-wait`, 대기가 시작된 지 15초가 지났으면 `timeout`. 아직이면 null.
 * 필요하면 그림 받기를 걸어 둔다 — 끝나면 `subscribeScanGate` 로 알린다.
 */
export function angleSettledForHold(index: number, holdSinceMs: number): 'result' | 'no-wait' | 'timeout' | null {
  if (detectAbsent()) return 'no-wait';
  if (hasResult(index) && imageReady(index)) return 'result';
  if (Date.now() - holdSinceMs >= RESULT_WAIT_MS) return 'timeout';
  return null;
}

/** 검사용 — 그림 받기를 바꾼다. null 이면 브라우저 기본. */
export function setScanImageLoader(loader: ScanImageLoader | null): void {
  loadImage = loader ?? browserLoader;
}

/** 지금 앞 칸을 기다리는 칸들 — 검사와 화면 설명용. */
export function waitingIndices(): number[] {
  return [...pending.keys()].sort((a, b) => a - b);
}

/** 검사용 — 처음 상태로. */
export function resetScanGate(): void {
  runKey = null;
  pending.clear();
  litAt.clear();
  dataFlowing = false;
  shownUrls.clear();
  failedUrls.clear();
  preloaded.clear();
  if (stopTimer !== null) { stopTimer(); stopTimer = null; }
}
