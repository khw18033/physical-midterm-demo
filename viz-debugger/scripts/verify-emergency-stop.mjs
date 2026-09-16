// verify:emergency-stop (260910 신설 — 화면 연결 지시서 §7)
//
// **정지를 눌렀는데 화면이 계속 진행하는 것**이 이 기능의 가장 흔한 실패 모양이다.
// 눈으로 보면 "어? 멈췄는데 왜 돌지"로 나타나고, 그때 누른 사람은 로봇이 멈춘 줄 알고
// 다가간다. 그래서 이 검사의 첫 줄이 그것부터 본다.
//
// 보는 것 다섯.
//  1. **정지 뒤 늦게 온 CommandStatus 가 노드를 안 바꾸는가** ← 핵심
//  2. 타이머·폴링이 멈추는가
//  3. 화면이 잠기는가 · 「정지됨」에서 나오는 길이 있는가
//  4. **연결이 없을 때 버튼이 눌리고 실패를 크게 말하는가** — 조용히 성공한 척하지 않는가
//  5. **발행 실패와 화면 잠금이 갈려 있는가** — 1번이 실패해도 2·3·4 는 일어나는가
//
// 5번이 이 기능의 뼈대다. 발행 성공 여부와 화면 잠금을 한 덩어리로 묶으면, 브로커가 죽은
// 날 화면이 계속 돌아간다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const { emergencyStop, stopFailureMessage, issueScan, pauseMission, resumeMission } = await load('src', 'physical', 'robotCommands.ts');
const {
  resetRobotSession, markApproved, robotSession, registerTimer, releaseStopped,
  applyEffects, canIssueRobotCommand, setConnection, recordCommand,
} = await load('src', 'physical', 'robotSession.ts');

const online = () => setConnection({ state: 'open' });
/**
 * 목이 쓰는 command_id 를 **우리가 낸 명령으로 등록**한다. `effectsOf` 가 남의 명령의
 * 진행 보고를 걸러 내므로(260910), 등록하지 않으면 목 프레임이 통째로 무시된다.
 */
const ownCommand = (commandId = 'cmd-00000001') => recordCommand({
  taskId: 'T-A3', commandId, requestId: null, state: 'issued', code: null, message: null, result: {},
  issuedAtIso: new Date().toISOString(), parameters: {}, log: [],
});
const { receiveUplink } = await load('src', 'physical', 'robotBridge.ts');
const { decodeUplink, parseDetail } = await load('src', 'physical', 'uplink.ts');
const { mockScanUplink } = await load('src', 'physical', 'mockUplink.ts');
const { emptyFill, reduceFrames, cellsInOrder } = await load('src', 'viewpoint', 'fill.ts');
const { resetViewpoint, framesUpTo } = await load('src', 'viewpoint', 'store.ts');
const { commandTracker } = await load('src', 'shared', 'commandCenter.ts');

const failures = [];
const controls = [];

function client({ connected = true } = {}) {
  const sent = [];
  return {
    sent,
    getStatus: () => ({ state: connected ? 'open' : 'closed', reason: '브로커 연결 없음' }),
    send(action, parameters) {
      sent.push({ action, parameters });
      if (!connected) return { sent: false, commandId: '', reason: '브로커에 붙어 있지 않습니다 — closed' };
      return { sent: true, commandId: 'cmd-' + String(sent.length).padStart(8, '0') };
    },
  };
}

const MISSION = 'MSN-260909-01';
const filled = () => cellsInOrder(reduceFrames(emptyFill(8), framesUpTo(999))).filter((c) => c.phase !== 'pending').length;

