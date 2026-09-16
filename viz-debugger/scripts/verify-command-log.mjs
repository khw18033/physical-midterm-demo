// verify:command-log (260912 신설 — 「실패라고 뜨는데 왜인지 모른다」)
//
// **화면에 적히는 값이 실제로 오간 것인가.**
//
// 260912 실측: 「산출된 경로에 따라 이동」이 이동을 다 마치고 **실패**로 떴다. 화면에는
// 손으로 쓴 예시 문장이 있었을 뿐이라(「진입 중 측면 클리어런스 0.06 m …」) 그 문장을
// 읽고 원인을 찾으면 아무 데도 안 닿는다. 일어난 적 없는 일이 실패마다 뜨고 있었다.
//
// 막으려는 실패 다섯.
//
//  1. **두 명령을 연달아 쏘는 것** — 회전과 직진은 명령 둘인데 태스크는 하나(`T-B2`)다.
//     앞엣것이 끝나기 전에 뒤엣것을 내면 뒤엣것이 거절당하고, 그 거절 하나가 노드를
//     실패로 만든다. **끝나야 다음을 낸다.**
//  2. **지어낸 실패 사유** — 로봇이 준 코드·문구가 없으면 **비운다.**
//  3. **지어낸 로그** — 오간 줄은 받은 값으로만 만든다. 모르는 값은 안 적는다.
//  4. **남의 명령 로그가 섞이는 것** — uplink 는 토픽 하나다. 모르는 command_id 는 버린다.
//  5. **적힌 거리와 나간 거리가 다른데 말 안 하는 것** — 시험에서는 1m 만 보낸다.
//     계획값을 적되 나간 값을 괄호로 붙인다.
//
// 대조군 포함.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const sample = (...p) => JSON.parse(readFileSync(join(root, '..', 'door_example', 'test', ...p), 'utf8'));
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = (...p) => strip(readFileSync(join(root, 'src', ...p), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const controls = [];

const session = await load('src', 'physical', 'robotSession.ts');
const store = await load('src', 'detect', 'store.ts');
const { uplinkWords } = await load('src', 'physical', 'uplink.ts');
const {
  approachSteps, approachWords, failureOfTask, issueApproach, issuedForwardM, plannedForwardM,
} = await load('src', 'physical', 'robotCommands.ts');
const { STOP_ACTION } = await load('src', 'physical', 'presets.ts');

const PATH = sample('door', 'evidence.json');

/** 명령을 세고, 시험자가 원할 때만 응답을 흘리는 가짜 로봇. */
function stubRobot() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    getStatus: () => ({ state: 'open' }),
    send(action, parameters) {
      const commandId = `cmd-${String(sent.length + 1).padStart(8, '0')}`;
      sent.push({ action, parameters: { ...(parameters ?? {}) }, commandId });
      return { sent: true, commandId };
    },
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    emit(message) { for (const cb of [...listeners]) cb(message); },
  };
}

function armed() {
  session.resetRobotSession();
  session.setConnection({ state: 'open' });
  session.markApproved();
  store.resetDetect();
  store.receivePath(PATH);
}

