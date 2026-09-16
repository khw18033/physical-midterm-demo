/**
 * src/data/scenario.ts
 *
 * **현재 임무 저장소** (260831 — 대본 재생에서 개조).
 *
 * 통합 전에는 `MSN-260826-01.json` 한 편이 모듈 상수로 박혀 있었고, 되감기 시각(41·95)·
 * 마일스톤 수(7건)·배정 대상(MS-C)까지 그 한 편에 맞춰 손으로 적혀 있었다. 이제 이
 * 저장소가 「어느 대본이든」 현재 임무로 든다 — **기동 시 기본은 여전히 `MSN-260826-01`**
 * (HCI 전달본 그대로)이고, 대본이 승인되면 바뀐다.
 *
 * 세 가지 상태:
 *  - current  : 확정 임무. 화면이 이걸 그린다.
 *  - proposal : 발화가 대본에 매칭돼 **제안 상태**로 뜬 것 (VZ-U-07 · REQ-1506).
 *               승인 전에는 진행 사건이 하나도 없다 — 화면은 전부 pending 으로 그린다.
 *  - headSec  : 재생 머리. 게이트웨이의 trace_event 수신(통합) 또는 로컬 재생기(단독)가
 *               민다. 재생이 끝나면 durationSec 에 서고 슬라이더는 되감기 도구가 된다.
 *
 * **마일스톤 상태는 정적 필드가 아니라 태스크 상태를 접은 결과다** — `statusesAt()` 이
 * 태스크와 마일스톤을 함께 돌려준다. 옛 파일의 정적 status 는 무시하되 지우지 않고,
 * 태스크가 없는 마일스톤(옛 파일의 MS-A·B·D~G)만 그 값으로 그린다(접을 재료가 없다).
 *
 * 이 파일은 `tabs/` 를 import 하지 않는다 — 탭① 단독 빌드의 경계다(verify:standalone).
 *
 * ## 260904 — 화면이 접는 것이 대본에서 기록 열로 바뀌었다
 *
 * `view.events` 는 이제 **대본의 정의**다. 화면의 원천은 `data/trace.ts` 의 기록 열이고,
 * 거기에 넣는 길은 하나뿐이다(`appendTrace`). 이 파일에서 그 입구를 부르는 자리는 셋이다.
 *
 * | 부르는 자리 | 언제 | 무엇을 넣나 |
 * |---|---|---|
 * | `receiveTrace()` | 통합 빌드 — 게이트웨이 `trace_event` | 받은 봉투 |
 * | 로컬 재생기 (`activateMission(_, 'local')`) | 단독 빌드 — 게이트웨이 없음 | 대본을 시각까지 읽어 흘려보낸다 |
 * | `recordHuman()` | 화면에서 나가는 모든 명령 | `produced_by=human` (`VZ-D-08`) |
 *
 * 기동 직후(`activatedBy: 'boot'`)의 옛 편은 **이미 끝난 과거 임무의 기록**이라 열을 통째로
 * 채워 둔다 — 재생 머리가 처음부터 `durationSec` 에 서 있고 슬라이더가 되감기 도구인 것이
 * 그 뜻이다. 승인을 우회하는 것이 아니다: 승인 선(`VZ-U-07`)이 걸린 것은 **제안과
 * 정지 미리보기**이고, 그 둘은 열이 비어 있다.
 */

import { useSyncExternalStore } from 'react';
import { foldStatuses, type FoldedStatuses } from './fold.ts';
import { MergeScheduler } from './mergeScheduler.ts';
import { appendGenerated, appendHuman, appendTrace, resetTrace, traceEvents, traceMissionId } from './trace.ts';
import { scriptFrames } from '../viewpoint/source.ts';
import { appendViewpoint, resetViewpoint, type ArrivedFrame } from '../viewpoint/store.ts';
import { clearStarted, markApproved, resetRobotSession, robotDrives } from '../physical/robotSession.ts';
import { resetDetect } from '../detect/store.ts';
import { armMissionHistory, resetMissionHistory, sealRun } from './missionHistory.ts';
import { isReplayingRecord, leaveRecordReplay } from '../record/replayMode.ts';
import { armNotifications, resetNotifications } from '../shared/notifications.ts';
import { provenancePayload, type AiProvenance } from '../shared/provenance.ts';
import rawScenario from '../../scenarios/MSN-260826-01.json' with { type: 'json' };
import { libraryEntry } from '../scenarios/library.ts';
import type { ScriptMap, ScriptScenario, ScriptViewpointFrame, ScriptViewpoints } from '../scenarios/types.ts';
import type { Hardware, RefEdge, Scenario, ScenarioEvent, TaskStatus, Task } from '../model/types.ts';

export type { FoldedStatuses };
export { traceEvents, traceStats } from './trace.ts';

/** 옛 파일 원본. HCI 전달본·논문용 — 한 글자도 고치지 않는다(verify:scenario). */
export const scenario = rawScenario as Scenario;

