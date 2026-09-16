import { useState, type ReactNode } from 'react';
import { viewNodeEntry } from '../canvas/registry.ts';
import { useZoomTarget } from '../canvas/zoomState.ts';
import { traceFor, useMission } from '../data/scenario.ts';
import { libraryEntry } from '../scenarios/library.ts';
import { nowPlaying } from '../scenarios/nowPlaying.ts';
import { issueCommand } from '../shared/commandEgress.ts';
import { ManualScope, type ManualScopeId } from '../shared/Explain.tsx';
import { SOURCE_WORDS, useNotifications } from '../shared/notifications.ts';
import { PendingSource } from '../shared/PendingSource.tsx';
import { exitScenarioRender, useDevTools, useMockRender, useScenarioRender } from '../shared/renderMode.ts';
import { useTabsDataLayer } from '../tabs/index.tsx';
import { ConnectionsPanel } from './ConnectionsPanel.tsx';
import { HelpOverlay } from './HelpOverlay.tsx';
import { useMissionBridge } from './missionBridge.ts';
import { ModeSwitch } from './ModeSwitch.tsx';
import { ApproachButton, PauseButton, ResumeButton, StopButton } from '../physical/StopButton.tsx';
import { MissionHistoryList } from '../views/MissionHistory.tsx';
import { ResetButton, RestartButton } from '../views/ResetButton.tsx';
import { robotProbe } from '../physical/robotClient.ts';
import { ConnectionLamp } from './ConnectionLamp.tsx';

/**
 * ## 2026-09-03 (3단계) — 탭 바가 사라졌다
 *
 * `activeTab` · `app-tabs` nav · `TabView` 라우팅이 **여기서 죽었다.** 무대는 하나뿐이고
 * 그것이 노드 캔버스다. 화면 넷은 캔버스에 놓인 뷰 노드의 **확대**로 들어간다.
 *
 * 탭에 매달려 있던 다섯 중 나머지 넷은 이렇게 옮겨 앉았다 (지시서 §3):
 *  - `useTabsDataLayer()` — **그대로 여기 남는다.** 앱 수명과 같아야 하고 탭과 무관했다.
 *  - `TabGate` — 죽고 `NodeGate`(노드 단위 접힘)가 됐다. 팔레트 버튼 흐림도 팔레트로 갔다.
 *  - `HelpOverlay(tab=activeTab)` — **확대가 열려 있으면 그 노드의 설명서**, 아니면 캔버스 것.
 *  - 대본 띠의 「○○로」 — **「○○ 노드로」**. 탭은 이미 있었지만 노드는 캔버스에 아직 없을
 *    수 있어서, 누르면 **없으면 만들고(진행 중인 태스크에 연결한 채로) 있으면 하이라이트**한다.
 *    사용자가 팔레트를 몰라도 배너가 가르쳐 주는 두 번째 진입점이다.
 */

const CONNECTION_LABEL: Record<string, string> = {
  open: '게이트웨이 연결됨',
  reconnecting: '재연결 중',
  connecting: '연결 중',
  closed: '연결 종료',
};

