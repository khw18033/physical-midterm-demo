// 목 게이트웨이가 **하나**이고, 그 하나가 탭 여섯을 다 채우는지 검사한다.
//
// 화면만 옮기면 탭②~⑥은 텅 빈 채로 뜬다. 이식에서 가장 놓치기 쉬운 곳이라
// "빌드가 된다"가 아니라 **"데이터가 실제로 온다"**를 본다.
//
// transport 는 싱글턴이고 주소가 하나라 "탭마다 다른 게이트웨이"는 성립하지 않는다.
// 그래서 게이트웨이 하나에 붙어 탭별 채널이 전부 흘러나오는지 세고, 재연결 후에도
// 같은 구독이 복원되는지 본다.
//
// 이 스크립트는 게이트웨이를 **직접 띄웠다가 끈다.** 이미 떠 있는 것에 붙으면
// 남아 있던 프로세스가 다른 버전일 때 조용히 통과한다.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_GATEWAY_PORT ?? 8795);
const URL = `ws://127.0.0.1:${PORT}`;

/** 탭별로 최소 한 건은 와야 하는 채널. 안 오면 그 탭이 빈 화면이라는 뜻이다. */
const TAB_CHANNELS = {
  '② 구역 현황판': ['state'],
  '③ 제어 패널': ['actuator_state', 'control_lock'],
  '④ 지표 조회': ['telemetry'],
  '⑤ 영상 오버레이': ['video_meta'],
  // 탭⑥은 2026-08-31에 제거됐다. 게이트웨이의 /pipelines/* 라우팅은 이식본 그대로
  // 남아 있지만(기준선과의 diff 최소화) 소비하는 화면이 없으므로 검사하지 않는다.
  '① 임무 디버깅': ['trace_event'],
};

const failures = [];
const seen = new Set();

function open() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(URL);
    const timer = setTimeout(() => reject(new Error('연결 시간 초과')), 8000);
    socket.on('open', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

/** 데이터 계층이 실제로 거는 구독과 같은 축으로 건다. */
function subscribe(socket, id, selector) {
  socket.send(JSON.stringify({ type: 'subscribe', id, selector, scope: 'all' }));
}

function collect(socket, ms) {
  return new Promise((resolve) => {
    const subscribed = new Set();
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'subscribed') subscribed.add(message.id);
      if (message.type === 'data' && message.envelope) seen.add(message.envelope.channel);
    });
    setTimeout(() => resolve(subscribed), ms);
  });
}

const server = spawn(process.execPath, ['gateway/server.ts'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, MOCK_PORT: String(PORT), VIZ_SCENARIO_SPEED: '40' },
});

const stop = () => { if (!server.killed) server.kill(); };
process.on('exit', stop);

