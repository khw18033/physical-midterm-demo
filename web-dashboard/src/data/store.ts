/**
 * src/data/store.ts
 *
 * 구독 결과를 화면이 쓰는 형태로 보관한다.
 *
 * 지키는 규칙 넷.
 *  1. **상태를 단일 값으로 뭉쳐 저장하지 않는다** (REQ-205). 3층 원본을 그대로 들고 있고
 *     표시값은 읽는 쪽에서 파생시킨다. 뭉쳐 넣는 순간 원천이 섞여 되돌릴 수 없다.
 *  2. 채널별 마지막 봉투를 통째로 보관한다. payload만 꺼내 두면 ts·seq·quality·aggregation이
 *     사라져서 나중에 "이 값이 언제 것인지 / 집약값인지"를 물을 수 없다.
 *  3. 쓰기는 매 수신마다, 알림은 병합 창으로 (MergeScheduler).
 *  4. 레지스트리에만 있고 값이 한 번도 안 온 대상도 **레코드가 존재한다.** 미배포 카드의 근거.
 */

import type { ActuatorState, AiFailure, CommandResult, ControlLock, Envelope, RiskState, StateLayers } from '../transport/index.ts';
import { commandTracker } from './commands.ts';
import type { Plan, PlanSegment } from './plans.ts';
import { normalizeAggregation, type Aggregation } from './aggregation.ts';
import { MergeScheduler } from './mergeScheduler.ts';
import { IMMEDIATE_AVAILABILITY } from './constants.ts';
import type { Registry, RegistryEntity } from './registry.ts';

/** 채널 하나의 마지막 수신 결과. 봉투 메타를 잃지 않는다. */
export type ChannelSlot<T = unknown> = {
  payload: T;
  /** 서버 시각. 화면의 경과 시간 계산은 이 값과 payload의 last_seen으로만 한다. */
  ts: string;
  seq: number;
  quality: Envelope['quality'];
  aggregation: Aggregation;
  scope: Envelope['scope'];
  /**
   * BE-C-04 — 이 값의 좌표 기준계. 좌표를 담지 않는 채널은 null.
   * **읽기 전용이다.** 좌표 변환은 백엔드 단독 책임이므로 화면은 표기만 보여준다.
   */
  coordinateFrame: string | null;
};

export type EntityRecord = {
  id: string;
  /** 레지스트리에서 온 정적 구성. 값이 없어도 이것만으로 카드를 그린다. */
  registry: RegistryEntity | null;
  /** 상태 3층 원본 (REQ-205). 뭉치지 않는다. */
  state: ChannelSlot<StateLayers> | null;
  telemetry: ChannelSlot | null;
  heartbeat: ChannelSlot | null;
  videoMeta: ChannelSlot | null;
  /** 표준 3층과 별개인 액추에이터 도메인 어휘 (VZ-U-01). */
  actuator: ChannelSlot<ActuatorState> | null;
  commandResult: ChannelSlot<CommandResult> | null;
  /** VZ-O-05 — 제어 잠금. 액추에이터 도메인 어휘와 별개로 대상 단위로 온다. */
  controlLock: ChannelSlot<ControlLock> | null;
  /** VZ-U-07 — 계획 본문 + 근거 + 승인 상태. */
  plan: ChannelSlot<Plan> | null;
  /** VZ-U-05 — 구간 진행. 하달·시작·완료·실패 네 시점에만 온다. */
  planProgress: ChannelSlot<{
    plan_id: string;
    command_id: string | null;
    relay_stage?: string;
    segments: PlanSegment[];
  }> | null;
  metrics: ChannelSlot | null;
  /** VZ-I-08 — AI가 판정한 위험 단계와 근거. 화면에서 재계산하지 않는다. */
  riskState: ChannelSlot<RiskState> | null;
  /** VZ-I-10 — 지표 폴링과 분리된 즉시 실패 이벤트의 마지막 수신값. */
  aiFailure: ChannelSlot<AiFailure> | null;
  /** 이 대상에서 받은 총 봉투 수. 계측·디버깅용. */
  envelopeCount: number;
};

function emptyRecord(id: string, registry: RegistryEntity | null): EntityRecord {
  return {
    id,
    registry,
    state: null,
    telemetry: null,
    heartbeat: null,
    videoMeta: null,
    actuator: null,
    commandResult: null,
    controlLock: null,
    plan: null,
    planProgress: null,
    metrics: null,
    riskState: null,
    aiFailure: null,
    envelopeCount: 0,
  };
}

function toSlot<T>(env: Envelope): ChannelSlot<T> {
  return {
    payload: env.payload as T,
    ts: env.ts,
    seq: env.seq,
    quality: env.quality,
    // VZ-C-03 — 여기서 정규화해 두면 아래 코드가 축약형/객체형을 신경 쓰지 않는다.
    aggregation: normalizeAggregation(env.aggregation),
    scope: env.scope,
    coordinateFrame: env.coordinate_frame ?? null,
  };
}

export class DataStore {
  readonly merge = new MergeScheduler();

  private records = new Map<string, EntityRecord>();
  /** useSyncExternalStore가 참조 비교로 변화를 감지하도록 스냅샷을 갈아 끼운다. */
  private snapshot: ReadonlyMap<string, EntityRecord> = this.records;
  private version = 0;
  private dirty = false;

