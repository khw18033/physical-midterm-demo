/**
 * src/record/recorder.ts (260914 신설 — 「새로고침하면 임무 이력이 다 날아간다」)
 *
 * **판마다 파일로 남긴다.** 리허설 기록이 디버깅에 쓰이는데, 지금까지는 새로고침 한 번에 전부
 * 사라졌다. DB 가 붙기 전까지 저장소 루트 `mission-history/<날짜>/<시각_임무>/` 에 쓴다
 * (창구 `scripts/mission-records.mjs`).
 *
 * ## 무엇을 남기나
 *
 *   mission.json    어떤 임무였나 — 임무 정의 전체(`view`) · 시작/끝 시각 · 결과 · 노드 셈 · 경로 요약
 *   progress.json   어떻게 진행됐나 — 기록 열 · 뷰포인트 프레임 · 로봇 명령과 응답 로그 · 탐지 결과와
 *                   근거 · 탐지 로그 · 준비 단계 값 · 알림 · 로봇 촬영 목록
 *   images/detect   탐지가 내준 그림 — 각도 원본 · 상자 입힌 것 · 잘라낸 것 · 경로 그림 · 도면
 *   images/robot    로봇이 찍어 보낸 원본 (각도별)
 *
 * 다시보기(`loadRecord.ts`)가 이 둘을 도로 채워 **같은 화면**으로 그린다. 그래서 여기서 쓰는 모양이
 * 곧 저장소의 모양이다 — 따로 번역하지 않는다.
 *
 * ## 언제 쓰나
 *
 * - **바뀌었을 때마다** (1.5초 주기로 보고, 달라진 파일만). 끝 표시 없이 새로고침·충돌로 끊겨도
 *   거기까지는 남는다 — 리허설에서 알고 싶은 것이 바로 그런 판이다.
 * - **판이 끝났을 때 곧바로** (완료·실패·정지).
 * - **새 판이 서기 직전** (`sealRun`) — 새 임무·처음부터·초기화는 저장소를 비운다. 비우기 전에 뜬다.
 *
 * 폴더는 **무언가 일어난 뒤에야** 만든다 — 승인만 하고 끝낸 판까지 폴더가 생기면 목록이 빈 판으로 찬다.
 *
 * ## 그림
 *
 * 탐지 그림은 **탐지 창구가 새 판을 시작할 때 지운다.** 받은 즉시 떠 둔다. 아직 안 만들어진 그림(404)은
 * 다음 주기에 다시 시도하고, 여러 번 실패하면 그만둔다 — 기록에는 어느 그림이 비었는지 남는다.
 * 탐지가 판을 다시 시작하면(`imageRound`) 같은 이름의 그림을 새로 떠서 덮는다.
 *
 * 다시보기 중에는 아무것도 안 쓴다. 창구가 없으면(단독 빌드 등) 조용히 멈춘다.
 */

import { foldStatuses } from '../data/fold.ts';
import {
  currentRunSerial, missionHistory, onRunSeal, subscribeMissionHistory, type MissionHistoryEntry,
} from '../data/missionHistory.ts';
import { getMissionState, NO_MISSION, traceEvents } from '../data/scenario.ts';
import { frameImageUrl, mapImageUrl, pathImageUrl, roundedImageUrl, sourceOf } from '../detect/DetectClient.ts';
import { detectLog } from '../detect/detectLog.ts';
import { detectState, recordableDetect } from '../detect/store.ts';
import { prepState } from '../physical/prepStage.ts';
import { recordableRobotSession, robotDrives, robotSession } from '../physical/robotSession.ts';
import type { ScanFeedMessage } from '../physical/scanFeed.ts';
import { connectionAddress } from '../shared/connections.ts';
import { notificationsNow } from '../shared/notifications.ts';
import { arrivedFrames } from '../viewpoint/store.ts';
import { useSyncExternalStore } from 'react';
import {
  detectImagePath, postRecordImage, putRecordJson, robotImagePath, runFolderOf, type RecordMissionSummary,
} from './recordClient.ts';
import { isReplayingRecord } from './replayMode.ts';

export const RECORD_SCHEMA = 'mission-record/1';
const TICK_MS = 1500;
/** 그림 하나를 몇 번까지 다시 떠 보나. 주기가 1.5초라 대략 30초. */
const IMAGE_ATTEMPTS = 20;

/** 로봇 촬영 한 건 — 그림은 파일로, 값은 여기로. */
export type RecordedRobotFrame = {
  receivedAtIso: string;
  rotationDeg: number;
  seq: number | null;
  bytes: number | null;
  sha1: string | null;
  duplicateOfPrev: boolean;
  timestamp: string | null;
  file: string | null;
};

