/**
 * src/detect/useDetect.tsx (260912 신설)
 *
 * **탐지를 앱 수명 내내 받는다.** `useRobotUplink` 과 같은 자리·같은 이유다 —
 * 마일스톤 화면에만 있는 부품에 두면 노드를 눌러 그래프로 들어가는 순간 끊긴다.
 * 로봇 연동에서 실제로 그래서 마지막 응답 하나를 통째로 잃었다.
 *
 * ## 언제 묻는가
 *
 * **상대가 있을 때만** 묻는다 — 「테스트」가 켜져 있거나 주소가 들어 있을 때. 아무것도
 * 없는데 1.5초마다 실패하는 요청을 던지면 콘솔이 빨갛게 차고, 진짜 문제가 그 안에 묻힌다.
 *
 * 여덟을 다 보기 전에는 짧게, 다 보고 나면 길게 묻는다.
 */

import { useEffect } from 'react';
import { advanceRobotHead } from '../data/scenario.ts';
import { elapsedSec, useRobotSession } from '../physical/robotSession.ts';
import { applyDetection } from './detectBridge.ts';
import { advanceDetectTasks } from './detectTrace.ts';
import { detectBaseUrl } from './DetectClient.ts';
import { startDetectPolling } from './poll.ts';
import { detectState, subscribeDetect, useDetect } from './store.ts';
import { isReplayingRecord } from '../record/replayMode.ts';

export function useDetectUplink(missionId: string, params: Record<string, unknown> | null): void {
  const state = useDetect();
  const stepDeg = typeof params?.viewpoint_step_deg === 'number' ? params.viewpoint_step_deg : 45;
  const count = typeof params?.viewpoint_count === 'number' ? params.viewpoint_count : 8;
  const base = detectBaseUrl();
  /**
   * **시작을 누르기 전에는 안 묻는다** (260912 지시 — 「승인을 누르면 T-A1·T-A2 가 바로
   * 완료로 뜬다」).
   *
   * 자세 역산은 임무 시계와 무관한 파일이라 켜 두면 곧바로 온다. 그래서 승인만 하고
   * 가만히 있어도 앞의 두 노드가 초록이 됐다 — **로봇은 아직 아무것도 안 했는데.**
   *
   * 묻는 시점을 시작에 건다. 승인은 「이 계획대로 해도 좋다」이고, 임무의 첫 걸음은
   * 시작을 누른 뒤에 시작한다.
   */
  const started = useRobotSession().started;

  // 상대가 있고 **임무가 시작됐을 때만** 묻는다. 주소가 바뀌거나 테스트를 켜면 다시 선다.
  useEffect(() => {
    if (!started) return;
    if (!state.testMode && base.trim() === '') return;
    return startDetectPolling(() => detectState().frames.length < count, count, stepDeg);
  }, [started, state.testMode, base, count, stepDeg]);

  /**
   * 받은 것을 여덟 칸에 얹는다. **머리도 같이 민다** — 안 그러면 방금 넣은 프레임이
   * 「아직 안 온 것」으로 걸러진다(로봇 연동에서 그대로 겪은 자리다).
   */
  useEffect(() => subscribeDetect(() => {
    // **다시보기가 채운 결과로는 칠하지 않는다** (260914) — 칸과 노드 상태는 기록 열에 이미 있다.
    if (isReplayingRecord()) return;
    const at = elapsedSec();
    const put = applyDetection(missionId, at, stepDeg, count);
    // **태스크 노드도 민다** (260912). 여덟 칸만 차고 노드가 대기로 남으면 마일스톤이
    // 안 끝나고 다음 마일스톤으로도 안 넘어간다 — 실제로 그랬다.
    const moved = advanceDetectTasks(missionId, at, stepDeg, count);
    if (put > 0 || moved > 0) advanceRobotHead(missionId, at);
  }), [missionId, stepDeg, count]);
}
