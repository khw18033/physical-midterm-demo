/**
 * src/physical/robotSession.ts (260910 신설 — 화면 연결 §1 · §3 · §4)
 *
 * **로봇 한 판의 상태를 들고 있는 열 하나.** 화면은 이걸 읽고, 응답은 이리로 들어온다.
 * `src/data/trace.ts` 와 같은 자리·같은 이유다 — 입구가 둘이면 갈라진다.
 *
 * ## 정지가 하는 넷은 서로 묶여 있지 않다 (§5 「명령이 안 나가도 화면은 멈춘다」)
 *
 *   1. `abort` 발행        ← 실패할 수 있다. 네트워크를 타고 나가므로
 *   2. 추적 중단           ← 여기서 일어난다
 *   3. 타이머·폴링 정지    ← 여기서 일어난다
 *   4. 화면 잠금           ← 여기서 일어난다
 *
 * **2·3·4 는 1의 결과를 보지 않는다.** 이게 이 기능의 뼈대다. 발행이 실패했다고 화면이
 * 계속 돌면, 누른 사람은 멈춘 줄 알고 로봇에 다가간다.
 *
 * ## 이건 안전장치가 아니다
 *
 * 화면의 정지는 소프트웨어 정지다. 브로커가 죽었거나 Wi-Fi 가 끊기면 명령이 아예 안 나간다.
 * **물리적 비상 정지는 로봇 본체와 조종기 쪽에 있다.** 시험할 때도 발표할 때도 조종기를
 * 든 사람이 옆에 있어야 한다.
 */

import { useSyncExternalStore } from 'react';
import type { ViewpointFrame } from '../viewpoint/fill.ts';
import type { LinkEffect } from './missionLink.ts';
import type { PhysicalStatus } from './PhysicalClient.ts';

/** 화면이 잠긴 이유. `null` 이면 안 잠겼다. */
export type StopState = {
  /** 누른 시각. 「정지됨」 띠에 적는다. */
  atIso: string;
  /** `abort` 가 실제로 나갔는가. **화면 잠금과 별개다.** */
  published: boolean;
  /** 못 나갔으면 왜. 크게 빨갛게 띄울 문구다. */
  failure: string | null;
};

/**
 * **일시정지.** 정지와 다른 점은 하나다 — **진행상황을 안 버린다.**
 *
 *   정지    로봇을 멈추고 화면을 잠근다. 여덟 칸도 진행률도 종결된다. 다시 승인해야 한다
 *   일시정지 로봇을 멈추지만 여덟 칸·진행률·문 방향은 그대로 둔다. 재시작하면 이어 간다
 *
 * ## 로봇에는 「이어 하기」가 없다
 *
 * 규약에 일시정지도 재개도 없다(연동 가이드 §4-2). 우리가 할 수 있는 것은 `abort_mission`
 * 으로 **돌던 임무를 접는 것**뿐이다. 그래서 재시작은 멈춘 지점부터가 아니라 **그 단계를
 * 처음부터** 다시 낸다. 화면이 그렇게 말한다 — 「이어서 간다」고 적어 두면 발표자가
 * 로봇이 세 걸음째부터 돌 줄 알고 기다린다.
 */
export type PauseState = {
  atIso: string;
  /** 멈출 때 돌던 태스크. 재시작이 다시 낼 명령이 이것이다. 없었으면 null. */
  taskId: string | null;
  /** `abort_mission` 이 실제로 나갔는가. **화면 멈춤과 별개다.** */
  published: boolean;
  failure: string | null;
};

/**
 * **로봇이 보내온 한 줄.** 지어낸 문장이 아니라 **받은 값 그대로**다 (260912 지시).
 *
 * 액션 아이템 자리와 실패 사유 자리가 둘 다 이것을 읽는다. 전에는 그 두 자리에 손으로
 * 적은 예시 문장이 박혀 있었다 — 「진입 중 측면 클리어런스 0.06 m」 같은 것이 실제로
 * 일어난 적이 없는데도 실패할 때마다 떴다. **없으면 비운다.**
 */
export type CommandLogLine = {
  /** 받은 시각. 명령을 낸 시각과의 차이가 곧 걸린 시간이다. */
  atIso: string;
  /** 수락 / 진행 / 종료 중 무엇인가. */
  kind: 'acceptance' | 'status' | 'result';
  /** 한 줄 요약. 값은 로봇이 준 것만 담는다. */
  text: string;
  /** 로봇이 보낸 원문(`detail`). 없으면 빈 문자열 — 지어 채우지 않는다. */
  raw: string;
  /**
   * **몇 번째 각도의 줄인가** (260912 지시 — 각도별 노드가 자기 몫만 보여 준다).
   *
   * 한 바퀴는 명령 **하나**(`scan_mission`)인데 노드는 여덟이다. 그래서 그 하나의 로그를
   * 걸음 번호로 갈라 각 칸에 나눠 준다 — `step`(1부터) 을 인덱스(0부터)로 옮긴 값이고,
   * 그 변환은 `uplink.ts` 의 함수 하나가 한다.
   *
   * 회전 보고가 아닌 줄은 null 이다. 없는 칸에 억지로 붙이지 않는다.
   */
  index: number | null;
};

