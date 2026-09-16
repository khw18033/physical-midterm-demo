/**
 * src/shell/missionBridge.ts (260831 신설)
 *
 * 게이트웨이의 **임무 축**(node: mission-trace)을 현재 임무 저장소에 잇는 다리.
 *
 * 탭 데이터 계층의 구독은 구역 축(zone-503)이라 임무 채널(plan 제안·trace_event ·
 * 발화 command_result)이 딸려 오지 않는다 — 임무는 장비가 아니고 zone 이 없다
 * (gateway/mission-trace.ts 의 규칙). 그래서 셸이 임무 축을 따로 구독한다.
 *
 * **셸에만 있다.** 탭① 코어(단독 빌드)는 게이트웨이가 없으므로 이 다리도 없다 —
 * 그때는 발화 패널의 로컬 매칭과 로컬 재생기가 같은 저장소를 민다(같은 매처·같은 대본).
 *
 * 받은 봉투는 탭 데이터 계층(store)에도 넣는다 — 계획은 PlanApproval(VZ-U-07)이 읽고,
 * command_result 는 명령 추적기가 요청을 정리한다. 저장소 반영은 그 다음이다.
 */

import { useEffect } from 'react';
import { activateMission, proposeMission, receiveTrace, rejectProposal, viewForMission } from '../data/scenario.ts';
import { libraryEntry } from '../scenarios/library.ts';
import { axesOfMission } from '../scenarios/scriptScope.ts';
import { markIntegratedBuild, observeConnection, observeEnvelope, updateClientHealth } from '../shared/observability.ts';
import { enterScenarioRender } from '../shared/renderMode.ts';
import { store } from '../tabs/data/index.ts';
import { getTransport, type Envelope } from '../transport/index.ts';
import { liveFrame } from '../viewpoint/source.ts';
import { appendViewpoint } from '../viewpoint/store.ts';
import { approvedByHuman, markApproved } from '../physical/robotSession.ts';
import { humanActed } from '../shared/humanAction.ts';

type WirePlan = {
  plan_id: string;
  decision: 'pending' | 'approved' | 'rejected';
  script?: { mission_id: string; title: string; matched_keywords?: string[]; world: 'registry' | 'legacy' };
};

type WireTrace = {
  seq?: number;
  at_sec?: number;
  node_id?: string;
  status?: string;
  kind?: string;
  produced_by?: string;
  attempt?: number;
  payload?: Record<string, unknown>;
  derived_from?: string;
};

let started = false;
/** 승인 반영은 계획당 한 번 — 승인 뒤에도 plan 봉투가 여러 번 오지만(중계 단계) 재생을 다시 세우면 안 된다. */
const activatedPlans = new Set<string>();

export function startMissionBridge(): () => void {
  if (started) return () => undefined;
  started = true;

  /**
   * 자체 관측 (`VZ-O-04` · 260904) — **수신 지연과 재연결은 게이트웨이가 있을 때만 잰다.**
   * 다리가 여기서 봉투와 연결 상태를 다 보므로 계측을 다른 곳에 또 걸 이유가 없다.
   * 단독 빌드에는 이 다리가 없고, 그래서 그 둘은 「해당 없음」으로 뜬다 — 0이 아니다.
   */
  markIntegratedBuild();
  const transport = getTransport();
  observeConnection(transport.getStatus());
  const unwatch = transport.onStatus((status) => observeConnection(status));

  const unsubscribe = transport.subscribe(
    { entity: '*', node: 'mission-trace', channel: '*' },
    (envelope) => {
      observeEnvelope(envelope);
      store.apply(envelope);
      if (envelope.channel === 'plan') applyPlan(envelope);
      // **로봇 편의 진행은 로봇만 몬다** (260910 지적 — 조건을 걸지 않는다).
      //
      // 목 게이트웨이는 승인되면 대본을 제 시각으로 흘려보낸다 — trace_event 로 노드를
      // 칠하고 robot_state·detection 으로 여덟 칸을 채운다. 그건 로봇이 없던 시절의
      // 재생이다. 이제 이 편은 실물 시연이므로 그 합성 진행을 **아예 안 받는다.**
      //
      // 처음엔 `robotDrives()` 일 때만 버렸는데, 승인 순간 연결이 아직 안 열려 있으면
      // 대본이 그대로 재생돼 **로봇 없이 다 끝난 화면**이 나왔다. 로봇이 안 붙었으면
      // 진행이 없는 것이 맞다 — 없는 진행을 지어 보이는 편이 나쁘다.
      //
      // 계획(plan)은 그대로 받는다 — 승인 자체는 게이트웨이를 지나는 일이다.
      if (robotScript(envelope.entity)
        && (envelope.channel === 'trace_event' || envelope.channel === 'robot_state' || envelope.channel === 'detection')) return;
      if (envelope.channel === 'trace_event') applyTrace(envelope);
      if (envelope.channel === 'robot_state' || envelope.channel === 'detection') applyViewpoint(envelope);
    },
    'all',
  );
  // 임무 축 구독 하나. 탭 데이터 계층의 구역 축 구독은 그쪽이 센다.
  updateClientHealth({ subscriptions: 1 });

  return () => {
    unsubscribe();
    unwatch();
    updateClientHealth({ subscriptions: 0 });
    started = false;
  };
}

