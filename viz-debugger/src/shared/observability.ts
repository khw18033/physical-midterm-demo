/**
 * src/shared/observability.ts
 *
 * **자체 관측** (`VZ-O-04`) — 가시화가 자기 성능을 잰다.
 *
 * 260904 이전에는 11줄이었고 `ClientHealth` 세 필드에 갱신·조회 함수가 있었는데
 * **양쪽 다 부르는 곳이 0**이었다. 계측이 없으니 **논문 측정축 D를 잴 수 없었다.**
 *
 * ## 측정은 우리 것, 발행은 남의 것
 *
 * | | 지금 한다 | 왜 |
 * |---|---|---|
 * | 값을 잰다 | ○ | 축 D의 원자료 |
 * | 화면에 보인다 (devpanel) | ○ | 재는 중인지 사람이 확인해야 한다 |
 * | JSON 으로 내보낸다 | ○ | 논문 측정에 바로 쓴다 |
 * | 관측 스택으로 발행 | ✗ | **상대가 없다.** 「연결 예정」 자리표시다 (`client-metrics-sink`) |
 *
 * `VZ-O-04` 의 「60초 1회 집계 발행」에서 **집계 주기는 지금 지킨다.** 발행 상대가 생기면
 * 같은 창을 그대로 밀어 넣으면 된다.
 *
 * ## `shared/` 에 있는 이유
 *
 * 축 D는 **단독 빌드**에서 재야 한다. 여기가 `tabs/` 에 의존하면 대시보드 데이터 계층이
 * 통째로 딸려 들어와 부하가 섞이고, 그러면 잰 숫자가 무엇의 숫자인지 말할 수 없다.
 * `verify:standalone` 이 그 관문이다.
 *
 * `tabs/data/selfObservability.ts` 와 **다른 물건이다.** 그쪽은 대시보드 데이터 계층의
 * 봉투 지연을 게이트웨이로 POST 하는 이식본이고, 여기는 단독 빌드에서도 도는 축 D 계측이다.
 *
 * ## 계측 자체가 부하다
 *
 * 그래서 규칙 셋을 지킨다.
 *  1. **집계는 60초 1회.** 매 사건마다 계산하지 않는다. 창 안에서는 숫자 몇 개만 더한다.
 *  2. **열 용량은 표본으로 추정한다.** 매번 열 전체를 직렬화하면 계측이 측정 대상을 흔든다.
 *  3. **못 재는 것은 `null` 이다.** 빈칸에 0을 넣지 않는다 — 0은 「쟀는데 0이었다」로 읽힌다.
 *     왜 못 재는지는 `unmeasured()` 가 문장으로 돌려준다.
 */

import { traceEvents, traceStats } from '../data/trace.ts';
import { missionMergeStats } from '../data/scenario.ts';

// ── 연결 건강 (기존 세 필드 — 260904에 부르는 곳이 생겼다) ─────────────────────

export type ClientHealth = { connected: boolean; subscriptions: number; lastError: string | null };

let health: ClientHealth = { connected: false, subscriptions: 0, lastError: null };

export function updateClientHealth(next: Partial<ClientHealth>) {
  health = { ...health, ...next };
}

export function getClientHealth(): ClientHealth {
  return { ...health };
}

// ── 창 하나 ──────────────────────────────────────────────────────────────────

/** `VZ-O-04` 의 집계 주기. 발행 상대가 생겼을 때의 주기와 같은 값이어야 한다. */
export const PERIOD_MS = 60_000;

/** 기술 문서 §5-2 의 임의 시점 복원 목표. 화면이 이 선을 함께 그린다. */
export const FOLD_BUDGET_MS = 16;

/** 창을 몇 개나 들고 있나 — 60개 = 한 시간. 넘으면 오래된 것부터 버린다. */
const MAX_WINDOWS = 60;
/** 창 하나에서 붙드는 접기 표본 상한. 10 Hz 로 60초면 600개다. */
const MAX_FOLD_SAMPLES = 4_000;
/** 용량 추정에 쓰는 표본 수. 열 전체를 직렬화하지 않기 위한 자리다. */
const BYTES_SAMPLE = 24;