/** 태스크 하나가 로봇에 낸 명령. 응답이 어느 노드의 것인지 이걸로 안다. */
export type TaskCommandRecord = {
  taskId: string;
  commandId: string;
  /** 무슨 명령이었나. 로봇이 「그런 명령 없다」고 하면 어느 이름인지 알아야 한다. */
  action: string;
  /** **실제로 실려 나간 값.** 화면에 적힌 계획값이 아니라 바이트에 들어간 것이다. */
  parameters: Record<string, number>;
  /** 낸 시각. 로그의 시각과 견주면 걸린 시간이 나온다. */
  issuedAtIso: string;
  /** 추적기가 발급한 요청 식별자 — 감사·추적이 이 키로 걸린다. */
  requestId: string | null;
  state: 'issued' | 'running' | 'done' | 'failed';
  code: string | null;
  message: string | null;
  result: Record<string, number>;
  /** 이 명령으로 오간 로그. **받은 순서 그대로** 쌓는다. */
  log: readonly CommandLogLine[];
};

export type RobotSession = {
  connection: PhysicalStatus;
  /** command_id → 그 명령을 낸 태스크. `effectsOf` 의 `taskOf` 가 이걸 본다. */
  commands: Readonly<Record<string, TaskCommandRecord>>;
  /** 뷰포인트 칸별 경고 (`note != ok`). 인덱스로 찾는다. */
  warnings: Readonly<Record<number, string>>;
  /** 진행률 — `ack/of`. 아직 모르면 null. */
  progress: { ack: number; of: number } | null;
  /**
   * `door_turn` 이 왔는가 — `MS-B` 로 넘어가는 선이 열린다. 새 노드가 아니다.
   * `chosenIndex` 는 **로봇이 고른 칸**이다. 그 칸이 초록이 된다 (260910).
   */
  doorTurn: { yawDeg: number | null; chosenIndex: number | null } | null;
  /** 이 판에서 각 걸음이 보고한 방위. `door_turn` 을 견주는 데 쓴다. */
  seenYaw: Readonly<Record<number, number>>;
  /** 이 판에서 켜진 뷰포인트 칸. 방위를 모르고 켜진 칸(0도)도 여기엔 있다. */
  litIndices: Readonly<Record<number, true>>;
  /**
   * **출발 방향으로 돌아온 마지막 회전의 방위** (260914). 곧 스캔을 시작한 방위다 — 탐지의
   * 회전각이 그 방위 기준이라, 로봇이 스캔 뒤 `door_turn` 으로 틀어진 만큼 이동 명령을 보정한다.
   */
  scanReturnYaw: number | null;
  /**
   * **로봇이 지금 촬영 뒤 서서 기다리는 각도** (260914). `scan_release` 가 오면 null. `holdSeen` 은 이 판에서
   * 대기 보고를 한 번이라도 받았는가 — 옛 노드(대기 없음)와 가른다.
   */
  scanHold: { step: number; rotationDeg: number; seq: number | null; timeoutS: number | null; note: string; sinceMs: number } | null;
  holdSeen: boolean;
  /**
   * **문이 있다고 칠 방향** — 임시다 (260910 지시).
   *
   * 문 탐지 기능이 아직 없다(연동 가이드 §5-3). `door_turn` 은 고정된 기하값이라 「어느
   * 쪽에 문이 있나」를 아무도 말해 주지 않는다. 탐지가 붙을 때까지 **여덟 중 하나를
   * 무작위로** 정해 두고 화면이 그 자리에 「임시」라고 적는다.
   *
   * 판마다 한 번만 뽑는다 — 다시 그릴 때마다 뽑으면 초록 칸이 돌아다닌다.
   * 탐지가 붙는 날 이 칸을 탐지 결과로 갈아 끼우면 화면 코드는 안 바뀐다.
   */
  doorIndex: number | null;
  /** 스캔을 이미 쐈는가. 승인 한 번에 한 번만 나간다. */
  scanIssued: boolean;
  /** 접근을 이미 쐈는가. **자동으로 넘어가지 않는다** — 사람이 누른다(§1). */
  approachIssued: boolean;
  /** 승인 뒤인가. 이 값이 false 인 동안 로봇으로 나가는 바이트가 없어야 한다(§2). */
  approved: boolean;
  /** 잠김. `null` 이면 안 잠겼다. */
  stopped: StopState | null;
  /** 일시정지됨. `null` 이면 안 멈췄다. **진행상황은 그대로 남아 있다.** */
  paused: PauseState | null;
  /** 마지막 `ping` 왕복. 발표 직전에 이걸 보고 무대에 오른다. */
  ping: { ok: boolean; roundTripMs: number | null; message: string } | null;
  /** 승인한 시각(ms). 승인 전에는 null. */
  approvedAtMs: number | null;
  /**
   * **사람이 「임무 시작」을 눌렀는가** (260912 지시).
   *
   * 승인만으로는 로봇이 안 움직인다. 승인은 「이 계획대로 해도 좋다」이고, 시작은
   * 「지금 하라」다 — 무대에서 그 둘 사이에 말할 시간이 필요하다. 승인하자마자 로봇이
   * 돌기 시작하면 발표자가 계획을 설명할 틈이 없다.
   */
  started: boolean;
  /** 시작을 누른 시각(ms). **임무 시계의 0초가 여기다.** 승인 시각이 아니다. */
  startedAtMs: number | null;
  /**
   * **준비 단계가 끝났는가** (260912 지시).
   *
   * 시작을 누르면 로봇이 곧바로 돌았다. 그런데 앞에 두 태스크가 있다 — 「2D 맵에서 문
   * 위치 확인」(`T-A1`)과 「로봇 현재 위치와 각도 파악」(`T-A2`). 도는 것은 그 뒤의 일인데
   * 화면에서는 **한 바퀴 다 돌고 나서** 그 둘에 완료가 떴다. 순서가 거꾸로 보였다.
   *
   * 그래서 시작과 회전 사이에 창을 하나 둔다. 이 값이 참이 되기 전에는 스캔이 안 나간다.
   *
   * **창만으로는 안 열린다** (260914 실측 — 「앞의 두 노드가 대기인데 로봇이 돈다」).
   * 시계가 닫혀도 T-A1·T-A2 가 실제로 끝나야 참이 된다(`physical/prepStage.ts`). 로봇이 몰지
   * 않는 대본 재생에서는 그 둘을 대본이 칠하므로 창만 본다.
   */
  prepared: boolean;
  /** 준비 창(최소 시간)이 닫혔는가. */
  prepWindowDone: boolean;
  /** T-A1·T-A2 가 실제로 끝났는가 — 도면을 읽었고, 로봇의 지금 방위를 받았다. */
  prepTasksDone: boolean;
  /** 준비가 끝난 시각(ms). **로봇이 돌기 시작하는 시계의 0초가 여기다.** */
  preparedAtMs: number | null;
  /**
   * 지금 어느 **단계**인가 (연동 가이드 §4-3). `sdk_starting` 이면 로봇이 일어서는 중이다.
   * 임무 ACK 와 다른 축이라 따로 둔다 — 진행률은 아직 0인데 로봇은 이미 뭔가 하고 있다.
   */
  stage: string | null;
  /**
   * 로봇이 **「그런 명령 없다」고 한 이름들** (`UNIMPLEMENTED`).
   *
   * 가이드에 적힌 어휘와 노드에 올라가 있는 어휘가 다를 수 있다 — 260910 실측으로
   * `sdk_stop` · `sdk_auto` 가 `UNIMPLEMENTED: action not supported` 로 돌아왔다.
   * 그러면 그 버튼은 **눌러도 영영 안 되는 버튼**이다. 비활성으로 감추지 않고(정지
   * 버튼과 같은 규칙) 한 번 듣고 나면 화면이 그 사실을 말한다.
   *
   * 하드웨어가 올리는 날 거절이 멈추고 저절로 풀린다 — 우리가 고칠 자리가 없다.
   */
  unsupported: Readonly<Record<string, true>>;
  /**
   * **스캔 중에 로봇이 스스로 걸었다** (260910 실측). `forward_m: 0` 을 보냈는데도 온다.
   *
   * 「접근 시작」을 누르면 **한 번 더** 걷는다는 뜻이라, 누르기 전에 알아야 한다.
   * 담은 것은 로봇이 적어 준 문구 그대로다 — `"ok odo=1.00m cmd=1.00m"`.
   */
  walked: string | null;
};

