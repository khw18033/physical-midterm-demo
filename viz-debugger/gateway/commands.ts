// 이식: web-dashboard/mock-gateway/commands.ts @ 700ed91 — 대본 재생(260831)에서 primeState() 하나 추가
/**
 * mock-gateway/commands.ts
 *
 * 제어 명령 왕복 엔진 (VZ-O-01 · VZ-O-02) + 제어 잠금 (VZ-O-05) + 감사 적재 (VZ-I-05).
 *
 * **명령은 이 파일 안에서만 왕복한다.** 실제 디바이스로 나가는 경로는 만들지 않는다.
 *
 * 여기가 지키는 것 다섯.
 *  1. **상관 키를 여기서 발급한다** (BE-X-01). 가시화가 보낸 것은 요청 식별자일 뿐이고,
 *     command_id는 **명령 조립 단계**인 여기서 만들어져 ACK로 내려간다. 이후의 결과·감사는
 *     전부 이 키로만 이어진다.
 *  2. **만료 검사를 서버가 한다** (REQ-909). 화면이 "만료됐다"고 말만 하는 게 아니라
 *     서버가 실제로 거부해야, 만료 필드가 계약에서 의미를 갖는다.
 *  3. **네 단계로 응답한다** — ack → executing(200ms 진행) → physical_state_changed → settled.
 *  4. **실패하면 이전 상태로 되돌린다.** 화면과 현실이 어긋나는 것이 관제에서 가장 위험하다.
 *  5. **잠긴 대상·범위 밖 대상의 명령은 접수하지 않는다.** 화면 차단은 사용자 편의이고
 *     실제 차단은 서버다(VZ-C-04 / BE-Q-04).
 */

import { INTERVALS, SCENARIO_TIMING } from './config.ts';
import { commandLatency } from './controls.ts';
import type { Hub } from './hub.ts';
import type { AuditRecord, CommandRequest, CommandResult, ControlLock } from './protocol.ts';

/**
 * 액션 카탈로그.
 * `irreversible`이 참이면 **ACK가 아니라 실제 수행 결과로 확정 표시**해야 하는 명령이다
 * (VZ-O-02). 수문처럼 되돌리기 어려운 것이 여기 해당한다.
 * ※ 미결: 실제 액션 어휘집(REQ-1208)은 백엔드 소관이며 형태가 Tier 2다.
 */
export type ActionSpec = {
  action: string;
  label: string;
  targetPct: number;
  irreversible: boolean;
  /** 이 액션이 만드는 물리 상태 이름. 화면의 "현재 상태" 표기에 쓴다. */
  resultingState: string;
};

const GATE_ACTIONS: ActionSpec[] = [
  { action: 'open_gate', label: '수문 개방', targetPct: 100, irreversible: true, resultingState: 'open' },
  { action: 'close_gate', label: '수문 폐쇄', targetPct: 0, irreversible: true, resultingState: 'closed' },
];

export const ACTION_CATALOG: Record<string, ActionSpec[]> = {
  'actuator-01': GATE_ACTIONS,
  // zone-504의 수문. 권한 범위(VZ-C-04) 검증용으로 **다른 구역에** 있는 것이 요점이다.
  'actuator-02': GATE_ACTIONS,
};

/** 범위·권한 검사 결과. 서버가 실제로 막는다는 것을 화면이 확인할 수 있어야 한다. */
export type PermissionVerdict = { allowed: boolean; reason: string | null };

type ActiveCommand = {
  req: CommandRequest;
  /** BE-X-01 — 이 엔진이 발급한 상관 키. 결과·감사는 전부 이 키로 나간다. */
  commandId: string;
  spec: ActionSpec;
  startedMs: number;
  /** 실패 시 되돌릴 값. */
  previousPct: number;
  previousState: string;
  timers: Array<ReturnType<typeof setTimeout>>;
  /** 다음 결과가 실패여야 하는가(시나리오 주입). */
  failAt: number | null;
};

/** 명령 접수 결과. **두 키를 함께 돌려준다** — 이 쌍이 곧 ACK 메시지의 내용이다. */
export type SubmitOutcome = {
  clientRequestId: string;
  commandId: string;
  accepted: boolean;
  reasonCode: string | null;
  message: string;
};

