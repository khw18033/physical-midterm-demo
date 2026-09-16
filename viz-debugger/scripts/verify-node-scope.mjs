// 시나리오 → 뷰 노드 범위 (260901 축→탭 · 260903 3단계에 축→노드로).
//
// **같은 대응이 두 곳에 손으로 적히는 것을 막는다.** 막으려는 실패는 넷이다.
//
//  1. **표가 갈라지는 것** — 축→노드 표(`AXIS_NODES`)와 패널→축 표(`SCENARIO_PANELS`)가
//     서로 다른 노드를 가리키면, 팔레트 버튼은 흐린데 카드는 살아 있거나 그 반대가 된다.
//     사용자가 「이 대본엔 없음」이라고 적힌 노드를 놓았는데 내용이 그대로 있으면 안내가
//     거짓말이 된다.
//  2. **화면과 표가 갈라지는 것** — 화면이 표에 없는 패널 id 로 접거나, 표에 있는 패널을
//     아무도 접지 않으면 표는 장식이 된다. 소스에서 실제 `PanelGate`/`NodeGate` 사용을 읽는다.
//  3. **어휘가 갈라지는 것** (260903 신설) — 표의 종류 id 와 **등록된 렌더러의 kind** 가
//     어긋나면, 표는 있는데 그 노드가 팔레트에 없거나 그 반대가 된다. 이름(label)을 표에
//     두지 않고 렌더러에서만 얻는 이유가 이것이고, 그래서 id 만이라도 대조해야 한다.
//  4. **세 편의 「쓰는 노드」가 지시서와 달라지는 것** — 대본을 고치다 축이 늘거나 줄면
//     조용히 달라진다. 1편 장치·지표·영상 · 2편 같음 · 3편 장치·제어·지표를 못으로 박아 둔다.
//
// 규칙과 표는 `src/scenarios/axes.ts` 하나에서 읽는다 — 여기에 베껴 적으면 이 검사가
// 막으려던 실패를 이 검사가 저지르게 된다. 대본은 verify:script-library 와 같은 방식으로
// scenarios/*.json 을 직접 읽는다(브라우저 번들의 JSON import 는 Node ESM 에서 안 열린다).
//
// 음성 대조군 포함 — 표·화면·대본을 각각 무력화한 사본이 반드시 실패로 잡히는지 본다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const axes = await import(pathToFileURL(join(root, 'src', 'scenarios', 'axes.ts')).href);
const { AXIS_NODES, SCENARIO_NODE_KINDS, SCENARIO_PANELS, axesOfScript, nodeKindsOfScript, panelAlive, panelsOfNode } = axes;
const { SCRIPT_IDS } = await import(pathToFileURL(join(root, 'src', 'scenarios', 'manifest.ts')).href);

const scripts = SCRIPT_IDS.map((id) =>
  JSON.parse(readFileSync(join(root, 'scenarios', `${id}.json`), 'utf8')),
);

const failures = [];
const controls = [];
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