const EMPTY: RobotSession = {
  connection: { state: 'idle' },
  commands: {},
  warnings: {},
  progress: null,
  doorTurn: null,
  doorIndex: null,
  scanIssued: false,
  approachIssued: false,
  approved: false,
  stopped: null,
  paused: null,
  ping: null,
  approvedAtMs: null,
  started: false,
  startedAtMs: null,
  prepared: false,
  prepWindowDone: false,
  prepTasksDone: false,
  preparedAtMs: null,
  stage: null,
  unsupported: {},
  walked: null,
  seenYaw: {},
  litIndices: {},
  scanReturnYaw: null,
  scanHold: null,
  holdSeen: false,
};

let session: RobotSession = EMPTY;
const listeners = new Set<() => void>();
/** 정지가 끊어야 할 타이머들. 목 재생기·폴링이 여기 등록한다 (§4 의 3번). */
const timers = new Set<() => void>();

function commit(next: RobotSession): void {
  session = next;
  for (const listener of listeners) listener();
}

export function robotSession(): RobotSession {
  return session;
}

export function subscribeRobot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 화면이 읽는 자리. `useSyncExternalStore` 는 같은 참조를 돌려받아야 다시 그리지 않는다. */
export function useRobotSession(): RobotSession {
  return useSyncExternalStore(subscribeRobot, robotSession, robotSession);
}

