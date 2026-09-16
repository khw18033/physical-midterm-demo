/**
 * src/physical/robotBridge.ts (260910 신설 — 화면 연결 §3)
 *
 * **uplink → 화면 상태.** `effectsOf()` 가 이미 내놓는 것을 잇기만 한다. 여기서 새로
 * 계산하지 않는다 — 계산이 두 곳에 있으면 하나만 고쳐지는 날이 온다.
 *
 * 뷰포인트 프레임은 1단계가 세운 열(`src/viewpoint/store.ts`)로 들어간다. 그 열은
 * 프레임이 로봇에서 왔는지 대본에서 왔는지 모른다 — 260909 §6 의 규칙 그대로다.
 */

import { useEffect } from 'react';
import { appendViewpoint } from '../viewpoint/store.ts';
import { hasResults } from '../detect/detectBridge.ts';
import { effectsOf, NO_NODE, type LinkEffect } from './missionLink.ts';
import type { PhysicalClient } from './PhysicalClient.ts';
import { advanceRobotHead, receiveRobotProgress } from '../data/scenario.ts';
import { noteIssue } from '../shared/notifications.ts';
import type { ScenarioEvent } from '../model/types.ts';
import { elapsedSec, applyEffects, noteCommandLog, robotSession } from './robotSession.ts';
import { robotClient } from './robotClient.ts';
import { isScanHold, isScanRelease, uplinkWords, viewpointIndexOf, type UplinkMessage } from './uplink.ts';
import { isReplayingRecord } from '../record/replayMode.ts';
import { offerScanFrame } from './scanGate.ts';

/**
 * uplink 하나를 화면 상태로. 되돌려주는 것은 뷰포인트 열에 넣은 프레임 수다.
 *
 * `chosenAngleDeg` 는 화면이 고른 각도다 — `door_turn` 의 yaw 와 대조해 로봇이 우리와
 * 다른 방향을 보고 있는지 본다.
 */
