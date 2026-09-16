// verify:mission-prep (260912 신설 — 「임무 시작을 누르면 바로 돈다」)
//
// **로봇이 돌기 전에 해야 할 두 가지가 있다.**
//
//   T-A1  2D 맵에서 문 위치 확인
//   T-A2  로봇 현재 위치와 각도 파악
//   T-A3  로봇이 1바퀴 돈다      ← 위의 둘 **뒤**에 오는 일이다
//
// 260912 실측: 「임무 시작」을 누르는 순간 로봇이 돌기 시작했고, 앞의 두 노드에는 **한 바퀴
// 다 돌고 나서** 완료가 떴다. 화면이 임무의 순서를 거꾸로 보여 준 것이다.
//
// 막으려는 실패 넷.
//
//  1. **눌렀는데 곧바로 돈다** — 준비 창이 없으면 `T-A1`·`T-A2` 가 진행 중인 동안 로봇이 돈다
//  2. **준비 중에 각도가 열린다** — 시료의 박자가 시작 시계를 쓰면, 로봇이 서 있는 동안
//     결과가 먼저 뜬다. **안 본 방향의 답이 먼저 나온다**
//  3. **정지했는데 나중에 돈다** — 준비 창이 타이머라, 그 타이머가 정지에 안 걸리면
//     멈춘 뒤에 창이 닫히면서 스캔이 나간다. 가장 위험한 실패다
//  4. **앞의 둘이 대기인데 돈다** (260914 실측 — 3번째로 되살아난 모양). 창이 시계로만
//     닫혀서, 두 노드가 대기인 채로 로봇이 돌았다. 두 노드는 탐지의 자세 역산을 기다렸는데
//     실제 탐지는 그것을 **한 바퀴 뒤에** 계산한다. 이제 둘은 돌기 전에 실제로 끝난다 —
//     도면을 받고(T-A1), 로봇의 지금 방위를 받는다(T-A2). **둘이 끝나야** 돈다
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

const failures = [];
const controls = [];

const session = await load('src', 'physical', 'robotSession.ts');
const { shouldIssueScan } = await load('src', 'physical', 'robotCommands.ts');
const { sampleRevealed } = await load('src', 'detect', 'DetectClient.ts');
const { PREP_SEC, afterPrep } = session;

// ── 1. 준비 창이 닫히기 전에는 스캔이 안 나간다 ─────────────────────────────
{
  if (!(PREP_SEC > 0)) failures.push(`준비 창이 ${PREP_SEC}초다 — 0이면 누르는 즉시 돈다`);

  session.resetRobotSession();
  session.setConnection({ state: 'open' });
  session.markApproved();

  // 승인만으로는 안 돈다 (260912 지시 — 이미 걸려 있는 관문).
  if (shouldIssueScan()) failures.push('승인만으로 스캔이 나간다 — 시작 버튼이 있는 이유가 없어진다');

  session.markStarted();
  if (!session.robotSession().started) failures.push('시작이 안 걸렸다 — 검사가 헛돈다');
  if (session.robotSession().prepared) failures.push('누르자마자 준비가 끝났다고 한다');
  if (shouldIssueScan()) {
    failures.push('시작을 누르자마자 스캔이 나간다 — T-A1·T-A2 가 진행 중인데 로봇이 돈다');
  }

  // **창만 닫혀서는 안 돈다** (260914) — 로봇이 몰면 T-A1·T-A2 가 실제로 끝나야 한다.
  session.finishPrep();
  if (session.robotSession().prepared) failures.push('창만 닫혔는데 준비가 끝났다고 한다 — T-A1·T-A2 가 대기인데 로봇이 돈다');
  if (shouldIssueScan()) failures.push('창만 닫혔는데 스캔이 나간다 — 260914 에 실제로 났던 모양이다');
  session.markPrepTasksDone();
  if (!session.robotSession().prepared) failures.push('창도 닫히고 두 걸음도 끝났는데 준비가 안 끝난다');
  if (!shouldIssueScan()) failures.push('준비가 끝났는데 스캔이 안 나간다 — 로봇이 영영 안 돈다');

  // 로봇이 안 몰면(대본 재생) 두 노드는 대본이 칠한다 — 창만으로 연다.
  session.resetRobotSession();
  session.setConnection({ state: 'closed', reason: '검사' });
  session.markApproved();
  session.markStarted();
  session.finishPrep();
  if (!session.robotSession().prepared) failures.push('로봇이 안 모는데 창이 닫혀도 준비가 안 끝난다 — 대본 재생의 시료 박자가 멎는다');
  session.resetRobotSession();
}

