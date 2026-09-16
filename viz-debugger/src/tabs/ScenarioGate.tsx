/**
 * src/tabs/ScenarioGate.tsx (260901 신설 — 시나리오가 탭을 끌고 가게)
 *
 * **층 2 — 패널 접힘.** 대본이 그 패널의 축을 몰지 않으면 **패널을 통째로 접는다.**
 *
 * 260903(3단계 — 탭 제거)에 판정 대상이 탭에서 **뷰 노드**로 옮겨 앉았다. 규칙은 그대로다:
 * 노드가 담은 패널이 하나도 안 살면 카드 본문을 한 장으로 갈음하고(`NodeGate`), 하나라도
 * 살면 개별 패널이 각자 접힌다(`PanelGate`). 팔레트 버튼은 흐려지되 **막지 않는다**.
 *
 * 8/31 작업은 연계를 **자리(slot) 층에서만** 했다. 「이 대본에는 해당 없음」 칩을 안쪽 칸에
 * 붙였지만 그 위의 제목·버튼 줄·표는 그대로 서 있었다 — 1편(로봇 이동)을 틀어도 탭③에
 * `actuator-01 · 수문 제어` 제목과 버튼 줄과 감사 표가 남아서, **로봇 이야기를 보는 사람
 * 앞에 수문이 있었다.** 칩 몇 개로는 그 인상이 지워지지 않는다. 뼈대를 없애야 한다.
 *
 * 규칙 셋.
 *  1. **시나리오 모드에서만 접는다.** 일반 모드는 지금처럼 전부 그린다 — 그게 「남이 줄
 *     데이터가 어디에 얼마나 있는지」를 보여 주는 화면이기 때문이다. 목·개발도 전부 그린다
 *     (목이 이긴다는 기존 규칙 그대로).
 *  2. **막지 않는다.** 접힌 자리에는 왜 없는지와 **어느 편에서 살아나는지**를 적고,
 *     그 대본으로 바꾸는 버튼을 둔다 — 모드 스위치와 **같은 경로**(enterScriptPreview)다.
 *  3. **자리 크기를 지키지 않는다.** 자리표시(PendingSource)와 반대다. 자리표시는 「나중에
 *     이 자리에 그대로 들어간다」를 보이려 크기를 유지하지만, 접힘은 「이 이야기에 없다」이므로
 *     자리를 비워 화면을 짧게 만드는 것이 맞다.
 */

import type { ReactNode } from 'react';
import { viewNodeEntry } from '../canvas/registry.ts';
import { panelAlive, panelsOfNode, scenarioPanel, type ViewNodeKindId } from '../scenarios/axes.ts';
import { enterScriptPreview } from '../scenarios/enterPreview.ts';
import { scriptsUsingNode, scriptsUsingPanel } from '../scenarios/scriptScope.ts';
import { useScenarioAxes, useScenarioRender } from '../shared/renderMode.ts';

type CardProps = {
  /** 「이 대본은 …을 쓰지 않습니다」의 목적어. */
  what: string;
  /** 왜 이 편에 없는가 — 한 줄씩. */
  why: string[];
  /** 이 자리가 살아나는 대본들. */
  elsewhere: Array<{ missionId: string; title: string }>;
  /** 노드 카드 전체를 대체하는 한 장인가 (패널 하나가 아니라). */
  wide?: boolean;
};

function NotInScriptCard({ what, why, elsewhere, wide }: CardProps) {
  const scenario = useScenarioRender();
  return (
    <section className={wide === true ? 'tabskip tabskip--wide' : 'tabskip'} data-scenario-skip={what}>
      <h2 className="tabskip__title">
        이 대본{scenario === null ? '' : `(${scenario.missionId})`}은 <b>{what}</b>을 쓰지 않습니다
      </h2>
      {why.map((line) => <p key={line} className="tabskip__why">{line}</p>)}
      {elsewhere.length === 0 ? (
        <p className="tabskip__where">어느 대본도 몰지 않는 자리입니다 — 평시 데이터가 채울 자리이고, <b>일반 모드</b>에서 누가 줄 데이터인지 볼 수 있습니다.</p>
      ) : (
        <ul className="tabskip__list">
          {elsewhere.map((script) => (
            <li key={script.missionId}>
              살아나는 편 — <code>{script.missionId}</code> 「{script.title}」
              {/* 모드 스위치의 대본 선택과 **같은 경로**다 (scenarios/enterPreview.ts). */}
              <button type="button" onClick={() => enterScriptPreview(script.missionId)}>그 대본으로 바꾸기</button>
            </li>
          ))}
        </ul>
      )}
      <p className="tabskip__back">일반 모드로 돌아가면 이 자리의 원래 화면이 그대로 보입니다.</p>
    </section>
  );
}

/**
 * 패널 하나의 접힘. `id` 는 `SCENARIO_PANELS` 의 것이어야 한다 — 없는 id 면 즉시 터진다
 * (조용히 안 접히는 것보다 낫다). `verify:node-scope` 가 화면과 표의 아귀를 검사한다.
 */
export function PanelGate({ id, children }: { id: string; children: ReactNode }) {
  // 일반·목·개발 모드에서는 axes 가 null 이다 — 전부 그린다. 접힘은 시나리오 모드에서만이다.
  const axes = useScenarioAxes();
  const spec = scenarioPanel(id);
  if (axes === null) return <>{children}</>;
  if (panelAlive(spec, axes)) return <>{children}</>;
  return <NotInScriptCard what={spec.title} why={[spec.why]} elsewhere={scriptsUsingPanel(spec)} />;
}

/**
 * **뷰 노드 하나의 접힘** (260903 — 탭 제거. `TabGate` 였다).
 *
 * 그 종류의 패널이 **하나도** 살지 않으면 노드 본문을 한 장으로 갈음한다 — 1·2편의 제어
 * 노드, 3편의 영상 노드가 그렇다. 하나라도 살면 본문을 그리고 개별 패널이 각자 접힌다.
 * 판정 규칙은 탭 시절과 **똑같다** — 판정 대상이 탭에서 노드로 옮겨 앉았을 뿐이다.
 *
 * **이름은 등록된 렌더러에서 얻는다** — 여기 손으로 적으면 팔레트 버튼과 접힘 카드가
 * 서로 다른 이름을 말하게 된다(`VZ-N-01`).
 */
export function NodeGate({ kind, children }: { kind: ViewNodeKindId; children: ReactNode }) {
  const axes = useScenarioAxes();
  if (axes === null) return <>{children}</>;
  const panels = panelsOfNode(kind);
  if (panels.length === 0 || panels.some((spec) => panelAlive(spec, axes))) return <>{children}</>;
  return (
    <NotInScriptCard
      wide
      what={viewNodeEntry(kind)?.label ?? kind}
      why={panels.map((spec) => spec.why)}
      elsewhere={scriptsUsingNode(kind)}
    />
  );
}
