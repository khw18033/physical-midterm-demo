/**
 * src/physical/missionLink.ts (260910 신설 — 하드웨어 연동 §3 · §4 · §5 · §6)
 *
 * **로봇의 응답을 화면이 읽는 것으로 바꾸는 자리.** 어느 태스크가 무엇을 쏘고, 돌아온
 * 응답이 어느 노드를 어떻게 바꾸는지가 여기 한 곳에 있다.
 *
 * ## 두 출처가 섞이는 자리를 갈라 둔다 (§6)
 *
 *   몇 번째 각도인가 → **로봇** (`CommandStatus.detail.step`)
 *   그 각도에 문이 있는가 → **대본** (index 2만 door: true)
 *
 * 탐지 연동이 붙으면 **아랫줄만** 바뀐다. 그래서 이 파일은 「문이 있다」를 절대 스스로
 * 만들지 않는다 — 로봇에서 온 것으로는 `scanning` 까지만 간다.
 */

import type { ViewpointFrame } from '../viewpoint/fill.ts';
import { missionGeometry, SCAN_HOLD_AFTER_CAPTURE, SCAN_HOLD_TIMEOUT_S, type MissionGeometry } from './presets.ts';
import {
  chosenIndexOf, holdRotationOf, isDoorTurn, isReturnTurn, isScanHold, isScanRelease, progressOf, stageOf, viewpointIndexOf, warningOf,
  type StatusDetail, type UplinkMessage,
} from './uplink.ts';
import type { PhysicalAction } from './encode.ts';

/** 어느 태스크가 무엇을 쏘는가 (§3). 표가 여기 하나라 화면이 명령을 지어내지 않는다. */
/**
 * **노드가 없는 명령의 자리.** 구동 브리지 명령(`sdk_start` 등)은 태스크 그래프에
 * 대응하는 노드가 없다 — 임무의 한 걸음이 아니라 장비를 준비시키는 일이다.
 *
 * 그래도 `command_id` 를 표에 적어 둬야 그 응답의 **단계 보고**(`sdk_starting`)가 화면까지
 * 온다. `effectsOf` 는 모르는 command_id 의 상태를 통째로 버리기 때문이다(남의 도구가 쏜
 * 명령이 우리 진행률을 밀던 것을 막은 자리다). 그래서 이름은 주되, 사건은 안 만든다 —
 * 없는 노드에 사건을 붙이면 태스크 그래프가 대본보다 커진다.
 */
export const NO_NODE = 'no-node';

export type TaskCommand = { taskId: string; action: PhysicalAction; parameters?: Record<string, number> };

/**
 * 태스크 → 명령. **`scan_mission` 에 전진을 태우지 않는다** (§3).
 *
 * `scan_mission` 은 `forward_m` 으로 스캔과 전진을 한 번에 할 수 있지만, 순서도가 스캔과
 * 접근을 **다른 마일스톤**으로 갈라 놓았다. 명령 하나가 두 마일스톤에 걸치면 어느 노드를
 * 언제 완료로 바꿀지 애매해진다. 태스크 경계와 명령 경계를 맞추는 것이 이 결정의 이유다.
 *
 * 부수 효과로, 스캔이 끝난 뒤 사람이 화면을 보고 접근을 이어 갈 수 있다.
 */
export function commandForTask(taskId: string, geometry: MissionGeometry): TaskCommand | null {
  if (taskId === 'T-A3') {
    // `step_deg` 를 함께 싣는다 (연동 가이드 §4-1). 안 실으면 로봇의 기본값을 쓰게 되고,
    // 그러면 우리가 여덟 칸을 그리는 근거(45도씩)와 로봇이 도는 각이 어긋날 수 있다.
    return {
      taskId,
      action: 'scan_mission',
      // 촬영 뒤 대기를 켠다 (260914) — 화면이 그 각도 그림을 띄운 뒤 `scan_continue` 로 다음 회전을 푼다.
      parameters: {
        steps: geometry.steps, step_deg: geometry.stepDeg, forward_m: 0,
        hold_after_capture: SCAN_HOLD_AFTER_CAPTURE, hold_timeout_s: SCAN_HOLD_TIMEOUT_S,
      },
    };
  }
  // **`T-B2`(이동)는 여기서 명령을 만들지 않는다** (260914 리허설 — 「하드코딩된 경로로 이동」).
  //
  // 전에는 `move_forward { distance_m: 대본의 forward_distance_m }`(4.2m)을 냈다. 탐지 경로가
  // 없어도 로봇의 `door_turn` 만 오면 「경로대로 이동」이 열렸고, 누르면 **방향도 모른 채 4.2m** 를
  // 걸었다 — 리허설에서 두 번 사람이 정지로 끊었다. 이동은 이제 `T-B1`(2D 맵 기반 경로 산출)이
  // 낸 경로로만 나간다(`physical/approachPlan.ts`). 경로가 없으면 안 움직인다.
  return null;
}