/**
 * 임무가 바뀌면 판을 비운다. 남은 상태가 다음 임무의 노드를 칠하면 안 된다.
 *
 * **연결은 안 지운다** (260910 — 실제로 났던 버그). 브로커에 붙은 것은 임무의 성질이
 * 아니라 전송의 성질이다. 여기서 지웠더니 승인 순간에 「브로커 안 붙음」으로 보여
 * 대본 타이머가 돌았고, 로봇이 첫 걸음도 떼기 전에 화면이 끝나 있었다.
 *
 * `ping` 결과도 남긴다 — 연결 관리에서 확인한 사실이 임무를 바꿨다고 사라지면 안 된다.
 */
export function resetRobotSession(): void {
  cancelPrep();
  stopAllTimers();
  commit({ ...EMPTY, connection: session.connection, ping: session.ping });
}

/**
 * 정지가 끊을 타이머를 맡긴다. 되돌려주는 함수를 부르면 등록이 풀린다.
 * 목 재생기와 폴링이 이걸 쓴다 — 정지 한 번에 전부 선다.
 */
export function registerTimer(cancel: () => void): () => void {
  timers.add(cancel);
  return () => timers.delete(cancel);
}

function stopAllTimers(): void {
  for (const cancel of timers) cancel();
  timers.clear();
}

export function setConnection(connection: PhysicalStatus): void {
  /**
   * **시작한 뒤에 브로커가 붙었다** — 준비를 창만 보고 열어 뒀다면 도로 닫는다 (260914).
   * 로봇이 몰기 시작하는 순간부터는 T-A1·T-A2 가 실제로 끝나야 돈다. 이미 스캔을 냈으면
   * 건드리지 않는다 — 돌고 있는 판을 되돌리지 않는다.
   */
  const reopen = connection.state === 'open' && session.started && session.prepared
    && !session.prepTasksDone && !session.scanIssued;
  commit({ ...session, connection, ...(reopen ? { prepared: false, preparedAtMs: null } : {}) });
}

export function setPing(ping: RobotSession['ping']): void {
  commit({ ...session, ping });
}

/**
 * **사람이 이번 세션에서 승인을 누른 계획.** 로봇 관문은 이 값이 맞을 때만 열린다.
 *
 * 260910 에 페이지를 새로 열자마자 `approved: true` 였다. 계획 채널이 **캐시되는 채널**이라
 * 지난 세션의 승인된 계획이 재접속 즉시 다시 내려오고, 그걸 새 승인으로 받아 관문을
 * 열었기 때문이다. 브로커가 붙는 순간 스캔이 나갔다 — **사람이 아무것도 안 눌렀는데
 * 로봇이 움직일 수 있는 상태**였다.
 *
 * 모듈 변수로 둔다(세션 밖으로 안 나간다). 새로고침하면 비고, 그것이 이 값의 요점이다.
 */
let humanApprovedPlanId: string | null = null;

/** 사람이 「승인」을 눌렀다. 누른 그 순간에만 부른다. */
export function armApproval(planId: string): void {
  humanApprovedPlanId = planId;
}

/** 이 계획을 이번 세션에서 사람이 승인했는가. */
export function approvedByHuman(planId: string): boolean {
  return humanApprovedPlanId === planId;
}

/**
 * 승인 — 이 뒤부터 로봇으로 바이트가 나갈 수 있다 (`VZ-U-07`).
 *
 * **승인만으로는 안 움직인다** (260912). 관문이 하나 더 있다 — 사람이 「임무 시작」을
 * 누르는 것. 승인은 「이 계획대로 해도 좋다」이고 시작은 「지금 하라」다.
 */
export function markApproved(): void {
  commit({ ...session, approved: true, approvedAtMs: Date.now() });
}

/**
 * **준비 단계의 최소 길이(초).** 시작을 누르고 로봇이 돌기 시작할 때까지.
 *
 * 260914 에 바뀌었다. 전에는 이 시계가 닫히면 곧바로 돌았고, `T-A1`·`T-A2` 는 탐지의 자세
 * 역산을 기다렸다. 그런데 실제 탐지 프로그램은 자세를 **한 바퀴를 다 받은 뒤에** 계산한다 —
 * 두 노드는 대기인 채로 로봇이 돌았다.
 *
 * 이제 둘은 돌기 전에 **화면이 실제로 할 수 있는 일**로 끝난다(`physical/prepStage.ts`).
 * 도면과 문의 도면 위치를 읽고(T-A1), 로봇이 보고한 지금 방위를 받는다(T-A2). 이 시계는
 * 「그 둘이 진행 중으로 보이는 최소 시간」이고, 둘이 끝나야 비로소 돈다.
 */
export const PREP_SEC = 5;

/** 준비 창을 재는 타이머. 시작을 다시 누르거나 정지하면 끊는다. */
let prepTimer: ReturnType<typeof setTimeout> | null = null;
let unregisterPrep: (() => void) | null = null;

/**
 * **기록에 남기는 몫** (260914 — 임무 기록). 연결·ping 은 이 기기의 지금 사정이라 뺀다.
 */
export type RecordedRobotSession = Pick<RobotSession,
  'commands' | 'warnings' | 'progress' | 'doorTurn' | 'doorIndex' | 'seenYaw' | 'litIndices' | 'scanReturnYaw'
  | 'scanIssued' | 'approachIssued' | 'approved' | 'stopped' | 'paused' | 'approvedAtMs' | 'started' | 'startedAtMs'
  | 'prepared' | 'preparedAtMs' | 'stage' | 'unsupported' | 'walked'>;