type Run = {
  serial: number;
  missionId: string;
  createdAtMs: number;
  folder: { date: string; run: string } | null;
  startedAtIso: string | null;
  /** 마지막으로 쓴 본문 — 같으면 안 쓴다. */
  written: { mission: string; progress: string };
  robotFrames: RecordedRobotFrame[];
  /** 저장한 그림: 경로 → 서명(판 번호 등). 서명이 바뀌면 다시 뜬다. */
  images: Map<string, string>;
  /** 저장이 어떻게 됐나 — 기록에 같이 남긴다. */
  imageLog: Record<string, { source: string; savedAtIso: string | null; attempts: number; error: string | null }>;
};

type ImageJob = {
  folder: { date: string; run: string };
  run: Run;
  path: string;
  signature: string;
  source: string | Uint8Array;
  attempts: number;
};

export type RecorderStatus = {
  state: 'idle' | 'waiting' | 'recording' | 'unavailable';
  folder: string | null;
  lastSavedAtIso: string | null;
  lastError: string | null;
};

let run: Run | null = null;
let status: RecorderStatus = { state: 'idle', folder: null, lastSavedAtIso: null, lastError: null };
const statusListeners = new Set<() => void>();
const jobs = new Map<string, ImageJob>();
let writing: Promise<void> = Promise.resolve();
let jobsRunning = false;

function setStatus(next: Partial<RecorderStatus>): void {
  const merged = { ...status, ...next };
  if (merged.state === status.state && merged.folder === status.folder
    && merged.lastSavedAtIso === status.lastSavedAtIso && merged.lastError === status.lastError) return;
  status = merged;
  for (const listener of statusListeners) listener();
}

export function recorderStatus(): RecorderStatus {
  return status;
}

