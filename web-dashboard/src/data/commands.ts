/**
 * src/data/commands.ts
 *
 * 명령 발행과 결과 추적 (VZ-O-01 · VZ-O-02 · REQ-903 · REQ-909).
 *
 * 화면은 transport를 직접 부르지 않는다 — 여기를 거친다.
 * 여기가 하는 일은 넷이다.
 *  1. **요청 식별자와 만료 시각을 붙인다.** 상관 키(`command_id`)는 붙이지 않는다 —
 *     그건 백엔드가 명령 조립 단계에서 발급한다(BE-X-01).
 *  2. **두 구간으로 나눠 동작한다.** ACK 전에는 요청 식별자로 낙관적 UI를 걸고,
 *     ACK가 오면 매핑을 저장해 그때부터 상관 키로 결과를 잇는다.
 *  3. 도착하는 `command_result`를 매핑으로 짝지어 **단계 이력**을 만든다.
 *     매핑이 아직 없는 이벤트는 버리지 않고 **보류**했다가 매핑이 오면 흡수한다.
 *  4. 네 단계를 **진행중 · 확정 · 실패 3종**으로 접는다 (REQ-903).
 *
 * **컴포넌트는 키를 다루지 않는다.** 화면에 나가는 것은 "이 요청의 현재 상태" 하나이고,
 * 지금 무엇으로 추적 중인지는 `tracking` 한 필드로 표시용 형태만 넘어간다.
 */

import { getTransport } from '../transport/index.ts';
import type { ActionSpec, CommandRequest, CommandResult } from '../transport/index.ts';
import { GATEWAY } from '../transport/index.ts';
import { buildAuditPayload } from './auditFieldMap.ts';
import { CorrelationRegistry } from './correlation.ts';

/** 명령 유효 시간. 서버의 COMMAND_TTL_MS와 짝을 이룬다. */
export const COMMAND_TTL_MS = 30_000;

export type CommandDisplay = 'in_progress' | 'confirmed' | 'failed';

export const COMMAND_DISPLAY_LABEL: Record<CommandDisplay, string> = {
  in_progress: '진행중',
  confirmed: '확정',
  failed: '실패',
};

/** 서버가 보내는 네 단계. 화면은 3종으로 접지만 이력에는 네 단계가 다 남는다. */
export type CommandStageEntry = {
  stage: CommandResult['stage'] | 'issued' | 'linked' | 'expired';
  status: CommandResult['status'] | 'local';
  detail: string;
  progressPct: number | null;
  reasonCode: string | null;
  ts: string;
  /**
   * 이 단계가 **보류됐다가 흡수된** 이벤트인가.
   * 매핑보다 먼저 도착했다는 뜻이고, 화면이 "이벤트를 잃지 않았다"를 보이는 근거다.
   */
  absorbed?: boolean;
};

/**
 * 화면이 보는 **추적 키 한 개**.
 * 지금 이 요청을 무엇으로 가리키고 있는지를 표시용 형태로만 넘긴다 —
 * 컴포넌트가 키가 둘이라는 사실을 알 필요가 없다.
 */
export type TrackingKey = {
  label: string;
  value: string;
  /** 상관 키까지 이어졌는가. 화면은 이 불리언으로 문구만 고른다. */
  linked: boolean;
};

export type TrackedCommand = {
  /** 화면 목록의 key이자 "이 요청"의 식별자. 내부적으로는 client_request_id다. */
  requestId: string;
  entity: string;
  action: string;
  actionLabel: string;
  irreversible: boolean;
  expiresAt: string;
  /** 발행 시각(로컬). 서버 시각이 아니므로 표시에만 쓰고 판정에 쓰지 않는다. */
  issuedAtLocal: number;
  /** 지금 이 요청을 무엇으로 추적 중인가. */
  tracking: TrackingKey;
  /** 도착한 단계 이력. 마지막 값만 남기면 ACK 단계가 화면에서 사라진다. */
  stages: CommandStageEntry[];
  display: CommandDisplay;
  /** 수행 중 진행률. */
  progressPct: number | null;
  /** 실패 시 이전 상태로 복원됐는가. */
  restored: boolean;
  reasonCode: string | null;
  lastDetail: string;
  /** 매핑보다 먼저 와서 보류했다가 흡수한 이벤트 수. 0이면 순서대로 온 것이다. */
  absorbedCount: number;
  /** 더 이상 변화가 없는 요청인가. 만료·거부·완료·실패. */
  settled: boolean;
};

