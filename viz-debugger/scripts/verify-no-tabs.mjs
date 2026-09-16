// 탭이 없다 · 확대는 탭이 아니다 (260903 — 2단계에 §6 넷 · 3단계에 탭 제거까지).
//
// 이 검사가 막으려는 실패는 하나다: **확대가 이름만 바꾼 탭이 되는 것.**
// 노드로 통합하는 이유가 「화면을 바꾸지 않고 공시 ↔ 통시를 넘어간다」(HCI 차별점 2)인데,
// 확대가 캔버스를 갈아 치우면 탭을 옮기는 것과 똑같아지고 그 문장이 다시 거짓이 된다.
//
// 지시서 §6이 그것을 **검사 가능한 네 조건**으로 적어 뒀다. 여기서 그 넷을 소스로 확인한다.
//
//  1. 캔버스가 **뒤에 남아 보인다** — 오버레이이고, 배경이 반투명이며, 캔버스를 조건부로
//     그리지 않는다(확대 중에도 TaskGraph 가 그대로 마운트돼 있다).
//  2. 닫으면 **정확히 같은 자리** — 닫기가 zoom 상태 하나만 되돌린다. 다른 상태를 함께
//     초기화하면 「어디였지」가 생긴다.
//  3. 전역에 **`activeTab` 류 상태가 없다** — 캔버스 쪽에 그런 상태가 하나도 없어야 한다.
//  4. 확대는 **한 번에 하나** — 상태가 문자열 하나다. 배열이면 둘이 열리고, 둘이 열리면
//     분할 화면이고, 분할 화면은 곧 탭이 된다.
//
// **3단계에서 다섯째가 늘었다 — 탭이 정말 없는가.** 2단계에는 `AppShell` 의 `activeTab` 이
// 탭 바가 살아 있어 정상이었고 「셸 한 곳뿐인가」만 봤다. 이제 **0곳**이어야 하고,
// `TabView`·`TabGate`·`app-tabs` 도 코드에 남아 있으면 안 된다. 죽은 탭 코드가 남으면
// 다음 사람이 「아직 탭이 있나?」를 매번 다시 물어야 한다.
//
// 음성 대조군 포함 — 판정들이 무력화된 사본을 실제로 잡는지 확인한다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

/**
 * 주석을 걷어낸 소스. 이 저장소의 주석은 「왜 activeTab 이 아닌가」를 길게 적으므로,
 * 걷어내지 않으면 **설명이 위반으로 잡힌다.** 검사 대상은 코드다.
 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const main = read('src', 'main.tsx');
const overlay = read('src', 'canvas', 'ZoomOverlay.tsx');
/** 대상 상태 오버레이 (260904 — `VZ-D-07`). 확대와 **같은 규칙**을 지켜야 한다. */
const deviceOverlay = read('src', 'views', 'DeviceStatusOverlay.tsx');
const graph = read('src', 'graph', 'TaskGraph.tsx');
const css = read('src', 'style.css');