export class CommandEngine {
  private readonly hub: Hub;
  private readonly active = new Map<string, ActiveCommand>();
  private readonly audit: AuditRecord[] = [];
  private readonly locks = new Map<string, ControlLock>();
  private commandSeq = 0;

  /** 다음 명령 1건을 실패시킨다(시나리오 주입). */
  failNext = false;

  /**
   * VZ-C-04 / BE-Q-04 — 범위 밖 대상인지 묻는 훅. server.ts가 현재 역할을 근거로 채운다.
   * 엔진이 역할 저장소를 직접 알지 않게 하려고 콜백으로 둔다.
   */
  permissionCheck: ((entity: string) => PermissionVerdict) | null = null;

  /**
   * 명령 시작·종료 시 장치 발행 주기를 다시 걸도록 알리는 훅.
   * 엔진이 장치를 직접 알지 않게 하려고 콜백으로 둔다.
   */
  onActivityChange: ((entity: string) => void) | null = null;

  /** 대상별 현재 물리 상태 이름. 화면의 "현재 상태 closed" 표기. */
  private readonly physicalState = new Map<string, string>();
  private readonly positionPct = new Map<string, number>();

  constructor(hub: Hub) {
    this.hub = hub;
    for (const entity of Object.keys(ACTION_CATALOG)) {
      if (!hub.runtime.has(entity)) continue;
      this.physicalState.set(entity, 'closed');
      this.positionPct.set(entity, 0);
      this.setLock(entity, { locked: false, phase: 'unlocked', reason: null, safe_state_held: false, since: nowIso() });
    }
  }

  /**
   * 대본 시작 시 세계의 초기 조건 주입 (대본 파일의 `initial`).
   *
   * 이 엔진은 수문을 닫힘 0%로 기동하는데, 3편(월류방어벽) 이야기는 열림 100%에서
   * 시작한다. **명령 우회가 아니다** — 재생 전에 세계의 출발 상태를 정하는 것이고,
   * 이후의 모든 변화는 여전히 submit() 4단계로만 일어난다. 수행 중인 명령이 있으면
   * 상태가 어긋나므로 거부한다.
   */
  primeState(entity: string, positionPct: number, physicalState: string): boolean {
    if (this.active.has(entity)) return false;
    this.positionPct.set(entity, positionPct);
    this.physicalState.set(entity, physicalState);
    return true;
  }

  // ── 제어 잠금 (VZ-O-05) ────────────────────────────────────────────────────

  getLock(entity: string): ControlLock | null {
    return this.locks.get(entity) ?? null;
  }

  private setLock(entity: string, lock: ControlLock): void {
    this.locks.set(entity, lock);
    if (this.hub.runtime.has(entity)) {
      this.hub.publish(entity, 'control_lock', lock, { fromDevice: false, quality: lock.locked ? 'unknown' : 'good' });
    }
  }

  /** 통신 두절 주입 — 즉시 잠근다. 늦게 알면 관제사가 헛버튼을 계속 누른다. */
  lockForCommLoss(entity: string, reason: string): void {
    this.setLock(entity, {
      locked: true,
      phase: 'comm_lost',
      reason,
      safe_state_held: true,
      since: nowIso(),
    });
  }

  /**
   * 통신 복구 — **바로 풀지 않는다.**
   * 재확인 단계를 거쳐야 잠금이 해제된다. 끊긴 동안 실제로 무슨 일이 있었는지
   * 모른 채 명령을 내보내면 안 되기 때문이다.
   */
  beginRecheck(entity: string): void {
    this.setLock(entity, {
      locked: true,
      phase: 'rechecking',
      reason: '통신 복구 — 실제 상태 재확인 중 (' + Math.round(SCENARIO_TIMING.CONTROL_RECHECK_MS / 1000) + '초)',
      safe_state_held: true,
      since: nowIso(),
    });
    setTimeout(() => {
      const lock = this.locks.get(entity);
      if (lock?.phase !== 'rechecking') return;
      this.setLock(entity, { locked: false, phase: 'unlocked', reason: null, safe_state_held: false, since: nowIso() });
    }, SCENARIO_TIMING.CONTROL_RECHECK_MS);
  }

  // ── 명령 접수 ──────────────────────────────────────────────────────────────