/** REQ-903 — 5값을 3종으로. 액션별 규칙 없이 상태값만 본다. */
export function toDisplay(status: CommandResult['status']): CommandDisplay {
  if (status === 'completed') return 'confirmed';
  if (status === 'accepted') return 'in_progress';
  return 'failed';
}

export class CommandTracker {
  /** 키는 **client_request_id**다 — 발행 순간에 확실한 유일한 키이기 때문이다. */
  private readonly commands = new Map<string, TrackedCommand>();
  /** 두 키의 매핑과 보류함. 이 추적기 밖으로 새지 않는다. */
  private readonly correlation = new CorrelationRegistry<CommandResult>();
  private readonly listeners = new Set<() => void>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snapshot: readonly TrackedCommand[] = [];
  private seq = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly TrackedCommand[] => this.snapshot;

  /** 매핑·보류 계측값. 화면 하단 배지가 "이벤트를 잃지 않았다"를 숫자로 보인다. */
  correlationStats = () => this.correlation.stats();

  private commit(): void {
    // 최신 명령이 위로. 명령은 몇 건 안 되므로 매번 정렬해도 무해하다.
    this.snapshot = [...this.commands.values()].sort((a, b) => b.issuedAtLocal - a.issuedAtLocal);
    for (const l of this.listeners) l();
  }

  /**
   * 명령 발행.
   *
   * `expires_at`은 여기서 붙이지만 **검사는 서버가 서버 시각으로 한다.**
   * 클라이언트가 만료를 판단하면 사용자 PC 시계에 의존하게 된다. 아래 만료 타이머는
   * 명령의 유효성을 판정하는 것이 아니라 **ACK를 언제까지 기다릴지**를 정하는 것이다.
   */
  async issue(
    entity: string,
    spec: ActionSpec,
    options: { ttlMs?: number; inputMode?: 'click' | 'voice' | 'api' | 'keyboard' } = {},
  ): Promise<TrackedCommand> {
    this.seq += 1;
    // 상관 키가 아니다. 접두사를 다르게 둬서 로그에서 섞이지 않게 한다.
    const requestId = 'req-' + Date.now().toString(36) + '-' + String(this.seq).padStart(2, '0');
    const ttl = options.ttlMs ?? COMMAND_TTL_MS;
    const expiresAt = new Date(Date.now() + ttl).toISOString();

    const request: CommandRequest = {
      client_request_id: requestId,
      entity,
      // 추상 action만 보낸다. 장비 명령으로의 번역은 백엔드 몫이다.
      action: spec.action,
      params: { target_pct: spec.targetPct },
      expires_at: expiresAt,
      // VZ-O-03 — 필드 이름은 auditFieldMap이 만든다. 여기서 이름을 쓰지 않는다.
      audit: buildAuditPayload({
        inputMode: options.inputMode ?? 'click',
        decisionSource: 'human',
      }),
    };

    const tracked: TrackedCommand = {
      requestId,
      entity,
      action: spec.action,
      actionLabel: spec.label,
      irreversible: spec.irreversible,
      expiresAt,
      issuedAtLocal: Date.now(),
      tracking: {
        label: '요청 식별자 (가시화 발급 · ACK 대기)',
        value: requestId,
        linked: false,
      },
      stages: [
        {
          stage: 'issued',
          status: 'local',
          detail: '발행 — 상관 키 도착 전이라 요청 식별자로 화면 상태를 걸었다',
          progressPct: null,
          reasonCode: null,
          ts: new Date().toISOString(),
        },
      ],
      display: 'in_progress',
      progressPct: null,
      restored: false,
      reasonCode: null,
      lastDetail: '발행 — 가시화 → 백엔드 (감사 필드 동봉)',
      absorbedCount: 0,
      settled: false,
    };
    this.commands.set(requestId, tracked);
    // **ACK를 기다리지 않고 지금 알린다.** 이 한 줄이 "발행 직후 버튼 비활성"의 근거다.
    this.commit();

    // ACK 없이 만료되는 경우를 화면이 스스로 정리할 수 있게 한다.
    this.armExpiry(requestId, ttl);

    const ack = await getTransport().publishCommand(request);
    this.applyAck(ack.clientRequestId, ack.commandId, ack.accepted, ack.reasonCode, ack.message);
    return this.commands.get(requestId) ?? tracked;
  }