// ── 1. 정지 뒤 늦게 온 CommandStatus 가 노드를 안 바꾼다 (핵심) ──────────────
{
  resetRobotSession();
  resetViewpoint(MISSION);
  online();
  markApproved();
  ownCommand();

  // 옛 pi7 처럼 door_turn 까지 흘린다 — 정지 뒤에 그것이 선을 여는지도 봐야 한다.
  const frames = mockScanUplink({ legacyDoorTurn: true });
  // 앞의 넷을 흘린다 — 회전이 도는 중이다.
  for (const frame of frames.slice(0, 4)) {
    receiveUplink(decodeUplink(frame.payload), MISSION, frame.atSec, 90);
  }
  const beforeStop = filled();
  if (beforeStop === 0) failures.push('정지 전에 노드가 하나도 안 찼다 — 검사가 헛돈다');

  await emergencyStop(client());

  // **남은 다섯을 흘린다. 노드가 더 차면 안 된다.**
  for (const frame of frames.slice(4)) {
    receiveUplink(decodeUplink(frame.payload), MISSION, frame.atSec, 90);
  }
  const afterStop = filled();
  if (afterStop !== beforeStop) {
    failures.push(`정지 뒤에 노드가 ${beforeStop} → ${afterStop} 로 더 찼다 — 「멈췄는데 왜 돌지」가 이것이다`);
  }

  // 진행률·door_turn 도 더 안 움직인다.
  const progressAfter = robotSession().progress;
  for (const frame of frames.slice(4)) receiveUplink(decodeUplink(frame.payload), MISSION, frame.atSec, 90);
  if (JSON.stringify(robotSession().progress) !== JSON.stringify(progressAfter)) {
    failures.push('정지 뒤에 진행률이 더 움직였다');
  }
  if (robotSession().doorTurn !== null) failures.push('정지 뒤에 door_turn 이 들어와 MS-B 선이 열렸다');
}

// ── 2. 타이머·폴링이 멈춘다 ─────────────────────────────────────────────────
{
  resetRobotSession();
  online();
  markApproved();
  let cancelled = 0;
  registerTimer(() => { cancelled += 1; });
  registerTimer(() => { cancelled += 1; });

  await emergencyStop(client());
  if (cancelled !== 2) failures.push(`정지가 타이머를 ${cancelled}개만 끊었다 — 둘 다 끊어야 한다`);
}

// ── 3. 화면이 잠기고, 나오는 길이 있다 ──────────────────────────────────────
{
  resetRobotSession();
  online();
  markApproved();
  await emergencyStop(client());

  const stopped = robotSession().stopped;
  if (stopped === null) failures.push('정지를 눌렀는데 화면이 안 잠겼다');
  if (!String(stopped?.atIso ?? '').trim()) failures.push('정지 시각이 안 남았다');
  if (canIssueRobotCommand()) failures.push('잠긴 화면에서 명령을 내도 된다고 한다');

  // **자동으로 돌아가지 않는다** — 사람이 다시 승인해야 한다.
  releaseStopped();
  if (robotSession().stopped !== null) failures.push('정지 해제가 안 된다 — 갇힌다');
  if (robotSession().approved) failures.push('정지를 풀었더니 승인이 그대로다 — 사람이 다시 승인해야 한다');
}

// ── 4. 연결이 없을 때 — 눌리고, 실패를 크게 말한다 ──────────────────────────
{
  resetRobotSession();
  online();
  markApproved();
  const offline = client({ connected: false });

  const stopped = await emergencyStop(offline);

  // 눌리기는 했는가 — 보내려는 시도가 있어야 한다.
  if (offline.sent.length !== 1) failures.push('연결이 없을 때 정지가 아예 시도되지 않았다');
  // **조용히 성공한 척하지 않는다.**
  if (stopped.published !== false) failures.push('못 보냈는데 보냈다고 한다 — 최악의 경우다');
  const message = stopFailureMessage(stopped);
  if (message === null) failures.push('정지 실패인데 화면에 띄울 문구가 없다');
  if (!/보내지 못했습니다/.test(String(message))) failures.push(`실패 문구가 «${message}» — 「보내지 못했습니다」가 들어가야 한다`);
  // **그래도 잠긴다.**
  if (robotSession().stopped === null) failures.push('발행이 실패했다고 화면이 안 잠겼다 — 이게 이 기능의 뼈대다');
}

