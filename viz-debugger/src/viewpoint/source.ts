/**
 * src/viewpoint/source.ts (260909 신설 — 시연 대본 §6)
 *
 * **대본과 라이브를 가르는 자리. 여기 한 곳뿐이다.**
 *
 * 이 파일 위로는 대본을 안다(`ScriptScenario.viewpointTimeline` 을 읽는다). 이 파일 아래로는
 * 모른다 — `fill.ts` 가 받는 것은 `ViewpointFrame` 뿐이고, 그것이 대본에서 왔는지
 * 게이트웨이에서 왔는지 묻지 않는다.
 *
 * ## 로봇이 붙는 날 무엇을 하는가
 *
 * `liveFrame()` 을 채널 수신부에 붙이면 끝이다. 노드 갱신 코드(`fill.ts`)도, 화면도
 * 한 줄도 안 고친다 — 그것이 §6 이 요구한 조건이고, 이 파일이 그 조건의 값이다.
 *
 * 지금 라이브 채널은 없다. **그래서 `liveFrame()` 은 형식 검사만 한다** — 없는 소켓을
 * 지어 붙이지 않는다. 붙는 날 그 함수를 부르는 쪽만 생긴다.
 */

import type { DoorDetectionFrame, RobotRotationFrame, ViewpointFrame } from './fill.ts';

/** 대본이 싣는 한 줄. 시각과 채널과 값 — 봉투가 아니라 값이다. */
export type ScriptViewpointEntry = {
  atSec: number;
  channel: string;
  payload: Record<string, unknown>;
};

function isRotation(payload: Record<string, unknown>): payload is RobotRotationFrame & Record<string, unknown> {
  return typeof payload.rotation_index === 'number' && typeof payload.yaw === 'number';
}

function isDetection(payload: Record<string, unknown>): payload is DoorDetectionFrame & Record<string, unknown> {
  return typeof payload.index === 'number' && typeof payload.door === 'boolean';
}

/**
 * 채널 이름과 값에서 프레임 하나. **형식에 안 맞으면 null 이다** — 지어 채우지 않는다.
 * 대본도 라이브도 이 함수를 지나므로, 형식이 어긋나면 양쪽에서 똑같이 걸린다.
 */
export function toFrame(channel: string, payload: Record<string, unknown>): ViewpointFrame | null {
  if (channel === 'robot_state' && isRotation(payload)) {
    return {
      channel: 'robot_state',
      payload: {
        rotation_index: payload.rotation_index,
        yaw: payload.yaw,
        state: typeof payload.state === 'string' ? payload.state : 'unknown',
        last_cmd: typeof payload.last_cmd === 'string' ? payload.last_cmd : null,
        result: typeof payload.result === 'string' ? payload.result : null,
      },
    };
  }
  if (channel === 'detection' && isDetection(payload)) {
    return {
      channel: 'detection',
      payload: {
        index: payload.index,
        angle_deg: typeof payload.angle_deg === 'number' ? payload.angle_deg : payload.index * 45,
        door: payload.door,
        bbox: Array.isArray(payload.bbox) ? (payload.bbox as number[]) : null,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : 0,
        reason: typeof payload.reason === 'string' ? payload.reason : '',
      },
    };
  }
  return null;
}

/**
 * **대본 쪽 입구.** 재생 머리까지 흘러온 프레임을 시각 순으로 준다.
 *
 * 되감기가 성립하려면 「머리까지의 프레임을 처음부터 다시 접는다」여야 한다 — 상태를
 * 들고 있다가 이어 붙이면 슬라이더를 뒤로 끌었을 때 이미 켜진 초록이 안 꺼진다.
 */
export function scriptFrames(
  timeline: readonly ScriptViewpointEntry[] | undefined,
  headSec: number,
): ViewpointFrame[] {
  const frames: ViewpointFrame[] = [];
  if (timeline === undefined) return frames;
  for (const entry of timeline) {
    if (entry.atSec > headSec) continue;
    const frame = toFrame(entry.channel, entry.payload);
    if (frame !== null) frames.push(frame);
  }
  return frames;
}

/**
 * **라이브 쪽 입구.** 채널 봉투 하나에서 프레임 하나.
 *
 * 아직 부르는 곳이 없다 — 로봇·탐지 AI 가 형식 합의 중이다(지시서 「왜 하나」). 붙는 날
 * 수신부가 이 함수를 부르면 그 아래는 전부 그대로 돈다. 지금 없는 소켓을 지어 붙이는 것이
 * 아니라, **붙을 자리를 형식으로 못박아 두는 것**이 이 함수의 일이다.
 */
export function liveFrame(message: { channel: string; payload: Record<string, unknown> }): ViewpointFrame | null {
  return toFrame(message.channel, message.payload);
}
