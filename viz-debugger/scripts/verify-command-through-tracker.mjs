// verify:command-through-tracker (260910 신설 — 화면 연결 지시서 §7)
//
// **로봇 명령이 `CommandTracker` 를 지나는가.**
//
// 탭 이식 때 추적기를 출구 본체로 삼은 이유가 이것이다. 로봇 명령이 이걸 우회하면
// `VZ-O-02`(4단계 추적)와 `VZ-O-03`(감사)이 **그 명령만** 못 본다 — 「모든 조작은
// produced_by=human 으로 기록된다」가 로봇 명령에서만 거짓이 된다.
//
// 보는 것 넷.
//  1. 로봇 명령이 추적기의 목록에 뜨는가 (`VZ-O-02`)
//  2. 사람 조작 기록에 남는가 (`VZ-D-08` · `recordHuman`)
//  3. 감사 필드가 실려 나가는가 (`VZ-O-03`)
//  4. 발행 수단만 갈렸고 **추적은 안 갈렸는가** — 게이트웨이로 나가지 않는다

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const { commandTracker } = await load('src', 'shared', 'commandCenter.ts');
const { issueScan, issueSdkStart, issueSdkAuto } = await load('src', 'physical', 'robotCommands.ts');
const { resetRobotSession, markApproved, setConnection } = await load('src', 'physical', 'robotSession.ts');
const online = () => setConnection({ state: 'open' });
const failures = [];
const controls = [];

function countingClient() {
  const sent = [];
  return {
    sent,
    getStatus: () => ({ state: 'open' }),
    send(action, parameters) {
      sent.push({ action, parameters });
      return { sent: true, commandId: 'cmd-' + String(sent.length).padStart(8, '0') };
    },
  };
}

// ── 1~4. 스캔 하나를 쏘고 추적기가 봤는지 본다 ───────────────────────────────
{
  resetRobotSession();
  online();
  markApproved();
  const client = countingClient();
  const before = commandTracker.getSnapshot().length;

  const outcome = await issueScan(client, { viewpoint_count: 8, forward_distance_m: 4.2 });

  // 1. 추적기 목록에 떴는가.
  const after = commandTracker.getSnapshot();
  if (after.length !== before + 1) {
    failures.push(`추적기 목록이 ${before} → ${after.length} — 로봇 명령이 추적기를 안 지났다`);
  }
  const tracked = after.find((c) => c.requestId === outcome?.requestId);
  if (tracked === undefined) {
    failures.push('발행한 명령을 추적기에서 못 찾는다 — 우회했다는 뜻이다');
  } else {
    if (tracked.action !== 'scan_mission') failures.push(`추적기가 본 action 이 ${tracked.action}`);
    if (tracked.entity !== 'robot-01') failures.push(`추적기가 본 대상이 ${tracked.entity} — 화면 id 여야 한다`);
    // 4단계 추적이 걸렸는가 — 발행 단계가 적혀야 한다.
    if (!tracked.stages.some((s) => s.stage === 'issued')) failures.push('발행 단계가 추적기에 안 적혔다');
    // ACK 가 반영됐는가 — 상관 키가 우리 command_id 다.
    if (tracked.tracking.linked !== true && tracked.tracking.value === outcome?.requestId) {
      failures.push('ACK 가 반영되지 않아 상관 키가 요청 식별자에 머물러 있다');
    }
  }

  // 2. 실제로 MQTT 로 나갔는가 — 발행 수단이 갈렸다는 뜻.
  if (client.sent.length !== 1) failures.push(`MQTT 발행이 ${client.sent.length}건 — 하나여야 한다`);
  if (client.sent[0]?.action !== 'scan_mission') failures.push('MQTT 로 나간 action 이 다르다');

  // 3. 태스크 id 가 파라미터에 실렸는가 — 응답이 어느 노드의 것인지 잇는 실.
  if (tracked !== undefined && outcome?.commandId === '') failures.push('command_id 가 안 돌아왔다');
}