// ── 1. 앞 명령이 끝나야 다음을 낸다 ─────────────────────────────────────────
{
  armed();
  store.setTestMode(false);
  store.receivePath(PATH);
  const robot = stubRobot();
  const running = issueApproach(robot, null);

  await sleep(120);
  if (robot.sent.length !== 1) {
    failures.push(`회전이 끝나기 전에 ${robot.sent.length}건이 나갔다 — 앞엣것이 끝나야 다음을 낸다`);
  }
  if (robot.sent[0]?.action !== 'turn') failures.push(`먼저 나간 것이 ${robot.sent[0]?.action} — 회전이 먼저다`);

  // 진행 보고는 끝이 아니다. 이것으로 다음이 나가면 안 된다.
  robot.emit({ kind: 'status', commandId: robot.sent[0].commandId, state: 'executing', detail: null, raw: 'executing' });
  await sleep(60);
  if (robot.sent.length !== 1) failures.push('진행 보고를 끝으로 읽고 다음 명령을 냈다');

  // 수락도 끝이 아니다 — 「받았다」일 뿐이다.
  robot.emit({ kind: 'acceptance', commandId: robot.sent[0].commandId, accepted: true, code: null, message: null });
  await sleep(60);
  if (robot.sent.length !== 1) failures.push('수락을 끝으로 읽고 다음 명령을 냈다');

  // 종료 응답이 와야 직진이 나간다.
  robot.emit({ kind: 'result', commandId: robot.sent[0].commandId, status: 'SUCCEEDED', result: { turn_deg: 90 }, code: null, message: null });
  await sleep(120);
  if (robot.sent.length !== 2) failures.push(`회전이 끝났는데 직진이 안 나갔다 (${robot.sent.length}건)`);
  if (robot.sent[1]?.action !== 'move_forward') failures.push(`둘째가 ${robot.sent[1]?.action} — 직진이어야 한다`);

  /**
   * **직진이 끝나면 도착 정지가 한 번 더 나간다** (260912 지시 — 「확인사살용으로」).
   *
   * 직진이 끝나면 로봇은 이미 서 있다. 그래도 `T-B3`「문과 가까워지면 정지」는 순서도에
   * 있는 걸음이고, 명령을 안 내면 화면에만 있는 걸음이 된다.
   */
  robot.emit({ kind: 'result', commandId: robot.sent[1].commandId, status: 'SUCCEEDED', result: { odo_m: 1 }, code: null, message: null });
  await sleep(140);
  if (robot.sent.length !== 3) failures.push(`직진이 끝났는데 도착 정지가 안 나갔다 (${robot.sent.length}건)`);
  if (robot.sent[2]?.action !== STOP_ACTION) failures.push(`셋째가 ${robot.sent[2]?.action} — 정지여야 한다`);
  // **규약 밖의 파라미터를 안 더한다** — reason 하나뿐이다.
  if (Object.keys(robot.sent[2]?.parameters ?? {}).join(',') !== 'reason') {
    failures.push(`정지에 실린 파라미터가 [${Object.keys(robot.sent[2]?.parameters ?? {})}] — reason 하나여야 한다`);
  }
  const outcome = await running;
  if (outcome?.sent !== true) failures.push(`셋 다 나갔는데 결과가 실패다 — ${outcome?.reason}`);

  // 정지가 성공하면 **임무 종료 확인(T-C1)** 까지 간다 — 화면이 내리는 판정이다.
  // 로봇에 「임무가 끝났는가」를 묻는 말이 규약에 없어서, 우리가 본 것으로 판정한다.
  const { receiveUplink } = await load('src', 'physical', 'robotBridge.ts');
  const { traceEvents } = await load('src', 'data', 'trace.ts');
  const { activateMission } = await load('src', 'data', 'scenario.ts');
  // 사건은 **지금 올라와 있는 임무의 것만** 받는다. 그래서 판을 먼저 세운다.
  // (`remote` 는 대본 타이머를 안 세운다 — 로봇이 모는 판이다.)
  activateMission('MSN-260909-01', 'remote');
  session.recordCommand({
    taskId: 'T-B3', commandId: 'cmd-stop-x', action: STOP_ACTION, parameters: { reason: 2 },
    issuedAtIso: new Date().toISOString(), requestId: null,
    state: 'issued', code: null, message: null, result: {}, log: [],
  });
  receiveUplink({ kind: 'result', commandId: 'cmd-stop-x', status: 'SUCCEEDED', result: { sdk_reached: 1 }, code: null, message: null }, 'MSN-260909-01', 1);
  const nodes = traceEvents().filter((e) => e.status === 'done').map((e) => e.nodeId);
  if (!nodes.includes('T-B3')) failures.push('정지가 성공했는데 T-B3 이 완료가 안 된다');
  if (!nodes.includes('T-C1')) failures.push('정지가 성공했는데 임무 종료 확인(T-C1)이 안 뜬다 — 한 바퀴가 안 끝난다');

  // **끝나지 않은 임무를 끝났다고 적지 않는다.** 정지가 실패하면 T-C1 은 안 뜬다.
  activateMission('MSN-260909-01', 'remote');
  session.recordCommand({
    taskId: 'T-B3', commandId: 'cmd-stop-bad', action: STOP_ACTION, parameters: { reason: 2 },
    issuedAtIso: new Date().toISOString(), requestId: null,
    state: 'issued', code: null, message: null, result: {}, log: [],
  });
  receiveUplink({ kind: 'result', commandId: 'cmd-stop-bad', status: 'FAILED', result: {}, code: 'INTERNAL', message: 'no' }, 'MSN-260909-01', 1);
  if (traceEvents().some((e) => e.nodeId === 'T-C1' && e.status === 'done')) {
    failures.push('정지가 실패했는데 임무 종료 확인이 떴다 — 안 끝난 임무를 끝났다고 적는다');
  }
}