  private registry: Registry | null = null;
  private registryError: string | null = null;

  constructor() {
    // 병합 창이 닫힐 때 스냅샷을 새로 만들어 구독자에게 넘긴다.
    this.merge.subscribe(() => this.commit());
  }

  // ── 레지스트리 ─────────────────────────────────────────────────────────────

  /**
   * 존재해야 할 목록을 먼저 심는다. 값이 한 번도 안 오는 대상(robot-03)도
   * 여기서 레코드가 생기므로 화면에 카드가 나타난다.
   */
  setRegistry(registry: Registry, error: string | null): void {
    this.registry = registry;
    this.registryError = error;
    for (const e of registry.entities) {
      const existing = this.records.get(e.id);
      if (existing) existing.registry = e;
      else this.records.set(e.id, emptyRecord(e.id, e));
    }
    this.dirty = true;
    this.merge.flushNow();
  }

  getRegistry(): Registry | null {
    return this.registry;
  }

  getRegistryError(): string | null {
    return this.registryError;
  }

  // ── 수신 ───────────────────────────────────────────────────────────────────

  /** 봉투 1건 반영. **매 수신마다 호출되며 하나도 버리지 않는다.** */
  apply(env: Envelope): void {
    let rec = this.records.get(env.entity);
    if (!rec) {
      // 레지스트리에 없는데 값이 오는 경우 — 구성 변경 통지를 놓쳤을 수 있다. 일단 받아 둔다.
      rec = emptyRecord(env.entity, null);
      this.records.set(env.entity, rec);
    }
    rec.envelopeCount += 1;

    let immediate = false;

    switch (env.channel) {
      case 'state': {
        const prev = rec.state?.payload.availability ?? null;
        const next = toSlot<StateLayers>(env);
        rec.state = next;
        // 오프라인·판단불가 **전이**는 병합 창을 기다리지 않는다 (VZ-U-01 "오프라인 감지는 즉시").
        const nextAvail = next.payload.availability;
        immediate = nextAvail !== prev && nextAvail !== null && IMMEDIATE_AVAILABILITY.has(nextAvail);
        break;
      }
      case 'telemetry':
        rec.telemetry = toSlot(env);
        break;
      case 'heartbeat':
        rec.heartbeat = toSlot(env);
        break;
      case 'video_meta':
        rec.videoMeta = toSlot(env);
        break;
      case 'actuator_state':
        rec.actuator = toSlot<ActuatorState>(env);
        break;
      case 'command_result': {
        const slot = toSlot<CommandResult>(env);
        rec.commandResult = slot;
        // 명령 추적기에도 넘긴다. store는 채널별 **마지막 값**만 들고 있으므로
        // 네 단계 이력은 여기서 놓치고, 단계 이력이 필요한 쪽은 추적기가 갖는다.
        commandTracker.apply(slot.payload);
        // 결과는 이산 이벤트라 병합 창에 묻히면 안 된다.
        immediate = true;
        break;
      }
      case 'control_lock': {
        const prev = rec.controlLock?.payload.locked ?? null;
        rec.controlLock = toSlot<ControlLock>(env);
        // 잠금 전환이 늦게 보이면 관제사가 실행되지 않는 버튼을 계속 누른다.
        immediate = rec.controlLock.payload.locked !== prev;
        break;
      }
      case 'plan':
        rec.plan = toSlot<Plan>(env);
        // 승인 절차는 사용자가 기다리는 화면이다. 병합 창에 묻히면 클릭이 먹히지 않은 것처럼 보인다.
        immediate = true;
        break;
      case 'plan_progress':
        rec.planProgress = toSlot(env);
        // 구간 전이는 이산 이벤트다 — 네 시점에만 오므로 묶을 이유가 없다.
        immediate = true;
        break;
      case 'metrics':
        rec.metrics = toSlot(env);
        break;
      case 'risk_state':
        rec.riskState = toSlot<RiskState>(env);
        // 단계 전이는 화면 색과 경보를 바꾸므로 병합 창을 기다리지 않는다.
        immediate = true;
        break;
      case 'ai_failure':
        rec.aiFailure = toSlot<AiFailure>(env);
        // 실패는 드문 이산 이벤트다. 15초 지표 질의에 섞지 않고 도착 즉시 알린다.
        immediate = true;
        break;
      case 'video_frame':
      case 'detections':
        // **영상은 store에 넣지 않는다.** 15fps × 프레임마다 스냅샷을 갈면
        // 100ms 병합 창의 의미가 사라지고 상태 화면까지 같이 리렌더된다.
        // 영상 패널이 자기 버퍼로 직접 받아 자기 프레임 루프로 그린다.
        break;
      default:
        break;
    }

    this.dirty = true;
    if (immediate) this.merge.flushNow();
    else this.merge.mark();
  }

  // ── 읽기 ───────────────────────────────────────────────────────────────────

  private commit(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.version += 1;
    // 레코드는 제자리에서 갱신하고 Map만 새로 만든다 —
    // 대상 20개 규모에서 매 창마다 전체를 깊은 복사할 이유가 없다.
    this.snapshot = new Map(this.records);
    for (const l of this.listeners) l();
  }

  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReadonlyMap<string, EntityRecord> => this.snapshot;

  getVersion = (): number => this.version;

  get(id: string): EntityRecord | null {
    return this.snapshot.get(id) ?? null;
  }
}
