// verify:notifications (260913 신설 — 「실제로 이슈가 생기면 알림에도 뜨도록」)
//
// **머리줄의 뱃지가 실제 사건만 센다.**
//
// 전에는 두 줄이 박혀 있었다(`AI-FAIL-01` · `GEN-FAIL-01`). 구 대시보드에서 넘어온 예시이고
// **일어난 적이 없는 일**인데 뱃지는 늘 「알림 2」였다. 무대에서 그것을 보면 방금 무슨 일이
// 난 줄 안다. 반대로 진짜 이슈 — 브로커가 끊기고 로봇이 거절하는 일 — 는 **아무 데도 안
// 올라왔다.** 노드가 빨개지는 것은 그 마일스톤을 보고 있을 때만 보인다.
//
// 막으려는 실패 다섯.
//
//  1. **목이 되살아나는 것** — 시작할 때 비어 있어야 한다.
//  2. **이슈가 안 올라오는 것** — 끊김·거절·못 보낸 정지 셋이 뱃지를 늘려야 한다.
//  3. **무엇이 왜 실패했는지 안 적는 것** — 어느 태스크·무슨 명령·로봇이 준 사유 셋이다.
//  4. **같은 줄로 가득 차는 것** — 폴링은 1.5초마다 실패하고 연결 상태는 초마다 다시 온다.
//     직전과 같으면 삼킨다. 다만 **끊겼다 붙었다 다시 끊기면 세 줄이 다 남아야 한다.**
//  5. **지나가는 상태를 이슈로 적는 것** — 「붙는 중」은 이슈가 아니라 표시등의 일이다.
//
// 대조군 포함.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = (...p) => strip(readFileSync(join(root, 'src', ...p), 'utf8'));

const failures = [];
const controls = [];

const notify = await load('src', 'shared', 'notifications.ts');
const session = await load('src', 'physical', 'robotSession.ts');
const { receiveUplink } = await load('src', 'physical', 'robotBridge.ts');
const { emergencyStop } = await load('src', 'physical', 'robotCommands.ts');

/** 지금 목록. `useNotifications` 는 훅이라 여기서 못 부른다 — 같은 배열을 읽는 길이다. */
const list = () => notify.notificationsNow();

// ── 1. 시작할 때 비어 있다 ──────────────────────────────────────────────────
{
  notify.resetNotifications();
  if (list().length !== 0) failures.push(`시작부터 ${list().length}건이 있다 — 일어난 적 없는 일이 뱃지를 채운다`);

  // 손으로 쓴 두 줄이 되살아나지 않았는가.
  const store = src('shared', 'notifications.ts');
  for (const seeded of ['AI-FAIL-01', 'GEN-FAIL-01']) {
    if (store.includes(seeded)) failures.push(`${seeded} 가 코드에 살아 있다 — 목이 되살아났다`);
  }
}

// ── 2·4·5. 연결 — 결말만, 되풀이는 삼키고, 오가면 다 남긴다 ────────────────
{
  notify.resetNotifications();
  notify.armNotifications();

  notify.noteIssue('robot-broker', 'connection', '브로커가 끊겼습니다 — 6000ms 안에 응답이 없습니다');
  notify.noteIssue('robot-broker', 'connection', '브로커가 끊겼습니다 — 6000ms 안에 응답이 없습니다');
  notify.noteIssue('robot-broker', 'connection', '브로커가 끊겼습니다 — 6000ms 안에 응답이 없습니다');
  if (list().length !== 1) failures.push(`같은 사유가 ${list().length}줄이 됐다 — 하나여야 한다`);

  // 끊겼다 붙었다 다시 끊기면 셋이 다 남는다. 전역으로 한 번씩만 올리면 마지막이 사라진다.
  notify.noteIssue('robot-broker', 'connection', '브로커에 붙었습니다');
  notify.noteIssue('robot-broker', 'connection', '브로커가 끊겼습니다 — 6000ms 안에 응답이 없습니다');
  if (list().length !== 3) failures.push(`오간 것이 ${list().length}줄 — 셋이어야 한다 (끊김·붙음·끊김)`);
  if (list()[0]?.message !== '브로커가 끊겼습니다 — 6000ms 안에 응답이 없습니다') {
    failures.push('최근 것이 맨 위가 아니다');
  }

  // 통로가 다르면 서로 안 삼킨다 — 브로커와 탐지가 같은 줄을 나눠 쓰면 하나가 묻힌다.
  notify.noteIssue('detect', 'connection', '탐지 서비스에 못 닿습니다 — Failed to fetch');
  if (list().length !== 4) failures.push('다른 통로의 알림을 삼킨다');

  // **지나가는 상태는 안 올린다.** 「붙는 중」은 표시등의 일이다.
  const client = src('physical', 'robotClient.ts');
  if (!/status\.state === 'connecting'/.test(client) || !/return;/.test(client)) {
    failures.push('「붙는 중」을 이슈로 올린다 — 확인 한 번에 두 줄이 생긴다');
  }
  if (!/noteConnection\(status\)/.test(client)) failures.push('연결 변화를 알림으로 안 올린다');
}