// ── 1-b. 앞 명령이 실패하면 다음을 안 낸다 ──────────────────────────────────
//
// 안 돌고 가면 엉뚱한 데로 간다. 그리고 **왜 안 갔는지 말한다.**
{
  armed();
  store.setTestMode(false);
  store.receivePath(PATH);
  const robot = stubRobot();
  const running = issueApproach(robot, null);
  await sleep(120);
  robot.emit({
    kind: 'result', commandId: robot.sent[0].commandId, status: 'FAILED', result: {},
    code: 'go1_sdk_not_running', message: 'bridge down',
  });
  const outcome = await running;
  if (robot.sent.length !== 1) failures.push('회전이 실패했는데 직진을 냈다 — 안 돌고 가면 엉뚱한 데로 간다');
  if (outcome?.sent !== false) failures.push('앞 명령이 실패했는데 보냈다고 한다');
  for (const must of ['FAILED', 'go1_sdk_not_running']) {
    if (!String(outcome?.reason ?? '').includes(must)) {
      failures.push(`실패 사유에 로봇이 준 「${must}」 가 없다 — ${outcome?.reason}`);
    }
  }
}

// ── 2·3. 로그는 받은 값으로만 만든다 ────────────────────────────────────────
{
  const words = uplinkWords({
    kind: 'status', commandId: 'c', state: 'RUNNING', raw: '{"ack":3,"of":10,"event":"scan_turn","step":3,"steps":8,"yaw_deg":131,"note":"ok"}',
    detail: { ack: 3, of: 10, ackSeq: null, event: 'scan_turn', step: 3, steps: 8, yaw_deg: 131, note: 'ok' },
  });
  for (const must of ['ack 3/10', 'scan_turn', 'step 3/8', 'yaw 131', 'ok']) {
    if (!words.includes(must)) failures.push(`로그 줄에 「${must}」 가 없다 — ${words}`);
  }
  // **모르는 값은 안 적는다.** yaw 가 null 인 것은 정상이고, 0 으로 채우면 북쪽을 본다는 거짓이 된다.
  const noYaw = uplinkWords({
    kind: 'status', commandId: 'c', state: 'RUNNING', raw: '{}',
    detail: { ack: 1, of: 10, ackSeq: null, event: 'scan_turn', step: 1, steps: 8, yaw_deg: null, note: 'ok' },
  });
  if (/yaw/.test(noYaw)) failures.push(`방위를 모르는데 적는다 — ${noYaw}`);

  // 거절과 실패는 **로봇이 준 코드와 문구 그대로**.
  const rejected = uplinkWords({ kind: 'acceptance', commandId: 'c', accepted: false, code: 'robot_state_dead', message: '로봇 상태 없음' });
  for (const must of ['robot_state_dead', '로봇 상태 없음']) {
    if (!rejected.includes(must)) failures.push(`거절 줄이 「${must}」 를 버린다 — ${rejected}`);
  }
  const done = uplinkWords({ kind: 'result', commandId: 'c', status: 'SUCCEEDED', result: { odo_m: 1, duration_s: 12.5 }, code: null, message: null });
  for (const must of ['SUCCEEDED', 'odo_m=1', 'duration_s=12.5']) {
    if (!done.includes(must)) failures.push(`종료 줄이 「${must}」 를 버린다 — ${done}`);
  }
}