/**
 * 이 임무가 **로봇이 도는 편**인가 (`world: 'registry'`).
 *
 * 로봇 편의 진행은 로봇만 몬다 — 목 게이트웨이의 합성 재생도, 시나리오 모드 띠도 안 쓴다.
 * 옛 편(`legacy`)은 재생할 로봇이 없으니 그대로 대본으로 돈다.
 */
function robotScript(missionId: string): boolean {
  return libraryEntry(missionId)?.world === 'registry';
}

function applyPlan(envelope: Envelope): void {
  const plan = envelope.payload as WirePlan | null;
  if (!plan?.script) return; // 데모 계획(robot-01)은 임무 저장소와 무관하다.
  /**
   * **사람이 먼저다** (260910). 계획 채널은 캐시되는 채널이라, 구독하는 순간 지난 세션의
   * 제안과 승인이 그대로 다시 들어온다. 그걸 새 것으로 받으면 아무도 아무것도 안 눌렀는데
   * 화면이 임무로 찬다 — 빈 화면을 기본으로 만들고도 부팅 화면이 안 비었던 이유다.
   *
   * 로봇 관문의 `approvedByHuman` 과 같은 빗장이고 같은 이유다.
   */
  if (!humanActed()) return;
  if (plan.decision === 'pending') {
    proposeMission({
      origin: 'script',
      missionId: plan.script.mission_id,
      title: plan.script.title,
      keywords: plan.script.matched_keywords ?? [],
      planId: plan.plan_id,
      world: plan.script.world,
    });
    return;
  }
  if (plan.decision === 'approved') {
    if (activatedPlans.has(plan.plan_id)) return;
    activatedPlans.add(plan.plan_id);
    // 재생 머리는 게이트웨이의 trace_event 가 민다 — 로컬 타이머를 세우지 않는다.
    activateMission(plan.script.mission_id, 'remote');
    // **여기도 승인이다** (260910 — 빠져 있었다). 단독 빌드는 `acceptProposal` 을 지나며
    // 관문을 열지만 통합 빌드는 게이트웨이의 plan 채널로 들어와 그 함수를 안 지난다.
    //
    // 다만 **사람이 이번 세션에서 누른 것만** 연다. 계획은 캐시되는 채널이라 지난 세션의
    // 승인이 재접속 즉시 다시 내려온다 — 그걸 새 승인으로 받으면 아무도 안 눌렀는데
    // 로봇이 움직인다. 실제로 그랬다.
    if (approvedByHuman(plan.plan_id)) markApproved();
    // **로봇 편은 시나리오 모드로 안 들어간다** (260910 지적 — 조건을 걸지 않는다).
    //
    // 시나리오 모드는 「대본을 재생 중」이라는 화면이다 — 「합성 데이터 · 재생 중」 띠를
    // 띄우고 안 쓰는 패널을 접는다. 실물 시연에서 그 띠가 뜨면 **연결 전 테스트처럼
    // 보인다.** 이 편(`world: 'registry'`)은 로봇이 도는 편이므로 일반 모드로 둔다.
    //
    // 로봇이 안 붙어 있을 때만 재생하도록 했다가 되돌렸다 — 승인 순간 연결이 아직
    // 안 열려 있으면 띠가 떴다. 「연결이 늦었다」는 사정이 화면에 대본으로 나오면 안 된다.
    //
    // 옛 편(`world: 'legacy'`, MSN-260826-01)은 그대로 시나리오 모드로 간다.
    if (plan.script.world !== 'registry') {
      const view = viewForMission(plan.script.mission_id);
      if (view !== null) {
        enterScenarioRender({
          missionId: view.missionId,
          title: view.label,
          cast: view.cast,
          axes: axesOfMission(view.missionId),
          playing: true, // 승인 재생 — 모드 스위치의 정지 미리보기와 화면 문구가 다르다.
        });
      }
    }
    return;
  }
  rejectProposal(); // 거부하면 아무것도 재생되지 않는다.
}

/**
 * 뷰포인트 채널 수신 (260909 §6). **라이브 입구 하나를 지난다** (`viewpoint/source.ts`) —
 * 이 봉투가 목 게이트웨이의 대본 재생에서 왔는지 실제 로봇에서 왔는지 여기서 묻지 않고,
 * 물을 방법도 없다. 실제 장치가 붙는 날 고칠 곳이 없다는 것이 이 함수의 뜻이다.
 */
function applyViewpoint(envelope: Envelope): void {
  const payload = envelope.payload as Record<string, unknown> | null;
  if (!payload) return;
  const frame = liveFrame({ channel: envelope.channel, payload });
  if (frame === null) return; // 형식에 안 맞으면 버린다 — 지어 채우지 않는다.
  appendViewpoint(envelope.entity, typeof payload.at_sec === 'number' ? payload.at_sec : 0, frame);
}

function applyTrace(envelope: Envelope): void {
  const wire = envelope.payload as WireTrace | null;
  if (!wire) return;
  receiveTrace(envelope.entity, {
    seq: wire.seq ?? 0,
    atSec: wire.at_sec ?? 0,
    nodeId: wire.node_id ?? '',
    status: (wire.status ?? 'pending') as never,
    kind: wire.kind ?? '',
    producedBy: (wire.produced_by ?? 'backend') as never,
    attempt: wire.attempt,
    payload: wire.payload,
    derivedFrom: wire.derived_from,
  });
}

/** 셸 최상위에서 한 번 — 탭 데이터 계층과 같은 수명이다. */
export function useMissionBridge(): void {
  useEffect(() => startMissionBridge(), []);
}
