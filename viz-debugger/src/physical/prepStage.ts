/**
 * src/physical/prepStage.ts (260914 신설)
 *
 * **로봇이 돌기 전의 두 걸음을 실제로 한다.**
 *
 *   T-A1  2D 맵에서 문 위치 확인      도면을 받아 오고, 그 위의 문 자리(GT 고정값)를 잡는다
 *   T-A2  로봇 현재 위치와 각도 파악   로봇이 보고한 **지금** 방위(`state.position.heading_deg`)를 받는다
 *
 * 둘 다 끝나야 `T-A3`(한 바퀴)가 나간다 — `robotSession.markPrepTasksDone()`.
 *
 * ## 전에는 왜 대기였나 (260914 실측)
 *
 * 두 노드는 탐지의 자세 역산(`/detect/localization`)을 기다렸다. 그런데 탐지 프로그램은 자세를
 * **여덟 장을 다 받은 뒤에** 계산한다(`mqtt_stream_receiver.py` — 「마지막 프레임 직후 localize()」).
 * 돌기 전에는 올 수가 없는 값이었고, 준비 창은 시계로만 닫혀서 **두 노드가 대기인 채로 로봇이
 * 돌았다.** 이전에 한 번 고친 증상이 같은 모양으로 되살아난 것이다.
 *
 * 이제 두 노드는 **돌기 전에 화면이 실제로 할 수 있는 일**로 끝난다. 탐지의 자세 역산은 한 바퀴
 * 뒤에 오면 그대로 T-A2 의 액션 아이템에 「탐지가 역산한 도면 기준 방위」로 덧붙는다 — 로봇이
 * 보고한 방위와 나란히 놓여 서로 견줄 수 있다.
 *
 * ## 로봇이 몰 때만 한다
 *
 * 브로커에 안 붙어 있으면 대본이 두 노드를 칠한다. 그때 여기서 또 칠하면 한 노드에 사건이
 * 두 벌 쌓인다.
 */

import { useSyncExternalStore } from 'react';
import { currentMission, receiveRobotProgress } from '../data/scenario.ts';
import { floorPlanUrls, isBundledFloorPlan, sourceOf } from '../detect/DetectClient.ts';
import { appendDetectLog, DETECT_TASKS, resetDetectLog } from '../detect/detectLog.ts';
import { DOOR_PX, doorCm } from '../detect/floorPlan.ts';
import { detectState } from '../detect/store.ts';
import type { ScenarioEvent } from '../model/types.ts';
import { noteIssue } from '../shared/notifications.ts';
import { deviceState, subscribeDevices } from './deviceState.ts';
import { hardwareTarget } from './encode.ts';
import { isReplayingRecord, subscribeReplayMode } from '../record/replayMode.ts';
import {
  elapsedSec, markPrepTasksDone, robotDrives, robotSession, subscribeRobot,
} from './robotSession.ts';

/** 대본의 로봇 id. 하드웨어 id(`go1-001`)로 바꾸는 표는 `encode.ts` 에 있다. */
const ROBOT_ENTITY = 'robot-01';

/**
 * 「지금」 방위로 칠 수 있는 나이. 로봇은 5초마다 state 를 민다 — 시작을 누르기 직전 한 주기
 * 안에 온 값까지는 지금 값이다. 그보다 오래된 값으로 끝내면 「현재 각도」가 거짓말이 된다.
 */
export const POSE_FRESH_MS = 6000;

/** 방위가 이만큼 안 오면 사유를 적는다. **돌지는 않는다** — 방위 없이 돌면 같은 오류다. */
export const POSE_WAIT_WARN_MS = 15000;

export type PrepStep = 'idle' | 'running' | 'done' | 'failed';

export type PrepPose = {
  headingDeg: number;
  /** 로봇 오도메트리(m). 도면 좌표가 아니다 — 도면 위 자리는 탐지가 한 바퀴 뒤에 역산한다. */
  xM: number;
  yM: number;
  /** 로봇이 찍은 시각(저쪽 시계). */
  stateTimestamp: string | null;
  /** 우리가 받은 시각. */
  receivedAtIso: string;
};

export type PrepState = {
  /** 이 준비가 어느 시작의 것인가(`startedAtMs`). 시작을 다시 누르면 새 판이다. */
  runKey: number | null;
  map: {
    step: PrepStep;
    /** 실제로 받아 온 도면 주소. 2D 맵 뷰 노드가 이 주소를 그린다. */
    url: string | null;
    /** 탐지 창구가 아니라 저장소 사본에서 읽었는가. */
    bundled: boolean;
    doorPx: { x: number; y: number };
    doorCm: { x: number; y: number };
    atIso: string | null;
    reason: string | null;
  };
  pose: { step: PrepStep; value: PrepPose | null; atIso: string | null; reason: string | null };
};

