/**
 * src/scenarios/scriptScope.ts (260901 — axes.ts 에서 갈라 나옴)
 *
 * **대본 목록에 묻는 것들** — 「이 축·이 노드·이 패널은 어느 편에서 살아나는가」.
 *
 * 규칙과 표는 옆의 `axes.ts` 하나에 있고, 여기는 그 규칙을 `SCRIPT_LIBRARY` 에 적용해
 * 답만 만든다. 갈라 둔 이유는 `verify:node-scope` 가 표를 Node 에서 직접 읽어야 하는데
 * 대본 목록이 JSON import 라 Node ESM 에서 그대로 열리지 않기 때문이다 — 검사가 표를
 * 손으로 베끼면 「두 곳에 적힌 같은 대응」이라는 이번 작업이 막으려던 실패로 되돌아간다.
 */

import {
  axesOfScript,
  nodeKindsOfScript,
  panelAlive,
  type ScenarioAxis,
  type ScenarioPanelSpec,
  type ViewNodeKindId,
} from './axes.ts';
import { SCRIPT_LIBRARY } from './library.ts';

/** 임무 id 로 축을 묻는다. 옛 편(legacy — 구판 세계)은 아무 축도 몰지 않는다. */
export function axesOfMission(missionId: string): ReadonlySet<ScenarioAxis> {
  const entry = SCRIPT_LIBRARY.find((candidate) => candidate.missionId === missionId);
  return entry?.script ? axesOfScript(entry.script) : new Set<ScenarioAxis>();
}

/** 이 축이 실제로 보이는 대본들 — 「해당 없음」 자리가 어느 편으로 가면 보이는지 안내할 재료. */
export function scriptsWithAxis(axis: ScenarioAxis): Array<{ missionId: string; title: string }> {
  return SCRIPT_LIBRARY
    .filter((entry) => entry.script !== null && axesOfScript(entry.script).has(axis))
    .map((entry) => ({ missionId: entry.missionId, title: entry.script?.title ?? entry.missionId }));
}

/** 이 뷰 노드가 살아나는 대본들 — 접힘 카드가 「그 대본으로 바꾸기」에 쓸 재료. */
export function scriptsUsingNode(kind: ViewNodeKindId): Array<{ missionId: string; title: string }> {
  return SCRIPT_LIBRARY
    .filter((entry) => entry.script !== null && nodeKindsOfScript(entry.script).has(kind))
    .map((entry) => ({ missionId: entry.missionId, title: entry.script?.title ?? entry.missionId }));
}

/** 이 패널이 살아나는 대본들. 노드가 아니라 패널 단위 — 3편의 장치·위험 노드는 살지만 구역 맵은 접힌다. */
export function scriptsUsingPanel(spec: ScenarioPanelSpec): Array<{ missionId: string; title: string }> {
  return SCRIPT_LIBRARY
    .filter((entry) => entry.script !== null && panelAlive(spec, axesOfScript(entry.script)))
    .map((entry) => ({ missionId: entry.missionId, title: entry.script?.title ?? entry.missionId }));
}
