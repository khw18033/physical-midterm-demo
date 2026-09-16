// 이식: web-dashboard/mock-gateway/devices.ts @ 700ed91 — 대본 재생(260831)에서 drive()·scripted 추가
//
// 대본(worldTimeline)이 장치의 값을 「몰아 주는」 경로가 더해졌다. 봉투는 여전히
// 장치의 평소 발행 경로(publishNow 등)로 나간다 — 대본이 봉투를 직접 만들면
// seq·ts·quality 규칙이 두 벌이 된다. **대본이 도는 동안 무작위 흔들림은 멈춘다**
// (scripted 플래그) — 랜덤 워크가 대본 값과 싸우면 기록 열이 흔들린다.
/**
 * mock-gateway/devices.ts
 *
 * 가짜 장치들. **각 장치는 요구사항 시트가 정한 실제 주기로 발행한다** —
 * 주기를 실제와 다르게 두면 화면이 "잘 동작하는 것처럼" 보이다가 붙일 때 무너진다.
 * 모든 주기 숫자는 config.ts에서만 온다.
 *
 * 좌표는 **이미 전역 좌표로 변환된 값**을 낸다. 로컬→글로벌 변환과 축 변환은
 * 백엔드 책임이므로(REQ-302) 가시화도, 이 목 서버의 소비자도 변환 로직을 갖지 않는다.
 */

import { AGGREGATION, INTERVALS, METRICS_QUERY } from './config.ts';
import type { Hub } from './hub.ts';
import type { ActuatorState, AggregationSpec } from './protocol.ts';
import type { CommandEngine } from './commands.ts';

/**
 * 주기가 도중에 바뀔 수 있는 루프. setInterval 대신 재무장 setTimeout을 쓴다.
 *
 * **기동 즉시 1회 발행한다.** 첫 주기를 기다리면 평시 1분 센서는 서버가 뜬 뒤 1분 동안
 * 마지막 값 캐시가 비어 있고, 그 사이에 구독한 화면은 VZ-I-02의 즉시 스냅샷을 받지 못한다.
 * 실제 장치도 부팅하면 곧바로 자기 상태를 보고하므로 이쪽이 현실에도 맞다.
 */
type Loop = {
  stop(): void;
  /**
   * 주기가 바뀌었을 때 **이미 무장된 타이머를 다시 건다.**
   * 이게 없으면 평시 1분으로 무장된 센서가 이벤트 모드로 바뀌어도 다음 발행은
   * 여전히 1분 뒤라, 급변 대응 주기 상향(HW-S-03)이 이름만 남는다.
   */
  rearm(): void;
};

