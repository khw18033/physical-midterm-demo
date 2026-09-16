/**
 * src/canvas/registry.ts (260903 — 1단계)
 *
 * **뷰 노드 렌더러 레지스트리 = 단독 빌드 경계.**
 *
 * 이번 작업의 최대 위험은 요구사항이 아니라 여기다. 뷰 노드를 그래프 안에 그냥 넣으면
 * `tabs/data/` 스토어가 단독 번들에 딸려 들어와 **논문 측정축 D(계측 오버헤드)가 오염된다.**
 * 그래서 그래프는 `ViewNodeEntry` 인터페이스만 알고, **통합 빌드가 `tabs/` 의 렌더러를
 * 주입한다**(`integrated.tsx` → `registerViewNodes`). 단독 빌드는 주입하지 않는다.
 *
 * 주입은 **명시적 호출**이다 — import 부작용으로 등록하면 어느 파일이 등록했는지가
 * 코드에서 보이지 않고, 트리 셰이킹 여부에 따라 팔레트가 조용히 비는 일이 생긴다.
 * `verify:view-nodes` 가 「통합 진입점이 실제로 부르는가」를 소스에서 확인한다.
 *
 * 등록이 하나도 없으면 팔레트 자체가 뜨지 않는다 — 단독 전달본의 화면은 그대로다.
 */

import { useSyncExternalStore } from 'react';
import type { ViewNodeEntry, ViewNodeKind } from './types.ts';

let entries: readonly ViewNodeEntry[] = [];
const listeners = new Set<() => void>();

/**
 * 렌더러 주입. 통합 빌드가 기동 시 한 번 부른다. **두 번 불리면 뒤엣것이 이긴다** —
 * 개발 중 HMR 로 다시 불려도 목록이 두 배가 되지 않아야 한다.
 */
export function registerViewNodes(next: readonly ViewNodeEntry[]): void {
  const kinds = new Set<ViewNodeKind>();
  for (const entry of next) {
    // 같은 kind 가 둘이면 팔레트에 같은 버튼이 두 번 뜨고 저장된 구성이 어느 쪽을 뜻하는지
    // 알 수 없게 된다. 조용히 덮지 않고 즉시 터뜨린다.
    if (kinds.has(entry.kind)) throw new Error(`뷰 노드 kind 가 중복 등록됐다: ${entry.kind}`);
    kinds.add(entry.kind);
  }
  entries = next;
  for (const listener of listeners) listener();
}

/** 팔레트가 훑는 목록. 화면은 이것만 보고 종류 이름을 스스로 적지 않는다 (`VZ-N-01`). */
export function viewNodeCatalog(): readonly ViewNodeEntry[] {
  return entries;
}

export function viewNodeEntry(kind: ViewNodeKind): ViewNodeEntry | null {
  return entries.find((entry) => entry.kind === kind) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 주입이 렌더 뒤에 일어나도 팔레트가 따라오도록 구독한다. */
export function useViewNodeCatalog(): readonly ViewNodeEntry[] {
  return useSyncExternalStore(subscribe, viewNodeCatalog, viewNodeCatalog);
}