export function receiveUplink(
  message: UplinkMessage,
  missionId: string,
  atSec: number,
  viewpointCount = 8,
): number {
  // **다시보기 중에는 받지 않는다** (260914). 지난 판의 명령 로그에 지금 로봇의 응답이 섞이면
  // 기록을 들여다보는 의미가 없다. 로봇은 그대로 붙어 있고, 다시보기를 닫으면 다시 받는다.
  if (isReplayingRecord()) return 0;
  /**
   * **온 것을 그대로 적어 둔다** (260912 지시).
   *
   * 액션 아이템 자리와 실패 사유 자리가 이 로그를 읽는다. 전에는 그 두 자리에 손으로 쓴
   * 예시 문장이 박혀 있었고, 실제로 일어난 적이 없는 일이 실패할 때마다 떴다.
   *
   * **효과보다 먼저 적는다.** 효과는 정지·일시정지 뒤에 버려지는데, 무엇이 왔는지는
   * 그때도 알고 싶은 것이다 — 오히려 그때 가장 알고 싶다.
   */
  noteCommandLog(message.commandId, {
    atIso: new Date().toISOString(),
    kind: message.kind,
    text: uplinkWords(message),
    // 원문은 status 에만 있다. 없는 것을 지어 채우지 않는다.
    raw: message.kind === 'status' ? message.raw : '',
    // **몇 번째 각도의 줄인가.** 회전 보고가 아니면 null 이고, 그것이 정상이다.
    // 촬영 뒤 대기 · 풀림은 그 촬영의 칸에 붙인다 — `step` 이 촬영 순번(0부터)이다 (260914).
    index: message.kind !== 'status' ? null
      : (isScanHold(message.detail) || isScanRelease(message.detail)) && message.detail !== null
        && message.detail.step >= 0 && message.detail.step < viewpointCount
        ? message.detail.step
        : viewpointIndexOf(message.detail, viewpointCount),
  });

  const effects = effectsOf(message, {
    // 어느 태스크의 응답인가 — 발행할 때 적어 둔 표를 본다.
    taskOf: (commandId) => robotSession().commands[commandId]?.taskId ?? null,
    // 이 판에서 본 방위들 — `door_turn` 이 어느 걸음이었는지 견주는 재료다.
    seenYawByIndex: new Map(Object.entries(robotSession().seenYaw).map(([k, v]) => [Number(k), v])),
    litIndices: new Set(Object.keys(robotSession().litIndices).map(Number)),
    viewpointCount,
  });
  const frames = applyEffects(effects);
  // 이 봉투로 열에 넣은 프레임 수. **회전 프레임만 세면 안 된다** — 아래 판정 칠하기도
  // 프레임이고, 그것까지 세야 재생 머리가 그 뒤로 넘어간다.
  let appended = 0;
  for (const frame of frames) {
    // **회전 보고는 문지기를 지난다** (260914) — 촬영이 흐르는 판에서는 칸을 촬영과 탐지 결과가 켠다.
    appended += frame.channel === 'robot_state'
      ? offerScanFrame(missionId, atSec, frame, 'turn')
      : appendViewpoint(missionId, atSec, frame) ? 1 : 0;
  }

  /**
   * **로봇이 돌아선 칸에 불이 켜진다** (연동 가이드 §5-3 · 260910 갱신).
   *
   * 「로봇이 문으로 판단한 칸」이라고 읽고 그렇게 적었다가 고쳤다. **문 탐지 기능이 아직
   * 없다** — `door_turn` 의 회전 목표는 고정된 기하값이고 로봇이 방향을 고르는 절차는
   * 존재하지 않는다. 초록은 「찾았다」가 아니라 **「지금 이쪽을 보고 있다」**다.
   *
   * 그래도 칸은 칠한다. 로봇이 어느 쪽을 보고 서 있는지가 다음 걸음(「접근 시작」)을
   * 누를 사람에게 필요한 정보이기 때문이다. 문 유무 자체는 탐지가 붙을 때까지 비어 있다.
   *
   * `door_turn` 이 올 때 한 번에 칠한다 — 도는 동안 미리 칠하면 화면이 로봇보다 앞서 간다.
   */
  for (const effect of effects) {
    if (effect.kind !== 'door-turn') continue;
    // **탐지가 말하면 로봇은 칸을 안 칠한다** (260912).
    //
    // 탐지 결과가 한 건이라도 있으면 여덟 칸은 그쪽이 채운다(`detect/detectBridge.ts`).
    // 둘 다 칠하면 같은 칸을 두 번 덮어쓰고, 그때 어느 쪽이 이기는지는 도착 순서가 정한다.
    if (hasResults()) continue;

    // 여기부터는 **탐지가 아직 없을 때**의 임시다 (260910 지시).
    //
    // 로봇이 돌아선 방향(`effect.chosenIndex`)은 고정된 기하값이라 「문이 거기 있다」는
    // 뜻이 아니다(연동 가이드 §5-3). 그래서 여덟 중 하나를 무작위로 정해 두고 그 칸에
    // 불을 켠다 — 화면이 그 자리에 「임시」라고 적는다.
    //
    // 못 뽑았으면(스캔을 안 거쳤다면) 아무 칸도 안 켠다. 지어 고르지 않는다.
    const doorIndex = robotSession().doorIndex;
    if (doorIndex === null) continue;
    for (let index = 0; index < viewpointCount; index += 1) {
      const chosen = index === doorIndex;
      const verdict = applyEffects([{
        kind: 'viewpoint',
        frame: {
          channel: 'detection',
          payload: {
            index,
            angleDegOf: undefined,
            angle_deg: seenYawOf(index),
            door: chosen,
            bbox: null,
            confidence: chosen ? 1 : 0,
            // **탐지 결과가 아니다.** 로봇이 지금 이쪽을 보고 있다는 사실뿐이다.
            // **탐지 결과가 아니다.** 탐지가 붙기 전까지 임시로 뽑은 방향이다.
            reason: chosen ? '임시 판정 — 문 탐지가 아직 안 붙었습니다' : '',
          } as never,
        },
        warning: null,
      }]);
      for (const done of verdict) appendViewpoint(missionId, atSec, done);
      appended += verdict.length;
    }
  }

  // **머리도 같이 민다.** 회전 사건에는 태스크 상태 변화가 없어서 아래 사건 옮기기만으로는
  // 머리가 안 움직이고, 그러면 방금 넣은 프레임이 「아직 안 온 것」으로 걸러진다.
  //
  // 260910 — 여기서 `frames.length` 만 봤다가 실물에서 걸렸다. `door_turn` 은 회전 프레임을
  // 하나도 안 만들고(진행률과 door-turn 효과뿐이다) 판정 여덟 칸만 만든다. 그래서 머리가
  // 안 밀렸고, **여덟 칸이 「회전 중」에서 영영 안 넘어갔다.** 로봇은 다 돌고 문까지
  // 골랐는데 화면만 도는 중이었다. 넣은 것을 다 세어야 한다.
  if (appended > 0) advanceRobotHead(missionId, atSec);

  // **태스크 노드도 로봇이 민다** (260910 지적). 대본 타이머가 멈춰 있으므로 노드 상태가
  // 저절로 바뀌지 않는다 — 응답을 기록 열의 사건으로 옮겨야 화면이 따라온다.
  for (const event of traceEventsOf(effects, atSec)) receiveRobotProgress(missionId, event);

  /**
   * **실패는 알림에도 올린다** (260913 지시 — 「어떤 태스크에서 어떤 문제인지」).
   *
   * 노드가 빨개지는 것은 그 마일스톤을 보고 있을 때만 보인다. 발표자가 다른 화면에 있으면
   * 로봇이 거절당한 것을 모른 채로 다음 걸음을 누른다. 머리줄의 뱃지는 어느 화면에서도 는다.
   *
   * 문구는 **어느 태스크·무슨 명령·로봇이 뭐라 했는지** 셋이다. 셋 다 로봇이 준 값이고
   * 없는 칸은 안 적는다.
   */
  for (const effect of effects) {
    if (effect.kind !== 'task-failed') continue;
    const action = robotSession().commands[effect.commandId]?.action ?? null;
    const who = effect.taskId === NO_NODE ? (action ?? '이름 없는 명령') : `${effect.taskId}${action === null ? '' : ` · ${action}`}`;
    const why = [effect.code, effect.message].filter((v) => v !== null && v !== '').join(' ');
    noteIssue(`task:${effect.taskId}`, 'robot', `${who} 실패 — ${why || '사유 없음'}`);
  }
  return appended;
}

