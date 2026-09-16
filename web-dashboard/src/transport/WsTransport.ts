/**
 * src/transport/WsTransport.ts
 *
 * Transport의 WebSocket 구현체. **여기가 전송 방식을 아는 유일한 파일이다.**
 *
 * 하는 일 넷:
 *  1. 계약 축 {entity, node, channel} 구독을 그대로 서버에 넘긴다(토픽 문자열로 번역하지 않는다).
 *  2. 끊기면 지수 백오프로 재접속하고 **기존 구독을 자동 복원**한다.
 *  3. 복원되면 서버가 현재값을 다시 밀어 주므로(VZ-I-02) 화면에 공백이 남지 않는다.
 *  4. scope(VZ-I-11)를 구독 요청에 실어 보내고, 봉투에 실려 돌아온 값을 그대로 상위로 넘긴다.
 */

import { backoffDelayMs } from './backoff.ts';
import type { Transport, Unsubscribe } from './Transport.ts';
import type {
  CommandAck,
  CommandRequest,
  ConnectionState,
  ConnectionStatus,
  Envelope,
  RoleInfo,
  ScopeSpec,
  Selector,
} from './types.ts';

export type WsTransportConfig = {
  /** 게이트웨이 WS 주소. **진짜 백엔드가 나오면 여기만 바꾼다.** */
  url: string;
  /** 레지스트리 HTTP base. */
  httpBase: string;
};

type Sub = {
  id: string;
  selector: Selector;
  scope: ScopeSpec;
  handler: (e: Envelope) => void;
};

export class WsTransport implements Transport {
  private readonly config: WsTransportConfig;
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, Sub>();
  private readonly statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private roleWaiters: Array<(r: RoleInfo) => void> = [];
  /**
   * **client_request_id** → ACK 대기자.
   *
   * 상관 키(command_id)로 잡을 수 없다 — 그 키는 ACK가 도착해야 알게 되는 값이기 때문이다.
   * 이 구간에서 확실한 것은 내가 붙인 요청 식별자뿐이고, 그것이 두 키를 나눈 이유다.
   * 진행 단계는 이 경로가 아니라 command_result 채널 구독으로 따로 온다.
   */
  private readonly commandWaiters = new Map<string, (o: CommandAck) => void>();

  private subSeq = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;

  private status: ConnectionStatus = {
    state: 'closed',
    attempt: 0,
    nextRetryInMs: null,
    serverTime: null,
    staleThresholdMs: null,
    lastError: null,
  };

  constructor(config: WsTransportConfig) {
    this.config = config;
  }

  // ── 연결 ───────────────────────────────────────────────────────────────────