/**
 * 로컬 재생 배속(단독 빌드). 게이트웨이의 VIZ_SCENARIO_SPEED 기본값과 같은 20이다 —
 * 대본마다·환경마다 다른 배속을 두면 둘을 비교할 때 축이 달라진다.
 */
export const LOCAL_SPEED = 20;

// ── 화면이 그리는 형태 ────────────────────────────────────────────────────────

export type MissionMilestone = {
  id: string;
  title: string;
  assignedTargets: string[];
  /** 옛 파일의 정적 status. 태스크가 없는 마일스톤의 마지막 근거다. 대본에는 없다. */
  staticStatus: TaskStatus | null;
};

export type MissionView = {
  missionId: string;
  /** 상단 바의 임무 이름 아래 한 줄. */
  label: string;
  world: 'registry' | 'legacy';
  utteranceText: string;
  durationSec: number;
  milestones: MissionMilestone[];
  /** milestone 필드가 반드시 채워져 있다 — 옛 파일은 전부 MS-C(태스크 7개가 다 그 소속). */
  tasks: Task[];
  /**
   * **대본의 정의**다 — 화면의 원천이 아니다 (260904). 로컬 재생기와 목 게이트웨이가 이걸
   * 읽어 기록 열로 흘려보내고, 화면은 흘러온 것만 접는다.
   */
  events: ScenarioEvent[];
  /** 뷰 노드에서 그려도 되는 장비. 옛 편은 hardware 목록의 id 들이다. */
  cast: string[];
  /** 옛 편만 있다. 대본(registry 세계)은 cast 로 그린다 — 실측값을 지어내지 않는다. */
  hardware: Hardware[] | null;
  /** 대본의 편별 상수(위험 수위 선 등). 화면이 읽는다. */
  params: Record<string, unknown>;
  /** 2편의 구역 맵(503호 평면·카메라 시야·사각지대 칸). 다른 편은 null — 맵이 없다고 적는다. */
  map: ScriptMap | null;
  /** 되돌아가는 참조 엣지 (260831 노드 분화). deps 가 아니다 — 그리기 전용. */
  refEdges: RefEdge[];
  /**
   * 8분할 뷰포인트 묶음 (260909). 선언한 편만 원형 배치를 받는다 — 나머지는 null 이고
   * 배치가 지금까지와 같다. `map` 과 같은 자리·같은 규칙이다.
   */
  viewpoints: ScriptViewpoints | null;
  /**
   * 뷰포인트 채널의 대본 (260909 §6). 화면은 이것을 **프레임으로 바꿔서만** 읽는다
   * (`src/viewpoint/source.ts`) — 노드 갱신 코드는 대본을 모른다.
   */
  viewpointTimeline: ScriptViewpointFrame[];
};

/**
 * **아무 임무도 없는 화면** (260910 지시 — 「비어 있는 걸 기본으로」).
 *
 * 부팅 기본값이 옛 편(MSN-260826-01)이었다. 그러면 앱을 열자마자 시연에서 쓰지도 않는
 * 구판 대본의 마일스톤 일곱과 **하드웨어 자리표시 일곱 장**이 뜬다 — 무대에 올라 처음
 * 보이는 화면이 그것이었다. 발화를 넣으면 넘어가긴 하지만, 그 전까지 화면이 목으로 차 있다.
 *
 * 그래서 **비운 채로 시작한다.** 옛 편은 사라지지 않는다 — 「415호에서 503호로 이동해줘」를
 * 넣으면 그대로 온다.
 *
 * `world` 는 `registry` 다. 비어 있는 화면이 시나리오 모드로 들어갈 일은 없지만, 기본값이
 * `legacy` 면 「구판 세계」 안내줄이 임무도 없는데 뜬다.
 *
 * `hardware` 를 `null` 이 아니라 **빈 배열**로 둔다 — `null` 은 「cast 를 써라」는 뜻이라
 * 자리표시 카드가 다시 살아난다. 빈 배열은 「장비가 없다」다.
 */
export const NO_MISSION = '';

function emptyView(): MissionView {
  return {
    missionId: NO_MISSION,
    label: '아직 임무가 없습니다',
    world: 'registry',
    utteranceText: '',
    durationSec: 0,
    milestones: [],
    tasks: [],
    events: [],
    cast: [],
    hardware: [],
    params: {},
    map: null,
    refEdges: [],
    viewpoints: null,
    viewpointTimeline: [],
  };
}

function legacyView(): MissionView {
  return {
    missionId: scenario.missionId,
    label: '415동 → 503동 이동',
    world: 'legacy',
    utteranceText: scenario.utterance.text,
    durationSec: scenario.durationSec,
    milestones: scenario.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      assignedTargets: m.assignedTargets,
      staticStatus: m.status ?? null,
    })),
    // 옛 파일의 태스크는 전부 MS-C 소속이다(파일에 필드가 없어 여기서 채운다).
    tasks: scenario.tasks.map((t) => ({ ...t, milestone: t.milestone ?? 'MS-C' })),
    events: scenario.events,
    cast: (scenario.hardware ?? []).map((h) => h.id),
    hardware: scenario.hardware ?? null,
    params: {},
    map: null,
    refEdges: [],
    viewpoints: null,
    viewpointTimeline: [],
  };
}