/**
 * **산출된 경로를 따라가는 명령들** (260912 지시 — 「전방으로 직진」이 바뀐 자리).
 *
 * 경로 산출이 낸 것은 「얼마나 돌고 얼마나 간다」 둘이다. 앞의 세 태스크(판단·근거·경로
 * 산출)는 **로봇을 안 움직인다** — 보고 판단하는 자리다. 움직이는 것은 여기 하나다.
 *
 * 회전이 먼저다. 돌기 전에 직진하면 엉뚱한 데로 간다.
 *
 * `turn` 은 **오른쪽이 +** 다(연동 가이드 §4-2). 경로 산출은 왼쪽/오른쪽을 문장으로 주고
 * 각도는 절댓값으로 주므로, 왼쪽이면 부호를 뒤집는다.
 */
export function pathCommands(
  turnInstruction: string, turnDegAbs: number, forwardM: number,
): TaskCommand[] {
  const out: TaskCommand[] = [];
  const left = /왼쪽|반시계|counter/i.test(turnInstruction);
  const deg = left ? -Math.abs(turnDegAbs) : Math.abs(turnDegAbs);
  // 5도 미만은 규약이 안 받는다(§4-2 — `deg` 5~360). 그만한 각도는 안 도는 것이 맞다.
  if (Math.abs(deg) >= 5) out.push({ taskId: 'T-B2', action: 'turn', parameters: { deg } });
  // 0.05m 미만도 안 받는다. 이미 다 온 것이다.
  if (forwardM >= 0.05) out.push({ taskId: 'T-B2', action: 'move_forward', parameters: { distance_m: forwardM } });
  return out;
}

/**
 * **`T-A4-3` → 3.** 각도 칸 노드의 이름 규칙.
 *
 * 대본이 이 이름으로 여덟을 두고 `detect/detectTrace.ts` 도 같은 규칙으로 사건을 낸다.
 * 이름을 읽는 자리를 여기 하나로 모아 둔다 — 세 곳에서 따로 쪼개면 하나만 고쳐지는 날이 온다.
 *
 * 규칙에 안 맞으면 null 이다. 각도 칸이 아닌 노드에 각도 로그를 붙이지 않는다.
 */
