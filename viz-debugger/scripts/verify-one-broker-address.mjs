// verify:one-broker-address (260910 신설 — 연결 관리 통합 지시서 §6)
//
// **브로커 주소를 갖는 상태가 하나뿐인가. 시연 화면이 따로 들고 있지 않은가.**
//
// 앞 작업(`작업프롬프트_화면연결_260910.md` §1)이 시연 화면에 프리셋 UI 와 주소 칸을
// 뒀다. 그 전제가 틀렸다 — 연결 관리는 팝업이라 탭을 떠나는 게 아니고, 시연 세팅은 무대에
// 오르기 전에 끝난다. **연결에 관한 것이 두 군데 있으면 「어느 쪽이 진짜냐」가 생긴다.**
//
// 이 검사는 그 둘째 자리가 다시 생기는 것을 막는다.
//
// 보는 것 넷.
//  1. 주소를 **바꾸는** 코드가 연결 관리 밖에 없는가
//  2. 시연 화면(`RobotPanel`)에 주소 칸·프리셋·확인 버튼이 없는가
//  3. 주소의 원천이 여전히 하나인가 (`connections.ts` 저장소)
//  4. **긴급 정지는 시연 화면에 그대로 있는가** — 연결 기능이 아니라 안전 기능이다

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const srcDir = join(root, 'src');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const failures = [];
const controls = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** 주소를 **바꾸는** 것이 허용된 자리. 설정은 연결 관리 하나다. */
const MAY_WRITE = [
  join('src', 'shell', 'ConnectionsPanel.tsx'),   // 연결 관리 — 여기서 바꾼다
  join('src', 'shared', 'connections.ts'),        // 저장소 본체
  join('src', 'physical', 'PhysicalClient.ts'),   // 기본값을 심는다(registerConnectionDefault)
  join('src', 'stt', 'SttClient.ts'),
  join('src', 'generate', 'LlmClient.ts'),
];

