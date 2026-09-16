// verify:connection-panel (260910 신설 — 연결 관리 통합 지시서 §6)
//
// **연결에 관한 것이 한 화면에 다 있는가.**
//
// 보는 것 넷.
//  1. 확인 대상 넷(`physical`·`detect`·`stt`·`generate`)이 다 올라와 있는가
//  2. **`physical` 이 브로커·단말·로봇을 따로 보이는가** ← 이번 작업의 요점
//  3. 확인 버튼이 **실제 왕복을 돌리는가** — 누른 척만 하지 않는가
//  4. 대상 하나가 죽어도 **그 줄만 빨갛고 나머지는 도는가**
//
// 2번이 핵심이다. 층이 셋이고 셋 다 다르다 — 브로커에 붙는 것, 라즈베리파이의 단말이
// 답하는 것, 로봇 개가 살아 있는 것. 뭉치면 발표 직전에 무엇을 봐야 하는지 못 가른다.
// **ping 은 단말까지만 증명한다** — 로봇 줄은 「모른다」로 남는다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const { CONNECTION_TARGETS } = await load('src', 'shared', 'connections.ts');
const { checkPhysical, checkTarget, checkDetect } = await load('src', 'shared', 'connectionCheck.ts');
const {
  CHECKED_TARGETS, healthOf, targetOk, firstBroken, resetHealth,
} = await load('src', 'shared', 'connectionHealth.ts');
const { BROKER_PRESETS, presetReady } = await load('src', 'physical', 'presets.ts');

const failures = [];
const controls = [];

// ── 1. 확인 대상 넷이 다 올라와 있는가 ───────────────────────────────────────
{
  const ids = CONNECTION_TARGETS.map((t) => t.id);
  for (const target of ['physical', 'detect', 'stt', 'generate']) {
    if (!ids.includes(target)) failures.push(`연결 관리에 ${target} 이 없다`);
    if (!CHECKED_TARGETS.includes(target)) failures.push(`${target} 이 확인 대상 목록에 없다`);
  }
  // 화면이 목록을 그린다 — 손으로 넷을 적으면 대상이 늘 때 한쪽만 는다.
  const panel = readFileSync(join(root, 'src', 'shell', 'ConnectionsPanel.tsx'), 'utf8');
  if (!/CONNECTION_TARGETS\.map/.test(panel)) failures.push('팝업이 목록을 그리지 않는다 — 손으로 적으면 갈라진다');
  for (const row of ['conn-health', 'conn-check']) {
    if (!panel.includes(row)) failures.push(`팝업에 ${row} 줄이 없다 — 네 줄 중 하나가 빠졌다`);
  }
}

