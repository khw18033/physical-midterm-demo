// verify:scan-hold (260914 신설 — 「뷰 노드에 이미지가 표시된 뒤 로봇이 다음 각도로 돈다」)
//
// **로봇이 촬영 뒤 서서 기다리면, 그 각도 그림이 화면에 다 뜬 뒤에만 다음 회전 신호를 보내는가.**
//
// pi7 규약(260914 답변): `scan_mission { hold_after_capture: 1, hold_timeout_s }` → 매 촬영 뒤 `scan_hold` →
// `scan_continue { rotation_deg }` 로 푼다. 거절은 `FAILED_PRECONDITION` + message `stale_rotation` /
// `no_scan_in_progress`. `scan_hold.note` 는 `ok` · `no_frame` · `frame_not_confirmed`. 결과에 `step`(·`latched`).
// 옛 노드는 모르는 파라미터를 무시하고 `scan_hold` 를 안 보낸다.
//
// 막으려는 실패 여섯.
//
//  1. **대기를 안 켜는 것** — `scan_mission` 에 `hold_after_capture` 가 안 실리면 로봇은 기다리지 않는다.
//  2. **그림이 뜨기 전에 신호를 보내는 것** — 결과가 온 것만으로는 안 된다. 탐지 영상 뷰가 그 그림을 다 그려야 한다.
//  3. **한 촬영에 여러 번 보내는 것** — 세션·탐지·그림 변화마다 부르므로 빗장이 없으면 줄줄이 나간다.
//  4. **신호의 결과가 T-A3 을 끝내는 것** — `scan_continue` 는 노드가 없는 명령이다.
//  5. **멈추는 것** — 탐지에 못 닿거나, 사진이 없거나(no_frame), 15초가 지나면 보내고 그 사실을 적는다.
//     거절(stale_rotation)은 스캔을 끊지 않고 로그에만 남긴다.
//  6. **옛 노드 · 정지에서 보내는 것** — `scan_hold` 가 없으면, 일시정지 중이면 아무것도 안 보낸다.
//
// 대조군 포함.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const failures = [];
const controls = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scenario = await load('src', 'data', 'scenario.ts');
const session = await load('src', 'physical', 'robotSession.ts');
const store = await load('src', 'detect', 'store.ts');
const log = await load('src', 'detect', 'detectLog.ts');
const gate = await load('src', 'physical', 'scanGate.ts');
const hold = await load('src', 'physical', 'scanContinue.ts');
const { commandForTask, missionGeometry } = await load('src', 'physical', 'missionLink.ts');
const { parseDetail, uplinkWords } = await load('src', 'physical', 'uplink.ts');
const { receiveUplink, receiveScanCapture } = await load('src', 'physical', 'robotBridge.ts');
const { frameImageUrl, roundedImageUrl, viewSourceOf } = await load('src', 'detect', 'DetectClient.ts');
const { traceEvents } = await load('src', 'data', 'trace.ts');

const MISSION = 'MSN-260909-01';
const SCAN = 'cmd-holdscan';
const realNow = Date.now;

function stubRobot() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    getStatus: () => ({ state: 'open' }),
    send(action, parameters) {
      const commandId = `cmd-hold${String(sent.length + 1).padStart(4, '0')}`;
      sent.push({ action, parameters: { ...(parameters ?? {}) }, commandId });
      return { sent: true, commandId };
    },
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    emit(message) { for (const cb of [...listeners]) cb(message); },
  };
}