// ── 1. 주소를 바꾸는 코드가 연결 관리 밖에 없는가 ────────────────────────────
{
  for (const file of walk(srcDir)) {
    const rel = relative(root, file);
    if (MAY_WRITE.includes(rel)) continue;
    const source = readFileSync(file, 'utf8');
    if (/saveConnections\s*\(/.test(source)) {
      failures.push(`${rel}: 주소를 바꾼다 — 설정은 연결 관리 하나여야 한다`);
    }
    if (/registerConnectionDefault\s*\(\s*'physical'/.test(source)) {
      failures.push(`${rel}: physical 기본값을 심는다 — 경계 파일 하나여야 한다`);
    }
  }
}

// ── 2. 시연 화면에 주소 칸·프리셋·확인 버튼이 없는가 ────────────────────────
{
  const panel = readFileSync(join(srcDir, 'physical', 'RobotPanel.tsx'), 'utf8');
  const banned = [
    [/BROKER_PRESETS/, '프리셋 목록'],
    [/robot-preset/, '프리셋 셀렉트'],
    [/robot-address/, '주소 입력 칸'],
    [/robot-ping/, '연결 확인 버튼'],
    [/issuePing/, 'ping 왕복'],
    [/saveConnections/, '주소 저장'],
    [/connectionAddress\s*\(/, '주소 읽기'],
    [/<input/, '입력 칸'],
    [/<select/, '고르는 칸'],
  ];
  for (const [pattern, what] of banned) {
    if (pattern.test(panel)) failures.push(`시연 화면에 ${what} 이 남아 있다 — 표시등만 남긴다`);
  }
}

// ── 3. 표시등은 읽기 전용이고 연결 관리를 연다 ──────────────────────────────
{
  const lamp = readFileSync(join(srcDir, 'shell', 'ConnectionLamp.tsx'), 'utf8');
  if (/<input|<select|saveConnections/.test(lamp)) failures.push('표시등이 읽기 전용이 아니다');
  if (!/onOpen/.test(lamp)) failures.push('표시등을 눌러도 연결 관리가 안 열린다');

  const shell = readFileSync(join(srcDir, 'shell', 'AppShell.tsx'), 'utf8');
  if (!/<ConnectionLamp\s+onOpen=\{\(\) => setPanel\('connections'\)\}/.test(shell)) {
    failures.push('셸이 표시등을 안 그리거나 연결 관리로 안 잇는다');
  }

  // **무엇이 끊겼는지 보여야 한다** (§4).
  const { resetHealth, setHealth, line, firstBroken, CHECKED_TARGETS } = await load('src', 'shared', 'connectionHealth.ts');
  resetHealth();
  setHealth('physical', [line('broker', '브로커', true), line('robot', '로봇', false, { reason: '죽었다' })]);
  const broken = firstBroken(CHECKED_TARGETS);
  if (broken?.line.label !== '로봇') failures.push('표시등이 어느 줄이 끊겼는지 못 짚는다');
  resetHealth();
}

// ── 4. 긴급 정지는 시연 화면에 그대로 있다 ──────────────────────────────────
//
// 연결 기능이 아니라 **안전 기능**이다. 연결 관리로 옮기면 발표 중에 팝업을 열어야
// 멈출 수 있게 되고, 그때는 이미 늦다.
{
  const shell = readFileSync(join(srcDir, 'shell', 'AppShell.tsx'), 'utf8');
  const topbar = readFileSync(join(srcDir, 'views', 'TopBar.tsx'), 'utf8');
  for (const [name, source] of [['AppShell', shell], ['TopBar', topbar]]) {
    if (!/<StopButton \/>/.test(source)) failures.push(`${name} 에서 정지 버튼이 사라졌다 — 안전 기능은 시연 화면에 남는다`);
  }
  const connections = readFileSync(join(srcDir, 'shell', 'ConnectionsPanel.tsx'), 'utf8');
  if (/StopButton|emergencyStop/.test(connections)) {
    failures.push('정지가 연결 관리로 옮겨졌다 — 연결 기능이 아니라 안전 기능이다');
  }
}

// ── 5. 주소의 원천이 하나인가 ───────────────────────────────────────────────
{
  const { connectionAddresses, connectionKey } = await load('src', 'shared', 'connections.ts');
  const key = connectionKey('physical', 'ws');
  const all = connectionAddresses();
  if (!(key in all)) failures.push('physical 주소가 저장소에 없다 — 원천이 사라졌다');

  // 대비값을 connections.ts 로 되돌리지 않았는가 (§7 · verify:physical-port 와 같은 선).
  const source = readFileSync(join(srcDir, 'shared', 'connections.ts'), 'utf8');
  if (/pi7\.local|192\.168\.50\.172/.test(source)) {
    failures.push('connections.ts 에 브로커 주소가 되돌아왔다 — 주소를 아는 면은 src/physical/ 하나다');
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // 시연 화면에 주소 칸을 되살린 셈 치고 같은 규칙을 돌린다.
  const injected = '<input className="robot-address" value={address} />';
  control('시연 화면에 주소 칸 주입', /robot-address/.test(injected) && /<input/.test(injected));
}
{
  const injected = "saveConnections({ ...connectionAddresses(), x: 'y' });";
  control('연결 관리 밖에서 주소 저장 주입', /saveConnections\s*\(/.test(injected));
}
{
  // 연결 관리는 실제로 주소를 바꿔야 한다 — 규칙이 헛돌지 않는다는 확인.
  const panel = readFileSync(join(srcDir, 'shell', 'ConnectionsPanel.tsx'), 'utf8');
  control('연결 관리는 주소를 바꾼다', /saveConnections\s*\(/.test(panel));
}

if (failures.length) {
  console.error(`❌ verify:one-broker-address\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 주소를 바꾸는 자리가 연결 관리 하나 — 시연 화면은 프리셋·주소 칸·확인 버튼 0건');
console.log('✅ 표시등은 읽기 전용이고 무엇이 끊겼는지 짚는다 · 누르면 연결 관리가 열린다');
console.log('✅ 긴급 정지는 시연 화면에 그대로 — 연결 관리로 옮기지 않았다 (안전 기능이다)');
console.log('✅ 주소 원천 하나 · connections.ts 에 브로커 주소가 안 돌아왔다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
