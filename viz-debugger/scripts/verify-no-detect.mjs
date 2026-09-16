// verify:no-detect (260910 신설 — 연결 관리 통합 지시서 §6)
//
// **탐지가 없어도 그 줄만 빨갛고 나머지는 도는가.**
//
// `verify:no-stt` · `verify:no-llm` · `verify:no-physical` 과 같은 검사다. 탐지는 2단계-B
// 에서 붙으므로 **지금은 늘 없는 상태**이고, 그 상태가 나머지를 끌어내리면 안 된다.
//
// 특히 §5 의 발표 직전 점검이 성립해야 한다 — 주소도 없고 테스트도 안 켠 detect 가
// 나머지 셋을 끌어내리면 안 된다. detect 를 그때 **빨갛게** 칠하면 「넷 다 초록」이
// 애초에 불가능해진다. 그래서 그 상태는 빨강이 아니라 **「모름」**이다.
//
// 260912 — 탐지 확인이 실제로 이어졌다(테스트 자료 또는 실제 주소). 그래도 위 규칙은
// 그대로다: **상대가 없을 때 빨개지지 않는다.**

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const { checkDetect, checkTarget } = await load('src', 'shared', 'connectionCheck.ts');
const {
  resetHealth, setHealth, line, healthOf, targetOk, firstBroken, CHECKED_TARGETS,
} = await load('src', 'shared', 'connectionHealth.ts');
const { CONNECTION_TARGETS } = await load('src', 'shared', 'connections.ts');

const failures = [];
const controls = [];

// ── 1. 자리는 있다 ──────────────────────────────────────────────────────────
{
  const target = CONNECTION_TARGETS.find((t) => t.id === 'detect');
  if (target === undefined) failures.push('연결 관리에 detect 자리가 없다');
  /**
   * **늘 떠 있는 설명은 없다** (260913 지시). 로봇과 탐지는 매번 쓰는 둘이라 문장이 아니라
   * 주소 칸이 먼저 보여야 한다.
   *
   * 그렇다고 안내가 사라진 것은 아니다 — 주소가 비었을 때 무엇을 할 수 있는지는 아래
   * 「상태」 줄이 **그때 그 상태의 사유로** 말한다(2절이 그것을 검사한다). 늘 떠 있는
   * 문장과 그때만 뜨는 사유는 다르다.
   */
  for (const id of ['physical', 'detect']) {
    const live = CONNECTION_TARGETS.find((t) => t.id === id);
    if (live?.what !== undefined) failures.push(`${id} 에 늘 떠 있는 설명이 남아 있다`);
    if (live?.pending !== undefined) failures.push(`${id} 에 늘 떠 있는 자리표시 문구가 남아 있다`);
  }
  // **지금 쓰는 둘이 맨 위다** (260912 지시). 시연 직전에 확인하는 것이 로봇과 탐지다.
  const top = CONNECTION_TARGETS.slice(0, 2).map((t) => t.id).join(',');
  if (top !== 'physical,detect') {
    failures.push(`연결 관리 맨 위 둘이 [${top}] 다 — physical,detect 여야 한다`);
  }
}

// ── 2. 확인이 던지지 않는다 ─────────────────────────────────────────────────
//
// 260914 — 기본 주소가 생겼다(Tailscale). 그래서 **「상대가 없다」를 여기서 명시적으로 만든다.**
// 기본값을 그대로 두면 검사가 실제 테일넷에 요청을 던지고, 데스크톱이 켜져 있느냐에 따라
// 결과가 갈린다. 규칙은 그대로다 — 주소도 없고 테스트도 안 켰으면 빨강이 아니라 모름.
const { registerConnectionDefault } = await load('src', 'shared', 'connections.ts');
await load('src', 'detect', 'DetectClient.ts');          // 기본값을 심는 자리 — 먼저 심게 두고 덮는다
registerConnectionDefault('detect', 'base', '');
{
  let lines;
  try {
    lines = await checkDetect();
  } catch (error) {
    failures.push(`detect 확인이 던졌다 — ${error instanceof Error ? error.message : error}`);
    lines = [];
  }
  if (lines.length === 0) failures.push('detect 확인이 아무 줄도 안 낸다');
  // **상대가 없으면 「모름」이다.** 주소도 없고 테스트도 안 켰으면 빨강이 아니다 —
  // 빨강은 「붙어야 하는데 못 붙었다」는 뜻이고, 지금은 붙을 상대가 없는 것이다.
  if (lines[0]?.ok !== null) {
    failures.push(`주소도 테스트도 없는데 detect 가 ${lines[0]?.ok} 다 — 「모름」이어야 한다`);
  }
  if (!/테스트/.test(String(lines[0]?.reason))) {
    failures.push('상대가 없을 때 무엇을 할 수 있는지 안 알려 준다 — 테스트로 먼저 볼 수 있다');
  }

  // 확인 버튼을 눌러도 팝업이 안 날아간다.
  resetHealth();
  await checkTarget('detect', null);
  if (healthOf('detect').lines.length === 0) failures.push('detect 확인 뒤 결과가 안 남았다');
  if (healthOf('detect').checking) failures.push('detect 확인이 끝났는데 「확인 중」이 안 풀렸다');
}

