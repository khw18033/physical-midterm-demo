// 이식: web-dashboard/src/data/aggregation.ts @ 700ed91 — 무수정 (transport 경로만 조정)
/**
 * src/data/aggregation.ts
 *
 * VZ-C-03 — 집약 계층 경계 표기와 **재집약 차단**.
 *
 * ── 이건 미래 대비가 아니라 현재 상태다
 *
 * 예전에는 "나중에 집약이 서버로 옮겨가면"이라는 가정으로 자리만 열어 뒀다. 그런데
 * `BE-S-03`이 정한 구조에서는 **평시에 이미** 엣지가 raw를 로컬 보관하고 구역 요약만
 * 백엔드로 올라온다. 즉 화면이 평시에 받는 지표는 **이미 집약된 값**이고, `BE-S-06`이
 * 값마다 집약 계층을 표기해 보낸다. 지금부터 그 표기를 읽어야 한다.
 *
 * ── 경고가 아니라 차단이다
 *
 * 재집약 오류는 **화면상으로 드러나지 않는다.** 그래프가 그려지고 숫자가 나오는데
 * 그 숫자가 틀렸을 뿐이다. 콘솔 경고는 아무도 안 보고, 운영 빌드에서는 아예 없다.
 * 그래서 집약값에 집약 연산이 들어오면 **계산 자체를 수행하지 않고** 차단 사실을
 * 기록해 화면이 표시로 대체하게 한다.
 *
 * ── 모르는 표기는 **원본이 아니라 차단**이다
 *
 * 계약이 확정 전이라 두 철자를 다 받지만, **못 읽는 표기를 만났을 때 떨어지는 방향**은
 * 관용의 문제가 아니다. `BE-S-06`이 "값에 집약 계층을 표기해 전달한다"고 정의하므로
 * **표기가 없거나 모르는 형태인 것 자체가 이상 신호**다. 그때 취할 태도는
 * "모르니까 원본이겠지"가 아니라 **"모르니까 계산하지 않는다"** 여야 한다.
 *
 * - 원본으로 떨어뜨리면 → 조용히 통과하고 **숫자가 틀린다.** 한참 뒤 "값이 이상한데?"로 발견된다.
 * - 차단으로 떨어뜨리면 → 계산이 멈추고 **화면에 그 사실이 뜬다.** 통합 첫날에 드러난다.
 *
 * 그래서 mode가 셋이다 — `raw` / `aggregated` / **`unknown`**.
 *
 * 표기 해석도 여기 한 곳에서만 한다 — 컴포넌트는 아래 `aggregationBadge()`가 주는
 * 표시용 형태만 받는다.
 */

import type { WireAggregation } from '../../transport/index.ts';

/**
 * 와이어의 축약형('raw')과 객체형을 하나로 정규화한 형태.
 *
 * `unknown`은 "표기가 없다"가 아니라 **"표기가 있는데 읽을 수 없다"** 이다.
 * 둘은 다르게 다뤄야 한다 — 아래 normalizeAggregation의 `undefined` 분기 참조.
 */
export type Aggregation = {
  mode: 'raw' | 'aggregated' | 'unknown';
  /** 어느 계층에서 집약되었나. 평시 지표는 'zone'. 원본이면 null. */
  level: string | null;
  method: string | null;
  /** 집약 창 크기(초). */
  windowSec: number | null;
  /**
   * **못 읽은 원본 표기.** `unknown`일 때만 채워진다.
   *
   * 무엇을 못 읽었는지 알아야 진단이 된다 — 필드 이름이 어긋난 것인지, 축약형을 다르게
   * 쓴 것인지가 이 문자열 하나로 갈린다. 뱃지 툴팁과 차단 메시지에 그대로 실린다.
   */
  rawSpec: string | null;
};

export const RAW: Aggregation = { mode: 'raw', level: null, method: null, windowSec: null, rawSpec: null };

/** 계층 이름을 사람이 읽는 말로. 계약이 영문 enum이므로 표시용 사전을 여기 둔다. */
const LEVEL_LABEL: Record<string, string> = {
  device: '장치',
  edge: '엣지',
  zone: '구역',
  server: '서버',
};

/** 못 읽은 표기를 진단용 문자열로. `unknown` 경로에서만 부른다. */
function describeWire(wire: unknown): string {
  if (typeof wire === 'string') return JSON.stringify(wire);
  try {
    return JSON.stringify(wire);
  } catch {
    return String(wire);
  }
}

/**
 * 와이어 값 정규화.
 *
 * ※ 정식 계약이 축약형/객체형 중 무엇을 쓸지, 필드 이름을 `kind/level/window_sec`로 할지
 *   `mode/layer/window_ms`로 할지 아직 확정되지 않았으므로 **둘 다 받는다.**
 *   확정되면 이 함수 하나만 좁히면 된다.
 *
 * **모르는 철자를 추측해서 늘리지 않는다.** 세 번째 철자를 넣으면 같은 함정을 하나 더
 * 만드는 것이고, 어차피 못 읽는 값은 아래 `unknown`으로 떨어져 차단된다.
 */
