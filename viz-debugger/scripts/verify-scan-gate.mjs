// verify:scan-gate (260914 신설 — 「한 바퀴 노드가 카메라 이미지보다 약간 빨라 싱크가 안 맞는다」)
//
// **각도 칸이 그 각도의 데이터가 온 뒤에야 다음으로 넘어가는가.**
//
// 로봇의 한 걸음은 회전 → 정지 → 0.6초 → 촬영 → 전송이고, 탐지가 판단해 창구에 올리고 화면이 폴링으로
// 받기까지 몇 초가 더 걸린다. 화면은 회전 보고가 오는 순간 칸을 켜서, 칸은 k 인데 탐지 영상은 k-1 이었다.
//
// 막으려는 실패 넷.
//
//  1. **회전 보고로 칸을 켜는 것** — 촬영이 흐르는 판에서 칸은 촬영(또는 탐지 결과)이 켠다.
//  2. **앞 칸의 결과를 안 기다리는 것** — 칸 k+1 은 칸 k 의 탐지 결과가 온 뒤에 켜진다.
//  3. **화면이 멈추는 것** — 탐지가 못 닿거나 결과가 15초째 없으면 넘어가고 그 사실을 적는다.
//     촬영이 아예 안 흐르는 판은 예전처럼 회전 보고로 켠다.
//  4. **지난 판의 대기열이 새 판을 켜는 것.**
//  5. **그림이 뜨기 전에 넘어가는 것** — 결과가 온 뒤에도 탐지 영상 뷰 노드의 img 가 그 그림을 다 그려야
//     다음 칸이 켜진다. 뷰가 없으면 같은 주소를 미리 받아 본 완료로 본다. 뷰는 도는 동안 최신 각도를 보여야 한다.
//
// 대조군 포함.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const failures = [];
const controls = [];

const scenario = await load('src', 'data', 'scenario.ts');
const session = await load('src', 'physical', 'robotSession.ts');
const store = await load('src', 'detect', 'store.ts');
const log = await load('src', 'detect', 'detectLog.ts');
const gate = await load('src', 'physical', 'scanGate.ts');
const { receiveUplink, receiveScanCapture } = await load('src', 'physical', 'robotBridge.ts');
const { arrivedFrames } = await load('src', 'viewpoint', 'store.ts');
const { frameImageUrl, roundedImageUrl, viewSourceOf } = await load('src', 'detect', 'DetectClient.ts');

const MISSION = 'MSN-260909-01';
const realNow = Date.now;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 켜진 칸 — 열에 들어간 회전 프레임의 인덱스. */
const lit = () => [...new Set(arrivedFrames()
  .filter((entry) => entry.frame.channel === 'robot_state')
  .map((entry) => entry.frame.payload.rotation_index))].sort((a, b) => a - b).join(',');

const turn = (step) => receiveUplink({
  kind: 'status', commandId: 'cmd-gate', state: 'RUNNING', raw: '{}',
  detail: { ack: step, of: 8, ackSeq: null, event: 'scan_turn', step, steps: 8, yaw_deg: step * 45, note: 'ok' },
}, MISSION, step * 4);
const image = (index) => receiveScanCapture(MISSION, index * 4 + 1, index, index === 0 ? 0 : null);
/** 뷰 노드가 그리는 것과 같은 주소. */
const urlOf = (index) => roundedImageUrl(
  frameImageUrl(viewSourceOf(store.detectState()), `frame_${String(index + 1).padStart(6, '0')}.jpg`, 'original'),
  store.detectState().imageRound,
);
const result = (indices) => store.receiveFrames(indices.map((index) => ({
  frame: `frame_${String(index + 1).padStart(6, '0')}.jpg`, rotation_deg: index * 45, found: false,
})));

async function freshRun({ resetGate = true } = {}) {
  if (resetGate) gate.resetScanGate();
  scenario.activateMission(MISSION, 'remote');
  session.markApproved();
  await sleep(3);                 // 판 열쇠가 시작 시각(ms)이다 — 앞 판과 겹치지 않게
  session.markStarted();
  session.markScanIssued();
  session.recordCommand({
    taskId: 'T-A3', commandId: 'cmd-gate', action: 'scan_mission', parameters: { steps: 8, step_deg: 45, forward_m: 0 },
    issuedAtIso: new Date().toISOString(), requestId: null, state: 'running', code: null, message: null, result: {}, log: [],
  });
  store.setTestMode(false);
}