  connect(): void {
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus({ state: this.attempt > 0 ? 'reconnecting' : 'connecting', nextRetryInMs: null });

    const ws = new WebSocket(this.config.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus({ state: 'open', attempt: 0, nextRetryInMs: null, lastError: null });
      // **구독 자동 복원.** 호출자는 아무것도 하지 않는다.
      // 복원 즉시 서버가 현재값을 1회 푸시하므로(VZ-I-02) 화면 공백이 생기지 않는다.
      for (const sub of this.subs.values()) this.sendSubscribe(sub);
    };

    ws.onmessage = (ev) => this.onMessage(ev);

    ws.onerror = () => {
      this.setStatus({ lastError: '게이트웨이 연결 오류' });
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.manualClose) {
        this.setStatus({ state: 'closed', nextRetryInMs: null });
        return;
      }
      this.scheduleReconnect();
    };
  }

  close(): void {
    this.manualClose = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus({ state: 'closed', attempt: 0, nextRetryInMs: null });
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = backoffDelayMs(this.attempt);
    this.setStatus({ state: 'reconnecting', attempt: this.attempt, nextRetryInMs: delay });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  // ── 구독 ───────────────────────────────────────────────────────────────────

  subscribe(selector: Selector, handler: (e: Envelope) => void, scope: ScopeSpec = 'all'): Unsubscribe {
    this.subSeq += 1;
    const id = 'sub-' + this.subSeq;
    const sub: Sub = { id, selector, scope, handler };
    this.subs.set(id, sub);

    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe(sub);

    return () => {
      this.subs.delete(id);
      this.send({ type: 'unsubscribe', id });
    };
  }

  private sendSubscribe(sub: Sub): void {
    this.send({
      type: 'subscribe',
      id: sub.id,
      // 토픽 문자열로 번역하지 않는다. 계약 축을 그대로 보낸다.
      selector: sub.selector,
      // VZ-I-11 — 현 단계 'all' 고정이지만 요청에 실제로 실려 나간다.
      scope: sub.scope,
    });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // ── 수신 ───────────────────────────────────────────────────────────────────

  private onMessage(ev: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello':
        this.setStatus({
          serverTime: msg.server_time as string,
          // 표시용으로만 받는다. stale 판정은 서버가 이미 끝냈다.
          staleThresholdMs: msg.stale_threshold_ms as number,
        });
        return;

      case 'data': {
        const sub = this.subs.get(msg.sub as string);
        if (!sub) return;
        sub.handler(msg.envelope as Envelope);
        return;
      }

      case 'role': {
        // VZ-C-04 — 역할과 **범위**가 함께 온다. 범위 해석은 여기서 하지 않는다.
        const info: RoleInfo = {
          role: msg.role as string,
          display_name: (msg.display_name as string | undefined) ?? (msg.role as string),
          scope: (msg.scope as RoleInfo['scope'] | undefined) ?? { zones: [] },
          issued_at: (msg.issued_at as string | undefined) ?? new Date().toISOString(),
          source: (msg.source as string | undefined) ?? '(출처 미표기)',
        };
        const waiters = this.roleWaiters;
        this.roleWaiters = [];
        for (const w of waiters) w(info);
        return;
      }

      case 'command_ack': {
        // **두 키가 함께 오는 유일한 메시지.** 대기자는 요청 식별자로 찾고,
        // 상관 키는 그대로 위로 넘긴다 — 매핑을 만드는 것은 데이터 레이어의 일이다.
        const requestId = msg.client_request_id as string;
        const waiter = this.commandWaiters.get(requestId);
        if (waiter === undefined) return;
        this.commandWaiters.delete(requestId);
        waiter({
          clientRequestId: requestId,
          commandId: (msg.command_id as string | undefined) ?? null,
          accepted: msg.accepted as boolean,
          reasonCode: (msg.reason_code as string | null) ?? null,
          message: String(msg.message),
        });
        return;
      }

      case 'error':
        this.setStatus({ lastError: String(msg.message) });
        return;

      default:
        return;
    }
  }

  // ── 상태 ───────────────────────────────────────────────────────────────────

  private setStatus(patch: Partial<ConnectionStatus> & { state?: ConnectionState }): void {
    this.status = { ...this.status, ...patch };
    for (const h of this.statusHandlers) h(this.status);
  }

  onStatus(handler: (s: ConnectionStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  fetchRole(): Promise<RoleInfo> {
    return new Promise((resolve) => {
      this.roleWaiters.push(resolve);
      this.send({ type: 'role' });
    });
  }

  publishCommand(command: CommandRequest): Promise<CommandAck> {
    return new Promise((resolve) => {
      const requestId = command.client_request_id;

      if (this.ws?.readyState !== WebSocket.OPEN) {
        // 끊긴 상태에서 명령을 큐에 쌓지 않는다 — 나중에 한꺼번에 나가면
        // 만료 시각의 의미가 사라지고 관제사가 의도하지 않은 시점에 장비가 움직인다.
        resolve({
          clientRequestId: requestId,
          commandId: null,
          accepted: false,
          reasonCode: 'disconnected',
          message: '게이트웨이 연결 없음 — 명령을 보내지 않았다',
        });
        return;
      }

      this.commandWaiters.set(requestId, resolve);
      this.send({ type: 'command', command });

      /**
       * ACK 자체가 오지 않는 경우를 위한 안전장치.
       *
       * 대기 한도를 **만료 시각에서 뽑는다.** 고정 5초로 두면 TTL이 더 긴 명령에서
       * "접수 응답 없음"이 만료보다 먼저 떠서, 정작 화면에 보여야 할 사유(만료)를
       * 덮어 버린다. 만료 판정 자체는 서버가 하지만 **기다림의 한도**는 만료 시각을
       * 따라가는 것이 맞다. 여유 500ms는 서버 거부 응답이 도착할 시간이다.
       */
      const waitMs = Math.max(1_000, Date.parse(command.expires_at) - Date.now() + 500);
      setTimeout(() => {
        if (!this.commandWaiters.has(requestId)) return;
        this.commandWaiters.delete(requestId);
        resolve({
          clientRequestId: requestId,
          // 끝내 상관 키를 받지 못했다. 이 요청은 요청 식별자만으로 정리되어야 한다.
          commandId: null,
          accepted: false,
          reasonCode: 'ack_timeout',
          message: '접수 응답(ACK) 없음 — 상관 키를 받지 못했다',
        });
      }, waitMs);
    });
  }

  setVideoPanel(entity: string, open: boolean): void {
    this.send({ type: 'video', entity, open });
  }

  decidePlan(planId: string, decision: 'approve' | 'reject', reason?: string): void {
    this.send({ type: 'plan_decision', plan_id: planId, decision, reason });
  }

  /** 목 게이트웨이 전용. 실제 게이트웨이 구현에는 이 메서드가 없다. */
  playScenario(name: string): void {
    this.send({ type: 'scenario', name });
  }
}