export function normalizeAggregation(wire: WireAggregation | undefined): Aggregation {
  /**
   * **표기 필드가 아예 없는 경우는 raw다.**
   *
   * 상태(state)·명령(command_result)·계획 같은 채널은 집약 개념이 없어 이 필드를 싣지
   * 않는다. 이걸 `unknown`으로 떨어뜨리면 그 채널 전부가 차단에 걸려 현황판과 제어
   * 화면이 망가진다. "필드가 없는 것"과 "필드가 있는데 못 읽는 것"은 다른 사건이다.
   */
  if (wire === undefined) return { ...RAW };

  if (typeof wire === 'string') {
    if (wire === 'raw') return { ...RAW };
    // 축약형인데 'raw'가 아니다 — 계약이 정의하지 않은 문자열이므로 판단할 수 없다.
    return { mode: 'unknown', level: null, method: null, windowSec: null, rawSpec: describeWire(wire) };
  }

  // 객체형. 런타임에는 계약 밖 값이 올 수 있으므로 문자열로 읽어 비교한다.
  const kind = (wire.kind ?? wire.mode) as string | undefined;
  const level = wire.level ?? wire.layer ?? null;
  const method = wire.method ?? null;
  const windowSec = wire.window_sec ?? (wire.window_ms === undefined ? null : Math.round(wire.window_ms / 1000));

  if (kind === 'raw') return { mode: 'raw', level, method, windowSec, rawSpec: null };
  if (kind === 'aggregated') return { mode: 'aggregated', level, method, windowSec, rawSpec: null };

  /**
   * `kind`·`mode` 가 **둘 다 없거나 모르는 값**이다.
   *
   * 계층(`level`)이나 창(`window_sec`)이 실려 있어도 원본/집약 여부를 단정하지 않는다 —
   * 그 추측이 틀리면 이 파일이 막으려던 사고가 그대로 난다. 읽어 낸 부분은 진단에
   * 쓰이도록 남기고, 판정만 유보한다.
   */
  return { mode: 'unknown', level, method, windowSec, rawSpec: describeWire(wire) };
}

export function describeAggregation(a: Aggregation): string {
  if (a.mode === 'raw') return '원본 측정';
  if (a.mode === 'unknown') {
    return '집약 표기 불명' + (a.rawSpec === null ? '' : ' (수신값 ' + a.rawSpec + ')');
  }
  const parts = ['집약값'];
  if (a.level) parts.push((LEVEL_LABEL[a.level] ?? a.level) + ' 계층');
  if (a.method) parts.push(a.method);
  if (a.windowSec) parts.push(a.windowSec + '초 창');
  return parts.join(' · ');
}

/**
 * 화면에 다는 **표시용 표기**.
 *
 * "지금 보는 값이 요약인지 원본인지"가 그래프·카드에 보여야 한다는 것이 요구사항이므로,
 * 컴포넌트가 각자 문자열을 조립하지 않게 여기서 만들어 넘긴다. 컴포넌트는 `short`를
 * 작게 달고 `title`을 툴팁으로 쓰면 된다.
 *
 * **불리언이 아니라 3상태로 답한다.** 두 값으로는 `unknown`을 표현할 수 없고,
 * 불리언으로 두면 호출부가 `false`를 원본으로 읽어 표기 불명이 원본처럼 보인다 —
 * 그게 이 파일이 막으려는 실패 모드 그 자체다.
 */
export type AggregationBadge = {
  /** 뱃지에 들어갈 짧은 표기. 예: "요약 · 구역 · 15초" / "표기 불명". */
  short: string;
  /** 마우스를 올렸을 때의 설명. `unknown`이면 못 읽은 원본 값이 들어 있다. */
  title: string;
  state: 'raw' | 'aggregated' | 'unknown';
};

export function aggregationBadge(a: Aggregation): AggregationBadge {
  if (a.mode === 'raw') {
    return {
      short: '원본',
      title: '원본 측정값이다. 집약 연산을 적용해도 된다.',
      state: 'raw',
    };
  }

  if (a.mode === 'unknown') {
    return {
      short: '표기 불명',
      title:
        '집약 표기를 읽을 수 없어 이 값이 원본인지 집약인지 판단할 수 없다. ' +
        'BE-S-06은 값마다 집약 계층을 표기해 전달한다고 정의하므로, 표기를 못 읽는 것 자체가 ' +
        '계약 불일치 신호다. 판단이 되지 않는 값에는 집약 연산을 적용하지 않는다.' +
        (a.rawSpec === null ? '' : '\n수신한 표기: ' + a.rawSpec),
      state: 'unknown',
    };
  }

  const level = a.level === null ? '계층 미표기' : LEVEL_LABEL[a.level] ?? a.level;
  const window = a.windowSec === null ? '창 미표기' : a.windowSec + '초';
  return {
    short: '요약 · ' + level + ' · ' + window,
    title:
      '이미 ' + describeAggregation(a) + ' 이다. 평시 지표는 엣지가 raw를 보관하고 구역 요약만 ' +
      '올라오므로(BE-S-03) 이 값에 평균·합계를 다시 적용하면 가중치가 무너진다. ' +
      '원본이 필요하면 "원본 보기"로 별도 질의해야 한다.',
    state: 'aggregated',
  };
}