// ── 3. 태스크 실패 — 어느 태스크·무슨 명령·무슨 사유 ───────────────────────
{
  notify.resetNotifications();
  notify.armNotifications();
  session.resetRobotSession();
  session.recordCommand({
    taskId: 'T-B2', commandId: 'cmd-fail', action: 'move_forward', parameters: { distance_m: 1 },
    issuedAtIso: new Date().toISOString(), requestId: null,
    state: 'issued', code: null, message: null, result: {}, log: [],
  });
  receiveUplink({
    kind: 'acceptance', commandId: 'cmd-fail', accepted: false,
    code: 'go1_sdk_not_running', message: 'bridge down',
  }, 'MSN-260909-01', 3);

  const first = list()[0];
  if (first === undefined) { failures.push('태스크가 거절당했는데 알림이 없다'); }
  else {
    if (first.source !== 'robot') failures.push(`갈래가 ${first.source} — robot 이어야 한다`);
    for (const must of ['T-B2', 'move_forward', 'go1_sdk_not_running', 'bridge down']) {
      if (!first.message.includes(must)) failures.push(`실패 알림에 「${must}」 가 없다 — ${first.message}`);
    }
  }
  session.resetRobotSession();
}

// ── 2-b. 못 보낸 정지 ───────────────────────────────────────────────────────
//
// 화면은 어차피 잠긴다. 그런데 **로봇은 안 멈췄을 수 있다** — 누른 사람이 멈춘 줄 알고
// 다가가는 것이 이 기능의 가장 위험한 실패다.
{
  notify.resetNotifications();
  notify.armNotifications();
  session.resetRobotSession();
  await emergencyStop(null);
  const first = list()[0];
  if (first === undefined || !/정지 명령을 못 보냈습니다/.test(first.message)) {
    failures.push('정지를 못 보냈는데 알림이 없다 — 멈춘 줄 알고 다가간 사람이 있다');
  }
  if (first !== undefined && !/계속 움직일 수 있습니다/.test(first.message)) {
    failures.push('못 보낸 정지가 무엇을 뜻하는지 안 적는다');
  }
  session.releaseStopped();
  session.resetRobotSession();
  notify.resetNotifications();
}

// ── 6. 화면이 그린다 ────────────────────────────────────────────────────────
{
  const shell = src('shell', 'AppShell.tsx');
  if (!/notification-list/.test(shell)) failures.push('알림 목록을 안 그린다');
  if (!/notifications\.length === 0/.test(shell)) failures.push('비어 있을 때를 안 가른다');
  // 「명령이 거부되거나 …」 안내 줄은 뺐다 (260913 지시).
  if (/여기에 쌓입니다/.test(shell)) failures.push('빈 판에 안내 문장이 남아 있다');
  if (!/SOURCE_WORDS/.test(shell)) failures.push('갈래를 사람 말로 안 적는다');
  if (!/occurredAt/.test(shell)) failures.push('언제 난 일인지 안 적는다');
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **전역으로 한 번만 올리는 사본.** 끊겼다 붙었다 다시 끊기면 마지막이 사라진다.
  const once = new Set();
  const naive = (text) => { if (once.has(text)) return false; once.add(text); return true; };
  const flap = ['끊김', '붙음', '끊김'];
  const naiveCount = flap.filter(naive).length;
  notify.resetNotifications();
  notify.armNotifications();
  for (const text of flap) notify.noteIssue('ch', 'connection', text);
  control('전역으로 한 번만 올리는 사본', naiveCount === 2 && list().length === 3);
  notify.resetNotifications();
}
{
  // **되풀이를 안 삼키는 사본.** 폴링 열 번이면 열 줄이 된다.
  notify.resetNotifications();
  notify.armNotifications();
  for (let again = 0; again < 10; again += 1) notify.noteIssue('ch', 'connection', '같은 사유');
  control('되풀이를 안 삼키는 사본 (폴링 10회 = 10줄)', list().length === 1);
  notify.resetNotifications();
}

if (failures.length) {
  console.error(`❌ verify:notifications\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 시작할 때 비어 있다 — 손으로 쓴 두 줄이 안 되살아난다');
console.log('✅ 끊김·붙음이 남고 「붙는 중」은 안 남는다 — 되풀이는 삼키되 오간 것은 다 남는다');
console.log('✅ 태스크 실패가 올라온다 — 어느 태스크 · 무슨 명령 · 로봇이 준 코드와 문구');
console.log('✅ 못 보낸 정지가 올라온다 — 「로봇이 계속 움직일 수 있습니다」까지 적는다');
console.log('✅ 화면이 갈래·시각·문구 셋을 그리고, 빈 판에 안내 문장이 없다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
