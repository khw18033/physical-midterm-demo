/**
 * src/detect/views/DetectActionLog.tsx (260914 신설)
 *
 * **액션 아이템에 붙는 탐지 쪽 두 자리.**
 *
 *   PrepFacts        T-A1 · T-A2 가 실제로 받아 온 값 — 도면과 문 자리, 로봇의 지금 방위(yaw)
 *   DetectLogLines   탐지 경로에서 오간 줄 — 로봇 → 탐지 · 탐지 → 화면 · 화면의 판단
 *
 * 로봇 명령 로그(`ActionModal` 의 RobotCommands)와 같은 규칙이다 — **받은 값만 적고, 없으면
 * 없다고 적는다.**
 */

import { useEffect, useState } from 'react';
import { planApproach, wrapDeg } from '../../physical/approachPlan.ts';
import { commandsOfTask, useRobotSession } from '../../physical/robotSession.ts';
import { useDeviceStates } from '../../physical/deviceState.ts';
import { hardwareTarget } from '../../physical/encode.ts';
import { viewpointTaskIndex } from '../../physical/missionLink.ts';
import { usePrepStage } from '../../physical/prepStage.ts';
import { DETECT_TASKS, LANE_WORDS, useDetectLog } from '../detectLog.ts';
import { useDetect } from '../store.ts';

const ROBOT_ENTITY = 'robot-01';

/** 탐지 경로의 태스크인가 — 액션 아이템이 이 자리를 열지 정한다. */
export function isDetectTask(taskId: string): boolean {
  return viewpointTaskIndex(taskId) !== null
    || (Object.values(DETECT_TASKS) as string[]).includes(taskId);
}

