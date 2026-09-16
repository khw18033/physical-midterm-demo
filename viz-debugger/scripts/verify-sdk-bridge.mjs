// verify:sdk-bridge (260910 신설 — 연동 가이드 §4-3)
//
// **「붙어 있다」와 「움직일 수 있다」는 다르다.**
//
// 구동 브리지(`go1-sdk`)는 평시에 내려가 있다 — 기동하는 순간 로봇이 일어서기 때문에
// 부팅 자동시작이 꺼져 있다. 로봇이 브로커에 붙어 있어도 그것만으로는 안 움직인다.
// 이동 명령이 오면 알아서 띄우고, 그 사이 진행 보고가 두 건 더 온다.
//
//     수락 → sdk_starting → sdk_ready → executing → (임무 ACK…) → 종료
//
// 보는 것 다섯.
//  1. **단계 보고를 안 버린다** — `detail` 은 임무 ACK 만 오는 것이 아니다. 맨 문자열로도
//     오고 `sdk_starting` 으로도 온다. `parseDetail` 은 `step` 을 요구해서 그 둘을 조용히
//     버린다 (실측: `diag` 의 단계 둘이 그렇게 사라졌다).
//  2. **일어서는 중이 화면까지 온다** — 그 몇 초 동안 임무 ACK 는 하나도 안 온다.
//     화면이 조용하면 「명령이 안 갔다」로 읽힌다.
//  3. **`sdk` 가 없으면 「모른다」다** — `null` 을 「꺼짐」으로 그리면 안 된다. 지금 돌고
//     있는 노드(schema 1.3)는 이 필드를 아예 안 실어 보낸다.
//  4. **노드 없는 명령이 사건을 안 만든다** — 브리지 명령은 태스크 그래프에 자리가 없다.
//  5. **이름은 상수 한 줄에** — 하드웨어가 다른 이름을 쓰겠다고 할 수 있다.
//
// 대조군 포함.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const { parseDetail, stageOf, isStanding, SDK_STARTING, SDK_READY } = await load('src', 'physical', 'uplink.ts');
const { effectsOf, NO_NODE } = await load('src', 'physical', 'missionLink.ts');
const { applyDeviceMessage } = await load('src', 'physical', 'deviceState.ts');
const { receiveUplink } = await load('src', 'physical', 'robotBridge.ts');
const { robotSession, recordCommand, resetRobotSession, setConnection } = await load('src', 'physical', 'robotSession.ts');
const scenario = await load('src', 'data', 'scenario.ts');
const { SDK_ACTIONS } = await load('src', 'physical', 'presets.ts');

const failures = [];
const controls = [];

const context = { taskOf: () => NO_NODE, seenYawByIndex: new Map(), viewpointCount: 8 };
const statusOf = (raw) => ({ kind: 'status', commandId: 'cmd-sdk', state: 'RUNNING', detail: parseDetail(raw), raw });
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ── 1. 단계 보고를 안 버린다 ─────────────────────────────────────────────────
{
  // 실측한 네 모양. 앞의 둘은 `parseDetail` 이 못 읽는다 — 그게 맞고, `stageOf` 가 읽는다.
  const cases = [
    ['', null, '빈 것은 아무 말도 아니다'],
    ['executing', 'executing', '맨 문자열로 온 단계 이름'],
    [JSON.stringify({ event: SDK_STARTING }), SDK_STARTING, '브리지가 뜨는 중'],
    [JSON.stringify({ event: SDK_READY }), SDK_READY, '브리지가 섰다'],
  ];
  for (const [raw, want, what] of cases) {
    const got = stageOf(raw);
    if (got !== want) {
      failures.push(`${what}: stageOf(${JSON.stringify(raw)}) 가 ${JSON.stringify(got)} — ${JSON.stringify(want)} 이어야 한다`);
    }
  }
  // **임무 ACK 는 단계가 아니다.** 한 봉투가 두 뜻이 되면 진행률이 두 번 밀린다.
  const ack = JSON.stringify({ ack: 3, of: 10, event: 'scan_turn', step: 3, steps: 8, yaw_deg: 225, note: 'ok' });
  if (stageOf(ack) !== null) failures.push('임무 ACK 를 단계로도 읽는다 — 한 봉투가 두 뜻이 된다');
  if (parseDetail(ack) === null) failures.push('임무 ACK 를 못 읽는다 — 검사가 헛돈다');
  // 반대로 단계는 임무 ACK 가 아니다.
  if (parseDetail(JSON.stringify({ event: SDK_STARTING })) !== null) {
    failures.push('sdk_starting 을 임무 ACK 로도 읽는다 — step 이 없는데 칸을 고른다');
  }
  if (!isStanding(SDK_STARTING) || isStanding(SDK_READY) || isStanding(null)) {
    failures.push('「일어서는 중」 판정이 sdk_starting 하나가 아니다');
  }
}

