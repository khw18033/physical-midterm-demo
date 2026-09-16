// verify:detect-map (260912 신설 — 탐지 연동 2단계-B)
//
// **탐지가 준 모양을 화면이 읽는 모양으로 바꾸는 자리를 지킨다.**
//
// 막으려는 실패 다섯.
//
//  1. **한 칸 밀림** — `rotation_deg / step_deg` 가 칸 번호다. 한 칸 밀려도 화면은 그럴싸하게
//     돌아간다(여덟이 차례로 켜지고 초록도 하나 뜬다). 눈으로는 못 잡는다.
//  2. **점수를 확률로 그리는 것** — 찾은 프레임의 `final_score` 가 0.2696 이다. 「27%」로
//     적으면 「거의 못 찾았다」로 읽히는데, 실제로는 관문 넷을 다 통과한 판정이다.
//  3. **깊이값을 거리로 그리는 것** — 시료가 `distance_cm: 0.0` · 보정범위 밖으로 왔고,
//     자료가 「이 값 대신 도면상 고정 위치까지의 거리를 쓰라」고 직접 적었다.
//  4. **상자 형식** — 탐지는 `[x1,y1,x2,y2]`, 화면은 `[x,y,w,h]`. 우리가 바꾼다(260912 결정).
//  5. **초록이 둘** — 문이 두 방향에서 잡히는 것은 가정이 아니라 측정값이다. 받은 시료에서
//     270도와 315도가 둘 다 찾혔고 점수 차이가 0.0016 이었다.
//
// 재료는 **받은 시료 그대로**다. 지어낸 값으로 검사하면 위의 성질이 통째로 빠진다.
//
// 대조군 포함.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const sample = (...p) => JSON.parse(readFileSync(join(root, '..', 'door_example', 'test', ...p), 'utf8'));

const { indexOfRotation, boxOf, reasonOf, chosenFrame, usableDistanceCm, SCORE_LABEL } =
  await load('src', 'detect', 'parse.ts');

const failures = [];
const controls = [];

const summary = sample('door', 'target_summary.json');
const found113 = sample('door', 'frame_000113', 'evidence.json');
const found132 = sample('door', 'frame_000132', 'evidence.json');
const STEP = 45;
const COUNT = 8;

// ── 1. 각도 → 칸 번호 ───────────────────────────────────────────────────────
{
  const got = summary.frames.map((f) => indexOfRotation(f.rotation_deg, STEP, COUNT));
  if (got.join(',') !== '0,1,2,3,4,5,6,7') failures.push(`여덟 각도가 [${got.join(',')}] 로 옮았다 — 0~7 이어야 한다`);
  // 범위 밖은 버린다 — 없는 칸을 만들어 그리면 화면이 대본보다 커진다.
  for (const deg of [-45, 360, 405]) {
    if (indexOfRotation(deg, STEP, COUNT) !== null) failures.push(`범위 밖 ${deg}도가 칸을 냈다`);
  }
  // 딱 안 떨어지는 각도는 우리가 정할 일이 아니다.
  if (indexOfRotation(44.7, STEP, COUNT) !== null) failures.push('44.7도를 어느 칸으로 몰아넣었다');
  // step_deg 를 45 로 박지 않았는가 — 스캔 파라미터라 화면에서 바뀐다.
  if (indexOfRotation(90, 30, 12) !== 3) failures.push('step_deg 가 45 로 박혀 있다');
}

// ── 2. 초록은 하나 · 실제로 둘이 찾혔다 ─────────────────────────────────────
{
  const hits = summary.frames.filter((f) => f.found);
  if (hits.length !== 2) failures.push(`시료에서 찾힌 각도가 ${hits.length}개다 — 2개여야 한다 (검사가 헛돈다)`);
  const scoreOf = (f) => (f.frame === found113.frame ? found113.final_score : f.frame === found132.frame ? found132.final_score : 0);
  const best = chosenFrame(summary.frames, scoreOf);
  if (best?.rotation_deg !== 270) failures.push(`고른 각도가 ${best?.rotation_deg} 다 — 270도(점수 더 높음)여야 한다`);
  if (indexOfRotation(best.rotation_deg, STEP, COUNT) !== 6) failures.push('270도가 6번 칸이 아니다');
  // 하나도 못 찾으면 **안 고른다.** 임의로 한 방향을 고르면 안 된다.
  if (chosenFrame(summary.frames.map((f) => ({ ...f, found: false })), scoreOf) !== null) {
    failures.push('하나도 못 찾았는데 한 방향을 골랐다');
  }
  // 동점이면 먼저 본 각도 — 같은 판을 다시 그릴 때 답이 바뀌면 안 된다.
  const tied = chosenFrame(summary.frames.filter((f) => f.found), () => 1);
  if (tied?.rotation_deg !== 270) failures.push('동점에서 고른 것이 먼저 본 각도가 아니다');
}