export function viewpointTaskIndex(taskId: string): number | null {
  const matched = /^T-A4-(\d+)$/.exec(taskId);
  if (matched === null) return null;
  const index = Number(matched[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** 대본 `params` 에서 방향·거리를 읽는다 — 경로 산출이 붙는 자리는 `presets.ts` 하나다. */
export { missionGeometry };

/** 화면이 읽는 한 줄. 무엇이 바뀌었는지만 담고, 어떻게 그릴지는 화면이 정한다. */
export type LinkEffect =
  /**
   * `commandId` 도 같이 싣는다 — **한 태스크가 명령을 두 번 낼 수 있다.** 태스크 이름으로만
   * 찾으면 둘째 응답이 첫째 기록을 덮는다. 노드가 없는 브리지 명령은 셋이 이름 하나를
   * 나눠 쓰므로 그 자리에서는 이름으로 아예 못 가른다.
   */
  | { kind: 'task-running'; taskId: string; commandId: string }
  | { kind: 'task-failed'; taskId: string; commandId: string; code: string | null; message: string | null }
  | { kind: 'task-done'; taskId: string; commandId: string; result: Record<string, number> }
  /**
   * `yawKnown === false` 면 칸만 켜고 방위는 안 적는다 (260914). 0도 칸은 회전 보고 없이 켜질 수
   * 있는데, 그때 옆 걸음의 방위를 빌려 적으면 `door_turn` 견주기와 이동 보정이 둘 다 틀린다.
   */
  | { kind: 'viewpoint'; frame: ViewpointFrame; warning: string | null; yawKnown?: boolean }
  | { kind: 'progress'; ack: number; of: number }
  /**
   * 로봇이 문 쪽으로 몸을 돌렸다. **로봇이 고른 칸이 곧 화면이 고른 칸이다** (260910).
   * `chosenIndex` 가 null 이면 어느 걸음인지 못 짚은 것이고, 그때는 초록을 켜지 않는다.
   */
  | { kind: 'door-turn'; yawDeg: number | null; chosenIndex: number | null }
  /**
   * **출발 방향으로 돌아온 마지막 회전** (260914). 노드가 아니다. 그 방위는 곧 스캔을 시작한
   * 방위이고, 탐지의 회전각이 그 방위 기준이라 이동 명령을 보정할 때 쓴다(`approachPlan.ts`).
   */
  | { kind: 'scan-return'; yawDeg: number | null }
  /**
   * **로봇이 촬영 뒤 서서 기다린다** (260914). 화면이 그 각도 그림을 띄우면 `scan_continue` 를 보낸다
   * (`physical/scanContinue.ts`). 노드가 아니다.
   */
  | { kind: 'scan-hold'; step: number; rotationDeg: number | null; seq: number | null; timeoutS: number | null; note: string }
  | { kind: 'scan-release'; step: number; rotationDeg: number | null; by: string | null; waitedS: number | null }
  | { kind: 'aborted'; note: string }
  /**
   * 임무 ACK 가 아닌 **단계 보고** (연동 가이드 §4-3). `sdk_starting` 이면 로봇이 지금
   * 일어서는 중이다 — 몇 초 동안 아무 일도 안 일어나는 것처럼 보이는 구간이라 화면이
   * 그대로 말해야 한다.
   */
  | { kind: 'stage'; stage: string }
  /**
   * 로봇이 **스스로 걸었다.** 스캔은 돌기만 해야 하는데 끝에 직진이 붙어서 왔다.
   * `forward_m: 0` 을 보냈는데도 온다 — 260910 실측(§ 아래 주석).
   */
  | { kind: 'walked'; taskId: string; note: string };

export type LinkContext = {
  /** 지금 이 command_id 로 쏜 태스크. 응답이 어느 노드의 것인지 이걸로 안다. */
  taskOf(commandId: string): string | null;
  /**
   * 이 판에서 각 걸음이 보고한 방위. `door_turn` 이 어느 걸음이었는지 견주는 데 쓴다.
   * **절대 각도로 고르지 않는다** — 기준점이 움직인다(연동 가이드 §5-3).
   */
  seenYawByIndex: ReadonlyMap<number, number>;
  /** 이미 켜진 칸. 없으면 방위를 본 칸으로 갈음한다. */
  litIndices?: ReadonlySet<number>;
  /** 뷰포인트 칸 수. 대본이 여덟이라고 말한다. */
  viewpointCount: number;
};

/**
 * uplink 하나 → 화면이 할 일들. **하나가 여럿을 낳을 수 있다** — 회전 하나가 노드를
 * 채우면서 진행률도 민다.
 *
 * 여기서 나오는 뷰포인트 프레임은 **`scanning` 까지만** 간다. 문 유무는 대본이 준다(§6).
 */
export function effectsOf(message: UplinkMessage, context: LinkContext): LinkEffect[] {
  const taskId = context.taskOf(message.commandId);

  if (message.kind === 'acceptance') {
    if (!taskId) return [];
    // **거절을 숨기지 마라** (§4). robot_state_dead 가 실제로 나온 응답이고, 로봇을 안
    // 켜면 시연 당일에도 이게 뜬다. 코드와 문구를 그대로 올린다.
    return message.accepted
      ? [{ kind: 'task-running', taskId, commandId: message.commandId }]
      : [{ kind: 'task-failed', taskId, commandId: message.commandId, code: message.code, message: message.message }];
  }

  if (message.kind === 'result') {
    if (!taskId) return [];
    return message.status === 'SUCCEEDED'
      ? [{ kind: 'task-done', taskId, commandId: message.commandId, result: message.result }]
      : [{ kind: 'task-failed', taskId, commandId: message.commandId, code: message.code, message: message.message }];
  }

  // **우리가 낸 명령의 상태만 받는다** (260910 — 실제로 섞였다).
  //
  // uplink 는 토픽 하나라 다른 도구가 쏜 명령의 진행 보고도 같이 들어온다. 그걸 그대로
  // 반영했더니 진행률이 「30 / 10」이 됐다 — 남의 스캔 셋이 우리 여덟 칸을 같이 채운 것이다.
  if (taskId === null) return [];

  // **단계 보고를 안 버린다** (260910). `detail` 은 임무 ACK 만 오는 것이 아니다 — 맨
  // 문자열(`"executing"`)로도 오고, 브리지가 뜨는 동안에는 `sdk_starting` 이 온다.
  // `parseDetail` 은 `step` 을 요구해서 그 둘을 조용히 버린다.
  const stage = stageOf(message.raw);
  if (stage !== null) return [{ kind: 'stage', stage }];

  return statusEffects(message.detail, { ...context, taskId });
}

/** `CommandStatus` 하나가 낳는 것들. `event` 로 갈린다 (§5 ㉡). */
function statusEffects(detail: StatusDetail | null, context: LinkContext & { taskId: string }): LinkEffect[] {
  if (detail === null) return [];
  const effects: LinkEffect[] = [];
  const progress = progressOf(detail);
  if (progress !== null) effects.push({ kind: 'progress', ...progress });

  // **로봇이 스스로 걸었다** (260910 실측 — 시뮬레이터·실물 둘 다).
  //
  // 우리는 `forward_m: 0` 을 보낸다. 스캔은 돌기만 하고, 어디로 갈지는 사람이 초록 칸을
  // 보고 「접근 시작」을 눌러 정하는 것이 이 시연의 요점이기 때문이다. 그런데 결과가
  // 이렇게 돌아온다:
  //
  //     보낸 것   { steps: 8, step_deg: 45, forward_m: 0 }
  //     받은 것   forward … note="ok odo=1.00m cmd=1.00m"
  //     결과      { forward_m: 1, odo_m: 1, … }
  //
  // 0 을 「안 준 것」으로 읽고 기본값 1.0 을 쓰는 것으로 보인다. 우리가 막을 수 있는
  // 자리가 아니다 — 규약에 「직진하지 마라」를 말할 다른 방법이 없다. 그러면 **최소한
  // 화면이 그 사실을 말해야 한다.** 안 그러면 발표자가 「접근 시작」을 눌러 로봇을 한 번
  // 더 걷게 하고, 왜 두 번 가는지 모른다.
  if (detail.event === 'forward') {
    effects.push({ kind: 'walked', taskId: context.taskId, note: detail.note });
    return effects;
  }

  if (detail.event === 'aborted') {
    effects.push({ kind: 'aborted', note: detail.note });
    return effects;
  }

  // 촬영 뒤 대기 · 풀림 (260914). 칸을 켜지 않는다 — 칸은 촬영(/frame)이 켠다.
  if (isScanHold(detail)) {
    effects.push({
      kind: 'scan-hold', step: detail.step, rotationDeg: holdRotationOf(detail),
      seq: detail.seq ?? null, timeoutS: detail.timeout_s ?? null, note: detail.note,
    });
    return effects;
  }
  if (isScanRelease(detail)) {
    effects.push({ kind: 'scan-release', step: detail.step, rotationDeg: holdRotationOf(detail), by: detail.by ?? null, waitedS: detail.waited_s ?? null });
    return effects;
  }

  if (isDoorTurn(detail)) {
    // **새 노드로 만들지 않는다** (§5). 초록 노드에서 「문에 접근한다」로 선이 이어지는
    // 자리가 순서도의 그 지점이고, 이것은 그 선을 활성화하는 계기다.
    effects.push({
      kind: 'door-turn',
      yawDeg: detail.yaw_deg,
      // **로봇이 고른 쪽을 따른다.** 어긋남을 보여 주는 것이 아니라 그것이 답이다.
      chosenIndex: chosenIndexOf(detail, context.seenYawByIndex),
    });
    return effects;
  }

  if (isReturnTurn(detail)) {
    effects.push({ kind: 'scan-return', yawDeg: detail.yaw_deg });
    return effects;
  }

  const index = viewpointIndexOf(detail, context.viewpointCount);
  /**
   * **첫 회전이 왔는데 0도 칸이 아직 안 켜졌으면 0도를 켠다** (260914). 0도는 첫 회전 **전에**
   * 찍힌다 — 보통은 `/frame` 촬영이 먼저 켜지만(`robotBridge.receiveScanCapture`), 촬영 흐름이
   * 없을 때(pi7 전송이 꺼짐 · 로봇 없는 모의) 0도 칸이 영영 대기로 남으면 안 된다. 회전을
   * 0도 칸에 붙이는 것이 아니다 — 「회전1이 시작됐다면 0도는 이미 찍혔다」는 사실만 칠한다.
   */
  const zeroLit = context.litIndices?.has(0) ?? context.seenYawByIndex.has(0);
  if (index === 1 && !zeroLit) {
    effects.push({
      kind: 'viewpoint',
      frame: {
        channel: 'robot_state',
        // 0도의 방위는 이 보고에 없다 — 이것은 회전1 **뒤**의 방위다. 칸만 켜고 방위는 안 적는다.
        payload: { rotation_index: 0, yaw: detail.yaw_deg ?? 0, state: 'rotating', last_cmd: 'scan_mission', result: null },
      },
      warning: null,
      yawKnown: false,
    });
  }
  if (index !== null) {
    effects.push({
      kind: 'viewpoint',
      // **`scanning` 까지만이다.** 로봇은 어느 각도를 보는지만 말하고 거기 문이 있는지는
      // 말해 주지 않는다 (§6). 문 유무는 대본이 준다 — 탐지가 붙으면 그 줄만 바뀐다.
      frame: {
        channel: 'robot_state',
        payload: {
          rotation_index: index,
          yaw: detail.yaw_deg ?? index * 45,
          state: 'rotating',
          last_cmd: 'scan_mission',
          result: null,
        },
      },
      // note != ok 면 그 노드에 경고를 남긴다 (§5 ㉢) — 조용히 정상으로 칠하지 않는다.
      warning: warningOf(detail),
    });
  }
  return effects;
}