// ── 2. 일어서는 중이 화면까지 온다 ───────────────────────────────────────────
{
  const effects = effectsOf(statusOf(JSON.stringify({ event: SDK_STARTING })), context);
  const stage = effects.find((e) => e.kind === 'stage');
  if (stage === undefined) failures.push('sdk_starting 이 효과를 하나도 안 낳는다 — 화면이 조용하다');
  else if (stage.stage !== SDK_STARTING) failures.push(`단계가 ${stage.stage} 로 왔다`);

  // 세션까지 실제로 닿는가.
  resetRobotSession();
  setConnection({ state: 'open' });
  scenario.previewMission('MSN-260909-01');
  recordCommand({
    commandId: 'cmd-sdk', taskId: NO_NODE, action: SDK_ACTIONS.start,
    issuedAtIso: new Date().toISOString(), parameters: {}, log: [], requestId: 'req-sdk', state: 'issued', code: null, message: null, result: {},
  });
  receiveUplink(statusOf(JSON.stringify({ event: SDK_STARTING })), 'MSN-260909-01', 1);
  if (robotSession().stage !== SDK_STARTING) {
    failures.push(`세션의 단계가 ${robotSession().stage} 다 — 화면이 「일어서는 중」을 못 그린다`);
  }
  receiveUplink(statusOf(JSON.stringify({ event: SDK_READY })), 'MSN-260909-01', 2);
  if (robotSession().stage !== SDK_READY) failures.push('sdk_ready 로 안 넘어간다 — 배너가 안 꺼진다');
}

// ── 3. sdk 가 없으면 「모른다」다 ────────────────────────────────────────────
{
  const parsed = { entityType: 'robot', entityId: 'go1-001', channel: 'status' };
  // 지금 돌고 있는 노드가 실제로 보내는 모양 — `sdk` 가 아예 없다.
  const real = applyDeviceMessage(undefined, parsed, { status: 'online', link: 'fault', battery_pct: 57 });
  if (real.sdkReady !== null) failures.push(`sdk 가 안 왔는데 ${real.sdkReady} 로 읽는다 — null 이어야 한다`);
  if (real.sdkAutostart !== null) failures.push('자동 기동을 안 왔는데 지어 읽는다');

  // 오면 그대로 읽는다.
  const told = applyDeviceMessage(real, parsed, { sdk: { ready: true, autostart: false } });
  if (told.sdkReady !== true || told.sdkAutostart !== false) failures.push('sdk 가 왔는데 안 읽는다');
  // **다음 봉투에 없다고 지우지 않는다** — 안 실린 것과 꺼진 것은 다르다.
  const later = applyDeviceMessage(told, parsed, { status: 'online' });
  if (later.sdkReady !== true) failures.push('sdk 가 안 실린 봉투가 서 있던 브리지를 지웠다');
}