// ── ① 두 표의 아귀 ───────────────────────────────────────────────────────────
function checkTables(axisNodes, panels) {
  const f = [];
  const kindIds = new Set(SCENARIO_NODE_KINDS);
  for (const [axis, kinds] of Object.entries(axisNodes)) {
    if (!Array.isArray(kinds) || kinds.length === 0) {
      f.push(`AXIS_NODES의 ${axis}에 노드가 없다 — 축이 어디에도 안 나타나면 그릴 자리가 없다`);
    }
    for (const kind of kinds) if (!kindIds.has(kind)) f.push(`AXIS_NODES의 ${axis}가 없는 노드 ${kind}를 가리킨다`);
  }
  // 패널의 노드가 그 패널 축의 노드 목록 안에 있어야 한다.
  for (const panel of panels) {
    if (panel.axes.length === 0) f.push(`패널 ${panel.id}에 축이 없다 — 접힘 판정을 할 수 없다`);
    for (const axis of panel.axes) {
      const kinds = axisNodes[axis];
      if (kinds === undefined) {
        f.push(`패널 ${panel.id}이 표에 없는 축 ${axis}를 쓴다`);
        continue;
      }
      if (!kinds.includes(panel.node)) {
        f.push(`어긋남: 패널 ${panel.id}은 노드 ${panel.node}에 있는데 축 ${axis}의 표는 [${kinds.join(', ')}]다`);
      }
    }
  }
  // 역방향 — 표의 (축→노드) 칸을 아무 패널도 맡지 않으면 그 축은 그 노드에서 접힘 판정을 못 받는다.
  for (const [axis, kinds] of Object.entries(axisNodes)) {
    for (const kind of kinds) {
      if (!panels.some((p) => p.node === kind && p.axes.includes(axis))) {
        f.push(`빈 칸: 축 ${axis}가 노드 ${kind}에 나타난다고 적혀 있는데 그 노드에 이 축을 맡은 패널이 없다`);
      }
    }
  }
  return f;
}
failures.push(...checkTables(AXIS_NODES, SCENARIO_PANELS));

// ── ② 화면과 표 ──────────────────────────────────────────────────────────────
// 화면이 실제로 어떤 id/종류로 접는지 소스에서 읽는다. 표에 적어 두고 화면이 안 쓰면
// 표는 장식이고, 화면이 표에 없는 id 를 쓰면 런타임에 터진다.
const gateSources = [
  ['src/tabs/viewNodes.tsx', read('src', 'tabs', 'viewNodes.tsx')],
  ['src/tabs/views/MetricsView.tsx', read('src', 'tabs', 'views', 'MetricsView.tsx')],
];
function collectGates(sources) {
  const panelIds = new Set();
  const kinds = new Set();
  for (const [, source] of sources) {
    for (const m of source.matchAll(/<PanelGate\s+id="([^"]+)"/g)) panelIds.add(m[1]);
    for (const m of source.matchAll(/<NodeGate\s+kind="([^"]+)"/g)) kinds.add(m[1]);
  }
  return { panelIds, kinds };
}
function checkScreens(sources, panels) {
  const f = [];
  const { panelIds, kinds } = collectGates(sources);
  for (const id of panelIds) {
    if (!panels.some((p) => p.id === id)) f.push(`화면이 표에 없는 패널 id 로 접는다 — ${id}`);
  }
  for (const panel of panels) {
    if (!panelIds.has(panel.id)) {
      f.push(`표의 패널 ${panel.id}(${panel.title})을 아무 화면도 접지 않는다 — 표가 장식이 된다`);
    }
  }
  // 뷰 노드 넷은 전부 NodeGate 를 지나야 한다. 실행 노드는 늘 살아 있어 게이트가 없다.
  for (const kind of SCENARIO_NODE_KINDS) {
    if (!kinds.has(kind)) f.push(`노드 ${kind}에 NodeGate 가 없다 — 패널이 전부 접혀도 카드 본문이 그대로 뜬다`);
  }
  return f;
}
failures.push(...checkScreens(gateSources, SCENARIO_PANELS));

// ── ③ 어휘 — 표의 종류 id 와 등록된 렌더러의 kind (260903 신설) ───────────────
{
  const renderers = read('src', 'tabs', 'viewNodes.tsx');
  const registered = [...renderers.matchAll(/kind:\s*'([^']+)'/g)].map((m) => m[1]).sort();
  const tabled = [...SCENARIO_NODE_KINDS].sort();
  if (registered.join(',') !== tabled.join(',')) {
    failures.push(`표의 종류 [${tabled.join(', ')}] 와 등록된 렌더러 [${registered.join(', ')}] 가 다르다 — 이름은 렌더러에만 있으므로 id 라도 맞아야 한다`);
  }
  // 이름(label)을 표에 두면 팔레트와 접힘 카드가 서로 다른 이름을 말하게 된다.
  const axesSource = read('src', 'scenarios', 'axes.ts');
  if (/(TAB_LABEL|NODE_LABEL)\s*[:=]/.test(axesSource)) {
    failures.push('축 표에 이름표가 생겼다 — 이름의 원천은 등록된 렌더러 하나여야 한다 (VZ-N-01)');
  }
}