try {
  // 게이트웨이가 뜰 때까지 기다린다.
  let socket = null;
  for (let attempt = 0; attempt < 20 && socket === null; attempt += 1) {
    try { socket = await open(); } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  if (socket === null) throw new Error(`게이트웨이(${URL})가 뜨지 않았다`);

  // 데이터 계층의 구독 축 + 탭①의 임무 기록 축. **연결은 하나다.**
  subscribe(socket, 'zone', { entity: '*', node: 'zone-503', channel: '*' });
  subscribe(socket, 'trace', { entity: 'MSN-260826-01', node: '*', channel: 'trace_event' });
  const firstSubs = await collect(socket, 4000);
  if (firstSubs.size !== 2) failures.push(`구독 확인이 ${firstSubs.size}건 (2건이어야 한다)`);

  for (const [tab, channels] of Object.entries(TAB_CHANNELS)) {
    for (const channel of channels) {
      if (!seen.has(channel)) failures.push(`${tab} — 채널 '${channel}' 이 한 건도 오지 않았다 (빈 화면이 된다)`);
    }
  }

  // 음성 대조군 — 이 검사가 채널 이름을 실제로 보고 있는가.
  // command_result 는 명령을 내지 않았으므로 와서는 안 되고(캐시 금지 채널이기도 하다),
  // 아무거나 통과시키는 검사라면 이것도 '봤다'로 잡힐 것이다.
  if (seen.has('command_result')) {
    failures.push('명령을 내지 않았는데 command_result 가 왔다 — 캐시 금지(BE-T-06)가 깨졌거나 이 검사가 채널을 안 보고 있다');
  }
  if (seen.size < 4) failures.push(`받은 채널이 ${seen.size}종뿐이다 — 게이트웨이가 절반만 돌고 있다`);

  // 재연결 — 껐다 켜면 구독이 한 번에 복원되어야 한다 (여기서는 다시 걸리는지만 본다).
  socket.close();
  const reconnected = await open();
  seen.clear();
  subscribe(reconnected, 'zone', { entity: '*', node: 'zone-503', channel: '*' });
  const secondSubs = await collect(reconnected, 3000);
  if (secondSubs.size !== 1) failures.push('재연결 후 구독이 복원되지 않았다');
  if (!seen.has('state')) failures.push('재연결 후 구독 즉시 스냅샷(VZ-I-02)이 오지 않았다');
  reconnected.close();
} catch (error) {
  failures.push(String(error?.message ?? error));
} finally {
  stop();
}

// ── 주소가 런타임으로 바뀌어도 출입구는 하나인가 (260904 — `VZ-C-07`) ───────────
//
// `VZ-C-07`(연결 관리)이 **이 검사를 깨뜨리기 제일 쉬운** 변경이었다. 주소가 상수에서
// 런타임 값이 되면 「여기저기서 URL 을 읽는」 길이 열리고, 그 순간 출입구가 갈라진다.
// 위의 채널 검사는 목 게이트웨이만 보므로 그 성질을 못 본다 — 여기서 **실제로 주소를 바꿔**
// 확인한다.
//
//  1. `getTransport()` 는 여전히 **같은 인스턴스**를 돌려준다 (주소를 바꿔도 새로 만들지 않는다)
//  2. 바꾸면 **끊고 새 주소로 다시 붙는다** — 옛 게이트웨이를 죽여도 값이 계속 온다
//  3. 구독은 살아 있다 — 호출자가 다시 구독하지 않는다
//  4. **`new WsTransport(` 는 소스 전체에 하나뿐이다** — 두 번째가 생기면 출입구가 둘이다
{
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { relative } = await import('node:path');

  // 4 — 소스에서 전송을 만드는 곳을 센다.
  const sources = [];
  (function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) sources.push(path);
    }
  })(join(root, 'src'));
  const makers = sources.filter((path) => /new WsTransport\s*\(/.test(readFileSync(path, 'utf8')));
  if (makers.length !== 1 || !makers[0].endsWith(join('src', 'transport', 'index.ts'))) {
    failures.push(`전송을 만드는 곳이 ${makers.length}곳이다 (${makers.map((one) => relative(root, one)).join(', ')}) — 출입구는 transport/index.ts 하나여야 한다`);
  }

  // 1~3 — 실제로 주소를 바꿔 본다. 게이트웨이 둘을 띄우고 A → B 로 옮긴다.
  globalThis.WebSocket = WebSocket;
  const PORT_A = PORT + 1;
  const PORT_B = PORT + 2;
  const spawnGateway = (port) => spawn(process.execPath, ['gateway/server.ts'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, MOCK_PORT: String(port), VIZ_SCENARIO_SPEED: '40' },
  });
  const gatewayA = spawnGateway(PORT_A);
  const gatewayB = spawnGateway(PORT_B);
  const waitFor = (label, predicate, timeout = 15000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error(`${label} 시간 초과`)); }
    }, 50);
  });
  try {
    const { saveConnections } = await import('../src/shared/connections.ts');
    const { getTransport } = await import('../src/transport/index.ts');
    saveConnections({ 'gateway.ws': `ws://127.0.0.1:${PORT_A}`, 'gateway.http': `http://127.0.0.1:${PORT_A}` });

    const transport = getTransport();
    let frames = 0;
    // **열림으로 들어간 횟수.** 「끊고 다시 붙었다」는 이 값이 늘어야만 사실이다 —
    // 주소만 바꿔 두고 옛 연결에 그대로 붙어 있어도 `config.url` 과 상태는 멀쩡해 보인다.
    let opens = 0;
    let previous = transport.getStatus().state;
    transport.onStatus((status) => {
      if (status.state === 'open' && previous !== 'open') opens += 1;
      previous = status.state;
    });
    transport.subscribe({ entity: '*', node: 'zone-503', channel: '*' }, () => { frames += 1; });
    transport.connect();
    await waitFor('A 연결·구독', () => transport.getStatus().state === 'open' && frames > 0);
    const opensAtA = opens;

    // 주소를 B 로 바꾼다. **화면이 하는 일과 같은 호출**이다.
    saveConnections({ 'gateway.ws': `ws://127.0.0.1:${PORT_B}`, 'gateway.http': `http://127.0.0.1:${PORT_B}` });
    // 1 — 같은 인스턴스여야 한다.
    if (getTransport() !== transport) failures.push('주소를 바꿨더니 getTransport() 가 새 인스턴스를 돌려준다 — 그 위에 걸린 구독이 통째로 날아간다');
    // 2 — A 를 죽이지 않은 채로 **끊고 다시 붙어야** 한다. 그냥 두면 옛 연결이 멀쩡해서
    //     아무 일도 일어나지 않는데, 그때도 주소·상태는 정상으로 보인다.
    await waitFor(
      'B 로 끊고 다시 붙기 (A 는 살아 있다)',
      () => opens > opensAtA && transport.getStatus().state === 'open' && transport.config.url.endsWith(String(PORT_B)),
    );

    // 3 — 옛 게이트웨이를 죽여도 값이 계속 온다(= 정말 B 에 붙었다 + 구독이 살아 있다).
    gatewayA.kill();
    await new Promise((resolve) => gatewayA.once('exit', resolve));
    frames = 0;
    await waitFor('B 에서 구독 복원 수신', () => frames > 0);
    console.log(`✅ 주소 교체 — 같은 인스턴스가 ${PORT_A} → ${PORT_B} 로 끊고 다시 붙고(A 를 죽이기 전에), 구독은 다시 걸지 않아도 살아 있다`);

    // 음성 대조군 — 붙지 않는 주소로 바꾸면 반드시 열린 상태를 벗어난다.
    saveConnections({ 'gateway.ws': 'ws://127.0.0.1:1', 'gateway.http': 'http://127.0.0.1:1' });
    await waitFor('대조군 — 없는 주소에서 연결이 끊긴다', () => transport.getStatus().state !== 'open');
    transport.close();
  } catch (error) {
    failures.push(`주소 교체 검사: ${String(error?.message ?? error)}`);
  } finally {
    gatewayA.kill();
    gatewayB.kill();
  }
}

if (failures.length) {
  console.error(`❌ 게이트웨이 하나가 탭 여섯을 못 채운다:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✅ 통과 — 게이트웨이 1개 · 연결 1개로 탭별 채널 ${Object.values(TAB_CHANNELS).flat().join('·')} 수신, 재연결 후 구독·스냅샷 복원, 미발행 채널 대조군 확인`);
console.log('✅ 통과 — 주소가 런타임으로 바뀌어도 전송을 만드는 곳은 하나, 싱글턴 유지, 끊고 다시 붙기·구독 복원 확인');
// 이 검사는 게이트웨이 셋과 소켓 여럿을 띄웠다 잡는다. 붙지 못한 소켓(대조군의 없는 주소)
// 하나라도 남으면 Node 의 이벤트 루프가 안 죽어 `npm run` 이 영원히 매달린다 — 끝났으면 끝낸다.
process.exit(0);