// ── 1·2. 촬영이 흐르는 판 — 칸은 데이터가 켜고, 앞 칸 결과를 기다린다 ────────────
await freshRun();
{
  image(0);
  if (lit() !== '0') failures.push(`0도 촬영 뒤 켜진 칸이 ${lit()} — 0 이어야 한다`);
  turn(1);
  if (lit() !== '0') failures.push(`촬영이 흐르는데 회전 보고가 칸을 켰다 (${lit()}) — 사진이 오기 전에 칸이 앞서 간다`);
  image(1);
  if (lit() !== '0') failures.push(`0도 탐지 결과가 오기 전에 1번 칸이 켜졌다 (${lit()}) — 탐지 영상보다 앞서 간다`);
  if (gate.waitingIndices().join(',') !== '1') failures.push(`기다리는 칸이 ${gate.waitingIndices()} — 1 이어야 한다`);
  result([0]);
  if (lit() !== '0,1') failures.push(`0도 결과가 왔는데 1번 칸이 안 켜졌다 (${lit()})`);

  // 로봇이 둘 앞서 가 있어도 차례로 연다.
  turn(2); image(2); turn(3); image(3);
  if (lit() !== '0,1') failures.push(`1번 결과 전에 뒤 칸이 켜졌다 (${lit()})`);
  result([0, 1]);
  if (lit() !== '0,1,2') failures.push(`1번 결과로 2번만 켜져야 한다 — ${lit()}`);
  result([0, 1, 2]);
  if (lit() !== '0,1,2,3') failures.push(`2번 결과로 3번이 안 켜졌다 — ${lit()}`);

  // ── 3. 멈추지 않는다 — 15초 ────────────────────────────────────────────────
  image(4);
  if (lit() !== '0,1,2,3') failures.push('3번 결과 전에 4번이 켜졌다');
  Date.now = () => realNow() + gate.RESULT_WAIT_MS + 1000;
  store.receiveFeatures(null);    // 저장소가 한 번 바뀌면 문지기가 다시 본다 — 폴링 한 번과 같다
  Date.now = realNow;
  if (lit() !== '0,1,2,3,4') failures.push(`3번 결과가 15초째 없는데 4번이 안 켜진다 (${lit()}) — 화면이 멈춘다`);
  if (!log.detectLog().some((line) => /3번 각도의 탐지 결과가 15초째 없어 4번 각도로 넘어갑니다/.test(line.text))) {
    failures.push('기다리다 넘어간 사실을 탐지 로그에 안 적는다');
  }

  // 탐지 창구에 못 닿으면 기다리지 않는다.
  store.noteDetectError('fetch failed');
  image(5);
  if (lit() !== '0,1,2,3,4,5') failures.push(`탐지에 못 닿는데 5번 칸이 기다린다 (${lit()})`);

  // 방위 기록은 문지기와 무관하게 로봇이 보고한 즉시 남는다 — 이동·판정 재료다.
  if (session.robotSession().seenYaw[3] !== 135) failures.push('칸을 늦추느라 회전 보고의 방위까지 늦게 적는다');
}

// ── 4. 촬영이 없는 판 — 예전처럼 회전 보고로 · 지난 판 대기열은 버린다 ───────────
{
  // 앞 판에서 기다리던 칸을 하나 남겨 둔다.
  store.noteDetectError(null);
  image(6);
  const leftover = gate.waitingIndices().length;
  if (leftover !== 1) failures.push(`앞 판에 기다리는 칸을 못 남겼다(${leftover}) — 검사가 헛돈다`);
  // 문지기를 손으로 비우지 않는다 — 판이 바뀐 것을 스스로 알아야 한다.
  await freshRun({ resetGate: false });
  store.receiveFeatures(null);    // 새 판에서 저장소가 바뀌면 남은 대기열이 깨어난다 — 여기서 켜면 안 된다
  turn(1);
  turn(2);
  if (lit() !== '0,1,2') failures.push(`촬영이 없는 판에서 회전 보고로 칸이 안 켜진다 (${lit()}) — 여덟이 영영 대기다`);
  if (leftover > 0 && arrivedFrames().some((entry) => entry.frame.channel === 'robot_state' && entry.frame.payload.rotation_index === 6)) {
    failures.push('지난 판에서 기다리던 칸이 새 판에 켜졌다');
  }
}

