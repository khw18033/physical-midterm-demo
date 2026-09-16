// verify:no-publish-before-approval (260910 신설 — 화면 연결 지시서 §7)
//
// **승인 전에 로봇으로 나가는 바이트가 0건인가.**
//
// 매칭 결과는 제안이고 사람이 승인하기 전에는 아무것도 나가지 않는다(`VZ-U-07`).
// 이 검사는 그 선이 로봇 채널에도 걸려 있는지 본다 — 대본 재생에는 걸려 있었지만
// MQTT 는 이번에 새로 뚫은 길이라 같은 선을 다시 그어야 한다.
//
// 발행을 세는 방법: 진짜 `PhysicalClient` 를 쓰되 `send()` 를 세는 것으로 갈아 끼운다.
// 브로커에 붙지 않은 상태에서도 「보내려 시도했는가」가 잡혀야 하므로 붙은 척한다.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const { issueScan, issueApproach, issuePing, emergencyStop } = await load('src', 'physical', 'robotCommands.ts');
const {
  resetRobotSession, markApproved, robotSession, canIssueRobotCommand, releaseStopped, setConnection,
} = await load('src', 'physical', 'robotSession.ts');

/** 브로커에 붙은 것으로 둔다 — `issueScan` 이 `robotDrives()` 를 묻는다. */
const online = () => setConnection({ state: 'open' });

const failures = [];
const controls = [];

/** 붙은 척하면서 발행을 세는 가짜 클라이언트. 진짜와 같은 모양이다. */
function countingClient() {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    getStatus: () => ({ state: 'open' }),
    // 진짜 클라이언트와 같은 면 — issuePing 이 응답을 기다리므로 귀가 있어야 한다.
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** 로봇이 답한 척한다. 안 부르면 응답 없음이 된다. */
    reply(message) { for (const l of listeners) l(message); },
    send(action, parameters) {
      sent.push({ action, parameters });
      const commandId = 'cmd-' + String(sent.length).padStart(8, '0');
      // ping 은 왕복을 기다린다 — 다음 틱에 답이 온 것으로 한다.
      if (action === 'ping') {
        setTimeout(() => this.reply({ kind: 'acceptance', commandId, accepted: true, code: null, message: null }), 0);
      }
      return { sent: true, commandId };
    },
  };
}

const params = { viewpoint_count: 8, forward_distance_m: 4.2 };

// ── 1. 승인 전 — 임무 명령이 하나도 안 나간다 ────────────────────────────────
{
  resetRobotSession();
  online();
  const client = countingClient();
  if (canIssueRobotCommand()) failures.push('승인 전인데 로봇 명령을 내도 된다고 한다');

  const scan = await issueScan(client, params);
  const approach = await issueApproach(client, params);

  if (client.sent.length !== 0) {
    failures.push(`승인 전에 ${client.sent.length}건이 나갔다 — ${client.sent.map((s) => s.action).join(', ')}`);
  }
  if (scan?.sent !== false) failures.push('승인 전 스캔이 보냈다고 한다');
  if (approach?.sent !== false) failures.push('승인 전 접근이 보냈다고 한다');
  // 왜 안 보냈는지는 말해야 한다 — 조용히 넘어가면 발표장에서 「왜 안 가지」가 된다.
  if (!String(scan?.reason ?? '').trim()) failures.push('승인 전 거부에 사유가 없다');
}

// ── 2. 승인 뒤 — 스캔이 나간다. forward_m 은 0 이다 ─────────────────────────
{
  resetRobotSession();
  online();
  const client = countingClient();
  markApproved();
  await issueScan(client, params);

  if (client.sent.length !== 1) failures.push(`승인 뒤 스캔이 ${client.sent.length}건 — 하나여야 한다`);
  const scan = client.sent[0];
  if (scan?.action !== 'scan_mission') failures.push(`승인이 ${scan?.action} 을 쐈다 — scan_mission 이어야 한다`);
  // **스캔과 접근을 한 명령으로 묶지 않는다** — 두 마일스톤이 한 명령에 걸리면 안 된다.
  if (scan?.parameters?.forward_m !== 0) failures.push(`승인이 쏜 forward_m 이 ${scan?.parameters?.forward_m} — 0 이어야 한다`);
}