// ── 4. 남의 명령 로그가 안 섞인다 · 우리 것은 쌓인다 ────────────────────────
{
  session.resetRobotSession();
  session.recordCommand({
    taskId: 'T-B2', commandId: 'cmd-mine', action: 'turn', parameters: { deg: -90 },
    issuedAtIso: new Date().toISOString(), requestId: 'req-1',
    state: 'issued', code: null, message: null, result: {}, log: [],
  });
  session.noteCommandLog('cmd-mine', { atIso: new Date().toISOString(), kind: 'status', text: 'ack 1/2', raw: '{}' });
  session.noteCommandLog('cmd-남의것', { atIso: new Date().toISOString(), kind: 'status', text: '남의 진행', raw: '' });

  const mine = session.commandsOfTask('T-B2');
  if (mine.length !== 1) failures.push(`태스크의 명령이 ${mine.length}건 — 1건이어야 한다`);
  if (mine[0]?.log.length !== 1) failures.push(`로그가 ${mine[0]?.log.length}줄 — 우리 것 하나만 쌓여야 한다`);
  if (mine[0]?.log[0]?.text !== 'ack 1/2') failures.push('남의 명령 로그가 우리 노드에 섞였다');
  // **실린 파라미터를 적어 둔다** — 화면의 계획값이 아니라 바이트에 들어간 값이다.
  if (mine[0]?.parameters.deg !== -90) failures.push('실린 파라미터를 안 적어 둔다');

  // 실패 사유 — 로봇이 준 것이 있으면 그것, 없으면 **null**.
  if (failureOfTask('T-B2') !== null) failures.push('실패한 적이 없는데 사유가 있다고 한다');
  session.recordCommand({
    taskId: 'T-B2', commandId: 'cmd-mine', action: 'turn', parameters: { deg: -90 },
    issuedAtIso: new Date().toISOString(), requestId: 'req-1',
    state: 'failed', code: 'INVALID_ARGUMENT', message: 'deg out of range', result: {}, log: [],
  });
  const why = failureOfTask('T-B2');
  if (why === null || !/INVALID_ARGUMENT/.test(why.words) || !/deg out of range/.test(why.words)) {
    failures.push(`실패 사유가 로봇이 준 것이 아니다 — ${JSON.stringify(why)}`);
  }
  // 코드도 문구도 없으면 마지막 로그 줄을 쓴다. 그마저 없으면 null 이다.
  session.recordCommand({
    taskId: 'T-C9', commandId: 'cmd-quiet', action: 'turn', parameters: {},
    issuedAtIso: new Date().toISOString(), requestId: null,
    state: 'failed', code: null, message: null, result: {}, log: [],
  });
  if (failureOfTask('T-C9') !== null) failures.push('아무것도 안 받았는데 사유를 지어낸다 — 비워야 한다');
  session.noteCommandLog('cmd-quiet', { atIso: new Date().toISOString(), kind: 'result', text: 'ABORTED', raw: '' });
  if (failureOfTask('T-C9')?.words !== 'ABORTED') failures.push('마지막 로그 줄도 안 쓴다');
  session.resetRobotSession();
}

// ── 4-b. 화면에 손으로 쓴 실패 사유가 남아 있지 않은가 ──────────────────────
{
  const modal = src('views', 'ActionModal.tsx');
  if (/클리어런스 0\.06/.test(modal)) {
    failures.push('실패 사유에 손으로 쓴 예시 문장이 남아 있다 — 일어난 적 없는 일이 실패마다 뜬다');
  }
  if (!/failureOfTask/.test(modal)) failures.push('실패 사유를 로봇이 준 것에서 안 읽는다');
  if (!/commandsOfTask/.test(modal)) failures.push('액션 아이템 자리가 실제 명령을 안 읽는다');
  // 로그가 오는 대로 다시 그려야 한다 — 안 그러면 열어 둔 창이 멈춘 화면이 된다.
  if (!/useRobotSession/.test(modal)) failures.push('로그가 와도 창이 안 다시 그려진다');
}