// ── ④ 접힘은 시나리오 모드에서만 ─────────────────────────────────────────────
const gateSource = read('src', 'tabs', 'ScenarioGate.tsx');
function checkModeGuard(source) {
  const f = [];
  // 두 게이트 모두 「시나리오 모드가 아니면 axes 가 null → 전부 그린다」로 시작해야 한다.
  const guards = [...source.matchAll(/axes === null\) return <>\{children\}<\/>;/g)].length;
  if (guards < 2) f.push(`ScenarioGate 에 시나리오 모드 가드가 ${guards}곳뿐이다 — PanelGate·NodeGate 둘 다 있어야 한다`);
  if (!source.includes('enterScriptPreview')) {
    f.push('접힘 카드에 「그 대본으로 바꾸기」 경로가 없다 — 막지 않는다는 규칙이 화면에서 사라졌다');
  }
  return f;
}
failures.push(...checkModeGuard(gateSource));

// 층 1 — 안 쓰는 것은 흐리게 하되 **막지 않는다.** 3단계에 탭 바에서 팔레트로 옮겨 왔다.
const paletteSource = read('src', 'canvas', 'Palette.tsx');
if (!paletteSource.includes('palette__item--unused')) failures.push('팔레트에 안 쓰는 노드 표시(palette__item--unused)가 없다 — 층 1이 없다');
if (/palette__item--unused[\s\S]{0,400}?disabled/.test(paletteSource)) failures.push('안 쓰는 노드를 disabled 로 막았다 — 놓아서 확인할 수 있어야 한다');
const shellSource = read('src', 'shell', 'AppShell.tsx');
if (!shellSource.includes('nowPlaying(')) failures.push('셸이 「지금」 안내줄을 그리지 않는다 — 화면을 옮겨도 남으려면 셸이 그려야 한다');

// ── ⑤ 세 편의 「쓰는 노드」 — 지시서 표를 못으로 박는다 ───────────────────────
const EXPECTED = {
  'MSN-260831-01': ['device-risk', 'metrics', 'video'],
  'MSN-260831-02': ['device-risk', 'metrics', 'video'],
  'MSN-260831-03': ['device-risk', 'control', 'metrics'],
  // 5편(260909 시연) — 자리와 속도만 몬다. 액추에이터 명령이 없고(로봇은 ACTION_CATALOG 밖)
  // 영상 축도 없다 — 근거 이미지는 아직 없어서 자리만 비워 두었다(지시서 §5).
  'MSN-260909-01': ['device-risk', 'metrics'],
};
function checkScripts(list) {
  const f = [];
  for (const script of list) {
    const want = EXPECTED[script.missionId];
    if (want === undefined) {
      f.push(`쓰는 노드 기대표에 ${script.missionId}가 없다 — 대본을 더했으면 표도 더해야 한다`);
      continue;
    }
    const got = [...nodeKindsOfScript(script)].sort();
    if (got.join(',') !== [...want].sort().join(',')) {
      f.push(`${script.missionId}의 쓰는 노드가 [${got.join(', ')}] — 기대는 [${want.join(', ')}]`);
    }
  }
  return f;
}
failures.push(...checkScripts(scripts));