// ── 2. physical 이 브로커·단말·로봇을 따로 보인다 (요점) ────────────────────
//
// 260910 에 줄을 둘에서 **셋**으로 늘렸다. 로봇을 꺼 놓고 눌렀는데 「로봇 ✓」가 떠서
// uplink 를 떠 보니 답한 것은 라즈베리파이의 **단말 에이전트**였다 — ping 의 결과가
// `{ uptime_s }` 이고 그건 단말의 가동 시간이다.
//
// **ping 은 단말까지만 증명한다.** 로봇 줄은 초록도 빨강도 아닌 「모른다」다.
{
  const both = await checkPhysical({
    getStatus: () => ({ state: 'open' }),
    connect: async () => ({ state: 'open' }),
    ping: async () => ({ ok: true, roundTripMs: 12, message: '로봇이 답했습니다' }),
  });
  if (both.length !== 3) failures.push(`physical 이 줄을 ${both.length}개 낸다 — 브로커·단말·로봇 셋이어야 한다`);
  if (both.find((l) => l.id === 'broker')?.ok !== true) failures.push('브로커가 붙었는데 초록이 아니다');
  if (both.find((l) => l.id === 'agent')?.ok !== true) failures.push('단말이 답했는데 초록이 아니다');
  if (both.find((l) => l.id === 'agent')?.roundTripMs !== 12) failures.push('왕복 시간이 안 실린다');
  // **장비 상태가 없으면 로봇은 모른다.** 단말이 답했다고 초록으로 칠하지 않는다.
  const robotLine = both.find((l) => l.id === 'robot');
  if (robotLine?.ok !== null) failures.push(`장비 상태가 없는데 로봇 줄이 ${robotLine?.ok} — 「모른다(null)」여야 한다`);

  // **장비 상태가 오면 로봇 줄이 채워진다** (260910 — link 가 그 답이다).
  const facts = (over = {}) => ({ online: true, link: 'ok', health: 'ok', batteryPct: 55, stale: false, staleSec: 0, ...over });
  const alive = await checkPhysical({
    getStatus: () => ({ state: 'open' }), connect: async () => ({ state: 'open' }),
    ping: async () => ({ ok: true, roundTripMs: 5, message: 'ok' }),
  }, facts());
  if (alive.find((l) => l.id === 'robot')?.ok !== true) failures.push('link 가 ok 인데 로봇 줄이 초록이 아니다');

  // 내부 링크가 끊기면 **빨갛다** — 파이는 붙어 있는데 로봇이 아니다.
  const linkDown = await checkPhysical({
    getStatus: () => ({ state: 'open' }), connect: async () => ({ state: 'open' }),
    ping: async () => ({ ok: true, roundTripMs: 5, message: 'ok' }),
  }, facts({ link: 'down' }));
  if (linkDown.find((l) => l.id === 'robot')?.ok !== false) failures.push('내부 링크가 끊겼는데 로봇 줄이 빨갛지 않다');
  if (linkDown.find((l) => l.id === 'agent')?.ok !== true) failures.push('로봇 링크가 끊겼다고 단말까지 빨개졌다');

  // 파이가 오프라인으로 보면 빨갛다.
  const offline = await checkPhysical({
    getStatus: () => ({ state: 'open' }), connect: async () => ({ state: 'open' }),
    ping: async () => ({ ok: true, roundTripMs: 5, message: 'ok' }),
  }, facts({ online: false }));
  if (offline.find((l) => l.id === 'robot')?.ok !== false) failures.push('오프라인인데 로봇 줄이 빨갛지 않다');

  // **낡은 값은 현재가 아니다** — 마지막 값을 초록으로 그리면 안 된다.
  const old = await checkPhysical({
    getStatus: () => ({ state: 'open' }), connect: async () => ({ state: 'open' }),
    ping: async () => ({ ok: true, roundTripMs: 5, message: 'ok' }),
  }, facts({ stale: true, staleSec: 40 }));
  if (old.find((l) => l.id === 'robot')?.ok !== null) failures.push('40초째 소식이 없는데 현재처럼 그린다');
  if (!/소식이 없습니다/.test(String(old.find((l) => l.id === 'robot')?.reason))) failures.push('낡았다는 사실을 안 적었다');

  // **단말이 안 답하면 단말 줄이 빨갛다** — 브로커는 그대로 초록이다.
  const agentDead = await checkPhysical({
    getStatus: () => ({ state: 'open' }),
    connect: async () => ({ state: 'open' }),
    ping: async () => ({ ok: false, roundTripMs: null, message: '로봇이 4000ms 안에 답하지 않았습니다' }),
  });
  if (agentDead.find((l) => l.id === 'broker')?.ok !== true) failures.push('단말이 죽었다고 브로커까지 빨개졌다');
  if (agentDead.find((l) => l.id === 'agent')?.ok !== false) failures.push('단말이 안 답했는데 초록이다');
  if (!/답하지 않았습니다/.test(String(agentDead.find((l) => l.id === 'agent')?.reason))) {
    failures.push('단말 실패 사유를 버렸다');
  }

  // 브로커가 안 붙으면 아래 둘은 **못 물어본 것**이다 — 실패가 아니다.
  const brokerDead = await checkPhysical({
    getStatus: () => ({ state: 'closed', reason: '주소를 못 찾습니다' }),
    connect: async () => ({ state: 'closed', reason: '주소를 못 찾습니다' }),
    ping: async () => { throw new Error('여기까지 오면 안 된다'); },
  });
  if (brokerDead.find((l) => l.id === 'broker')?.ok !== false) failures.push('브로커가 죽었는데 초록이다');
  if (!/주소를 못 찾습니다/.test(String(brokerDead.find((l) => l.id === 'broker')?.reason))) {
    failures.push('브로커 실패 사유를 버렸다 — 주소 문제인지 알 수 없어진다');
  }
  if (brokerDead.find((l) => l.id === 'agent')?.ok !== null) failures.push('브로커가 없을 때 단말이 「모른다」가 아니다');
  if (!/물어보지 못했습니다/.test(String(brokerDead.find((l) => l.id === 'agent')?.reason))) {
    failures.push('브로커가 없을 때 단말 줄이 「못 물어봤다」고 말하지 않는다');
  }

  // 대상 전체 판정 — **모르는 줄이 있으면 초록이라고 말하지 않는다.**
  resetHealth();
  const { setHealth } = await load('src', 'shared', 'connectionHealth.ts');
  setHealth('physical', both);
  if (targetOk('physical') !== null) {
    failures.push('로봇을 모르는데 physical 이 초록이다 — 확인된 것만 초록이어야 한다');
  }
  setHealth('physical', agentDead);
  if (targetOk('physical') !== false) failures.push('단말이 죽었는데 physical 이 빨갛지 않다');
}