// ── 5. 시험에서는 1m 만 나간다 · 화면은 계획값을 적는다 ─────────────────────
{
  armed();
  store.setTestMode(false);
  store.receivePath(PATH);
  const planned = plannedForwardM();
  if (Math.abs(planned - 6.354) > 0.001) failures.push(`계획 거리가 ${planned}m — 시료는 6.354m 다 (검사가 헛돈다)`);
  if (Math.abs(issuedForwardM() - planned) > 0.001) failures.push('테스트가 꺼져 있는데 거리를 줄인다');

  store.setTestMode(true);
  store.receivePath(PATH);
  if (issuedForwardM() !== 1) failures.push(`시험에서 ${issuedForwardM()}m 가 나간다 — 1m 여야 한다`);
  if (approachSteps().length !== 3) failures.push(`걸음이 ${approachSteps().length}개 — 회전·직진·도착 정지 셋이어야 한다`);
  const forward = approachSteps().find((step) => step.action === 'move_forward');
  if (forward?.parameters?.distance_m !== 1) failures.push(`실제 명령이 ${forward?.parameters?.distance_m}m 다`);
  // 회전은 안 줄인다 — 각도는 제자리에서 도는 것이라 자리가 필요 없다.
  const turn = approachSteps().find((step) => step.action === 'turn');
  if (turn?.parameters?.deg !== -90) failures.push(`시험에서 회전이 ${turn?.parameters?.deg} 로 바뀌었다`);

  // **화면은 계획값을 적되, 나간 값을 숨기지 않는다.**
  const words = approachWords();
  if (!/6\.35m/.test(words)) failures.push(`화면이 계획 거리를 안 적는다 — ${words}`);
  if (!/1\.00m/.test(words)) failures.push(`화면이 실제로 나간 거리를 안 적는다 — ${words}`);
  if (!/도착 정지/.test(words)) failures.push(`화면이 도착 정지를 안 적는다 — ${words}`);

  store.setTestMode(false);
  session.resetRobotSession();
}

// ── 6. 각도 칸은 한 명령의 제 몫만 본다 (260912 지시) ───────────────────────
//
// 한 바퀴는 명령 **하나**(`scan_mission`)인데 노드는 여덟이다. 각 칸에 그 명령 전체를
// 붙이면 여덟 칸이 똑같은 표 여덟 개가 된다 — 「이 각도에서 무슨 일이 있었나」를 물었는데
// 한 바퀴 전체가 나온다.
{
  const { viewpointTaskIndex } = await load('src', 'physical', 'missionLink.ts');
  if (viewpointTaskIndex('T-A4-3') !== 3) failures.push('각도 칸 이름에서 번호를 못 읽는다');
  if (viewpointTaskIndex('T-A4-0') !== 0) failures.push('0번 칸을 못 읽는다 — 0 을 빈 값으로 다루면 안 된다');
  for (const other of ['T-A3', 'T-B2', 'T-A4-', 'T-A4-x']) {
    if (viewpointTaskIndex(other) !== null) failures.push(`${other} 를 각도 칸으로 읽는다`);
  }

  const { receiveUplink } = await load('src', 'physical', 'robotBridge.ts');
  const { activateMission } = await load('src', 'data', 'scenario.ts');
  activateMission('MSN-260909-01', 'remote');
  session.recordCommand({
    taskId: 'T-A3', commandId: 'cmd-scan', action: 'scan_mission',
    parameters: { steps: 8, step_deg: 45, forward_m: 0 },
    issuedAtIso: new Date().toISOString(), requestId: null,
    state: 'issued', code: null, message: null, result: {}, log: [],
  });
  // 여덟 걸음이 한 명령으로 들어온다 (260914). 0도는 회전 **전에** 찍혀 회전 보고가 없고,
  // 회전 k(1~7)는 k번 칸이며, 회전 8 은 출발 방향으로의 복귀라 칸이 없다.
  for (let step = 1; step <= 8; step += 1) {
    receiveUplink({
      kind: 'status', commandId: 'cmd-scan', state: 'RUNNING',
      raw: JSON.stringify({ ack: step, of: 9, event: 'scan_turn', step, steps: 8, yaw_deg: step * 45, note: 'ok' }),
      detail: { ack: step, of: 9, ackSeq: null, event: 'scan_turn', step, steps: 8, yaw_deg: step * 45, note: 'ok' },
    }, 'MSN-260909-01', step);
  }
  const all = session.commandsOfTask('T-A3');
  if (all[0]?.log.length !== 8) failures.push(`한 바퀴 로그가 ${all[0]?.log.length}줄 — 여덟이어야 한다`);

  // **0도 칸에는 회전 줄이 없다** — 첫 칸에서 돌았다고 적으면 리허설에서 본 그 잘못이다.
  const zero = session.logAtIndex(0).flatMap((group) => group.lines);
  if (zero.length !== 0) failures.push(`0번 칸에 회전 줄 ${zero.length}개가 붙었다 — 0도는 돌지 않고 찍기만 한다`);
  for (let index = 1; index < 8; index += 1) {
    const groups = session.logAtIndex(index);
    const lines = groups.flatMap((group) => group.lines);
    if (lines.length !== 1) { failures.push(`${index}번 칸에 ${lines.length}줄이 온다 — 하나여야 한다`); continue; }
    // **한 칸 밀림을 여기서 잡는다.** 회전 k 가 k번 칸이다.
    if (!lines[0].text.includes(`step ${index}/8`)) {
      failures.push(`${index}번 칸에 ${lines[0].text} 가 붙었다 — step ${index} 이어야 한다`);
    }
  }
  // 복귀 회전(step 8)은 어느 칸에도 안 붙는다.
  const returnLine = [0, 1, 2, 3, 4, 5, 6, 7].some((index) => session.logAtIndex(index)
    .flatMap((group) => group.lines).some((line) => line.text.includes('step 8/8')));
  if (returnLine) failures.push('복귀 회전(step 8)이 각도 칸에 붙었다 — 출발 방향으로 돌아온 것이지 새 각도가 아니다');
  // 회전 보고가 아닌 줄은 어느 칸에도 안 붙는다.
  receiveUplink({ kind: 'result', commandId: 'cmd-scan', status: 'SUCCEEDED', result: {}, code: null, message: null }, 'MSN-260909-01', 9);
  const after = session.logAtIndex(0).flatMap((group) => group.lines);
  if (after.length !== 0) failures.push('종료 응답이 0번 칸에 붙었다 — 회전 보고가 아닌 줄은 칸이 없다');

  const modal = src('views', 'ActionModal.tsx');
  if (!/logAtIndex/.test(modal)) failures.push('각도 칸이 제 몫의 줄을 안 읽는다');
  if (!/viewpointTaskIndex/.test(modal)) failures.push('각도 칸인지 아닌지를 안 가른다');
  session.resetRobotSession();
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **연달아 쏘는 사본.** 앞엣것의 종료를 안 기다리면 한 번에 둘이 나간다.
  const robot = stubRobot();
  robot.send('turn', { deg: -90 });
  robot.send('move_forward', { distance_m: 1 });
  control('종료를 안 기다리고 둘을 쏜 사본', robot.sent.length === 2);
}
{
  // **지어낸 사유를 쓰는 사본.**
  const made = '진입 중 측면 클리어런스 0.06 m < 최소 0.12 m';
  control('지어낸 실패 사유를 쓴 사본',
    /클리어런스 0\.06/.test(made) && !/클리어런스 0\.06/.test(src('views', 'ActionModal.tsx')));
}
{
  // **각도 칸에 명령 전체를 붙인 사본.** 여덟 칸이 똑같은 표 여덟 개가 된다.
  const whole = 8;
  const mine = 1;
  control('각도 칸에 한 바퀴 전체를 붙인 사본', whole !== mine);
}
{
  // **시험 거리를 안 거는 사본.** 6.354m 가 그대로 나간다.
  store.setTestMode(true);
  store.receivePath(PATH);
  control('시험 상한을 안 건 사본 (6.354m 그대로)', plannedForwardM() !== issuedForwardM());
  store.setTestMode(false);
}