// ── ① 캔버스가 뒤에 남아 보인다 ───────────────────────────────────────────────
{
  // 캔버스를 확대와 **바꿔치기**하지 않는다. TaskGraph 를 그리는 자리에 zoom 삼항이 없어야 한다.
  const swapsCanvas = (source) => /zoom[A-Za-z]*\s*(!==\s*null|===\s*null|\?)[^\n]{0,80}<TaskGraph/.test(source);
  check(!swapsCanvas(main), '확대할 때 캔버스를 갈아 치운다 — 오버레이가 아니라 화면 전환이다');
  check(main.includes('<TaskGraph'), 'TaskGraph 를 그리는 곳이 없다');
  check(/\{zoomedNode !== null && zoomedEntry !== null && <ZoomOverlay/.test(main), '확대 오버레이가 캔버스의 형제로 얹히지 않는다');
  // 배경이 불투명하면 뒤가 안 보인다. 8자리 hex(알파 포함)여야 한다.
  const backdrop = /\.modal-backdrop\{[^}]*background:#([0-9a-f]{6,8})/.exec(css);
  check(backdrop !== null && backdrop[1].length === 8, `확대 배경이 불투명하다(#${backdrop === null ? '없음' : backdrop[1]}) — 캔버스가 뒤에 보여야 한다`);
  check(overlay.includes('modal-backdrop'), '확대가 ActionModal 계통(.modal-backdrop)이 아니다');
  // 음성 대조군.
  if (!swapsCanvas('return zoomedId !== null ? <Zoom /> : <TaskGraph tasks={tasks} />;')) {
    failures.push('대조군 실패: 캔버스를 갈아 치우는 사본을 판정이 놓쳤다 — 이 검사는 무의미하다');
  }
  console.log('✅ 캔버스가 뒤에 남는다 — 오버레이는 형제이고 배경은 반투명, TaskGraph 는 조건 없이 그린다');
}

// ── ② 닫으면 정확히 같은 자리 ────────────────────────────────────────────────
//
// **오버레이마다 그 오버레이의 닫기를 본다** (260904). 예전에는 `main.tsx` 의 첫 `onClose`
// 하나만 봤는데, 대상 상태 오버레이(`VZ-D-07`)가 늘면서 그 첫 자리가 바뀌어 확대의 닫기를
// 놓칠 뻔했다. 규칙(닫으면 자기 상태 하나만 되돌린다)은 오버레이 **전부**에 걸어야 한다 —
// 닫으면서 다른 상태까지 만지면 어느 오버레이든 「어디였지」가 생긴다.
{
  /** `<Name … onClose={() => …}>` 에서 그 오버레이의 닫기 본문만 꺼낸다. */
  const closeBodyOf = (name) => {
    const at = main.indexOf('<' + name);
    if (at < 0) return null;
    const found = /onClose=\{\(\) => ([^}]+)\}/.exec(main.slice(at, at + 600));
    return found === null ? null : found[1];
  };
  for (const [name, setter] of [['ZoomOverlay', 'setZoomedId'], ['DeviceStatusOverlay', 'setStatusDeviceId']]) {
    const body = closeBodyOf(name);
    check(body !== null, `${name} 의 닫기 경로가 없다`);
    if (body === null) continue;
    check(body.includes(`${setter}(null)`), `${name} 의 닫기가 자기 상태를 되돌리지 않는다: ${body}`);
    // 닫으면서 다른 상태까지 만지면 「어디였지」가 생긴다 — 자리·스크롤·되감기 시각은 그대로여야 한다.
    const otherSets = body.match(/set[A-Z][A-Za-z]*\(/g)?.filter((called) => called !== `${setter}(`) ?? [];
    check(otherSets.length === 0, `${name} 의 닫기가 다른 상태도 되돌린다(${otherSets.join(' ')}) — 닫으면 같은 자리여야 한다`);
  }
  // Esc 로도 닫힌다 — 여는 길이 둘(더블클릭·버튼)이면 닫는 길도 둘 이상이어야 한다.
  check(overlay.includes("'Escape'"), '확대가 Esc 로 닫히지 않는다');
  check(deviceOverlay.includes("'Escape'"), '대상 상태가 Esc 로 닫히지 않는다');
  // 음성 대조군 — 이름을 앵커로 삼은 판정이 실제로 그 오버레이를 집는가.
  if (closeBodyOf('ZoomOverlay') === closeBodyOf('DeviceStatusOverlay')) {
    failures.push('대조군 실패: 두 오버레이의 닫기가 같은 것으로 잡혔다 — 앵커가 안 듣는다');
  }
  console.log('✅ 닫으면 같은 자리 — 오버레이 둘 다 자기 상태 하나만 되돌린다 (Esc·배경·버튼)');
}

// ── ③ 전역에 activeTab 류 상태가 없다 ────────────────────────────────────────
{
  const CANVAS_FILES = ['types.ts', 'registry.ts', 'scope.ts', 'persist.ts', 'defaults.ts', 'useCanvas.ts', 'Palette.tsx', 'ViewNodeCard.tsx', 'ZoomOverlay.tsx'];
  const looksLikeTabState = (source) => /activeTab|activePanel|currentTab|selectedTab|tabIndex/.test(source);
  for (const file of CANVAS_FILES) {
    check(!looksLikeTabState(stripComments(read('src', 'canvas', file))), `src/canvas/${file} 에 탭 류 상태가 있다 — 확대가 이름만 바꾼 탭이 된다`);
  }
  check(!looksLikeTabState(stripComments(graph)), 'TaskGraph 에 탭 류 상태가 있다');
  // 3단계에서 탭 바가 사라졌으므로 셸도 **0곳**이다. 2단계에는 여기가 「한 곳뿐인가」였다.
  const shell = stripComments(read('src', 'shell', 'AppShell.tsx'));
  const shellCount = (shell.match(/activeTab/g) ?? []).length;
  check(shellCount === 0, `AppShell 에 activeTab 이 ${shellCount}곳 남았다 — 3단계에서 탭 상태는 0곳이어야 한다`);
  const mainCount = (stripComments(main).match(/activeTab/g) ?? []).length;
  check(mainCount === 0, `캔버스 화면(main.tsx)에 activeTab 이 ${mainCount}곳 생겼다`);
  if (!looksLikeTabState("const [activeTab, setActiveTab] = useState('a');")) {
    failures.push('대조군 실패: 탭 류 상태를 판정이 놓쳤다 — 이 검사는 무의미하다');
  }
  console.log('✅ 탭 류 상태 — 캔버스·그래프·셸 전부 0곳');
}

// ── ④ 탭이 정말 없는가 (260903 3단계) ────────────────────────────────────────
{
  const shell = stripComments(read('src', 'shell', 'AppShell.tsx'));
  const tabsIndex = stripComments(read('src', 'tabs', 'index.tsx'));
  const gate = stripComments(read('src', 'tabs', 'ScenarioGate.tsx'));
  const css = read('src', 'style.css');
  // 탭 바·탭 라우팅·탭 단위 접힘 — 셋 다 코드에서 사라져야 한다.
  check(!/app-tabs/.test(shell) && !/app-tabs/.test(css), '탭 바(app-tabs)가 코드나 CSS 에 남아 있다');
  check(!/TabView/.test(shell) && !/TabView/.test(tabsIndex), 'TabView(탭 본문 라우팅)가 남아 있다');
  check(!/TabGate/.test(gate) && !/TabGate/.test(tabsIndex), 'TabGate(탭 단위 접힘)가 남아 있다 — 접힘은 NodeGate 로 내려앉았다');
  check(/NodeGate/.test(gate), 'NodeGate 가 없다 — 노드 단위 접힘이 사라졌다');
  // 무대는 하나다. 감췄다 되살릴 다른 무대가 없다.
  check(!/is-hidden/.test(shell) && !/is-hidden/.test(css), '감춘 무대(is-hidden)가 남아 있다 — 무대는 캔버스 하나뿐이어야 한다');
  // 지시서 §3 — 이 둘은 **그대로 남아야** 한다.
  check(/useTabsDataLayer\(\)/.test(shell), '데이터 계층 기동이 셸에서 사라졌다 — 앱 수명과 같아야 한다 (지시서 §3 · 하지 않을 것)');
  check(/onDebuggerHome/.test(shell), '마일스톤 목록으로 돌아가는 길이 셸에서 사라졌다');
  // 「○○ 노드로」 — 탭 시절의 「갈 탭」이 옮겨 앉은 자리.
  check(/onOpenNode\(/.test(shell), '대본 띠의 「○○ 노드로」가 없다 — 안내줄이 갈 곳을 잃었다');
  check(/nodeKinds\.map/.test(shell), '안내줄이 노드 후보를 그리지 않는다');
  console.log('✅ 탭 제거 — 탭 바·TabView·TabGate·감춘 무대가 전부 없고, 데이터 계층과 되돌아갈 길은 그대로다');
}

// ── ⑤ 확대는 한 번에 하나 ────────────────────────────────────────────────────
{
  // 상태가 **하나**다. 배열·집합이면 둘이 열린다.
  //
  // 3단계에 원천이 모듈 저장소로 올라갔다(`canvas/zoomState.ts`) — 셸의 `?` 설명서가 같은
  // 값을 읽어야 하기 때문이다. 값을 두 곳에 복제하지 않았는지가 여기서 걸린다.
  const zoomState = stripComments(read('src', 'canvas', 'zoomState.ts'));
  check(/export type ZoomTarget = \{ id: string; kind: string \} \| null;/.test(zoomState), '확대 상태의 모양이 「하나 또는 없음」이 아니다');
  check(/^let target: ZoomTarget = null;$/m.test(zoomState), '확대 상태의 원천이 값 하나가 아니다 — 둘이 열릴 수 있다');
  check(/const zoomedId = zoomTarget\?\.id \?\? null;/.test(main), '캔버스가 확대 상태를 저장소에서 파생하지 않는다 — 복제하면 갈라진다');
  check(!/useState<string \| null>\(null\);[^\n]*\/\/ *zoom/i.test(main), '캔버스가 확대 상태를 따로 들고 있다');
  check(/zoomedId: string \| null;/.test(graph), '캔버스 계약의 확대 상태가 「문자열 하나」가 아니다');
  check(!/zoomedIds|zoomTargets|zoomed.*Set<|zoomed.*\[\]/.test(main + graph + zoomState), '확대 상태가 여러 개를 담는 모양이다 — 분할 화면은 곧 탭이 된다');
  // 오버레이를 목록으로 그리지 않는다.
  check(!/<ZoomOverlay[\s\S]{0,200}\.map\(/.test(main) && !/\.map\([^)]*<ZoomOverlay/.test(main), '확대 오버레이를 목록으로 그린다 — 한 번에 하나여야 한다');
  console.log('✅ 확대는 한 번에 하나 — 원천이 값 하나(zoomState)이고 오버레이를 목록으로 그리지 않는다');
}

if (failures.length) {
  console.error('❌ 「확대는 탭이 아니다」 검사 실패:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('✅ 통과 — 오버레이 · 같은 자리 · 탭 상태 0곳 · 탭 제거 · 동시 하나 (지시서 §6 네 조건 + 3단계)');