// ── 5. 클라이언트가 아예 없어도 잠긴다 ──────────────────────────────────────
{
  resetRobotSession();
  online();
  markApproved();
  const stopped = await emergencyStop(null);
  if (robotSession().stopped === null) failures.push('클라이언트가 null 인데 화면이 안 잠겼다');
  if (stopped.published !== false) failures.push('클라이언트가 없는데 보냈다고 한다');
  if (stopped.failure === null) failures.push('클라이언트가 없는데 사유가 비었다');
}

// ── 6. 발행이 던져도 잠긴다 ─────────────────────────────────────────────────
{
  resetRobotSession();
  online();
  markApproved();
  const throwing = {
    getStatus: () => ({ state: 'open' }),
    send() { throw new Error('소켓이 죽었다'); },
  };
  const stopped = await emergencyStop(throwing);
  if (robotSession().stopped === null) failures.push('발행이 예외를 던졌더니 화면이 안 잠겼다');
  if (stopped.published !== false) failures.push('예외가 났는데 보냈다고 한다');
  if (!/소켓이 죽었다/.test(String(stopped.failure))) failures.push('예외 사유가 안 남았다');
}

// ── 7. 규약 밖으로 나가지 않는다 ────────────────────────────────────────────
{
  resetRobotSession();
  online();
  markApproved();
  const c = client();
  await emergencyStop(c);

  const stop = c.sent[0];
  const { STOP_ACTION, STOP_REASON } = await load('src', 'physical', 'presets.ts');
  if (stop?.action !== STOP_ACTION) failures.push(`정지가 ${stop?.action} 을 쐈다 — ${STOP_ACTION} 이어야 한다`);
  // **reason 하나뿐이다** — 규약 밖의 파라미터를 더하지 않는다.
  const keys = Object.keys(stop?.parameters ?? {});
  if (JSON.stringify(keys) !== JSON.stringify(['reason'])) {
    failures.push(`정지 파라미터가 [${keys.join(', ')}] — reason 하나뿐이어야 한다`);
  }
  if (stop?.parameters?.reason !== STOP_REASON.human) failures.push('사람이 눌렀다는 사유(1)가 아니다');

  // **abort 는 자기 command_id 를 새로 만든다** — 돌던 임무의 id 를 재사용하면 응답이 섞인다.
  resetRobotSession();
  online();
  markApproved();
  const c2 = client();
  await issueScan(c2, { viewpoint_count: 8, forward_distance_m: 4.2 });
  const scanId = Object.keys(robotSession().commands)[0];
  await emergencyStop(c2);
  if (c2.sent.length !== 2) failures.push('스캔과 정지가 둘 다 안 나갔다');
  // 클라이언트가 부를 때마다 새 id 를 만든다 — 같은 id 가 두 번 나오면 안 된다.
  if (scanId !== undefined && c2.sent[1]?.commandId === scanId) failures.push('abort 가 돌던 임무의 id 를 재사용했다');
}

