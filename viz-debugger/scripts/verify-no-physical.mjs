// verify:no-physical (260910 신설 — 하드웨어 연동 지시서 §7)
//
// **브로커가 없어도 화면이 뜨고 대본 재생·되감기·캔버스가 도는가.**
//
// `verify:no-stt` · `verify:no-llm` 과 같은 검사다. 로봇은 시연 당일에도 안 켜져 있을 수
// 있고(`robot_state_dead` 가 실제로 나온 응답이다), 그때 화면 전체가 죽으면 발표가 끝난다.
// 로봇 명령만 꺼지고 나머지는 그대로 돌아야 한다.
//
// 보는 것 넷.
//  1. 브로커가 없을 때 `connect()` 가 **던지지 않고** 닫힌 상태를 돌려주는가 — 사유와 함께.
//     사유를 버리면 「브로커가 없다」와 「주소가 틀렸다」가 화면에서 같은 문장이 된다.
//  2. 붙지 않은 채로 `send()` 하면 **조용히 삼키지 않고** 안 보냈다고 말하는가.
//  3. 뷰포인트 채우기가 로봇 없이도 도는가 — 대본 경로가 살아 있다는 뜻이다.
//  4. mqtt 를 **정적으로 import 하지 않는가** — 단독 빌드에 브로커 라이브러리가 딸려 들어가면
//     로봇을 안 쓰는 빌드까지 무거워진다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const failures = [];
const controls = [];

// ── 1. 브로커가 없을 때 connect() ────────────────────────────────────────────
//
// **주소를 여기서 못 붙을 곳으로 박는다.** 기본값(`ws://pi7.local:9001`)을 그대로 쓰면
// 랩 망에서 검사를 돌릴 때 진짜 브로커에 붙어 버려서 「브로커가 없을 때」라는 전제가
// 깨진다 — 260910 에 실제로 그랬다. 검사가 환경에 기대면 안 된다.
{
  const { saveConnections, connectionKey } = await load('src', 'shared', 'connections.ts');
  // 127.0.0.1:1 — 아무도 안 듣는 포트다.
  saveConnections({ [connectionKey('physical', 'ws')]: 'ws://127.0.0.1:1' });

  const { PhysicalClient } = await load('src', 'physical', 'PhysicalClient.ts');
  const client = new PhysicalClient();
  let status;
  try {
    // 붙을 곳이 없는 주소다. 여기서 예외가 새면 화면 첫 렌더가 통째로 날아간다.
    status = await client.connect(2000);
  } catch (error) {
    failures.push(`connect() 가 던졌다 — ${error instanceof Error ? error.message : error}`);
    status = null;
  }
  if (status !== null) {
    if (status.state === 'open') {
      failures.push('브로커가 없는데 open 이라고 한다');
    } else if (status.state === 'closed' && !String(status.reason ?? '').trim()) {
      failures.push('닫혔는데 사유가 비었다 — 「없다」와 「주소가 틀렸다」가 같은 문장이 된다');
    }
  }

  // ── 2. 안 붙은 채로 보내면 안 보냈다고 말하는가 ───────────────────────────
  const sent = client.send('ping');
  if (sent.sent !== false) failures.push('브로커에 안 붙었는데 보냈다고 한다');
  if (!String(sent.reason ?? '').trim()) failures.push('안 보낸 사유가 비었다 — 조용히 삼키면 무대에서 원인을 못 찾는다');
  if (!String(sent.commandId ?? '').trim()) failures.push('안 보내도 command_id 는 있어야 한다 — 기록이 남는다');
  client.disconnect();

  // 주소를 원래대로 — 뒤 검사가 이 값을 물려받으면 안 된다.
  saveConnections({});
}

// ── 3. 로봇 없이 뷰포인트가 도는가 (대본 경로) ───────────────────────────────
{
  const { emptyFill, reduceFrames, cellsInOrder } = await load('src', 'viewpoint', 'fill.ts');
  const { scriptFrames } = await load('src', 'viewpoint', 'source.ts');
  const door = JSON.parse(readFileSync(join(root, 'scenarios', 'MSN-260909-01.json'), 'utf8'));
  const fill = reduceFrames(emptyFill(8), scriptFrames(door.viewpointTimeline, door.durationSec));
  const selected = cellsInOrder(fill).filter((c) => c.phase === 'selected').length;
  const rejected = cellsInOrder(fill).filter((c) => c.phase === 'rejected').length;
  if (selected !== 1 || rejected !== 7) {
    failures.push(`로봇 없이 돌린 대본이 선정 ${selected} · 미선정 ${rejected} — 1 과 7 이어야 한다`);
  }
}