function scriptToView(script: ScriptScenario): MissionView {
  return {
    missionId: script.missionId,
    label: script.title,
    world: 'registry',
    utteranceText: script.utterance.text,
    durationSec: script.durationSec,
    milestones: script.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      assignedTargets: m.assignedTargets,
      staticStatus: null,
    })),
    tasks: script.tasks,
    events: script.events,
    cast: script.cast,
    hardware: null,
    params: script.params ?? {},
    map: script.map ?? null,
    refEdges: script.refEdges ?? [],
    viewpoints: script.viewpoints ?? null,
    viewpointTimeline: script.viewpointTimeline ?? [],
  };
}

/** 라이브러리의 임무를 화면 형태로. 모르는 id 면 null — 지어내지 않는다. */
export function viewForMission(missionId: string): MissionView | null {
  if (missionId === scenario.missionId) return legacyView();
  const entry = libraryEntry(missionId);
  if (entry?.script) return scriptToView(entry.script);
  return null;
}

// ── 저장소 ───────────────────────────────────────────────────────────────────

/**
 * 대본이 골라진 제안. **키워드 대조의 결과이지 모델이 아니다.**
 */
export type ScriptProposal = {
  origin: 'script';
  missionId: string;
  title: string;
  /** 어느 키워드가 맞아서 이 대본이 골라졌는지 — 화면이 그 자리에서 보여준다. */
  keywords: string[];
  planId: string | null;
  world: 'registry' | 'legacy';
};

/**
 * 모델이 낸 제안 (260907 · 9단계 · `VZ-G-01`).
 *
 * 대본 제안과 **다른 종류다.** 대본 제안은 「미리 써 둔 편 중 하나를 고른 것」이라
 * `missionId` 만 있으면 본문을 라이브러리에서 찾을 수 있지만, 이쪽은 **방금 만들어진
 * 것**이라 어디에도 없다. 그래서 본문(`view`)을 스스로 들고 다닌다.
 *
 * 그리고 근거를 함께 든다. 승인되기 전에는 기록 열에 아무것도 넣지 않으므로
 * (「승인 전에는 진행 사건이 하나도 없다」), 근거가 사는 곳은 승인 전까지 여기 하나다.
 */
export type AiProposal = {
  origin: 'ai';
  missionId: string;
  title: string;
  /** 모델이 낸 임무. 대본 라이브러리에 없다 — 이것이 원본이다. */
  view: MissionView;
  provenance: AiProvenance;
};

/**
 * **제안은 두 종류다.** 화면이 배지를 갈라 붙이는 근거가 이 합집합이고, 갈라 두지 않으면
 * 「이 마일스톤은 누가 썼나」에 답할 수 없다 — 대본에서 읽은 것과 모델이 낸 것이 같은
 * 모양으로 뜨는 순간 그 물음이 사라진다.
 */
export type MissionProposal = ScriptProposal | AiProposal;

export type MissionState = {
  current: MissionView;
  proposal: MissionProposal | null;
  /** 재생 머리(대본 시각 초). 재생 중이 아니면 durationSec — 슬라이더는 되감기 도구다. */
  headSec: number;
  playing: boolean;
  /**
   * 기동 기본(boot) / 승인 활성화(approval) / 모드 스위치의 정지 미리보기(preview) /
   * 저장된 기록 다시보기(record · 260914). 구판 세계 안내 띠와 「정지 미리보기」 표기의 근거다.
   */
  activatedBy: 'boot' | 'approval' | 'preview' | 'record';
};

let state: MissionState = {
  // **비운 채로 시작한다** (260910). 옛 편은 발화로 부르면 온다.
  current: emptyView(),
  proposal: null,
  headSec: 0,
  playing: false,
  activatedBy: 'boot',
};

const listeners = new Set<() => void>();
let localTimer: ReturnType<typeof setInterval> | null = null;
/** 뷰포인트 프레임을 어디까지 흘려보냈는지. 기록 열의 `localCursor` 와 같은 자리다. */
let localViewpointCursor = 0;

/** 로컬 재생기가 대본을 어디까지 읽어 흘려보냈는지. 매 틱 처음부터 훑지 않기 위한 자리다. */
let localCursor = 0;

/**
 * 알림 병합 창 (VZ-I-01 · 100 ms).
 *
 * 20 Hz 수신에서 사건마다 구독자를 깨우면 초당 20번 접고 20번 그린다 — 렌더 예산을 넘긴다.
 * **데이터는 전량 받는다**(열에는 매 건이 들어간다). 묶는 것은 *알림*뿐이고, 규칙도 창
 * 크기도 이미 있는 것을 그대로 쓴다 (`mergeScheduler.ts` · `RENDER_MERGE_WINDOW_MS`).
 *
 * 재생 머리는 창으로 묶고, **제안·승인·미리보기·재생 끝은 창을 건너뛴다**(`commitNow`) —
 * 승인 버튼이 100 ms 늦게 반응하면 그건 그냥 느린 화면이다 (mergeScheduler 규칙 3).
 */
