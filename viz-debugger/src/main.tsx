import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  acceptProposal,
  displayMission,
  rejectProposal,
  useMission,
  type MissionMilestone,
  type MissionView,
} from './data/scenario.ts';
import { foldStatuses } from './data/fold.ts';
import { TaskGraph, type CanvasLayer } from './graph/TaskGraph.tsx';
import { Palette } from './canvas/Palette.tsx';
import { ZoomOverlay } from './canvas/ZoomOverlay.tsx';
import { viewNodeEntry } from './canvas/registry.ts';
import { viewScopeFor } from './canvas/scope.ts';
import { MISSION_SLOT } from './canvas/persist.ts';
import { useCanvas } from './canvas/useCanvas.ts';
import { setZoomTarget, useZoomTarget } from './canvas/zoomState.ts';
import type { ScenarioEvent, Task, TaskStatus } from './model/types.ts';
import { ObservabilityPanel } from './shared/ObservabilityPanel.tsx';
import { measureFold, startObservability } from './shared/observability.ts';
import { PendingSource } from './shared/PendingSource.tsx';
import { MissionHistoryList, useMissionEndWatch } from './views/MissionHistory.tsx';
import { hardwareSourceLabel, listCastIds, listRegisteredHardware } from './shared/registry.ts';
import { graphShape, shapeLabel } from './graph/shape.ts';
import { ActionModal } from './views/ActionModal.tsx';
import { DeviceStatusOverlay } from './views/DeviceStatusOverlay.tsx';
import { UtterancePanel } from './views/UtterancePanel.tsx';
import { StatusLegend } from './views/StatusLegend.tsx';
import './style.css';
import { Explain } from './shared/Explain.tsx';
import { emptyFill, reduceFrames, type ViewpointFill } from './viewpoint/fill.ts';
import { RobotPanel } from './physical/RobotPanel.tsx';
import { useRobotUplink } from './physical/robotBridge.ts';
import { useDetectUplink } from './detect/useDetect.tsx';
import { HardwareLink } from './physical/HardwareLink.tsx';
import { robotClient } from './physical/robotClient.ts';
import { framesUpTo } from './viewpoint/store.ts';
import { startMissionRecorder } from './record/recorder.ts';
import { useReplayTarget } from './record/replayMode.ts';

type Screen = 'milestones' | 'graph' | 'detail' | 'replay' | 'failure';

/**
 * 한 편(MSN-260826-01)에 맞춰 손으로 적혀 있던 값들 — 되감기 시각(41·95) · 마일스톤 수(7건) ·
 * 배정 대상(MS-C) · 실패 태스크(T-35) — 은 전부 현재 임무 저장소에서 파생한다 (260831).
 * 화면 구조는 HCI 전달본 그대로다.
 */

/**
 * 되감기 타임라인의 한 줄. **접는 대상은 기록 열이다** (260904) — 전까지는 대본
 * (`view.events`)을 그려서, 아직 오지 않은 사건까지 미리 칠해져 있었다.
 */
function timelineSegments(view: MissionView, trace: readonly ScenarioEvent[], taskId: string) {
  const events = trace.filter((event) => event.nodeId === taskId);
  const points = events[0]?.atSec === 0 ? events : [{ atSec: 0, status: 'pending' as const }, ...events];
  return points.map((point, index) => ({ status: point.status, start: point.atSec, end: points[index + 1]?.atSec ?? view.durationSec }));
}

/**
 * 사람 조작 줄 (260904 · `VZ-D-08`). 태스크 줄과 **같은 축**에 찍힌다 — 「모든 조작은
 * `produced_by=human` 으로 기록된다」가 화면에서 확인되는 자리다.
 *
 * 조작은 구간이 아니라 **순간**이라 태스크 줄처럼 칠하지 않고 점으로 찍는다. 대상이
 * 태스크가 아니라 장비·임무인 경우가 대부분이라(`recordHuman` 의 nodeId) 태스크 줄에
 * 얹으면 그 태스크가 그때 무슨 상태였는지를 거짓으로 만든다.
 */
function humanMarks(trace: readonly ScenarioEvent[]) {
  return trace.filter((event) => event.producedBy === 'human');
}

/**
 * AI 가 만든 것의 줄 (260907 · 9단계 · `VZ-G-01`). 사람 줄과 **같은 축**에 찍힌다 —
 * 「이 임무는 누가 만들었나 → 누가 받아들였나」가 한 화면에서 위아래로 읽힌다.
 *
 * 빈 줄로 두지 않는다. 없으면 「없다」고 적는다 — 사람 줄과 같은 규칙이다.
 */
function aiMarks(trace: readonly ScenarioEvent[]) {
  return trace.filter((event) => event.producedBy === 'ai');
}