export function recordableRobotSession(): RecordedRobotSession {
  const {
    commands, warnings, progress, doorTurn, doorIndex, seenYaw, litIndices, scanReturnYaw, scanIssued, approachIssued,
    approved, stopped, paused, approvedAtMs, started, startedAtMs, prepared, preparedAtMs, stage, unsupported, walked,
  } = session;
  return {
    commands, warnings, progress, doorTurn, doorIndex, seenYaw, litIndices, scanReturnYaw, scanIssued, approachIssued,
    approved, stopped, paused, approvedAtMs, started, startedAtMs, prepared, preparedAtMs, stage, unsupported, walked,
  };
}

/**
 * **다시보기 — 지난 판의 명령과 응답을 도로 채운다** (260914).
 *
 * 액션 아이템이 읽는 값(명령 · 로그 · 방위)만 되살린다. **승인·시작·정지는 안 되살린다** —
 * 그 셋이 참이면 스캔을 쏘거나 도면을 받으러 가거나 화면을 잠그는 쪽이 깨어난다. 다시보기는
 * 로봇을 움직이지 않는다. 그 셋의 원래 값은 기록 파일에 그대로 있다.
 */
export function restoreRobotSession(saved: Partial<RecordedRobotSession>): void {
  cancelPrep();
  stopAllTimers();
  commit({
    ...EMPTY,
    connection: session.connection,
    ping: session.ping,
    commands: saved.commands ?? {},
    warnings: saved.warnings ?? {},
    progress: saved.progress ?? null,
    doorTurn: saved.doorTurn ?? null,
    doorIndex: saved.doorIndex ?? null,
    seenYaw: saved.seenYaw ?? {},
    litIndices: saved.litIndices ?? {},
    scanReturnYaw: saved.scanReturnYaw ?? null,
    unsupported: saved.unsupported ?? {},
    walked: saved.walked ?? null,
    approachIssued: saved.approachIssued ?? false,
  });
}

function cancelPrep(): void {
  if (prepTimer !== null) { clearTimeout(prepTimer); prepTimer = null; }
  if (unregisterPrep !== null) { unregisterPrep(); unregisterPrep = null; }
}

/** 준비가 막 끝났다 — 끝난 시각을 한 번만 적는다. */
function prepare(next: RobotSession): RobotSession {
  if (next.prepared) return next;
  return { ...next, prepared: true, preparedAtMs: Date.now() };
}

/**
 * 준비 창이 닫혔다. **로봇이 몰면 T-A1·T-A2 도 끝나야 스캔이 나간다** (260914).
 * 로봇이 안 몰면(대본 재생) 두 노드는 대본이 칠하므로 창만으로 연다.
 */
export function finishPrep(): void {
  cancelPrep();
  if (session.prepared) return;
  const next = { ...session, prepWindowDone: true };
  commit(next.prepTasksDone || !robotDrives() ? prepare(next) : next);
}

/** T-A1·T-A2 가 실제로 끝났다. 창도 닫혀 있으면 이제 돈다. */
export function markPrepTasksDone(): void {
  if (!session.started || session.prepTasksDone) return;
  const next = { ...session, prepTasksDone: true };
  commit(next.prepWindowDone ? prepare(next) : next);
}

/** 사람이 「임무 시작」을 눌렀다. **임무 시계가 여기서 0부터 흐른다.** */
export function markStarted(): void {
  if (!session.approved) return;   // 승인 없이는 시작도 없다
  cancelPrep();
  commit({
    ...session, started: true, startedAtMs: Date.now(),
    prepared: false, prepWindowDone: false, prepTasksDone: false, preparedAtMs: null,
    // **지난 판의 방위를 들고 가지 않는다** (260914) — 이동 명령을 보정하는 재료라, 남아 있으면
    // 이번 판의 회전을 지난 판의 방위로 고친다.
    seenYaw: {}, litIndices: {}, scanReturnYaw: null, doorTurn: null, warnings: {}, walked: null,
    scanHold: null, holdSeen: false,
  });
  prepTimer = setTimeout(finishPrep, PREP_SEC * 1000);
  // 정지 한 번에 같이 끊긴다 — 멈춘 뒤에 창이 닫혀 스캔이 나가면 안 된다.
  unregisterPrep = registerTimer(cancelPrep);
}

/** 시작 전으로 되돌린다. 「처음부터」가 쓴다 — 다시 누르는 것도 사람의 행위다. */
export function clearStarted(): void {
  cancelPrep();
  commit({
    ...session, started: false, startedAtMs: null, prepared: false,
    prepWindowDone: false, prepTasksDone: false, preparedAtMs: null,
    scanIssued: false, approachIssued: false,
  });
}

/**
 * **로봇이 임무를 모는가.** 브로커에 붙어 있으면 그렇다.
 *
 * 붙어 있으면 대본의 자동 진행을 멈추고 uplink 가 오는 대로 진행한다 — 「라즈베리파이와
 * 통신되어서 받아오는 정보를 토대로 진행되어야 한다」(260910 지적). 안 붙어 있으면
 * 대본이 그대로 돈다 — 로봇 없이도 시연이 되어야 하기 때문이다.
 */
