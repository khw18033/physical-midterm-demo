/**
 * src/physical/scanContinue.ts (260914 신설 — 「뷰 노드에 이미지가 표시된 뒤 로봇이 다음 각도로 돈다」)
 *
 * **로봇이 촬영 뒤 서서 기다리면, 그 각도의 탐지 영상이 화면에 다 뜬 순간 다음 회전 신호를 보낸다.**
 *
 * pi7 이 `scan_mission { hold_after_capture: 1 }` 을 받으면 매 촬영(/frame 전송) 뒤 `scan_hold` 를 보내고 선다.
 * `scan_continue { rotation_deg }` 가 오면 다음 회전으로 가고, 안 오면 `hold_timeout_s`(20초) 뒤 스스로 간다.
 *
 *   scan_hold(45°)  →  탐지 결과 45° 도착  →  탐지 영상 뷰의 45° 그림 로드 완료  →  scan_continue(45)
 *
 * 「끝났다」의 판단은 각도 칸이 넘어가는 규칙과 같다(`scanGate.angleSettledForHold`) — 칸과 로봇이 같은 박자다.
 * 기다리지 않는 경우도 같다: 탐지가 없거나 못 닿으면 곧바로, 15초가 지나면 넘기고 로그에 적는다.
 * 로봇이 사진을 못 찍었다고(`no_frame`) 하면 올 결과가 없으니 곧바로 보낸다.
 *
 * 한 촬영에 한 번만 보낸다. 발행이 안 됐으면(브로커 끊김) 다음 기회에 다시 보낸다. 정지·일시정지·다시보기 중에는
 * 보내지 않는다. `scan_hold` 가 한 번도 안 오는 판(옛 노드)에서는 아무것도 안 한다.
 */

import { angleTask, appendDetectLog, DETECT_TASKS } from '../detect/detectLog.ts';
import { subscribeDetect } from '../detect/store.ts';
import { isReplayingRecord } from '../record/replayMode.ts';
import type { PhysicalClient } from './PhysicalClient.ts';
import { issueScanContinue } from './robotCommands.ts';
import { canIssueRobotCommand, robotSession, subscribeRobot } from './robotSession.ts';
import { angleSettledForHold, RESULT_WAIT_MS, subscribeScanGate } from './scanGate.ts';

const TICK_MS = 500;

/** 이미 신호를 낸(또는 내는 중인) 촬영 — `시작 시각:촬영 순번`. */
const signalled = new Set<string>();
let clientOf: () => PhysicalClient | null = () => null;
let timer: ReturnType<typeof setInterval> | null = null;
let initialised = false;

function keyOf(step: number): string {
  return `${robotSession().startedAtMs ?? 'none'}:${step}`;
}

/** 한 번 본다. 보낼 때가 됐으면 보낸다. 검사가 직접 부른다. */
export function checkScanHold(): void {
  const session = robotSession();
  const hold = session.scanHold;
  syncTimer(hold !== null);
  if (hold === null || isReplayingRecord() || !canIssueRobotCommand()) return;
  const key = keyOf(hold.step);
  if (signalled.has(key)) return;

  const why = hold.note === 'no_frame' ? 'no-frame' : angleSettledForHold(hold.step, hold.sinceMs);
  if (why === null) return;
  const client = clientOf();
  if (client === null) return;

  signalled.add(key);
  const tasks = [DETECT_TASKS.sweep, angleTask(hold.step)];
  const because = why === 'result' ? '탐지 영상이 화면에 떴습니다'
    : why === 'no-frame' ? '로봇이 사진을 못 찍었다고 합니다(no_frame) — 기다릴 결과가 없습니다'
      : why === 'no-wait' ? '탐지 창구가 없거나 못 닿아 기다리지 않습니다'
        : `탐지 영상이 ${RESULT_WAIT_MS / 1000}초째 안 떠서 넘깁니다`;
  appendDetectLog({
    lane: 'screen', level: why === 'result' ? 'info' : 'warn',
    text: `${hold.rotationDeg}° ${because} → 로봇에 다음 회전 신호(scan_continue)`,
    detail: `로봇 대기 ${((Date.now() - hold.sinceMs) / 1000).toFixed(1)}초${hold.note !== 'ok' ? ` · note ${hold.note}` : ''}`,
    tasks,
  });

  void issueScanContinue(client, hold.rotationDeg).then(({ outcome, answer }) => {
    if (!outcome.sent) {
      // 안 나갔으면 다시 보낼 수 있게 푼다 — 로봇은 아직 서 있다.
      signalled.delete(key);
      appendDetectLog({ lane: 'screen', level: 'warn', text: `${hold.rotationDeg}° 다음 회전 신호를 못 보냈습니다 — ${outcome.reason ?? '사유 없음'}`, detail: '다음 기회에 다시 보냅니다', tasks });
      return;
    }
    if (answer === null) {
      appendDetectLog({ lane: 'robot', level: 'warn', text: `${hold.rotationDeg}° 다음 회전 신호에 로봇 답이 없습니다`, detail: `command_id ${outcome.commandId} · 로봇은 ${hold.timeoutS ?? '?'}초 뒤 스스로 넘어갑니다`, tasks });
      return;
    }
    if (answer.kind === 'result' && answer.status === 'SUCCEEDED') {
      const latched = answer.result.latched === 1;
      appendDetectLog({
        lane: 'robot', level: 'info',
        text: `로봇이 ${hold.rotationDeg}° 신호를 받았습니다${latched ? ' — 대기 들어가기 전에 와서 기억해 두었다가 풉니다' : ' — 다음 회전'}`,
        detail: Object.entries(answer.result).map(([k, v]) => `${k}=${v}`).join(' · '),
        tasks,
      });
      return;
    }
    const code = answer.kind === 'result' ? `${answer.status} ${answer.code ?? ''}` : answer.kind === 'acceptance' ? answer.code ?? '' : '';
    const message = answer.kind === 'status' ? '' : answer.message ?? '';
    appendDetectLog({
      lane: 'robot', level: 'warn',
      text: `로봇이 ${hold.rotationDeg}° 신호를 거절했습니다 — ${[code.trim(), message].filter((v) => v !== '').join(' · ') || '사유 없음'}`,
      detail: message === 'stale_rotation' ? '그 대기는 이미 지나갔습니다(시한으로 넘어갔을 수 있음) — 스캔은 계속됩니다' : '',
      tasks,
    });
  });
}

function syncTimer(holding: boolean): void {
  if (holding && timer === null) {
    timer = setInterval(checkScanHold, TICK_MS);
    (timer as { unref?: () => void }).unref?.();
  } else if (!holding && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** 한 번만 잇는다. 로봇 클라이언트를 만들 때 부른다 — 그리기와 무관한 자리여야 두 판째에도 돈다. */
export function initScanContinue(client: () => PhysicalClient | null): void {
  clientOf = client;
  if (initialised) return;
  initialised = true;
  subscribeRobot(checkScanHold);
  subscribeDetect(checkScanHold);
  subscribeScanGate(checkScanHold);
}

/** 검사용 — 처음 상태로. */
export function resetScanContinue(): void {
  signalled.clear();
  syncTimer(false);
}