const renderMerge = new MergeScheduler();
renderMerge.subscribe(() => { for (const listener of listeners) listener(); });

/** 상태를 바꾸고 **병합 창**으로 알린다. 재생 머리처럼 초당 여러 번 바뀌는 값. */
function commit(next: Partial<MissionState>): void {
  state = { ...state, ...next };
  renderMerge.mark();
}

/** 상태를 바꾸고 **즉시** 알린다. 늦으면 안 되는 전이. */
function commitNow(next: Partial<MissionState>): void {
  state = { ...state, ...next };
  renderMerge.flushNow();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMissionState(): MissionState {
  return state;
}

export function useMission(): MissionState {
  return useSyncExternalStore(subscribe, getMissionState, getMissionState);
}

export function currentMission(): MissionView {
  return state.current;
}

/** 알림 병합 실측값. 자체 관측(`VZ-O-04`)이 읽는다. */
export function missionMergeStats() {
  return renderMerge.stats();
}

const EMPTY_TRACE: readonly ScenarioEvent[] = Object.freeze([]);

/**
 * 그 임무의 기록 열. 열은 임무당 하나이므로, **아직 아무것도 흘러오지 않은 임무**
 * (제안된 대본 · 다른 편)는 빈 열이다 — 지어내지 않는다.
 */
export function traceFor(view: MissionView): readonly ScenarioEvent[] {
  return traceMissionId() === view.missionId ? traceEvents() : EMPTY_TRACE;
}

/**
 * 화면이 그릴 임무 — 제안이 있으면 제안된 대본을 「제안 상태」로 그린다
 * (진행 사건 0건 = 시각 0의 접기 결과, 전부 pending).
 */
export function displayMission(): {
  view: MissionView;
  phase: 'proposal' | 'playing' | 'idle';
  headSec: number;
  /** 그 임무의 기록 열. 화면은 **이것만** 접는다. */
  trace: readonly ScenarioEvent[];
} {
  if (state.proposal !== null) {
    // 모델이 낸 제안은 라이브러리에 없다 — **제안이 본문을 들고 있다.**
    const view = state.proposal.origin === 'ai'
      ? state.proposal.view
      : viewForMission(state.proposal.missionId);
    // 제안은 아직 승인 전이라 흘러온 것이 없다 — 열이 비어 있는 것이 곧 그 사실이다.
    if (view !== null) return { view, phase: 'proposal', headSec: 0, trace: traceFor(view) };
  }
  return {
    view: state.current,
    phase: state.playing ? 'playing' : 'idle',
    headSec: state.headSec,
    trace: traceFor(state.current),
  };
}

// ── 제안 · 승인 · 재생 ────────────────────────────────────────────────────────

/** 발화 매칭 결과를 제안으로 올린다. 게이트웨이(plan 수신)와 단독 빌드(로컬 매칭)가 부른다. */
export function proposeMission(proposal: ScriptProposal): void {
  if (viewForMission(proposal.missionId) === null) return;
  // 같은 제안의 중복(로컬 매칭 직후 게이트웨이 plan 도착)은 planId 만 갱신한다.
  if (state.proposal?.origin === 'script' && state.proposal.missionId === proposal.missionId && proposal.planId === null) return;
  commitNow({ proposal });
}

/**
 * 모델이 낸 임무를 제안으로 올린다 (260907 · 9단계 · `VZ-G-01`).
 *
 * **여기서 실행되는 것은 없다.** 대본 제안과 정확히 같은 자리에 서고, 승인 전에는 기록
 * 열이 비어 있다 — 「승인 없이는 아무것도 실행되지 않는다」(`VZ-U-07` · `REQ-1506`)가
 * 모델이 낸 것에도 그대로 걸린다는 뜻이다.
 *
 * 대본 제안과 달리 **`viewForMission` 으로 걸러 낼 수 없다.** 방금 만들어진 임무라
 * 라이브러리에 없는 것이 정상이다. 대신 그리 볼 수 없는 것은 막는다 — 마일스톤이 하나도
 * 없는 임무는 화면에 올려 봐야 빈 목록이고, 사람이 승인을 판단할 재료가 없다.
 */
export function proposeGenerated(view: MissionView, provenance: AiProvenance, title?: string): boolean {
  if (view.milestones.length === 0) return false;
  commitNow({
    proposal: {
      origin: 'ai',
      missionId: view.missionId,
      title: title ?? view.label,
      view,
      provenance,
    },
  });
  return true;
}

export function rejectProposal(): void {
  if (state.proposal === null) return;
  commitNow({ proposal: null });
}

/**
 * 승인 → 현재 임무 교체 + 재생 시작.
 * mode 'remote' 는 게이트웨이의 trace_event 가 머리를 밀고(통합),
 * 'local' 은 로컬 재생기가 같은 배속으로 민다(단독 빌드 — 게이트웨이 없음).
 *
 * **어느 쪽이든 기록은 같은 입구로 들어간다** (`appendTrace`). 입구가 둘이면 단독 빌드와
 * 통합 빌드의 되감기가 달라지고, 그게 곧 논문 측정축 D의 오염이다.
 */
export function activateMission(missionId: string, mode: 'remote' | 'local'): void {
  const view = viewForMission(missionId);
  if (view === null) return;
  beforeNewRun();
  stopLocalTimer();
  resetTrace(view.missionId);
  resetViewpoint(view.missionId);
  resetRobotSession();
  // 새 판이 선다 — 이력은 **판마다 한 줄**이라 여기서 표시를 내려야 같은 편을 두 번
  // 돌렸을 때 두 줄이 남는다 (260912).
  armMissionHistory();
  // 지난 판의 「직전 문구」가 새 판의 첫 줄을 삼키면 안 된다 — 같은 사유로 또 끊겨도
  // 새 판에서는 새로 적혀야 한다.
  armNotifications();
  // 탐지도 같이 비운다 (260912) — 지난 판의 각도와 「이미 끝났다」는 기억이 남으면
  // 새 판이 처음부터 다 끝난 채로 뜬다.
  resetDetect();
  localCursor = 0;
  localViewpointCursor = 0;
  commitNow({ current: view, proposal: null, headSec: 0, playing: true, activatedBy: 'approval' });

  // **로봇이 몰면 타이머를 안 세운다** (260910 지적). 대본 시각이 저 혼자 흐르면 로봇이
  // 아직 첫 걸음도 안 뗐는데 화면은 끝나 있다.
  if (mode === 'local' && !robotDrives()) {
    const stepMs = 200;
    localTimer = setInterval(() => {
      const nextHead = state.headSec + (stepMs / 1000) * LOCAL_SPEED;
      if (nextHead >= state.current.durationSec) {
        stopLocalTimer();
        // 남은 사건을 마저 흘려보낸 **뒤에** 머리를 끝에 세운다 — 순서가 바뀌면
        // 마지막 한 틱 동안 화면이 「끝났는데 아직 안 온」 상태를 그린다.
        feedLocalTrace(state.current.durationSec);
        commitNow({ headSec: state.current.durationSec, playing: false });
        return;
      }
      feedLocalTrace(nextHead);
      commit({ headSec: nextHead });
    }, stepMs);
  }
}

/**
 * 승인 — **제안을 캔버스에 올리는 유일한 문** (`VZ-U-07` · `REQ-1506` · 260907).
 *
 * ## 왜 문이 하나여야 하나
 *
 * 9단계에 제안이 두 종류가 됐다(대본 · 모델). 승인 경로가 종류마다 따로 있으면, 나중에
 * 한쪽에 검사를 더하면서 다른 쪽을 빠뜨려도 아무도 모른다 — 그리고 빠뜨린 쪽이 하필
 * 모델이 낸 것이면, **사람이 안 본 계획이 캔버스에 올라간다.** 그래서 문을 하나로 두고
 * `verify:proposal-gate` 가 이 함수 하나를 지킨다.
 *
 * 제안이 없으면 **아무 일도 하지 않는다.** 「승인할 것이 없는데 승인이 됐다」가 곧
 * 승인 선을 우회하는 길이다.
 *
 * @returns 실제로 승인이 일어났는가.
 */
export function acceptProposal(mode: 'remote' | 'local' = 'local'): boolean {
  const proposal = state.proposal;
  if (proposal === null) return false;
  if (proposal.origin === 'script') {
    activateMission(proposal.missionId, mode);
    const accepted = state.activatedBy === 'approval' && state.current.missionId === proposal.missionId;
    // **승인이 로봇 관문을 연다** (260910 · `VZ-U-07`). 이 줄 앞에서는 MQTT 로 나가는
    // 바이트가 없다 — `verify:no-publish-before-approval` 이 그것을 센다.
    // 승인의 문이 하나이므로 관문도 여기 한 곳에서만 열린다.
    if (accepted) markApproved();
    return accepted;
  }
  return activateGenerated(proposal);
}

/**
 * 모델이 낸 제안의 승인 (260907 · 9단계).
 *
 * `activateMission` 과 갈라지는 곳은 둘뿐이다.
 *  - 라이브러리에서 찾지 않는다. **제안이 든 본문이 원본이다.**
 *  - 재생기를 세우지 않는다. 흘려보낼 사건이 없다(`events: []` · `durationSec: 0`) —
 *    이것은 실행 기록이 아니라 **계획**이다. 타이머를 세우면 있지도 않은 기록을 향해
 *    머리가 굴러간다.
 *
 * 열에 들어가는 첫 두 줄이 이 함수의 요점이다.
 *
 * ```
 * seq 2,000,000  produced_by=ai      mission_generated   ← 모델·프롬프트 지문·규칙 목록
 * seq 1,000,000  produced_by=human   proposal_accepted   ← 사람이 수락했다 (VZ-D-08)
 * ```
 *
 * **순서가 뜻이다.** 생성이 먼저고 승인이 그 뒤다 — 그 두 줄이 있어야 화면에 뜬 마일스톤
 * 하나에서 「무엇이 만들었나 → 누가 받아들였나」로 거슬러 올라갈 수 있다
 * (`VZ-G-01` 의 「역추적이 맨 위까지 닿는다」).
 */
function activateGenerated(proposal: AiProposal): boolean {
  beforeNewRun();
  stopLocalTimer();
  resetTrace(proposal.view.missionId);
  resetViewpoint(proposal.view.missionId);
  resetRobotSession();
  localCursor = 0;
  localViewpointCursor = 0;
  commitNow({ current: proposal.view, proposal: null, headSec: 0, playing: false, activatedBy: 'approval' });
  appendGenerated(
    proposal.view.missionId,
    'mission_generated',
    proposal.view.missionId,
    0,
    provenancePayload(proposal.provenance),
  );
  // 승인도 사람 조작이다 — `VZ-D-08` 은 예외를 두지 않는다.
  recordHuman('proposal_accepted', proposal.view.missionId, {
    origin: 'ai',
    milestones: proposal.view.milestones.length,
    tasks: proposal.view.tasks.length,
  });
  return true;
}

/**
 * 로컬 재생기 — **대본을 읽어 게이트웨이와 같은 입구로 기록을 흘려보낸다.**
 * 목 게이트웨이가 하는 일(`gateway/mission-trace.ts`)을 단독 빌드에서 대신하는 자리다.
 */
function feedLocalTrace(headSec: number): void {
  const events = state.current.events;
  while (localCursor < events.length && events[localCursor].atSec <= headSec) {
    appendTrace(state.current.missionId, events[localCursor]);
    localCursor += 1;
  }
  // 뷰포인트 채널 (260909 §6) — 기록 열과 **같은 걸음으로** 흘려보낸다. 화면은 대본이
  // 아니라 흘러온 것을 접는다.
  //
  // **로봇이 붙어 있으면 대본이 이 자리를 채우지 않는다** (260910 지적). 진행은 uplink 의
  // `CommandStatus` 가 몬다 — 대본과 로봇이 같이 채우면 여덟 칸이 두 번 차고, 화면이
  // 로봇보다 앞서 간다.
  if (robotDrives()) return;
  const timeline = state.current.viewpointTimeline;
  while (localViewpointCursor < timeline.length && timeline[localViewpointCursor].atSec <= headSec) {
    const entry = timeline[localViewpointCursor];
    for (const frame of scriptFrames([entry], entry.atSec)) {
      appendViewpoint(state.current.missionId, entry.atSec, frame);
    }
    localViewpointCursor += 1;
  }
}

/**
 * 정지 미리보기 (260831 — 사이트 개선 요구 4 · 우상단 모드 스위치).
 *
 * 현재 임무를 그 대본으로 올리되 **기록 열이 비어 있다** — headSec 0 · playing false 라
 * 탭①은 전부 pending 으로 그린다(제안 상태와 같은 성질). **재생은 여전히 승인 뒤다** —
 * 이 함수는 「그린다」까지이고 승인 선(VZ-U-07 · REQ-1506)을 우회하지 않는다.
 */
export function previewMission(missionId: string): void {
  const view = viewForMission(missionId);
  if (view === null) return;
  beforeNewRun();
  stopLocalTimer();
  resetTrace(view.missionId);
  resetViewpoint(view.missionId);
  resetRobotSession();
  localCursor = 0;
  localViewpointCursor = 0;
  commitNow({ current: view, proposal: null, headSec: 0, playing: false, activatedBy: 'preview' });
}

function stopLocalTimer(): void {
  if (localTimer !== null) clearInterval(localTimer);
  localTimer = null;
}

/**
 * **판을 비우기 전에** (260914 — 임무 기록). 기록기가 지난 판의 마지막 모습을 뜨게 하고,
 * 다시보기 중이었으면 그것을 푼다 — 다시보기로 채운 탐지 결과·로봇 명령이 새 판에 남으면 안 된다.
 */
function beforeNewRun(): void {
  sealRun();
  if (!isReplayingRecord()) return;
  leaveRecordReplay();
  resetRobotSession();
  resetDetect();
}

/**
 * 게이트웨이 trace_event 수신 (통합 셸의 브리지가 부른다).
 * 다른 임무의 사건은 버린다 — 승인 전에는 애초에 오지 않는다(게이트웨이 규칙).
 *
 * 중복(재접속 뒤 다시 온 같은 `seq`)은 열이 흡수한다 — 새로 생긴 것이 없고 머리도 안
 * 움직이면 화면을 다시 그리지 않는다.
 */
/**
 * **로봇이 민 진행** (260910). `receiveTrace` 와 갈라 둔 이유는 **대본 끝 판정** 때문이다.
 *
 * `receiveTrace` 는 대본의 마지막 사건 시각을 넘으면 「재생 끝」으로 보고 머리를
 * `durationSec` 에 세운다. 로봇은 대본보다 느릴 수도 빠를 수도 있어서 그 판정을 쓰면
 * 로봇이 아직 도는 중에 화면이 끝나 버린다. 여기서는 **머리를 사건 시각까지만** 민다.
 */
export function receiveRobotProgress(missionId: string, event: ScenarioEvent): void {
  // 다시보기 중에는 지난 판의 열에 아무것도 안 붙인다 — 같은 임무 id 의 새 사건이어도.
  if (missionId !== state.current.missionId || isReplayingRecord()) return;
  appendTrace(missionId, event);
  commit({ headSec: Math.max(state.headSec, event.atSec), playing: true });
}

/**
 * **로봇이 민 재생 머리** (260910). 사건 없이 시각만 민다.
 *
 * 뷰포인트 프레임은 기록 열의 사건이 아니라 별도 열로 들어간다(`viewpoint/store.ts`).
 * 화면은 그 열을 **머리까지만** 접으므로, 머리가 안 움직이면 로봇이 여덟 걸음을 다
 * 흘려도 화면은 비어 있다 — 실제로 그랬다. 회전 사건에는 태스크 상태 변화가 없어서
 * 머리를 밀 사건이 하나도 없었기 때문이다.
 */
export function advanceRobotHead(missionId: string, atSec: number): void {
  if (missionId !== state.current.missionId || isReplayingRecord()) return;
  if (atSec <= state.headSec) return;
  commit({ headSec: atSec, playing: true });
}

export function receiveTrace(missionId: string, event: ScenarioEvent): void {
  if (missionId !== state.current.missionId || isReplayingRecord()) return;
  const fresh = appendTrace(missionId, event);
  const lastAt = state.current.events.at(-1)?.atSec ?? state.current.durationSec;
  if (event.atSec >= lastAt) {
    // 마지막 사건 — 재생 끝. 머리를 durationSec 에 세우고 슬라이더를 되감기 도구로 돌려준다.
    commitNow({ headSec: state.current.durationSec, playing: false });
    return;
  }
  if (!fresh && event.atSec <= state.headSec) return;
  commit({ headSec: Math.max(state.headSec, event.atSec), playing: true });
}

// ── 사람 조작 기록 (260904 — 같은 열로 합쳤다) ───────────────────────────────

/**
 * 화면에서 나가는 명령을 기록한다 (`VZ-D-08`). 전까지는 별도 배열과 `console.log` 가
 * 끝이라 **되감기에 안 보였다** — 기록이라고 부를 수 없었다.
 *
 * `atSec` 는 조작한 그 시각의 재생 머리다. 사건을 만드는 규칙 자체는 `trace.ts` 에 있다 —
 * `produced_by=human` 이 여기저기서 손으로 적히면 그 규칙이 갈라진다.
 */
export function recordHuman(kind: string, nodeId = state.current.missionId, payload: Record<string, unknown> = {}) {
  // 다시보기는 지난 판이다 — 지금 누른 것을 그 판의 기록에 끼워 넣지 않는다.
  if (isReplayingRecord()) return null;
  const event = appendHuman(
    state.current.missionId,
    kind,
    nodeId,
    Math.min(state.headSec, state.current.durationSec),
    payload,
  );
  // 열이 자랐으면 화면을 다시 그린다 — 되감기 타임라인에 그 조작이 떠야 한다.
  if (event !== null) commitNow({});
  return event;
}

// ── 상태 접기 (REQ-1405 되감기 · 마일스톤은 태스크를 접은 결과) ──────────────────

/**
 * 시각 t 의 계층 상태. 접는 규칙은 `fold.ts` 하나에 있고 여기서는 **접는 대상**만
 * 정한다 — 화면이 그리는 임무(제안 중이면 제안된 대본)의 **기록 열**이다.
 */
export function statusesAt(second: number, view: MissionView = displayMission().view): FoldedStatuses {
  return foldStatuses(second, view, traceFor(view));
}

/**
 * 기동 직후의 옛 편 — **이미 끝난 과거 임무의 기록**이라 열을 채워 둔다.
 * 게이트웨이가 있으면 같은 사건이 `trace_event` 로 다시 오는데, `seq` 가 같으므로
 * 열이 중복으로 흡수한다 (`VZ-I-02` 와 같은 성질).
 */
resetTrace(state.current.missionId);
resetViewpoint(state.current.missionId);
for (const event of state.current.events) appendTrace(state.current.missionId, event);


/**
 * **화면을 처음 상태로** (260910 지시).
 *
 * 시연을 한 판 돌리고 나면 마일스톤도 여덟 칸도 차 있다. 다시 보이려면 새로고침해야 했는데,
 * 새로고침하면 **브로커 연결이 끊긴다** — 무대에서 그걸 다시 붙이는 시간이 아깝다.
 *
 * 그래서 여기서 비운다. 임무·제안·기록 열이 지워지고, 연결은 그대로 남는다
 * (`resetRobotSession` 이 연결과 ping 을 남기는 것과 같은 이유다).
 */
export function resetMission(): void {
  beforeNewRun();
  stopLocalTimer();
  localCursor = 0;
  localViewpointCursor = 0;
  // 임무가 없으니 열도 없다 — 다음 임무가 열릴 때 그 id 로 다시 선다.
  resetTrace(NO_MISSION);
  resetViewpoint(NO_MISSION);
  resetRobotSession();
  resetDetect();
  // 「초기화」는 화면을 처음 상태로 되돌리는 것이라 이력도 알림도 같이 비운다.
  resetMissionHistory();
  resetNotifications();
  commitNow({ current: emptyView(), proposal: null, headSec: 0, playing: false, activatedBy: 'boot' });
}


/**
 * **지금 임무를 처음부터 다시** (260911 지시).
 *
 * 한 판이 끝났거나 정지한 뒤 같은 편을 다시 보려면 발화부터 다시 해야 했다 — 문장을 누르고,
 * 요청하고, 승인하고. 시연 중에 그 셋을 다시 하는 것은 번거롭고, 그동안 화면이 제안 상태로
 * 돌아가 보는 사람이 「방금 것이 실패했나」로 읽는다.
 *
 * `activateMission` 과 같은 일을 한다 — 기록·여덟 칸·로봇 세션을 비우고 시각을 0으로.
 * **승인은 다시 안 받는다.** 이 편은 이미 승인된 편이고, 버튼을 누른 것이 사람의 행위다.
 * 그래서 로봇 관문도 같이 연다 — 안 그러면 눌러도 로봇이 안 움직여 「또 안 되네」가 된다.
 *
 * 임무가 없으면 아무것도 안 한다.
 */
export function restartMission(): boolean {
  const missionId = state.current.missionId;
  if (missionId === NO_MISSION) return false;
  if (viewForMission(missionId) === null) return false;
  activateMission(missionId, 'remote');
  markApproved();
  // **시작까지 자동으로 넘어가지 않는다** (260912). 「처음부터」는 판을 비우는 것이고,
  // 로봇을 움직이는 것은 사람이 「임무 시작」을 누르는 일이다 — 관문을 우회하지 않는다.
  clearStarted();
  recordHuman('mission_restarted', missionId, { from: 'button' });
  return true;
}


// ── 저장된 기록 다시보기 (260914) ────────────────────────────────────────────

/**
 * **지난 판을 화면에 올린다.** 기록 파일의 기록 열 · 뷰포인트 프레임을 새 열에 그대로 붓고,
 * 재생 머리를 그 판이 끝난 자리에 세운다 — 슬라이더가 되감기 도구다(기동 직후 옛 편과 같은 성질).
 *
 * 로봇 명령·탐지 결과는 부르는 쪽(`record/loadRecord.ts`)이 먼저 채운다. 여기서는 임무와 두 열만.
 * **재생기는 안 세운다** — 흘려보낼 대본이 아니라 이미 일어난 일이다.
 *
 * 축 길이는 대본 길이와 기록이 간 곳 중 긴 쪽이다. 로봇이 몬 판은 대본보다 오래 걸린다.
 */
export function loadRecordedMission(
  view: MissionView,
  trace: readonly ScenarioEvent[],
  frames: readonly ArrivedFrame[],
  headSec: number,
): void {
  stopLocalTimer();
  localCursor = 0;
  localViewpointCursor = 0;
  resetTrace(view.missionId);
  for (const event of trace) appendTrace(view.missionId, event);
  resetViewpoint(view.missionId);
  for (const entry of frames) appendViewpoint(view.missionId, entry.atSec, entry.frame);
  const reach = Math.max(headSec, ...trace.map((event) => event.atSec), ...frames.map((entry) => entry.atSec));
  commitNow({
    current: { ...view, durationSec: Math.max(view.durationSec, Math.ceil(reach)) },
    proposal: null,
    headSec: Math.max(headSec, reach),
    playing: false,
    activatedBy: 'record',
  });
}

/**
 * **다시보기를 닫는다.** 「초기화」와 같이 비우되 이 세션의 이력 목록과 알림은 남긴다 —
 * 다시보기는 지난 판을 들여다본 것이지 화면을 처음으로 돌린 것이 아니다.
 */
export function closeRecordReplay(): void {
  if (!isReplayingRecord()) return;
  leaveRecordReplay();
  stopLocalTimer();
  localCursor = 0;
  localViewpointCursor = 0;
  resetTrace(NO_MISSION);
  resetViewpoint(NO_MISSION);
  resetRobotSession();
  resetDetect();
  commitNow({ current: emptyView(), proposal: null, headSec: 0, playing: false, activatedBy: 'boot' });
}