export function robotDrives(): boolean {
  return session.connection.state === 'open';
}

/** 승인 뒤 몇 초째인가. 로봇이 몰 때 사건의 시각이 된다. */
export function elapsedSec(): number {
  // **시작을 누른 순간이 0초다** (260912). 승인 시각으로 재면, 승인하고 설명하는 동안
  // 시계가 흘러 시작하자마자 「이미 한참 지난」 화면이 된다 — 탐지 시료가 그 시계로
  // 각도를 열고 여덟 칸의 시각도 그 축이라, 눌렀을 때 처음부터 흘러야 한다.
  // **시작 전에는 0이다.** 승인 시각으로 물러나면 안 된다 — 승인하고 설명하는 동안 시계가
  // 흘러, 눌렀을 때 이미 여덟 각도가 다 열린 화면이 된다. 실제로 그렇게 보였다:
  // 승인하고 한참 뒤에 열어 보면 **처음부터 270도만 불이 켜져 있었다.**
  if (session.startedAtMs === null) return 0;
  return (Date.now() - session.startedAtMs) / 1000;
}

/**
 * **로봇이 돌기 시작한 뒤 몇 초째인가.** 준비 단계를 뺀 시계다.
 *
 * 각도별 결과의 박자가 이 시계를 쓴다 — 시작 시계로 재면 로봇이 아직 서 있는 동안
 * 각도가 열려, **안 본 방향의 결과가 먼저 뜬다.**
 */
export function scanElapsedSec(): number {
  // **준비가 실제로 걸린 시간을 뺀다** (260914). 준비가 창보다 길어질 수 있다 — 로봇의 방위가
  // 늦게 오면 그만큼 늦게 돈다. 아직 준비 중이면 무한대를 빼서 0이다.
  const prepSec = session.preparedAtMs !== null && session.startedAtMs !== null
    ? Math.max(PREP_SEC, (session.preparedAtMs - session.startedAtMs) / 1000)
    : Number.POSITIVE_INFINITY;
  return afterPrep(elapsedSec(), prepSec);
}

/**
 * 준비를 뺀 시계. **순수 함수로 갈라 둔다** — 시계를 읽는 함수는 시험할 수가 없어서,
 * 빼는 규칙만 따로 두면 그것을 눈으로도 검사로도 확인할 수 있다.
 */
export function afterPrep(elapsed: number, prepSec = PREP_SEC): number {
  return Math.max(0, elapsed - prepSec);
}

/** 태스크가 명령을 냈다. `requestId` 는 추적기가 준다. */
export function recordCommand(record: TaskCommandRecord): void {
  commit({ ...session, commands: { ...session.commands, [record.commandId]: record } });
}

/**
 * **로봇이 보낸 한 줄을 그 명령 밑에 쌓는다** (260912 지시).
 *
 * 모르는 `command_id` 는 버린다 — uplink 는 토픽 하나라 남의 도구가 쏜 명령의 보고도
 * 같이 들어온다. 그것까지 쌓으면 우리 노드의 로그에 남의 값이 섞인다.
 *
 * 정지·일시정지 뒤에도 쌓는다. 진행을 **반영**하지 않는 것과 무엇이 왔는지 **기록**하는
 * 것은 다르다 — 멈춘 뒤에 뭐가 왔는지가 오히려 알고 싶은 것이다.
 */
export function noteCommandLog(commandId: string, line: CommandLogLine): void {
  const entry = session.commands[commandId];
  if (entry === undefined) return;
  const next = { ...entry, log: [...entry.log, line] };
  commit({ ...session, commands: { ...session.commands, [commandId]: next } });
}

/**
 * **그 각도의 줄만 모은다** (260912 지시).
 *
 * 한 바퀴가 명령 하나라 태스크 이름으로는 못 가른다. 줄에 적어 둔 걸음 번호로 가른다.
 * 그 각도의 줄이 하나도 없는 명령은 안 내놓는다 — 빈 표를 여덟 개 만들지 않는다.
 */
export function logAtIndex(index: number): ReadonlyArray<{
  record: TaskCommandRecord; lines: readonly CommandLogLine[];
}> {
  return Object.values(session.commands)
    .map((record) => ({ record, lines: record.log.filter((line) => line.index === index) }))
    .filter((entry) => entry.lines.length > 0)
    .sort((a, b) => a.record.issuedAtIso.localeCompare(b.record.issuedAtIso));
}

/** 그 태스크가 낸 명령들. 낸 순서대로 — 회전 먼저, 직진 나중. */
export function commandsOfTask(taskId: string): readonly TaskCommandRecord[] {
  return Object.values(session.commands)
    .filter((record) => record.taskId === taskId)
    .sort((a, b) => a.issuedAtIso.localeCompare(b.issuedAtIso));
}

export function markApproachIssued(): void {
  commit({ ...session, approachIssued: true });
}

export function markScanIssued(): void {
  commit({ ...session, scanIssued: true, scanHold: null, holdSeen: false });
}

