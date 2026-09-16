/**
 * src/physical/uplink.ts (260910 신설 — 하드웨어 연동 §4 · §5)
 *
 * **로봇이 보내온 봉투를 화면이 읽는 모양으로 바꾸는 자리.**
 *
 * 응답 세 종이 모두 uplink 하나로 오고 종류는 `oneof body` 가 구분한다. 여기서 갈라
 * 화면에는 이미 갈라진 것만 넘긴다.
 *
 * ## step 은 1부터, 인덱스는 0부터
 *
 * **이 작업에서 가장 흔하게 날 실수다.** 로봇의 `step` 은 1~8 이고 우리 노드 인덱스는
 * 0~7 이다. `index = step - 1`. 한 칸 밀려도 화면은 그럴싸하게 돌아가서 눈으로는 못 잡는다.
 * 그래서 **변환하는 자리를 이 파일의 함수 하나로 묶었고**(`viewpointIndexOf`),
 * `verify:status-index` 가 그것부터 본다.
 *
 * ## 노드를 채우는 코드는 출처를 모른다
 *
 * `detail` 을 파싱해 인덱스를 내놓는 것이 여기까지이고, 그 인덱스가 로봇에서 왔는지
 * 대본에서 왔는지는 `src/viewpoint/fill.ts` 가 모른다 (260909 §6 과 같은 규칙).
 */

import { physical } from './protocol.js';

/** `CommandStatus.detail` 안의 JSON. 하드웨어가 보내는 그대로다. */
export type StatusDetail = {
  /** **이번 임무의** ACK 순번. 진행률은 이걸 쓴다 (연동 가이드 §5 · 260910 갱신). */
  ack: number;
  of: number;
  /**
   * 로봇 원본 카운터. **진행률에 쓰지 않는다** — 브리지가 사는 동안 누적된다.
   *
   * 예전에는 `ack` 자체가 이렇게 누적돼서 화면이 「31 / 10」을 띄웠다. 하드웨어가
   * `ack` 를 임무별로 돌리고 원본을 이 칸으로 옮겼다. 안 오면 null 이다.
   */
  ackSeq: number | null;
  event: 'scan_turn' | 'door_turn' | 'forward' | 'aborted' | string;
  step: number;
  steps: number;
  /** 그 시점 방위(도). **모를 수 있다 — null 이 정상이다.** 노드를 고르는 데 쓰지 않는다. */
  yaw_deg: number | null;
  note: string;
  /**
   * `scan_hold` · `scan_release` 에만 (260914). `step` 은 촬영 순번(0~7)이고 `rotation_deg` 가 그 각도다.
   * `scan_hold.note` 는 `ok` · `no_frame`(사진을 못 찍음) · `frame_not_confirmed`(전송 알림이 안 옴).
   */
  rotation_deg?: number | null;
  seq?: number | null;
  timeout_s?: number | null;
  /** `scan_release` — `web` · `timeout` · `abort`. */
  by?: string | null;
  waited_s?: number | null;
};

export type UplinkMessage =
  | { kind: 'acceptance'; commandId: string; accepted: boolean; code: string | null; message: string | null }
  | { kind: 'status'; commandId: string; state: string; detail: StatusDetail | null; raw: string }
  | { kind: 'result'; commandId: string; status: string; result: Record<string, number>; code: string | null; message: string | null };

/**
 * 봉투 하나 → 화면이 읽는 모양. **형식에 안 맞으면 null 이다** — 지어 채우지 않는다.
 * 우리가 안 쓰는 body(취소 응답·Capability)도 null 이다.
 */
