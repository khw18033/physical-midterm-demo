/**
 * src/scenarios/enterPreview.ts (260901 신설 — 시나리오 연계)
 *
 * **대본으로 들어가는 정지 미리보기 경로 하나.**
 *
 * 지금까지 이 네 단계(목 끄기 → 탭① 제안 성질로 올리기 → scenario 렌더 진입 →
 * 게이트웨이 `script_preview`)는 모드 스위치 안에만 있었다. 이번에 접힘 카드의
 * 「그 대본으로 바꾸기」가 같은 일을 하게 되면서 부르는 곳이 둘이 됐다 — 두 벌로 적으면
 * 한쪽만 고쳐져 조용히 갈라진다. 그래서 **여기 하나**로 뽑았다.
 *
 * **승인 선을 우회하지 않는다.** 이 경로는 「그린다」까지다(`playing: false`). 재생은
 * 여전히 VZ-U-07 승인 뒤이고, 그 사실이 대본 띠의 상태 문구로 구분되어 보인다.
 *
 * **나오는 길은 여기 없다.** 대본을 끄는 경로는 셸에만 있다 — 띠의 「대본 닫기」와 모드
 * 스위치의 「일반」 둘이고, 그 둘은 같은 길이다(verify:scenario-mode 가 그것을 검사한다).
 */

import { previewMission } from '../data/scenario.ts';
import { issueCommand } from '../shared/commandEgress.ts';
import { enterScenarioRender, setRenderMode } from '../shared/renderMode.ts';
import { SCRIPT_LIBRARY } from './library.ts';
import { axesOfMission } from './scriptScope.ts';

/** 대본 하나를 정지 미리보기로 올린다. 모르는 id 면 아무것도 하지 않는다(지어내지 않는다). */
export function enterScriptPreview(missionId: string): boolean {
  const entry = SCRIPT_LIBRARY.find((candidate) => candidate.missionId === missionId);
  if (!entry?.script) return false;
  setRenderMode('placeholder'); // 목 토글이 켜져 있었다면 끈다 — mock 이 이기므로.
  previewMission(missionId); // 탭① — 사건 0건, 전부 pending (승인 전과 같은 성질).
  enterScenarioRender({
    missionId,
    title: entry.script.title,
    cast: entry.script.cast,
    axes: axesOfMission(missionId),
    playing: false, // 정지 미리보기 — 재생 중이라고 적으면 안 된다.
  });
  // 게이트웨이 — 초기 조건 + t=0 프레임(장치 값이 그 대본의 출발점에 선다). 대상은 대본 임무다.
  void issueCommand({ action: 'script_preview', entity: missionId, params: { mission_id: missionId } }).catch(() => undefined);
  return true;
}