// ── 3. 확인 버튼이 실제 왕복을 돌린다 ────────────────────────────────────────
{
  resetHealth();
  let pinged = 0;
  await checkTarget('physical', {
    getStatus: () => ({ state: 'open' }),
    connect: async () => ({ state: 'open' }),
    ping: async () => { pinged += 1; return { ok: true, roundTripMs: 8, message: 'ok' }; },
  });
  if (pinged !== 1) failures.push(`확인 버튼이 왕복을 ${pinged}번 돌렸다 — 한 번이어야 한다`);
  if (healthOf('physical').lines.length !== 3) failures.push('확인 뒤 줄 셋이 안 적혔다');
  if (healthOf('physical').checking) failures.push('확인이 끝났는데 「확인 중」이 안 풀렸다');

  // **던지지 않는다** — 여기서 예외가 새면 팝업이 통째로 날아간다.
  resetHealth();
  await checkTarget('physical', {
    getStatus: () => ({ state: 'open' }),
    connect: async () => ({ state: 'open' }),
    ping: async () => { throw new Error('소켓이 죽었다'); },
  });
  const lines = healthOf('physical').lines;
  if (lines.length === 0) failures.push('확인이 던져서 결과가 아예 안 남았다');
  if (!lines.some((l) => /소켓이 죽었다/.test(String(l.reason)))) failures.push('예외 사유가 안 남았다');
}