/** 발행이 실패했으면 표시를 도로 내린다 — 안 나간 것을 나갔다고 둘 수 없다. */
export function clearScanIssued(): void {
  commit({ ...session, scanIssued: false });
}

/** `effectsOf` 가 낸 것을 판에 반영한다. **여기서 새로 계산하지 않는다** (§3). */
export function applyEffects(effects: readonly LinkEffect[]): ViewpointFrame[] {
  // **정지 뒤에는 아무것도 반영하지 않는다** (§4 의 2번). 뒤늦게 오는 CommandStatus 로
  // 노드가 더 차면, 「정지를 눌렀는데 화면이 계속 진행한다」가 된다 — 이 기능의 가장 흔한
  // 실패 모양이고 눈으로는 "어? 멈췄는데 왜 돌지"로 나타난다.
  if (session.stopped !== null) return [];

  // **일시정지도 같다** (260910 지적 — 「돌고 있는 도중 일시정지가 안 된다」).
  //
  // 멈춤 표시는 걸리는데 여덟 칸이 계속 찼다. 여기서 `stopped` 만 보고 `paused` 를 안
  // 봤기 때문이다. 로봇이 실제로 멈추기까지 몇 걸음이 더 날아오고, 그것들이 그대로
  // 반영되니 **누른 사람 눈에는 아무 일도 안 일어난 것**으로 보인다.
  //
  // 정지와 다른 점은 **버리는 것이 아니라 안 받는 것**이다. 이미 찬 칸은 그대로 남는다.
  if (session.paused !== null) return [];

  let next = session;
  const frames: ViewpointFrame[] = [];
  for (const effect of effects) {
    if (effect.kind === 'viewpoint') {
      frames.push(effect.frame);
      if (effect.frame.channel === 'robot_state') {
        const index = effect.frame.payload.rotation_index;
        // 이 걸음이 보고한 방위를 적어 둔다 — `door_turn` 이 어느 걸음이었는지 견줄 재료다.
        if (effect.yawKnown !== false) next = { ...next, seenYaw: { ...next.seenYaw, [index]: effect.frame.payload.yaw } };
        next = { ...next, litIndices: { ...next.litIndices, [index]: true } };
        // 경고는 회전 프레임에만 붙는다 — 로봇이 내는 것은 「어느 각도를 보는가」뿐이다(§6).
        if (effect.warning !== null) {
          next = { ...next, warnings: { ...next.warnings, [index]: effect.warning } };
        }
      }
    } else if (effect.kind === 'progress') {
      next = { ...next, progress: { ack: effect.ack, of: effect.of } };
    } else if (effect.kind === 'door-turn') {
      next = { ...next, doorTurn: { yawDeg: effect.yawDeg, chosenIndex: effect.chosenIndex } };
    } else if (effect.kind === 'scan-return') {
      next = { ...next, scanReturnYaw: effect.yawDeg };
    } else if (effect.kind === 'scan-hold') {
      const rotationDeg = effect.rotationDeg ?? effect.step * 45;
      next = {
        ...next, holdSeen: true,
        scanHold: { step: effect.step, rotationDeg, seq: effect.seq, timeoutS: effect.timeoutS, note: effect.note, sinceMs: Date.now() },
      };
    } else if (effect.kind === 'scan-release') {
      // 그 각도의 대기만 푼다 — 늦게 온 앞 각도의 풀림이 지금 대기를 지우면 안 된다.
      if (next.scanHold !== null && next.scanHold.step === effect.step) next = { ...next, scanHold: null };
    } else if (effect.kind === 'task-running' || effect.kind === 'task-failed' || effect.kind === 'task-done') {
      next = { ...next, commands: applyTaskEffect(next.commands, effect) };
      // 명령이 끝났으면 단계는 지난 말이다 — 「실행 중」을 끝난 뒤에도 띄우면 거짓말이다.
      if (effect.kind !== 'task-running') next = { ...next, stage: null };
      // **「그런 명령 없다」를 기억한다.** 눌러도 영영 안 되는 버튼을 계속 권하지 않는다.
      if (effect.kind === 'task-failed' && effect.code === 'UNIMPLEMENTED') {
        const action = next.commands[effect.commandId]?.action;
        if (action !== undefined) next = { ...next, unsupported: { ...next.unsupported, [action]: true } };
      }
    } else if (effect.kind === 'walked') {
      // 스캔이 걸었을 때만 놀랄 일이다 — 「접근 시작」(T-B2)은 걸으라고 시킨 것이다.
      if (effect.taskId === 'T-A3') next = { ...next, walked: effect.note };
    } else if (effect.kind === 'stage') {
      // **일어서는 중이라는 말을 안 삼킨다.** 몇 초 동안 아무 일도 안 일어나는 것처럼
      // 보이는 구간이고, 그때 화면이 조용하면 발표장에서 「왜 안 가지」가 된다.
      next = { ...next, stage: effect.stage };
    } else if (effect.kind === 'aborted') {
      // 로봇이 스스로 끊었다 — 우리가 누른 정지와 다르다. 화면은 잠그지 않고 사실만 남긴다.
      next = { ...next, progress: next.progress };
    }
  }
  if (next !== session) commit(next);
  return frames;
}