  /**
   * 명령 접수.
   *
   * **첫 줄에서 상관 키를 발급한다** (BE-X-01 "명령 조립 단계에서 발급"). 거부하더라도
   * 키는 발급한다 — 거부도 감사에 남고, 화면은 두 키의 매핑을 받아야 그 거부를
   * 자기 요청에 붙일 수 있기 때문이다.
   *
   * 거부 사유는 넷 — 미지원 액션 / 권한 범위 밖 / 만료 / 잠금.
   * 거부도 command_result로 내려보낸다. 화면이 사유를 표시할 수 있어야 하기 때문이다.
   */
  submit(req: CommandRequest): SubmitOutcome {
    this.commandSeq += 1;
    // BE-X-01 — 전 파트 단일 상관 키. 가시화가 보낸 client_request_id와는 다른 키다.
    const commandId = 'cmd-' + Date.now().toString(36) + '-' + String(this.commandSeq).padStart(3, '0');

    const specs = ACTION_CATALOG[req.entity] ?? [];
    const spec = specs.find((s) => s.action === req.action);

    if (!spec) {
      return this.reject(req, commandId, 'unknown_action', '지원하지 않는 action: ' + req.action);
    }

    // VZ-C-04 / BE-Q-04 — **화면이 막지 못했을 때 여기서 막힌다.**
    // 화면 차단은 사용자 편의일 뿐이고 실제 강제는 백엔드라는 것이 계약이므로,
    // 목 서버도 범위 밖 명령을 실제로 거부해야 그 계약이 검증된다.
    const verdict = this.permissionCheck?.(req.entity) ?? { allowed: true, reason: null };
    if (!verdict.allowed) {
      return this.reject(req, commandId, 'out_of_scope', verdict.reason ?? '담당 권한 범위 밖 대상이다');
    }

    // REQ-909 — **서버 시각**으로 만료를 검사한다. 클라이언트 시계를 믿지 않는다.
    if (Date.parse(req.expires_at) <= Date.now()) {
      return this.reject(req, commandId, 'expired', '만료 시각이 지난 명령이라 실행하지 않는다 (expires_at=' + req.expires_at + ')');
    }

    const lock = this.locks.get(req.entity);
    if (lock?.locked) {
      return this.reject(req, commandId, 'control_locked', lock.reason ?? '제어 잠금 상태');
    }

    if (this.active.has(req.entity)) {
      return this.reject(req, commandId, 'busy', '이전 명령이 아직 수행 중이다');
    }

    this.begin(req, commandId, spec);
    return {
      clientRequestId: req.client_request_id,
      commandId,
      accepted: true,
      reasonCode: null,
      message: spec.label + ' 명령 접수',
    };
  }

  private reject(req: CommandRequest, commandId: string, reasonCode: string, detail: string): SubmitOutcome {
    this.emitResult(req, commandId, {
      status: 'rejected',
      stage: 'settled',
      progress_pct: null,
      detail,
      reason_code: reasonCode,
      restored: false,
    });
    this.record(req, commandId, 'rejected', detail);
    return { clientRequestId: req.client_request_id, commandId, accepted: false, reasonCode, message: detail };
  }

  // ── 4단계 수행 ─────────────────────────────────────────────────────────────

  private begin(req: CommandRequest, commandId: string, spec: ActionSpec): void {
    const previousPct = this.positionPct.get(req.entity) ?? 0;
    const previousState = this.physicalState.get(req.entity) ?? 'unknown';

    const cmd: ActiveCommand = {
      req,
      commandId,
      spec,
      startedMs: 0,
      previousPct,
      previousState,
      timers: [],
      // 시나리오가 실패를 예약했으면 진행 60% 지점에서 실패시킨다 —
      // 시작하자마자 실패하면 "이전 상태로 복원"이 눈에 보이지 않는다.
      failAt: this.failNext ? 60 : null,
    };
    this.failNext = false;
    this.active.set(req.entity, cmd);
    this.onActivityChange?.(req.entity);

    // 명령 경로 왕복 지연 주입.
    // 하달(서버→엣지 Kafka → 브릿지 → 말단 MQTT)과 회신이 각각 한 방향씩이므로
    // **말단 응답은 두 번 겪는다.** 0이면 지금까지의 동작 그대로다.
    const roundTrip = commandLatency.oneWayMs * 2;

    // 1단계 — 수신 확인(ACK). 화면은 여기서 '진행중'이 되지만 상태는 아직 안 바꾼다.
    cmd.timers.push(
      setTimeout(() => {
        this.emitResult(req, commandId, {
          status: 'accepted',
          stage: 'ack',
          progress_pct: null,
          detail: '디바이스 ACK 수신',
          reason_code: null,
          restored: false,
        });
      }, SCENARIO_TIMING.ACTUATOR_ACK_MS + roundTrip),
    );

    // 2단계 — 수행 중. 200ms마다 진행 보고 (VZ-O-02 / HW-A-04).
    cmd.timers.push(
      setTimeout(() => {
        cmd.startedMs = Date.now();
        this.tickProgress(req.entity);
      }, SCENARIO_TIMING.ACTUATOR_ACK_MS + SCENARIO_TIMING.ACTUATOR_EXEC_GAP_MS + roundTrip),
    );
  }