export function decodeUplink(payload: Uint8Array): UplinkMessage | null {
  let envelope;
  try {
    envelope = physical.PhysicalCommandEnvelope.decode(payload);
  } catch {
    return null;
  }
  if (envelope.acceptance) {
    const a = envelope.acceptance;
    return {
      kind: 'acceptance',
      commandId: a.commandId ?? '',
      accepted: a.accepted === true,
      // 거절 사유를 **버리지 않는다.** robot_state_dead 가 실제로 나온 응답이고,
      // 로봇을 안 켜면 시연 당일에도 이게 뜬다 (§4).
      code: a.rejection?.code ?? null,
      message: a.rejection?.message ?? null,
    };
  }
  if (envelope.status) {
    const s = envelope.status;
    const raw = s.detail ?? '';
    return { kind: 'status', commandId: s.commandId ?? '', state: s.state ?? '', detail: parseDetail(raw), raw };
  }
  if (envelope.result) {
    const r = envelope.result;
    const names = physical.TerminalStatus;
    const status = Object.keys(names).find((key) => names[key as keyof typeof names] === r.status) ?? 'TERMINAL_STATUS_UNSPECIFIED';
    return {
      kind: 'result',
      commandId: r.commandId ?? '',
      status,
      result: Object.fromEntries(Object.entries(r.result ?? {}).map(([k, v]) => [k, Number(v)])),
      code: r.failure?.code ?? null,
      message: r.failure?.message ?? null,
    };
  }
  return null;
}

/** `detail` 은 JSON 문자열로 온다. 깨져 있으면 null — 그 사실이 화면에 남아야 한다. */
export function parseDetail(raw: string): StatusDetail | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const d = parsed as Record<string, unknown>;
  if (typeof d.step !== 'number' || typeof d.event !== 'string') return null;
  return {
    ack: typeof d.ack === 'number' ? d.ack : 0,
    of: typeof d.of === 'number' ? d.of : 0,
    ackSeq: typeof d.ack_seq === 'number' ? d.ack_seq : null,
    event: d.event,
    step: d.step,
    steps: typeof d.steps === 'number' ? d.steps : 0,
    // **null 이 정상이다.** 모를 수 있다고 하드웨어가 못박았다.
    yaw_deg: typeof d.yaw_deg === 'number' ? d.yaw_deg : null,
    note: typeof d.note === 'string' ? d.note : 'ok',
    ...(d.event === 'scan_hold' || d.event === 'scan_release' ? {
      rotation_deg: typeof d.rotation_deg === 'number' ? d.rotation_deg : null,
      seq: typeof d.seq === 'number' ? d.seq : null,
      timeout_s: typeof d.timeout_s === 'number' ? d.timeout_s : null,
      by: typeof d.by === 'string' ? d.by : null,
      waited_s: typeof d.waited_s === 'number' ? d.waited_s : null,
    } : {}),
  };
}

/** 촬영 뒤 대기 보고인가 (260914). 칸을 켜지 않는다 — 화면이 신호를 보낼 계기다. */
export function isScanHold(detail: StatusDetail | null): boolean {
  return detail?.event === 'scan_hold';
}

export function isScanRelease(detail: StatusDetail | null): boolean {
  return detail?.event === 'scan_release';
}

/** 대기 보고의 각도. 안 실렸으면 촬영 순번 × 간격으로 — 순번은 0부터다. */
export function holdRotationOf(detail: StatusDetail): number | null {
  if (typeof detail.rotation_deg === 'number') return detail.rotation_deg;
  if (detail.steps > 0 && Number.isInteger(detail.step)) return detail.step * (360 / detail.steps);
  return null;
}

