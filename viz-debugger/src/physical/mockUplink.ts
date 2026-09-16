/**
 * src/physical/mockUplink.ts (260910 신설 — 하드웨어 연동 §6)
 *
 * **브로커 없이 개발할 수 있어야 한다.** 로봇도 라즈베리파이도 없는 자리에서 화면을
 * 짜려면 uplink 가 흘러야 하고, 그렇다고 화면에 가짜 경로를 따로 두면 진짜가 붙는 날
 * 그 경로만 안 고쳐진다.
 *
 * 그래서 이 목은 **진짜와 같은 바이트를 만든다.** `PhysicalCommandEnvelope` 로 인코딩해서
 * 내보내고, 받는 쪽은 `decodeUplink` 를 그대로 지난다 — 목인지 아닌지 모른다.
 *
 * ## 무엇을 흘리는가 (§6)
 *
 *   · `CommandStatus` 를 1초 + 1초 간격으로 step 1~8 → `of` 는 8
 *   · **`door_turn` 은 없다** (260914 — pi7 에서 걷어 냈다). 옛 pi7 을 흉내 내려면 `legacyDoorTurn`
 *   · **한 번은 `note` 를 `turn_timeout`** — 경고 표시가 실제로 뜨는지 본다
 *   · **`yaw_deg` 가 `null` 인 경우도 한 번** — 모를 수 있다고 하드웨어가 못박았다
 *
 * 문 유무는 여기서 만들지 않는다. 로봇이 안 주는 것을 목이 주면 §6 의 경계가 흐려진다.
 */

import { physical } from './protocol.js';
import type { StatusDetail } from './uplink.ts';

/** 한 걸음. 시각은 대본과 같은 초 단위이고 배속은 부르는 쪽이 정한다. */
export type MockFrame = { atSec: number; payload: Uint8Array };

export type MockOptions = {
  commandId?: string;
  steps?: number;
  /** 경고를 넣을 step (1부터). null 이면 안 넣는다. */
  timeoutAtStep?: number | null;
  /** yaw 를 모르는 step (1부터). null 이면 안 넣는다. */
  unknownYawAtStep?: number | null;
  /** 옛 pi7 처럼 마지막에 `door_turn` 을 붙인다. 그때 `of` 는 steps+1. */
  legacyDoorTurn?: boolean;
  /** `legacyDoorTurn` 일 때 `door_turn` 의 yaw. */
  doorYawDeg?: number;
};

function statusBytes(commandId: string, detail: StatusDetail): Uint8Array {
  return physical.PhysicalCommandEnvelope.encode(
    physical.PhysicalCommandEnvelope.create({
      status: { commandId, state: 'EXECUTING', detail: JSON.stringify(detail) },
    }),
  ).finish();
}

/**
 * 스캔 한 판. **진짜와 같은 바이트**이고 받는 쪽은 목인지 모른다.
 *
 * 1초 회전 + 1초 유지 — 대본 `MSN-260909-01` 의 박자와 같다. 두 축이 다르면 목으로 맞춘
 * 화면이 대본 재생에서 어긋난다.
 */
export function mockScanUplink(options: MockOptions = {}): MockFrame[] {
  const {
    commandId = 'cmd-00000001',
    steps = 8,
    timeoutAtStep = 4,
    unknownYawAtStep = 6,
    legacyDoorTurn = false,
    doorYawDeg = 90,
  } = options;
  // forward_m=0 이면 of 는 스캔 걸음 수다. 옛 pi7 은 door_turn 하나가 더 붙었다.
  const of = legacyDoorTurn ? steps + 1 : steps;
  const frames: MockFrame[] = [];

  for (let step = 1; step <= steps; step += 1) {
    frames.push({
      atSec: (step - 1) * 2,
      payload: statusBytes(commandId, {
        ack: step,
        of,
        // 로봇 원본 카운터. 임무를 넘어 누적되므로 목도 그렇게 만든다 — 화면이 이걸
        // 진행률로 쓰면 「31 / 10」이 되고, 그 실패를 목에서도 재현할 수 있어야 한다.
        ackSeq: 100 + step,
        event: 'scan_turn',
        step,
        steps,
        // **모를 수 있다.** 한 걸음은 null 로 보내 화면이 안 깨지는지 본다.
        yaw_deg: step === unknownYawAtStep ? null : (step - 1) * (360 / steps),
        // **한 번은 경고.** 조용히 정상으로 칠하는지 여기서 드러난다.
        note: step === timeoutAtStep ? 'turn_timeout' : 'ok',
      }),
    });
  }

  if (!legacyDoorTurn) return frames;
  // 옛 pi7 의 마지막 ACK — 정해진 방향으로 몸을 돌린다. **탐지 결과가 아니다**(연동 가이드 §5-3).
  frames.push({
    atSec: steps * 2,
    payload: statusBytes(commandId, {
      ack: of, of, ackSeq: 100 + of, event: 'door_turn', step: of, steps, yaw_deg: doorYawDeg, note: 'ok',
    }),
  });
  return frames;
}

/** 받았다 / 거절당했다. 거절은 로봇을 안 켰을 때 실제로 오는 응답이다. */
export function mockAcceptance(commandId: string, accepted: boolean, code = 'robot_state_dead'): Uint8Array {
  return physical.PhysicalCommandEnvelope.encode(
    physical.PhysicalCommandEnvelope.create({
      acceptance: accepted
        ? { commandId, accepted: true }
        : { commandId, accepted: false, rejection: { code, message: '로봇 상태를 읽을 수 없습니다' } },
    }),
  ).finish();
}

/** 끝. `SUCCEEDED` 가 아니면 사유가 붙는다. */
export function mockResult(
  commandId: string,
  status: 'SUCCEEDED' | 'ABORTED' | 'CANCELED' = 'SUCCEEDED',
  result: Record<string, number> = {},
): Uint8Array {
  return physical.PhysicalCommandEnvelope.encode(
    physical.PhysicalCommandEnvelope.create({
      result: {
        commandId,
        status: physical.TerminalStatus[status],
        result,
        ...(status === 'SUCCEEDED' ? {} : { failure: { code: 'forward_timeout', message: '전진이 시간 안에 안 끝났습니다' } }),
      },
    }),
  ).finish();
}

/**
 * 목을 실제로 흘려보낸다. 배속은 대본 재생과 같은 축을 쓰라고 부르는 쪽이 정한다.
 * 되돌려주는 함수를 부르면 멈춘다 — 화면을 떠날 때 타이머가 남으면 안 된다.
 */
export function playMockUplink(
  frames: readonly MockFrame[],
  onPayload: (payload: Uint8Array) => void,
  speed = 1,
): () => void {
  const timers = frames.map((frame) =>
    setTimeout(() => onPayload(frame.payload), Math.max(0, (frame.atSec * 1000) / speed)),
  );
  return () => { for (const timer of timers) clearTimeout(timer); };
}