function Milestones({ view, phase, milestoneStatuses, assignments, onAssign, onOpen, planApproval }: {
  view: MissionView;
  phase: 'proposal' | 'playing' | 'idle';
  milestoneStatuses: Record<string, TaskStatus>;
  assignments: Record<string, string[]>;
  onAssign(id: string, hardware: string): void;
  onOpen(id: string): void;
  planApproval?: ReactNode;
}) {
  const hardware = listRegisteredHardware();
  const cast = listCastIds();
  const mission = useMission();
  /**
   * 더블클릭으로 연 **대상 상태** (260904 — `VZ-D-07` 의 미구현분). 카드가 드래그로 배정만
   * 되고 눌러도 아무 일이 없었다. **문자열 하나다** — 배열이면 둘이 열리고, 둘이 열리면
   * 분할 화면이고, 분할 화면은 곧 탭이 된다 (`VZ-N-05` 와 같은 규칙).
   */
  const [statusDeviceId, setStatusDeviceId] = useState<string | null>(null);
  // 승인·거부는 **마일스톤 목록 위 제안 카드 안**에 있다 (260901). 통합 빌드는 이 슬롯에
  // PlanApproval(근거 4층 + 승인·거부)이 들어오고, 단독 빌드는 로컬 재생기용 폴백이 들어온다 —
  // **같은 자리**다. 근거의 「구간별 계획」이 「아래 마일스톤과 같음」이라고 적으므로
  // 카드는 목록보다 위에 있어야 한다.
  // 모델이 낸 제안은 **재생할 것이 없다** — 대본이 아니라 계획이라 사건이 0건이다.
  // 그래서 버튼 문구가 다르다. 「재생 시작」이라고 적어 두면 눌러도 아무 일이 없고,
  // 그때 사용자는 승인이 실패했다고 읽는다.
  const aiProposal = mission.proposal?.origin === 'ai' ? mission.proposal : null;
  const approvalSlot = planApproval ?? (mission.proposal !== null && <div className="proposal-fallback">
    {/* 단독 빌드(게이트웨이 없음)의 승인 자리 — 통합 앱에서는 PlanApproval(VZ-U-07)이 들어온다. */}
    <p>{aiProposal ? 'AI 제안' : '대본 제안'} <code>{mission.proposal.missionId}</code> — 승인해야 {aiProposal ? '캔버스에 올라갑니다' : '재생이 시작됩니다'} (VZ-U-07 · 로컬 재생기)</p>
    {/* **승인의 문은 하나다** (`acceptProposal`). 종류마다 부르는 곳이 다르면 언젠가 한쪽만 검사가 붙는다. */}
    <button onClick={() => acceptProposal('local')}>{aiProposal ? '승인 — 캔버스에 올린다' : '승인 — 재생 시작'}</button>
    <button onClick={() => rejectProposal()}>거부</button>
  </div>);
  const showApproval = phase === 'proposal' || planApproval !== undefined;
  return <div className="milestone-layout"><UtterancePanel fallbackText={view.utteranceText} /><section className="milestone-panel"><h2>마일스톤 · {view.milestones.length}건</h2>
    <RobotPanel client={robotClient()} />
    {showApproval && <div className="proposal-card">
      {phase === 'proposal' && (aiProposal
        ? <p className="proposal-note proposal-ai"><b>AI 제안</b> — <code>{aiProposal.provenance.model}</code> 이 만든 임무 {view.missionId} 「{view.label}」. 승인 전에는 아무것도 실행되지 않습니다
            <small>규칙 {aiProposal.provenance.rules?.length ?? 0}개 · 프롬프트 {aiProposal.provenance.promptDigest ?? '없음(스텁)'} · 근거는 발화 패널에 폅니다</small></p>
        : <p className="proposal-note"><b>제안 상태</b> — 대본 {view.missionId} 「{view.label}」. 승인 전에는 아무것도 재생되지 않습니다{mission.proposal?.origin === 'script' && mission.proposal.keywords.length ? <small>맞은 키워드: {mission.proposal.keywords.join(' · ')}</small> : null}</p>)}
      {approvalSlot}
    </div>}
    <div className="milestone-list">{view.milestones.map((item) => <button key={item.id} className={`milestone state-${milestoneStatuses[item.id] ?? 'pending'}`} onClick={() => onOpen(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onAssign(item.id, event.dataTransfer.getData('text/plain'))}><b>{item.id}</b><strong>{item.title}</strong><span>{(assignments[item.id] ?? item.assignedTargets).join(' · ') || '미배정'}</span><small>클릭 → 태스크 그래프</small></button>)}</div></section>
    <aside className="hardware-panel"><h2>하드웨어 · {view.hardware ? hardware.length : cast.length}대</h2><p>카드를 마일스톤으로 드래그 · <b>더블클릭 → 대상 상태</b> · 원천 {hardwareSourceLabel()}</p>
    {view.hardware
      ? hardware.map((item) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)} onDoubleClick={() => setStatusDeviceId(item.id)}><b className={item.connection}>{item.id}</b><small>{item.kind}</small><span><PendingSource id="hardware-pool-status" inline>{item.connection} · {item.battery}% · {item.rssi} dBm</PendingSource></span></article>)
      // 대본(registry 세계) — 등장 장비는 id 만 대본에서 읽는다. 실측 3행은 여전히 자리표시다
      // (VZ-D-07 · 8/31 결정 — registry 장비의 실측값은 남이 줄 데이터라 지어내지 않는다).
      // 대본(registry 세계) — 등장 장비는 id 만 대본에서 읽는다. 연결 상태는 **아는 만큼**
      // 적고(260910 지적), 실측 두 행(배터리·RSSI)은 여전히 자리표시다 — 로봇이 그 값을
      // 보내 주는 채널이 아직 없다(VZ-D-07 · 8/31 결정: 남이 줄 데이터는 지어내지 않는다).
      : cast.map((id) => <article key={id} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', id)} onDoubleClick={() => setStatusDeviceId(id)}><b>{id}</b><small>대본 등장 장비</small><HardwareLink entityId={id} /></article>)}</aside>
    {/* 대상 상태 (260904). 목록의 **형제**로 얹힌다 — 뒤의 마일스톤·하드웨어 목록은
        언마운트되지 않으므로 닫으면 정확히 같은 자리다 (VZ-N-05 와 같은 규칙). */}
    {statusDeviceId !== null && <DeviceStatusOverlay
      deviceId={statusDeviceId}
      device={hardware.find((item) => item.id === statusDeviceId)}
      source={hardwareSourceLabel()}
      onClose={() => setStatusDeviceId(null)} />}</div>;
}

function ReplayControls({ second, following, playing, onChange, onFollow, view, trace, tasks }: {
  second: number; following: boolean; playing: boolean;
  onChange(value: number): void; onFollow(): void; view: MissionView;
  /** 되감기가 보는 것은 대본이 아니라 **흘러온 기록**이다 (260904). */
  trace: readonly ScenarioEvent[];
  tasks: Task[];
}) {
  const shown = Math.min(view.durationSec, Math.round(second));
  const human = humanMarks(trace);
  const ai = aiMarks(trace);
  /**
   * 축의 길이. **0으로 나누지 않는다** — 모델이 낸 임무는 `durationSec` 이 0이다
   * (재생할 사건이 없다). 나눠 버리면 눈금 위치가 전부 `NaN%` 가 되고, 그것은 CSS 에서
   * 조용히 무시되어 「눈금이 왜 안 보이지」로 끝난다.
   */
  const span = Math.max(1, view.durationSec);
  return <section className="replay-controls"><div><button onClick={() => onChange(0)}>◀◀</button><button onClick={() => onChange(Math.max(0, shown - 1))}>◀</button><button onClick={() => onChange(Math.min(view.durationSec, shown + 1))}>▶</button><b>{shown}s / {view.durationSec}s</b>
    {/* 재생 중에는 머리를 따라가고, 뒤로 끌면 그 시점을 그린다. 재생이 끝나면 그냥 되감기 도구다. */}
    {playing && (following
      ? <b className="follow-live">● 따라가는 중</b>
      : <button className="follow-live" onClick={onFollow}>▶ 따라가기 (live)</button>)}
  </div><input aria-label="임무 재생 시각" type="range" min="0" max={view.durationSec} value={shown} onChange={(event) => onChange(Number(event.target.value))} /><div className="timelines">{tasks.map((task) => <div key={task.id}><code>{task.id}</code><span className="timeline">{timelineSegments(view, trace, task.id).map((segment, index) => <em key={`${segment.start}-${index}`} className={`state-${segment.status}`} style={{ width: `${(segment.end - segment.start) / span * 100}%` }} />)}<i style={{ left: `${shown / span * 100}%` }} /></span></div>)}
    {/* AI 줄 — 이 임무를 무엇이 만들었나 (260907 · `VZ-G-01` 역추적). 사람 줄 바로 위다. */}
    <div className="timeline-ai"><code>AI</code><span className="timeline">{ai.map((event) => <b key={event.seq} className="ai-mark" style={{ left: `${Math.min(1, event.atSec / span) * 100}%` }} title={`T+${Math.round(event.atSec)}s · ${event.kind} → ${event.nodeId} (produced_by=ai · ${String((event.payload as { model?: unknown } | undefined)?.model ?? '모델 미상')})`} />)}<i style={{ left: `${shown / span * 100}%` }} /></span><small>{ai.length === 0 ? '생성 기록 없음 (대본에서 읽은 임무입니다)' : `${ai.length}건 · produced_by=ai`}</small></div>
    {/* 사람 조작 줄 — 없으면 「아직 없다」고 적는다. 빈 줄은 「기록을 안 한다」로 읽힌다. */}
    <div className="timeline-human"><code>사람</code><span className="timeline">{human.map((event) => <b key={event.seq} className="human-mark" style={{ left: `${Math.min(1, event.atSec / span) * 100}%` }} title={`T+${Math.round(event.atSec)}s · ${event.kind} → ${event.nodeId} (produced_by=human)`} />)}<i style={{ left: `${shown / span * 100}%` }} /></span><small>{human.length === 0 ? '조작 기록 없음' : `${human.length}건 · produced_by=human`}</small></div></div></section>;
}

/**
 * 노드 분화(260831) 이후 그래프의 **보기 범위.**
 * 분기·합류는 대부분 마일스톤을 건넌다 — 1편의 합류(T-15a ← MS-D 셋)도, 2편의
 * 되돌아감(MS-F → MS-C)도. 그래서 「임무 전체」 보기를 둔다. 기본은 여전히 마일스톤이다 —
 * HCI 전달본의 화면 흐름(마일스톤 클릭 → 그 마일스톤의 그래프)을 지킨다.
 */
export type GraphScope = 'milestone' | 'mission';

function GraphScreen({ screen, view, trace, milestone, tasks, headSec, playing, scope, onScope, refEdges, crossing, viewpoints, viewpointFill, onOpen, onBack, onGraph, openTask, nodeRequest, onMilestone }: {
  screen: Screen; view: MissionView; milestone: MissionMilestone | null; tasks: Task[];
  /** 이전 · 다음 마일스톤으로 (260914 지시). 태스크가 있는 마일스톤만 오간다. */
  onMilestone(id: string): void;
  /** 흘러온 기록 열. 접기·되감기·타임라인이 전부 이것만 본다 (260904). */
  trace: readonly ScenarioEvent[];
  headSec: number; playing: boolean;
  scope: GraphScope; onScope(value: GraphScope): void;
  refEdges: MissionView['refEdges']; crossing: MissionView['refEdges'];
  viewpoints: MissionView['viewpoints'];
  viewpointFill: ViewpointFill | null;
  onOpen(task: Task, failed: boolean): void;
  /** 이동 경로의 「마일스톤」 칸 (260901). 되돌아갈 길이 화면에 없으면 없는 길이다. */
  onBack(): void;
  /** 가운데 칸 — 지금 보고 있는 그래프로. 액션 팝업이 열려 있으면 닫힌다. */
  onGraph(): void;
  /** 마지막 칸은 액션 아이템 팝업이 열려 있을 때만 나온다. */
  openTask: Task | null;
  /**
   * 대본 띠의 「○○ 노드로」 (260903 3단계). **없으면 만들고, 있으면 하이라이트한다.**
   * 탭 시절에는 갈 곳이 이미 있어 이동만 하면 됐지만 노드는 캔버스에 아직 없을 수 있다.
   */
  nodeRequest: { kind: string; taskId: string | null; requestId: number } | null;
}) {
  const replay = screen === 'replay'; const failure = screen === 'failure';
  /** 저장된 판을 다시 보는 중이면 그 판 (260914). 머리줄에 어느 판인지 적는다. */
  const recorded = useReplayTarget();
  /** 되감기 위치. null 이면 재생 머리를 따라간다(live). */
  const [override, setOverride] = useState<number | null>(null);
  useEffect(() => setOverride(null), [view.missionId, screen]);
  const second = replay ? (override ?? headSec) : headSec;
  /**
   * 노드 캔버스 (260903 — 1단계). **슬롯은 지금 보고 있는 범위**다 — 마일스톤 하나면 그
   * 마일스톤, 「임무 전체」면 별도 슬롯(`__mission__`). 마일스톤별 저장만으로는 임무 전체
   * 보기의 구성이 미아가 된다 (`VZ-N-04`).
   */
  const slot = scope === 'mission' ? MISSION_SLOT : milestone?.id ?? MISSION_SLOT;
  const canvas = useCanvas(view.missionId, slot, tasks);
  /** 팔레트가 뷰 노드를 붙일 태스크. 범위가 바뀌면 고르기를 푼다. */
  const [pickedTaskId, setPickedTaskId] = useState<string | null>(null);
  useEffect(() => setPickedTaskId(null), [slot, view.missionId]);
  const picked = tasks.find((task) => task.id === pickedTaskId) ?? null;
  /**
   * 확대된 뷰 노드 (260903 2단계 · `VZ-N-05`). **`activeTab` 류가 아니다** — 「몇 번째 탭」이
   * 아니라 「어느 노드」이고, 값이 하나라 한 번에 하나만 열린다(지시서 §6).
   *
   * 3단계에 **모듈 저장소로 올렸다**(`canvas/zoomState.ts`) — 셸의 `?` 설명서가 「확대가
   * 열려 있으면 그 노드의 설명서」를 보여야 하는데, 상태를 양쪽에 복제하면 갈라진다.
   * 범위를 옮기면(다른 마일스톤·임무) 그 노드가 화면에 없으므로 함께 닫는다.
   */
  const zoomTarget = useZoomTarget();
  const zoomedId = zoomTarget?.id ?? null;
  const setZoomedId = (id: string | null) => {
    const node = id === null ? null : canvas.nodes.find((item) => item.id === id) ?? null;
    setZoomTarget(node === null ? null : { id: node.id, kind: node.kind });
  };
  useEffect(() => { setZoomTarget(null); }, [slot, view.missionId]);
  // 그래프를 떠나면(마일스톤 목록으로) 확대도 함께 닫는다 — 뒤에 캔버스가 없으면 오버레이만 남는다.
  useEffect(() => () => setZoomTarget(null), []);
  const zoomedNode = canvas.nodes.find((node) => node.id === zoomedId) ?? null;
  const zoomedEntry = zoomedNode === null ? null : viewNodeEntry(zoomedNode.kind);

  /**
   * 안내줄이 가리킨 노드 — 잠깐 반짝인다. 만들어 주고 어디 생겼는지 말하지 않으면
   * 사용자가 캔버스를 훑어야 한다.
   */
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  useEffect(() => {
    if (highlightedId === null) return;
    const timer = setTimeout(() => setHighlightedId(null), 2600);
    return () => clearTimeout(timer);
  }, [highlightedId]);

  /**
   * 「○○ 노드로」 — **없으면 만들고(진행 중인 태스크에 연결한 채로), 있으면 하이라이트한다.**
   * 사용자가 팔레트를 몰라도 배너가 가르쳐 주는 두 번째 진입점이다 (지시서 §3 ★).
   *
   * **두 걸음으로 나눈 이유**: 안내줄이 가리키는 태스크가 지금 보고 있는 마일스톤 **밖**일
   * 수 있다. 그때 셸의 요청 한 번이 마일스톤 이동과 노드 요청을 함께 일으키는데, 이동 직후
   * 첫 렌더에는 `canvas.nodes` 가 아직 **옛 마일스톤의 구성**이다. 거기서 바로 판정하면
   * 「이미 있다」를 잘못 읽어 아무것도 안 뜬다. 그래서 요청을 일단 세워 두고(pending),
   * 캔버스 구성이 그 슬롯 것으로 바뀐 다음 렌더에서 처리한다.
   */
  const requestSeen = useRef(0);
  const [pendingNode, setPendingNode] = useState<{ kind: string; taskId: string | null } | null>(null);
  useEffect(() => {
    if (nodeRequest === null || nodeRequest.requestId === requestSeen.current) return;
    requestSeen.current = nodeRequest.requestId;
    setPendingNode({ kind: nodeRequest.kind, taskId: nodeRequest.taskId });
  }, [nodeRequest?.requestId]);
  useEffect(() => {
    if (pendingNode === null) return;
    // 같은 종류가 이미 있으면 만들지 않는다 — 누를 때마다 카드가 쌓이면 캔버스가 금세 지저분해진다.
    const existing = canvas.nodes.find((node) => node.kind === pendingNode.kind) ?? null;
    // 그 태스크가 지금 범위 안에 있을 때만 연결한다. 밖이면 전역 노드가 된다(강등과 같은 규칙).
    const boundTask = tasks.some((task) => task.id === pendingNode.taskId) ? pendingNode.taskId : null;
    setHighlightedId(existing !== null ? existing.id : canvas.add(pendingNode.kind, boundTask));
    setPendingNode(null);
  }, [pendingNode, canvas.nodes, tasks]);
  const canvasLayer = useMemo<CanvasLayer>(() => ({
    nodes: canvas.nodes,
    entryOf: viewNodeEntry,
    // **재생 머리는 캔버스 전체가 같은 값을 쓴다** (`VZ-N-03`) — 되감기 중이면 그 시각이다.
    scopeOf: (taskId) => viewScopeFor(taskId, view, second),
    pickedTaskId: picked?.id ?? null,
    onPick: setPickedTaskId,
    onMove: canvas.move,
    onResize: canvas.resize,
    onBind: canvas.bind,
    onRemove: canvas.remove,
    zoomedId,
    onZoom: setZoomedId,
    highlightedId,
  }), [canvas.bind, canvas.move, canvas.nodes, canvas.remove, canvas.resize, highlightedId, picked, second, view, zoomedId]);
  // **기록 열이 자라면 다시 접는다** — 열은 덧붙일 때만 신원이 바뀌므로(TraceStore.snapshot)
  // 사건이 없는 렌더에서는 접지 않는다.
  const folded = useMemo(() => measureFold(() => foldStatuses(second, view, trace)), [second, trace, view]);
  const failedTask = tasks.find((task) => folded.tasks[task.id]?.status === 'failed') ?? null;
  /**
   * 머리줄이 적을 **이 임무 자신의 모양** (260904). 고정 문구(「분기와 합류가 있는 태스크
   * DAG」)는 대본에 따라 거짓이었다 — 3편은 합류가 하나도 없다. 트리는 언급하지 않는다:
   * 배치 모드 토글이 없어졌고, 없는 기능을 설명하면 "그게 뭔데?"가 생긴다 (§7.10).
   */
  const shape = useMemo(() => graphShape(tasks, refEdges), [refEdges, tasks]);
  const title = scope === 'mission'
    ? `${view.label} · 임무 전체 ${tasks.length}노드`
    : milestone === null ? view.label : `마일스톤 ${milestone.id.replace(/^MS-/, '')} · ${milestone.title}`;
  /**
   * 이동 경로 (260901 — 후속 3건 요구 1).
   *
   * 탭①의 이동은 마일스톤 → 그래프 → 액션 아이템 한 방향뿐이었다. 그래프에서 마일스톤으로
   * 돌아가는 길은 상단 공통 바의 임무 이름 버튼 하나였는데 그게 「마일스톤으로 돌아가기」라는
   * 것을 화면 어디에도 적어 두지 않았다 — **발견할 수 없는 길은 없는 길이다.**
   *
   * 되감기·실패 화면(replay·failure)도 이 컴포넌트라 같이 풀린다. 그 둘도 똑같이 갇혀 있었다.
   */
  const here = scope === 'mission' ? `임무 전체 ${tasks.length}노드` : milestone === null ? view.label : `${milestone.id} ${milestone.title}`;
  const crumbs = <nav className="crumbs" aria-label="이동 경로">
    {/* 항상 있고 항상 눌린다. 사용자가 요구한 되돌아가기가 이것이다. */}
    <button type="button" className="crumbs__link" onClick={onBack}>마일스톤</button>
    <span className="crumbs__sep" aria-hidden="true">›</span>
    {openTask === null
      ? <span className="crumbs__here">{here}</span>
      : <button type="button" className="crumbs__link" onClick={onGraph}>{here}</button>}
    {openTask !== null && <><span className="crumbs__sep" aria-hidden="true">›</span><span className="crumbs__here">{openTask.id} {openTask.title}</span></>}
  </nav>;
  /**
   * **이전 · 다음 마일스톤** (260914 지시 — 「메인 화면으로 나가서 마일스톤을 골라야 했다」).
   *
   * 머리줄 가운데에 둔다. 태스크가 없는 마일스톤(옛 편의 MS-A·B 등)은 그래프가 비므로 건너뛴다 —
   * 그래프에 들어갈 마일스톤을 고르는 규칙(`graphMilestone`)과 같다. 「임무 전체」로 보고 있으면 오갈
   * 마일스톤이 없으므로 누르면 그 마일스톤 보기로 돌아간다.
   */
  const steppable = view.milestones.filter((item) => view.tasks.some((task) => task.milestone === item.id));
  const at = milestone === null ? -1 : steppable.findIndex((item) => item.id === milestone.id);
  const prevMilestone = at > 0 ? steppable[at - 1] : null;
  const nextMilestone = at >= 0 && at < steppable.length - 1 ? steppable[at + 1] : null;
  const goMilestone = (target: MissionMilestone | null) => {
    if (target === null) return;
    onMilestone(target.id);
    onScope('milestone');
  };
  const stepper = steppable.length > 1 && <nav className="milestone-stepper" aria-label="마일스톤 이동">
    <button type="button" disabled={prevMilestone === null} onClick={() => goMilestone(prevMilestone)}
      title={prevMilestone === null ? '첫 마일스톤입니다' : `${prevMilestone.id} ${prevMilestone.title}`}>
      ◀ 이전 마일스톤{prevMilestone !== null && <small>{prevMilestone.id}</small>}
    </button>
    <span className="milestone-stepper__at">{at >= 0 ? `${at + 1} / ${steppable.length}` : `– / ${steppable.length}`}</span>
    <button type="button" disabled={nextMilestone === null} onClick={() => goMilestone(nextMilestone)}
      title={nextMilestone === null ? '마지막 마일스톤입니다' : `${nextMilestone.id} ${nextMilestone.title}`}>
      {nextMilestone !== null && <small>{nextMilestone.id}</small>}다음 마일스톤 ▶
    </button>
  </nav>;
  return <div className={replay ? 'replay-layout' : ''}>{/* **손으로 쓴 네 줄이 실제 목록이 됐다** (260912 지시). 이 세션에서 끝난 판만
        쌓이고, 그 사실을 목록이 스스로 적는다. */}
    {replay && <aside className="history"><h2>임무 이력</h2><MissionHistoryList /></aside>}<section className="graph-panel"><header className="section-title section-title--graph"><div>{crumbs}<h2>{title}</h2><small>{replay ? `${recorded !== null ? `저장된 판 ${recorded.date}/${recorded.run} · ` : ''}리플레이 · T+${String(Math.round(second)).padStart(2, '0')}s` : failure ? (failedTask ? '실패 경로 강조 · 관련 없는 노드 흐림' : '이 대본에는 실패가 없습니다 — 결함 주입(REQ-1409)으로 만들 수 있습니다') : shapeLabel(shape)}</small></div>{stepper || <span />}<div className="toggle"><button className={scope === 'milestone' ? 'active' : ''} onClick={() => onScope('milestone')}>이 마일스톤</button><button className={scope === 'mission' ? 'active' : ''} onClick={() => onScope('mission')}>임무 전체</button></div></header><Palette canvas={canvas} pickedTaskId={picked?.id ?? null} pickedTaskTitle={picked?.title ?? null} /><TaskGraph tasks={tasks} hardware={listRegisteredHardware()} states={folded.tasks} selected={failure ? failedTask?.id : undefined} dimUnrelated={failure && failedTask !== null} refEdges={refEdges} viewpoints={viewpoints} viewpointFill={viewpointFill} onOpen={(task) => onOpen(task, folded.tasks[task.id]?.status === 'failed')} canvas={canvasLayer} />
    {/* 마일스톤 밖으로 나가는 되돌아감 — 적지 않으면 사용자는 루프의 존재를 모른다 (결정 2). */}
    {crossing.length > 0 && <p className="ref-crossing">↺ {crossing.map((edge) => `${edge.from} → ${edge.to} (${edge.label})`).join(' · ')} — 이 마일스톤 밖으로 되돌아갑니다 <button onClick={() => onScope('mission')}>임무 전체로 보기</button></p>}
    {replay && <ReplayControls second={second} following={override === null} playing={playing} onChange={setOverride} onFollow={() => setOverride(null)} view={view} trace={trace} tasks={tasks} />}<StatusLegend /><Explain id="dbg-1" className="hint">노드를 더블클릭하면 액션 아이템 상세를 엽니다. 실패 상태 노드는 수정 화면으로 이어집니다. 뷰 노드를 더블클릭하면 그 자리에서 확대됩니다 — 캔버스는 뒤에 그대로 있습니다.</Explain></section>
    {/* 확대 오버레이 (260903 2단계). **TaskGraph 의 형제**다 — 위에서 캔버스를 조건 없이
        그리고 여기에 얹기만 하므로, 확대해도 캔버스가 교체되지 않고 닫으면 같은 자리다. */}
    {zoomedNode !== null && zoomedEntry !== null && <ZoomOverlay entry={zoomedEntry} scope={viewScopeFor(zoomedNode.taskId, view, second)} taskId={zoomedNode.taskId} onClose={() => setZoomedId(null)} />}</div>;
}

/**
 * 셸 → 캔버스 요청 (260903 3단계에 `node` 가 늘었다).
 *
 * `node` 는 대본 띠의 「○○ 노드로」다 — 그 태스크가 든 마일스톤으로 데려간 다음, 캔버스에
 * 그 종류가 없으면 만들고 있으면 하이라이트한다. 셸은 캔버스 안을 모른 채 **요청만** 넣는다.
 */
export type DebuggerNavigation = {
  screen: 'milestones' | 'replay' | 'node';
  requestId: number;
  node?: { kind: string; taskId: string | null };
};

/**
 * `planApproval` — VZ-U-07 승인·거부 패널. **통합 셸이 프롭으로 넣는다.**
 *
 * 자리는 마일스톤 목록 **위**의 제안 카드다 (260901). 단독 빌드는 이 프롭을 받지 않고
 * 같은 자리에 로컬 승인 폴백을 그린다 — 통합·단독이 같은 슬롯을 쓴다.
 *
 * 여기서 직접 import 하지 않는 이유: 그 패널은 `tabs/data/` 의 스토어를 보는데,
 * 탭① 단독 빌드가 그걸 끌어오면 대시보드 데이터 계층이 통째로 딸려 들어와
 * 논문 측정축 D(계측 오버헤드)가 오염된다. 단독 빌드는 이 프롭을 주지 않고,
 * 그때는 제안에 로컬 승인 자리가 뜬다(위 Milestones 의 proposal-fallback).
 */

export function MissionDebugger({ navigation, planApproval }: { navigation?: DebuggerNavigation; planApproval?: ReactNode }) {
  useMission(); // 저장소 변화(제안·승인·재생 머리)에 다시 그린다.
  const display = displayMission();
  const view = display.view;

  const [screen, setScreen] = useState<Screen>('milestones');
  const [scope, setScope] = useState<GraphScope>('milestone');
  const [modalTask, setModalTask] = useState<Task | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [milestoneId, setMilestoneId] = useState<string | null>(null);
  /** 셸이 넣은 「○○ 노드로」 요청. 그래프 화면이 처리한다. */
  const [nodeRequest, setNodeRequest] = useState<{ kind: string; taskId: string | null; requestId: number } | null>(null);

  // 임무가 바뀌면(대본 승인) 한 편에 묶였던 화면 상태를 처음으로 되돌린다.
  useEffect(() => { setScreen('milestones'); setModalTask(null); setAssignments({}); setMilestoneId(null); setScope('milestone'); }, [view.missionId]);
  /**
   * **저장된 판을 열면 리플레이 화면의 임무 전체로** (260914). 위 효과 **뒤에** 둔다 — 다른 임무의
   * 판을 열면 같은 그리기에서 둘이 같이 돌고, 나중 것이 이긴다.
   */
  const recordedRun = useReplayTarget();
  useEffect(() => {
    if (recordedRun === null) return;
    setScreen('replay'); setModalTask(null); setScope('mission');
  }, [recordedRun?.loadSerial]);

  /**
   * 자체 관측 집계 (`VZ-O-04` · 260904). **두 빌드가 공유하는 이 화면**이 켠다 —
   * 셸이 켜면 단독 빌드에서 안 돌고, 축 D는 바로 그 단독 빌드에서 재는 숫자다.
   */
  useEffect(() => startObservability(), []);

  /**
   * **임무 기록** (260914 — 「새로고침하면 다 날아간다」). 판마다 저장소 루트 `mission-history/` 에
   * 쓴다. 여기 두는 이유는 위 관측과 같다 — 이 화면은 앱이 살아 있는 동안 안 사라진다.
   */
  useEffect(() => startMissionRecorder(), []);

  /**
   * **로봇 응답 수신** (260910). 여기 두는 이유는 위 관측과 같다 — 이 화면은 두 빌드가
   * 공유하고 앱이 살아 있는 동안 안 사라진다. 패널 안에 뒀다가 노드를 누르는 순간
   * 구독이 끊겨 `door_turn` 을 통째로 놓쳤다.
   */
  useRobotUplink(view.missionId, view.params);
  // 탐지도 같은 자리에서 받는다 (260912) — 상대가 있을 때만 묻는다.
  useDetectUplink(view.missionId, view.params);

  // 그래프에 들어갈 마일스톤 — 클릭한 것. 태스크가 없으면(옛 파일의 MS-A 등)
  // 태스크를 가진 마일스톤으로 간다(옛 편은 전부 MS-C라 기존 화면 그대로다).
  const graphMilestone = useMemo(() => {
    const hasTasks = (id: string) => view.tasks.some((task) => task.milestone === id);
    if (milestoneId !== null && hasTasks(milestoneId)) return view.milestones.find((m) => m.id === milestoneId) ?? null;
    return view.milestones.find((m) => hasTasks(m.id)) ?? view.milestones[0] ?? null;
  }, [milestoneId, view]);

  const graphTasks = useMemo(
    () => view.tasks
      .filter((task) => scope === 'mission' || task.milestone === graphMilestone?.id)
      .map((task) => assignments[task.milestone ?? '']?.length ? { ...task, target: assignments[task.milestone ?? ''][0] } : task),
    [assignments, graphMilestone, scope, view],
  );

  // 참조 엣지 — 보이는 범위 안에 양끝이 다 있으면 그리고, 밖으로 나가면 한 줄로 적는다.
  const graphTaskIds = useMemo(() => new Set(graphTasks.map((task) => task.id)), [graphTasks]);
  const visibleRefEdges = useMemo(
    () => view.refEdges.filter((edge) => graphTaskIds.has(edge.from) && graphTaskIds.has(edge.to)),
    [graphTaskIds, view],
  );
  const crossingRefEdges = useMemo(
    () => view.refEdges.filter((edge) => graphTaskIds.has(edge.from) !== graphTaskIds.has(edge.to)),
    [graphTaskIds, view],
  );
  /**
   * 8분할 묶음 (260909) — **여덟이 다 보일 때만** 넘긴다. 「이 마일스톤」으로 MS-B 를 보고
   * 있으면 여덟이 화면에 없고, 그때 원을 그릴 중심도 없다. 참조 엣지가 범위를 벗어나면
   * 안 그리는 것과 같은 규칙이다.
   */
  /**
   * 뷰포인트가 지금 어디까지 채워졌는가 (260909 §4). **재생 머리까지의 프레임을 처음부터
   * 다시 접는다** — 상태를 들고 있다가 이어 붙이면 슬라이더를 뒤로 끌었을 때 이미 켜진
   * 초록이 안 꺼진다. 되감기가 기존 노드와 같은 규칙으로 돌아야 한다.
   *
   * 대본을 아는 것은 `scriptFrames` 한 곳뿐이다 — 로봇이 붙는 날 그 자리만 갈아끼운다(§6).
   */
  const viewpointFill = useMemo(() => {
    const group = view.viewpoints;
    if (group === null) return null;
    // **흘러온 것만 접는다** — 대본(`view.viewpointTimeline`)이 아니라 열이다
    // (`src/viewpoint/store.ts` 머리말). 머리까지를 처음부터 다시 접으므로 되감기가
    // 기록 열과 같은 규칙으로 돈다.
    return reduceFrames(emptyFill(group.taskIds.length), framesUpTo(display.headSec));
  }, [view, display.headSec]);
  const visibleViewpoints = useMemo(() => {
    const group = view.viewpoints;
    if (group === null) return null;
    const whole = group.taskIds.every((id) => graphTaskIds.has(id)) && graphTaskIds.has(group.parentTaskId);
    return whole ? group : null;
  }, [graphTaskIds, view]);

  const trace = display.trace;
  const milestoneStatuses = useMemo(
    () => measureFold(() => foldStatuses(display.headSec, view, trace)).milestones,
    [display.headSec, trace, view],
  );

  /** 머리 시각의 접기 결과 — 실패 태스크를 찾는 두 자리가 같은 값을 본다. */
  const folded = useMemo(() => measureFold(() => foldStatuses(display.headSec, view, trace)), [display.headSec, trace, view]);

  /**
   * **한 판이 끝나면 이력에 한 줄** (260912 지시). 완료·실패·정지 셋 중 하나로 끝났을 때다.
   * 여기서 보는 이유는 접기 결과가 이 화면에 있기 때문이다 — 셸은 임무 구조를 모른다.
   */
  useMissionEndWatch(view, folded);

  const navigate = (next: Screen) => {
    setScreen(next);
    setModalTask(next === 'detail' ? graphTasks[0] ?? null : next === 'failure' ? graphTasks.find((task) => folded.tasks[task.id]?.status === 'failed') ?? null : null);
  };
  const openTask = (task: Task, failed: boolean) => { setModalTask(task); setScreen(failed ? 'failure' : 'detail'); };

  /**
   * **마일스톤이 끝나면 다음 마일스톤 그래프로 넘어간다** (260911 지시).
   *
   * 시연에서 MS-A 가 끝나면 발표자가 마일스톤 목록으로 돌아가 MS-B 를 다시 눌러야 했다.
   * 로봇은 이미 다음 걸음을 기다리는데 화면만 뒤에 있다.
   *
   * ## 이미 끝난 것을 열었을 때는 안 넘어간다
   *
   * 끝난 마일스톤을 되짚어 보려고 연 것인데 곧바로 다음으로 튀면 **되짚어 볼 수가 없다.**
   * 그래서 **열 때 안 끝나 있던 것이 끝났을 때만** 넘어간다.
   *
   * 한 박자 쉬고 넘어간다. 끝나자마자 화면이 바뀌면 무엇이 끝났는지 볼 틈이 없다.
   * 그 사이에 사람이 다른 데로 가면 취소된다.
   */
  const watching = useRef<string | null>(null);
  const currentMilestoneStatus = milestoneId === null ? null : milestoneStatuses[milestoneId] ?? 'pending';
  useEffect(() => {
    if (screen !== 'graph' || milestoneId === null) { watching.current = null; return; }
    // 열 때 이미 끝나 있었으면 이 마일스톤에서는 안 넘어간다.
    if (watching.current !== milestoneId) {
      watching.current = milestoneId;
      if (currentMilestoneStatus === 'done') return;
    }
    if (currentMilestoneStatus !== 'done') return;
    const order = view.milestones.map((item) => item.id);
    const next = order[order.indexOf(milestoneId) + 1];
    if (next === undefined) return;   // 마지막이면 그대로 둔다
    const timer = setTimeout(() => setMilestoneId(next), 1200);
    return () => clearTimeout(timer);
  }, [screen, milestoneId, currentMilestoneStatus, view]);
  useEffect(() => {
    if (!navigation) return;
    if (navigation.screen !== 'node') { navigate(navigation.screen); return; }
    // 「○○ 노드로」 — 진행 중인 태스크가 든 마일스톤의 캔버스로 데려간다. 그 태스크가 어느
    // 마일스톤인지는 여기서만 알 수 있다(셸은 임무 구조를 모른다).
    const request = navigation.node;
    if (request === undefined) return;
    const owner = view.tasks.find((task) => task.id === request.taskId) ?? null;
    if (owner?.milestone !== undefined) setMilestoneId(owner.milestone);
    setScope('milestone');
    navigate('graph');
    setNodeRequest({ ...request, requestId: navigation.requestId });
  }, [navigation?.requestId]);

  const firstFailed = graphTasks.find((task) => folded.tasks[task.id]?.status === 'failed') ?? null;

  return <div className="mission-debugger">{screen === 'milestones'
    ? <Milestones view={view} phase={display.phase} milestoneStatuses={milestoneStatuses} assignments={assignments} onAssign={(id, hardware) => setAssignments((current) => ({ ...current, [id]: [...new Set([...(current[id] ?? []), hardware])] }))} onOpen={(id) => { setMilestoneId(id); navigate('graph'); }} planApproval={planApproval} />
    : <GraphScreen screen={screen} view={view} trace={trace} milestone={graphMilestone} tasks={graphTasks} headSec={display.headSec} playing={display.phase === 'playing'} scope={scope} onScope={setScope} refEdges={visibleRefEdges} crossing={crossingRefEdges} viewpoints={visibleViewpoints} viewpointFill={viewpointFill} onOpen={openTask}
      // navigate() 를 쓴다 — 그것이 modalTask 정리까지 함께 한다. setScreen 을 직접 부르면 팝업이 남는다.
      // 범위도 함께 되돌린다: 「임무 전체」로 보다 목록으로 나갔다 다시 들어왔는데 전체로 남아 있으면 어리둥절하다.
      onBack={() => { setScope('milestone'); navigate('milestones'); }}
      onGraph={() => navigate('graph')}
      openTask={modalTask}
      nodeRequest={nodeRequest}
      onMilestone={setMilestoneId} />}
    {modalTask && <ActionModal task={modalTask} view={view} device={listRegisteredHardware().find((item) => item.id === modalTask.target)} failure={screen === 'failure'} onClose={() => { setModalTask(null); if (screen === 'detail') setScreen('graph'); }} />}
    {screen === 'failure' && !modalTask && firstFailed && <button className="failure-open" onClick={() => setModalTask(firstFailed)}>실패 수정 팝업 열기</button>}
    {/* 자체 관측 (VZ-O-04) — devpanel 이라 통합 셸에서는 목·개발 모드에서만 뜨고,
        단독 빌드(측정 장비)에서는 늘 보인다. 기본은 접힘이다. */}
    <ObservabilityPanel /></div>;
}
