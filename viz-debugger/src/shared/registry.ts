import { displayMission } from '../data/scenario.ts';
import type { Hardware } from '../model/types.ts';

/**
 * 모든 탭이 같은 배정 원천을 보도록 하는 레지스트리 경계.
 *
 * **탭①의 원천은 현재 임무 저장소이고, 탭②~⑤의 원천은 게이트웨이가 내려주는 레지스트리다.**
 * 화면이 임무의 hardware/cast 를 직접 읽으면 그 사실이 코드에서 보이지 않으므로
 * 탭①의 접근을 이 파일 하나로 모은다.
 *
 * 7.8 「두 세계」는 대본 재생(260831)에서 **registry.json 세계로 대본을 쓰는 방향**으로
 * 해소됐다 — 대본(world: 'registry')의 cast 는 registry.json 의 ID 그대로다
 * (실재 여부는 verify:script-library 가 대조한다 — 탭①이 registry.json 을 직접 읽으면
 * 단독 빌드에 대시보드 계층이 딸려 들어간다). 옛 편(MSN-260826-01)은 HCI 전달본이라
 * 손대지 않고 구판 세계의 예외로 남는다.
 */

/**
 * 현재 구역 (`VZ-I-03` · `VZ-C-05` — 설계 전제는 구역 1개).
 *
 * 뷰 노드의 `ViewScope.zoneId` 가 이 값을 쓴다 (260903). 탭②~⑤가 각자 `'zone-503'` 을
 * 손으로 적고 있었는데, 캔버스까지 넷째로 적으면 「두 곳이 갈라진다」가 그대로 난다 —
 * 레지스트리 경계인 이 파일 하나로 모은다.
 */
export const CURRENT_ZONE_ID = 'zone-503';

/**
 * 옛 편의 하드웨어 목록(실측값 7행). **대본에는 없다** — registry 세계 장비의 실측값은
 * 남이 줄 데이터라 지어내지 않고, 카드 3행은 자리표시다(8/31 결정 · VZ-D-07).
 */
export function listRegisteredHardware(): readonly Hardware[] {
  return displayMission().view.hardware ?? [];
}

/** 대본 등장 장비 id 목록. 옛 편이면 hardware 목록의 id 들과 같다. */
export function listCastIds(): readonly string[] {
  return displayMission().view.cast;
}

/** 이 목록이 어디서 왔는가. 화면이 목임을 감추지 않기 위해 표시한다. */
export function hardwareSourceLabel(): string {
  const { view } = displayMission();
  return view.world === 'registry'
    ? 'registry.json (목)'
    : `임무 시나리오 ${view.missionId} (목)`;
}