export type ObservabilityWindow = {
  index: number;
  startedAt: string;
  endedAt: string;
  periodSec: number;

  /** 축 D 본문 — 기록 발생률 (건/초). */
  traceRatePerSec: number;
  traceAppended: number;
  /** 축 D 「로그 용량」 — 열 길이와 **추정** 바이트. */
  traceLength: number;
  traceBytesEstimate: number;
  traceDuplicates: number;
  traceOutOfOrder: number;

  /** 축 D 「임의 시점 복원 시간」 — 화면이 실제로 접은 것만 센다. */
  foldCount: number;
  foldAvgMs: number | null;
  foldP95Ms: number | null;
  foldMaxMs: number | null;
  /** 표본 상한을 넘겨 못 담은 접기 횟수. 0이 아니면 위 통계는 앞쪽 표본만의 것이다. */
  foldDropped: number;

  /** 추가 지연 — 봉투의 발행 시각에서 화면 도착까지. 게이트웨이가 있을 때만. */
  envelopeCount: number;
  receiveDelayAvgMs: number | null;
  receiveDelayMaxMs: number | null;

  /** 안정성 — 열려 있던 연결이 끊어진 횟수. 연결을 보고하는 쪽이 있을 때만. */
  reconnects: number | null;

  /** 브라우저 메모리. `performance.memory` 가 없으면 null — **지어내지 않는다.** */
  jsHeapUsedMb: number | null;

  /** 알림 병합 (`VZ-I-01`) — 받은 알림 대비 실제로 그린 횟수. */
  notifyMarked: number;
  notifyFlushed: number;
};

// ── 창 안에서 모으는 원자료 ──────────────────────────────────────────────────

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let windowIndex = 0;
let windowStartedAt = Date.now();
let lastTraceLength = 0;
let lastNotifyMarked = 0;
let lastNotifyFlushed = 0;

let foldSamples: number[] = [];
let foldDropped = 0;

let envelopeCount = 0;
let delayTotal = 0;
let delayMax = 0;

let reconnects = 0;
/** 연결을 보고하는 쪽이 한 번이라도 있었나. 없으면 재연결 횟수는 `null`(해당 없음)이다. */
let connectionReported = false;
let lastConnectionState: string | null = null;

const windows: ObservabilityWindow[] = [];

/**
 * **접기 한 번을 재는 자리.** 화면의 접기 호출을 이걸로 감싼다.
 *
 * 감싸는 비용은 시계 두 번(≈수십 ns)이고, 접기는 10 Hz 로 일어난다 — 측정 대상을
 * 흔들지 않는다. 대신 **합성 측정이 아니라 화면이 실제로 한 접기**를 재게 된다.
 * 안내줄(`nowPlaying`) 안의 접기는 세지 않는다 — 축 D가 말하는 것은 화면 상태 복원이다.
 */
export function measureFold<T>(run: () => T): T {
  const started = performance.now();
  const value = run();
  const elapsed = performance.now() - started;
  if (foldSamples.length < MAX_FOLD_SAMPLES) foldSamples.push(elapsed);
  else foldDropped += 1;
  return value;
}

/** 받은 봉투 하나. 통합 빌드의 임무 축 브리지가 부른다. */
export function observeEnvelope(envelope: { ts?: string }): void {
  const sent = envelope.ts === undefined ? Number.NaN : Date.parse(envelope.ts);
  if (!Number.isFinite(sent)) return;
  const delay = Math.max(0, Date.now() - sent);
  envelopeCount += 1;
  delayTotal += delay;
  if (delay > delayMax) delayMax = delay;
}

/**
 * 연결 상태 전이. **열려 있던 것이 끊어진 횟수**를 센다 —
 * `attempt` 는 붙으면 0으로 돌아가므로 누적을 알 수 없다.
 */
export function observeConnection(status: { state: string; lastError?: string | null }): void {
  connectionReported = true;
  if (lastConnectionState === 'open' && status.state !== 'open') reconnects += 1;
  lastConnectionState = status.state;
  updateClientHealth({ connected: status.state === 'open', lastError: status.lastError ?? null });
}

// ── 집계 ─────────────────────────────────────────────────────────────────────