/**
 * **회전 걸음(step, 1부터) → 그 회전이 로봇을 데려다 놓은 뷰포인트 노드(0부터).** 변환은 여기 한 곳뿐이다.
 *
 * ## 0도 노드는 회전하지 않는다 (260914 리허설 — 「맨 처음 노드부터 회전한다」)
 *
 * 로봇의 실제 순서는 이렇다(`detection-protocol_0914.md` §4② · 브로커 감시 실측).
 *
 *     scan_start → 0도 촬영 → 회전1 → 45도 촬영 → 회전2 → 90도 촬영 … 회전7 → 315도 촬영 → 회전8(출발 방향으로 복귀)
 *
 * 전에는 `step - 1` 로 옮겨서 **회전1(0→45도)이 0도 노드에 붙었다** — 화면에서 0도 노드가
 * 회전하는 것처럼 보였다. 연동 가이드 §5-2 의 표(「step 1 → index 0」)는 「돌고 나서 본다」던
 * 옛 시뮬레이터 전제였고, 실물은 0도를 돌기 전에 찍는다.
 *
 * 이제 회전 k 는 **k 번 노드**(k·step_deg 도)에 붙는다. 0도 노드는 회전 없이 촬영·탐지만 한다 —
 * 그 칸은 `/frame` 의 0도 촬영이 켠다(`robotBridge.receiveScanCapture`). 마지막 회전(step = count)
 * 은 출발 방향으로 돌아오는 것이라 **어느 노드도 아니다** — `T-A3`(한 바퀴)의 줄로 남는다.
 *
 * `scan_turn` 만 뷰포인트를 건드린다 (§5 ㉡). `door_turn` 은 노드가 아니고, `forward` 는 `T-B2`,
 * `aborted` 는 임무 중단이다. 범위 밖의 step 은 null — 없는 칸을 만들지 않는다.
 */
export function viewpointIndexOf(detail: StatusDetail | null, count = 8): number | null {
  if (detail === null) return null;
  if (detail.event !== 'scan_turn') return null;
  const index = detail.step;
  if (!Number.isInteger(index) || index < 1 || index >= count) return null;
  return index;
}

/** 출발 방향으로 돌아오는 마지막 회전인가 (step = steps). 노드가 아니다 — 방위만 적어 둔다. */
export function isReturnTurn(detail: StatusDetail | null): boolean {
  return detail !== null && detail.event === 'scan_turn' && detail.steps > 0 && detail.step === detail.steps;
}

/**
 * **로봇이 일어서는 중인지 알려 주는 자리** (연동 가이드 §4-3).
 *
 * 구동 브리지는 평시에 내려가 있다 — 기동하는 순간 로봇이 일어서기 때문이다. 이동 명령은
 * 필요하면 스스로 브리지를 띄우고, 그 사이 진행 보고가 두 건 더 온다.
 *
 *     수락 → sdk_starting → sdk_ready → executing → (임무 ACK…) → 종료
 *
 * 가이드가 「`sdk_starting` 이 보이면 로봇이 지금 일어서는 중이다. 화면에 그대로 드러내야
 * 한다」고 못박았다. 몇 초 동안 아무 일도 안 일어나는 것처럼 보이는 구간이라, 안 그리면
 * 발표장에서 「왜 안 가지」가 된다.
 */
export const SDK_STARTING = 'sdk_starting';
export const SDK_READY = 'sdk_ready';

/**
 * 임무 ACK 가 아닌 **단계 보고**를 읽는다. 못 읽으면 null 이다.
 *
 * `detail` 은 한 종류가 아니다. 실측으로 셋을 봤다:
 *
 *     ""                                          빈 것 — 아무 말도 안 한다
 *     "executing"                                 맨 문자열로 온 단계 이름
 *     {"ack":3,"of":10,"event":"scan_turn",…}     임무 ACK (JSON)
 *
 * 그래서 `parseDetail` 하나로 다 받으면 안 된다 — 그것은 `step` 을 요구해서 앞의 둘을
 * **조용히 버린다.** 실제로 `diag` 의 단계 둘이 그렇게 사라졌다. 임무 ACK 인 것은 여기서
 * null 을 돌려주고 `parseDetail` 에게 맡긴다 — 한 봉투가 두 뜻이 되면 안 된다.
 */