// ── 4. mqtt 를 정적으로 import 하지 않는가 ───────────────────────────────────
{
  const source = readFileSync(join(root, 'src', 'physical', 'PhysicalClient.ts'), 'utf8');
  if (/^\s*import\s+[^\n]*from\s+['"]mqtt['"]/m.test(source)) {
    failures.push('mqtt 를 정적으로 import 한다 — 로봇을 안 쓰는 빌드까지 무거워진다');
  }
  if (!/await import\(['"]mqtt['"]\)/.test(source)) {
    failures.push('mqtt 를 동적으로 부르지 않는다 — 검사가 헛돈다');
  }
}

// ── 5. mqtt 모듈의 두 모양을 다 받는가 (260910 — 실제로 났던 실패) ──────────
//
// **Node 검사는 통과했는데 브라우저에서만 안 붙었다.** 원인은 mqtt 빌드가 둘이라는 것이다:
//   Node    build/index.js      CJS interop → 네임스페이스에 connect 가 붙는다
//   브라우저 dist/mqtt.esm.js    `export default` 하나뿐 → 네임스페이스에 connect 가 없다
//
// 그래서 `mod.connect(...)` 가 브라우저에서만 「is not a function」으로 죽었다.
// 이 검사는 두 모양을 **직접 넣어 본다** — Node 에서 도는 검사로 브라우저 모양까지 본다.
{
  const { resolveConnect } = await load('src', 'physical', 'PhysicalClient.ts');
  const fn = () => 'connected';

  // Node 모양 — 네임스페이스에 connect 가 있다.
  try {
    if (resolveConnect({ connect: fn }) !== fn) failures.push('Node 모양에서 connect 를 못 꺼낸다');
  } catch (error) {
    failures.push(`Node 모양에서 던졌다 — ${error instanceof Error ? error.message : error}`);
  }

  // **브라우저 모양** — default 안에만 있다. 이게 실제로 났던 실패다.
  try {
    if (resolveConnect({ default: { connect: fn } }) !== fn) {
      failures.push('브라우저 모양(default 안)에서 connect 를 못 꺼낸다 — 화면에서만 안 붙는다');
    }
  } catch (error) {
    failures.push(`브라우저 모양에서 던졌다 — ${error instanceof Error ? error.message : error}`);
  }

  // 둘 다 아니면 **그 사실을 말한다.** 조용히 undefined 를 부르면 남의 말로 실패한다.
  let said = false;
  try {
    resolveConnect({ nothing: true });
  } catch (error) {
    said = /connect 를 못 찾았습니다/.test(String(error instanceof Error ? error.message : error));
  }
  if (!said) failures.push('connect 가 없는 모듈인데 그 사실을 말하지 않는다');

  // 실제 설치된 브라우저 빌드가 정말 default 하나뿐인지 — 가정이 낡으면 여기서 걸린다.
  const esm = readFileSync(join(root, 'node_modules', 'mqtt', 'dist', 'mqtt.esm.js'), 'utf8');
  const tail = esm.slice(-800);
  if (!/export default/.test(tail)) {
    failures.push('브라우저용 mqtt 빌드에 default export 가 없다 — 가정이 바뀌었다');
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  const bad = "import mqtt from 'mqtt';";
  control('정적 mqtt import 사본', /^\s*import\s+[^\n]*from\s+['"]mqtt['"]/m.test(bad));
}
{
  // 사유를 지운 사본이 잡히는가.
  const empty = { state: 'closed', reason: '' };
  control('닫힘 사유를 지운 사본', empty.state === 'closed' && !String(empty.reason).trim());
}

if (failures.length) {
  console.error(`❌ verify:no-physical\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 브로커가 없어도 connect() 가 던지지 않고 사유와 함께 닫힌 상태를 돌려준다');
console.log('✅ 안 붙은 채로 보내면 안 보냈다고 말한다 (조용히 삼키지 않는다) · command_id 는 남는다');
console.log('✅ 로봇 없이도 대본 뷰포인트가 돈다 — 선정 1 · 미선정 7');
console.log('✅ mqtt 는 동적 import — 단독 빌드에 브로커 라이브러리가 딸려 들어가지 않는다');
console.log('✅ mqtt 모듈의 두 모양(Node 네임스페이스 · 브라우저 default)을 다 받는다 — 못 찾으면 그 사실을 말한다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