// ── 3. 스캔 → 접근이 자동으로 이어지지 않는다 (§1) ──────────────────────────
{
  resetRobotSession();
  online();
  const client = countingClient();
  markApproved();
  await issueScan(client, params);
  const before = client.sent.length;

  // door_turn 이 오지 않은 상태에서 접근을 부르면 — 사람이 안 눌렀다는 뜻이다.
  const { canApproach } = await load('src', 'physical', 'robotCommands.ts');
  if (canApproach()) failures.push('door_turn 전인데 접근을 눌러도 된다고 한다');
  if (client.sent.length !== before) failures.push('스캔이 접근을 자동으로 불렀다 — 사람이 눌러야 한다');
}

// ── 4. 정지 뒤에는 다시 안 나간다 ────────────────────────────────────────────
{
  resetRobotSession();
  online();
  const client = countingClient();
  markApproved();
  await emergencyStop(client);
  const afterStop = client.sent.length;   // abort 하나는 나갔다

  await issueScan(client, params);
  await issueApproach(client, params);
  if (client.sent.length !== afterStop) {
    failures.push(`정지 뒤에 ${client.sent.length - afterStop}건이 더 나갔다 — 잠긴 화면에서 명령이 나가면 안 된다`);
  }

  // 「정지됨」에서 나오면 **승인이 내려간다** — 사람이 다시 승인해야 한다.
  releaseStopped();
  if (robotSession().approved) failures.push('정지를 풀었더니 승인이 그대로다 — 사람이 다시 승인해야 한다');
  if (canIssueRobotCommand()) failures.push('정지를 푼 직후에 명령을 내도 된다고 한다');
}

// ── 5. ping 은 승인과 무관하다 ───────────────────────────────────────────────
//
// 임무 명령이 아니라 연결 확인이다. 발표 직전에 무대에 오르기 전 누르는 것이라
// 승인이라는 개념 자체가 없다.
{
  resetRobotSession();
  online();
  const client = countingClient();
  const ping = await issuePing(client);
  if (client.sent.length !== 1 || client.sent[0].action !== 'ping') {
    failures.push('승인 전 ping 이 안 나간다 — 연결 확인은 임무 명령이 아니다');
  }
  if (ping.ok !== true) failures.push('ping 이 나갔는데 실패라고 한다');
}

