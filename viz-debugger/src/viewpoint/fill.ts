/**
 * src/viewpoint/fill.ts (260909 신설 — 시연 대본 §4 · §6)
 *
 * **8분할 뷰포인트가 하나씩 채워지는 규칙.** 여기가 대본과 라이브를 가르는 자리 **바로
 * 아래**다 — 이 파일은 대본을 모른다.
 *
 * ## 무엇을 보는가
 *
 * 두 형식만 본다. 실제 로봇·탐지 AI 가 붙는 날 채널이 그대로 이 두 형식으로 오고,
 * 그때 이 파일은 한 줄도 안 고친다 (§6).
 *
 *   로봇 상태 `{ rotation_index, yaw, state, last_cmd, result }`
 *   탐지 결과 `{ index, angle_deg, door, bbox, confidence, reason }`
 *
 * ## rotation_index 가 유일한 열쇠다
 *
 * **yaw 로 노드를 고르지 않는다.** 실제 로봇은 드리프트가 있어서 90도를 명령해도 88.4도가
 * 오고, 각도로 맞추면 어느 노드인지 어긋난다. `rotation_index`(탐지는 `index`)만 본다.
 *
 * **도착 순서로도 고르지 않는다.** 실제 탐지는 268ms 걸리고 순서가 뒤집힐 수 있다 —
 * 인덱스 5의 결과가 인덱스 4보다 먼저 와도 각자 제 노드로 가야 한다. 그래서 상태는
 * 배열이 아니라 **인덱스로 찾는 표**다. `verify:viewpoint-fill` 이 뒤섞어 넣어 확인한다.
 *
 * ## 상태 셋 (§4)
 *
 *   대기      초기            빈 테두리, 흐림
 *   탐색 중   회전 사건 도착   테두리 점멸
 *   판정 완료 탐지 사건 도착   문 없음 회색 / 문 있음 초록
 *
 * 되돌아가지 않는다 — 판정이 끝난 칸에 회전 사건이 늦게 와도 대기로 돌리지 않는다.
 * 늦게 온 회전은 이미 지나간 칸의 것이고, 화면이 뒤로 가면 사용자는 다시 도는 줄 안다.
 */

/** 로봇 상태 채널. 실제 채널이 올 때도 같은 필드다 (§6). */
export type RobotRotationFrame = {
  rotation_index: number;
  yaw: number;
  state: string;
  last_cmd: string | null;
  result: string | null;
};

/** 탐지 결과 채널. 실제 채널이 올 때도 같은 필드다 (§6). */
export type DoorDetectionFrame = {
  index: number;
  angle_deg: number;
  door: boolean;
  bbox: readonly number[] | null;
  confidence: number;
  reason: string;
};

/**
 * 뷰포인트 한 칸의 상태 **넷** (260910 — 셋에서 쪼갰다).
 *
 * 9/9 에는 판정이 끝난 칸을 `judged` 하나로 묶고 문 있음·없음은 화면이 `detection.door` 를
 * 다시 보고 갈랐다. 그래서 「이 칸은 무슨 상태인가」의 답이 두 군데에 있었다. 발표장에서
 * 일곱을 죽이고 하나를 살리려면 그 구분이 **상태 자체**여야 한다.
 *
 * 프레임이 인덱스로 찾아가는 규칙과 사건 형식은 그대로다 — 갈라진 것은 도착한 뒤
 * 이름을 정하는 자리뿐이다.
 */
export type ViewpointPhase = 'pending' | 'scanning' | 'rejected' | 'selected';

/** 판정이 끝난 상태 둘. 여기서 되돌아가지 않는다. */
function isJudged(phase: ViewpointPhase): boolean {
  return phase === 'rejected' || phase === 'selected';
}

/** 뷰포인트 한 칸. 화면이 읽는 것은 이것뿐이다. */
export type ViewpointCell = {
  index: number;
  phase: ViewpointPhase;
  /** 판정 완료일 때만 채워진다. 대기·탐색 중에는 null — 없는 값을 지어내지 않는다. */
  detection: DoorDetectionFrame | null;
  /** 마지막으로 도달한 로봇 상태. 각도는 화면 표기용이고 노드를 고르는 데 쓰지 않는다. */
  rotation: RobotRotationFrame | null;
};

/** 인덱스로 찾는 표. 배열이 아닌 이유가 위 「도착 순서로 고르지 않는다」다. */
export type ViewpointFill = ReadonlyMap<number, ViewpointCell>;

/** 여덟 칸을 전부 대기로 깔아 둔다 — 승인 즉시 여덟이 다 보이되 비어 있어야 한다 (§4). */
export function emptyFill(count: number): ViewpointFill {
  const map = new Map<number, ViewpointCell>();
  for (let i = 0; i < count; i += 1) {
    map.set(i, { index: i, phase: 'pending', detection: null, rotation: null });
  }
  return map;
}

function cellOf(fill: ViewpointFill, index: number): ViewpointCell {
  return fill.get(index) ?? { index, phase: 'pending', detection: null, rotation: null };
}