export function useRecorderStatus(): RecorderStatus {
  return useSyncExternalStore(
    (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    recorderStatus, recorderStatus,
  );
}

// ── 판 ───────────────────────────────────────────────────────────────────────

function currentRun(): Run | null {
  const mission = getMissionState();
  if (mission.current.missionId === NO_MISSION || mission.activatedBy !== 'approval') return null;
  if (run === null || run.serial !== currentRunSerial() || run.missionId !== mission.current.missionId) {
    run = {
      serial: currentRunSerial(),
      missionId: mission.current.missionId,
      createdAtMs: Date.now(),
      folder: null,
      startedAtIso: null,
      written: { mission: '', progress: '' },
      robotFrames: [],
      images: new Map(),
      imageLog: {},
    };
  }
  return run;
}

/** 이 판이 끝났으면 그 줄. 이 판이 서기 전에 적힌 줄은 남의 것이다. */
function endOf(target: Run): MissionHistoryEntry | null {
  const entry = missionHistory()[0];
  if (entry === undefined || entry.missionId !== target.missionId) return null;
  return Date.parse(entry.endedAtIso) >= target.createdAtMs - 1000 ? entry : null;
}

/** 폴더를 만들 만큼 무언가 일어났나 — 시작을 눌렀거나, 사람 밖의 사건이 왔거나, 끝났거나. */
function somethingHappened(target: Run): boolean {
  if (robotSession().started || endOf(target) !== null) return true;
  return traceEvents().some((event) => event.producedBy !== 'human' && event.producedBy !== 'ai');
}

// ── 본문 ─────────────────────────────────────────────────────────────────────

function buildBodies(target: Run): { mission: string; progress: string } {
  const mission = getMissionState();
  const view = mission.current;
  const trace = traceEvents();
  const folded = foldStatuses(mission.headSec, view, trace);
  const done = view.tasks.filter((task) => folded.tasks[task.id]?.status === 'done').length;
  const failed = view.tasks.find((task) => folded.tasks[task.id]?.status === 'failed') ?? null;
  const end = endOf(target);
  const detect = recordableDetect();
  const session = recordableRobotSession();
  const now = new Date().toISOString();

  const summary: RecordMissionSummary & { schema: string; folder: string; view: typeof view; connections: Record<string, string> } = {
    schema: RECORD_SCHEMA,
    folder: target.folder === null ? '' : `${target.folder.date}/${target.folder.run}`,
    missionId: view.missionId,
    label: view.label,
    startedAtIso: target.startedAtIso ?? now,
    updatedAtIso: now,
    endedAtIso: end?.endedAtIso ?? null,
    outcome: end?.outcome ?? null,
    done: end?.done ?? done,
    of: end?.of ?? view.tasks.length,
    failedTaskId: end?.failedTaskId ?? failed?.id ?? null,
    reason: end?.reason ?? '',
    headSec: mission.headSec,
    robotDriven: robotDrives(),
    testMode: detect.testMode,
    imageCount: target.images.size,
    path: detect.path === null ? null : {
      mode: detect.path.path_mode ?? null,
      turnInstruction: detect.path.turn_instruction,
      forwardM: detect.path.forward_distance_cm / 100,
    },
    pathFailure: detect.pathFailure,
    connections: {
      robot: connectionAddress('physical', 'ws'),
      detect: connectionAddress('detect', 'base'),
    },
    view,
  };

  const progress = {
    schema: RECORD_SCHEMA,
    missionId: view.missionId,
    updatedAtIso: now,
    headSec: mission.headSec,
    trace,
    viewpointFrames: arrivedFrames(),
    robot: session,
    robotFrames: target.robotFrames,
    detect,
    detectLog: detectLog(),
    prep: prepState(),
    notifications: notificationsNow(),
    images: target.imageLog,
  };
  return { mission: JSON.stringify(summary, null, 2), progress: JSON.stringify(progress) };
}

function write(target: Run, bodies: { mission: string; progress: string }): void {
  const folder = target.folder;
  if (folder === null) return;
  const missionChanged = bodies.mission.replace(/"updatedAtIso": "[^"]*"/, '') !== target.written.mission.replace(/"updatedAtIso": "[^"]*"/, '');
  const progressChanged = bodies.progress.replace(/"updatedAtIso":"[^"]*"/, '') !== target.written.progress.replace(/"updatedAtIso":"[^"]*"/, '');
  if (!missionChanged && !progressChanged) return;
  target.written = bodies;
  // 차례로 쓴다 — 같은 파일을 두 요청이 겹쳐 쓰면 늦게 출발한 것이 먼저 끝날 수 있다.
  writing = writing.then(async () => {
    try {
      if (progressChanged) await putRecordJson(folder.date, folder.run, 'progress.json', bodies.progress);
      await putRecordJson(folder.date, folder.run, 'mission.json', bodies.mission);
      setStatus({ state: 'recording', folder: `${folder.date}/${folder.run}`, lastSavedAtIso: new Date().toISOString(), lastError: null });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // 창구가 아예 없으면(404) 멈춘다 — 매 주기 실패를 쌓지 않는다.
      if (/ 404$/.test(why)) { setStatus({ state: 'unavailable', lastError: '기록 창구가 없습니다 — npm run dev 로 띄운 화면에서만 저장됩니다' }); return; }
      target.written = { mission: '', progress: '' };   // 다음 주기에 다시 쓴다
      setStatus({ lastError: why });
    }
  });
}

// ── 그림 ─────────────────────────────────────────────────────────────────────

function want(target: Run, path: string, signature: string, source: string | Uint8Array): void {
  if (target.folder === null) return;
  if (target.images.get(path) === signature) return;
  const key = `${target.folder.date}/${target.folder.run}/${path}`;
  const existing = jobs.get(key);
  if (existing !== undefined && existing.signature === signature) return;
  jobs.set(key, { folder: target.folder, run: target, path, signature, source, attempts: 0 });
  target.imageLog[path] = { source: typeof source === 'string' ? source : 'robot/frame (MQTT)', savedAtIso: null, attempts: 0, error: null };
}

/** 지금 저장소에 있는 탐지 그림을 떠 둘 목록에 올린다. */
function wantDetectImages(target: Run): void {
  const detect = detectState();
  const source = sourceOf(detect.testMode);
  const round = String(detect.imageRound);
  for (const frame of detect.frames) {
    const kinds = frame.found ? ['original', 'target_overlay', 'target_crop'] as const : ['original'] as const;
    for (const kind of kinds) {
      want(target, detectImagePath({ frame: frame.frame, kind }), round,
        roundedImageUrl(frameImageUrl(source, frame.frame, kind), detect.imageRound));
    }
  }
  if (detect.path !== null && detect.path.path_overlay_available !== false) {
    want(target, detectImagePath('path_overlay'), `${round}:${detect.path.turn_instruction}`,
      roundedImageUrl(pathImageUrl(source), detect.imageRound));
  }
  const map = prepState().map;
  if (map.url !== null && !map.bundled) {
    want(target, detectImagePath('map'), `${prepState().runKey ?? ''}:${map.url}`, roundedImageUrl(mapImageUrl(source), detect.imageRound));
  }
}

async function runJobs(): Promise<void> {
  if (jobsRunning) return;
  jobsRunning = true;
  try {
    for (const [key, job] of [...jobs]) {
      job.attempts += 1;
      const log = job.run.imageLog[job.path];
      try {
        const bytes = typeof job.source === 'string'
          ? await fetchImage(job.source)
          : job.source;
        await postRecordImage(job.folder.date, job.folder.run, job.path, bytes);
        job.run.images.set(job.path, job.signature);
        if (log !== undefined) Object.assign(log, { savedAtIso: new Date().toISOString(), attempts: job.attempts, error: null });
        if (jobs.get(key) === job) jobs.delete(key);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        if (log !== undefined) Object.assign(log, { attempts: job.attempts, error: why });
        if (job.attempts >= IMAGE_ATTEMPTS && jobs.get(key) === job) jobs.delete(key);
      }
    }
  } finally {
    jobsRunning = false;
  }
}

async function fetchImage(url: string): Promise<Blob> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`그림을 못 받았습니다 — ${response.status}`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('빈 그림');
  return blob;
}