// ── 2. 준비 중에는 각도가 안 열린다 ─────────────────────────────────────────
//
// 시료의 박자가 **시작 시계**를 쓰면 로봇이 서 있는 동안 결과가 뜬다. 준비 창을 뺀
// 시계를 써야 첫 각도가 로봇이 돌기 시작한 뒤에 온다.
{
  if (afterPrep(0) !== 0) failures.push('시작 직후의 스캔 시계가 0이 아니다');
  if (afterPrep(PREP_SEC) !== 0) failures.push('준비가 막 끝난 순간의 스캔 시계가 0이 아니다');
  if (afterPrep(PREP_SEC + 4) !== 4) failures.push(`준비 뒤 4초가 ${afterPrep(PREP_SEC + 4)} 로 온다`);
  // 준비 중에는 한 각도도 안 열린다.
  for (const at of [0, 1, PREP_SEC - 0.1, PREP_SEC]) {
    if (sampleRevealed(afterPrep(at), 8) !== 0) {
      failures.push(`준비 중(${at}초)에 각도가 열린다 — 안 본 방향의 답이 먼저 뜬다`);
    }
  }
  if (sampleRevealed(afterPrep(PREP_SEC + 4), 8) !== 1) failures.push('돌기 시작하고 4초에 첫 각도가 안 온다');

  // 폴링이 실제로 그 시계를 쓰는가 — 함수만 있고 안 쓰면 소용이 없다.
  const poll = src('detect', 'poll.ts');
  if (!/scanElapsedSec\(\)/.test(poll)) failures.push('폴링이 시작 시계로 각도를 연다 — 준비 중에 결과가 뜬다');
  if (/fetchSummary\(source, 'door', elapsedSec\(\)\)/.test(poll)) {
    failures.push('폴링이 아직 elapsedSec 으로 각도를 연다');
  }
}

// ── 3. 정지하면 준비 창도 끊긴다 ────────────────────────────────────────────
//
// **가장 위험한 실패다.** 멈춘 뒤에 창이 닫히면서 스캔이 나가면, 누른 사람은 멈춘 줄 알고
// 로봇에 다가가 있다.
{
  session.resetRobotSession();
  session.setConnection({ state: 'open' });
  session.markApproved();
  session.markStarted();
  session.lockStopped(true, null);          // 정지가 하는 3번 — 타이머 정지
  session.finishPrep();                     // 창이 닫혀도
  if (shouldIssueScan()) failures.push('정지한 뒤에 스캔이 나간다 — 멈춘 줄 알고 다가간 사람이 있다');

  // 일시정지도 같다 — 멈춰 있는데 창이 닫혔다고 돌면 안 된다.
  session.resetRobotSession();
  session.setConnection({ state: 'open' });
  session.markApproved();
  session.markStarted();
  session.lockPaused('T-A3', true, null);
  session.finishPrep();
  const paused = session.robotSession().paused !== null;
  if (!paused) failures.push('일시정지가 안 걸렸다 — 검사가 헛돈다');

  // 「처음부터」는 준비 창도 처음으로 되돌린다.
  session.resetRobotSession();
  session.setConnection({ state: 'open' });
  session.markApproved();
  session.markStarted();
  session.finishPrep();
  session.clearStarted();
  if (session.robotSession().prepared) failures.push('처음으로 되돌렸는데 준비가 끝나 있다 — 다음 판에서 곧바로 돈다');
  if (shouldIssueScan()) failures.push('처음으로 되돌렸는데 스캔이 나간다');

  session.resetRobotSession();              // 타이머를 남기지 않는다
}

