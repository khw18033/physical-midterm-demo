// 이식: web-dashboard/src/data/correlation.ts @ 700ed91 — 무수정
// 위치만 data/ 에서 shared/ 로 옮겼다. 두 키의 매핑은 명령 출구의 일부이고,
// 명령 출구는 탭이 아니라 앱이 갖는 것이라 공유 계층에 있어야 한다.
/**
 * src/data/correlation.ts
 *
 * **두 키의 매핑을 보관하는 유일한 곳** (VZ-O-01 / BE-X-01).
 *
 * ── 왜 키가 둘인가
 *
 * 확정된 계약에서 `command_id`는 **백엔드가 명령 조립 단계에서 발급**한다. 그런데 가시화가
 * 아무 키도 붙이지 않으면, 명령을 발행한 순간부터 ACK가 도착하기까지의 구간에서 요청과
 * 응답을 짝지을 수단이 없다. 버튼 비활성·진행 표시를 걸어 둘 대상이 사라진다.
 *
 * 그래서 키를 둘로 나누되 **수명 구간을 갈랐다.**
 *   - `client_request_id` : 가시화가 발급. 발행 ~ ACK 도착까지. 낙관적 UI를 거는 대상.
 *   - `command_id`        : 백엔드가 발급. ACK 도착 이후. 결과·감사의 사슬.
 *
 * ── 왜 데이터 레이어에 두는가
 *
 * 이 매핑은 **전송 방식과 무관한 규칙**이다. WS든 토픽이든 SSE든 "요청 식별자로 걸었다가
 * 상관 키로 잇는다"는 규칙은 그대로여야 하므로, transport에 두면 전송을 갈아끼울 때 같이
 * 딸려 간다. 반대로 컴포넌트에 두면 화면마다 매핑이 생겨 키 관리가 흩어진다.
 *
 * **컴포넌트는 이 파일을 import 하지 않는다.** 화면에는 "이 요청의 현재 상태" 하나만
 * 보이고, 키가 몇 개인지는 여기서 끝난다.
 *
 * ── 실제 백엔드를 붙일 때의 접점
 *
 * 여기가 접점이다. 백엔드가 ACK에 요청 식별자를 되돌려 주면 `link()` 한 줄이 그대로 살고,
 * 되돌려 주지 않으면 매핑이 성립하지 않아 이 파일의 전제가 무너진다(미결 사항 참조).
 */

/**
 * 매핑 없는 상관 키 이벤트의 **보류함**.
 *
 * 목 서버가 순서를 지키면 이 경로는 타지 않는다. 그러나 **순서를 신뢰하는 코드는 실제
 * 백엔드에서 깨진다** — ACK와 결과가 다른 경로로 흐르면 결과가 먼저 도착할 수 있고,
 * 그때 이벤트를 버리면 진행 표시가 통째로 사라진다. 보류했다가 매핑이 생기면 흡수한다.
 */
const MAX_PENDING_PER_KEY = 64;

/** 보류함에 얼마나 오래 두는가. 이보다 오래된 것은 매핑이 영영 안 올 이벤트로 본다. */
const PENDING_TTL_MS = 60_000;

type Pending<E> = { at: number; event: E };

export type CorrelationStats = {
  /** 살아 있는 매핑 수. */
  linked: number;
  /** 지금 보류 중인 이벤트 수. */
  pending: number;
  /** 지금까지 보류했다가 흡수한 누적 이벤트 수. **검증 4의 계측값이다.** */
  absorbed: number;
};

export class CorrelationRegistry<E> {
  /** command_id → client_request_id */
  private readonly toRequest = new Map<string, string>();
  /** client_request_id → command_id */
  private readonly toCommand = new Map<string, string>();
  /** 아직 매핑이 없는 command_id의 이벤트 보류함. */
  private readonly pending = new Map<string, Array<Pending<E>>>();

  private absorbed = 0;

  /**
   * ACK 도착 — 두 키를 잇는다.
   * @returns 이 매핑을 기다리며 보류돼 있던 이벤트들. 호출부가 **순서대로 흡수**해야 한다.
   */
  link(clientRequestId: string, commandId: string): E[] {
    this.toRequest.set(commandId, clientRequestId);
    this.toCommand.set(clientRequestId, commandId);

    const held = this.pending.get(commandId);
    if (held === undefined) return [];
    this.pending.delete(commandId);
    this.absorbed += held.length;
    // 도착 순서를 그대로 돌려준다 — 단계 이력은 순서가 곧 의미다.
    return held.map((p) => p.event);
  }

  /** 상관 키가 어느 요청의 것인가. 매핑이 아직 없으면 null. */
  requestIdFor(commandId: string): string | null {
    return this.toRequest.get(commandId) ?? null;
  }

  /**
   * 이 요청이 받은 상관 키. ACK 전이면 null.
   * 감사 조회(VZ-I-05)가 이 값을 조회 키로 쓴다 — 사슬이 상관 키로 이어지기 때문이다.
   */
  commandIdFor(clientRequestId: string): string | null {
    return this.toCommand.get(clientRequestId) ?? null;
  }

  /** 매핑 없는 상관 키 이벤트를 잠시 맡아 둔다. */
  hold(commandId: string, event: E): void {
    this.sweep();
    const list = this.pending.get(commandId) ?? [];
    // 상한을 두는 이유: 영영 매핑되지 않을 키의 이벤트가 무한히 쌓이면 안 된다.
    // 넘치면 **가장 오래된 것부터** 버린다 — 최신 단계가 화면에 더 중요하다.
    if (list.length >= MAX_PENDING_PER_KEY) list.shift();
    list.push({ at: Date.now(), event });
    this.pending.set(commandId, list);
  }

  /** 이 상관 키의 이벤트가 지금 보류 중인가. */
  pendingCount(commandId: string): number {
    return this.pending.get(commandId)?.length ?? 0;
  }

  /**
   * 요청 하나를 잊는다. **매핑이 없는 경우에도 불릴 수 있다** —
   * ACK 없이 만료된 요청이 그 경우이고, 그때는 지울 상관 키 자체가 없다.
   */
  forget(clientRequestId: string): void {
    const commandId = this.toCommand.get(clientRequestId);
    this.toCommand.delete(clientRequestId);
    if (commandId !== undefined) {
      this.toRequest.delete(commandId);
      this.pending.delete(commandId);
    }
  }

  clear(): void {
    this.toRequest.clear();
    this.toCommand.clear();
    this.pending.clear();
  }

  stats(): CorrelationStats {
    let pending = 0;
    for (const list of this.pending.values()) pending += list.length;
    return { linked: this.toCommand.size, pending, absorbed: this.absorbed };
  }

  /** 매핑이 끝내 오지 않은 보류 이벤트를 정리한다. */
  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [commandId, list] of this.pending) {
      const alive = list.filter((p) => p.at >= cutoff);
      if (alive.length === 0) this.pending.delete(commandId);
      else if (alive.length !== list.length) this.pending.set(commandId, alive);
    }
  }
}
