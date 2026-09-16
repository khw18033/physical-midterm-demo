/**
 * src/shared/Explain.tsx (260831 신설 — 사이트 개선 요구 1)
 *
 * 화면에 상주하던 설명 문단을 **우상단 `?` 오버레이로 옮기는 통로.**
 *
 * 설명서를 별도 파일로 옮기면 화면을 고칠 때 한쪽만 바뀌어 조용히 갈라진다 —
 * 이 저장소가 계속 피해 온 실패다. 그래서 문구는 **원래 있던 컴포넌트 자리에 그대로 두고**
 * (`<Explain id="…">원래 문단</Explain>`), 그리는 위치만 바꾼다:
 *
 *  - 통합 셸 안(ManualScope 제공됨): 본문에는 아무것도 그리지 않고, 자기 내용을
 *    「지금 보고 있는 것」(캔버스 또는 확대된 노드)의 설명서로 등록한다.
 *    등록 순서 = DOM 순서 = 설명서의 순서.
 *  - 단독 빌드(셸 없음 — ManualScope 없음): **원래 문단 그대로 그린다.**
 *    HCI 전달본(단독 빌드)의 화면이 이 개편으로 바뀌면 안 되기 때문이다.
 *
 * 등록은 마운트 시 한 번(useEffect), 내용은 ref 로 매번 최신을 읽는다 —
 * 매 렌더마다 등록하면 오버레이가 열려 있을 때 되그리기가 요란해진다.
 */

import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

/**
 * 설명서의 구역 (260903 3단계 — 탭 다섯에서 **캔버스 + 뷰 노드 4종**으로).
 *
 * `canvas` 는 캔버스 화면 자체(마일스톤·태스크 그래프·팔레트)이고, 넷은 확대된 뷰 노드다.
 * 종류 id 는 `scenarios/axes.ts` 의 `ViewNodeKindId` 와 같은 어휘를 쓴다 —
 * `verify:node-scope` 가 그 어휘가 갈라지지 않았는지 본다.
 */
export type ManualScopeId = 'canvas' | 'device-risk' | 'control' | 'metrics' | 'video' | 'shell';

/**
 * 셸이 캔버스를, 확대 오버레이가 그 노드를 감싼다. 단독 빌드에는 제공자가 없다 —
 * 그때 Explain 은 원래 문단 그대로 그린다(HCI 전달본 보존).
 */
export const ManualScope = createContext<ManualScopeId | null>(null);

type ManualEntry = {
  id: string;
  scope: ManualScopeId;
  order: number;
  /** 오버레이가 열릴 때 최신 내용을 읽는다. */
  read(): ReactNode;
};

const entries = new Map<string, ManualEntry>();
let orderSeq = 0;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 오버레이가 읽는 목록 — 등록(DOM) 순서대로. */
export function manualEntries(scope: ManualScopeId): ManualEntry[] {
  return [...entries.values()].filter((entry) => entry.scope === scope).sort((a, b) => a.order - b.order);
}

/** 오버레이가 목록 변화(확대 열고 닫기·마운트)에 다시 그리도록 하는 구독. */
export function useManualVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => 0,
  );
}

export function Explain({ id, className = 'note', children }: {
  id: string;
  /** 단독 빌드에서 문단으로 그릴 때의 클래스 — 원래 문단의 클래스를 그대로 준다. */
  className?: string;
  children: ReactNode;
}) {
  const scope = useContext(ManualScope);
  const contentRef = useRef<ReactNode>(children);
  contentRef.current = children;

  useEffect(() => {
    if (scope === null) return;
    const key = scope + ':' + id;
    if (!entries.has(key)) {
      orderSeq += 1;
      entries.set(key, { id, scope, order: orderSeq, read: () => contentRef.current });
    }
    notify();
    return () => {
      entries.delete(key);
      notify();
    };
  }, [scope, id]);

  // 단독 빌드 — 오버레이가 없으므로 원래 자리에서 원래 문단으로 그린다 (전달본 보존).
  if (scope === null) return <p className={className}>{children}</p>;
  return null;
}