// ── 8. 기존 버튼을 살렸는가 — 새 버튼을 만들지 않았는가 ─────────────────────
{
  const shell = readFileSync(join(root, 'src', 'shell', 'AppShell.tsx'), 'utf8');
  const topbar = readFileSync(join(root, 'src', 'views', 'TopBar.tsx'), 'utf8');
  for (const [name, source] of [['AppShell', shell], ['TopBar', topbar]]) {
    if (!/<StopButton \/>/.test(source)) failures.push(`${name} 이 정지 버튼을 안 그린다 — 어느 화면에 있든 보여야 한다`);
    if (/mission_abort/.test(source)) failures.push(`${name} 에 옛 mission_abort 가 남아 있다 — 기존 버튼을 살리기로 했다`);
  }
  const whole = readFileSync(join(root, 'src', 'physical', 'StopButton.tsx'), 'utf8');
  // 같은 파일에 이동 버튼(`ApproachButton`)이 함께 산다. 그쪽은 **보내는 중에만** 막는데
  // (두 번 누르면 같은 걸음이 두 번 나간다), 그것까지 걸리면 검사가 엉뚱한 것을 잡는다.
  // 여기서 보는 것은 임무 조작 셋뿐이다.
  const button = whole.split('export function ApproachButton')[0];
  // **비활성화하지 않는다.**
  if (/disabled/.test(button)) failures.push('정지 버튼에 disabled 가 있다 — 연결이 없어도 눌려야 한다');
  // **확인 대화상자를 띄우지 않는다.**
  if (/confirm\(/.test(button)) failures.push('정지 버튼이 확인 대화상자를 띄운다 — 한 번 누르면 멈춰야 한다');
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // 정지를 안 눌렀으면 늦게 온 사건이 노드를 채운다 — 1번 검사가 뜻이 있으려면 이래야 한다.
  resetRobotSession();
  resetViewpoint(MISSION);
  online();
  markApproved();
  ownCommand();
  const frames = mockScanUplink();
  for (const frame of frames.slice(0, 4)) receiveUplink(decodeUplink(frame.payload), MISSION, frame.atSec, 90);
  const before = filled();
  for (const frame of frames.slice(4, 6)) receiveUplink(decodeUplink(frame.payload), MISSION, frame.atSec, 90);
  control('정지를 안 누르면 노드가 더 찬다', filled() > before);
}
{
  // 발행 성공과 잠금을 묶은 사본 — 실패했으면 안 잠근다. 그것이 막으려는 것이다.
  resetRobotSession();
  online();
  markApproved();
  const stopped = await emergencyStop(client({ connected: false }));
  control('발행 실패해도 잠긴다', stopped.published === false && robotSession().stopped !== null);
}
{
  // detail 이 깨져도 정지 상태에서는 아무것도 안 바뀐다.
  resetRobotSession();
  online();
  markApproved();
  await emergencyStop(client());
  const before = JSON.stringify(robotSession());
  applyEffects([{ kind: 'progress', ack: 9, of: 9 }]);
  control('잠긴 뒤 effects 는 통째로 무시된다', JSON.stringify(robotSession()) === before);
}

resetRobotSession();
resetViewpoint(MISSION);
commandTracker.clear();

// ── 6. 일시정지 — 멈추되 버리지 않는다 (260910 지시) ────────────────────────
//
// 「중단」을 없애고 그 동작을 「정지」에 넣었다. 대신 **일시정지**가 생겼다. 둘의 차이는
// 하나뿐이다 — 정지는 진행상황을 종결하고, 일시정지는 그대로 남긴다.
//
// 뼈대는 정지와 같다: **발행이 실패해도 멈춤은 일어난다.**
{
  resetRobotSession();
  setConnection({ state: 'open' });
  markApproved();
  const bot = client();
  await issueScan(bot, { viewpoint_count: 8 });

  // 로봇이 세 걸음 돌았다 — 이 진행상황이 살아남아야 한다.
  const before = robotSession().progress;
  applyEffects([{ kind: 'progress', ack: 3, of: 9 }]);
  const progressed = robotSession().progress;
  if (progressed === null) failures.push('진행률이 안 실렸다 — 검사가 헛돈다');

  let stopped = false;
  const release = registerTimer(() => { stopped = true; });
  const paused = await pauseMission(bot);

  if (robotSession().paused === null) failures.push('일시정지를 눌렀는데 세션이 안 멈췄다');
  if (!stopped) failures.push('일시정지가 타이머를 안 멈춘다 — 화면이 계속 흐른다');
  if (canIssueRobotCommand()) failures.push('일시정지 중인데 새 명령을 내도 된다고 한다');
  // **핵심** — 아무것도 안 버린다.
  if (robotSession().progress === null) failures.push('일시정지가 진행률을 버렸다 — 그것은 정지가 할 일이다');
  if (robotSession().stopped !== null) failures.push('일시정지가 화면을 잠갔다 — 정지와 같아져 버린다');
  if (paused.published !== true) failures.push('일시정지가 로봇에 안 나갔다');
  // **로봇을 멈추는 방법은 하나뿐이다** (260910 실측). `abort_mission` 은 수락만 하고
  // 임무를 그대로 두고 돌린다 — 6초에 쏴도 27초까지 계속 돌았다. `abort` 만 멎는다.
  const last = bot.sent.at(-1);
  if (last?.action !== 'abort') {
    failures.push(`일시정지가 ${last?.action} 을 쏜다 — abort 여야 한다 (abort_mission 은 안 멈춘다)`);
  }
  // 규약 밖의 파라미터를 더하지 않는다 — reason 하나뿐이다.
  if (JSON.stringify(last?.parameters ?? {}) !== JSON.stringify({ reason: 1 })) {
    failures.push(`일시정지의 파라미터가 ${JSON.stringify(last?.parameters)} 다 — reason 하나여야 한다`);
  }
  release();
  if (before === progressed) failures.push('진행률이 안 바뀌었다 — 검사가 헛돈다');
}
{
  // **발행이 실패해도 멈춘다.** 정지와 같은 뼈대다.
  resetRobotSession();
  setConnection({ state: 'open' });
  markApproved();
  let timerStopped = false;
  registerTimer(() => { timerStopped = true; });
  const paused = await pauseMission(null);   // 연결 없음
  if (robotSession().paused === null) failures.push('못 보냈다고 일시정지를 안 걸었다');
  if (!timerStopped) failures.push('못 보냈다고 타이머를 안 멈췄다');
  if (paused.published !== false || paused.failure === null) {
    failures.push('못 보냈는데 조용하다 — 크게 말해야 한다');
  }
}
{
  // **재시작** — 멈춰 있던 단계를 다시 낸다. 승인은 다시 안 받는다.
  resetRobotSession();
  setConnection({ state: 'open' });
  markApproved();
  const bot = client();
  await issueScan(bot, { viewpoint_count: 8 });
  await pauseMission(bot);
  const sentBefore = bot.sent.length;
  await resumeMission(bot, { viewpoint_count: 8 });

  if (robotSession().paused !== null) failures.push('재시작했는데 아직 멈춰 있다');
  if (!robotSession().approved) failures.push('재시작이 승인을 내렸다 — 사람이 이미 승인한 임무다');
  if (bot.sent.length !== sentBefore + 1) {
    failures.push(`재시작이 명령을 ${bot.sent.length - sentBefore}건 냈다 — 하나여야 한다`);
  }
  if (bot.sent.at(-1)?.action !== 'scan_mission') {
    failures.push(`재시작이 ${bot.sent.at(-1)?.action} 을 냈다 — 멈출 때 돌던 단계여야 한다`);
  }
}

// ── 7. 「중단」이 사라지고 셋만 남았는가 (소스) ──────────────────────────────
//
// 전에는 「■ 정지」가 게이트웨이로 `mission_pause` 를 쏘다 거절되고, 그 옆의 「■ 중단」만
// 실제로 로봇을 멈췄다 — **같은 뜻의 버튼이 둘인데 하나만 동작했다.**
{
  const buttons = readFileSync(join(root, 'src', 'physical', 'StopButton.tsx'), 'utf8');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [name, mark] of [['StopButton', '■ 정지'], ['PauseButton', '⏸'], ['ResumeButton', '▶ 재시작']]) {
    if (!buttons.includes(`export function ${name}`)) failures.push(`${name} 이 없다`);
    if (!buttons.includes(mark)) failures.push(`${name} 의 글씨(${mark})가 없다`);
  }
  if (strip(buttons).includes('중단')) failures.push('「중단」이 남아 있다 — 정지에 합쳤다');
  for (const bar of [['src', 'shell', 'AppShell.tsx'], ['src', 'views', 'TopBar.tsx']]) {
    const source = strip(readFileSync(join(root, ...bar), 'utf8'));
    if (/mission_(pause|resume)/.test(source)) {
      failures.push(`${bar.at(-1)} 이 아직 게이트웨이로 mission_pause 를 쏜다 — 거절되는 명령이다`);
    }
    for (const name of ['StopButton', 'PauseButton', 'ResumeButton']) {
      if (!source.includes(`<${name} />`)) failures.push(`${bar.at(-1)} 에 ${name} 이 없다`);
    }
  }
}

