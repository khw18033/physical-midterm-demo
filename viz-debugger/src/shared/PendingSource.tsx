/**
 * src/shared/PendingSource.tsx
 *
 * 남이 줄 데이터가 있어야 할 자리에 **무엇을 · 누구에게서 기다리는지**를 그린다.
 *
 * 빈칸으로 두는 것이 아니다. 빈칸은 "우리가 안 만들었다"로 읽히고, 자리표시는
 * **"못 받았다 · 누가 주면 된다"**로 읽힌다. 그 차이가 이 작업의 전부다.
 *
 * ## 크기를 부모에서 받는다
 *
 * 나중에 진짜 데이터가 오면 **이 자리에 그대로 들어가야** 하므로 원래 자리의 크기를 유지한다.
 * 화면이 텅 비어 보이면 실패다. 그래서 높이를 스스로 정하지 않고 `minHeight`/`fill` 로 받는다.
 *
 * ## 목 렌더 모드
 *
 * `renderMode` 가 `'mock'` 이면 `children`(원래의 목 화면)을 그린다. 이때 **지워지지 않는
 * 목 배지**가 그 자리에 함께 뜬다 — 토글을 켠 것을 잊고 시연하면 원래 문제로 되돌아간다.
 * 배지를 끄는 경로는 만들지 않는다.
 */

import type { ReactNode } from 'react';
import { AXIS_LABEL, type ScenarioAxis } from '../scenarios/axes.ts';
import { scriptsWithAxis } from '../scenarios/scriptScope.ts';
import { pendingSource, PLANE_LABEL, PLANE_NOTE } from './pendingSources.ts';
import { useMockRender, useScenarioAxis, useScenarioCast } from './renderMode.ts';

type Props = {
  /** `pendingSources.ts` 의 id. */
  id: string;
  /** 원래 자리의 최소 높이(px). 자리를 유지하려면 준다. */
  minHeight?: number;
  /** 부모 높이를 꽉 채운다. */
  fill?: boolean;
  /** 한 줄짜리 좁은 자리(카드 안 한 행 등). 네 가지는 툴팁으로 간다. */
  inline?: boolean;
  /**
   * 이 자리가 담는 **장비 ID** (260831 — scenario 모드).
   * 대본 재생 중 그 장비가 대본의 cast 에 있으면 값을 그린다 — 대본이 몰아 주는
   * 합성값이라는 배지와 함께. cast 밖이거나 entity 가 없으면 여전히 자리표시다.
   * 「이 값은 대본이 준 것」과 「이 자리는 아직 아무도 안 준 것」이 그렇게 갈린다.
   */
  entity?: string;
  /**
   * 이 자리가 담는 **축** (260831 — 사이트 개선 요구 2).
   *
   * 시나리오 모드에서 이 축을 현재 대본이 몰지 않으면 「연결 예정」이 아니라
   * **「이 대본에는 해당 없음」**을 그린다. 1편의 수문 자리, 3편의 영상 자리가 그렇다 —
   * 그 자리는 못 받은 것이 아니라 이 대본의 이야기에 없는 것이고, 다른 편에서는 실제로 온다.
   * 그 구분이 없으면 시연에서 "왜 여긴 비었냐"에 답할 수 없다.
   */
  axis?: ScenarioAxis;
  /** 목 렌더·scenario 모드에서 그릴 원래 화면. */
  children?: ReactNode;
};

function senderLines(spec: ReturnType<typeof pendingSource>) {
  return spec.from.map((sender) => `${sender.part} ${sender.id} ${sender.title}`);
}

/** 좁은 자리에서 툴팁으로 쓰는 한 덩어리 문구. 네 가지가 다 들어간다. */
function summaryText(spec: ReturnType<typeof pendingSource>): string {
  const from = spec.from.length === 0
    ? `누가 보내나: 상대 없음 — ${spec.missing ?? '회의 안건'}`
    : `누가 보내나: ${senderLines(spec).join(' → ')}`;
  return [
    spec.title,
    `무엇: ${spec.what}`,
    from,
    `우리 자리: ${spec.ours.join(' · ')}`,
    `경로: ${PLANE_LABEL[spec.plane]} — ${PLANE_NOTE[spec.plane]}`,
  ].join('\n');
}