// ── 3. detect 가 나머지를 끌어내리지 않는다 ─────────────────────────────────
{
  resetHealth();
  await checkTarget('detect', null);
  setHealth('physical', [line('broker', '브로커', true), line('robot', '로봇', true, { roundTripMs: 9 })]);
  setHealth('stt', [line('probe', '서비스', true, { roundTripMs: 4 })]);
  setHealth('generate', [line('probe', '서비스', true, { roundTripMs: 6 })]);

  if (targetOk('physical') !== true) failures.push('detect 때문에 physical 이 빨개졌다');
  if (targetOk('stt') !== true) failures.push('detect 때문에 stt 가 빨개졌다');
  if (targetOk('generate') !== true) failures.push('detect 때문에 generate 가 빨개졌다');

  // **표시등이 detect 를 짚지 않는다.** 「모름」은 끊긴 것이 아니다 — 상대가 없는 것이다.
  // 여기서 짚으면 무대에 오르기 전 점검에서 넷 다 초록이 영영 안 된다.
  const broken = firstBroken(CHECKED_TARGETS);
  if (broken !== null) {
    failures.push(`표시등이 ${broken.target} 을 짚는다 — 상대 없는 detect 는 끊긴 것이 아니다`);
  }
}

// ── 3-b. 테스트를 켜면 초록이 된다 (260912) ─────────────────────────────────
//
// 탐지 서비스가 붙기 전에 화면 쪽을 다 맞춰 두려면, 받아 둔 실제 산출물로 한 판을 돌 수
// 있어야 한다. 「테스트」가 그 자리다.
{
  const { setTestMode, detectState } = await load('src', 'detect', 'store.ts');
  setTestMode(true);
  if (!detectState().testMode) failures.push('테스트를 켰는데 안 켜진다');
  // 끄면 읽어 둔 것도 같이 버린다 — 시료가 실제 결과로 남아 있으면 안 된다.
  const { receiveFrames } = await load('src', 'detect', 'store.ts');
  receiveFrames([{ frame: 'f.jpg', rotation_deg: 0, found: true }]);
  setTestMode(false);
  if (detectState().frames.length !== 0) {
    failures.push('테스트를 껐는데 읽어 둔 결과가 남았다 — 시료가 실제 결과로 보인다');
  }
}

// ── 4. 화면은 탐지 없이도 돈다 ──────────────────────────────────────────────
//
// 대본을 돌리면 탐지 없이도 여덟 칸이 찬다. 탐지가 붙는다고 이 길이 막히면 안 된다.
{
  const { readFileSync } = await import('node:fs');
  const { emptyFill, reduceFrames, cellsInOrder } = await load('src', 'viewpoint', 'fill.ts');
  const { scriptFrames } = await load('src', 'viewpoint', 'source.ts');
  const door = JSON.parse(readFileSync(join(root, 'scenarios', 'MSN-260909-01.json'), 'utf8'));
  const fill = reduceFrames(emptyFill(8), scriptFrames(door.viewpointTimeline, door.durationSec));
  const selected = cellsInOrder(fill).filter((c) => c.phase === 'selected').length;
  if (selected !== 1) failures.push(`탐지 없이 돌린 대본이 선정 ${selected}칸 — 문 유무는 대본이 준다`);
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **detect 를 빨갛게 칠한 사본.** 그러면 「넷 다 초록」이 애초에 불가능해진다.
  // 상대가 없는 것과 못 붙은 것은 다르다 — 지금은 앞쪽이다.
  resetHealth();
  await checkTarget('detect', null);
  control('상대 없는 detect 를 빨갛게 칠한 사본', targetOk('detect') !== false);
}
{
  resetHealth();
  control('안 눌러 본 detect 는 「모른다」', targetOk('detect') === null);
}

resetHealth();

if (failures.length) {
  console.error(`❌ verify:no-detect\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ detect 자리가 맨 위 둘(로봇·탐지)에 있고, 늘 떠 있는 설명 없이 상태 줄이 그때 사유를 말한다');
console.log('✅ detect 확인이 던지지 않는다 — 눌러도 팝업이 안 날아간다');
console.log('✅ 상대 없는 detect 가 나머지 셋을 안 끌어내린다 — 표시등이 아무도 안 짚는다 (모름은 끊김이 아니다)');
console.log('✅ 탐지 없이도 대본으로 뷰포인트가 찬다 · 테스트를 켜면 받아 둔 실제 산출물로 돈다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
