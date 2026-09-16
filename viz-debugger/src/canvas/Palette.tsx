/**
 * src/canvas/Palette.tsx (260903 — 1단계)
 *
 * **뷰 노드 팔레트** (`VZ-N-01`). 캔버스 머리줄에 붙는 한 줄이다.
 *
 * 목록을 여기에 적지 않는다 — `registry` 에 등록된 렌더러를 그대로 훑는다. 요구사항의
 * 뒷문장이 「개발자가 팔레트 코드를 고쳐 노드를 추가하는 일이 없어야 한다」이기 때문이고,
 * 그 덕에 **단독 빌드에서는 등록이 하나도 없어 팔레트가 아예 뜨지 않는다** — 단독 전달본의
 * 화면이 이번 작업으로 바뀌지 않는다는 뜻이다 (`verify:standalone`).
 *
 * 만든 노드는 **선택한 태스크에 연결된 채로** 나온다. 선택이 없으면 전역 노드다 —
 * 전역은 허용된 상태이지 오류가 아니다(확정된 결정 3). 둘은 화면에서 구별된다.
 */

import { nodeKindsOfAxes, type ViewNodeKindId } from '../scenarios/axes.ts';
import { useScenarioAxes } from '../shared/renderMode.ts';
import type { CanvasApi } from './useCanvas.ts';
import { useViewNodeCatalog } from './registry.ts';

export function Palette({ canvas, pickedTaskId, pickedTaskTitle }: {
  canvas: CanvasApi;
  /** 지금 고른 태스크. 팔레트에서 꺼낸 노드가 여기에 붙는다. */
  pickedTaskId: string | null;
  pickedTaskTitle: string | null;
}) {
  const catalog = useViewNodeCatalog();
  /**
   * **층 1 — 대본이 안 쓰는 종류는 흐리게** (260903 3단계에 탭 바에서 여기로 옮겨 왔다).
   *
   * **막지 않는다** — 막으면 「왜 안 눌리지」가 새 질문이 된다. 판정 재료는 노드 접힘과
   * **같은 훅**이라 일반 모드에서는 null 이고, 목 렌더가 켜져 있으면 목이 이긴다.
   */
  const axes = useScenarioAxes();
  const scriptKinds = axes === null ? null : nodeKindsOfAxes(axes);
  // 주입이 없는 빌드(단독 전달본)에서는 팔레트 자체가 없다. 빈 줄을 남기지 않는다.
  if (catalog.length === 0) return null;
  return <div className="palette">
    <div className="palette__row">
      <b className="palette__title">뷰 노드</b>
      {catalog.filter((entry) => entry.inPalette !== false).map((entry) => {
        const unused = scriptKinds !== null && !scriptKinds.has(entry.kind as ViewNodeKindId);
        return <button
          key={entry.kind}
          type="button"
          className={'palette__item' + (unused ? ' palette__item--unused' : '')}
          title={unused
            ? `${entry.hint} — 이 대본은 이 노드를 쓰지 않습니다 (놓아서 확인할 수 있습니다)`
            : `${entry.hint} — ${pickedTaskId === null ? '전역 노드로 놓입니다' : `${pickedTaskId} 에 연결된 채로 놓입니다`}`}
          onClick={() => canvas.add(entry.kind, pickedTaskId)}
        >+ {entry.label}{unused && <small> · 이 대본엔 없음</small>}</button>;
      })}
      {/* 고른 태스크가 없을 때는 아무 말도 안 한다 (260914 지시) — 늘 떠 있는 설명이라
          버튼 줄만 길어졌다. 전역 노드로 놓인다는 것은 버튼 툴팁과 카드의 「전역」이 말한다. */}
      {pickedTaskId !== null && <span className="palette__target">
        연결 대상 <b>◂ {pickedTaskId}</b>{pickedTaskTitle === null ? null : ` ${pickedTaskTitle}`}
      </span>}
      {/* 층 ③ — 사용자 구성을 지우고 기본 구성으로. 되돌릴 것이 없으면 버튼도 없다. */}
      {canvas.restorable && <button type="button" className="palette__reset" onClick={canvas.reset} title="이 마일스톤의 캔버스 구성을 기본으로 되돌립니다">기본 구성으로 되돌리기</button>}
    </div>
    {/* 실패 셋의 한 줄들 — 저장소 막힘 · 태스크 소실 · 스키마 변경. 막지 않고 적기만 한다. */}
    {canvas.notices.map((notice) => <p key={notice} className="palette__notice">{notice}</p>)}
    {!canvas.writable && canvas.notices.length === 0 && <p className="palette__notice">이 브라우저에서는 캔버스 구성이 저장되지 않습니다 — 화면은 그대로 동작합니다.</p>}
  </div>;
}