  /**
   * ACK 반영 — **여기가 두 구간의 경계다.**
   * 상관 키가 실려 왔으면 매핑을 저장하고, 그 매핑을 기다리며 보류돼 있던 이벤트를 흡수한다.
   */
  private applyAck(
    requestId: string,
    commandId: string | null,
    accepted: boolean,
    reasonCode: string | null,
    message: string,
  ): void {
    const tracked = this.commands.get(requestId);
    if (tracked === undefined) return;
    // 이미 만료로 정리된 요청에 늦은 응답이 오면 무시한다 — 화면에 뜬 사유를 덮으면 안 된다.
    if (tracked.settled && commandId === null) return;

    if (commandId === null) {
      // 상관 키를 끝내 받지 못했다. 이 요청은 요청 식별자만으로 정리된다.
      this.settleWithoutCommandId(tracked, reasonCode ?? 'ack_timeout', message);
      return;
    }

    const held = this.correlation.link(requestId, commandId);

    tracked.tracking = {
      label: '상관 키 (백엔드 발급 · BE-X-01)',
      value: commandId,
      linked: true,
    };
    tracked.stages.push({
      stage: 'linked',
      status: 'local',
      detail:
        '수신 확인 — 백엔드가 상관 키를 발급했다. 지금부터 결과·감사는 이 키로 이어진다' +
        (held.length > 0 ? ' (먼저 도착해 보류돼 있던 이벤트 ' + held.length + '건을 흡수)' : ''),
      progressPct: null,
      reasonCode: null,
      ts: new Date().toISOString(),
    });

    if (!accepted && tracked.stages.every((s) => s.status === 'local')) {
      // 접수 거부는 즉답으로 온다. 결과 봉투도 따로 오지만, 그게 늦거나 유실돼도
      // "왜 아무 일도 안 일어났나"가 화면에 남아야 한다.
      tracked.display = 'failed';
      tracked.reasonCode = reasonCode;
      tracked.lastDetail = message;
      tracked.settled = true;
    }

    // 보류돼 있던 이벤트를 **도착 순서대로** 흡수한다.
    for (const result of held) this.absorb(tracked, result, true);

    this.commit();
  }

  /** ACK가 오지 않은 채 만료된 요청의 정리. 지울 상관 키가 없다. */
  private settleWithoutCommandId(tracked: TrackedCommand, reasonCode: string, detail: string): void {
    if (tracked.settled) return;
    tracked.display = 'failed';
    tracked.settled = true;
    tracked.reasonCode = reasonCode;
    tracked.lastDetail = detail;
    tracked.stages.push({
      stage: 'expired',
      status: 'local',
      detail,
      progressPct: null,
      reasonCode,
      ts: new Date().toISOString(),
    });
    this.correlation.forget(tracked.requestId);
    this.commit();
  }