export function PendingSource({ id, minHeight, fill, inline, entity, axis, children }: Props) {
  const spec = pendingSource(id);
  const mock = useMockRender();
  const scenarioCast = useScenarioCast();
  const axisCovered = useScenarioAxis(axis);

  if (mock) {
    return (
      <div className={inline ? 'mockwrap mockwrap--inline' : 'mockwrap'} data-pending={id}>
        {/* 지워지지 않는다. 목 렌더 중이라는 사실이 화면에서 사라지면 안 된다. */}
        <span className="mockwrap__badge" title={summaryText(spec)}>목 — 실제 데이터 아님</span>
        {children}
      </div>
    );
  }

  // 시나리오 모드 · 이 축을 대본이 몰지 않는다 — **「연결 예정」이 아니다** (요구 2의 넷째 상태).
  // 못 받은 것이 아니라 이 대본의 이야기에 없는 것이고, 어느 편에서 보이는지까지 적는다.
  if (axisCovered === false && axis !== undefined) {
    const elsewhere = scriptsWithAxis(axis);
    if (inline) {
      return (
        <span className="notinscript notinscript--inline" data-pending={id} title={summaryText(spec)}>
          <b>이 대본에는 해당 없음</b> <em>{AXIS_LABEL[axis]}</em>
        </span>
      );
    }
    return (
      <section className="notinscript" data-pending={id} style={minHeight === undefined ? undefined : { minHeight }}>
        <header>
          <span className="notinscript__mark">이 대본에는 해당 없음</span>
          <h3>{AXIS_LABEL[axis]} · {spec.title}</h3>
        </header>
        <p>
          {elsewhere.length === 0
            ? <>어느 대본도 몰지 않는 축입니다 — 평시 데이터({spec.from.map((sender) => sender.part).join('·') || '상대 미정'})가 줄 자리입니다.</>
            : <>{elsewhere.map((script) => script.missionId).join(' · ')} 에서 보입니다.</>}
        </p>
        <p className="notinscript__why">자리 크기는 그대로 둡니다 — 대본을 바꾸거나 일반 모드로 돌아가면 이 자리에 그대로 들어갑니다.</p>
      </section>
    );
  }

  // scenario 모드 — 대본 등장 장비에 한해 합성값을 그린다. 배지는 지워지지 않는다.
  // A/B 분류는 바뀌지 않는다 — 이 자리는 여전히 남이 줄 데이터이고, 지금 값은 대본의 합성본이다.
  if (scenarioCast !== null && entity !== undefined && scenarioCast.has(entity)) {
    return (
      <div className={inline ? 'scenariowrap scenariowrap--inline' : 'scenariowrap'} data-pending={id}>
        <span className="scenariowrap__badge" title={summaryText(spec)}>대본 — 합성 데이터</span>
        {children}
      </div>
    );
  }

  const noCounterpart = spec.from.length === 0;

  if (inline) {
    return (
      <span className="pending pending--inline" data-pending={id} title={summaryText(spec)}>
        <b>{spec.title}</b>
        <em>{spec.ours.join(' · ')}</em>
        {noCounterpart && <strong className="pending__missing">상대 없음 — 회의 안건</strong>}
      </span>
    );
  }

  return (
    <section
      className={fill ? 'pending pending--fill' : 'pending'}
      data-pending={id}
      style={minHeight === undefined ? undefined : { minHeight }}
    >
      <header className="pending__head">
        <span className="pending__mark">연결 예정</span>
        <h3 className="pending__title">{spec.title}</h3>
      </header>

      <dl className="pending__rows">
        <dt>무엇</dt>
        <dd>{spec.what}</dd>

        <dt>누가 보내나</dt>
        <dd>
          {noCounterpart ? (
            <>
              <strong className="pending__missing">상대 없음 — 회의 안건</strong>
              <span className="pending__why">{spec.missing}</span>
            </>
          ) : (
            <ol className="pending__from">
              {spec.from.map((sender) => (
                <li key={sender.id}>
                  <span className={`pending__part pending__part--${sender.part}`}>{sender.part}</span>
                  <code>{sender.id}</code> {sender.title}
                </li>
              ))}
            </ol>
          )}
        </dd>

        <dt>우리 자리</dt>
        <dd>
          {spec.ours.map((our) => <code key={our}>{our}</code>)}
          <span className="pending__why">받으면 그릴 준비가 되어 있다. 못 만든 것이 아니라 못 받은 것이다</span>
        </dd>

        <dt>경로</dt>
        <dd>
          <b>{PLANE_LABEL[spec.plane]}</b>
          <span className="pending__why">{PLANE_NOTE[spec.plane]}</span>
        </dd>
      </dl>
    </section>
  );
}
