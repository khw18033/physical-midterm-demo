/**
 * src/views/ResetButton.tsx (260910 신설)
 *
 * **화면을 처음 상태로.** 한 판 돌린 뒤 다음 판을 위해 비운다.
 *
 * 지금까지는 새로고침이 유일한 방법이었는데, 새로고침하면 **브로커 연결이 끊긴다** —
 * 무대에서 연결 관리를 다시 열어 붙이는 시간이 아깝고, 그 사이 화면은 빨갛다.
 * 여기서 비우면 연결과 `ping` 결과는 그대로 남는다.
 *
 * ## 두 번 눌러야 한다 (정지 버튼과 반대다)
 *
 * 정지는 **못 누르는 것이 잘못 누르는 것보다 나쁘다** — 그래서 한 번에 멈춘다.
 * 초기화는 반대다. 한 판을 통째로 버리는 일이라 **잘못 누르는 쪽이 훨씬 비싸고**, 급할
 * 이유가 하나도 없다. 그래서 한 번 누르면 물어보고, 다시 눌러야 지운다.
 *
 * 물어보는 상태는 5초 뒤에 저절로 풀린다 — 「정말?」이 화면에 얹힌 채로 남아 있으면
 * 다음에 누르는 사람이 그것을 첫 누름으로 안다.
 */

import { useEffect, useState } from 'react';
import { restartMission, resetMission, useMission } from '../data/scenario.ts';

/**
 * **지금 임무를 처음부터 다시** (260911 지시).
 *
 * 한 판이 끝났거나 정지한 뒤 같은 편을 다시 보려면 발화부터 다시 해야 했다 — 문장을 누르고,
 * 요청하고, 승인하고. 시연 중에 그 셋을 다시 하는 것은 번거롭고, 그동안 화면이 제안
 * 상태로 돌아가 보는 사람이 「방금 것이 실패했나」로 읽는다.
 *
 * ## 머리줄의 「▶ 재시작」과 다른 것이다
 *
 *   ▶ 재시작    **로봇의 멈춘 단계**를 다시 낸다 — 일시정지를 푸는 것
 *   ↻ 처음부터  **임무 한 편**을 처음부터 — 기록·여덟 칸을 비우고 첫 걸음부터
 *
 * 이름을 「재시작」으로 하면 둘이 같아 보인다. 그래서 「처음부터」다.
 *
 * 임무가 없으면 누를 것이 없다 — 그때는 안 그린다. 초기화와 달리 한 번에 돈다.
 * 잘못 눌러도 같은 편을 다시 볼 뿐이고, 시연 중에 두 번 묻는 것이 더 성가시다.
 */
export function RestartButton() {
  const mission = useMission();
  if (mission.current.missionId === '') return null;
  return <button
    type="button"
    className="mission-restart"
    onClick={() => { restartMission(); }}
    title="이 임무를 처음부터 다시 돌립니다 — 발화와 승인을 다시 하지 않아도 됩니다"
  >
    ↻ 처음부터
  </button>;
}

export function ResetButton() {
  const [asking, setAsking] = useState(false);

  // 물어보는 상태를 오래 두지 않는다.
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(timer);
  }, [asking]);

  if (!asking) {
    return <button
      type="button"
      className="mission-reset"
      onClick={() => setAsking(true)}
      title="임무·진행·여덟 칸을 비웁니다. 브로커 연결은 그대로 남습니다"
    >
      ↺ 초기화
    </button>;
  }

  return <span className="mission-reset-ask">
    <button type="button" className="mission-reset mission-reset--confirm" onClick={() => { resetMission(); setAsking(false); }}>
      정말 초기화 — 이 판을 버립니다
    </button>
    <button type="button" className="mission-reset-cancel" onClick={() => setAsking(false)}>취소</button>
  </span>;
}