// ── 8. 정지 버튼이 실제로 보이는가 (260910 실측으로 드러난 자리) ────────────
//
// **흰 글씨에 흰 바탕이었다.** 셸 머리줄의 `.global-bar button` 이 `background:#fff` 를
// 걸고 그쪽이 더 구체적이라, `.robot-stop` 의 빨간 바탕이 덮였다. 화면에는 **빈 상자**가
// 떴고 예전 「중단」도 내내 그 상태였다.
//
// 「크고, 색이 다르고, 다른 버튼과 떨어져 있다」가 이 버튼의 규칙인데 그중 둘이 죽어
// 있었다. 눌러야 할 때 안 보이는 정지 버튼이 이 기능의 최악이다.
{
  const css = readFileSync(join(root, 'src', 'style.css'), 'utf8');
  // 머리줄 규칙보다 특정도가 낮으면 또 덮인다 — `button.` 을 붙여 맞춘다.
  for (const name of ['robot-stop', 'robot-pause', 'robot-resume']) {
    if (!new RegExp(`button\.${name}\{`).test(css)) {
      failures.push(`.${name} 의 특정도가 낮다 — .global-bar button 이 바탕을 덮어 빈 상자가 된다`);
    }
  }
  // 검사가 헛돌지 않게 — 덮는 규칙이 실제로 있는지 확인한다.
  if (!/\.global-bar button[^{]*\{[^}]*background:#fff/.test(css)) {
    failures.push('덮는 규칙(.global-bar button)이 사라졌다 — 이 검사의 전제가 없어졌다');
  }
  // 정지는 빨간 바탕에 흰 글씨여야 한다. 옆 버튼과 색이 같으면 못 찾는다.
  const stop = css.match(/button\.robot-stop\{([^}]*)\}/)?.[1] ?? '';
  if (!/background:#d5322b/.test(stop) || !/color:#fff/.test(stop)) {
    failures.push('정지 버튼이 빨간 바탕·흰 글씨가 아니다 — 다른 버튼과 구별되지 않는다');
  }
}

