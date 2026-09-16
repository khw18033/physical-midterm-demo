import { useMission } from '../data/scenario.ts';
import { ApproachButton, PauseButton, ResumeButton, StopButton } from '../physical/StopButton.tsx';
import { ResetButton, RestartButton } from './ResetButton.tsx';

export function TopBar({ onHome, onReplay }: { onHome(): void; onReplay(): void }) {
  const { current } = useMission();
  // 임무 조작 셋은 **한 부품**에서 온다 (260910). 전에는 여기서 게이트웨이로
  // `mission_pause` 를 쏘다가 「지원하지 않는 action」으로 거절됐다 — 두 상단 바가 각자
  // 손으로 적으면 한쪽만 고쳐진다.
  return <header className="topbar">
    <button className="mission-home" onClick={onHome}><b>{current.missionId}</b><span>{current.label}</span><small>목 데이터 · HCI 초안 · 클릭하면 마일스톤으로</small></button>
    <p>정지는 로봇을 즉시 멈추고 임무를 끝냅니다. 진행상황을 남기려면 일시정지를 쓰세요.</p>
    <nav><StopButton /><PauseButton /><ResumeButton /><ApproachButton /><button onClick={onReplay}>◷ 임무 이력</button><RestartButton /><ResetButton /></nav>
  </header>;
}