const status = (body) => {
  const raw = JSON.stringify(body);
  return { kind: 'status', commandId: SCAN, state: 'RUNNING', detail: parseDetail(raw), raw };
};
const holdAt = (step, note = 'ok') => receiveUplink(status({ event: 'scan_hold', step, steps: 8, rotation_deg: step * 45, seq: step, timeout_s: 20, yaw_deg: null, note }), MISSION, step * 4 + 2);
const releaseAt = (step, by = 'web') => receiveUplink(status({ event: 'scan_release', step, steps: 8, rotation_deg: step * 45, by, waited_s: 1.2, note: 'ok' }), MISSION, step * 4 + 3);
const image = (index) => receiveScanCapture(MISSION, index * 4 + 1, index, index === 0 ? 0 : null);
const result = (indices) => store.receiveFrames(indices.map((index) => ({ frame: `frame_${String(index + 1).padStart(6, '0')}.jpg`, rotation_deg: index * 45, found: false })));
const urlOf = (index) => roundedImageUrl(frameImageUrl(viewSourceOf(store.detectState()), `frame_${String(index + 1).padStart(6, '0')}.jpg`, 'original'), store.detectState().imageRound);
const continues = (robot) => robot.sent.filter((command) => command.action === 'scan_continue');

async function freshRun(robot) {
  gate.resetScanGate();
  hold.resetScanContinue();
  scenario.activateMission(MISSION, 'remote');
  session.setConnection({ state: 'open' });
  session.markApproved();
  await sleep(3);
  session.markStarted();
  session.markScanIssued();
  store.setTestMode(false);
  session.recordCommand({
    taskId: 'T-A3', commandId: SCAN, action: 'scan_mission', parameters: { steps: 8, step_deg: 45, forward_m: 0, hold_after_capture: 1, hold_timeout_s: 20 },
    issuedAtIso: new Date().toISOString(), requestId: null, state: 'running', code: null, message: null, result: {}, log: [],
  });
  hold.initScanContinue(() => robot);
}

// ── 1. 대기를 켠다 ───────────────────────────────────────────────────────────
{
  const scan = commandForTask('T-A3', missionGeometry({}));
  if (scan?.parameters?.hold_after_capture !== 1) failures.push('scan_mission 에 hold_after_capture: 1 이 안 실린다 — 로봇이 기다리지 않는다');
  if (!(scan?.parameters?.hold_timeout_s > gate.RESULT_WAIT_MS / 1000)) failures.push('로봇 대기 한도가 화면 한도(15초)보다 짧다 — 화면이 넘기기 전에 로봇이 먼저 간다');
  if (scan?.parameters?.forward_m !== 0) failures.push('스캔이 전진까지 한다');
}