// 패널 단위까지 — 「1편에서 제어 노드가 통째로 접히는가」를 패널 표로 다시 확인한다.
function collapsedPanels(script) {
  const set = axesOfScript(script);
  return SCENARIO_PANELS.filter((p) => !panelAlive(p, set)).map((p) => p.id);
}
const PANEL_EXPECTED = {
  'MSN-260831-01': ['risk', 'control', 'metrics-push'],
  'MSN-260831-02': ['risk', 'control', 'metrics-push'],
  'MSN-260831-03': ['risk', 'zone-map', 'metrics-push', 'video'],
  'MSN-260909-01': ['risk', 'control', 'metrics-push', 'video'],
};
for (const script of scripts) {
  const got = collapsedPanels(script).sort();
  const want = [...(PANEL_EXPECTED[script.missionId] ?? [])].sort();
  if (got.join(',') !== want.join(',')) {
    failures.push(`${script.missionId}에서 접히는 패널이 [${got.join(', ')}] — 기대는 [${want.join(', ')}]`);
  }
}
// 노드 전체가 접히는 경우 — 그 노드의 패널이 하나도 안 살아야 「한 장으로 대체」가 성립한다.
for (const script of scripts) {
  const set = axesOfScript(script);
  const used = nodeKindsOfScript(script);
  for (const kind of SCENARIO_NODE_KINDS) {
    const alive = panelsOfNode(kind).some((p) => panelAlive(p, set));
    if (alive !== used.has(kind)) {
      failures.push(
        `${script.missionId}: 노드 ${kind} — 팔레트는 ${used.has(kind) ? '쓴다' : '안 쓴다'}는데 패널은 ${alive ? '살아 있다' : '전부 접힌다'}`,
      );
    }
  }
}

// ── 음성 대조군 — 무력화한 사본이 반드시 잡히는가 ────────────────────────────
function control(name, found, marker) {
  if (!found.some((msg) => msg.includes(marker))) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  else controls.push(name);
}
control('축→노드 표를 옮김 (actuator를 지표 노드로)', checkTables({ ...AXIS_NODES, actuator: ['metrics'] }, SCENARIO_PANELS), '어긋남');
control(
  '패널을 다른 노드로 (제어 패널을 장치·위험으로)',
  checkTables(AXIS_NODES, SCENARIO_PANELS.map((p) => (p.id === 'control' ? { ...p, node: 'device-risk' } : p))),
  '어긋남',
);
control(
  '표에만 있고 화면이 안 쓰는 패널',
  checkScreens(gateSources, [...SCENARIO_PANELS, { id: 'ghost', node: 'device-risk', title: '유령', axes: ['position'], why: '' }]),
  'ghost',
);
control(
  'NodeGate 삭제 사본',
  checkScreens(gateSources.map(([name, src]) => [name, src.replaceAll('<NodeGate kind="control"', '<div data-x="control"')]), SCENARIO_PANELS),
  'NodeGate 가 없다',
);
control('모드 가드 삭제 사본', checkModeGuard(gateSource.replaceAll('axes === null', 'false')), '가드');
control(
  '대본에 액추에이터 명령 주입 (1편이 제어 노드를 쓰게 됨)',
  checkScripts([
    { ...scripts[0], commands: [{ atSec: 1, entity: 'actuator-01', action: 'close_gate', producedBy: 'backend', taskId: 'x' }] },
  ]),
  '쓰는 노드',
);

if (failures.length) {
  console.error(`❌ verify:node-scope\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ 축→노드 표(${Object.keys(AXIS_NODES).length}축)와 패널→축 표(${SCENARIO_PANELS.length}패널)의 아귀 — 양방향 대조, 빈 칸 없음`);
console.log(`✅ 어휘 — 표의 종류 ${SCENARIO_NODE_KINDS.length}종이 등록된 렌더러와 같고, 이름표는 표에 없다(렌더러가 원천)`);
console.log('✅ 화면과 표 — 게이트가 표의 id 만 쓰고 표의 패널을 전부 누군가 접는다 · 접힘은 시나리오 모드에서만 · 팔레트는 흐리게만 하고 막지 않는다');
console.log('✅ 쓰는 노드 — 1편 장치·지표·영상 · 2편 장치·지표·영상 · 3편 장치·제어·지표 (팔레트와 노드 접힘이 서로 어긋나지 않음)');
console.log(`✅ 음성 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