function looping(getDelayMs: () => number, fn: () => void): Loop {
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      fn();
      arm();
    }, getDelayMs());
  };
  fn();
  arm();
  return {
    stop: () => clearTimeout(timer),
    rearm: () => {
      clearTimeout(timer);
      arm();
    },
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────────────────────────────────────
// 로봇 (HW-R-02 · HW-R-03)
// ─────────────────────────────────────────────────────────────────────────────

export class RobotDevice {
  /** 임무 중이면 50ms, 대기면 5초. */
  mission: boolean;
  private battery: number;
  private phase = 0;
  private readonly hub: Hub;
  readonly id: string;
  /** 대본이 몰아 주는 값. null 이면 평소(원 궤도 랜덤 워크). */
  private driven: { x: number; y: number; z: number; speed: number; moving: boolean } | null = null;

  constructor(
    hub: Hub,
    id: string,
    opts: { mission: boolean; battery: number; deviceStatus: 'ok' | 'fault' },
  ) {
    this.hub = hub;
    this.id = id;
    this.mission = opts.mission;
    this.battery = opts.battery;
    const rt = this.hub.runtime.get(id);
    if (rt) rt.deviceStatus = opts.deviceStatus;
    if (opts.deviceStatus === 'fault') {
      const r = this.hub.runtime.get(id);
      if (r) r.note = '구동부 응답 없음 — 기기 자기보고 fault';
    }
  }

  private telemetryDelay = (): number =>
    this.mission ? INTERVALS.ROBOT_MISSION_MS : INTERVALS.ROBOT_IDLE_MS;

  private emitTelemetry(): void {
    const rt = this.hub.runtime.get(this.id);
    const faulted = rt?.deviceStatus === 'fault';

    // 대본 구동 중 — 몰아 준 값을 평소 경로 그대로 발행한다. 랜덤 워크는 멈춘다.
    if (this.driven !== null) {
      const d = this.driven;
      if (d.moving) this.battery = Math.max(0, this.battery - 0.0006);
      this.hub.publish(this.id, 'telemetry', {
        position: { x: d.x, y: d.y, z: d.z, frame: 'site-global' },
        battery_pct: round(this.battery, 1),
        velocity: { linear_mps: d.speed, angular_rps: 0 },
        is_moving: d.moving,
        mission: null,
      }, {
        quality: faulted ? 'degraded' : 'good',
        coordinateFrame: 'site-global',
      });
      return;
    }

    const moving = this.mission && !faulted;

    if (moving) {
      this.phase += 0.02;
      this.battery = Math.max(0, this.battery - 0.0006);
    }

    // 이미 전역 좌표로 변환된 값 (REQ-302 — 변환은 백엔드 책임).
    const payload = {
      position: {
        x: round(12 + 6 * Math.cos(this.phase), 3),
        y: 0,
        z: round(-4.5 + 6 * Math.sin(this.phase), 3),
        frame: 'site-global',
      },
      battery_pct: round(this.battery, 1),
      velocity: { linear_mps: moving ? round(0.9 + 0.1 * Math.sin(this.phase * 3), 2) : 0, angular_rps: moving ? 0.2 : 0 },
      is_moving: moving,
      mission: this.mission ? { id: 'msn-503-01', segment: 3, segment_total: 7 } : null,
    };

    this.hub.publish(this.id, 'telemetry', payload, {
      quality: faulted ? 'degraded' : 'good',
      // BE-C-04 — 변환은 백엔드가 이미 끝냈고 봉투에 기준계만 표기해 보낸다.
      // 화면은 이 표기를 읽어 표시할 뿐 변환하지 않는다.
      coordinateFrame: 'site-global',
    });
  }

  /**
   * 대본 구동 (worldTimeline). 값을 채워 즉시 발행하고, 다음 구동까지 평소 주기로
   * 마지막 값을 유지 발행한다. 보간하지 않는다 — 파일에 없는 값을 지어내지 않는다.
   */
  drive(values: Record<string, unknown>): void {
    const pos = values.position as { x?: number; y?: number; z?: number } | undefined;
    const prev = this.driven;
    this.driven = {
      x: pos?.x ?? prev?.x ?? 12,
      y: pos?.y ?? prev?.y ?? 0,
      z: pos?.z ?? prev?.z ?? -4.5,
      speed: typeof values.speed_mps === 'number' ? values.speed_mps : prev?.speed ?? 0,
      moving: typeof values.is_moving === 'boolean' ? values.is_moving : prev?.moving ?? false,
    };
    this.emitTelemetry();
  }

  /** 대본 종료·닫기 — 평소 랜덤 워크로 복귀한다. */
  endScript(): void {
    this.driven = null;
  }

  /** 대기 중에만 1초 하트비트. 임무 중에는 50ms 상태 발행이 생존 신호를 겸한다. */
  private emitHeartbeat(): void {
    if (this.mission) return;
    this.hub.publish(this.id, 'heartbeat', { uptime_s: Math.round(process.uptime()), rssi_dbm: -58 });
  }

  start(): Loop[] {
    return [
      looping(this.telemetryDelay, () => this.emitTelemetry()),
      looping(() => INTERVALS.ROBOT_HEARTBEAT_IDLE_MS, () => this.emitHeartbeat()),
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 센서 (HW-S-02 · HW-S-03 · HW-S-05)
// ─────────────────────────────────────────────────────────────────────────────

export class SensorDevice {
  private level: number;
  private flow: number;
  /** 이벤트 모드(1초 상향)가 끝나는 서버 시각. 평시에는 0. */
  private eventModeUntilMs = 0;
  /** 시나리오가 연결을 끊은 동안은 아무것도 발행하지 않는다. */
  silent = false;
  /** 대본 구동 중 — 랜덤 워크를 멈추고 몰아 준 값을 유지 발행한다. */
  scripted = false;
  private readonly hub: Hub;
  readonly id: string;
  private loop: Loop | null = null;

  constructor(hub: Hub, id: string, opts: { level: number; flow: number }) {
    this.hub = hub;
    this.id = id;
    this.level = opts.level;
    this.flow = opts.flow;
    const rt = this.hub.runtime.get(id);
    if (rt) rt.deviceStatus = 'ok';
  }

  get eventMode(): boolean {
    return Date.now() < this.eventModeUntilMs;
  }

  private delay = (): number =>
    this.eventMode ? INTERVALS.SENSOR_EVENT_MS : INTERVALS.SENSOR_NORMAL_MS;

  private emit(): void {
    if (this.silent) return;
    // 대본 구동 중에는 랜덤 워크가 대본 값과 싸우면 안 된다 — 마지막 구동 값을 유지 발행.
    if (this.scripted) {
      this.publishNow();
      return;
    }
    if (this.eventMode) {
      this.level = round(this.level + (Math.random() - 0.35) * 0.05, 3);
      this.flow = round(Math.max(0, this.flow + (Math.random() - 0.4) * 0.1), 3);
    } else {
      this.level = round(this.level + (Math.random() - 0.5) * 0.01, 3);
      this.flow = round(Math.max(0, this.flow + (Math.random() - 0.5) * 0.02), 3);
    }
    this.publishNow();
  }

  private publishNow(): void {
    this.hub.publish(this.id, 'telemetry', {
      water_level: { value: this.level, unit: 'meter' },
      flow_velocity: { value: this.flow, unit: 'meter_per_second' },
      // 평시 1분 / 이벤트 1초 — 화면이 "왜 이 값이 자주 오는가"를 설명할 수 있어야 한다.
      report_mode: this.eventMode ? 'event' : 'normal',
      report_interval_ms: this.delay(),
    });
  }

  /**
   * 대본 구동 (worldTimeline). 값을 넣고 즉시 발행한다 (HW-S-02 「급변 시 즉시」와 같은 길).
   * 수위가 한 구동에 0.04 m 이상 움직이면 급변으로 보고 이벤트 모드(1초)로 상향한다 —
   * 3편에서 report_mode 가 event 로 바뀌는 것이 이 규칙이다.
   */
  drive(values: Record<string, unknown>): void {
    this.scripted = true;
    const prevLevel = this.level;
    if (typeof values.water_level_m === 'number') this.level = round(values.water_level_m, 3);
    if (typeof values.flow_mps === 'number') this.flow = round(values.flow_mps, 3);
    if (Math.abs(this.level - prevLevel) >= 0.04) {
      this.eventModeUntilMs = Date.now() + INTERVALS.SENSOR_EVENT_HOLD_MS;
      this.loop?.rearm();
    }
    this.publishNow();
  }

  /** 대본 종료·닫기 — 현재 값에서 평소 랜덤 워크로 복귀한다. */
  endScript(): void {
    this.scripted = false;
  }

  /**
   * 임계 초과·급변 — **주기를 기다리지 않고 즉시 발행**하고 이벤트 모드(1초)로 전환한다 (HW-S-02/03).
   * 평시 1분을 기다렸다면 골든타임 대응 화면이 성립하지 않는다.
   */
  surge(deltaM: number): void {
    this.level = round(this.level + deltaM, 3);
    this.flow = round(this.flow + deltaM * 0.8, 3);
    this.eventModeUntilMs = Date.now() + INTERVALS.SENSOR_EVENT_HOLD_MS;
    this.publishNow();
    // 평시 1분으로 무장된 타이머를 이벤트 주기(1초)로 다시 건다.
    this.loop?.rearm();
  }

  private emitHeartbeat(): void {
    if (this.silent) return;
    this.hub.publish(this.id, 'heartbeat', { uptime_s: Math.round(process.uptime()), rssi_dbm: -71 });
  }

  start(): Loop[] {
    this.loop = looping(this.delay, () => this.emit());
    return [this.loop, looping(() => INTERVALS.SENSOR_HEARTBEAT_MS, () => this.emitHeartbeat())];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 카메라 (HW-S-06) — 15fps 메타데이터만. 영상 스트림은 이번 범위 밖.
// ─────────────────────────────────────────────────────────────────────────────

export class CameraDevice {
  private frame = 0;
  silent = false;
  private readonly hub: Hub;
  readonly id: string;

  constructor(hub: Hub, id: string) {
    this.hub = hub;
    this.id = id;
    const rt = this.hub.runtime.get(id);
    if (rt) rt.deviceStatus = 'ok';
  }

  private emit(): void {
    if (this.silent) return;
    this.frame += 1;
    this.hub.publish(this.id, 'video_meta', {
      frame_seq: this.frame,
      fps: 15,
      resolution: { width: 1920, height: 1080 },
      // 프레임 참조 형식은 미확정(AI↔하드웨어 시트 공백)이므로 값만 흉내 낸다. 정합은 범위 밖.
      frame_ref: this.id + ':' + this.frame,
      encoding: 'h264',
    });
  }

  start(): Loop[] {
    return [looping(() => INTERVALS.CAMERA_META_MS, () => this.emit())];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 액추에이터 (HW-A-01 · HW-A-04) — 표준 3층과 별개인 도메인 어휘
// ─────────────────────────────────────────────────────────────────────────────

export class ActuatorDevice {
  private readonly hub: Hub;
  readonly id: string;
  private engine: CommandEngine | null = null;
  private loop: Loop | null = null;

  constructor(hub: Hub, id: string) {
    this.hub = hub;
    this.id = id;
    const rt = this.hub.runtime.get(id);
    if (rt) rt.deviceStatus = 'ok';
  }

  /**
   * 명령 수행은 CommandEngine이 소유한다. 장치는 **자기 상태를 보고할 뿐**이다.
   * 둘을 한 클래스에 두면 "장치 상태 100ms"와 "명령 진행 200ms"가 섞여
   * 어느 주기가 무엇을 위한 것인지 코드에서 읽히지 않는다.
   */
  attach(engine: CommandEngine): void {
    this.engine = engine;
  }

  private delay = (): number =>
    this.engine?.isBusy(this.id) ? INTERVALS.ACTUATOR_MOVING_MS : INTERVALS.ACTUATOR_IDLE_MS;

  private snapshot(): ActuatorState {
    const engine = this.engine;
    const lock = engine?.getLock(this.id) ?? null;
    const busy = engine?.isBusy(this.id) ?? false;

    // 잠긴 동안은 실제 상태를 확인할 수 없으므로 '확인 불가'다.
    // 도메인 어휘(대기·동작 중·완료·오류·확인 불가)는 표준 3층과 별개다.
    const phase: ActuatorState['phase'] = lock?.locked ? 'unverified' : busy ? 'moving' : 'idle';

    return {
      phase,
      progress_pct: null,
      position_pct: engine ? round(engine.getPositionPct(this.id), 1) : null,
      control_locked: lock?.locked ?? false,
      lock_reason: lock?.reason ?? null,
      // BE-X-01 — 이 상태를 유발한 명령의 상관 키. **백엔드(이 엔진)가 발급한 키**이지
      // 브라우저가 붙인 요청 식별자가 아니다.
      command_id: engine?.activeCommandId(this.id) ?? null,
    };
  }

  /**
   * 대기 1초 <-> 동작 중 100ms 전환. 엔진이 명령 시작·종료 시점에 불러 준다.
   * 루프 콜백 안에서 rearm을 부르면 이미 재무장을 예약한 타이머와 겹쳐
   * 매 틱마다 타이머가 배로 늘어난다 — 그래서 밖에서 부른다.
   */
  rearm(): void {
    this.loop?.rearm();
  }

  start(): Loop[] {
    this.loop = looping(this.delay, () => this.hub.publish(this.id, 'actuator_state', this.snapshot()));
    return [this.loop];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 관측 지표 (BE-S-03 · BE-S-06 · VZ-C-03) — **평시에 올라오는 것은 구역 요약이다**
//
// 이 클래스는 두 가지를 동시에 흉내 낸다.
//  1. **엣지가 로컬 보관하는 raw** — 1초 간격으로 자기 안에만 쌓는다. 발행하지 않는다.
//  2. **백엔드가 15초마다 당겨가는 구역 요약** — raw 창을 평균 내 metrics 채널로 발행한다.
//
// 평시 지표를 raw로 내려보내면 "언젠가 집약이 서버로 옮겨가면"이라는 미래 가정이 되는데,
// BE-S-03은 이미 그렇게 설계돼 있다. raw는 엣지에 남고 백엔드에는 구역 요약만 올라온다.
// 원본이 필요하면 질의 프록시가 엣지로 중계한다 — 그 경로가 server.ts의 /metrics/query다.
// ─────────────────────────────────────────────────────────────────────────────

export type RawSample = { t: number; value: number };

export class ObservabilityEmitter {
  private sent = 0;
  private failed = 0;
  private readonly hub: Hub;
  readonly id: string;

  /**
   * 엣지 로컬 raw 저장소. **여기 있는 값은 발행되지 않는다.**
   * 질의 프록시가 엣지로 중계해 올 때만 읽힌다(BE-Q-01 → BE-T-05).
   */
  private readonly rawStore = new Map<string, RawSample[]>();
  /** raw 보관 한도(초). 실제 엣지도 보관 기간이 유한하다. */
  private readonly rawWindowSec = 2 * 60 * 60;

  /**
   * **계약 위반 표기 주입** (검증 전용).
   *
   * 필드 이름이 어긋난 생산자나 축약형을 다르게 쓰는 생산자를 흉내 내, 화면의 가드가
   * "모르는 표기"를 원본으로 오인하지 않는지 확인한다. null이면 정상 표기.
   * 실제 계약에는 없는 경로이며 시나리오로만 켠다.
   */
  malformedAggregation: 'unlabeled' | 'odd-string' | null = null;

  constructor(hub: Hub, id: string) {
    this.hub = hub;
    this.id = id;
  }

  /**
   * 합성으로 메워도 되는 지표 — 이 엣지가 스스로 만드는 관측 지표뿐이다.
   * 도메인 계측(수위·로봇 속도·커버리지)은 **지어내지 않는다** (260831) —
   * 값이 실제로 발행된 구간만 저장소에 있고, 없는 구간은 없는 채로 조회된다.
   */
  private readonly syntheticMetrics = new Set(['cpu_pct', 'publish_latency_ms', 'publish_success']);

  syntheticAllowed(metric: string): boolean {
    return this.syntheticMetrics.has(metric);
  }

  /**
   * 도메인 계측 적재 (260831 — 대본 재생). 수위·로봇 속도·커버리지 %가 관측 지표와
   * **같은 엣지 raw 저장소·같은 질의 경로**(/metrics/query · BE-Q-01)로 조회된다.
   * 별도 경로를 만들지 않는다 — 경로가 둘이면 화면이 둘을 배운다.
   */
  recordSample(metric: string, value: number): void {
    this.push(metric, Date.now(), value);
  }

  /** 엣지가 자기 안에만 쌓는 원본 1초 샘플. */
  private sampleRaw(): void {
    const nowMs = Date.now();
    this.push('cpu_pct', nowMs, round(18 + Math.random() * 22, 1));
    this.push('publish_latency_ms', nowMs, round(8 + Math.random() * 14, 1));
    this.push('publish_success', nowMs, 55 + Math.floor(Math.random() * 20));
  }

  private push(metric: string, t: number, value: number): void {
    const series = this.rawStore.get(metric) ?? [];
    series.push({ t, value });
    const cutoff = t - this.rawWindowSec * 1000;
    while (series.length > 0 && series[0].t < cutoff) series.shift();
    this.rawStore.set(metric, series);
  }

  /**
   * 엣지 로컬 raw 조회. **질의 프록시만 부른다.**
   * 저장된 창보다 넓은 범위를 물으면 있는 만큼만 만들어 채운다(시연용 합성).
   */
  readRaw(metric: string, rangeMin: number, maxPoints: number): RawSample[] {
    const nowMs = Date.now();
    const fromMs = nowMs - rangeMin * 60_000;
    const stored = (this.rawStore.get(metric) ?? []).filter((s) => s.t >= fromMs);

    // 도메인 계측(260831)은 있는 만큼만 돌려준다 — 합성으로 메우면 대본이 안 돌던
    // 구간에 없는 수위가 생긴다.
    if (!this.syntheticMetrics.has(metric)) return stored.slice(-maxPoints);

    // 서버가 방금 떴다면 쌓인 raw가 짧다. 화면에서 "원본은 점이 15배 촘촘하다"를 보려면
    // 범위만큼의 점이 있어야 하므로, 없는 구간은 마지막 값 주변으로 합성해 채운다.
    const stepMs = METRICS_QUERY.RAW_POINT_INTERVAL_SEC * 1000;
    const want = Math.min(maxPoints, Math.floor((rangeMin * 60_000) / stepMs));
    if (stored.length >= want) return stored.slice(-want);

    // 합성 구간의 산포를 **실제 표본에서 뽑는다.** 임의의 좁은 폭으로 채우면
    // 그래프 왼쪽(합성)과 오른쪽(실측)이 눈에 띄게 달라져, 없는 사건이 있는 것처럼 보인다.
    const values = stored.map((s) => s.value);
    const lo = values.length > 0 ? Math.min(...values) : 18;
    const hi = values.length > 0 ? Math.max(...values) : 40;
    const filled: RawSample[] = [];
    for (let i = want - 1; i >= stored.length; i -= 1) {
      filled.push({ t: nowMs - i * stepMs, value: round(lo + Math.random() * (hi - lo), 1) });
    }
    return [...filled, ...stored];
  }

  /**
   * 백엔드 페더레이션 pull — 15초 창의 **구역 요약**을 만들어 발행한다.
   * 이 채널로 나가는 값에는 반드시 집약 표기가 붙는다(BE-S-06).
   */
  private emitSummary(): void {
    const windowMs = INTERVALS.OBSERVABILITY_MS;
    const batchSent = 900 + Math.floor(Math.random() * 200);
    const batchFailed = Math.floor(Math.random() * 4);
    this.sent += batchSent;
    this.failed += batchFailed;

    this.hub.publish(
      this.id,
      'metrics',
      {
        cpu_pct: { value: this.summarize('cpu_pct', windowMs, 24), unit: 'percent' },
        publish_success: { value: batchSent, unit: 'count' },
        publish_failure: { value: batchFailed, unit: 'count' },
        publish_latency_ms: { value: this.summarize('publish_latency_ms', windowMs, 14), unit: 'millisecond' },
        totals: { sent: this.sent, failed: this.failed },
        /** 이 요약이 몇 개의 원본 표본에서 나왔는가. 화면이 "요약임"을 설명하는 근거. */
        sample_count: (this.rawStore.get('cpu_pct') ?? []).filter((s) => s.t >= Date.now() - windowMs).length,
      },
      {
        /**
         * VZ-C-03 — 이 값은 **구역 단위로 이미 집약된 요약**이다(BE-S-03).
         * 표기가 없으면 화면이 이 값을 또 평균 내는 재집약 사고가 나고,
         * 그 오류는 화면상으로 드러나지 않아 발견이 늦다.
         */
        aggregation: this.aggregationSpec(),
      },
    );
  }

  /**
   * 발행에 실을 집약 표기.
   *
   * 평시에는 정식 계약값을 낸다. 시나리오가 켜져 있을 때만 **계약 밖 표기**를 낸다 —
   * 그 주입이 여기 한 지점에서만 일어나므로 캐스팅도 여기서 끝난다.
   */
  private aggregationSpec(): AggregationSpec {
    if (this.malformedAggregation === null) return AGGREGATION.ZONE_SUMMARY;

    /**
     * **여기는 계약 위반을 고의로 주입하는 자리다.**
     *
     * AggregationSpec 타입은 정식 계약 그대로 두고 느슨하게 만들지 않는다 —
     * 타입을 넓히면 tsc가 잡아 주던 것을 잃는다. 대신 이 한 줄에서만 캐스팅해
     * "계약 밖 값을 일부러 밀어 넣는 지점"을 코드에서 한눈에 보이게 한다.
     */
    if (this.malformedAggregation === 'unlabeled') {
      // kind/mode 가 없다 — 필드 이름이 어긋난 백엔드를 흉내 낸다.
      return { level: 'zone', window_sec: INTERVALS.OBSERVABILITY_MS / 1000 } as unknown as AggregationSpec;
    }
    // 축약형을 'raw' 아닌 문자열로 쓰는 백엔드를 흉내 낸다.
    return 'aggregated' as unknown as AggregationSpec;
  }

  /**
   * 지금 즉시 요약을 한 번 더 발행한다.
   * 표기를 바꾼 시나리오가 15초를 기다리게 하면 확인이 번거로우므로 곧바로 밀어낸다.
   * 값 자체는 정상 경로와 같다 — 바뀌는 것은 표기뿐이다.
   */
  republish(): void {
    this.emitSummary();
  }

  /** 창 안의 raw를 평균 낸다. **집약은 엣지에서 여기서만 일어난다.** */
  private summarize(metric: string, windowMs: number, fallback: number): number {
    const from = Date.now() - windowMs;
    const samples = (this.rawStore.get(metric) ?? []).filter((s) => s.t >= from);
    if (samples.length === 0) return round(fallback + (Math.random() - 0.5) * 4, 1);
    return round(samples.reduce((a, s) => a + s.value, 0) / samples.length, 1);
  }

  start(): Loop[] {
    return [
      // 엣지 로컬 raw — 1초. **발행하지 않는다.**
      looping(() => METRICS_QUERY.RAW_POINT_INTERVAL_SEC * 1000, () => this.sampleRaw()),
      // 백엔드 페더레이션 pull — 15초. 요약만 올라간다.
      looping(() => INTERVALS.OBSERVABILITY_MS, () => this.emitSummary()),
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 함대 조립
// ─────────────────────────────────────────────────────────────────────────────

export type Fleet = {
  robots: Map<string, RobotDevice>;
  sensors: Map<string, SensorDevice>;
  cameras: Map<string, CameraDevice>;
  actuators: Map<string, ActuatorDevice>;
  /** 엣지 로컬 raw 저장소를 가진 관측 노드. 질의 프록시가 원본을 물으면 여기로 중계된다. */
  observability: Map<string, ObservabilityEmitter>;
  stopAll(): void;
};

export function createFleet(hub: Hub): Fleet {
  const loops: Loop[] = [];

  const robots = new Map<string, RobotDevice>();
  const sensors = new Map<string, SensorDevice>();
  const cameras = new Map<string, CameraDevice>();
  const actuators = new Map<string, ActuatorDevice>();

  // robot-01 — 임무 수행 중(50ms). 렌더 병합을 실측하려면 이 대상이 계속 20Hz여야 한다.
  const r1 = new RobotDevice(hub, 'robot-01', { mission: true, battery: 82, deviceStatus: 'ok' });
  robots.set(r1.id, r1);

  // robot-02 — device_status = fault 로 시작. 연결은 살아 있으므로 availability는 online이다.
  const r2 = new RobotDevice(hub, 'robot-02', { mission: false, battery: 64, deviceStatus: 'fault' });
  robots.set(r2.id, r2);

  // robot-03 — 미배포. **아무것도 발행하지 않는다.** 화면은 레지스트리를 근거로만 그린다.
  const r3 = hub.runtime.get('robot-03');
  if (r3) {
    r3.deployment = 'not_deployed';
    r3.note = '배포되지 않아 값이 오지 않음 — 레지스트리 목록에만 존재';
  }

  const s1 = new SensorDevice(hub, 'sensor-01', { level: 1.42, flow: 0.31 });
  const s2 = new SensorDevice(hub, 'sensor-02', { level: 1.18, flow: 0.27 });
  sensors.set(s1.id, s1);
  sensors.set(s2.id, s2);

  // sensor-04 — 기동 시점부터 연결 두절(LWT 감지). 발행하지 않는다.
  const s4 = hub.runtime.get('sensor-04');
  if (s4) {
    s4.forcedOffline = true;
    s4.note = 'LWT로 연결 단절 감지';
  }

  const c2 = new CameraDevice(hub, 'camera-02');
  cameras.set(c2.id, c2);

  const a1 = new ActuatorDevice(hub, 'actuator-01');
  actuators.set(a1.id, a1);

  // actuator-02 — **zone-504**에 있다. 권한 범위(VZ-C-04)를 화면과 서버 양쪽에서
  // 확인하려면 담당 구역 밖에 실제 제어 대상이 하나 있어야 한다.
  const a2 = new ActuatorDevice(hub, 'actuator-02');
  actuators.set(a2.id, a2);

  const obs = new ObservabilityEmitter(hub, 'edge-node-a');
  const observability = new Map<string, ObservabilityEmitter>([[obs.id, obs]]);

  for (const d of [r1, r2, s1, s2, c2, a1, a2, obs]) loops.push(...d.start());

  // 첫 상태 3층을 즉시 한 번 조합해 캐시에 넣는다 — 첫 구독자가 빈 화면을 보지 않도록.
  // 전이 판정과 사유 문구를 한 곳에서 만들기 위해 publishAllStates가 아니라 sweep으로 낸다.
  hub.sweepAvailability();

  return {
    robots,
    sensors,
    cameras,
    actuators,
    observability,
    stopAll: () => loops.forEach((l) => l.stop()),
  };
}