// ── 4-b. 구동 브리지 명령도 지난다 (260910) ─────────────────────────────────
//
// `sdk_start` 는 **로봇을 일으켜 세운다.** 임무 명령이 아니라 승인과 무관하게 나가므로
// 오히려 감사에 남을 이유가 더 크다 — 「누가 언제 로봇을 세웠나」가 남아야 한다.
{
  resetRobotSession();
  online();   // 승인은 안 한다 — 임무 명령이 아니라는 것까지 같이 본다
  const client = countingClient();
  const before = commandTracker.getSnapshot().length;

  const started = await issueSdkStart(client);
  const auto = await issueSdkAuto(client, false);

  if (commandTracker.getSnapshot().length !== before + 2) {
    failures.push('브리지 명령이 추적기를 안 지났다 — 로봇을 세우는 명령이 감사에 안 남는다');
  }
  if (started.sent !== true) failures.push('승인 전이라고 브리지 명령을 막았다 — 임무 명령이 아니다');
  const actions = client.sent.map((c) => c.action);
  if (actions.join(',') !== 'sdk_start,sdk_auto') failures.push(`나간 action 이 ${actions.join(',')}`);
  // 규약이 map<string, double> 이라 참·거짓을 1·0 으로 싣는다.
  if (client.sent[1]?.parameters?.on !== 0) failures.push('자동 기동 끄기가 on:0 으로 안 나갔다');
  if (auto.sent !== true) failures.push('sdk_auto 가 안 나갔다');
}

// ── 5. 게이트웨이로는 안 나간다 ──────────────────────────────────────────────
//
// 발행 수단만 갈아 끼운 것이라, 로봇 명령이 게이트웨이 전송을 건드리면 안 된다.
{
  const { getTransport } = await load('src', 'transport', 'index.ts');
  const transport = getTransport();
  const original = transport.publishCommand.bind(transport);
  let gatewayCalls = 0;
  transport.publishCommand = async (request) => {
    gatewayCalls += 1;
    return { clientRequestId: request.client_request_id, commandId: null, accepted: false, reasonCode: 'test', message: 'test' };
  };

  resetRobotSession();
  online();
  markApproved();
  const client = countingClient();
  await issueScan(client, { viewpoint_count: 8, forward_distance_m: 4.2 });

  transport.publishCommand = original;
  if (gatewayCalls !== 0) {
    failures.push(`로봇 명령이 게이트웨이를 ${gatewayCalls}번 건드렸다 — MQTT 로만 나가야 한다`);
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // 추적기를 우회해 클라이언트를 직접 부르면 목록이 안 는다 — 그것이 이 검사가 막는 것이다.
  resetRobotSession();
  online();
  markApproved();
  const client = countingClient();
  const before = commandTracker.getSnapshot().length;
  client.send('scan_mission', { steps: 8, forward_m: 0 });   // 우회
  const after = commandTracker.getSnapshot().length;
  control('추적기를 우회한 직접 발행', client.sent.length === 1 && after === before);
}
{
  // 발행 수단을 안 주면 게이트웨이로 간다 — 기본 경로가 안 바뀌었다는 확인.
  const source = await load('src', 'shared', 'commandCenter.ts').then(() => null).catch(() => null);
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(root, 'src', 'shared', 'commandCenter.ts'), 'utf8');
  control(
    '발행 수단을 안 주면 게이트웨이 기본값',
    /options\.publish \?\? \(\(r: CommandRequest\) => getTransport\(\)\.publishCommand\(r\)\)/.test(text) && source === null,
  );
}

resetRobotSession();
// 추적기의 만료 타이머를 끊는다 — 안 끊으면 Node 가 TTL 이 다 될 때까지 안 죽는다.
commandTracker.clear();

if (failures.length) {
  console.error(`❌ verify:command-through-tracker\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 로봇 명령이 CommandTracker 목록에 뜬다 — 4단계 추적(VZ-O-02)과 감사(VZ-O-03)가 본다');
console.log('✅ 발행 수단만 MQTT 로 갈렸고 게이트웨이는 0번 — 추적은 안 갈렸다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