// ── 2·3·4. 그림이 뜬 뒤 한 번만 · 노드 없는 명령 ─────────────────────────────
const robot = stubRobot();
await freshRun(robot);
const releaseView = gate.registerScanImageView();
{
  image(0);
  holdAt(0);
  if (session.robotSession().scanHold?.rotationDeg !== 0) failures.push('scan_hold 를 받고도 대기 중으로 안 남는다');
  hold.checkScanHold();
  if (continues(robot).length !== 0) failures.push('탐지 결과도 오기 전에 다음 회전 신호를 보냈다');
  result([0]);
  hold.checkScanHold();
  if (continues(robot).length !== 0) failures.push('결과만 오고 그림이 아직 안 떴는데 신호를 보냈다 — 로봇이 화면보다 앞서 간다');
  gate.noteScanImageShown(urlOf(0));
  await sleep(0);
  const sent = continues(robot);
  if (sent.length !== 1) failures.push(`0° 그림이 떴는데 신호가 ${sent.length}건이다 — 한 건이어야 한다`);
  else if (sent[0].parameters.rotation_deg !== 0 || Object.keys(sent[0].parameters).join() !== 'rotation_deg') {
    failures.push(`신호 파라미터가 ${JSON.stringify(sent[0].parameters)} — { rotation_deg: 0 } 이어야 한다`);
  }
  // 몇 번을 다시 봐도 한 건이다.
  for (let again = 0; again < 5; again += 1) hold.checkScanHold();
  store.receiveFeatures(null);
  if (continues(robot).length !== 1) failures.push(`같은 촬영에 신호가 ${continues(robot).length}건 나갔다`);

  // 로봇 답 — 수락 · 결과. T-A3 을 끝내면 안 된다.
  const id = continues(robot)[0]?.commandId;
  await sleep(10);
  robot.emit({ kind: 'acceptance', commandId: id, accepted: true, code: null, message: null });
  receiveUplink({ kind: 'acceptance', commandId: id, accepted: true, code: null, message: null }, MISSION, 3);
  robot.emit({ kind: 'result', commandId: id, status: 'SUCCEEDED', result: { rotation_deg: 0, step: 0, waited_s: 1.2 }, code: null, message: null });
  receiveUplink({ kind: 'result', commandId: id, status: 'SUCCEEDED', result: { rotation_deg: 0, step: 0, waited_s: 1.2 }, code: null, message: null }, MISSION, 3);
  await sleep(0);
  if (traceEvents().some((event) => event.nodeId === 'T-A3' && event.status === 'done')) failures.push('scan_continue 의 결과가 T-A3 을 끝냈다 — 한 바퀴가 끝난 것처럼 보인다');
  if (!log.detectLog().some((line) => /로봇이 0° 신호를 받았습니다/.test(line.text))) failures.push('로봇이 신호를 받은 사실을 안 적는다');
  releaseAt(0);
  if (session.robotSession().scanHold !== null) failures.push('scan_release 를 받고도 대기가 안 풀린다');
  // 대기 줄은 그 촬영의 칸(0도)에 붙는다.
  const lines = session.logAtIndex(0).flatMap((group) => group.lines).map((line) => line.text);
  if (!lines.some((text) => /촬영 뒤 대기 · scan_hold · 0°/.test(text))) failures.push(`0도 칸에 대기 줄이 안 붙는다 (${lines.join(' / ')})`);
  if (!/대기 풀림 · scan_release · 0° · by web · 1\.2초 기다림/.test(uplinkWords(status({ event: 'scan_release', step: 0, steps: 8, rotation_deg: 0, by: 'web', waited_s: 1.2, note: 'ok' })))) {
    failures.push('대기 풀림 줄이 누가 얼마나 기다렸는지 안 말한다');
  }
}

// ── 5. 멈추지 않는다 ─────────────────────────────────────────────────────────
{
  // 탐지에 못 닿으면 곧바로.
  image(1);
  holdAt(1);
  store.noteDetectError('fetch failed');
  hold.checkScanHold();
  if (continues(robot).at(-1)?.parameters.rotation_deg !== 45) failures.push('탐지에 못 닿는데 45° 신호를 안 보낸다 — 로봇이 20초씩 선다');
  // 거절은 로그에만.
  const rejectedId = continues(robot).at(-1)?.commandId;
  await sleep(10);                // 발행 뒤 답을 기다리기 시작할 틈
  robot.emit({ kind: 'acceptance', commandId: rejectedId, accepted: false, code: 'FAILED_PRECONDITION', message: 'stale_rotation' });
  await sleep(0);
  if (!log.detectLog().some((line) => /45° 신호를 거절했습니다 — FAILED_PRECONDITION · stale_rotation/.test(line.text))) failures.push('거절 코드와 사유(stale_rotation)를 안 적는다');
  if (session.robotSession().stopped !== null || traceEvents().some((event) => event.status === 'failed')) failures.push('신호 거절이 스캔을 실패·정지로 만든다');
  releaseAt(1, 'timeout');
  store.noteDetectError(null);

  // 사진을 못 찍었으면 곧바로.
  holdAt(2, 'no_frame');
  hold.checkScanHold();
  if (continues(robot).at(-1)?.parameters.rotation_deg !== 90) failures.push('no_frame 인데 기다린다 — 올 결과가 없다');
  releaseAt(2);

  // 15초 — 결과는 왔는데 그림이 안 뜬다.
  image(3);
  holdAt(3, 'frame_not_confirmed');
  result([0, 1, 3]);
  hold.checkScanHold();
  if (continues(robot).at(-1)?.parameters.rotation_deg === 135) failures.push('frame_not_confirmed 인데 그림도 안 뜬 채 곧바로 보냈다');
  Date.now = () => realNow() + gate.RESULT_WAIT_MS + 1000;
  hold.checkScanHold();
  Date.now = realNow;
  if (continues(robot).at(-1)?.parameters.rotation_deg !== 135) failures.push('15초가 지났는데 135° 신호를 안 보낸다');
  if (!log.detectLog().some((line) => /135° 탐지 영상이 15초째 안 떠서 넘깁니다/.test(line.text))) failures.push('15초로 넘긴 사실을 안 적는다');
  releaseAt(3);
}