// ── 4. detect — 상대가 없으면 「모름」이다 (260912) ──────────────────────────
//
// 확인이 실제로 이어졌다. 그래도 **주소도 없고 테스트도 안 켰으면 빨강이 아니다** —
// 빨강은 「붙어야 하는데 못 붙었다」이고 지금은 붙을 상대가 없는 것이다. 여기서 빨갛게
// 칠하면 무대에 오르기 전 점검에서 「넷 다 초록」이 애초에 불가능해진다.
{
  // 260914 — 기본 주소(Tailscale)가 생겼으므로 「주소 없음」을 명시적으로 만든다.
  // 기본값 그대로 두면 실제 테일넷에 요청이 나가 결과가 데스크톱 전원에 따라 갈린다.
  const { connectionAddress, registerConnectionDefault } = await load('src', 'shared', 'connections.ts');
  const seededDetect = connectionAddress('detect', 'base');
  registerConnectionDefault('detect', 'base', '');
  const detect = await checkDetect();
  registerConnectionDefault('detect', 'base', seededDetect);
  if (detect.length === 0) failures.push('detect 줄이 아예 없다 — 자리는 있어야 한다');
  if (detect[0]?.ok !== null) {
    failures.push(`주소도 테스트도 없는데 detect 가 ${detect[0]?.ok} 다 — 「모름」이어야 한다`);
  }
  // 「테스트」로 먼저 볼 수 있다는 것을 알려 준다 — 그러라고 만든 자리다.
  if (!/테스트/.test(String(detect[0]?.reason))) {
    failures.push('상대가 없을 때 무엇을 할 수 있는지 안 알려 준다');
  }
  // 화면에 그 체크박스가 실제로 있는가.
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(join(root, 'src', 'shell', 'ConnectionsPanel.tsx'), 'utf8');
  if (!/conn-test/.test(panel) || !/setTestMode\(/.test(panel)) {
    failures.push('연결 관리에 탐지 「테스트」 체크박스가 없다');
  }
}

// ── 5. 한 대상이 죽어도 나머지는 돈다 ────────────────────────────────────────
{
  resetHealth();
  const { setHealth, line } = await load('src', 'shared', 'connectionHealth.ts');
  setHealth('physical', [line('broker', '브로커', false, { reason: '끊김' })]);
  setHealth('stt', [line('probe', '서비스', true, { roundTripMs: 5 })]);
  if (targetOk('stt') !== true) failures.push('physical 이 죽었다고 stt 까지 빨개졌다');

  const broken = firstBroken(CHECKED_TARGETS);
  if (broken?.target !== 'physical') failures.push('끊긴 대상을 못 짚는다 — 표시등이 무엇이 끊겼는지 말해야 한다');
  if (!String(broken?.line.label ?? '').trim()) failures.push('끊긴 줄의 이름이 없다');
}

// ── 6. physical 프리셋 ───────────────────────────────────────────────────────
//
// 네 자리(기본·같은 랜·발표장·직접 입력)가 다 있어야 한다. 260913 에 Tailscale 이 하나 더
// 붙어 다섯이 됐다 — 수를 못박는 대신 **있어야 하는 것이 있는지**를 본다.
{
  if (BROKER_PRESETS.length < 4) failures.push(`프리셋이 ${BROKER_PRESETS.length}개 — 넷 이상이어야 한다`);
  for (const id of ['tailscale', 'name', 'venue', 'manual']) {
    if (!BROKER_PRESETS.some((p) => p.id === id)) failures.push(`프리셋 ${id} 가 없다`);
  }
  /**
   * **기본 주소와 프리셋이 갈리면 안 된다** (260913 지시 — 기본을 Tailscale 로 옮겼다).
   *
   * 화면이 처음 뜰 때의 주소와 목록에서 고를 수 있는 주소가 다르면, 고르는 칸이
   * 「직접 입력」으로 떠 있는데 실제로는 프리셋과 같은 값인 상태가 된다.
   */
  const { connectionAddress } = await load('src', 'shared', 'connections.ts');
  await load('src', 'physical', 'PhysicalClient.ts');          // 기본값을 심는 자리
  const seeded = connectionAddress('physical', 'ws');
  const tail = BROKER_PRESETS.find((p) => p.id === 'tailscale');
  if (tail !== undefined && seeded !== tail.url) {
    failures.push(`기본 주소가 ${seeded} — Tailscale 프리셋(${tail.url})과 같아야 한다`);
  }
  if (tail !== undefined && !/\.ts\.net/.test(tail.url)) failures.push('Tailscale 프리셋이 ts.net 주소가 아니다');

  const venue = BROKER_PRESETS.find((p) => p.id === 'venue');
  if (venue === undefined) failures.push('발표장 핫스팟 프리셋이 없다');
  // **비어 있어야 한다** — 정적 IP 를 받으면 채운다. 지어내 넣지 않는다.
  if (venue !== undefined && venue.url.trim() !== '') failures.push(`발표장 주소가 채워져 있다 — ${venue.url}`);
  if (venue !== undefined && presetReady(venue)) failures.push('값이 빈 프리셋을 고를 수 있다');
  const panel = readFileSync(join(root, 'src', 'shell', 'ConnectionsPanel.tsx'), 'utf8');
  if (!/BROKER_PRESETS/.test(panel)) failures.push('연결 관리가 프리셋을 안 그린다');
}

// ── 7. detect 프리셋 (260914) ────────────────────────────────────────────────
//
// 로봇과 같은 모양으로 네트워크 환경을 고른다. 탐지는 시연장 밖 데스크톱에서 돌므로
// **기본값이 Tailscale 이고, 처음 뜰 때의 주소와 그 프리셋이 같아야 한다** — 갈리면 고르는
// 칸이 「직접 입력」으로 떠 있는데 값은 프리셋과 같은 상태가 된다(6절과 같은 이유).
{
  const { DETECT_PRESETS, detectPresetReady } = await load('src', 'detect', 'presets.ts');
  for (const id of ['tailscale', 'manual']) {
    if (!DETECT_PRESETS.some((p) => p.id === id)) failures.push(`탐지 프리셋 ${id} 가 없다`);
  }
  const { connectionAddress } = await load('src', 'shared', 'connections.ts');
  await load('src', 'detect', 'DetectClient.ts');            // 기본값을 심는 자리
  const seeded = connectionAddress('detect', 'base');
  const tail = DETECT_PRESETS.find((p) => p.id === 'tailscale');
  if (tail !== undefined && seeded !== tail.url) {
    failures.push(`탐지 기본 주소가 ${seeded || '(빈 값)'} — Tailscale 프리셋(${tail.url})과 같아야 한다`);
  }
  if (tail !== undefined && !/\.ts\.net/.test(tail.url)) failures.push('탐지 Tailscale 프리셋이 ts.net 주소가 아니다');
  if (DETECT_PRESETS.some((p) => p.id !== 'manual' && !detectPresetReady(p))) {
    failures.push('값이 빈 탐지 프리셋을 고를 수 있다');
  }
  const panel = readFileSync(join(root, 'src', 'shell', 'ConnectionsPanel.tsx'), 'utf8');
  if (!/DETECT_PRESETS/.test(panel)) failures.push('연결 관리가 탐지 프리셋을 안 그린다');
  // 주소 문자열은 탐지 경계 안에만 — 화면이 손으로 적으면 두 곳이 갈라진다.
  if (/ts\.net:8000|:8000/.test(panel)) failures.push('연결 관리가 탐지 주소를 손으로 적었다 — src/detect/presets.ts 에서 읽어야 한다');
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // 브로커와 로봇을 한 줄로 뭉친 사본 — 로봇이 죽으면 브로커까지 빨개진다.
  const merged = (brokerOk, robotOk) => [{ id: 'both', ok: brokerOk && robotOk }];
  const ours = await checkPhysical({
    getStatus: () => ({ state: 'open' }),
    connect: async () => ({ state: 'open' }),
    ping: async () => ({ ok: false, roundTripMs: null, message: 'dead' }),
  });
  control(
    '브로커와 로봇을 한 줄로 뭉친 사본',
    merged(true, false)[0].ok === false && ours.find((l) => l.id === 'broker').ok === true,
  );
}
{
  resetHealth();
  control('안 눌러 본 대상은 「모른다」 (빨강이 아니다)', targetOk('physical') === null);
}

resetHealth();

if (failures.length) {
  console.error(`❌ verify:connection-panel\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ 확인 대상 넷이 다 올라와 있다 — ${CHECKED_TARGETS.join(' · ')} (팝업이 목록을 그린다)`);
console.log('✅ physical 이 브로커·단말·로봇 셋을 따로 보인다 — 로봇 줄은 장비 상태의 link 가 채운다');
console.log('✅ 링크가 끊기면 로봇만 빨갛고 단말은 초록 · 낡은 값은 현재로 안 그린다');
console.log('✅ 브로커가 없으면 아래 둘은 「못 물어봤다」 · 모르는 줄이 있으면 초록이라고 말하지 않는다');
console.log('✅ 확인 버튼이 실제 왕복을 한 번 돌린다 · 던져도 사유가 남는다 (팝업이 안 날아간다)');
console.log('✅ detect 는 상대가 없으면 모름 — 2단계-B 에서 잇는다 · 한 대상이 죽어도 나머지는 돈다');
console.log('✅ 프리셋 넷 · 발표장 핫스팟은 빈 채로 고를 수 없다');
console.log('✅ 탐지도 네트워크 환경을 고른다 — 기본 주소가 Tailscale 프리셋과 같고, 주소는 src/detect/ 에만 있다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