/**
 * 회전 사건 → 그 칸이 **탐색 중**. 이미 판정이 끝난 칸은 되돌리지 않는다.
 *
 * 표에 없는 인덱스는 **버린다.** 여덟 칸짜리 화면에 인덱스 9가 오면 그것은 이 임무의
 * 사건이 아니고, 없는 칸을 만들어 그리면 화면이 대본보다 커진다.
 */
export function applyRotation(fill: ViewpointFill, frame: RobotRotationFrame): ViewpointFill {
  if (!fill.has(frame.rotation_index)) return fill;
  const cell = cellOf(fill, frame.rotation_index);
  const next = new Map(fill);
  next.set(frame.rotation_index, {
    ...cell,
    phase: isJudged(cell.phase) ? cell.phase : 'scanning',
    rotation: frame,
  });
  return next;
}

/**
 * 탐지 사건 → 그 칸이 **판정 완료**. 회전 사건이 아직 안 왔어도 판정으로 간다 —
 * 순서가 뒤집혀 도착하는 것이 정상이고(268ms), 결과가 왔는데 대기로 두면 거짓말이다.
 */
export function applyDetection(fill: ViewpointFill, frame: DoorDetectionFrame): ViewpointFill {
  if (!fill.has(frame.index)) return fill;
  const cell = cellOf(fill, frame.index);
  const next = new Map(fill);
  // 문이 있으면 **선정**, 없으면 **미선정**. 도착한 값에서 상태 이름이 곧바로 나온다 —
  // 화면이 door 를 다시 보고 갈라내지 않는다.
  next.set(frame.index, { ...cell, phase: frame.door ? 'selected' : 'rejected', detection: frame });
  return next;
}

/**
 * 채널 하나에서 온 프레임. **여기가 두 채널을 가르는 유일한 자리다** (§6) —
 * 대본에서 왔는지 게이트웨이에서 왔는지는 이 타입에 없고, 아래 `applyFrame` 도 묻지 않는다.
 */
export type ViewpointFrame =
  | { channel: 'robot_state'; payload: RobotRotationFrame }
  | { channel: 'detection'; payload: DoorDetectionFrame };

/** 프레임 하나를 반영한다. 채널을 가르는 switch 는 이 함수 하나뿐이다. */
export function applyFrame(fill: ViewpointFill, frame: ViewpointFrame): ViewpointFill {
  if (frame.channel === 'robot_state') return applyRotation(fill, frame.payload);
  return applyDetection(fill, frame.payload);
}

/**
 * 프레임 여럿을 차례로 반영한다. **도착 순서를 정렬하지 않는다** — 각 프레임이 제 인덱스로
 * 찾아가므로 순서가 뒤집혀도 결과가 같아야 하고, 그 성질을 여기서 몰래 고쳐 주면
 * `verify:viewpoint-fill` 의 뒤섞기 검사가 무의미해진다.
 */
export function reduceFrames(fill: ViewpointFill, frames: readonly ViewpointFrame[]): ViewpointFill {
  return frames.reduce(applyFrame, fill);
}

/** 문이 있다고 판정된 칸. 없으면 null — 아직 안 왔거나 여덟 다 문 없음이다. */
export function doorCell(fill: ViewpointFill): ViewpointCell | null {
  for (const cell of fill.values()) {
    if (cell.phase === 'selected') return cell;
  }
  return null;
}

/** 화면이 그릴 차례 — 인덱스 오름차순. 표의 삽입 순서에 화면이 끌려가면 안 된다. */
export function cellsInOrder(fill: ViewpointFill): ViewpointCell[] {
  return [...fill.values()].sort((a, b) => a.index - b.index);
}

/**
 * 뷰포인트 한 칸의 화면 상태 (§4 표). 색을 여기서 정하지 않는다 — 이름만 준다.
 * CSS 가 그 이름으로 테두리·점멸·초록을 붙인다.
 */
export function cellClass(cell: ViewpointCell): string {
  return 'viewpoint--' + cell.phase;
}

/**
 * **지금 보고 있는 칸.** 회전이 지나간 칸 중 가장 나중 것이다.
 *
 * 여덟이 다 지나갔으면 `null` 이다 — 그때는 「지금 보는 칸」이 없고 탐색이 끝난 것이다.
 * 화면이 이걸로 「탐색 중…」과 「탐색 완료」를 가른다. 260910 에 다 돌고 난 뒤에도 여덟이
 * 전부 「탐색 중」이라고 적혀 있었다 — 판정이 오기 전에는 phase 가 `scanning` 에 머무는데,
 * 그 낱말이 「지금 이 칸을 보고 있다」로 읽히기 때문이다.
 */
export function scanHead(fill: ViewpointFill): number | null {
  let head: number | null = null;
  let pending = 0;
  for (const cell of fill.values()) {
    if (cell.phase === 'pending') { pending += 1; continue; }
    if (head === null || cell.index > head) head = cell.index;
  }
  return pending === 0 ? null : head;
}