/**
 * 로봇의 응답 → 기록 열의 사건. **없는 사건을 만들지 않는다** — 태스크 상태가 실제로
 * 바뀐 것만 옮긴다.
 *
 * `seq` 는 사람 조작(1,000,000)·생성(2,000,000) 대역과 겹치지 않게 3,000,000 부터 센다.
 * 되감기가 열을 정렬할 때 로봇이 낸 것이 남의 대역에 끼면 순서가 뒤섞인다.
 */
let robotSeq = 3_000_000;

function traceEventsOf(effects: readonly LinkEffect[], atSec: number): ScenarioEvent[] {
  const events: ScenarioEvent[] = [];
  for (const effect of effects) {
    // 노드가 없는 명령(구동 브리지)은 사건을 안 만든다 — 없는 노드에 붙이면 그래프가 커진다.
    if ('taskId' in effect && effect.taskId === NO_NODE) continue;
    if (effect.kind === 'task-running') {
      events.push(event(effect.taskId, 'running', 'started', atSec));
    } else if (effect.kind === 'task-done') {
      events.push(event(effect.taskId, 'done', 'evaluated', atSec, effect.result));
      /**
       * **임무 종료 확인은 화면이 내리는 판정이다** (260912 지시 — 「임무 완료 판정까지」).
       *
       * `T-C1` 에 대응하는 로봇 명령이 없다. 로봇에 「임무가 끝났는가」를 묻는 말이 규약에
       * 없기 때문이다. 그래서 우리가 본 것으로 판정한다 — **도착 정지(`T-B3`)가 성공했으면
       * 한 바퀴가 끝난 것이다.**
       *
       * 정지가 실패하면 여기로 안 온다(그때는 `task-failed` 다). 끝나지 않은 임무를
       * 끝났다고 적지 않는다.
       */
      if (effect.taskId === 'T-B3') events.push(event('T-C1', 'done', 'evaluated', atSec));
    } else if (effect.kind === 'task-failed') {
      // 거절·실패 사유를 payload 에 그대로 싣는다 — 화면이 코드와 문구를 읽는다.
      events.push(event(effect.taskId, 'failed', 'failed', atSec, {
        ...(effect.code === null ? {} : { code: effect.code }),
        ...(effect.message === null ? {} : { message: effect.message }),
      }));
    }
  }
  return events;
}

function event(
  nodeId: string,
  status: ScenarioEvent['status'],
  kind: string,
  atSec: number,
  payload?: Record<string, unknown>,
): ScenarioEvent {
  robotSeq += 1;
  return {
    seq: robotSeq,
    atSec,
    nodeId,
    status,
    kind,
    // **로봇이 낸 것이다.** 사람도 대본도 아니다 — 열을 되짚을 때 그 사실이 남아야 한다.
    producedBy: 'backend',
    ...(payload === undefined ? {} : { payload }),
  } as ScenarioEvent;
}

