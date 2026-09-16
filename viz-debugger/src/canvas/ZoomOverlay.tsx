/**
 * src/canvas/ZoomOverlay.tsx (260903 — 2단계)
 *
 * **확대는 탭이 아니다.** 지시서 §6이 그것을 검사 가능한 네 조건으로 적어 뒀고, 이 파일이
 * 그 넷을 그대로 구현한다. `verify:no-tabs` 가 소스에서 같은 넷을 확인한다.
 *
 * | 조건 | 여기서 |
 * |---|---|
 * | 캔버스가 **뒤에 남아 보인다** | `ActionModal` 과 같은 `.modal-backdrop`(반투명 `#1a222c55`) 위에 얹는다. 캔버스는 언마운트되지 않는다 — 호출부가 `TaskGraph` 를 **조건 없이** 그리고 이 오버레이를 형제로 둔다 |
 * | 닫으면 **정확히 같은 자리** | 닫기는 `zoomedId` 를 null 로 두는 것뿐이다. 캔버스가 계속 살아 있었으므로 스크롤·노드 자리·되감기 시각이 그대로다 |
 * | 전역에 `activeTab` 류 상태가 **없다** | 상태는 `ZoomTarget`(`canvas/zoomState.ts`) 하나다. 「몇 번째 탭」이 아니라 「어느 노드」다 |
 * | 확대는 **한 번에 하나** | 그 상태가 문자열 하나라 둘이 열릴 수 없다. 배열도 집합도 아니다 |
 *
 * 그래서 이것은 오버레이이지 화면 전환이 아니다 — HCI 차별점 2(「화면을 바꾸지 않고
 * 공시 ↔ 통시를 넘어간다」)의 뒷절이 여기서 처음으로 사실이 된다.
 */

import { useEffect, type ReactNode } from 'react';
import { ManualScope, type ManualScopeId } from '../shared/Explain.tsx';
import type { ViewNodeEntry, ViewScope } from './types.ts';

export function ZoomOverlay({ entry, scope, taskId, onClose }: {
  entry: ViewNodeEntry;
  scope: ViewScope;
  /** 연결한 태스크. 전역 노드면 null — 머리줄이 범위를 그대로 적는다. */
  taskId: string | null;
  onClose(): void;
}) {
  // Esc 로 닫힌다. 팝업을 여는 길이 둘(더블클릭·버튼)이면 닫는 길도 둘 이상이어야 한다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const where: ReactNode = taskId === null
    ? <>전역 노드 · 임무 전체 구간</>
    : <>◂ {taskId} 에 연결됨 · {scope.deviceId ?? '대상 없음'}</>;

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal zoom-modal" role="dialog" aria-label={`${entry.label} 확대`}>
      <header>
        <div>
          <h2>⤢ {entry.label}</h2>
          {/* 범위를 여기 한 줄로 적는다 — 확대해도 「무엇의 값인지」가 안 흐려져야 한다. */}
          <small>{where} · T+{Math.round(scope.fromSec)}~{Math.round(scope.toSec)}s · 재생 머리 T+{Math.round(scope.headSec)}s</small>
        </div>
        <button onClick={onClose}>닫기 (Esc)</button>
      </header>
      {/* 확대 본문 안의 `<Explain>` 문단들이 **이 노드의 설명서**로 등록된다 (260903 3단계).
          우상단 `?` 가 확대 중에는 그 노드 것을 보인다 — 탭별 설명서가 있던 자리다. */}
      <div className="zoom-modal__body">
        <ManualScope.Provider value={entry.kind as ManualScopeId}>{entry.zoom(scope)}</ManualScope.Provider>
      </div>
      <footer>
        <span>확대는 캔버스를 교체하지 않습니다 — 뒤에 그대로 있고, 닫으면 같은 자리입니다.</span>
      </footer>
    </section>
  </div>;
}