export function AppShell({ debuggerView, onDebuggerHome, onMissionHistory, onOpenNode }: {
  debuggerView: ReactNode;
  onDebuggerHome(): void;
  onMissionHistory(): void;
  /** 대본 띠의 「○○ 노드로」 — 캔버스에 요청만 넣는다. 셸은 캔버스 안을 모른다. */
  onOpenNode(kind: string, taskId: string | null): void;
}) {
  const [panel, setPanel] = useState<'history' | 'notifications' | 'connections' | null>(null);
  const notifications = useNotifications();
  // 데이터 계층은 앱 수명과 같다. **탭을 옮겨도 구독을 끊지 않는다** — 여기서 한 번만 기동한다.
  const connection = useTabsDataLayer();
  // 임무 축(plan 제안·trace_event) — 구역 축 구독에 딸려 오지 않아 셸이 따로 잇는다 (260831).
  useMissionBridge();
  // 남이 줄 데이터를 그릴지 말지. **기본은 자리표시**다 (shared/renderMode.ts).
  const mock = useMockRender();
  // 상단 바의 임무 이름 — 한 편이 박혀 있던 자리. 현재 임무 저장소를 본다 (260831).
  const mission = useMission();
  // 대본 띠 — 모드 스위치가 상태를 말해 주므로 **한 줄**이다 (사이트 개선 요구 4).
  const scenario = useScenarioRender();
  const scenarioEnded =
    scenario !== null && scenario.playing && mission.current.missionId === scenario.missionId && !mission.playing;
  const scenarioState = scenario === null ? '' : scenario.playing ? (scenarioEnded ? '재생 끝 — 마지막 상태' : '재생 중') : '정지 미리보기';
  // 「지금 무엇이 어디서 보이는지」 (260901 §3). 재생 머리 기준 진행 중인 노드와 갈 탭 —
  // **셸이 그린다.** 탭이 그리면 탭을 옮길 때 사라져서 「보면서 확인」이 성립하지 않는다.
  const now = scenario !== null && mission.current.missionId === scenario.missionId
    ? nowPlaying(mission.current, libraryEntry(mission.current.missionId)?.script ?? null, mission.headSec, mission.playing, traceFor(mission.current))
    : null;
  // 층 1(대본이 안 쓰는 것은 흐리게)은 **팔레트로 옮겨 갔다** — 흐려질 대상이 탭 버튼에서
  // 팔레트 버튼이 됐기 때문이다 (canvas/Palette.tsx).
  const closeScript = () => {
    // 게이트웨이가 재생을 멈추고 장치를 평시로 되돌린다. 실패해도 화면은 placeholder 로 복귀한다.
    void issueCommand({ action: 'script_close' }).catch(() => undefined);
    exitScenarioRender();
  };
  // 개발 도구(devpanel — 시나리오 재생 버튼·계약 확인·리렌더 카운터)는 목·개발 모드(또는
  // ? 오버레이의 토글)에서만 보인다 (260831 요구 1). CSS 한 규칙으로 여섯 자리를 다 가린다.
  const devTools = useDevTools();
  // 확대가 열려 있으면 `?` 는 **그 노드의 설명서**를 보인다 (지시서 §3). 캔버스 상태의
  // 원천은 하나(canvas/zoomState.ts)이고 셸은 읽기만 한다.
  const zoomTarget = useZoomTarget();
  const manualScope: ManualScopeId = (zoomTarget?.kind as ManualScopeId | undefined) ?? 'canvas';
  const openNode = (kind: string, taskId: string | null) => { onOpenNode(kind, taskId); setPanel(null); };
  return <main className={'app-shell' + (mock ? ' app-shell--mock' : '') + (devTools ? ' app-shell--dev' : '')}>
    {/* 배너 3종은 각각 **한 줄**이다 — 상태는 우상단 모드 스위치가 말한다. 목 배너의 경고만 남긴다. */}
    {mock && <div className="mock-banner" role="status">목 렌더 켜짐 — 남의 데이터 자리가 <b>전부 지어낸 값</b>입니다. 시연 전에 끄세요.</div>}
    {scenario !== null && <div className="scenario-banner" role="status">
      <span className="scenario-banner__head">
        대본 <b>{scenario.missionId}</b> 「{scenario.title}」 · <b>합성 데이터</b> · {scenarioState}
        {scenario.playing && !scenarioEnded && <> T+{Math.round(mission.headSec)}s</>}
        {' '}— cast 밖 장비는 자리표시
      </span>
      {now !== null && <span className="scenario-banner__now">
        <b>지금:</b> {now.text}
        {/* 「○○ 노드로」 — 없으면 만들고 있으면 하이라이트한다 (지시서 §3 ★). 이름의 원천은
            등록된 렌더러다(VZ-N-01) — 여기 손으로 적으면 팔레트와 갈라진다. */}
        {now.nodeKinds.map((kind) => <button key={kind} className="scenario-banner__goto" onClick={() => openNode(kind, now.taskId)}>{viewNodeEntry(kind)?.label ?? kind} 노드로</button>)}
      </span>}
      <button className="scenario-banner__close" onClick={closeScript}>대본 닫기</button>
    </div>}
    {scenario === null && mission.activatedBy === 'approval' && mission.current.world === 'legacy' && <div className="legacy-banner" role="status">
      구판 세계 대본(<b>{mission.current.missionId}</b>) — 구역 장비와 연결되지 않아 탭②~⑤는 따라 움직이지 않습니다 (7.8 예외)
    </div>}
    <header className="global-bar">
      <button className="mission-identity" onClick={onDebuggerHome}><b>{mission.current.missionId}</b><span>{mission.current.label}</span><small>통합 가시화 · 노드 캔버스</small></button>
      {/* 안내 문단 2줄은 우상단 `?` 오버레이로 옮겼다 (사이트 개선 요구 1). */}
      <nav>
        <ModeSwitch />
        <HelpOverlay scope={manualScope} />
        <span className={`conn conn--${connection.state}`}>{CONNECTION_LABEL[connection.state] ?? connection.state}{connection.state === 'reconnecting' ? ` (${connection.attempt}회)` : ''}</span>
        {/* **셋이 한 부품에서 온다** (260910). 전에는 여기서 게이트웨이로 `mission_pause` 를
            쏘고 그 옆에 실제로 동작하는 「중단」이 따로 있었다 — 같은 뜻의 버튼이 둘인데
            하나만 동작했다. 동작하는 쪽을 「정지」에 넣고 중단을 지웠다. */}
        <StopButton /><PauseButton /><ResumeButton /><ApproachButton /><ConnectionLamp onOpen={() => setPanel('connections')} /><button onClick={() => { setPanel('history'); onMissionHistory(); }}>◷ 임무 이력</button><button onClick={() => setPanel('notifications')}>알림 <b>{notifications.length}</b></button><RestartButton /><ResetButton /><button onClick={() => setPanel('connections')}>⇄ 연결 관리</button>
      </nav>
    </header>
    {/* 연결 관리는 폼이라 목록 판과 모양이 다르다 — 자기 부품이 그린다 (`VZ-C-07`). */}
    {panel === 'connections' && <ConnectionsPanel onClose={() => setPanel(null)} physical={robotProbe()} />}
    {panel !== null && panel !== 'connections' && <aside className="global-panel"><header><b>{panel === 'history' ? '임무 이력' : '통합 알림'}</b><button onClick={() => setPanel(null)}>닫기</button></header>{panel === 'history' ? <MissionHistoryList compact onReplay={() => { onMissionHistory(); setPanel(null); }} /> : notifications.length === 0
      /* **비어 있으면 비었다고 적는다** (260913 지시). 전에는 일어난 적 없는 두 줄이 늘
         박혀 있어서 뱃지가 언제나 「알림 2」였다. */
      ? <p className="notifications-empty">아직 올라온 알림이 없습니다</p>
      /* 어느 갈래·언제·무슨 일인지 셋을 한 줄에 둔다 (260913 지시). 문구는 온 값 그대로다. */
      : <ul className="notification-list">{notifications.map((item) => <li key={item.id} className={`is-${item.source}`}>
          <b>{SOURCE_WORDS[item.source] ?? item.source}</b>
          <time>{item.occurredAt.slice(11, 19)}</time>
          <span>{item.source === 'external-ai' ? <PendingSource id="ai-failure-alert" inline>{item.message}</PendingSource> : item.message}</span>
        </li>)}</ul>}</aside>}
    {/* 무대는 하나다 — 노드 캔버스. 감췄다 되살릴 다른 무대가 없으므로 `is-hidden` 도 없다.
        ManualScope 는 캔버스를 감싼다 — 확대된 노드의 설명서는 오버레이가 따로 감싼다. */}
    <section className="tab-stage">
      <ManualScope.Provider value="canvas">{debuggerView}</ManualScope.Provider>
    </section>
  </main>;
}