  private tickProgress(entity: string): void {
    const cmd = this.active.get(entity);
    if (!cmd) return;

    const elapsed = Date.now() - cmd.startedMs;
    const ratio = Math.min(1, elapsed / SCENARIO_TIMING.ACTUATOR_TRAVEL_MS);
    const pct = Math.round(ratio * 100);
    const pos = cmd.previousPct + (cmd.spec.targetPct - cmd.previousPct) * ratio;
    this.positionPct.set(entity, Math.round(pos * 10) / 10);

    // 시나리오가 예약한 실패 지점 — 여기서 멈추고 되돌린다.
    if (cmd.failAt !== null && pct >= cmd.failAt) {
      this.fail(entity, 'obstruction', '구동부 과부하 감지 — 개폐 중단');
      return;
    }

    if (ratio >= 1) {
      this.settle(entity);
      return;
    }

    this.emitResult(cmd.req, cmd.commandId, {
      status: 'accepted',
      stage: 'executing',
      progress_pct: pct,
      detail: '수행 중 · 개도 ' + Math.round(pos) + '%',
      reason_code: null,
      restored: false,
    });

    cmd.timers.push(setTimeout(() => this.tickProgress(entity), INTERVALS.COMMAND_PROGRESS_MS));
  }

  /** 3~4단계 — 물리 상태 변화 → 완료. 되돌리기 어려운 명령은 여기서야 확정된다. */
  private settle(entity: string): void {
    const cmd = this.active.get(entity);
    if (!cmd) return;

    this.positionPct.set(entity, cmd.spec.targetPct);
    this.physicalState.set(entity, cmd.spec.resultingState);

    this.emitResult(cmd.req, cmd.commandId, {
      status: 'accepted',
      stage: 'physical_state_changed',
      progress_pct: 100,
      detail: '물리 상태 변화 확인 — ' + cmd.spec.resultingState,
      reason_code: null,
      restored: false,
    });

    this.emitResult(cmd.req, cmd.commandId, {
      status: 'completed',
      stage: 'settled',
      progress_pct: 100,
      detail: '백엔드가 수행 결과를 확인해 승격',
      reason_code: null,
      restored: false,
    });

    this.record(cmd.req, cmd.commandId, 'completed', cmd.spec.label + ' 완료');
    this.clear(entity);
  }

  /** 실패 — **이전 상태로 복원**하고 사유를 표시한다. */
  private fail(entity: string, reasonCode: string, detail: string): void {
    const cmd = this.active.get(entity);
    if (!cmd) return;

    this.positionPct.set(entity, cmd.previousPct);
    this.physicalState.set(entity, cmd.previousState);

    this.emitResult(cmd.req, cmd.commandId, {
      status: 'failed',
      stage: 'settled',
      progress_pct: null,
      detail: detail + ' — 이전 상태(' + cmd.previousState + ')로 복원',
      reason_code: reasonCode,
      restored: true,
    });

    this.record(cmd.req, cmd.commandId, 'failed', detail);
    this.clear(entity);
  }

  private clear(entity: string): void {
    const cmd = this.active.get(entity);
    cmd?.timers.forEach((t) => clearTimeout(t));
    this.active.delete(entity);
    this.onActivityChange?.(entity);
  }