// ── 재집약 차단 ───────────────────────────────────────────────────────────────

/**
 * 왜 막혔는가. **두 갈래가 구분돼야 한다** —
 * 통합 때 "이미 집약된 값이라 막혔다"와 "표기를 못 읽어서 막혔다"는 대응이 다르다.
 * 전자는 원본 질의로 우회하면 되고, 후자는 **계약을 맞춰야** 한다.
 */
export type BlockReason = 'aggregated' | 'unknown';

export const BLOCK_REASON_LABEL: Record<BlockReason, string> = {
  aggregated: '이미 집약된 값',
  unknown: '표기를 읽을 수 없음',
};

export type BlockRecord = {
  at: number;
  context: string;
  operation: string;
  aggregation: Aggregation;
  reason: BlockReason;
  message: string;
};

const blocks: BlockRecord[] = [];
const blockListeners = new Set<() => void>();

/** 차단 이력. 화면이 "계산이 수행되지 않았다"를 **콘솔이 아니라 화면에** 보이는 근거. */
export function getBlockLog(): readonly BlockRecord[] {
  return blocks;
}

export function subscribeBlocks(listener: () => void): () => void {
  blockListeners.add(listener);
  return () => blockListeners.delete(listener);
}

/**
 * **재집약 차단.** 집약 연산을 적용하면 안 되는 값에 그것을 적용하려 하면 여기서 막는다.
 *
 * 막는 대상이 둘이다.
 *  - `aggregated` — 이미 집약된 값. 다시 집약하면 가중치가 무너진다.
 *  - `unknown`    — 표기를 읽을 수 없는 값. **판단이 안 되는 값에 계산하지 않는다.**
 *
 * 개발 모드 여부를 보지 않는다 — 운영에서만 조용히 통과하면 그게 가장 위험한 조합이다.
 * 검사 비용은 필드 하나를 읽는 정도인 반면 재집약 오류는 발견이 늦다.
 *
 * @returns 차단되었는지 여부. 참이면 **호출부는 계산 결과 대신 표시로 대체해야 한다.**
 */
export function blockReaggregation(
  aggregation: Aggregation,
  operation: 'mean' | 'sum' | 'max' | 'min' | 'count',
  context: string,
): boolean {
  if (aggregation.mode === 'raw') return false;

  const reason: BlockReason = aggregation.mode === 'aggregated' ? 'aggregated' : 'unknown';

  const message =
    reason === 'aggregated'
      ? context + ' 의 값은 이미 ' + describeAggregation(aggregation) + ' 인데 여기에 ' + operation +
        ' 을(를) 적용하려 했다. 집약값을 다시 집약하면 가중치가 무너져 실제와 다른 수가 나오므로 ' +
        '계산을 수행하지 않았다. 원본이 필요하면 원본 질의(VZ-I-04)로 받아 계산할 것.'
      : context + ' 의 집약 표기를 읽을 수 없어 원본인지 집약인지 판단할 수 없는데 여기에 ' +
        operation + ' 을(를) 적용하려 했다. 판단이 되지 않는 값에 집약 연산을 적용하지 않는다 — ' +
        '원본으로 가정하고 계산하면 그 값이 실은 집약값일 때 숫자가 조용히 틀린다. ' +
        '생산자의 표기 형식을 계약(BE-S-06)에 맞춰야 한다.' +
        (aggregation.rawSpec === null ? '' : ' 수신한 표기: ' + aggregation.rawSpec);

  blocks.unshift({ at: Date.now(), context, operation, aggregation, reason, message });
  if (blocks.length > 20) blocks.length = 20;
  console.warn('[VZ-C-03 차단 · ' + BLOCK_REASON_LABEL[reason] + '] ' + message);
  for (const l of blockListeners) l();
  return true;
}

/**
 * 검사를 통과한 평균.
 *
 * 화면이 집약 연산을 하려면 **반드시 이 함수를 거치게** 해서 검사를 빠뜨릴 수 없게 만든다.
 * 집약값이나 표기 불명 값이 섞여 들어오면 **계산하지 않고 null을 돌려준다** —
 * 호출부는 null을 받으면 숫자 대신 차단 사유를 표시해야 한다.
 */
export function guardedMean(
  samples: Array<{ value: number; aggregation: Aggregation }>,
  context: string,
): number | null {
  if (samples.length === 0) return null;
  for (const s of samples) {
    if (blockReaggregation(s.aggregation, 'mean', context)) return null;
  }
  return samples.reduce((acc, s) => acc + s.value, 0) / samples.length;
}

export function guardedSum(
  samples: Array<{ value: number; aggregation: Aggregation }>,
  context: string,
): number | null {
  if (samples.length === 0) return null;
  for (const s of samples) {
    if (blockReaggregation(s.aggregation, 'sum', context)) return null;
  }
  return samples.reduce((acc, s) => acc + s.value, 0);
}
