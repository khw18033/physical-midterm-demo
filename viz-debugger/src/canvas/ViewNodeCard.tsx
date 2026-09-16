/**
 * src/canvas/ViewNodeCard.tsx (260903 — 1단계)
 *
 * 캔버스에 놓인 뷰 노드 한 장. **내용은 주입된 렌더러가 그린다** — 이 파일은 테두리와
 * 범위 표시와 손잡이만 안다. 그래서 `tabs/` 를 한 줄도 import 하지 않는다.
 *
 * 1단계의 본문은 **자리표시**다. 4종의 요약 카드 규격(장치·위험 / 제어 / 지표 / 영상)과
 * 확대 오버레이는 2단계다 (지시서 §5·§8).
 *
 * ## 연결과 전역은 화면에서 구별된다 (`VZ-N-02`)
 *
 * 연결된 노드는 머리에 `◂ T-43c` 가 붙고 태스크에서 내려오는 **범위 엣지**가 닿는다.
 * 전역 노드는 연결선이 없고 `전역` 뱃지를 단다. 뱃지만으로는 부족하다 — 선이 있고 없고가
 * 한눈에 보이는 차이다.
 */

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { ViewNodeEntry, ViewNodeInstance, ViewScope } from './types.ts';

/** 구간을 사람이 읽는 한 줄로. 전역은 임무 전체다. */
function spanLabel(scope: ViewScope): string {
  return `T+${Math.round(scope.fromSec)}~${Math.round(scope.toSec)}s`;
}

export function ViewNodeCard({ node, entry, scope, position, size, grips, picked, zoomed, highlighted, onPointerDown, onBind, onRemove, onZoom }: {
  node: ViewNodeInstance;
  /** 등록되지 않은 종류면 null — 저장된 구성이 다른 빌드에서 만들어졌을 때다. */
  entry: ViewNodeEntry | null;
  scope: ViewScope;
  position: { x: number; y: number };
  /** 사람이 바꾼 크기. 없으면 CSS 기본값이다 (260911). */
  size?: { w: number; h: number };
  /** 테두리 손잡이 — 그래프가 만들어 넣는다. 카드는 크기 조절 규칙을 모른다. */
  grips?: ReactNode;
  /** 지금 고른 태스크. 전역 노드를 여기에 이을 수 있다. */
  picked: string | null;
  /** 이 노드가 지금 확대돼 있는가 (260903 2단계). 카드는 **그대로 남는다** — 확대가
   *  캔버스를 교체하지 않는다는 것이 화면에서도 보여야 한다. */
  zoomed: boolean;
  /**
   * 대본 띠의 「○○ 노드로」가 방금 이 카드를 가리켰는가 (260903 3단계).
   * 만들어 준 노드가 캔버스 어디에 생겼는지 말해 주지 않으면 사용자가 찾아야 한다.
   */
  highlighted: boolean;
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onBind(taskId: string | null): void;
  onRemove(): void;
  onZoom(): void;
}) {
  const bound = node.taskId !== null;
  return <div
    className={`view-node ${bound ? 'view-node--bound' : 'view-node--global'}${zoomed ? ' view-node--zoomed' : ''}${highlighted ? ' view-node--flash' : ''}`}
    style={{ left: position.x, top: position.y, width: size?.w, height: size?.h }}
    onPointerDown={onPointerDown}
    // 확대는 **더블클릭**이다 (확정된 결정 2). 아래 ⤢ 버튼은 같은 길의 보이는 입구다 —
    // 더블클릭만 두면 발견할 수 없는 길이 된다.
    onDoubleClick={onZoom}
    data-view-node={node.kind}
  >
    {grips}
    <header className="view-node__head">
      <b>{entry?.label ?? node.kind}</b>
      {bound
        ? <span className="view-node__scope" title={`이 태스크의 대상·구간이 이 노드의 조회 범위입니다 (${spanLabel(scope)})`}>◂ {node.taskId}</span>
        : <span className="view-node__scope view-node__scope--global" title="연결하지 않은 전역 노드 — 임무 전체 구간을 봅니다">전역</span>}
      {/* 손잡이 버튼은 끌기와 섞이면 안 된다 — pointerdown 을 여기서 멈춘다. */}
      <span className="view-node__acts" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={onZoom} disabled={entry === null} title={entry === null ? '이 빌드에는 렌더러가 없어 확대할 것이 없습니다' : '확대 (더블클릭도 같습니다) — 캔버스는 뒤에 그대로 있습니다'}>⤢</button>
        {bound
          ? <button type="button" onClick={() => onBind(null)} title="연결을 끊고 전역 노드로">⛓</button>
          : <button type="button" onClick={() => onBind(picked)} disabled={picked === null} title={picked === null ? '연결할 태스크를 먼저 고르세요 (태스크를 한 번 누릅니다)' : `${picked} 에 연결`}>⛓</button>}
        <button type="button" onClick={onRemove} title="이 뷰 노드를 캔버스에서 지웁니다">×</button>
      </span>
    </header>
    <div className="view-node__body">
      {entry === null
        ? <p className="view-node__missing">이 빌드에는 <code>{node.kind}</code> 렌더러가 없습니다 — 통합 앱에서 보입니다.</p>
        : entry.summary(scope)}
    </div>
    <footer className="view-node__foot">{scope.deviceId ?? '대상 없음'} · {spanLabel(scope)}</footer>
  </div>;
}