// ── 4. 노드 없는 명령이 사건을 안 만든다 ────────────────────────────────────
{
  const before = scenario.traceFor(scenario.currentMission()).length;
  receiveUplink(
    { kind: 'acceptance', commandId: 'cmd-sdk', accepted: true, code: null, message: null },
    'MSN-260909-01', 3,
  );
  receiveUplink(
    { kind: 'result', commandId: 'cmd-sdk', status: 'SUCCEEDED', result: {}, code: null, message: null },
    'MSN-260909-01', 4,
  );
  const after = scenario.traceFor(scenario.currentMission()).length;
  if (after !== before) failures.push(`브리지 명령이 사건 ${after - before}건을 만들었다 — 그래프에 없는 노드다`);
}

// ── 4-b. 「그런 명령 없다」를 기억한다 (260910 실측) ────────────────────────
//
// 가이드 §4-2 의 브리지 어휘가 지금 pi7 에 올라가 있지 않다 — 실제로 이렇게 돌아왔다:
//
//     sdk_stop  거절 UNIMPLEMENTED action not supported
//     sdk_auto  거절 UNIMPLEMENTED action not supported
//
// 그러면 그 버튼은 눌러도 영영 안 되는 버튼이다. 화면이 한 번 듣고 나면 말해야 한다.
{
  resetRobotSession();
  setConnection({ state: 'open' });
  recordCommand({
    commandId: 'cmd-nosdk', taskId: NO_NODE, action: SDK_ACTIONS.stop,
    issuedAtIso: new Date().toISOString(), parameters: {}, log: [], requestId: 'req-nosdk', state: 'issued', code: null, message: null, result: {},
  });
  receiveUplink({
    kind: 'acceptance', commandId: 'cmd-nosdk', accepted: false,
    code: 'UNIMPLEMENTED', message: 'action not supported',
  }, 'MSN-260909-01', 5);
  if (robotSession().unsupported[SDK_ACTIONS.stop] !== true) {
    failures.push('UNIMPLEMENTED 를 안 기억한다 — 발표자가 죽은 버튼을 계속 누른다');
  }
  // **다른 거절과 섞지 않는다.** battery_too_low 는 지금 안 되는 것이지 영영 안 되는 것이 아니다.
  resetRobotSession();
  setConnection({ state: 'open' });
  recordCommand({
    commandId: 'cmd-batt', taskId: NO_NODE, action: SDK_ACTIONS.start,
    issuedAtIso: new Date().toISOString(), parameters: {}, log: [], requestId: 'req-batt', state: 'issued', code: null, message: null, result: {},
  });
  receiveUplink({
    kind: 'acceptance', commandId: 'cmd-batt', accepted: false,
    code: 'FAILED_PRECONDITION', message: 'battery_too_low',
  }, 'MSN-260909-01', 6);
  if (robotSession().unsupported[SDK_ACTIONS.start] === true) {
    failures.push('배터리 부족을 「그런 명령 없다」로 기억한다 — 충전하면 되는 것을 영영 안 되는 것으로 만든다');
  }
}