// ── 9. 초기화 — 비우되 연결은 남긴다 (260910 지시) ──────────────────────────
//
// 지금까지는 새로고침이 유일한 방법이었는데, 새로고침하면 **브로커 연결이 끊긴다.**
// 무대에서 연결 관리를 다시 열어 붙이는 시간이 아깝고 그 사이 화면은 빨갛다.
//
// 그리고 **두 번 눌러야 한다.** 정지와 반대다 — 정지는 못 누르는 것이 나쁘고, 초기화는
// 잘못 누르는 것이 나쁘다. 한 판을 통째로 버리는 일이라 급할 이유가 없다.
{
  const scenario = await load('src', 'data', 'scenario.ts');
  resetRobotSession();
  setConnection({ state: 'open' });
  markApproved();
  const bot = client();
  await issueScan(bot, { viewpoint_count: 8 });
  applyEffects([{ kind: 'progress', ack: 3, of: 9 }]);

  scenario.resetMission();

  const after = scenario.getMissionState();
  if (after.current.missionId !== '') failures.push(`초기화 뒤에도 임무가 남았다 — ${after.current.missionId}`);
  if (after.current.milestones.length !== 0) failures.push('초기화 뒤에도 마일스톤이 남았다');
  if (after.proposal !== null) failures.push('초기화 뒤에도 제안이 남았다');
  if (after.playing) failures.push('초기화했는데 아직 재생 중이다');
  if (robotSession().progress !== null) failures.push('초기화 뒤에도 진행률이 남았다');
  if (robotSession().approved) failures.push('초기화 뒤에도 승인이 남았다 — 아무도 안 눌렀는데 로봇이 움직일 수 있다');
  // **연결은 남는다.** 이것이 새로고침 대신 이 버튼을 만든 이유다.
  if (robotSession().connection.state !== 'open') {
    failures.push('초기화가 브로커 연결까지 끊었다 — 그러면 새로고침과 다를 것이 없다');
  }

  // **부팅 기본값**도 비어 있어야 한다 — 열자마자 구판 대본과 자리표시가 뜨면 안 된다.
  //
  // 소스에서 `emptyView()` 를 찾는 것으로는 못 가른다 — `resetMission()` 안에도 같은 줄이
  // 있어서, 부팅 기본값만 옛 편으로 되돌려도 그 검사는 통과한다(실제로 그랬다).
  // 그래서 **모듈을 새로 하나 더 열어** 아무것도 안 한 상태를 직접 읽는다.
  const fresh = await import(pathToFileURL(join(root, 'src', 'data', 'scenario.ts')).href + '?boot=1');
  const boot = fresh.getMissionState();
  if (boot.current.missionId !== '') {
    failures.push(`부팅 기본값이 ${boot.current.missionId} 다 — 열자마자 안 쓰는 대본이 뜬다`);
  }
  if (boot.current.milestones.length !== 0) {
    failures.push(`부팅 기본값에 마일스톤이 ${boot.current.milestones.length}건 있다`);
  }
  // `hardware` 가 `null` 이면 cast 를 그린다 — 자리표시 카드가 되살아난다. 빈 배열이어야 한다.
  if (boot.current.hardware === null || boot.current.hardware.length !== 0) {
    failures.push('부팅 기본값의 장비 목록이 비어 있지 않다 — 자리표시 카드가 뜬다');
  }
  if (boot.headSec !== 0 || boot.playing) failures.push('부팅하자마자 재생 중이다');

  // 화면이 두 번 묻는가.
  const button = readFileSync(join(root, 'src', 'views', 'ResetButton.tsx'), 'utf8');
  if (!/setAsking\(true\)/.test(button) || !/정말 초기화/.test(button)) {
    failures.push('초기화가 한 번에 지운다 — 한 판을 버리는 일은 두 번 물어야 한다');
  }
  for (const bar of [['src', 'shell', 'AppShell.tsx'], ['src', 'views', 'TopBar.tsx']]) {
    if (!readFileSync(join(root, ...bar), 'utf8').includes('<ResetButton />')) {
      failures.push(`${bar.at(-1)} 에 초기화 버튼이 없다`);
    }
  }
}

