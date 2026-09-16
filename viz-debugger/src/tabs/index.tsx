/**
 * src/tabs/index.tsx
 *
 * 이식한 화면들의 출입구. **통합 셸은 여기서만 import 한다.**
 *
 * 이 파일이 있는 이유는 셸이 이식한 화면들을 각각 알 필요가 없기 때문이고, 더 중요하게는
 * **단독 빌드가 이 경계 밖에 있다**는 것을 코드로 보이기 위해서다. `verify:standalone` 은
 * 단독 진입점의 의존 그래프에 `tabs/` 가 나타나면 실패한다.
 *
 * ## 2026-09-03 (3단계) — 탭이 사라졌다
 *
 * `TabView`(탭 본문 라우팅)와 `TabGate`(탭 단위 접힘)는 **여기서 죽었다.** 화면 넷은
 * 이제 뷰 노드의 **확대 본문**으로 들어간다(`viewNodes.tsx`) — 셸이 탭으로 고르는 것이
 * 아니라 사용자가 캔버스에 놓은 노드를 확대해서 본다.
 *
 * **폴더 이름은 `tabs/` 그대로 둔다.** 이 이름은 이제 「탭이었던 화면들」이 아니라
 * **「단독 빌드에 들어가면 안 되는 것들」**이라는 뜻이고, `verify:standalone` 이 그 경계를
 * 그 이름으로 검사한다. 바꾸면 검사·문서·보고서 열 곳이 한꺼번에 흔들린다.
 *
 * 데이터 계층 기동은 **여기 그대로 남는다** — 앱 수명과 같아야 하고 탭과 무관했다.
 * 끊으면 돌아왔을 때 화면이 비고, 평시 1분 주기 센서는 최대 1분간 빈 칸이 된다.
 */

import { useEffect } from 'react';
import { useAiFailureNotifications } from './aiFailureBridge.ts';
import { CURRENT_ZONE_ID } from '../shared/registry.ts';
import { startDataLayer } from './data/index.ts';
import { useConnectionStatus } from './data/hooks.ts';
import './views/styles.css';

export { PlanApproval } from './views/PlanApproval.tsx';

/**
 * 캔버스에 주입할 뷰 노드 4종 (260903). `PlanApproval` 과 **같은 경계**를 지난다 —
 * 통합 진입점만 이것을 가져가 `registerViewNodes()` 로 등록하고, 단독 빌드는 가져가지
 * 않는다(`verify:standalone` · `verify:view-nodes`).
 */
export { VIEW_NODE_RENDERERS } from './viewNodes.tsx';

/** 현재 설계 전제는 구역 1개 (VZ-C-05). 값은 레지스트리 경계 한 곳에 있다. */
const ZONE_ID = CURRENT_ZONE_ID;

/**
 * 데이터 계층 기동. **앱 수명과 같다** — 화면을 옮겨도 구독을 끊지 않는다.
 * 셸이 최상위에서 한 번 부른다. 두 번 불려도 `startDataLayer` 가 스스로 막는다.
 */
export function useTabsDataLayer() {
  useEffect(() => startDataLayer(ZONE_ID), []);
  // VZ-I-10 — 외부 AI 실패는 탭 하나가 아니라 **상단 공통 알림**으로 올라간다.
  useAiFailureNotifications();
  return useConnectionStatus();
}