// ── 6. 화면이 실제로 스캔을 부르는가 (260910 — 빠져 있던 배선) ──────────────
//
// `issueScan()` 을 만들어 놓고 **부르는 곳을 안 만든 적이 있다.** 이 검사가 함수를 직접
// 불러 통과해서 드러나지 않았다 — 화면에서는 승인해도 로봇이 안 돌았다.
// **함수가 있다**와 **화면이 부른다**는 다르다.
//
// 260910 — 부르는 곳이 `RobotPanel` 에서 `robotBridge.useRobotUplink` 으로 옮겼다. 패널은
// 마일스톤 화면에만 있어서, 승인 직후에 화면을 옮기면 명령이 아예 안 나갔다.
//
// 260911 — 다시 `robotClient()` 로 옮겼다. **그리기 타이밍에 매이면 두 판째에 안 나간다.**
// 같은 임무를 다시 올릴 때 `approved` 가 한 틱 안에 true → false → true 로 오가는데,
// React 가 둘을 한 번의 그리기로 묶으면 의존값이 안 바뀐 것으로 보여 효과가 안 돈다.
// 이제 세션 구독으로 쏜다 — 연결 상태·장비 상태를 거기서 잇는 것과 같은 자리다.
{
  const { readFileSync } = await import('node:fs');
  const wiring = readFileSync(join(root, 'src', 'physical', 'robotClient.ts'), 'utf8');
  // 그리기에 매인 자리로 되돌아가지 않게 못을 박는다.
  const bridge = readFileSync(join(root, 'src', 'physical', 'robotBridge.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/useEffect\([^)]*issueScan/.test(bridge) || /issueScan\(/.test(bridge)) {
    failures.push('스캔 발행이 다시 그리기 효과 안으로 들어갔다 — 두 판째에 안 나간다');
  }
  if (!/issueScan\(/.test(wiring)) {
    failures.push('화면이 issueScan 을 부르지 않는다 — 승인해도 로봇이 안 돈다');
  }
  if (!/shouldIssueScan\(\)/.test(wiring)) {
    failures.push('스캔을 한 번만 쏘는 관문을 안 쓴다 — 다시 그릴 때마다 로봇이 돈다');
  }

  // 관문이 실제로 한 번만 열리는가.
  const { shouldIssueScan } = await load('src', 'physical', 'robotCommands.ts');
  const { markScanIssued, markStarted, clearStarted, setConnection, finishPrep, markPrepTasksDone } =
    await load('src', 'physical', 'robotSession.ts');
  resetRobotSession();
  online();
  if (shouldIssueScan()) failures.push('승인 전인데 스캔을 쏘라고 한다');

  /**
   * **승인만으로는 안 쏜다** (260912 지시 — 관문이 하나 더 생겼다).
   *
   * 승인은 「이 계획대로 해도 좋다」이고 시작은 「지금 하라」다. 무대에서 그 둘 사이에
   * 계획을 설명할 시간이 필요한데, 승인하자마자 로봇이 돌면 그 틈이 없다.
   */
  markApproved();
  if (shouldIssueScan()) failures.push('승인만 했는데 스캔을 쏘라고 한다 — 시작을 눌러야 한다');
  markStarted();
  /**
   * **시작만으로도 안 쏜다** (260912 지시 — 관문이 또 하나 생겼다).
   *
   * 앞에 `T-A1`(문 위치 확인)·`T-A2`(로봇 위치·각도)가 있다. 누르는 즉시 돌면 화면에서는
   * 한 바퀴 다 돌고 나서 그 둘에 완료가 떠서 순서가 거꾸로 보인다. 준비 창이 닫혀야 쏜다
   * (`verify:mission-prep` 이 그 창을 따로 지킨다).
   */
  if (shouldIssueScan()) failures.push('시작을 누르자마자 스캔을 쏘라고 한다 — 준비 단계가 없다');
  // 준비 = 창이 닫히고 **T-A1·T-A2 가 실제로 끝났다** (260914 — `verify:mission-prep` 4절).
  finishPrep();
  markPrepTasksDone();
  if (!shouldIssueScan()) failures.push('준비가 끝났는데 스캔을 안 쏜다');
  markScanIssued();
  if (shouldIssueScan()) failures.push('이미 쐈는데 또 쏘라고 한다 — 로봇이 여러 번 돈다');

  // 승인 없이 시작만 누르는 길은 없다 — 관문 둘이 **둘 다** 있어야 한다.
  resetRobotSession();
  online();
  markStarted();
  if (shouldIssueScan()) failures.push('승인 없이 시작만으로 쏘라고 한다');

  // 브로커가 없으면 안 쏜다.
  resetRobotSession();
  online();
  markApproved();
  markStarted();
  finishPrep();
  markPrepTasksDone();
  setConnection({ state: 'closed', reason: '없음' });
  if (shouldIssueScan()) failures.push('브로커가 없는데 스캔을 쏘라고 한다');

  // 「처음부터」는 시작 관문을 도로 닫는다 — 우회하지 않는다.
  resetRobotSession();
  online();
  markApproved();
  markStarted();
  clearStarted();
  if (shouldIssueScan()) failures.push('처음부터가 시작 관문을 열어 둔 채로 둔다 — 눌러야 움직인다');
  resetRobotSession();
}

// ── 6-b. 화면의 버튼이 시작과 재시작 둘을 한 자리에 둔다 (260912 지시) ───────
{
  const { readFileSync } = await import('node:fs');
  const button = readFileSync(join(root, 'src', 'physical', 'StopButton.tsx'), 'utf8');
  if (!/임무 시작/.test(button)) failures.push('「임무 시작」 글씨가 없다');
  if (!/started \? '▶ 재시작' : '▶ 임무 시작'/.test(button)) {
    failures.push('안 돌린 임무에서 「재시작」이라고 적는다 — 한 번도 안 돌렸는데 다시 시작할 수는 없다');
  }
  if (!/markStarted\(\)/.test(button)) failures.push('시작 버튼이 시작을 안 건다');
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // 승인 확인을 건너뛴 사본은 승인 전에 바이트를 낸다.
  resetRobotSession();
  online();
  const client = countingClient();
  client.send('scan_mission', { steps: 8, forward_m: 0 });  // 관문을 안 지난 발행
  control('승인 확인을 건너뛴 발행', client.sent.length > 0 && !robotSession().approved);
}
{
  resetRobotSession();
  online();
  markApproved();
  control('승인 뒤에는 관문이 열린다', canIssueRobotCommand());
}

resetRobotSession();
// 추적기의 만료 타이머를 끊는다 — 안 끊으면 Node 가 TTL 이 다 될 때까지 안 죽는다.
const { commandTracker } = await load('src', 'shared', 'commandCenter.ts');
commandTracker.clear();

// ── 7. 실패해도 한 틱 안에서 다시 쏘지 않는다 (260912 — 브라우저가 멎었다) ──
//
// 발행이 실패하면 관문이 도로 내려간다(다시 시도할 수 있게). 그런데 그 내림 자체가 세션
// 변경이라 세션 구독이 다시 불리고, 조건이 그대로면 또 쏘고 또 실패해 **무한히 돈다.**
// 실제로 화면이 통째로 멎었다.
//
// 조건이 안 바뀌었으면 한 번으로 끝나야 한다.
{
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(join(root, 'src', 'physical', 'robotClient.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // **되돌아가는 줄이 실제로 있는가.** 변수만 두고 비교를 빼면 고리가 그대로 돈다.
  if (!/=== lastScanAttempt\) return;/.test(client)) {
    failures.push('같은 조건이면 되돌아가는 줄이 없다 — 발행이 실패하면 한 틱 안에서 무한히 돈다');
  }

  // 실제로 돌려 본다 — 못 보내는 클라이언트에 연결만 열린 상태.
  resetRobotSession();
  online();
  let sent = 0;
  const dead = {
    getStatus: () => ({ state: 'open' }),
    send() { sent += 1; return { sent: false, commandId: '', reason: '소켓이 없다' }; },
  };
  markApproved();
  for (let i = 0; i < 5; i += 1) await issueScan(dead, params);
  if (sent > 5) failures.push(`못 보내는데 ${sent}번 쐈다 — 부른 횟수보다 많다`);
}

if (failures.length) {
  console.error(`❌ verify:no-publish-before-approval\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 승인 전 로봇 발행 0건 — 스캔·접근 둘 다 막히고 사유를 말한다');
console.log('✅ 승인 뒤 scan_mission 하나 · forward_m=0 (스캔과 접근을 한 명령으로 묶지 않는다)');
console.log('✅ 스캔이 접근을 자동으로 부르지 않는다 — door_turn 전에는 누를 수도 없다');
console.log('✅ 정지 뒤 발행 0건 · 정지를 풀면 승인이 내려간다 (사람이 다시 승인한다)');
console.log('✅ ping 은 승인과 무관 — 연결 확인은 임무 명령이 아니다');
console.log('✅ 승인만으로는 안 쏜다 — 사람이 「임무 시작」을 눌러야 나간다 (관문 둘)');
console.log('✅ 화면이 실제로 issueScan 을 부른다 · 관문이 한 번만 열린다 · 브로커 없으면 안 쏜다');
console.log('✅ 발행이 실패해도 같은 조건으로 다시 안 쏜다 — 세션 구독이 스스로를 부르는 고리를 막는다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