export function stageOf(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  // 맨 문자열이면 그것이 단계 이름이다.
  if (!text.startsWith('{')) return text;
  // 임무 ACK 면 단계가 아니다 — 저쪽 함수의 몫이다.
  if (parseDetail(raw) !== null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const event = (parsed as Record<string, unknown>).event;
  return typeof event === 'string' && event !== '' ? event : null;
}

/** 이 단계에서 **로봇이 일어서는 중**인가. */
export function isStanding(stage: string | null): boolean {
  return stage === SDK_STARTING;
}

/** `note` 가 `ok` 가 아니면 경고다. 조용히 정상으로 칠하지 않는다 (§5 ㉢). */
export function warningOf(detail: StatusDetail | null): string | null {
  if (detail === null) return null;
  return detail.note === 'ok' ? null : detail.note;
}

/** 진행률 — `ack/of`. `of` 가 0 이면 모른다는 뜻이라 null 이다. */
export function progressOf(detail: StatusDetail | null): { ack: number; of: number } | null {
  if (detail === null || detail.of <= 0) return null;
  return { ack: detail.ack, of: detail.of };
}

/**
 * `door_turn` 인가 — **마일스톤이 넘어가는 계기다** (§5). 새 노드를 만들지 않는다.
 * 초록 노드에서 「문에 접근한다」로 선이 이어지는 자리가 순서도의 그 지점이다.
 */
export function isDoorTurn(detail: StatusDetail | null): boolean {
  return detail?.event === 'door_turn';
}

/**
 * `door_turn` 이 **돌아선 방향이 몇 번째 걸음인가**.
 *
 * ## 이것은 탐지 결과가 아니다 (연동 가이드 §5-3 · 260910 갱신)
 *
 * 한동안 「로봇이 문으로 판단한 방향」으로 읽고 그렇게 화면에 적었다. **틀렸다.**
 * 하드웨어 쪽이 못박았다 — 문 탐지 기능은 아직 없고, `door_turn` 의 회전 목표는
 * `-step_deg × (steps-1)` 로 **고정된 기하값**이다. 한 바퀴 돈 뒤 왼쪽으로 한 칸
 * 되돌아오는 것뿐이고, 로봇이 방향을 고르는 절차는 존재하지 않는다.
 *
 * 그래서 이 함수가 내놓는 것은 「로봇이 고른 칸」이 아니라 **「로봇이 지금 바라보는 칸」**
 * 이다. 화면 문구도 그렇게 적는다. 문 유무는 탐지 담당이 붙을 때까지 **비어 있는 것이
 * 맞다** — 지어 채우지 않는다.
 *
 * ## 절대 각도로 고르지 않는다
 *
 * 로봇의 `yaw_deg` 는 기준점이 움직인다(연동 가이드 §5-3) — 시뮬레이터는 회차가 이월되고
 * 실물은 출발 자세에 맞춰 재보정된다. 그래서 **그 판의 회전 걸음들이 실제로 보고한 yaw**
 * 와 견준다. 같은 판의 값끼리 견주므로 기준점이 어디든 상관없다.
 *
 * 걸음을 하나도 못 봤으면 null 이다 — 지어 고르지 않는다.
 */
export function chosenIndexOf(
  detail: StatusDetail | null,
  seenYawByIndex: ReadonlyMap<number, number> = new Map(),
): number | null {
  if (detail === null || !isDoorTurn(detail)) return null;
  const seen = seenYawByIndex ?? new Map();

  // **방위로 견준다.** `step` 이 아니라.
  //
  // 실측에서 `door_turn` 의 `step` 은 **늘 1** 이었다:
  //
  //   ack 129 step 8 scan_turn  yaw 180
  //   ack 130 step 1 door_turn  yaw 225   ← 돌아선 곳은 yaw 225 인 7번째 걸음이다
  //
  // 갱신된 가이드는 이제 해당 스캔 걸음 번호를 싣는다고 하지만(기본값이면 늘 7),
  // **방위 견주기는 옛 노드에서도 새 노드에서도 옳다** — yaw 는 돌아선 뒤의 실제 방위라
  // 어느 쪽이든 같은 답을 준다. 그래서 굳이 갈아타지 않는다.
  //
  // 절대 각도를 안 쓰고 **같은 판의 값끼리만** 견주므로 기준점이 움직여도(§5-2) 상관없다.
  if (detail.yaw_deg !== null && seen.size > 0) {
    return closestIndex(seen, detail.yaw_deg);
  }

  // 방위를 모를 때만 걸음 번호를 쓴다 — 그마저 없으면 안 고른다. 회전 k 가 k 번 노드다(260914).
  const byStep = detail.step;
  if (Number.isInteger(byStep) && seen.has(byStep)) return byStep;
  return null;
}

/** 본 방위들 중 가장 가까운 걸음. 각도는 360 으로 감긴다. */
function closestIndex(seen: ReadonlyMap<number, number>, yawDeg: number): number | null {
  let best: number | null = null;
  let closest = Number.POSITIVE_INFINITY;
  for (const [index, yaw] of seen) {
    const raw = Math.abs(yaw - yawDeg) % 360;
    const diff = raw > 180 ? 360 - raw : raw;
    if (diff < closest) { closest = diff; best = index; }
  }
  return best;
}

/**
 * **봉투 하나 → 사람이 읽을 한 줄.** 값은 전부 로봇이 준 것이고, 없는 칸은 **안 적는다**
 * (260912 지시 — 「더미가 아니라 실제로 받은 로그를」).
 *
 * 화면이 문장을 짓지 않게 여기 한 곳에서 만든다. 두 곳에서 만들면 액션 아이템에 적힌
 * 줄과 실패 사유에 적힌 줄이 같은 응답을 다르게 말하는 날이 온다.
 */
export function uplinkWords(message: UplinkMessage): string {
  if (message.kind === 'acceptance') {
    if (message.accepted) return '수락';
    // 거절 사유를 버리지 않는다 — 이것이 실패 사유 자리에 그대로 올라간다.
    return `거절 — ${[message.code, message.message].filter((v) => v !== null && v !== '').join(' ') || '사유 없음'}`;
  }
  if (message.kind === 'result') {
    const values = Object.entries(message.result).map(([key, value]) => `${key}=${value}`).join(' ');
    const why = [message.code, message.message].filter((v) => v !== null && v !== '').join(' ');
    return [message.status, values, why].filter((part) => part !== '').join(' · ');
  }
  const detail = message.detail;
  if (detail === null) {
    // 임무 ACK 가 아니면 단계 보고다 — `sdk_starting` 이 여기로 온다.
    return message.raw.trim() === '' ? message.state : `${message.state} · ${message.raw.trim()}`;
  }
  if (detail.event === 'scan_hold' || detail.event === 'scan_release') {
    const rotation = holdRotationOf(detail);
    return [
      detail.event === 'scan_hold' ? '촬영 뒤 대기' : '대기 풀림',
      detail.event,
      rotation === null ? `촬영 ${detail.step}` : `${rotation}°`,
      detail.event === 'scan_hold' && detail.timeout_s != null ? `최대 ${detail.timeout_s}초` : '',
      detail.by != null ? `by ${detail.by}` : '',
      detail.waited_s != null ? `${detail.waited_s}초 기다림` : '',
      detail.note !== 'ok' && detail.note !== '' ? detail.note : '',
    ].filter((part) => part !== '').join(' · ');
  }
  const parts = [
    `ack ${detail.ack}/${detail.of}`,
    detail.event,
    `step ${detail.step}/${detail.steps}`,
  ];
  // **모를 수 있는 값은 빈칸으로 둔다.** 0 으로 채우면 북쪽을 보고 있다는 거짓이 된다.
  if (detail.yaw_deg !== null) parts.push(`yaw ${detail.yaw_deg}`);
  if (detail.note !== '') parts.push(detail.note);
  return parts.join(' · ');
}