// ── 3. 상자 형식 ───────────────────────────────────────────────────────────
{
  const box = boxOf(found113.box_xyxy);
  const [x1, y1, x2, y2] = found113.box_xyxy;
  if (box === null) failures.push('상자를 못 읽는다');
  else if (box.join(',') !== [x1, y1, x2 - x1, y2 - y1].join(',')) {
    failures.push(`상자가 [${box.join(',')}] 로 왔다 — [x,y,w,h] 여야 한다`);
  }
  // 뒤집힌 상자도 받는다 — 음수 폭은 그리는 쪽에서 사라져 「못 찾았다」와 구별이 안 된다.
  if (boxOf([160, 143, 140, 89])?.join(',') !== '140,89,20,54') failures.push('뒤집힌 상자를 못 바로잡는다');
  for (const bad of [null, [1, 2, 3], [1, 2, 3, NaN]]) {
    if (boxOf(bad) !== null) failures.push(`망가진 상자 ${JSON.stringify(bad)} 를 받아들였다`);
  }
}

// ── 4. 문장은 관문에서 나온다 · 점수는 확률이 아니다 ────────────────────────
{
  const words = reasonOf(found113, true);
  for (const must of ['통과', SCORE_LABEL]) {
    if (!words.includes(must)) failures.push(`판단 문장에 「${must}」 가 없다 — ${words}`);
  }
  // 관문 넷이 다 통과였으니 넷이 다 문장에 있어야 한다.
  const passed = Object.values(found113.mandatory_gates).filter((g) => g.passed).length;
  if (passed !== 4) failures.push(`시료의 통과 관문이 ${passed}개다 — 4개여야 한다 (검사가 헛돈다)`);
  if (words.split('·').length < passed) failures.push(`문장이 관문 ${passed}개를 다 안 담았다 — ${words}`);
  // **퍼센트로 적지 않는다.** 0.2696 을 27% 로 적으면 「거의 못 찾았다」로 읽힌다.
  if (/%/.test(words)) failures.push(`판단 문장이 퍼센트를 쓴다 — ${words}`);
  if (reasonOf(null, false) !== '문 없음') failures.push('못 찾은 각도의 문장이 「문 없음」이 아니다');
  // **찾았는데 안 고른 칸.** 「통과」라고 적으면 통과했다면서 탈락이라 화면이 모순된다.
  // 「문 없음」도 거짓이다 — 문은 거기 있었고 우리가 다른 쪽을 골랐을 뿐이다.
  const loser = reasonOf(found132, true, false);
  if (/통과/.test(loser)) failures.push(`안 고른 칸이 「통과」라고 적힌다 — ${loser}`);
  if (loser === '문 없음') failures.push('안 고른 칸을 「문 없음」이라고 적는다 — 문은 거기 있었다');
  if (!/안 고름/.test(loser)) failures.push(`안 고른 이유가 없다 — ${loser}`);
}

// ── 5. 깊이값을 거리로 그리지 않는다 ────────────────────────────────────────
{
  const hit = summary.frames.find((f) => f.found);
  if (hit.in_valid_calibration_range !== false) failures.push('시료의 보정범위 밖 표시가 사라졌다 — 검사가 헛돈다');
  if (usableDistanceCm(hit) !== null) failures.push('보정범위 밖 깊이값을 거리로 쓴다 — 0.0m 가 화면에 뜬다');
  // 보정범위 안이고 값이 있으면 쓴다.
  if (usableDistanceCm({ ...hit, in_valid_calibration_range: true, distance_cm: 715.4 }) !== 715.4) {
    failures.push('쓸 수 있는 거리까지 버린다');
  }
}

