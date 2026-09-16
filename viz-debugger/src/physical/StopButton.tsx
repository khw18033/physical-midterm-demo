/**
 * src/physical/StopButton.tsx (260910 신설 — 화면 연결 §4 · 같은 날 셋으로 정리)
 *
 * **머리줄의 임무 조작 셋.** 어느 화면에 있든 늘 떠 있다.
 *
 *   ■ 정지     로봇을 멈추고 **끝낸다.** 진행상황도 종결되고 화면이 잠긴다
 *   ⏸ 일시정지 로봇을 멈추지만 **아무것도 안 버린다.** 여덟 칸도 진행률도 그대로
 *   ▶ 재시작   멈춰 있던 단계를 다시 낸다
 *
 * ## 「중단」을 없애고 「정지」에 합쳤다 (260910 지시)
 *
 * 전에는 「■ 정지」와 「■ 중단」이 나란히 있었다. 정지는 게이트웨이로 `mission_pause` 를
 * 쏘다가 「지원하지 않는 action」으로 거절됐고, 실제로 로봇을 멈추는 것은 중단뿐이었다 —
 * **같은 뜻의 버튼이 둘인데 하나만 동작하는** 상태였다. 발표장에서 어느 쪽을 눌러야 하는지
 * 아는 사람이 없다. 그래서 동작하는 쪽을 「정지」라는 이름에 넣고 중단을 지웠다.
 *
 * ## 지키는 것 넷 (셋 다 같다)
 *
 *  - **어느 화면에 있든 보인다** — 머리줄에 있으므로 마일스톤이든 뷰 노드든 늘 떠 있다
 *  - **확인 대화상자를 띄우지 않는다** — 한 번 누르면 멈춘다
 *  - **크고, 색이 다르고, 다른 버튼과 떨어져 있다** — 잘못 누르는 것보다 못 누르는 게 나쁘다
 *  - **연결이 없어도 비활성화하지 않는다** — 누를 수 있어야 하고 못 보냈으면 그렇게 말한다
 *
 * ## 이건 안전장치가 아니다
 *
 * 화면의 정지는 네트워크를 타고 나간다. 브로커가 죽었거나 Wi-Fi 가 끊기면 안 나간다.
 * **물리적 비상 정지는 로봇 본체와 조종기 쪽에 있다** — 시험할 때도 발표할 때도 조종기를
 * 든 사람이 옆에 있어야 한다.
 */

import { useState } from 'react';
import {
  approachWords, canApproach, emergencyStop, issueApproach, pauseMission, resumeMission,
} from './robotCommands.ts';
import { robotClient } from './robotClient.ts';
import { markStarted, useRobotSession } from './robotSession.ts';
import { useDetect } from '../detect/store.ts';
import { currentMission } from '../data/scenario.ts';

export function StopButton() {
  const session = useRobotSession();
  const locked = session.stopped !== null;
  return <button
    type="button"
    className={`robot-stop${locked ? ' robot-stop--locked' : ''}`}
    // **비활성화하지 않는다.** 연결이 없어도 누를 수 있어야 한다 — 2·3·4 는 그래도 일어난다.
    onClick={() => void emergencyStop(robotClient())}
    title="로봇을 멈추고 임무를 끝냅니다 — 진행상황이 종결되고 다시 승인해야 합니다"
  >
    ■ 정지
  </button>;
}

/**
 * **일시정지.** 정지와 뼈대가 같고 버리는 것만 다르다.
 *
 * 이미 멈춰 있으면 누른 시각을 보여 준다 — 두 번 눌러도 해로울 것은 없지만, 눌렀는데
 * 아무 변화가 없으면 「안 먹었나」가 된다.
 */
export function PauseButton() {
  const session = useRobotSession();
  const paused = session.paused !== null;
  return <button
    type="button"
    className={`robot-pause${paused ? ' robot-pause--held' : ''}`}
    onClick={() => void pauseMission(robotClient())}
    title="로봇을 멈추되 진행상황은 그대로 둡니다 — 재시작하면 그 단계를 다시 합니다"
  >
    {paused ? '⏸ 멈춰 있음' : '⏸ 일시정지'}
  </button>;
}

/**
 * **재시작.** 멈춰 있던 단계를 다시 낸다.
 *
 * **비활성화하지 않는다.** 멈춰 있지 않을 때 눌러도 관문만 풀고 아무것도 안 쏜다 —
 * 회색 버튼을 보고 「왜 안 눌리지」를 묻는 것보다 낫다.
 */