  /**
   * 결과 발행. **command_id만 싣는다** — 요청 식별자는 여기 실리지 않는다.
   * ACK 이후 구간의 사슬은 상관 키 하나로 이어지는 것이 BE-X-01의 정의이고,
   * 수신 측이 ACK로 받은 매핑 없이도 짝지을 수 있게 두 키를 다 실어 주면
   * 화면이 매핑을 신경 쓰지 않게 되어 실제 백엔드에서 그대로 깨진다.
   */
  private emitResult(
    req: CommandRequest,
    commandId: string,
    partial: Omit<CommandResult, 'command_id' | 'entity' | 'action' | 'expires_at' | 'ts'>,
  ): void {
    const result: CommandResult = {
      command_id: commandId,
      entity: req.entity,
      action: req.action,
      expires_at: req.expires_at,
      ts: nowIso(),
      ...partial,
    };
    this.hub.publish(req.entity, 'command_result', result, { fromDevice: false });
  }

  // ── 감사 적재 (VZ-I-05) ────────────────────────────────────────────────────

  /**
   * 감사 기록은 **백엔드가 쓴다**(VZ-O-03 / BE-X-02). 목 서버가 그 역할을 대신하며,
   * 조작자와 시각은 클라이언트가 보낸 값이 아니라 **서버가 주입한다** —
   * 브라우저가 직접 쓰면 조작자는 자기신고가 되고 시각은 사용자 PC 시계가 된다.
   *
   * 기록의 **1차 키는 command_id**다(BE-X-01의 사슬). 요청 식별자도 남기지만 그건
   * "어느 브라우저 요청에서 시작됐나"의 참고값이지 조회 키가 아니다.
   */
  private record(req: CommandRequest, commandId: string, result: string, detail: string): void {
    this.audit.unshift({
      command_id: commandId,
      // 조회 키가 아니라 출처 표시. 백엔드가 두 키의 매핑을 보유한다는 계약의 흔적이다.
      client_request_id: req.client_request_id,
      entity: req.entity,
      action: req.action,
      result,
      detail,
      // 서버 주입 — 클라이언트가 보낸 값을 쓰지 않는다.
      occurred_at: nowIso(),
      actor_id: 'khw',
      actor_display_name: '김현우',
      actor_role: 'operator',
      written_by: 'mock-gateway audit-writer',
      // 클라이언트가 동봉한 책임소재 필드는 **해석하지 않고 그대로** 적재한다.
      ...(req.audit ?? {}),
    });
    if (this.audit.length > 200) this.audit.length = 200;
  }

  /**
   * 엔진 밖에서 접수·처리된 명령의 감사 적재 (260831 — mission_from_utterance 등).
   *
   * 대본 매칭은 액추에이터 명령이 아니라 이 엔진의 4단계를 지나지 않지만,
   * **감사 저장소는 하나여야 한다** (VZ-I-05) — 발화로 낸 명령이 감사에서 사라지면
   * REQ-1305(voice 감사 필드)가 이 지점에서 끊긴다.
   */
  recordExternal(req: CommandRequest, commandId: string, result: string, detail: string): void {
    this.record(req, commandId, result, detail);
  }

  /**
   * 감사 조회 (VZ-I-05).
   * **command_id 조회가 1차다** — 상관 키가 요청부터 감사까지 사슬을 잇는다는 것이
   * BE-X-01의 정의이므로, 화면도 그 키로 되짚어야 계약이 검증된다.
   * entity 조회는 "이 대상을 마지막으로 조작한 사람"을 묻는 보조 경로다.
   */
  queryAudit(filter: { commandId?: string | null; entity?: string | null }, limit: number): AuditRecord[] {
    let rows: AuditRecord[] = this.audit;
    if (filter.commandId) rows = rows.filter((r) => r.command_id === filter.commandId);
    else if (filter.entity) rows = rows.filter((r) => r.entity === filter.entity);
    return rows.slice(0, limit);
  }

  // ── 조회 ───────────────────────────────────────────────────────────────────

  getPhysicalState(entity: string): string {
    return this.physicalState.get(entity) ?? 'unknown';
  }

  getPositionPct(entity: string): number {
    return this.positionPct.get(entity) ?? 0;
  }

  isBusy(entity: string): boolean {
    return this.active.has(entity);
  }

  /** 수행 중인 명령의 상관 키. 액추에이터 상태 봉투가 이 키를 달고 나간다. */
  activeCommandId(entity: string): string | null {
    return this.active.get(entity)?.commandId ?? null;
  }

  /** 화면의 액션 버튼 목록. 액션 어휘를 화면에 박지 않기 위해 서버가 내려준다. */
  actionsFor(entity: string): ActionSpec[] {
    return ACTION_CATALOG[entity] ?? [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
