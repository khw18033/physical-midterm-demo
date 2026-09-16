// 뷰 노드의 두 경계 (260903 — 1단계 신설 · 2단계에서 요약/확대 짝을 추가).
//
// ## ① 단독 빌드 경계 — 이번 작업의 최대 위험
//
// 뷰 노드를 그래프 안에 그냥 넣으면 `tabs/data/` 스토어가 단독 번들에 딸려 들어와
// **논문 측정축 D(계측 오버헤드)가 오염된다.** `verify:standalone` 이 그 순간 실패하지만,
// 그 검사는 「단독 진입점이 tabs/ 를 안 가져오는가」만 본다. **주입이 실제로 일어나는가**는
// 아무도 안 본다 — 통합 진입점이 등록을 빠뜨리면 팔레트가 조용히 비고, 그러면 「뷰 노드를
// 안 만든 것」과 「주입을 잊은 것」이 화면에서 같아진다. 여기서 양쪽을 다 못 박는다.
//
// ## ② deps 경계 — 뷰 노드는 실행 노드가 아니다
//
// `refEdges` 가 이미 준 교훈이다: 부수 엣지를 `deps` 에 넣으면 `depths()` 에 순환이 들어가
// 배치가 깨진다. 뷰 노드의 연결은 `taskId` 한 칸이고 깊이 계산에 **들어가지 않아야** 한다.
// 기하학적 확인(붙여도 x 가 안 움직인다)은 `verify:layout` 에 있고, 여기서는 **구조**를 본다.
//
// 음성 대조군 포함 — 판정들이 무력화된 사본을 실제로 잡는지 확인한다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerViewNodes, viewNodeCatalog, viewNodeEntry } from '../src/canvas/registry.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