if (failures.length) {
  console.error(`❌ verify:emergency-stop\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 정지 뒤 늦게 온 CommandStatus 가 노드를 안 바꾼다 — 진행률·door_turn 도 멈춘다');
console.log('✅ 타이머·폴링이 끊긴다 · 화면이 잠기고 「정지 해제」로 나온다 (승인은 내려간다)');
console.log('✅ 연결이 없어도 눌린다 — 못 보내면 「보내지 못했습니다」를 띄운다 (조용히 성공한 척 안 한다)');
console.log('✅ 발행이 실패해도·예외를 던져도·클라이언트가 없어도 화면은 잠긴다 (발행과 잠금이 갈려 있다)');
console.log('✅ 규약 그대로 — action 은 상수 하나 · 파라미터는 reason 뿐 · abort 는 자기 command_id');
console.log('✅ 일시정지 — 멈추되 진행률을 남긴다 · 못 보내도 멈춘다 · 재시작이 그 단계를 다시 낸다');
console.log('✅ 정지 버튼이 빨간 바탕에 흰 글씨로 보인다 — 머리줄 규칙에 안 덮인다 (빈 상자였다)');
console.log('✅ 「중단」은 사라지고 정지·일시정지·재시작 셋만 — 두 셸 다 그리고, disabled 도 confirm 도 없다');
console.log('✅ 초기화가 임무·진행·승인을 비우고 연결은 남긴다 · 두 번 물어본다 · 부팅 기본값이 빈 화면');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