  /**
   * 만료 타이머.
   * 만료 **판정**은 서버가 한다. 이건 "상관 키가 끝내 안 왔을 때 화면을 정리하는" 타이머다 —
   * 이게 없으면 ACK가 유실된 요청이 영원히 '진행중'으로 남아 버튼이 안 풀린다.
   */
  private armExpiry(requestId: string, ttlMs: number): void {
    const timer = setTimeout(() => {
      this.expiryTimers.delete(requestId);
      const tracked = this.commands.get(requestId);
      if (tracked === undefined || tracked.settled) return;
      if (this.correlation.commandIdFor(requestId) !== null) return; // 매핑이 있으면 결과로 정리된다.
      this.settleWithoutCommandId(
        tracked,
        'expired_without_ack',
        'ACK 없이 만료 — 상관 키를 끝내 받지 못해 요청 식별자만으로 정리했다. ' +
          '서버가 실행했는지 여부는 이 화면이 알 수 없다(감사 조회로 확인해야 한다)',
      );
    }, Math.max(0, ttlMs));
    this.expiryTimers.set(requestId, timer);
  }

  /**
   * `command_result` 봉투 반영.
   *
   * 짝지음은 **상관 키로만** 한다. 매핑이 아직 없으면 **버리지 않고 보류**한다 —
   * 목 서버가 순서를 지켜도 실제 백엔드에서는 ACK와 결과가 다른 경로로 흐를 수 있고,
   * 순서를 신뢰하는 코드는 그때 깨진다.
   */
  apply(result: CommandResult): void {
    const requestId = this.correlation.requestIdFor(result.command_id);
    if (requestId === null) {
      this.correlation.hold(result.command_id, result);
      return;
    }

    const tracked = this.commands.get(requestId);
    if (tracked === undefined) return;

    this.absorb(tracked, result, false);
    this.commit();
  }

  /** 단계 하나를 이력에 붙이고 표시 상태를 갱신한다. */
  private absorb(tracked: TrackedCommand, result: CommandResult, wasHeld: boolean): void {
    tracked.stages.push({
      stage: result.stage,
      status: result.status,
      detail: result.detail,
      progressPct: result.progress_pct,
      reasonCode: result.reason_code,
      ts: result.ts,
      absorbed: wasHeld,
    });
    if (wasHeld) tracked.absorbedCount += 1;

    tracked.display = toDisplay(result.status);
    tracked.progressPct = result.progress_pct;
    tracked.reasonCode = result.reason_code;
    tracked.restored = result.restored;
    tracked.lastDetail = result.detail;
    if (result.stage === 'settled') tracked.settled = true;
  }

  latestFor(entity: string): TrackedCommand | null {
    return this.snapshot.find((c) => c.entity === entity) ?? null;
  }

  /**
   * 이 요청의 감사 조회 키 (VZ-I-05).
   * **상관 키다** — 요청부터 감사까지 사슬을 잇는 것이 그 키이기 때문이다.
   * 아직 ACK가 오지 않았으면 null이고, 그때는 조회할 사슬 자체가 없다.
   */
  auditKeyFor(requestId: string): string | null {
    return this.correlation.commandIdFor(requestId);
  }

  clear(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.commands.clear();
    this.correlation.clear();
    this.commit();
  }
}

export const commandTracker = new CommandTracker();

/**
 * 액션 카탈로그 조회.
 * 화면이 액션 어휘를 하드코딩하지 않는다 — 장비가 바뀌어도 화면을 안 고친다는
 * VZ-O-01의 전제가 성립하려면 목록이 밖에서 와야 한다.
 */
export async function fetchActions(entity: string): Promise<ActionSpec[]> {
  try {
    const res = await fetch(GATEWAY.http + '/actions?entity=' + encodeURIComponent(entity));
    if (!res.ok) return [];
    const body = (await res.json()) as { actions?: ActionSpec[] };
    return body.actions ?? [];
  } catch {
    return [];
  }
}