/** 클라이언트를 화면 상태에 붙인다. 되돌려주는 함수를 부르면 끊긴다. */
export function bindRobot(
  client: PhysicalClient,
  missionId: string,
  headSec: () => number,
): () => void {
  return client.onMessage((message) => {
    receiveUplink(message, missionId, headSec());
  });
}

/**
 * **로봇이 그 각도에서 사진을 찍었다** — 그 칸을 「탐색 중」으로 켠다 (260914 리허설).
 *
 * 0도 노드는 회전하지 않는다. 로봇은 스캔을 시작하자마자 **돌기 전에** 0도를 찍는다 — 그 칸을
 * 켤 회전 보고가 없으므로 촬영(`/frame`)이 켠다. 다른 각도는 회전 보고와 촬영이 둘 다 켜는데,
 * 같은 칸에 같은 상태를 두 번 쓸 뿐이라 결과가 같다.
 *
 * 우리가 낸 스캔이 도는 중일 때만 받는다 — 남의 도구가 돌린 스캔의 촬영이 우리 칸을 켜면 안 된다.
 * 정지·일시정지 뒤에는 `applyEffects` 가 버린다.
 */
export function receiveScanCapture(missionId: string, atSec: number, index: number, yawDeg: number | null): number {
  const session = robotSession();
  if (!session.started || !session.scanIssued || isReplayingRecord()) return 0;
  const known = yawDeg ?? session.seenYaw[index] ?? null;
  const frames = applyEffects([{
    kind: 'viewpoint',
    frame: {
      channel: 'robot_state',
      payload: {
        rotation_index: index,
        // 0도 촬영에는 회전 보고가 없어 방위를 모른다 — 로봇의 지금 방위(state)를 넘겨받는다.
        yaw: known ?? 0,
        state: 'rotating',
        last_cmd: 'scan_mission',
        result: null,
      },
    },
    warning: null,
    // 방위를 모르면 0 을 적지 않는다 — `door_turn` 견주기에 가짜 0도가 끼면 엉뚱한 칸이 초록이 된다.
    yawKnown: known !== null,
  }]);
  // **촬영이 칸을 켠다 — 앞 칸의 탐지 결과가 온 뒤에** (260914 `scanGate.ts`).
  let put = 0;
  for (const frame of frames) put += offerScanFrame(missionId, atSec, frame, 'image');
  if (put > 0) advanceRobotHead(missionId, atSec);
  return put;
}

/** 그 걸음이 보고한 방위. 못 봤으면 0 — 표시용이고 칸을 고르는 데는 안 쓴다. */
function seenYawOf(index: number): number {
  return robotSession().seenYaw[index] ?? 0;
}


/**
 * **로봇 응답을 앱 수명 내내 받는다** (260910 실측으로 드러난 자리).
 *
 * 처음엔 이 배선이 `RobotPanel` 안에 있었다. 그 패널은 마일스톤 화면에만 있어서,
 * **로봇이 도는 동안 노드를 눌러 태스크 그래프로 들어가면 패널이 사라지고 구독이 끊겼다.**
 * 실물로 재보니 여덟 걸음은 다 들어왔는데 마지막 `door_turn` 하나가 통째로 버려져서,
 * 로봇은 문을 골라 돌아섰는데 화면은 여덟 칸이 「회전 중」인 채로 굳었다.
 *
 * 시연에서 노드를 눌러 보는 것은 당연한 동작이다. 그래서 `robotClient()` 가 연결 상태와
 * 장비 상태를 만들 때 잇는 것과 같은 이유로, 이 배선도 **안 사라지는 자리**에 둔다.
 *
 * 스캔 발행도 같이 옮겼다 — 승인 직후에 화면을 옮기면 명령이 아예 안 나갔다.
 */
export function useRobotUplink(missionId: string, params: Record<string, unknown> | null): void {
  useEffect(() => {
    const client = robotClient();
    return client.onMessage((message) => {
      // 시각은 **승인 뒤 몇 초째**다. 대본 시각이 아니다 — 화면이 로봇을 따라간다.
      receiveUplink(message, missionId, elapsedSec());
    });
  }, [missionId]);

  // **스캔 발행은 여기 없다** (260911). 그리기 타이밍에 매이면 두 판째에 안 나간다 —
  // 같은 임무를 다시 올릴 때 `approved` 가 한 틱 안에 true → false → true 로 오가서,
  // React 가 한 번의 그리기로 묶으면 의존값이 안 바뀐 것으로 보인다.
  // `robotClient()` 가 만들 때 세션을 구독해 쏜다.
  void params;
}