const IDLE: PrepState = {
  runKey: null,
  map: { step: 'idle', url: null, bundled: false, doorPx: { ...DOOR_PX }, doorCm: doorCm(), atIso: null, reason: null },
  pose: { step: 'idle', value: null, atIso: null, reason: null },
};

let state: PrepState = IDLE;
const listeners = new Set<() => void>();

function commit(next: PrepState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function prepState(): PrepState {
  return state;
}

export function subscribePrep(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrepStage(): PrepState {
  return useSyncExternalStore(subscribePrep, prepState, prepState);
}

// ── 사건 ─────────────────────────────────────────────────────────────────────

/** `seq` 대역 — 사람(1M)·생성(2M)·로봇(3M)·탐지(4M)와 겹치지 않게 5,000,000 부터. */
let seq = 5_000_000;

function emit(nodeId: string, status: 'running' | 'done', payload?: Record<string, unknown>): void {
  // **멈춘 뒤에는 칠하지 않는다.** 정지를 눌렀는데 노드가 더 차면 「멈췄는데 왜 가지」가 된다.
  const session = robotSession();
  if (session.stopped !== null || session.paused !== null) return;
  seq += 1;
  receiveRobotProgress(currentMission().missionId, {
    seq,
    atSec: elapsedSec(),
    nodeId,
    status,
    kind: status === 'done' ? 'evaluated' : 'started',
    // **화면이 받아 온 값으로 끝낸 것이다** — 도면은 탐지 창구(또는 사본), 방위는 로봇이 보냈다.
    producedBy: 'backend',
    ...(payload === undefined ? {} : { payload }),
  } as ScenarioEvent);
}

// ── 두 걸음 ──────────────────────────────────────────────────────────────────

/** 둘 다 끝났으면 돌아도 된다고 알린다. */
function settleIfReady(): void {
  if (state.map.step === 'done' && state.pose.step === 'done') markPrepTasksDone();
}

/**
 * **T-A1 — 도면을 실제로 받아 온다.** 받아 온 주소를 적어 두고, 2D 맵 뷰 노드는 그 주소를 그린다.
 * 탐지 창구가 아직 도면을 안 만들었으면(새 판 직후 404) 저장소의 같은 도면으로 대신한다.
 */
async function loadFloorPlan(runKey: number): Promise<void> {
  const tried: string[] = [];
  for (const url of floorPlanUrls(sourceOf(detectState().testMode))) {
    try {
      const response = await fetch(url);
      if (state.runKey !== runKey) return;              // 그사이 새 판이 시작됐다
      if (!response.ok) { tried.push(`${url} → ${response.status}`); continue; }
      const atIso = new Date().toISOString();
      const bundled = isBundledFloorPlan(url);
      commit({ ...state, map: { ...state.map, step: 'done', url, bundled, atIso, reason: null } });
      appendDetectLog({
        lane: bundled ? 'screen' : 'detect',
        level: tried.length > 0 ? 'warn' : 'info',
        text: bundled
          ? '도면을 저장소 사본에서 읽었습니다 — 탐지 창구에 아직 도면이 없습니다'
          : '탐지 창구에서 도면을 받았습니다',
        detail: [url, ...tried].join(' · '),
        tasks: [DETECT_TASKS.map],
      });
      const cm = state.map.doorCm;
      appendDetectLog({
        lane: 'screen',
        level: 'info',
        text: `문의 도면 위치 (${cm.x.toFixed(1)}, ${cm.y.toFixed(1)}) cm — GT 고정값`,
        detail: `px (${state.map.doorPx.x}, ${state.map.doorPx.y}) · 탐지 navigate_to_target_service 의 DOOR_PX`,
        tasks: [DETECT_TASKS.map],
      });
      emit(DETECT_TASKS.map, 'done', { door_position_cm: [Number(cm.x.toFixed(1)), Number(cm.y.toFixed(1))], floor_plan: url });
      settleIfReady();
      return;
    } catch (error) {
      tried.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (state.runKey !== runKey) return;
  const reason = `도면을 못 읽었습니다 — ${tried.join(' · ')}`;
  commit({ ...state, map: { ...state.map, step: 'failed', reason } });
  appendDetectLog({ lane: 'screen', level: 'error', text: reason, detail: '', tasks: [DETECT_TASKS.map] });
  noteIssue('prep-map', 'connection', `T-A1 ${reason} — 한 바퀴를 보류합니다`);
}

/** **T-A2 — 로봇이 보고한 지금 방위.** 시작 무렵 한 주기 안에 온 state 만 친다. */
function checkPose(): void {
  if (state.runKey === null || state.pose.step === 'done' || isReplayingRecord()) return;
  const device = deviceState(hardwareTarget(ROBOT_ENTITY));
  const position = device?.position ?? null;
  const at = device?.positionAtMs ?? null;
  if (position === null || at === null || at < state.runKey - POSE_FRESH_MS) return;
  const value: PrepPose = {
    headingDeg: position.headingDeg,
    xM: position.x,
    yM: position.y,
    stateTimestamp: device?.timestamp ?? null,
    receivedAtIso: new Date(at).toISOString(),
  };
  commit({ ...state, pose: { step: 'done', value, atIso: new Date().toISOString(), reason: null } });
  appendDetectLog({
    lane: 'screen',
    level: 'info',
    text: `로봇 방위(yaw) ${value.headingDeg.toFixed(1)}° · 위치 x ${value.xM.toFixed(2)} m · y ${value.yM.toFixed(2)} m`,
    detail: `로봇 state ${value.stateTimestamp ?? '시각 없음'} · 오도메트리 기준(도면 좌표 아님)`,
    tasks: [DETECT_TASKS.pose],
  });
  emit(DETECT_TASKS.pose, 'done', {
    heading_deg: value.headingDeg, x_m: value.xM, y_m: value.yM,
    ...(value.stateTimestamp === null ? {} : { state_timestamp: value.stateTimestamp }),
  });
  settleIfReady();
}

/** 시작이 바뀌었는지 본다. 새 시작이면 두 걸음을 처음부터 한다. */
function checkSession(): void {
  // 다시보기가 채운 준비 값은 그대로 둔다 — 세션이 비어 있다고 지우지 않는다.
  if (isReplayingRecord()) return;
  const session = robotSession();
  if (!session.started || session.startedAtMs === null) {
    if (state.runKey !== null) commit(IDLE);
    return;
  }
  if (state.runKey === session.startedAtMs) return;
  // 로봇이 안 몰면 대본이 칠한다. 나중에 브로커가 붙으면 이 함수가 다시 불려 그때 시작한다.
  if (!robotDrives()) return;

  const runKey = session.startedAtMs;
  resetDetectLog();                                     // 지난 판의 줄이 새 판 노드에 붙으면 안 된다
  commit({
    ...IDLE,
    runKey,
    map: { ...IDLE.map, step: 'running' },
    pose: { ...IDLE.pose, step: 'running' },
  });
  emit(DETECT_TASKS.map, 'running');
  emit(DETECT_TASKS.pose, 'running');
  appendDetectLog({
    lane: 'screen', level: 'info',
    text: '준비 시작 — 도면을 받고 로봇의 지금 방위를 받습니다. 둘 다 끝나야 한 바퀴를 돕니다',
    detail: '', tasks: [DETECT_TASKS.map, DETECT_TASKS.pose],
  });
  void loadFloorPlan(runKey);
  checkPose();
  const timer = setTimeout(() => {
    if (state.runKey !== runKey || state.pose.step === 'done') return;
    const reason = `로봇 state 가 ${POSE_WAIT_WARN_MS / 1000}초째 안 옵니다 — 방위 없이 돌지 않습니다`;
    commit({ ...state, pose: { ...state.pose, reason } });
    appendDetectLog({ lane: 'screen', level: 'warn', text: reason, detail: '', tasks: [DETECT_TASKS.pose] });
    noteIssue('prep-pose', 'robot', `T-A2 ${reason}`);
  }, POSE_WAIT_WARN_MS);
  // 사유를 적으려고 프로세스를 붙잡지 않는다(Node 검사) — 브라우저에는 없는 메서드다.
  (timer as { unref?: () => void }).unref?.();
}

let initialised = false;

/** 한 번만 잇는다. 로봇 클라이언트를 만들 때 부른다 — 그리기와 무관한 자리여야 두 판째에도 돈다. */
export function initPrepStage(): void {
  if (initialised) return;
  initialised = true;
  subscribeRobot(checkSession);
  subscribeDevices(checkPose);
  // 다시보기를 닫으면 그 판의 준비 값을 걷는다 — 다음 판 시작 전까지 남아 있으면 지난 판이 보인다.
  subscribeReplayMode(() => { if (!isReplayingRecord()) commit(IDLE); });
}

/**
 * **다시보기 — 지난 판의 준비 값** (260914). `runKey` 는 비운다 — 채워 두면 세션을 볼 때마다
 * 「시작이 바뀌었다」로 읽혀 다시 도면을 받으러 간다. 도면 주소는 부르는 쪽이 기록 폴더로 바꿔 준다.
 */
export function restorePrepStage(saved: PrepState): void {
  commit({ ...saved, runKey: null });
}

/** 검사가 판을 비울 때. */
export function resetPrepStage(): void {
  commit(IDLE);
}