/** 이 파일이 가져오는 상대 경로들 (src 기준). */
function importsOf(source) {
  return [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
}

// ── ① 캔버스는 tabs/·shell/ 을 모른다 ─────────────────────────────────────────
const CANVAS_FILES = ['types.ts', 'registry.ts', 'scope.ts', 'persist.ts', 'defaults.ts', 'useCanvas.ts', 'Palette.tsx', 'ViewNodeCard.tsx', 'ZoomOverlay.tsx'];
{
  const crosses = (path) => /(^|\/)(tabs|shell)\//.test(path);
  for (const file of CANVAS_FILES) {
    for (const path of importsOf(read('src', 'canvas', file))) {
      if (crosses(path)) failures.push(`src/canvas/${file} 이 ${path} 를 가져온다 — 캔버스가 탭·셸을 알면 단독 번들이 오염된다`);
    }
  }
  // 음성 대조군 — 판정이 실제로 잡는가.
  if (!crosses('../tabs/views/DeviceGrid.tsx')) failures.push('대조군 실패: tabs/ 경로를 판정이 놓쳤다 — 이 검사는 무의미하다');
  console.log(`✅ 캔버스 ${CANVAS_FILES.length}개 파일이 tabs/·shell/ 을 한 줄도 가져오지 않는다`);
}

// ── ② 주입은 통합 진입점만 한다 (그리고 반드시 한다) ──────────────────────────
{
  const integrated = read('src', 'integrated.tsx');
  const standalone = read('src', 'standalone.tsx');
  check(/registerViewNodes\(\s*VIEW_NODE_RENDERERS\s*\)/.test(integrated), 'integrated.tsx 가 뷰 노드 렌더러를 등록하지 않는다 — 통합 앱의 팔레트가 조용히 빈다');
  check(importsOf(integrated).some((path) => path.includes('tabs/')), 'integrated.tsx 가 tabs/ 를 가져오지 않는다 — 주입할 실물이 없다');
  check(!standalone.includes('registerViewNodes'), 'standalone.tsx 가 렌더러를 등록한다 — 단독 번들에 tabs/ 가 딸려 들어간다');
  check(!importsOf(standalone).some((path) => /(tabs|shell)\//.test(path)), 'standalone.tsx 가 tabs/·shell/ 을 가져온다');
  // 렌더러 실물은 tabs/ 안에 있어야 한다 — canvas/ 로 옮기면 경계가 사라진다.
  check(read('src', 'tabs', 'index.tsx').includes('VIEW_NODE_RENDERERS'), 'tabs/index.tsx 가 렌더러를 내보내지 않는다');
  console.log('✅ 주입 — 통합 진입점만 registerViewNodes() 를 부르고, 단독 진입점은 tabs/·shell/ 을 모른다');
}

// ── ③ 팔레트는 종류를 손으로 적지 않는다 (VZ-N-01) ────────────────────────────
{
  const renderers = read('src', 'tabs', 'viewNodes.tsx');
  const kinds = [...renderers.matchAll(/kind:\s*'([^']+)'/g)].map((match) => match[1]);
  // **이름을 못으로 박는다.** 개수만 세면 하나 지우고 하나 더한 것을 못 잡는다.
  // 260910 에 `robot` 이 늘었다 — 실물 로봇 상태를 태스크 그래프에서도 보려는 것이고,
  // 축 표에는 안 들어간다(대본과 무관하게 늘 살아 있어야 한다).
  // 260912 — 탐지 셋이 늘었다. 자리표시(`video-stream` · `detections` · `zone-map`)로
  // 비어 있던 곳이고, 축 표에는 안 들어간다(대본이 아니라 탐지가 미는 값이다).
  const EXPECTED = [
    'control', 'detect-cam', 'detect-map', 'detect-reason', 'device-risk', 'metrics', 'robot', 'video',
  ];
  check(
    [...kinds].sort().join(',') === EXPECTED.join(','),
    `뷰 노드 종류가 [${EXPECTED.join(', ')}] 가 아니다: ${kinds.join(', ')}`,
  );
  check(new Set(kinds).size === kinds.length, `종류가 중복됐다: ${kinds.join(', ')}`);
  // 요약과 확대는 **둘 다** 있어야 한다 (VZ-N-05). 하나만 있으면 그 종류는 확대할 수 없거나
  // 접을 수 없고, 「요약 ↔ 확대」로 표시 깊이를 바꾼다는 설계가 그 칸에서만 깨진다.
  for (const field of ['label:', 'hint:', 'summary:', 'zoom:']) {
    const count = renderers.split(field).length - 1;
    check(count === kinds.length, `${field} 가 ${count}개다 — 종류 ${kinds.length}개와 어긋난다`);
  }
  // 확대 본문은 옛 탭의 화면이다. 접힘 규칙(PanelGate)을 지나야 한다 — 확대라고 규칙에서
  // 빠져나가면 1편(로봇)에서 수문 제어 화면이 다시 열린다.
  check(renderers.includes('PanelGate'), '확대 본문이 PanelGate 를 지나지 않는다 — 대본이 안 미는 축의 화면이 확대로 되살아난다');
  // 접힘은 **정지 프레임**이다. 확대에서만 재생한다 (VZ-I-06).
  check(!/summary:[^,]*VideoOverlayView/.test(renderers), '영상 요약이 VideoOverlayView 를 그린다 — 카드 수만큼 프레임 루프가 돈다');
  check(/zoom:[^,]*VideoOverlayView/.test(renderers), '영상 확대가 VideoOverlayView 를 그리지 않는다 — 재생할 곳이 없다');
  // 영상 구독자가 **둘 이상**일 수 있게 됐다(접힌 카드의 한 장 + 확대의 재생). 열기·닫기가
  // 불리언이면 먼저 끝난 쪽이 남은 쪽의 발행까지 끄고, 증상은 「프레임이 안 온다」뿐이라
  // 원인을 찾기 어렵다. 참조 계수인지 확인한다.
  const vision = read('src', 'tabs', 'data', 'vision.ts');
  check(/openPanels/.test(vision) && /if \(opened === 1\) transport\.setVideoPanel\(entity, true\)/.test(vision),
    '영상 패널 열기가 참조 계수가 아니다 — 구독자가 둘이면 먼저 끝난 쪽이 남은 쪽의 프레임을 끊는다');
  check(/if \(left === 0\) transport\.setVideoPanel\(entity, false\)/.test(vision),
    '영상 패널 닫기가 참조 계수가 아니다 — 마지막 구독자가 나갈 때만 닫아야 한다');
  const palette = read('src', 'canvas', 'Palette.tsx');
  for (const kind of kinds) {
    check(!palette.includes(kind), `팔레트가 종류 ${kind} 를 손으로 적었다 — 목록은 등록분에서 자동 구성돼야 한다 (VZ-N-01)`);
  }
  // 등록이 없으면 팔레트 자체가 없다 — 단독 전달본의 화면이 이번 작업으로 바뀌지 않는 근거.
  check(/catalog\.length === 0\)\s*return null/.test(palette), '등록이 없을 때 팔레트가 빈 줄을 남긴다 — 단독 전달본 화면이 바뀐다');
  console.log(`✅ 팔레트 — 종류 ${kinds.length}종(${kinds.join(' · ')})을 등록분에서만 읽고, 등록이 없으면 뜨지 않는다`);
}

// ── ④ 레지스트리 — 같은 종류가 두 번 등록되면 즉시 터진다 ─────────────────────
{
  const entry = (kind) => ({ kind, label: kind, hint: kind, summary: () => null, zoom: () => null });
  registerViewNodes([entry('a'), entry('b')]);
  check(viewNodeCatalog().length === 2, '등록한 렌더러가 목록에 안 보인다');
  check(viewNodeEntry('a') !== null && viewNodeEntry('zzz') === null, '종류 조회가 어긋난다');
  // 두 번 등록하면 뒤엣것이 이긴다 — 개발 중 다시 불려도 목록이 두 배가 되면 안 된다.
  registerViewNodes([entry('c')]);
  check(viewNodeCatalog().length === 1, '두 번 등록했더니 목록이 누적됐다');
  let threw = false;
  try { registerViewNodes([entry('d'), entry('d')]); } catch { threw = true; }
  check(threw, '같은 종류를 두 번 등록해도 조용히 넘어간다 — 팔레트에 같은 버튼이 두 번 뜬다');
  registerViewNodes([]);
  check(viewNodeCatalog().length === 0, '등록을 비울 수 없다');
  console.log('✅ 레지스트리 — 주입이 누적되지 않고, 종류 중복은 즉시 터진다');
}

// ── ⑤ 뷰 노드는 deps 에 들어가지 않는다 ───────────────────────────────────────
{
  // 계약에 deps 칸이 없다.
  const types = read('src', 'canvas', 'types.ts');
  check(!/^\s*deps[?]?:/m.test(types), 'ViewNodeInstance 에 deps 칸이 생겼다 — 뷰 노드가 실행 노드가 되면 깊이 계산에 순환이 들어간다');
  // 배치는 deps 를 태스크에서만 읽는다.
  const layout = read('src', 'graph', 'layout.ts');
  const depsLines = layout.split('\n').filter((line) => line.includes('.deps') && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
  for (const line of depsLines) {
    check(/byId\.get\(id\)\?\.deps/.test(line), `layout.ts 가 태스크 밖에서 deps 를 읽는다: ${line.trim()}`);
  }
  // 그래프도 마찬가지 — 실행 엣지는 tasks 만 훑는다. deps 를 읽는 줄은 **태스크에서만**
  // 읽어야 하고, 뷰 노드(node·nodes)를 끌어들이면 안 된다.
  const readsTaskDepsOnly = (line) => /task/.test(line) && !/\bnodes?\b/.test(line);
  const graph = read('src', 'graph', 'TaskGraph.tsx');
  const graphDeps = graph.split('\n').filter((line) => line.includes('.deps') && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
  for (const line of graphDeps) {
    check(readsTaskDepsOnly(line), `TaskGraph 가 태스크 밖에서 deps 를 읽는다: ${line.trim()}`);
  }
  check(graphDeps.length > 0, 'TaskGraph 에서 deps 를 읽는 곳이 사라졌다 — 실행 엣지가 안 그려진다');
  // 음성 대조군 — 뷰 노드를 deps 에 섞은 사본은 반드시 잡혀야 한다.
  const forged = 'const edges = canvas.nodes.flatMap((node) => node.deps.map((dep) => dep));';
  if (readsTaskDepsOnly(forged)) failures.push('대조군 실패: 뷰 노드의 deps 사용을 판정이 놓쳤다 — 이 검사는 무의미하다');
  console.log(`✅ deps — 계약에 칸이 없고, 배치·그래프의 deps 읽기 ${depsLines.length + graphDeps.length}곳이 전부 태스크다`);
}

// ── ⑥ 크기 조절 손잡이가 테두리 **안쪽**에 있는가 (260911) ────────────────────
//
// 파워포인트처럼 테두리를 끌어 크기를 바꾼다. 손잡이를 테두리 **밖으로** 내밀었더니
// `overflow:hidden` 인 카드에서 잘려 **보이는데 안 눌렸다** — 실제로 뷰 노드가 그랬다.
{
  const css = read('src', 'style.css');
  for (const grip of ['e', 's', 'se']) {
    const rule = css.match(new RegExp(`\.node-grip--${grip}\{([^}]*)\}`))?.[1] ?? '';
    if (rule === '') { failures.push(`.node-grip--${grip} 규칙이 없다`); continue; }
    if (/-\d+px/.test(rule)) {
      failures.push(`.node-grip--${grip} 이 테두리 밖으로 나가 있다 — overflow:hidden 인 카드에서 안 눌린다`);
    }
    if (!/cursor:(ew|ns|nwse)-resize/.test(rule)) {
      failures.push(`.node-grip--${grip} 에 커서가 없다 — 테두리에 대도 조절할 수 있다는 것을 모른다`);
    }
  }
  // 그래프가 실제로 손잡이를 그리는가 · 크기를 저장하는 길이 있는가.
  const graph = read('src', 'graph', 'TaskGraph.tsx');
  check(/node-grip node-grip--se/.test(graph), '그래프가 크기 손잡이를 안 그린다');
  check(/onResize\(/.test(graph), '그래프가 바뀐 크기를 저장하지 않는다 — 새로고침에 사라진다');
  // 안 바꾼 카드에 인라인 높이를 박으면 **글이 잘린다** — 실제로 그랬다.
  check(/setSize\(task\.id, 'task'\)\?\.h/.test(graph), '안 바꾼 카드에도 높이를 박는다 — 마지막 줄이 잘린다');
  console.log('✅ 크기 조절 — 손잡이가 테두리 안쪽에 있고 커서가 바뀐다 · 안 바꾼 카드는 내용만큼 자란다');
}

if (failures.length) {
  console.error('❌ 뷰 노드 경계 검사 실패:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('✅ 통과 — 단독 빌드 경계(주입) · 팔레트 자동 구성 · deps 분리');