export function ResumeButton() {
  const session = useRobotSession();
  /**
   * **시작과 재시작은 같은 자리의 두 얼굴이다** (260912 지시).
   *
   * 아직 안 돌린 임무면 「임무 시작」, 한 번 돌린 뒤면 「재시작」이다. 버튼을 둘로 나누면
   * 머리줄에 여섯이 되고, 그중 하나는 늘 눌러선 안 되는 것이 된다.
   *
   * **승인만으로는 로봇이 안 움직인다.** 승인은 「이 계획대로 해도 좋다」이고 이 버튼이
   * 「지금 하라」다 — 무대에서 그 둘 사이에 계획을 설명할 시간이 필요하다.
   */
  const started = session.started;
  return <button
    type="button"
    className={started ? 'robot-resume' : 'robot-resume robot-resume--start'}
    onClick={() => {
      if (!started) { markStarted(); return; }
      void resumeMission(robotClient(), currentMission().params);
    }}
    title={started
      ? '멈춰 있던 단계를 다시 냅니다 — 로봇에 이어 하기가 없어 그 단계를 처음부터 합니다'
      : '승인된 임무를 지금 시작합니다 — 이 버튼을 누르기 전에는 로봇이 움직이지 않습니다'}
  >
    {started ? '▶ 재시작' : '▶ 임무 시작'}
  </button>;
}

/**
 * **산출된 경로에 따라 이동.** 스캔이 끝나고 경로가 나온 뒤에만 뜬다.
 *
 * ## 왜 머리줄로 옮겼나 (260912 지시 — 「직전에서 막힘」)
 *
 * 이 버튼은 `RobotPanel` 안에 있었다. 그 패널은 **마일스톤 목록 화면에만** 있다. 그런데
 * 마지막 마일스톤이 끝나면 화면이 다음 마일스톤의 노드 그래프로 저절로 넘어가고(260911),
 * 거기에는 패널이 없다. 경로까지 다 나온 화면에서 「산출된 경로에 따라 이동」 노드가
 * 대기로 떠 있는데 **누를 것이 아무 데도 없었다.**
 *
 * 정지·일시정지·재시작과 같은 자리로 옮긴다 — 임무를 진행시키는 버튼은 어느 화면에 있든
 * 보여야 한다.
 *
 * ## 연결이 없어도 비활성화하지 않는다
 *
 * 정지 버튼과 같은 규칙이다. 누르게 하고, 못 보냈으면 **버튼 자리에 그대로 적는다** —
 * 눌렀는데 아무 변화가 없으면 발표자는 버튼이 죽은 줄 안다.
 *
 * **자동으로 넘어가지 않는다**(§1). 스캔이 끝나면 화면이 초록 노드를 보여 주고 거기서 한
 * 박자 쉰다. 사람이 이 버튼을 누른다.
 */
export function ApproachButton() {
  // 관문이 로봇 세션과 탐지 경로 둘 다를 본다 — 둘 다 구독해야 열리는 순간 다시 그린다.
  useRobotSession();
  useDetect();
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * **기다리는 중이라고 말한다** (260912). 회전이 끝나야 직진을 내므로 누른 뒤 십수 초
   * 동안 아무 일도 안 일어나는 것처럼 보인다. 그때 화면이 조용하면 발표자가 한 번 더 누른다.
   */
  const [busy, setBusy] = useState(false);
  if (!canApproach()) return null;
  const words = approachWords();
  return <button
    type="button"
    className={`robot-approach${failure === null ? '' : ' robot-approach--failed'}`}
    // 두 번 누르면 같은 걸음이 두 번 나간다 — 기다리는 동안만 막는다.
    disabled={busy}
    onClick={() => {
      setFailure(null);
      setBusy(true);
      void issueApproach(robotClient(), currentMission().params).then((outcome) => {
        setBusy(false);
        setFailure(outcome?.sent === true ? null : (outcome?.reason ?? '낼 명령이 없습니다'));
      });
    }}
    title={failure ?? '경로 산출이 낸 회전과 직진을 차례로 냅니다 — 회전이 끝나야 직진이 나갑니다'}
  >
    {busy
      ? <>▶ 로봇이 하는 중 — 앞 명령이 끝나기를 기다립니다</>
      : failure === null
        ? <>▶ 경로대로 이동{words !== null && <small> · {words}</small>}</>
        : <>▶ 못 보냈습니다 — {failure}</>}
  </button>;
}