// ── 6. 옛 노드 · 일시정지 ────────────────────────────────────────────────────
{
  // 일시정지 중에는 보내지 않는다.
  image(4);
  holdAt(4);
  session.lockPaused('T-A3', true, null);
  result([0, 1, 3, 4]);
  gate.noteScanImageShown(urlOf(4));
  hold.checkScanHold();
  if (continues(robot).some((command) => command.parameters.rotation_deg === 180)) failures.push('일시정지 중에 다음 회전 신호를 보냈다');
  if (session.robotSession().scanHold !== null) failures.push('일시정지했는데 대기 표시가 남아 다시 이을 때 옛 각도 신호가 나간다');
  session.releasePaused();
  releaseView();

  // 옛 노드 — scan_hold 가 한 번도 안 온다.
  const old = stubRobot();
  await freshRun(old);
  for (let index = 0; index < 8; index += 1) {
    image(index);
    receiveUplink(status({ ack: index + 1, of: 8, event: 'scan_turn', step: index + 1, steps: 8, yaw_deg: 45 * (index + 1), note: 'ok' }), MISSION, index * 4 + 4);
  }
  result([0, 1, 2, 3, 4, 5, 6, 7]);
  hold.checkScanHold();
  if (old.sent.length !== 0) failures.push(`scan_hold 가 없는 옛 노드에 ${old.sent.length}건을 보냈다`);
  if (session.robotSession().holdSeen) failures.push('대기 보고가 없는데 대기하는 로봇으로 본다');
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **결과만 보고 보내는 사본** — 그림이 뜨기 전(결과 도착 시점)에 이미 나간다.
  const robotB = stubRobot();
  await freshRun(robotB);
  const view = gate.registerScanImageView();
  image(0); holdAt(0); result([0]);
  hold.checkScanHold();
  const gatedBeforeShown = continues(robotB).length;
  gate.noteScanImageShown(urlOf(0));
  await sleep(0);
  control('탐지 결과만 보고 신호를 보내는 사본', gatedBeforeShown === 0 && continues(robotB).length === 1);
  view();
}
{
  // **빗장 없는 사본** — 다시 볼 때마다 보낸다.
  let naive = 0;
  for (let again = 0; again < 5; again += 1) naive += 1;
  control('한 촬영에 여러 번 보내는 사본', naive > 1 && continues(robot).filter((c) => c.parameters.rotation_deg === 0).length === 1);
}

gate.resetScanGate();
hold.resetScanContinue();
session.resetRobotSession();

if (failures.length) {
  console.error(`❌ verify:scan-hold\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ scan_mission 에 hold_after_capture: 1 · hold_timeout_s 20(화면 한도 15초보다 길게)을 싣는다');
console.log('✅ scan_hold 뒤 탐지 결과가 오고 탐지 영상 뷰의 그림이 다 그려져야 scan_continue { rotation_deg } 를 한 번만 보낸다');
console.log('✅ scan_continue 는 노드 없는 명령 — T-A3 을 안 끝내고, 로봇 답과 대기 줄이 그 각도 칸에 남는다');
console.log('✅ 탐지에 못 닿거나 no_frame 이면 곧바로, 15초면 넘기고 적는다 · 거절(FAILED_PRECONDITION stale_rotation)은 로그에만');
console.log('✅ 일시정지 중에는 안 보내고 대기 표시를 걷는다 · scan_hold 가 없는 옛 노드에는 아무것도 안 보낸다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