function applyTaskEffect(
  commands: RobotSession['commands'],
  effect: LinkEffect,
): RobotSession['commands'] {
  // **command_id 로 찾는다.** 태스크 이름으로 찾으면 같은 이름의 둘째 명령이 첫째를 덮는다.
  const entry = 'commandId' in effect ? commands[effect.commandId] : undefined;
  if (entry === undefined) return commands;
  const next = { ...entry };
  if (effect.kind === 'task-running') next.state = 'running';
  if (effect.kind === 'task-done') { next.state = 'done'; next.result = effect.result; }
  if (effect.kind === 'task-failed') {
    next.state = 'failed';
    // **거절 사유를 버리지 않는다** (§3). robot_state_dead 가 실제로 나온 응답이다.
    next.code = effect.code;
    next.message = effect.message;
  }
  return { ...commands, [entry.commandId]: next };
}

/**
 * **긴급 정지의 2·3·4.** 발행(1번)은 부르는 쪽이 따로 하고, **그 결과를 여기 넘긴다.**
 * 넘어온 결과가 실패여도 잠금은 그대로 일어난다 — 함수를 갈라 둔 것이 그 보장이다.
 */
export function lockStopped(published: boolean, failure: string | null): StopState {
  stopAllTimers();                                   // 3. 타이머·폴링 정지
  const stopped: StopState = { atIso: new Date().toISOString(), published, failure };
  // 멈추면 로봇의 대기도 풀린다(abort) — 남겨 두면 다시 이을 때 옛 각도 신호를 보낸다.
  commit({ ...session, stopped, scanHold: null });                   // 2. 추적 중단(applyEffects 가 즉시 막힌다) · 4. 잠금
  return stopped;
}

/**
 * 「정지됨」에서 나오는 길. **자동으로 돌아가지 않는다** (§4) — 사람이 다시 승인해야 한다.
 * 그래서 푸는 것과 동시에 승인도 내린다.
 */
export function releaseStopped(): void {
  // 정지를 풀면 승인도 내려간다 — 사람이 다시 눌러야 관문이 열린다.
  humanApprovedPlanId = null;
  cancelPrep();
  commit({
    ...session, stopped: null, approved: false, approachIssued: false, scanIssued: false,
    // 다시 승인받아야 하는 판이다 — 준비 단계도 처음부터 다시 지나간다.
    started: false, startedAtMs: null, prepared: false,
    prepWindowDone: false, prepTasksDone: false, preparedAtMs: null,
  });
}

/** 지금 로봇 명령을 내도 되는가. 승인 전과 정지 뒤에는 안 된다. */
export function canIssueRobotCommand(): boolean {
  return session.approved && session.stopped === null && session.paused === null;
}

/**
 * **일시정지를 건다.** 정지와 같은 뼈대다 — 발행이 실패해도 2·3 은 그대로 일어난다.
 * 다른 점은 **아무것도 안 버린다**는 것뿐이다. 여덟 칸도 진행률도 문 방향도 그대로다.
 */
export function lockPaused(taskId: string | null, published: boolean, failure: string | null): PauseState {
  stopAllTimers();
  const paused: PauseState = { atIso: new Date().toISOString(), taskId, published, failure };
  commit({ ...session, paused, scanHold: null });
  return paused;
}

/**
 * **일시정지를 푼다.** 정지 해제와 달리 **승인을 안 내린다** — 사람이 이미 승인한 임무를
 * 잠깐 세웠다가 이어 가는 것이라 다시 승인을 받을 이유가 없다.
 *
 * `scanIssued` 는 내린다. 재시작이 그 단계를 다시 내야 하기 때문이다.
 */
/**
 * 일시정지 문구를 **뒤늦게** 채운다. 로봇의 답이 늦게 오기 때문이다.
 *
 * 이미 풀렸으면 아무것도 안 한다 — 지나간 판의 사유가 다시 뜨면 안 된다.
 */
export function notePauseFailure(failure: string): void {
  if (session.paused === null) return;
  commit({ ...session, paused: { ...session.paused, failure } });
}

export function releasePaused(): void {
  commit({ ...session, paused: null, scanIssued: false, approachIssued: false });
}

/** 지금 로봇이 돌리고 있는 태스크. 재시작이 무엇을 다시 낼지 정하는 재료다. */
/**
 * **문 방향을 하나 뽑는다** — 탐지가 붙기 전까지의 임시 자리 (260910 지시).
 *
 * 스캔을 낼 때 한 번만 부른다. 이미 뽑았으면 그대로 둔다 — 재시작으로 같은 판을 다시
 * 돌 때 답이 바뀌면 「아까는 7번이었는데」가 된다.
 */
export function pickDoorIndex(count: number): number {
  if (session.doorIndex !== null) return session.doorIndex;
  const index = Math.floor(Math.random() * Math.max(1, count));
  commit({ ...session, doorIndex: index });
  return index;
}

export function runningTaskId(): string | null {
  const running = Object.values(session.commands).find((c) => c.state === 'running' || c.state === 'issued');
  return running?.taskId ?? null;
}