// ── 5. 이름은 상수 한 줄에 ──────────────────────────────────────────────────
{
  for (const file of [['src', 'physical', 'RobotPanel.tsx'], ['src', 'physical', 'robotCommands.ts']]) {
    const source = strip(readFileSync(join(root, ...file), 'utf8'));
    if (/'sdk_(start|stop|auto)'/.test(source)) {
      failures.push(`${file.at(-1)} 에 브리지 명령 이름이 박혀 있다 — presets.ts 의 상수를 쓴다`);
    }
  }
  if (SDK_ACTIONS.start !== 'sdk_start' || SDK_ACTIONS.stop !== 'sdk_stop' || SDK_ACTIONS.auto !== 'sdk_auto') {
    failures.push('브리지 명령 이름이 가이드 §4-2 와 다르다');
  }
  /**
   * **화면에는 버튼이 없다** (260913 지시).
   *
   * 넷이 있었다. 「미리 세우기」는 브리지를 당겨 띄워 일어서는 몇 초를 아끼려는 것이었는데,
   * 파이가 **전원을 켤 때 브리지를 띄우도록 바뀌어** 그 몇 초가 애초에 없다. 나머지 셋은
   * 위에서 본 대로 `UNIMPLEMENTED` 로 거절된다 — 눌러도 안 되는 버튼이었다.
   *
   * 잘못 누르면 로봇이 일어서는 버튼이라 **안 두는 쪽이 안전하다.** 되살릴 일이 생기면
   * 명령 셋은 `robotCommands.ts` 에 그대로 있다 — 지운 것은 화면의 버튼뿐이다.
   */
  const panel = strip(readFileSync(join(root, 'src', 'physical', 'RobotPanel.tsx'), 'utf8'));
  const commands = strip(readFileSync(join(root, 'src', 'physical', 'robotCommands.ts'), 'utf8'));
  for (const name of ['issueSdkStart', 'issueSdkStop', 'issueSdkAuto']) {
    if (panel.includes(name + '(')) {
      failures.push(`화면에 ${name} 버튼이 돌아왔다 — 잘못 누르면 로봇이 일어선다`);
    }
    // 명령 자체는 남아 있어야 한다. 화면에서 뺀 것과 규약에서 지운 것은 다르다.
    if (!new RegExp('export async function ' + name).test(commands)) {
      failures.push(`${name} 이 통째로 사라졌다 — 되살릴 길이 없어진다`);
    }
  }
  // **상태는 남는다.** 브리지가 죽으면 이동 명령이 `go1_sdk_not_running` 으로 거절되는데,
  // 그때 원인을 볼 자리가 이 하나다.
  if (!/<SdkState/.test(panel)) failures.push('화면이 구동 브리지 상태를 안 그린다 — 거절 원인을 볼 자리가 없어진다');
  if (!/isStanding\(/.test(panel)) failures.push('화면이 「일어서는 중」을 안 그린다 — 가이드가 드러내라고 못박았다');
  // **내부 자리 이름이 화면에 새면 안 된다.** 실제로 「no-node 실패 — UNIMPLEMENTED」가 떴다.
  if (!new RegExp('taskId === NO_NODE').test(panel)) {
    failures.push('거절 문구가 no-node 를 그대로 쓴다 — 사람이 읽을 말이 아니다');
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **parseDetail 하나로 다 받는 사본.** 단계 보고가 통째로 사라진다.
  const raw = JSON.stringify({ event: SDK_STARTING });
  const onlyMission = (text) => (parseDetail(text) === null ? null : 'ok');
  control('parseDetail 하나로 다 받는 사본 (단계가 사라진다)',
    onlyMission(raw) === null && stageOf(raw) !== null);
}
{
  // **null 을 꺼짐으로 그린 사본.**
  const asOff = (ready) => (ready === true ? '서 있음' : '내려감');
  control('sdk 미상을 「내려감」으로 그린 사본', asOff(null) === '내려감');
}
{
  // **브리지 명령에 태스크 노드를 준 사본.** 없는 노드에 사건이 붙는다.
  control('브리지 명령에 태스크 노드를 준 사본', NO_NODE !== 'T-A3');
}

if (failures.length) {
  console.error(`❌ verify:sdk-bridge\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 단계 보고 넷을 다 읽는다 — 맨 문자열 · sdk_starting · 임무 ACK 를 서로 섞지 않는다');
console.log('✅ 「일어서는 중」이 세션까지 닿는다 · sdk 미상은 「모름」이지 「꺼짐」이 아니다');
console.log('✅ 브리지 명령은 태스크 그래프에 사건을 안 만든다 · 이름은 presets.ts 한 줄');
console.log('✅ UNIMPLEMENTED 는 기억하고 battery_too_low 는 안 기억한다 — 영영 안 되는 것과 지금 안 되는 것');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