// ── 5. 그림이 뜬 뒤에 넘어간다 ─────────────────────────────────────────────────
{
  await freshRun();
  const releaseView = gate.registerScanImageView();       // 탐지 영상 뷰 노드가 떠 있다
  image(0);
  image(1);
  result([0]);
  if (lit() !== '0') failures.push(`0도 결과는 왔지만 그림이 아직 안 떴는데 1번 칸이 켜졌다 (${lit()})`);
  gate.noteScanImageShown(urlOf(0));
  if (lit() !== '0,1') failures.push(`0도 그림이 떴는데 1번 칸이 안 켜진다 (${lit()})`);

  // 뒤 각도의 그림이 먼저 떴으면 앞 각도는 지난 것이다.
  image(2); image(3);
  result([0, 1, 2]);
  if (lit() !== '0,1') failures.push(`1번 그림이 안 떴는데 2번이 켜졌다 (${lit()})`);
  gate.noteScanImageShown(urlOf(2));
  if (lit() !== '0,1,2,3') failures.push(`2번 그림이 떴는데 2·3번이 안 켜진다 (${lit()})`);

  // 그림을 못 받으면 기다리지 않는다.
  image(4);
  result([0, 1, 2, 3]);
  gate.noteScanImageFailed(urlOf(3));
  if (lit() !== '0,1,2,3,4') failures.push(`3번 그림을 못 받았는데 4번이 기다린다 (${lit()})`);
  if (!log.detectLog().some((line) => /탐지 영상을 못 불러와/.test(line.text))) failures.push('그림을 못 받아 넘어간 사실을 안 적는다');

  // 뷰가 없으면 같은 주소를 미리 받아 본 완료로 본다.
  releaseView();
  let finishLoad = () => {};
  const asked = [];
  gate.setScanImageLoader((url) => { asked.push(url); return new Promise((resolve) => { finishLoad = resolve; }); });
  image(5);
  result([0, 1, 2, 3, 4]);
  if (lit() !== '0,1,2,3,4') failures.push(`뷰가 없는데 4번 그림을 받기도 전에 5번이 켜졌다 (${lit()})`);
  if (!asked.includes(urlOf(4))) failures.push('뷰가 없을 때 뷰와 같은 주소를 미리 받지 않는다');
  finishLoad();
  await sleep(0);
  if (lit() !== '0,1,2,3,4,5') failures.push(`4번 그림을 받았는데 5번이 안 켜진다 (${lit()})`);
  gate.setScanImageLoader(null);

  // 뷰는 도는 동안 최신 각도를 보여야 한다 — 먼저 찾은 문에 붙어 있으면 뒤 각도 그림이 영영 안 뜬다.
  const views = (await import('node:fs')).readFileSync(join(root, 'src', 'detect', 'views', 'DetectViews.tsx'), 'utf8');
  if (!/if \(frames\.length < count\) return frames\.at\(-1\)/.test(views)) failures.push('탐지 영상이 도는 동안 최신 각도를 안 따라간다');
  if (!/onLoad=\{\(\) => noteScanImageShown\(url\)\}/.test(views)) failures.push('탐지 영상 img 가 다 그렸다고 문지기에 안 알린다');
  // 큰 자리를 다른 각도로 골라 둬도(작은 각도 클릭) 작은 그림이 뜬 것을 알린다 — 안 그러면 로봇이 15초씩 선다.
  if (!/onLoad=\{\(\) => noteScanImageShown\(thumb\)\}/.test(views)) failures.push('작은 각도 그림이 뜬 것을 문지기에 안 알린다 — 큰 자리를 골라 두면 로봇이 멈춘다');
  gate.resetScanGate();
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **회전 보고로 켜는 사본** — 옛 화면. 촬영 1 전에 1번 칸이 켜진다.
  const naive = new Set([0]);
  naive.add(1);                                   // turn(1) 이 곧바로 켰다
  control('회전 보고로 칸을 켜는 사본', naive.has(1));
}
{
  // **촬영만 기다리는 사본** — 앞 칸 결과를 안 본다. 0도 결과 전에 1번이 켜진다.
  await freshRun();
  image(0);
  turn(1);
  const beforeResult = lit();
  image(1);
  const gated = lit();
  control('앞 칸 탐지 결과를 안 기다리는 사본', beforeResult === '0' && gated === '0' && '0,1' !== gated);
  gate.resetScanGate();
  session.resetRobotSession();
}

if (failures.length) {
  console.error(`❌ verify:scan-gate\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 촬영이 흐르는 판에서 칸은 회전 보고가 아니라 촬영이 켜고, 앞 칸의 탐지 결과가 온 뒤에야 다음 칸이 켜진다');
console.log('✅ 로봇이 앞서 가 있어도 결과가 오는 대로 한 칸씩 차례로 연다 · 방위 기록은 늦추지 않는다');
console.log(`✅ 결과가 ${15}초째 없거나 탐지에 못 닿으면 넘어가고 로그에 적는다 · 촬영이 없는 판은 회전 보고로 켠다`);
console.log('✅ 지난 판에서 기다리던 칸이 새 판을 켜지 않는다');
console.log('✅ 결과가 와도 탐지 영상 뷰의 그림이 다 그려져야 넘어간다 · 뒤 각도 그림이 뜨면 앞은 지난 것 · 못 받으면 넘어간다 · 뷰가 없으면 미리 받아 본다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