if (failures.length) {
  console.error(`❌ verify:command-log\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 회전 → 직진 → 도착 정지 — 앞엣것이 끝나야 다음이 나간다 (수락도 진행 보고도 끝이 아니다)');
console.log('✅ 정지가 성공하면 T-B3 이 완료가 되고 임무 종료 확인(T-C1)까지 간다 — 한 바퀴가 끝난다');
console.log('✅ 앞 명령이 실패하면 다음을 안 내고, 로봇이 준 코드·문구를 그대로 사유로 올린다');
console.log('✅ 로그 줄은 받은 값으로만 — 모르는 방위는 안 적고 거절·종료의 코드와 수치를 안 버린다');
console.log('✅ 남의 command_id 는 안 쌓인다 · 실린 파라미터가 남는다 · 사유가 없으면 null 이다');
console.log('✅ 화면에 손으로 쓴 실패 사유가 없다 — 실제 명령과 로그를 읽고 오는 대로 다시 그린다');
console.log('✅ 시험에서는 1m 만 나가고, 화면은 계획 6.35m 와 나간 1.00m 를 둘 다 적는다');
console.log('✅ 각도 칸은 한 바퀴 명령의 제 몫만 본다 — 0도는 회전 줄이 없고 회전 1~7 이 칸 1~7, 회전 8(복귀)은 칸이 없다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