// ── 4. 앞의 둘은 돌기 전에 실제로 끝난다 (260914) ───────────────────────────
//
// 도면을 받고(T-A1) 로봇의 지금 방위를 받는다(T-A2). **둘이 끝나야** 돈다. 시계와 가짜
// 서비스로 실제로 흘린다 — 문자열 훑기가 아니다.
{
  const evidence = sample('unidepth_localization', 'localization_evidence.json');
  // 문 자리는 탐지와 **같은 값**이어야 한다 — 도면 위 표시와 탐지 경로가 같은 문을 가리킨다.
  const { doorCm } = await load('src', 'detect', 'floorPlan.ts');
  const door = doorCm();
  const [gx, gy] = evidence.door_position_cm_fixed_from_gt;
  if (Math.abs(door.x - gx) > 0.1 || Math.abs(door.y - gy) > 0.1) {
    failures.push(`문의 도면 위치가 탐지와 다르다 — 화면 (${door.x.toFixed(1)}, ${door.y.toFixed(1)}) · 탐지 (${gx}, ${gy})`);
  }

  // 탐지는 더 이상 두 노드를 칠하지 않는다 — 두 곳에서 칠하면 사건이 두 벌 쌓인다.
  const trace = src('detect', 'detectTrace.ts');
  if (/'T-A1'|'T-A2'/.test(trace)) failures.push('detectTrace 가 아직 T-A1·T-A2 를 칠한다 — 한 바퀴 뒤에야 오는 값으로 끝낸다');

  const prep = await load('src', 'physical', 'prepStage.ts');
  const devices = await load('src', 'physical', 'deviceState.ts');
  const scenario = await load('src', 'data', 'scenario.ts');
  const realFetch = globalThis.fetch;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = async () => new Response('jpeg', { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const robotState = (heading) => devices.receiveDeviceMessage('zoneA/robot/go1-001/state', {
    timestamp: '2026-09-14T14:36:26+0900', position: { x: 0.187, y: -0.207, heading_deg: heading },
  });
  try {
    prep.initPrepStage();
    void scenario;

    // ① 시작 → 두 노드가 진행 중. 도면이 오면 T-A1 끝, 방위가 아직이면 안 돈다.
    devices.resetDevices(); prep.resetPrepStage(); session.resetRobotSession();
    session.setConnection({ state: 'open' });
    session.markApproved();
    session.markStarted();
    if (prep.prepState().map.step !== 'running' || prep.prepState().pose.step !== 'running') {
      failures.push('시작을 눌렀는데 T-A1·T-A2 가 진행 중으로 안 뜬다 — 그 몇 초가 빈 화면이 된다');
    }
    await flush(); await flush();
    if (prep.prepState().map.step !== 'done') failures.push(`도면을 받았는데 T-A1 이 ${prep.prepState().map.step} 다`);
    session.finishPrep();
    if (shouldIssueScan()) failures.push('로봇 방위를 아직 안 받았는데 스캔이 나간다 — T-A2 가 대기인데 돈다');

    // ② 로봇이 지금 방위를 보냈다 → T-A2 끝 → 이제 돈다. 액션 아이템이 읽을 값도 남는다.
    robotState(-29);
    if (prep.prepState().pose.step !== 'done') failures.push('로봇 방위가 왔는데 T-A2 가 안 끝난다');
    if (prep.prepState().pose.value?.headingDeg !== -29) failures.push(`T-A2 가 잡은 방위가 ${prep.prepState().pose.value?.headingDeg} — 로봇이 보낸 -29 여야 한다`);
    if (!shouldIssueScan()) failures.push('두 걸음이 다 끝났는데 스캔이 안 나간다');

    // ③ **낡은 방위로 끝내지 않는다** — 시작 한참 전에 온 값은 「지금」이 아니다.
    devices.resetDevices(); prep.resetPrepStage(); session.resetRobotSession();
    const realNow = Date.now;
    Date.now = () => realNow() - prep.POSE_FRESH_MS - 5000;
    robotState(10);
    Date.now = realNow;
    session.setConnection({ state: 'open' });
    session.markApproved();
    session.markStarted();
    await flush(); await flush();
    session.finishPrep();
    if (prep.prepState().pose.step === 'done') failures.push('시작 전에 받은 낡은 방위로 T-A2 를 끝냈다 — 「현재 각도」가 거짓이 된다');
    if (shouldIssueScan()) failures.push('낡은 방위만 있는데 스캔이 나간다');
  } finally {
    globalThis.fetch = realFetch;
    prep.resetPrepStage(); session.resetRobotSession(); devices.resetDevices();
  }

  const client = src('detect', 'DetectClient.ts');
  if (!/unidepth_localization\/localization_evidence\.json/.test(client)) {
    failures.push('자세 역산을 읽는 자리가 없다');
  }

  /**
   * **승인만으로는 앞의 둘도 안 움직인다** (260912 지시 — 「승인을 누르면 T-A1·T-A2 가
   * 바로 완료로 뜬다」).
   *
   * 자세 역산은 임무 시계와 무관한 파일이라 켜 두면 곧바로 온다. 묻는 시점을 시작에
   * 걸지 않으면, 승인만 하고 가만히 있어도 두 노드가 초록이 된다 — 로봇은 아직 아무것도
   * 안 했는데.
   */
  const uplink = src('detect', 'useDetect.tsx');
  if (!/if \(!started\) return;/.test(uplink)) {
    failures.push('시작 전에도 탐지를 묻는다 — 승인만 했는데 T-A1·T-A2 가 완료로 뜬다');
  }
  if (!/\[started, /.test(uplink)) failures.push('시작이 바뀌어도 폴링이 다시 서지 않는다');
}

// ── 5. 2D 맵은 경로 전후로 다른 그림이다 (260912 지시) ──────────────────────
//
// 도면은 임무 내내 있는 것이다. 경로가 없다고 그 자리를 비워 두면 발표 초반 내내 빈 상자다.
// 바뀌는 시점은 `T-B1` 의 완료와 **같은 값**에 걸려 있어야 한다 — 두 군데서 따로 판단하면
// 노드는 초록인데 그림은 그대로인 날이 온다.
{
  const { mapImageUrl, pathImageUrl, sourceOf } = await load('src', 'detect', 'DetectClient.ts');
  const at = sourceOf(true);
  if (mapImageUrl(at) === pathImageUrl(at)) failures.push('경로 전후의 그림이 같다 — 바뀌는 것이 안 보인다');
  if (!/map_original\.jpg$/.test(mapImageUrl(at))) failures.push(`기본 도면이 ${mapImageUrl(at)} 다`);
  if (!/path_overlay\.jpg$/.test(pathImageUrl(at))) failures.push(`경로 그림이 ${pathImageUrl(at)} 다`);

  // **판이 바뀌면 그림 주소도 바뀐다** (260914). 탐지의 그림 주소는 판마다 같아서, 새로고침 없이
  // 두 번째 판을 돌리면 브라우저가 지난 판의 경로 그림을 다시 쓸 수 있다.
  const { roundedImageUrl } = await load('src', 'detect', 'DetectClient.ts');
  const detectStore = await load('src', 'detect', 'store.ts');
  const liveSource = { kind: 'live', base: 'http://detect:8765' };
  const urlNow = () => roundedImageUrl(pathImageUrl(liveSource), detectStore.detectState().imageRound);
  const first = urlNow();
  detectStore.resetDetect();
  const second = urlNow();
  detectStore.discardRound();
  const third = urlNow();
  if (first === second || second === third) failures.push('새 판(임무 시작 · 탐지 재시작)에도 경로 그림 주소가 같다 — 지난 판 그림이 남는다');
  if (!second.startsWith('http://detect:8765/detect/path_overlay?target=door&round=')) failures.push(`판 번호를 붙인 주소가 ${second} 다`);
  if (!/imageRound/.test(src('detect', 'views', 'DetectViews.tsx'))) failures.push('그림을 그리는 곳이 판 번호를 안 붙인다');

  const views = src('detect', 'views', 'DetectViews.tsx');
  if (!/floorPlanUrls\(source\)/.test(views)) failures.push('경로 전에 도면을 안 그린다 — 그 자리가 빈 상자가 된다');
  if (!/path === null/.test(views)) failures.push('그림을 바꾸는 기준이 경로가 아니다');
  // **도면은 T-A1 이 끝난 뒤에 뜬다** (260914 지시) — 노드 상태를 그대로 읽는다.
  if (!/foldStatuses\(/.test(views) || !/DETECT_TASKS\.map/.test(views)) {
    failures.push('2D 맵이 T-A1 완료를 안 기다린다 — 노드는 대기인데 맵이 먼저 뜬다');
  }
  // 도면을 대신 읽을 자리가 도면 그림 하나뿐인가 — 판의 산출물은 대신하지 않는다.
  const { floorPlanUrls } = await load('src', 'detect', 'DetectClient.ts');
  const live = floorPlanUrls({ kind: 'live', base: 'http://d.test' });
  if (live.length !== 2 || !/\/detect\/map$/.test(live[0]) || !/map_original\.jpg$/.test(live[1])) {
    failures.push(`도면 주소 순서가 [${live.join(', ')}] — 탐지 창구 먼저, 저장소 도면 사본 나중이어야 한다`);
  }

  // 그림이 바뀌는 값과 T-B1 이 끝나는 값이 같은가.
  const trace = src('detect', 'detectTrace.ts');
  if (!/state\.path !== null.*T-B1/s.test(trace)) {
    failures.push('T-B1 이 경로로 끝나지 않는다 — 노드와 그림이 다른 순간에 바뀐다');
  }
}

// ── 6. 이동 버튼이 어느 화면에 있든 보인다 ──────────────────────────────────
//
// 260912 실측: 「산출된 경로에 따라 이동 직전에서 막힘」. 버튼이 `RobotPanel` 안에 있었고,
// 그 패널은 **마일스톤 목록 화면에만** 있다. 마지막 마일스톤이 끝나면 화면이 다음
// 마일스톤의 노드 그래프로 저절로 넘어가는데 거기에는 패널이 없다 — 경로까지 다 나왔는데
// **누를 것이 아무 데도 없었다.**
//
// 정지·일시정지·재시작과 같은 자리에 둔다. 연결이 없어도 감추지 않는다(정지와 같은 규칙).
{
  const panel = src('physical', 'RobotPanel.tsx');
  if (/canApproach\(\)/.test(panel)) {
    failures.push('이동 버튼이 아직 패널 안에 있다 — 노드 그래프로 넘어가면 사라진다');
  }
  const button = src('physical', 'StopButton.tsx');
  if (!/export function ApproachButton/.test(button)) failures.push('머리줄에 이동 버튼이 없다');
  // 연결이 없다고 막으면 안 된다. **보내는 중에만** 막는다 — 두 번 누르면 같은 걸음이
  // 두 번 나간다.
  for (const bad of button.match(/disabled=\{[^}]*\}/g) ?? []) {
    if (bad !== 'disabled={busy}') failures.push(`이동 버튼을 ${bad} 로 막는다 — 연결이 없어도 눌려야 한다`);
  }
  if (!/못 보냈습니다/.test(button)) failures.push('못 보낸 것을 버튼 자리에 안 적는다');
  for (const bar of [src('shell', 'AppShell.tsx'), src('views', 'TopBar.tsx')]) {
    if (!/<ApproachButton \/>/.test(bar)) failures.push('머리줄이 이동 버튼을 안 건다 — 어느 화면에서는 안 보인다');
  }
  // 머리줄의 `.global-bar button` 이 더 구체적이라, 클래스만 쓰면 초록이 안 뜬다.
  const css = readFileSync(join(root, 'src', 'style.css'), 'utf8');
  if (!/button\.robot-approach\{/.test(css)) {
    failures.push('이동 버튼 모양에 button. 이 없다 — 머리줄에서 흰 버튼으로 묻힌다');
  }

  const { issueApproach } = await load('src', 'physical', 'robotCommands.ts');
  session.resetRobotSession();
  session.markApproved();
  const outcome = await issueApproach(null, null);
  if (outcome?.sent !== false) failures.push('연결 없이 냈는데 보냈다고 한다');
  if (!outcome?.reason) failures.push('못 보낸 사유가 없다 — 발표자가 원인을 모른다');
  session.resetRobotSession();
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **준비 창이 없는 사본.** 시작 시계를 그대로 쓰면 4초에 첫 각도가 열린다 —
  // 로봇은 아직 서 있다.
  control('준비 창을 안 뺀 사본 (elapsed 를 그대로)', sampleRevealed(4, 8) === 1 && sampleRevealed(afterPrep(4), 8) === 0);
}
{
  // **준비를 참으로 박아 둔 사본.** 누르는 즉시 관문이 열린다.
  session.resetRobotSession();
  session.setConnection({ state: 'open' });
  session.markApproved();
  session.markStarted();
  const blocked = !shouldIssueScan();
  session.finishPrep();
  session.markPrepTasksDone();
  control('준비를 건너뛴 사본 (prepared 를 안 보는 관문)', blocked && shouldIssueScan());
  session.resetRobotSession();
}
{
  // **창만 보는 사본** (260914 에 실제로 있던 코드). 창이 닫히면 곧바로 참이었다 — 위 1절의
  // 「창만 닫혔는데 스캔이 나간다」 판정이 그것을 잡는지, 그 사본의 결과로 확인한다.
  session.resetRobotSession();
  session.setConnection({ state: 'open' });
  session.markApproved();
  session.markStarted();
  session.finishPrep();
  const oursBlocks = !shouldIssueScan();
  // 옛 코드를 흉내 낸다 — 창이 닫히는 순간 두 걸음을 확인하지 않고 준비를 끝낸다.
  session.markPrepTasksDone();
  const copyRotates = shouldIssueScan();      // 1절의 「창만 닫혔는데 스캔이 나간다」가 걸리는 상태
  control('창만 닫히면 도는 사본 (T-A1·T-A2 대기 중 회전)', oursBlocks && copyRotates);
  session.resetRobotSession();
}

if (failures.length) {
  console.error(`❌ verify:mission-prep\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ 시작을 눌러도 준비 창(${PREP_SEC}초)이 닫히고 T-A1·T-A2 가 실제로 끝나기 전에는 스캔이 안 나간다`);
console.log('✅ 준비 중에는 한 각도도 안 열린다 — 로봇이 서 있는 동안 안 본 방향의 답이 뜨지 않는다');
console.log('✅ 정지·일시정지·처음으로가 준비 창을 같이 끊는다 — 멈춘 뒤에 창이 닫혀도 안 돈다');
console.log('✅ T-A1 은 도면을 받아 끝나고(문 자리가 탐지와 같다), T-A2 는 로봇의 지금 방위로 끝난다 — 낡은 방위로는 안 끝난다');
console.log('✅ 2D 맵은 T-A1 이 끝난 뒤에 뜨고, 경로 전후로 다른 그림이며, 바뀌는 값이 T-B1 의 완료와 같다');
console.log('✅ 이동 버튼이 머리줄에 있어 어느 화면에서도 보이고, 연결이 없어도 눌린다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
