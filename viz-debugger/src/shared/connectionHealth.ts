/**
 * src/shared/connectionHealth.ts (260910 신설 — 연결 관리 통합 §2 · §3)
 *
 * **대상마다 「마지막으로 확인한 결과」를 들고 있는 열.**
 *
 * `connections.ts` 는 **설정**(어디에 붙을 것인가)이고 여기는 **결과**(눌러 봤더니 어땠는가)다.
 * 둘을 한 파일에 두면 주소를 고칠 때마다 결과가 같이 흔들린다.
 *
 * ## 「붙었다」와 「답한다」는 다르다 (§3 — 이번 작업의 요점)
 *
 * MQTT 브로커에 붙는 것과 로봇이 명령에 답하는 것은 별개다. 브로커는 살아 있는데 로봇이
 * 꺼져 있으면 **연결은 성공이고 왕복은 실패다.** 둘을 한 표시등으로 뭉치면 발표 직전에
 * 무엇이 문제인지 못 가른다 — 주소·포트·망을 봐야 하는지, 로봇 전원을 봐야 하는지.
 *
 * 그래서 결과가 **줄 단위**다. 한 대상이 줄을 여럿 가질 수 있고, `physical` 이 둘을 갖는다.
 */

import { useSyncExternalStore } from 'react';
import type { ConnectionTargetId } from './connections.ts';

/** 한 줄의 결과. **사유를 버리지 않는다** — `SttProbe` 와 같은 규칙이다. */
export type HealthLine = {
  /** 줄 이름. `physical` 은 '브로커'와 '로봇' 둘이다. */
  id: string;
  label: string;
  /**
   * `true` 초록 · `false` 빨강 · **`null` 은 「모른다」**.
   *
   * 모른다와 빨갛다는 다르다. `ping` 은 단말까지만 증명하고 로봇은 증명하지 않는다 —
   * 그때 로봇 줄을 빨갛게 칠하면 「로봇이 죽었다」는 없는 사실을 말하는 것이고,
   * 초록으로 칠하면 「로봇이 살아 있다」는 더 나쁜 거짓말이다.
   */
  ok: boolean | null;
  /** 왕복 시간(ms). 모르면 null — 발표에서 물어볼 수 있는 숫자다. */
  roundTripMs: number | null;
  /** 실패했으면 왜. 화면이 이 문장을 그대로 적는다. */
  reason: string | null;
  /** 언제 확인했는가. */
  checkedAtIso: string;
};

export type TargetHealth = {
  /** 확인 중인가 — 버튼을 두 번 누르지 않게. */
  checking: boolean;
  lines: readonly HealthLine[];
};

const EMPTY: TargetHealth = { checking: false, lines: [] };

let health: Readonly<Record<string, TargetHealth>> = {};
const listeners = new Set<() => void>();

function commit(next: Readonly<Record<string, TargetHealth>>): void {
  health = next;
  for (const listener of listeners) listener();
}

export function connectionHealth(): Readonly<Record<string, TargetHealth>> {
  return health;
}

export function healthOf(target: ConnectionTargetId): TargetHealth {
  return health[target] ?? EMPTY;
}

export function subscribeHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectionHealth(): Readonly<Record<string, TargetHealth>> {
  return useSyncExternalStore(subscribeHealth, connectionHealth, connectionHealth);
}

export function setChecking(target: ConnectionTargetId, checking: boolean): void {
  commit({ ...health, [target]: { ...healthOf(target), checking } });
}

/** 확인 결과를 적는다. 줄이 여럿이면 여럿을 한 번에 — `physical` 이 그렇다. */
export function setHealth(target: ConnectionTargetId, lines: readonly HealthLine[]): void {
  commit({ ...health, [target]: { checking: false, lines } });
}

/** 한 줄 만들기. 시각은 여기서 붙인다 — 부르는 쪽마다 다르게 적으면 표가 어긋난다. */
export function line(
  id: string,
  label: string,
  ok: boolean | null,
  extra: { roundTripMs?: number | null; reason?: string | null } = {},
): HealthLine {
  return {
    id,
    label,
    ok,
    roundTripMs: extra.roundTripMs ?? null,
    reason: extra.reason ?? null,
    checkedAtIso: new Date().toISOString(),
  };
}

/**
 * 대상 하나가 통째로 초록인가. **줄이 하나라도 빨가면 빨갛다** — 브로커만 붙고 로봇이
 * 죽어 있으면 그 대상은 초록이 아니다(§5 「넷 중 하나라도 빨간 채로 무대에 오르지 않는다」).
 *
 * 아직 안 눌러 봤으면 `null` 이다 — 「모른다」와 「빨갛다」는 다르다.
 */
export function targetOk(target: ConnectionTargetId): boolean | null {
  const lines = healthOf(target).lines;
  if (lines.length === 0) return null;
  // 빨간 줄이 하나라도 있으면 빨갛다.
  if (lines.some((l) => l.ok === false)) return false;
  // 「모른다」만 남았으면 초록이라고 말하지 않는다 — 확인된 것만 초록이다.
  if (lines.every((l) => l.ok === true)) return true;
  return null;
}

/** 시연 화면 표시등이 읽는 한 줄. 무엇이 끊겼는지가 보여야 한다 (§4). */
export function firstBroken(targets: readonly ConnectionTargetId[]): { target: ConnectionTargetId; line: HealthLine } | null {
  for (const target of targets) {
    // **모르는 것은 끊긴 것이 아니다.** 빨간 줄만 짚는다.
    const broken = healthOf(target).lines.find((l) => l.ok === false);
    if (broken !== undefined) return { target, line: broken };
  }
  return null;
}

/** 검사와 화면이 같은 목록을 본다. 발표 직전에 이 넷이 다 초록이어야 한다 (§5). */
export const CHECKED_TARGETS: readonly ConnectionTargetId[] = ['physical', 'detect', 'stt', 'generate'];

export function resetHealth(): void {
  commit({});
}