/**
 * 열의 **추정** 바이트. 앞·중간·뒤에서 표본을 떠서 평균 직렬화 길이를 재고 곱한다.
 * 열 전체를 직렬화하면 16 K 건에서 1 MB 넘는 문자열을 60초마다 만들게 된다 —
 * 그것은 계측이 아니라 부하다. 이름이 「추정」인 이유다.
 */
function estimateTraceBytes(): number {
  const events = traceEvents();
  if (events.length === 0) return 0;
  const step = Math.max(1, Math.floor(events.length / BYTES_SAMPLE));
  let sampled = 0;
  let bytes = 0;
  for (let i = 0; i < events.length; i += step) {
    bytes += JSON.stringify(events[i]).length;
    sampled += 1;
  }
  return Math.round((bytes / sampled) * events.length);
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function jsHeapUsedMb(): number | null {
  const perf = performance as unknown as { memory?: { usedJSHeapSize?: number } };
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === 'number' ? Math.round((used / 1024 / 1024) * 10) / 10 : null;
}

/** 지금까지 모인 것으로 창 하나를 만든다. 닫지 않고 **들여다보기만** 한다. */
function buildWindow(endedAtMs: number): ObservabilityWindow {
  const stats = traceStats();
  const merge = missionMergeStats();
  const elapsedSec = Math.max(0.001, (endedAtMs - windowStartedAt) / 1000);
  // 임무가 바뀌면 열이 새로 시작한다 — 그때는 지금 길이가 곧 이 창에서 늘어난 양이다.
  const appended = stats.length >= lastTraceLength ? stats.length - lastTraceLength : stats.length;
  const sorted = [...foldSamples].sort((a, b) => a - b);
  return {
    index: windowIndex,
    startedAt: new Date(windowStartedAt).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    periodSec: Math.round(elapsedSec * 10) / 10,

    traceRatePerSec: Math.round((appended / elapsedSec) * 100) / 100,
    traceAppended: appended,
    traceLength: stats.length,
    traceBytesEstimate: estimateTraceBytes(),
    traceDuplicates: stats.duplicates,
    traceOutOfOrder: stats.outOfOrder,

    foldCount: foldSamples.length,
    foldAvgMs: sorted.length === 0 ? null : round3(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    foldP95Ms: sorted.length === 0 ? null : round3(percentile(sorted, 0.95)),
    foldMaxMs: sorted.length === 0 ? null : round3(sorted[sorted.length - 1]),
    foldDropped,

    envelopeCount,
    receiveDelayAvgMs: envelopeCount === 0 ? null : Math.round(delayTotal / envelopeCount),
    receiveDelayMaxMs: envelopeCount === 0 ? null : Math.round(delayMax),

    reconnects: connectionReported ? reconnects : null,

    jsHeapUsedMb: jsHeapUsedMb(),

    notifyMarked: merge.received - lastNotifyMarked,
    notifyFlushed: merge.flushed - lastNotifyFlushed,
  };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** 창을 닫아 보관하고 원자료를 비운다. 60초마다, 그리고 손으로 부를 수 있다. */
export function closeWindow(): ObservabilityWindow {
  const now = Date.now();
  const done = buildWindow(now);
  windows.push(done);
  while (windows.length > MAX_WINDOWS) windows.shift();

  windowIndex += 1;
  windowStartedAt = now;
  lastTraceLength = done.traceLength;
  // **창에 적힌 값에서 이어 붙인다.** 여기서 카운터를 다시 읽으면 그 사이에 일어난
  // 플러시 한 번이 어느 창에도 안 들어가거나 두 창에 들어간다 — 창 경계에서
  // 「그린 횟수 > 알린 횟수」 같은 말이 안 되는 값이 나온다.
  lastNotifyMarked += done.notifyMarked;
  lastNotifyFlushed += done.notifyFlushed;
  foldSamples = [];
  foldDropped = 0;
  envelopeCount = 0;
  delayTotal = 0;
  delayMax = 0;
  reconnects = 0;
  return done;
}

/** 진행 중인 창. 닫지 않는다 — 화면이 「지금까지」를 보이는 자리다. */
export function currentWindow(): ObservabilityWindow {
  return buildWindow(Date.now());
}

export function closedWindows(): readonly ObservabilityWindow[] {
  return windows;
}

// ── 못 재는 것 ───────────────────────────────────────────────────────────────

export type Unmeasured = { key: string; label: string; why: string };

/**
 * **재는 값과 못 재는 값을 가른다.** 빈칸에 0을 넣지 않기 위한 목록이고, 화면과 JSON 이
 * 같은 목록을 쓴다. 「아직 안 왔다」와 「이 환경에서는 못 잰다」와 「상대가 없다」는
 * 서로 다른 말이고, 셋 다 0이 아니다.
 */
export function unmeasured(): Unmeasured[] {
  const list: Unmeasured[] = [];
  if (jsHeapUsedMb() === null) {
    list.push({
      key: 'jsHeapUsedMb',
      label: '브라우저 메모리',
      why: '이 브라우저가 performance.memory 를 주지 않습니다 (Chromium 계열에만 있습니다). 지어내지 않습니다.',
    });
  }
  if (!connectionReported) {
    list.push({
      key: 'reconnects',
      label: '재연결 횟수',
      why: '연결 상태를 보고하는 쪽이 없습니다 — 게이트웨이에 붙지 않는 단독 빌드에서는 해당 없음입니다.',
    });
  }
  if (envelopeCount === 0 && windows.every((w) => w.envelopeCount === 0)) {
    list.push({
      key: 'receiveDelayMs',
      label: '수신 지연',
      why: '아직 받은 봉투가 없습니다. 게이트웨이가 붙어 임무 축 봉투가 들어오면 잽니다.',
    });
  }
  list.push({
    key: 'publish',
    label: '관측 스택 발행',
    why: '연결 예정 — 발행할 상대(OTLP 수집기)가 아직 없습니다. 집계 주기(60초)는 지금도 지킵니다.',
  });
  return list;
}

// ── 내보내기 ─────────────────────────────────────────────────────────────────

export type ObservabilityReport = {
  generatedAt: string;
  periodSec: number;
  foldBudgetMs: number;
  /** 통합 셸인가 단독 빌드인가. 같은 숫자라도 무엇의 숫자인지가 달라진다. */
  build: 'standalone' | 'integrated';
  clientHealth: ClientHealth;
  unmeasured: Unmeasured[];
  current: ObservabilityWindow;
  windows: readonly ObservabilityWindow[];
};

/**
 * 어느 빌드에서 잰 값인가. **측정축 D는 단독 빌드의 숫자**이므로 파일에 함께 적는다 —
 * 셸이 붙어 있으면 대시보드 데이터 계층의 부하가 섞인 값이다.
 * 셸이 자기 손으로 표시한다(`markIntegratedBuild`) — 여기서 `shell/` 을 볼 수는 없다.
 */
let build: 'standalone' | 'integrated' = 'standalone';

export function markIntegratedBuild(): void {
  build = 'integrated';
}

export function observabilityReport(): ObservabilityReport {
  return {
    generatedAt: new Date().toISOString(),
    periodSec: PERIOD_MS / 1000,
    foldBudgetMs: FOLD_BUDGET_MS,
    build,
    clientHealth: getClientHealth(),
    unmeasured: unmeasured(),
    current: currentWindow(),
    windows: [...windows],
  };
}

/**
 * 집계를 시작한다. 모듈을 부르는 것만으로는 아무것도 돌지 않는다 —
 * Node 에서 규칙만 돌려 보는 검사가 타이머를 켜면 검사가 끝나지 않는다.
 */
export function startObservability(): () => void {
  if (running) return () => undefined;
  running = true;
  windowStartedAt = Date.now();
  lastTraceLength = traceStats().length;
  const merge = missionMergeStats();
  lastNotifyMarked = merge.received;
  lastNotifyFlushed = merge.flushed;
  timer = setInterval(closeWindow, PERIOD_MS);
  // 헤드리스 수집용 — 논문 측정 스크립트가 콘솔에서 그대로 꺼낸다.
  (globalThis as Record<string, unknown>).__vizObservability = observabilityReport;
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    running = false;
  };
}