function base64Bytes(base64: string): Uint8Array {
  const raw = atob(base64.replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

// ── 주기 ─────────────────────────────────────────────────────────────────────

/** 한 번 본다 — 폴더가 필요하면 만들고, 바뀐 것을 쓰고, 그림을 뜬다. 검사가 직접 부른다. */
export function recordTick(): void {
  if (isReplayingRecord() || status.state === 'unavailable') return;
  const target = currentRun();
  if (target === null) { setStatus({ state: 'idle', folder: null }); return; }
  if (target.folder === null) {
    if (!somethingHappened(target)) { setStatus({ state: 'waiting', folder: null }); return; }
    const startedAtMs = robotSession().startedAtMs ?? target.createdAtMs;
    target.folder = runFolderOf(new Date(startedAtMs), target.missionId);
    target.startedAtIso = new Date(startedAtMs).toISOString();
  }
  wantDetectImages(target);
  write(target, buildBodies(target));
  void runJobs();
}

/** 새 판이 서기 직전 — 지난 판의 마지막 모습을 지금 뜬다. 저장소가 곧 비워진다. */
function seal(): void {
  if (isReplayingRecord() || status.state === 'unavailable') return;
  recordTick();
  run = null;
}

/**
 * **로봇 촬영이 왔다** (`robotClient` 가 부른다). 그림은 곧바로 흘려보내고 값만 적는다.
 * 폴더가 아직 없으면 값만 들고 있다가 폴더가 서면 그림 없이 남는다 — 촬영은 시작 뒤에만 오므로 드물다.
 */
export function noteRobotFrame(message: ScanFeedMessage): void {
  if (message.kind !== 'frame' || isReplayingRecord() || status.state === 'unavailable') return;
  const target = currentRun();
  if (target === null) return;
  if (target.folder === null && somethingHappened(target)) recordTick();
  const path = robotImagePath(message.rotationDeg);
  const hasImage = message.imageBase64 !== null && target.folder !== null;
  target.robotFrames.push({
    receivedAtIso: new Date().toISOString(),
    rotationDeg: message.rotationDeg,
    seq: message.seq,
    bytes: message.bytes,
    sha1: message.sha1,
    duplicateOfPrev: message.duplicateOfPrev,
    timestamp: message.timestamp,
    file: hasImage ? path : null,
  });
  if (hasImage) {
    try {
      want(target, path, `${message.seq ?? ''}:${message.sha1 ?? target.robotFrames.length}`, base64Bytes(message.imageBase64!));
      void runJobs();
    } catch {
      // base64 가 깨졌으면 값만 남긴다.
    }
  }
}

let refs = 0;
let stopAll: (() => void) | null = null;

/** 켠다. 되돌려주는 함수를 부르면 끈다. 여러 번 켜도 하나만 돈다. */
export function startMissionRecorder(): () => void {
  refs += 1;
  if (stopAll === null) {
    const timer = setInterval(recordTick, TICK_MS);
    const offSeal = onRunSeal(seal);
    // 끝나면 곧바로 쓴다 — 주기를 기다리는 사이에 「처음부터」를 누르면 끝 표시가 늦는다.
    const offEnd = subscribeMissionHistory(() => recordTick());
    stopAll = () => { clearInterval(timer); offSeal(); offEnd(); };
  }
  return () => {
    refs -= 1;
    if (refs === 0 && stopAll !== null) { stopAll(); stopAll = null; }
  };
}

/** 검사용 — 기록기를 처음 상태로. */
export function resetRecorderForTest(): void {
  run = null;
  jobs.clear();
  writing = Promise.resolve();
  status = { state: 'idle', folder: null, lastSavedAtIso: null, lastError: null };
}

/** 검사용 — 밀린 쓰기와 그림이 끝날 때까지 기다린다. */
export async function settleRecorder(): Promise<void> {
  await writing;
  while (jobsRunning) await new Promise((resolve) => setTimeout(resolve, 5));
  await runJobs();
  await writing;
}