/** 초 단위로 다시 그린다 — 「몇 초 전 값」이 멈춰 있으면 낡은 값을 지금 값으로 읽는다. */
function useTick(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const ago = (now: number, at: number | null) => (at === null ? '받은 적 없음' : `${Math.max(0, Math.round((now - at) / 1000))}초 전`);

/**
 * **T-A1 · T-A2 가 받아 온 값** (260914 지시 — 「로봇의 현재 실제 yaw 값을 T-A2 액션 아이템에서」).
 *
 * T-A2 는 세 값을 나란히 놓는다. 셋은 **기준이 다르다** — 섞어 한 숫자로 적지 않는다.
 *
 *   지금 로봇 방위      로봇이 5초마다 보내는 state.position.heading_deg — 실시간으로 바뀐다
 *   T-A2 가 잡은 방위   준비 단계가 끝날 때 받은 값 — 한 바퀴의 출발 방위다
 *   탐지가 역산한 방위  한 바퀴 뒤 탐지가 받침대로 역산한 **도면 기준** 방위 — 기준점이 다르다
 */
export function PrepFacts({ taskId }: { taskId: string }) {
  const prep = usePrepStage();
  const devices = useDeviceStates();
  const detect = useDetect();
  const now = useTick();

  if (taskId === DETECT_TASKS.map) {
    const map = prep.map;
    return <section className="prep-facts">
      <h3>도면 · 문 위치</h3>
      <dl>
        <div><dt>상태</dt><dd>{STEP_WORDS[map.step]}{map.reason !== null && ` — ${map.reason}`}</dd></div>
        <div><dt>도면</dt><dd>{map.url === null ? '아직 안 받았습니다' : <>{map.bundled ? '저장소 사본' : '탐지 창구'} · <code>{map.url}</code></>}</dd></div>
        <div><dt>문 도면 위치</dt><dd>({map.doorCm.x.toFixed(1)}, {map.doorCm.y.toFixed(1)}) cm · px ({map.doorPx.x}, {map.doorPx.y}) <small>GT 고정값 — 검출값이 아닙니다</small></dd></div>
        {map.atIso !== null && <div><dt>받은 시각</dt><dd>{map.atIso.slice(11, 23)}</dd></div>}
      </dl>
    </section>;
  }

  if (taskId !== DETECT_TASKS.pose) return null;
  const device = devices[hardwareTarget(ROBOT_ENTITY)] ?? null;
  const live = device?.position ?? null;
  const caught = prep.pose.value;
  const loc = detect.localization;
  // 다시보기면 「지금 로봇 방위」는 이 판의 값이 아니다 — 지난 판 옆에 지금 값을 놓으면 섞어 읽는다.
  const replaying = detect.recordRun !== null;
  return <section className="prep-facts">
    <h3>로봇 방위 (yaw)</h3>
    <dl>
      <div className="prep-facts__live">
        <dt>지금 로봇 방위</dt>
        <dd>{replaying
          ? '저장된 판을 다시 보는 중이라 적지 않습니다 — 이 판의 값은 아래 두 줄입니다'
          : live === null
          ? '로봇 state 를 받은 적이 없습니다 — 브로커에 붙어 있는지 볼 것'
          : <><b>{live.headingDeg.toFixed(1)}°</b> · x {live.x.toFixed(2)} m · y {live.y.toFixed(2)} m
            <small> {ago(now, device?.positionAtMs ?? null)} · 로봇 시각 {device?.timestamp?.slice(11, 19) ?? '없음'} · 오도메트리 기준</small></>}
        </dd>
      </div>
      <div>
        <dt>T-A2 가 잡은 방위</dt>
        <dd>{caught === null
          ? <>{STEP_WORDS[prep.pose.step]}{prep.pose.reason !== null && ` — ${prep.pose.reason}`}</>
          : <><b>{caught.headingDeg.toFixed(1)}°</b> · x {caught.xM.toFixed(2)} m · y {caught.yM.toFixed(2)} m
            <small> 받은 시각 {caught.receivedAtIso.slice(11, 19)} · 한 바퀴의 출발 방위</small></>}
        </dd>
      </div>
      <div>
        <dt>탐지가 역산한 방위</dt>
        <dd>{loc?.current_heading_map_deg === undefined
          ? '아직 없습니다 — 탐지는 한 바퀴를 다 받은 뒤에 역산합니다'
          : <><b>{loc.current_heading_map_deg}°</b> · 위치 ({loc.robot_position_cm?.map((n) => n.toFixed(1)).join(', ')}) cm
            <small> 도면 기준 — 로봇 방위와 기준점이 다릅니다</small></>}
        </dd>
      </div>
    </dl>
  </section>;
}

/**
 * **`T-A3` 로봇이 1바퀴 돈다 — 한 바퀴 뒤 방위** (260914 지시).
 *
 * 각도 칸의 액션 아이템에는 그 회전 보고의 yaw 가 있지만, 여덟째 회전(출발 방향 복귀)은 칸이 없어 어디에도
 * 안 보였다. 그 보고의 yaw 는 이미 받고 있다(`scan_turn` step 8 → `scanReturnYaw`) — pi7 쪽 변경 없이 여기 적는다.
 *
 * 출발 방위와 견준 차이가 한 바퀴의 누적 오차다. 탐지의 회전각은 출발 방향 기준이므로 이 차이만큼 이동이 어긋난다.
 * 모든 값은 로봇 오도메트리 기준이고, 로봇이 안 실은 값은 「모름」으로 둔다.
 */
export function SweepFacts() {
  const session = useRobotSession();
  const prep = usePrepStage();
  const startCapture = session.seenYaw[0];
  const startPose = prep.pose.value?.headingDeg;
  const start = startCapture ?? startPose ?? null;
  const back = session.scanReturnYaw;
  const drift = start !== null && back !== null ? wrapDeg(back - start) : null;
  const scan = commandsOfTask(DETECT_TASKS.sweep).at(-1) ?? null;
  const resultYaw = scan?.result.yaw_deg;
  const turns = Object.entries(session.seenYaw)
    .map(([index, yaw]) => [Number(index), yaw] as const)
    .filter(([index]) => index > 0)
    .sort((a, b) => a[0] - b[0]);
  return <section className="prep-facts">
    <h3>한 바퀴 방위 (yaw)</h3>
    <dl>
      <div>
        <dt>출발 방위</dt>
        <dd>{start === null ? '모름 — 0도 촬영 때 로봇 state 도, T-A2 방위도 없습니다'
          : <><b>{start.toFixed(1)}°</b> <small>{startCapture !== undefined ? '0도 촬영 때 로봇 state' : 'T-A2 가 잡은 방위'}</small></>}</dd>
      </div>
      <div className="prep-facts__live">
        <dt>한 바퀴 뒤 방위</dt>
        <dd>{back === null
          ? (session.scanIssued ? '아직 없습니다 — 여덟째 회전(출발 방향 복귀) 보고가 오면 적힙니다' : '스캔 전입니다')
          : <><b>{back.toFixed(1)}°</b> <small>여덟째 회전(출발 방향 복귀) 보고의 yaw</small></>}</dd>
      </div>
      <div>
        <dt>출발과 차이</dt>
        <dd>{drift === null ? '모름' : <><b>{drift >= 0 ? '+' : ''}{drift.toFixed(1)}°</b> <small>한 바퀴 누적 오차 · 탐지 회전각이 이만큼 어긋난 방향에서 나간다</small></>}</dd>
      </div>
      {typeof resultYaw === 'number' && <div><dt>스캔 종료 결과</dt><dd>{resultYaw.toFixed(1)}° <small>scan_mission 결과의 yaw_deg</small></dd></div>}
      {turns.length > 0 && <div>
        <dt>회전별</dt>
        <dd>{turns.map(([index, yaw]) => `${index}번 ${yaw.toFixed(1)}°`).join(' · ')}{back !== null && ` · 복귀 ${back.toFixed(1)}°`}</dd>
      </div>}
    </dl>
  </section>;
}

/** 대체 경로 단계의 사람 이름. */
const STEP_NAMES: Record<string, string> = {
  A_pedestal: 'A · 단상으로 위치 추정',
  B_door_only: 'B · 문만으로 위치 추정',
  C_door_relative: 'C · 문 관측만으로 경로',
  path_map: '도면 기반 경로 산출',
};

/**
 * **`T-B1` 2D 맵 기반 경로 산출이 어떻게 나왔나** (260914 지시 — 「경로 산출 과정을 액션 아이템에서」).
 *
 * 탐지가 준 산출물 그대로다 — 대체 경로가 어디서 왜 넘어갔는지, 문 거리를 무엇으로 어림했는지,
 * 식과 대입값, 탐지가 낸 로봇 명령. **다시 계산하지 않는다.**
 */
export function PathFacts() {
  const detect = useDetect();
  const path = detect.path ?? detect.pathFailureDetail;
  if (path === null) {
    return <section className="prep-facts">
      <h3>경로 산출</h3>
      <p className="robot-log__empty">아직 없습니다 — 여덟 각도를 다 보면 탐지가 곧바로 산출합니다</p>
    </section>;
  }
  const distance = path.door_distance_estimate ?? null;
  const command = path.robot_command ?? null;
  return <section className="prep-facts">
    <h3>경로 산출{path.ok ? '' : ' — 실패'}</h3>
    <dl>
      <div><dt>결과</dt><dd>{path.ok ? <><b>{path.turn_instruction}</b> · 직진 {(path.forward_distance_cm / 100).toFixed(2)} m</> : <span className="detect-map__failed">{path.reason}</span>}</dd></div>
      {path.path_mode_words !== undefined && <div><dt>산출 방식</dt><dd>{path.path_mode_words}</dd></div>}
    </dl>
    {(path.fallback_chain ?? []).length > 0 && <ol className="path-chain">
      {(path.fallback_chain ?? []).map((step, at) => <li key={`${step.step}-${at}`} className={step.ok ? 'is-ok' : 'is-fail'}>
        <b>{step.ok ? '✓' : '✕'} {STEP_NAMES[step.step] ?? step.step}</b> <span>{step.detail}</span>
      </li>)}
    </ol>}
    {distance !== null && <>
      <h4>문 거리 — 겉보기 크기</h4>
      <p className="path-note"><code>{distance.formula}</code>{distance.substituted !== undefined && <> → {distance.substituted}</>}{distance.reason !== undefined && <> · <span className="detect-map__failed">{distance.reason}</span></>}</p>
      <table className="path-table"><thead><tr><th>프레임</th><th>각도</th><th>폭 px</th><th>높이 px</th><th>폭→거리</th><th>높이→거리</th></tr></thead>
        <tbody>{distance.per_frame.map((row) => <tr key={row.frame}>
          <td>{row.frame}</td><td>{row.rotation_deg}°</td>
          <td>{row.box_w_px}{row.width_clipped ? ' (잘림)' : ''}</td><td>{row.box_h_px}{row.height_clipped ? ' (잘림)' : ''}</td>
          <td>{row.distance_from_width_cm ?? '—'}</td><td>{row.distance_from_height_cm ?? row.skipped_reason ?? '—'}</td>
        </tr>)}</tbody>
      </table>
    </>}
    {Object.keys(path.path_calculation ?? {}).length > 0 && <>
      <h4>식과 대입값</h4>
      <ol className="detect-steps">
        {Object.entries(path.path_calculation).map(([name, step]) => <li key={name}>
          <code>{step.formula}</code>
          <small>{step.substituted}</small>
        </li>)}
      </ol>
    </>}
    {command !== null && <p className="path-note">
      탐지가 낸 로봇 명령 — <code>turn {command.turn.deg}°</code> · <code>move_forward {command.move_forward.distance_m} m</code>
      <small> 회전은 스캔 시작 방향 기준(오른쪽 +). 로봇이 한 바퀴 뒤 출발 방향에 서므로 그대로 보냅니다</small>
      {command.warning !== undefined && <> · <span className="detect-map__failed">{command.warning}</span></>}
    </p>}
  </section>;
}

/**
 * **`T-B2` 경로 → 실제로 보낼 명령** (260914). 버튼·발행과 같은 계산(`planApproach`)을 그대로 보여 준다.
 * 실제로 나간 명령과 로봇의 응답은 그 아래 「로봇 명령 · 오간 로그」에 있다.
 */
export function ApproachFacts() {
  useDetect();
  useRobotSession();
  useTick(2000);
  const plan = planApproach();
  return <section className="prep-facts">
    <h3>이동 명령 계산</h3>
    {!plan.ok
      ? <p className="robot-log__empty">{plan.reason}</p>
      : <dl>
        <div><dt>탐지 회전</dt><dd>{turnWords(plan.detectionTurnDeg)} <small>스캔 시작 방향 기준 — 로봇은 한 바퀴 뒤 출발 방향에 서 있으므로 보정 없이 그대로 보낸다</small></dd></div>
        <div className="prep-facts__live"><dt>보낼 명령</dt><dd><b>{plan.steps.map((step) => step.action === 'turn'
          ? `turn ${step.parameters?.deg}°`
          : step.action === 'move_forward' ? `move_forward ${step.parameters?.distance_m} m` : `${step.action}(도착 정지)`).join(' → ')}</b></dd></div>
        <div><dt>직진</dt><dd>경로 {plan.plannedForwardM.toFixed(3)} m{Math.abs(plan.plannedForwardM - plan.issuedForwardM) > 0.0005 && <> · 「테스트」라 {plan.issuedForwardM.toFixed(3)} m 만 보냄</>} · 속도 {plan.forwardVx} m/s <small>로봇 기본값 0.15 m/s 의 두 배 · 회전 속도는 pi7 설정</small></dd></div>
        {plan.notes.map((note) => <div key={note}><dt>참고</dt><dd>{note}</dd></div>)}
      </dl>}
  </section>;
}

const turnWords = (deg: number) => `${deg < 0 ? '왼쪽' : '오른쪽'} ${Math.abs(deg).toFixed(1)}°`;

/** `idle` 은 「임무 시작」 전이거나, 로봇이 안 몰아 대본이 노드를 칠한 경우다. */
const STEP_WORDS = { idle: '아직 안 했습니다 — 로봇이 몰 때 「임무 시작」 뒤에 채워집니다', running: '진행 중', done: '완료', failed: '실패' } as const;

/** **탐지 경로에서 오간 줄.** 그 태스크에 붙은 것만, 받은 순서 그대로. */
export function DetectLogLines({ taskId }: { taskId: string }) {
  const all = useDetectLog();
  const lines = all.filter((line) => line.tasks.includes(taskId));
  return <section className="detect-log">
    <h3>탐지 · 오간 로그</h3>
    {lines.length === 0
      ? <p className="robot-log__empty">이 태스크에 붙은 탐지 쪽 줄이 아직 없습니다 — 로봇이 프레임을 보내거나 탐지 창구가 답하면 여기에 쌓입니다</p>
      : <ol className="detect-log__lines">
        {lines.map((line, at) => <li key={`${line.atIso}-${at}`} className={`is-${line.level} lane-${line.lane}`}>
          <time>{line.atIso.slice(11, 23)}</time>
          <em>{LANE_WORDS[line.lane]}</em>
          <span>{line.text}</span>
          {line.detail !== '' && <code>{line.detail}</code>}
        </li>)}
      </ol>}
  </section>;
}
