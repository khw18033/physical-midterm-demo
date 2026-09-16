import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { registerViewNodes } from './canvas/registry.ts';
import { MissionDebugger, type DebuggerNavigation } from './main.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { PlanApproval, VIEW_NODE_RENDERERS } from './tabs/index.tsx';
import './style.css';

/**
 * **뷰 노드 렌더러 주입** (260903 — 노드 캔버스 1단계). `PlanApproval` 을 프롭으로 넣는
 * 것과 같은 경계다: 캔버스(`src/canvas/`)는 인터페이스만 알고, `tabs/` 의 실물은 통합
 * 빌드인 이 파일만 가져온다. 단독 빌드(`standalone.tsx`)는 이 줄이 없어 팔레트가 뜨지
 * 않는다 — 그래야 `tabs/data/` 스토어가 단독 번들에 딸려 들어가지 않는다
 * (`verify:standalone` · 논문 측정축 D).
 *
 * 렌더 전에 부른다. 등록이 늦으면 첫 프레임에 팔레트가 비어 보인다(구독하고 있어 곧
 * 따라오지만, 굳이 깜빡일 이유가 없다).
 */
registerViewNodes(VIEW_NODE_RENDERERS);

function IntegratedApp() {
  const [navigation, setNavigation] = useState<DebuggerNavigation>({ screen: 'milestones', requestId: 0 });
  const request = (screen: DebuggerNavigation['screen'], node?: DebuggerNavigation['node']) =>
    setNavigation((current) => ({ screen, node, requestId: current.requestId + 1 }));
  return <AppShell
    // VZ-U-07 승인·거부는 **탭① 안에서** 동작한다. 구 「임무 승인·진행」 탭이 통폐합된 자리다.
    // 프롭으로 주입하는 이유는 main.tsx 의 주석에 있다 (단독 빌드 오염 방지).
    debuggerView={<MissionDebugger navigation={navigation} planApproval={<PlanApproval />} />}
    onDebuggerHome={() => request('milestones')}
    onMissionHistory={() => request('replay')}
    // 대본 띠의 「○○ 노드로」 (260903 3단계). 셸은 캔버스 안을 모른 채 요청만 넣고,
    // 캔버스가 그 태스크의 마일스톤으로 옮겨 가 노드를 만들거나 하이라이트한다.
    onOpenNode={(kind, taskId) => request('node', { kind, taskId })} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><IntegratedApp /></StrictMode>);