// ── 5-b. 화면이 점수를 퍼센트로 만들지 않는가 (260912 실측) ─────────────────
//
// `reasonOf` 가 퍼센트를 안 써도 **화면이 따로 만들면 소용이 없다.** 실제로 그랬다 —
// 그래프가 `confidence * 100` 으로 「문 있음 · 27%」를 그리고 있었다. 문장을 만드는 쪽만
// 보는 검사는 이것을 못 잡는다.
{
  const graph = readFileSync(join(root, 'src', 'graph', 'TaskGraph.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/confidence \* 100/.test(graph) || /Math\.round\(cell\.detection\.confidence/.test(graph)) {
    failures.push('화면이 점수를 퍼센트로 만든다 — 0.27 이 「27%」로 보이면 「거의 못 찾았다」로 읽힌다');
  }
  // 대신 탐지가 준 문장을 쓴다.
  if (!/cell\.detection\?\.reason/.test(graph)) {
    failures.push('화면이 판단 문장을 안 쓴다 — 관문에서 조립한 근거가 버려진다');
  }
}

// ── 5-c. 다 보기 전에는 판정하지 않는다 (260912 지시) ───────────────────────
//
// 시료 파일에는 여덟 각도가 다 들어 있다. 그대로 내놓으면 **시작하자마자 정답이 이미
// 정해진 채로** 화면이 뜬다 — 실제 서비스는 한 각도가 끝날 때마다 하나씩 준다.
//
// 그리고 세 각도만 보고 「여기가 제일 높다」고 초록을 켜면, 다섯째에서 더 높은 것이
// 나왔을 때 **초록이 옮겨 다닌다.**
{
  const { sampleRevealed } = await load('src', 'detect', 'DetectClient.ts');
  // 승인 전에는 아무것도 안 봤다.
  if (sampleRevealed(0, 8) !== 0) failures.push('승인 전인데 각도를 봤다고 한다');
  // 한 각도에 4초. 여덟이면 32초쯤 — 로봇이 실제로 도는 시간과 비슷해야 한다.
  if (sampleRevealed(4, 8) !== 1) failures.push(`4초에 ${sampleRevealed(4, 8)}각도 — 1개여야 한다`);
  if (sampleRevealed(31, 8) !== 7) failures.push(`31초에 ${sampleRevealed(31, 8)}각도 — 7개여야 한다`);
  // 넘치지 않는다.
  if (sampleRevealed(9999, 8) !== 8) failures.push('여덟을 넘겨 내놓는다');

  // **시작 전에는 시계가 0이다.** 승인 시각으로 물러나면 승인하고 설명하는 동안 각도가
  // 열려, 눌렀을 때 이미 다 끝난 화면이 된다 — 실제로 그렇게 보였다.
  const session = readFileSync(join(root, 'src', 'physical', 'robotSession.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/startedAtMs \?\? session\.approvedAtMs/.test(session)) {
    failures.push('시작 전 시계가 승인 시각으로 흐른다 — 눌렀을 때 이미 다 열린 화면이 된다');
  }
  if (!/if \(session\.startedAtMs === null\) return 0;/.test(session)) {
    failures.push('시작 전에 시계를 0으로 두지 않는다');
  }

  const bridge = readFileSync(join(root, 'src', 'detect', 'detectBridge.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/if \(!sweepDone\(count\)\) return null;/.test(bridge)) {
    failures.push('다 보기 전에 초록을 켠다 — 더 높은 각도가 나오면 초록이 옮겨 다닌다');
  }
  /**
   * **한 바퀴를 다 돌기 전에는 아무 판정도 안 칠한다** (260913 지시).
   *
   * 전에는 못 찾은 각도를 오는 대로 탈락으로 칠했다. 화면에서는 **여덟이 하나씩
   * 희미해지다가** 마지막에 하나만 초록으로 남는 모양이 됐고, 보는 사람은 답이 각도마다
   * 하나씩 정해지는 줄 읽는다. 실제 순서는 그 반대다.
   *
   * 소스를 훑는 대신 **칸의 상태를 실제로 굴려 본다** — 문자열 검사는 같은 뜻의 다른
   * 코드를 못 잡는다.
   */
  const detect = await load('src', 'detect', 'detectBridge.ts');
  const store = await load('src', 'detect', 'store.ts');
  const vp = await load('src', 'viewpoint', 'store.ts');
  const fill = await load('src', 'viewpoint', 'fill.ts');
  const MISSION = 'MSN-260909-01';
  const phasesAfter = (howMany) => {
    store.resetDetect();
    vp.resetViewpoint(MISSION);
    store.receiveFrames(summary.frames.slice(0, howMany));
    for (const [name, ev] of [[found113.frame, found113], [found132.frame, found132]]) {
      if (summary.frames.slice(0, howMany).some((f) => f.frame === name)) store.receiveEvidence(name, ev);
    }
    detect.applyDetection(MISSION, 1, STEP, COUNT);
    const cells = fill.cellsInOrder(fill.reduceFrames(fill.emptyFill(COUNT), vp.framesUpTo(Infinity)), COUNT);
    return cells.map((cell) => cell.phase);
  };

  // 세 각도만 봤을 때 — 셋은 탐색 중, 나머지는 대기. **판정은 하나도 없다.**
  const three = phasesAfter(3);
  if (three.slice(0, 3).some((phase) => phase !== 'scanning')) {
    failures.push(`세 각도를 봤는데 [${three.slice(0, 3)}] — 셋 다 탐색 중이어야 한다`);
  }
  if (three.some((phase) => phase === 'selected' || phase === 'rejected')) {
    failures.push(`도는 중에 판정이 났다 — [${three}]`);
  }

  // 일곱째(270도 · 찾음)까지 봐도 아직 초록이 없다.
  const seven = phasesAfter(7);
  if (seven.includes('selected')) failures.push(`일곱 각도에서 벌써 초록이 떴다 — [${seven}]`);
  if (seven.includes('rejected')) failures.push(`일곱 각도에서 벌써 탈락이 떴다 — [${seven}]`);

  // 여덟째가 들어온 순간 한 번에 갈린다 — 초록 하나(270도 = 6번)와 흐림 일곱.
  const eight = phasesAfter(8);
  if (eight.filter((phase) => phase === 'selected').length !== 1) {
    failures.push(`다 보고 나서 초록이 ${eight.filter((p) => p === 'selected').length}개 — 하나여야 한다`);
  }
  if (eight[6] !== 'selected') failures.push(`초록이 ${eight.indexOf('selected')}번 칸 — 270도(6번)여야 한다`);
  if (eight.filter((phase) => phase === 'rejected').length !== 7) {
    failures.push(`흐림이 ${eight.filter((p) => p === 'rejected').length}개 — 일곱이어야 한다`);
  }
  store.resetDetect();
  vp.resetViewpoint(MISSION);
  // 근거도 판정 뒤다.
  const views = readFileSync(join(root, 'src', 'detect', 'views', 'DetectViews.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/sweepDone\(count\)/.test(views)) failures.push('근거가 판정보다 먼저 뜬다');
}

// ── 5-d. 탐지가 태스크 노드를 민다 (260912 지시) ────────────────────────────
//
// 여덟 칸이 다 차고 초록까지 떠도 **태스크 노드는 그대로 대기**였다. 그러면 마일스톤이
// 안 끝나고 다음 마일스톤으로도 안 넘어간다 — 임무가 거기서 멎는다.
//
// **없는 것을 끝났다고 하지는 않는다.** 이동·정지·종료는 로봇이 움직여야 끝나는 것이고
// 탐지는 그것을 모른다.
{
  const trace = readFileSync(join(root, 'src', 'detect', 'detectTrace.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const node of ['T-A3', 'T-A5', 'T-A6', 'T-B1']) {
    if (!trace.includes(node)) failures.push(`탐지가 ${node} 를 안 민다 — 그 노드가 대기로 남아 마일스톤이 안 끝난다`);
  }
  // **앞의 둘은 탐지가 안 민다** (260914) — 탐지는 자세를 한 바퀴 뒤에 계산한다. 돌기 전에
  // 끝나야 하는 두 걸음은 `physical/prepStage.ts` 가 민다(`verify:mission-prep` 4절).
  for (const node of ['T-A1', 'T-A2']) {
    if (trace.includes(`'${node}'`)) failures.push(`탐지가 아직 ${node} 를 민다 — 한 바퀴 뒤에야 오는 값으로 끝내고, prepStage 와 두 벌이 된다`);
  }
  // 로봇이 해야 끝나는 것을 탐지가 끝냈다고 하면 안 된다.
  for (const node of ['T-B2', 'T-B3', 'T-C1']) {
    if (trace.includes(`'${node}'`)) {
      failures.push(`탐지가 ${node} 를 끝냈다고 한다 — 로봇이 움직여야 끝나는 것이다`);
    }
  }
  // 못 고르면 판단이 안 끝난다 — 「문을 찾지 못함」은 완료가 아니다.
  if (!/chosen !== null/.test(trace)) failures.push('못 골랐는데도 판단을 끝냈다고 한다');

  // 이동 버튼이 탐지 경로로도 열려야 한다 — 로봇의 door_turn 만 보면 영영 안 뜬다.
  const cmd = readFileSync(join(root, 'src', 'physical', 'robotCommands.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/detectState\(\)\.path !== null/.test(cmd)) {
    failures.push('이동 버튼이 탐지 경로를 안 본다 — 경로가 나왔는데 버튼이 안 뜬다');
  }
  // 회전 먼저, 직진 나중 — 돌기 전에 가면 엉뚱한 데로 간다.
  const { pathCommands } = await load('src', 'physical', 'missionLink.ts');
  const left = pathCommands('왼쪽(반시계)으로 90.0도 회전', 90, 6.354);
  if (left.map((c) => c.action).join(',') !== 'turn,move_forward') {
    failures.push(`경로 명령이 [${left.map((c) => c.action).join(',')}] — turn 이 먼저여야 한다`);
  }
  if (left[0]?.parameters?.deg !== -90) failures.push(`왼쪽 회전이 ${left[0]?.parameters?.deg} — 오른쪽이 + 라 -90 이어야 한다`);
  const right = pathCommands('오른쪽(시계)으로 30도 회전', 30, 1);
  if (right[0]?.parameters?.deg !== 30) failures.push('오른쪽 회전의 부호가 틀렸다');
  // 규약 범위 밖은 안 낸다 — 5도 미만·0.05m 미만은 거절당한다.
  if (pathCommands('오른쪽으로 2도', 2, 0.01).length !== 0) failures.push('규약이 안 받는 값을 낸다');
}

// ── 5-e. 지난 판 결과를 이번 판으로 받지 않는다 (260914 실측) ────────────────
//
// 데스크톱 탐지 창구에 지난 판 산출물이 남아 있었고, 「임무 시작」 첫 물음에 여덟 각도와
// 경로가 한꺼번에 와서 로봇이 돌지도 않았는데 「접근 시작」까지 열렸다. 탐지 서비스는 새
// 스캔이 시작될 때 지난 판을 지우므로, **지워지는 것을 본 뒤에 쌓이는 것만** 받아야 한다.
//
// 가짜 탐지 서비스(fetch 스텁)로 그 순서를 실제로 흘린다 — 문자열 훑기가 아니다.
{
  const { registerConnectionDefault } = await load('src', 'shared', 'connections.ts');
  await load('src', 'detect', 'DetectClient.ts');
  registerConnectionDefault('detect', 'base', 'http://detect.test');
  const { pollOnce, resetDetectGate } = await load('src', 'detect', 'poll.ts');
  const { detectState, resetDetect, setTestMode } = await load('src', 'detect', 'store.ts');
  setTestMode(false);

  // 탐지 서비스가 지금 내주는 것. 테스트가 바꿔 가며 흘린다.
  const served = { frames: [], path: null, localization: null };
  const all = summary.frames;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/detect/results')) return json({ target_class: 'door', frames: served.frames });
    if (u.includes('/detect/localization')) return served.localization ? json(served.localization) : json({ error: 'not_available' }, 404);
    if (u.includes('/detect/path')) return served.path ? json(served.path) : json({ error: 'not_available' }, 404);
    if (u.includes('/detect/evidence')) return json(u.includes('frame_000132') ? found132 : found113);
    if (u.includes('/detect/features')) return json({ door: { features_compared: [] } });
    return json({ error: 'not_found' }, 404);
  };
  const stalePath = sample('door', 'evidence.json');
  const staleLoc = sample('unidepth_localization', 'localization_evidence.json');

  try {
    // ① 시작을 눌렀는데 지난 판이 다 남아 있다 — 아무것도 안 받는다.
    resetDetect(); resetDetectGate();
    Object.assign(served, { frames: all, path: stalePath, localization: staleLoc });
    await pollOnce(COUNT);
    await pollOnce(COUNT);
    const s1 = detectState();
    if (s1.frames.length !== 0) failures.push(`지난 판 ${all.length}각도가 남은 채 시작했는데 ${s1.frames.length}각도를 받았다 — 돌지도 않았는데 판정이 난다`);
    if (s1.path !== null) failures.push('지난 판의 경로를 받았다 — 「접근 시작」이 지난 판 경로로 로봇을 움직인다');
    if (s1.localization !== null) failures.push('지난 판의 자세를 받았다 — T-A1·T-A2 가 시작하자마자 끝난다');
    if (s1.staleFrames !== all.length) failures.push(`거르고 있다는 사실을 안 적었다 (staleFrames=${s1.staleFrames})`);

    // ② 새 스캔이 시작돼 지워졌다 → 한 각도씩 쌓인다 — 이제 받는다.
    Object.assign(served, { frames: [], path: null, localization: null });
    await pollOnce(COUNT);
    if (detectState().staleFrames !== null) failures.push('지난 판이 지워졌는데 계속 거른다 — 이번 판을 영영 못 받는다');
    served.frames = all.slice(0, 2);
    await pollOnce(COUNT);
    if (detectState().frames.length !== 2) failures.push(`지워진 뒤 쌓인 2각도를 ${detectState().frames.length}각도로 받았다`);
    // **각도 결과가 그 각도 칸의 액션 아이템에 붙는다** (260914) — 0°·45° 둘이 T-A4-0·T-A4-1 에.
    const { detectLogOf } = await load('src', 'detect', 'detectLog.ts');
    for (const [index, frame] of all.slice(0, 2).entries()) {
      const hit = detectLogOf(`T-A4-${indexOfRotation(frame.rotation_deg, STEP, COUNT)}`);
      if (!hit.some((line) => line.lane === 'detect' && line.text.includes(`${frame.rotation_deg}°`))) {
        failures.push(`${index + 1}번째 각도(${frame.rotation_deg}°) 결과가 그 칸의 액션 아이템 로그에 없다`);
      }
    }
    if (!detectLogOf('T-A3').some((line) => line.lane === 'screen' && /지난 판/.test(line.text))) {
      failures.push('지난 판을 거른 사실이 액션 아이템 로그에 없다 — 탐지는 답하는데 화면만 비어 「연결이 안 된다」로 읽힌다');
    }

    // ③ 처음부터 비어 있으면 거를 것이 없다.
    resetDetect(); resetDetectGate();
    Object.assign(served, { frames: [], path: null, localization: null });
    await pollOnce(COUNT);
    served.frames = all.slice(0, 1);
    await pollOnce(COUNT);
    if (detectState().frames.length !== 1 || detectState().staleFrames !== null) failures.push('비어 있던 서비스에서 첫 각도를 못 받았다');

    // ④ 이번 판 도중에 줄었다 — 판이 다시 시작됐다. 버린 판의 근거가 새 판 각도에 붙으면 안 된다.
    served.frames = all.filter((f) => f.found);          // 270·315 — 근거를 받는다
    await pollOnce(COUNT);
    const hadEvidence = Object.keys(detectState().evidence).length;
    served.frames = [];
    await pollOnce(COUNT);
    if (hadEvidence === 0) failures.push('검사 준비 실패 — 찾은 각도의 근거를 받지 못했다');
    if (Object.keys(detectState().evidence).length !== 0) failures.push('판이 다시 시작됐는데 버린 판의 근거가 남았다');

    // 대조군 — **문이 없던 사본**(받은 목록을 그대로 넣는다)을 실제로 만들고 ①의 판정이
    // 그것을 잡는지 본다. 잡지 못하면 위 검사는 헛돈다.
    const { receiveFrames } = await load('src', 'detect', 'store.ts');
    resetDetect();
    receiveFrames(all);
    control('지난 판을 그대로 받는 사본 (시작하자마자 여덟 각도)', detectState().frames.length !== 0);
  } finally {
    globalThis.fetch = realFetch;
    resetDetect(); resetDetectGate();
  }
}

// ── 5-f. 로봇 → 탐지 흐름을 화면도 듣는다 (260914) ──────────────────────────
//
// 탐지 그림이 한 장도 안 왔는데 **로봇이 안 보냈는지 탐지가 못 받았는지** 가를 수 없었다.
// 규약(`detection-protocol_0914.md` §2·§3)의 실제 모양으로 뜯고, 줄이 그 각도 칸에 붙는지 본다.
{
  const { parseScanFeed } = await load('src', 'physical', 'scanFeed.ts');
  const { noteScanFeed } = await load('src', 'detect', 'feedLog.ts');
  const { detectLogOf, resetDetectLog } = await load('src', 'detect', 'detectLog.ts');
  resetDetectLog();

  const frame = parseScanFeed('zoneA/robot/go1-001/frame', {
    schema_version: '1.3', device_id: 'go1-001', channel: 'frame', timestamp: '2026-09-14T11:45:53+0900',
    seq: 6, rotation_deg: 270.0, image: 'A'.repeat(32000), mission_id: 'scan-1789353953',
    width: 464, height: 400, bytes: 24558, sha1: '0ece0f94dc1947ee',
  });
  if (frame?.kind !== 'frame' || frame.rotationDeg !== 270 || frame.seq !== 6) failures.push(`프레임을 못 뜯었다 — ${JSON.stringify(frame)}`);
  if (frame !== null && 'image' in frame) failures.push('그림(base64)을 들고 다닌다 — 한 장 34KB 가 화면 메모리에 쌓인다');
  if (parseScanFeed('zoneA/robot/go1-001/frame', { seq: 1 }) !== null) failures.push('각도 없는 프레임을 받았다 — 탐지가 쓰는 짝이 아니다');
  if (parseScanFeed('zoneA/robot/go1-001/state', { position: {} }) !== null) failures.push('장비 상태를 스캔 흐름으로 뜯었다');
  const start = parseScanFeed('zoneA/robot/go1-001/scan', { channel: 'scan', event: 'scan_start', mission_id: 'scan-1', plan: { steps: 8, step_deg: 45, expected_frames: 8 } });
  if (start?.kind !== 'scan' || start.expectedFrames !== 8) failures.push('scan_start 의 예상 장수를 못 읽었다');
  const end = parseScanFeed('zoneA/robot/go1-001/scan', { channel: 'scan', event: 'scan_end', outcome: 'ABORTED', frames_sent: 5, expected_frames: 8 });

  noteScanFeed(start, STEP, COUNT);
  noteScanFeed(frame, STEP, COUNT);
  noteScanFeed({ ...frame, seq: 7, rotationDeg: 315, duplicateOfPrev: true }, STEP, COUNT);
  noteScanFeed(end, STEP, COUNT);

  if (!detectLogOf('T-A4-6').some((line) => line.lane === 'robot' && /270° 프레임/.test(line.text))) {
    failures.push('로봇이 270° 프레임을 보낸 사실이 270° 칸(T-A4-6) 액션 아이템에 없다');
  }
  const dup = detectLogOf('T-A4-7').find((line) => line.lane === 'robot');
  if (dup?.level !== 'warn' || !/같은 그림/.test(dup.text)) failures.push('카메라가 얼어 같은 그림이 온 것을 경고로 안 적는다 — 탐지가 그 판을 버린다');
  const sweep = detectLogOf('T-A3');
  if (!sweep.some((line) => /시작했습니다/.test(line.text))) failures.push('scan_start 가 한 바퀴(T-A3) 로그에 없다');
  if (!sweep.some((line) => line.level === 'warn' && /ABORTED/.test(line.text))) failures.push('중단된 판(ABORTED · 5/8장)을 경고로 안 적는다');

  // 화면이 실제로 그 토픽을 구독하는가 — 뜯는 함수만 있고 안 들으면 소용이 없다.
  const client = readFileSync(join(root, 'src', 'physical', 'PhysicalClient.ts'), 'utf8');
  if (!/zoneA\/\+\/\+\/frame/.test(client) || !/zoneA\/\+\/\+\/scan/.test(client)) failures.push('PhysicalClient 가 /frame · /scan 을 구독하지 않는다');
  const robotClientSrc = readFileSync(join(root, 'src', 'physical', 'robotClient.ts'), 'utf8');
  if (!/onScanFeed\(/.test(robotClientSrc) || !/noteScanFeed\(/.test(robotClientSrc)) failures.push('로봇 클라이언트가 스캔 흐름을 로그로 안 잇는다');
  // 액션 아이템이 그 로그를 실제로 그리는가.
  const modal = readFileSync(join(root, 'src', 'views', 'ActionModal.tsx'), 'utf8');
  if (!/<DetectLogLines /.test(modal)) failures.push('액션 아이템이 탐지 로그를 안 그린다');
  if (!/<PrepFacts /.test(modal)) failures.push('액션 아이템이 T-A1·T-A2 가 받아 온 값(도면·로봇 방위)을 안 그린다');
  resetDetectLog();
}

// ── 6. 경계 — 탐지를 아는 면이 src/detect/ 하나인가 ─────────────────────────
{
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const file of walk(join(root, 'src'))) {
    if (file.includes(join('src', 'detect'))) continue;
    const source = strip(readFileSync(file, 'utf8'));
    if (/\/detect-sample/.test(source)) failures.push(`${file} 에 탐지 시료 경로가 있다 — 경계 밖이다`);
    if (/\/detect\/(results|frame|path|evidence|features|localization|map)/.test(source)) {
      failures.push(`${file} 에 탐지 엔드포인트가 있다 — 경계 밖이다`);
    }
  }
  // 경계 안에는 실제로 있어야 한다 — 검사가 헛돌지 않게.
  const client = readFileSync(join(root, 'src', 'detect', 'DetectClient.ts'), 'utf8');
  if (!/\/detect-sample/.test(client)) failures.push('DetectClient 에 시료 경로가 없다 — 검사가 헛돈다');
  if (!/\/detect\/results/.test(client)) failures.push('DetectClient 에 엔드포인트가 없다 — 검사가 헛돈다');
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **한 칸 민 사본.** `rotation_deg / step_deg + 1` 로 두면 270도가 7번을 노린다.
  const shifted = (deg) => Math.round(deg / STEP) + 1;
  control('한 칸 민 사본 (rotation/step + 1)', shifted(270) !== indexOfRotation(270, STEP, COUNT));
}
{
  // **점수를 퍼센트로 적은 사본.**
  const asPercent = `${Math.round(found113.final_score * 100)}%`;
  control('점수를 퍼센트로 적은 사본 (27%)', asPercent === '27%' && !reasonOf(found113, true).includes('%'));
}
{
  // **상자를 그대로 쓴 사본.** `[x1,y1,x2,y2]` 를 `[x,y,w,h]` 로 읽으면 폭이 160이 된다.
  const raw = found113.box_xyxy;
  control('상자를 안 바꾼 사본 (x2 를 폭으로)', raw[2] !== boxOf(raw)[2]);
}

if (failures.length) {
  console.error(`❌ verify:detect-map\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 여덟 각도가 0~7 로 옮는다 — 범위 밖·안 떨어지는 각도는 버리고 step_deg 를 안 박았다');
console.log('✅ 시료도 한 각도씩 — 4초에 하나, 여덟을 다 본 뒤에 판정·근거·경로가 나온다');
console.log('✅ 도는 동안은 「탐색 중」뿐 — 여덟째가 들어온 순간 초록 하나와 흐림 일곱으로 한 번에 갈린다');
console.log('✅ 초록은 하나 — 시료에서 실제로 둘이 찾혔고(270·315) 점수 높은 쪽을 고른다, 없으면 안 고른다');
console.log('✅ 상자를 [x,y,w,h] 로 바꾼다 · 판단 문장은 관문 넷에서 나오고 화면도 퍼센트를 안 만든다');
console.log('✅ 보정범위 밖 깊이값을 거리로 안 그린다 (시료는 0.0cm · 범위 밖)');
console.log('✅ 탐지가 태스크 노드를 민다 — 이동·정지·종료는 안 민다(로봇이 해야 끝난다) · 회전 먼저 직진 나중');
console.log('✅ 지난 판 결과를 이번 판으로 안 받는다 — 시작 때 남아 있으면 거르고, 지워진 뒤 쌓이는 것만 받는다');
console.log('✅ 로봇 → 탐지(/frame · /scan)를 화면도 듣고, 각도 결과와 함께 그 칸의 액션 아이템 로그에 붙는다 — 얼어붙은 그림·중단된 판은 경고');
console.log('✅ 탐지를 아는 면이 src/detect/ 하나 — 시료 경로·엔드포인트가 경계 밖에 0건');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
