// 이식: web-dashboard/src/data/permissions.ts @ 700ed91 — 무수정 (transport 경로만 조정)
/**
 * src/data/permissions.ts
 *
 * VZ-C-01 · VZ-C-04 — 역할과 **권한 범위** (BE-Q-04).
 *
 * ── 자리 확보가 아니라 실사용이다
 *
 * 예전에는 역할 응답의 `scope`를 `["*"]` 고정으로 두고 자리만 열어 뒀다. 그런데
 * `BE-Q-04`는 역할과 **그 역할이 적용되는 범위(도메인·구역 집합)** 를 함께 내려주는 API를
 * 이미 제공한다. 기준 계층은 Zone(`BE-C-02`)이다.
 *
 * ── 화면 차단은 편의이고 강제는 백엔드다
 *
 * 그래서 이 파일은 **버튼을 잠그고 사유를 만드는 것까지만** 한다. 실제 차단은 서버가
 * 하고, 목 서버도 범위 밖 명령을 실제로 거부한다. 둘 다 있어야 한다 —
 * 화면만 막으면 우회되고, 서버만 막으면 관제사가 이유 없이 실패하는 버튼을 계속 누른다.
 *
 * ── 조회 시점
 *
 * 역할·범위는 세션 중 거의 바뀌지 않으므로 **로그인 시 1회 + 토큰 갱신 시** 재조회다.
 * 여기에 인터벌이 없는 것이 요구사항 그 자체다.
 */

import { getTransport } from '../../transport/index.ts';
import type { ControlLock, RoleInfo } from '../../transport/index.ts';
import type { Registry } from './registry.ts';

// ── 역할 보관 ────────────────────────────────────────────────────────────────

/**
 * 역할 피드.
 *
 * 훅이 각자 fetch 하면 화면마다 조회가 생겨 "로그인 시 1회"가 깨진다. 한 곳에 모아 두고
 * 화면들은 구독만 한다. 재조회는 **명시적 시점**에만 일어난다 — 연결 수립(로그인)과
 * `refreshRole()`(토큰 갱신).
 */
class RoleFeed {
  private snapshot: RoleInfo | null = null;
  private readonly listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RoleInfo | null => this.snapshot;

  /** 역할·범위 조회. 같은 시점의 중복 호출은 하나로 접는다. */
  refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = getTransport()
      .fetchRole()
      .then((role) => {
        this.snapshot = role;
        for (const l of this.listeners) l();
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

export const roleFeed = new RoleFeed();

/** 토큰 갱신 등으로 역할·범위를 다시 받아야 할 때. 주기 호출이 아니다. */
export function refreshRole(): Promise<void> {
  return roleFeed.refresh();
}

// ── 범위 판정 ────────────────────────────────────────────────────────────────

export type ScopeVerdict = {
  inScope: boolean;
  /** 범위 밖인 이유. 범위 안이면 null. */
  reason: string | null;
};

/** 전 범위 역할인가. `['*']`이면 캡스톤 단일 도메인 상태다. */
export function isFullScope(role: RoleInfo | null): boolean {
  return role !== null && role.scope.zones.includes('*');
}

/** 역할 범위를 사람이 읽는 한 줄로. */
export function describeScope(role: RoleInfo | null): string {
  if (role === null) return '역할 조회 전';
  if (isFullScope(role)) return '전 범위 (단일 도메인)';
  return '담당 구역 ' + role.scope.zones.join(', ');
}

/**
 * 이 대상이 현재 역할의 담당 범위 안인가.
 *
 * 대상의 구역은 **레지스트리**에서 읽는다 — 값 봉투에도 zone이 실려 오지만, 값이 한 번도
 * 오지 않은 대상(미배포)도 범위 판정이 되어야 하므로 구성 쪽이 근거로 맞다.
 */
export function checkScope(role: RoleInfo | null, entityId: string, registry: Registry | null): ScopeVerdict {
  // 역할을 아직 못 받았으면 막지 않는다 — 조회 지연으로 버튼이 잠기면 오해를 만든다.
  // 어차피 실제 강제는 백엔드가 하므로 이 구간의 위험은 없다.
  if (role === null) return { inScope: true, reason: null };
  if (isFullScope(role)) return { inScope: true, reason: null };

  const zone = registry?.entities.find((e) => e.id === entityId)?.zone ?? null;
  if (zone !== null && role.scope.zones.includes(zone)) return { inScope: true, reason: null };

  return {
    inScope: false,
    reason:
      '권한 범위 밖 — 현재 역할(' + role.display_name + ')의 담당 구역은 ' +
      role.scope.zones.join(', ') + ' 이고 이 대상은 ' + (zone ?? '구역 미지정') + ' 에 있다',
  };
}

// ── 제어 게이트 (VZ-O-05에 사유 한 줄을 더한다) ───────────────────────────────

export type LockReasonKind = 'control_lock' | 'out_of_scope';

export type LockReason = {
  kind: LockReasonKind;
  label: string;
  text: string;
  /** 부가 설명(안전 상태 유지 여부 등). 없으면 null. */
  meta: string | null;
};

export type ControlGate = {
  locked: boolean;
  /** 잠금 사유들. **둘 이상일 수 있다** — 통신 두절과 범위 밖은 동시에 성립한다. */
  reasons: LockReason[];
};

/**
 * 제어 가능 여부를 한 곳에서 판정한다.
 *
 * VZ-O-05의 잠금(통신 두절·재확인 중)에 **"권한 범위 밖"을 사유 하나로 더한** 형태다.
 * 두 사유를 따로 다루면 컴포넌트가 "잠금이 두 종류"라는 것을 알게 되고, 대상이 늘 때마다
 * 화면마다 조건이 갈라진다.
 */
export function resolveControlGate(input: {
  lock: ControlLock | null;
  scope: ScopeVerdict;
}): ControlGate {
  const reasons: LockReason[] = [];

  if (input.lock?.locked === true) {
    reasons.push({
      kind: 'control_lock',
      label: input.lock.phase === 'rechecking' ? '복구 후 재확인 중' : '통신 두절',
      text: input.lock.reason ?? '제어 잠금 상태',
      meta: input.lock.safe_state_held ? '안전 상태 유지' : null,
    });
  }

  if (!input.scope.inScope) {
    reasons.push({
      kind: 'out_of_scope',
      label: '권한 범위 밖',
      text: input.scope.reason ?? '담당 범위 밖 대상이다',
      // 화면 차단이 방어선이 아니라는 것을 사유 자체에 적어 둔다.
      meta: '화면 차단은 편의이고 실제 강제는 백엔드가 한다 (BE-Q-04)',
    });
  }

  return { locked: reasons.length > 0, reasons };
}
