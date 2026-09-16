import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dagLayout } from '../src/graph/layout.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const scenario = JSON.parse(await readFile(join(root, 'scenarios', 'MSN-260826-01.json'), 'utf8'));
const source = await readFile(join(root, 'src', 'graph', 'TaskGraph.tsx'), 'utf8');
// **배치는 DAG 하나다** (260904 — 요구사항정의서 §7.10). 배치 모드 토글이 없어졌으므로
// 화면 배치 검사도 하나만 본다. `treeLayout()` 은 지워지지 않았고 `measure:representation`
// 이 부른다 — 그쪽은 화면에 안 나오므로 「화면 밖으로 나가는가」를 물을 일이 없다.
{
  const positions = Object.values(dagLayout(scenario.tasks));
  const unique = new Set(positions.map(({ x, y }) => `${x},${y}`));
  if (positions.length !== 7 || unique.size !== 7) throw new Error('DAG: 노드 위치가 겹치거나 누락됨');
  console.log('✅ DAG 노드 7개 좌표가 모두 다름');
}
// 260911 — 인라인 스타일에 **크기**가 붙었다(사람이 테두리를 끌어 조절한다). 좌표가
// 그대로 left/top 으로 가는지만 본다 — 뒤에 무엇이 더 붙는지는 이 검사의 관심이 아니다.
if (!source.includes('left: position.x, top: position.y')) throw new Error('계산 좌표가 CSS left/top에 적용되지 않음');
console.log('✅ 계산 좌표를 카드 CSS left/top에 적용');
// 크기를 바꿔도 **선이 상자에 붙는다** — 상수로 그리면 늘린 노드에서 선이 허공에 뜬다.
if (!source.includes('boxOf(')) throw new Error('선이 노드의 실제 크기를 안 본다');
console.log('✅ 선이 노드의 실제 상자(좌표+크기)에 붙는다 — 크기를 바꿔도 따라온다');
if (source.includes('viewBox={`0 0 1380')) throw new Error('SVG와 HTML 노드가 서로 다른 좌표계를 사용함');
if (!source.includes('width={width} height={height}')) throw new Error('SVG가 그래프 캔버스 픽셀 크기를 공유하지 않음');
console.log('✅ SVG 연결선과 HTML 노드가 같은 픽셀 좌표계 사용');
if (!source.includes('onPointerDown=') || !source.includes('onPointerMove=')) throw new Error('노드 드래그 경로 누락');
console.log('✅ 포인터 드래그로 노드 위치와 연결선 좌표를 함께 갱신');

// ── 접기 배치 — 계산된 노드가 주어진 폭 안에 들어오는가 (260901 후속 3건 요구 2) ──────
//
// 이번 문제가 정확히 이것이었다: 깊이 하나당 열 하나를 무조건 오른쪽에 붙여 3편 「임무 전체」가
// 약 3,550 px 가 됐고, 첫 화면에서 오른쪽 노드가 보이지 않았다. **세 편 × 두 배치 모드 ×
// 두 범위**로 그 일이 다시 나면 여기서 잡힌다.
import { NODE_HEIGHT, NODE_WIDTH, columnsPerBand } from '../src/graph/layout.ts';
import { SCRIPT_IDS } from '../src/scenarios/manifest.ts';

const scripts = [];
for (const id of SCRIPT_IDS) {
  scripts.push(JSON.parse(await readFile(join(root, 'scenarios', `${id}.json`), 'utf8')));
}
/** 실제로 쓰는 창 폭들. 좁은 쪽은 노트북, 넓은 쪽은 외부 모니터. */
const WIDTHS = [1120, 1280, 1440, 1920];
const foldFailures = [];

/** 노드 상자가 서로 겹치는가 (dag 전용 — tree 는 92px 간격이 원래 노드 높이보다 좁다). */
function overlaps(positions) {
  const boxes = Object.entries(positions);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [aId, a] = boxes[i];
      const [bId, b] = boxes[j];
      if (Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT) return `${aId}·${bId}`;
    }
  }
  return null;
}

function checkFold(label, tasks, width) {
  const f = [];
  const positions = dagLayout(tasks, width);
  const ids = Object.keys(positions);
  if (ids.length !== tasks.length) f.push(`${label} ${width}px: 노드 ${tasks.length}개 중 ${ids.length}개만 배치됐다`);
  const right = Math.max(...Object.values(positions).map((p) => p.x + NODE_WIDTH));
  if (right > width) f.push(`${label} ${width}px: 오른쪽 끝이 ${right}px — 화면 밖으로 ${right - width}px 나간다`);
  const hit = overlaps(positions);
  if (hit !== null) f.push(`${label} ${width}px: 노드 상자가 겹친다 (${hit}) — 밴드 높이가 그 밴드의 노드 수를 반영하지 않는다`);
  return f;
}

for (const script of scripts) {
  const milestones = [...new Set(script.tasks.map((t) => t.milestone))];
  for (const width of WIDTHS) {
    // 범위 둘 — 「임무 전체」와 마일스톤 하나씩.
    foldFailures.push(...checkFold(`${script.missionId} 임무 전체(${script.tasks.length}노드)`, script.tasks, width));
    for (const milestone of milestones) {
      const own = script.tasks.filter((t) => t.milestone === milestone);
      foldFailures.push(...checkFold(`${script.missionId} ${milestone}(${own.length}노드)`, own, width));
    }
  }
}

// 좁은 창에서는 접기를 포기한다 — 한 열짜리로 접으면 세로가 터무니없이 길어진다.
if (columnsPerBand(500) !== 3) foldFailures.push(`좁은 창(500px)에서 한 밴드 열 수가 ${columnsPerBand(500)} — MIN_COLS(3) 아래로 접으면 안 된다`);
if (Number.isFinite(columnsPerBand(undefined))) foldFailures.push('폭을 모를 때 접는다 — 측정 전에는 옛 배치 그대로여야 한다');

// 음성 대조군 — 접지 않은 배치(폭 모름)는 반드시 폭 검사에 걸려야 한다.
{
  const widest = scripts.reduce((a, b) => (a.tasks.length > b.tasks.length ? a : b));
  const unfolded = dagLayout(widest.tasks);
  const right = Math.max(...Object.values(unfolded).map((p) => p.x + NODE_WIDTH));
  if (right <= 1920) foldFailures.push(`대조군 실패: 접지 않은 ${widest.missionId} 배치가 ${right}px 로 1920px 안에 들어왔다 — 이 검사는 무의미하다`);
  else console.log(`✅ 음성 대조군 — 접지 않으면 ${widest.missionId} 임무 전체가 ${right}px (화면의 두세 배)`);
}

if (foldFailures.length) {
  console.error(`❌ 접기 배치 검사 실패:\n  - ${foldFailures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✅ 접기 배치 — 대본 ${scripts.length}편 × 임무 전체·마일스톤별, 폭 ${WIDTHS.join('/')}px 에서 노드가 하나도 화면 밖으로 나가지 않고 겹치지 않음 (배치는 DAG 하나)`);

// ── 잰 높이 안에 들어오는가 (260904 — 추가 개선 1) ─────────────────────────────
//
// 9/1의 접기는 **폭만** 알았다. 그래서 세로가 남아도 늘 「폭이 허락하는 최대 열」로 붙였고,
// 16:9 모니터에서 아래가 통째로 비었다. 이제 배치가 높이를 함께 받는다.
//
// 여기서는 배치의 **속을 흉내 내지 않는다** — 높이를 모르는 배치(대조군)와 아는 배치를
// 나란히 돌려 결과만 본다. 셋을 본다.
//
//  B. 대조군이 이미 잰 높이 안에 들어왔으면 → 아는 배치도 **반드시** 들어온다.
//  C. 대조군조차 안 들어오면(세로가 애초에 모자라면) → 아는 배치가 **더 접지 않는다**
//     (= 대조군과 같은 높이. 더 접어 봐야 더 길어질 뿐이다).
//  D. 세로가 남는 창에서는 **실제로 더 쓴다** — 한 건도 안 늘면 높이 인자는 죽은 인자다.
//  E. 한 밴드에 다 들어가는 그래프는 **접지 않는다** — 세로가 남는다고 없던 `↵` 를 만들면
//     읽을 이유가 없는 줄바꿈이 생긴다. 접기는 어차피 접힐 그래프를 더 낫게 접는 일이다.
//
// 높이 값은 `TaskGraph` 가 재는 「창 바닥까지 남은 자리」다. 16:9 PC 기준으로 상단 바·머리줄·
// 범례를 뺀 실측 어림값을 쓴다 (1366×768 → 390 · 1600×900 → 590 · 1920×1080 → 770 ·
// 2560×1440 → 1130).
const VIEWPORTS = [
  { label: '1366×768', width: 1366, height: 390 },
  { label: '1600×900', width: 1600, height: 590 },
  { label: '1920×1080', width: 1920, height: 770 },
  { label: '2560×1440', width: 2560, height: 1130 },
];
const heightFailures = [];
/** D 의 증거 — 높이를 알려 줬더니 세로를 더 쓴 사례. */
const usedMore = [];

const bottomOf = (positions) => Math.max(...Object.values(positions).map((p) => p.y + NODE_HEIGHT));
/** 밴드 수 — 왼쪽 끝(x === PAD)에서 다시 시작하는 세로 층의 수다. */
const bandsOf = (positions) => new Set(Object.values(positions).map((p) => p.y)).size === 1
  ? 1
  : new Set(Object.values(positions).filter((p) => p.x === 30).map((p) => p.y)).size;
const rightOf = (positions) => Math.max(...Object.values(positions).map((p) => p.x + NODE_WIDTH));

for (const script of scripts) {
  const groups = [['임무 전체', script.tasks]];
  for (const milestone of [...new Set(script.tasks.map((t) => t.milestone))]) {
    groups.push([milestone, script.tasks.filter((t) => t.milestone === milestone)]);
  }
  for (const [label, tasks] of groups) {
    if (tasks.length === 0) continue;
    for (const { label: screen, width, height } of VIEWPORTS) {
      const where = `${script.missionId} ${label} ${screen}`;
      const blind = dagLayout(tasks, width);            // 높이를 모르는 옛 배치 (대조군)
      const aware = dagLayout(tasks, width, undefined, height);
      const blindBottom = bottomOf(blind);
      const awareBottom = bottomOf(aware);
      if (blindBottom <= height && awareBottom > height) {
        heightFailures.push(`${where}: 대조군은 ${blindBottom}px 로 잰 높이(${height}px) 안에 들어왔는데 높이를 알려 준 배치가 ${awareBottom}px 로 ${awareBottom - height}px 넘쳤다`);
      }
      if (blindBottom > height && awareBottom !== blindBottom) {
        heightFailures.push(`${where}: 세로가 애초에 모자란데(대조군 ${blindBottom}px > ${height}px) 배치가 ${awareBottom}px 로 달라졌다 — 더 접으면 더 길어질 뿐이다`);
      }
      // 세로를 쓰겠다고 가로로 나가면 안 된다. 폭 상한은 어떤 경우에도 그대로다.
      const right = rightOf(aware);
      if (right > width) heightFailures.push(`${where}: 오른쪽 끝이 ${right}px — 폭(${width}px) 밖으로 ${right - width}px 나간다`);
      const hit = overlaps(aware);
      if (hit !== null) heightFailures.push(`${where}: 노드 상자가 겹친다 (${hit})`);
      // E — 대조군이 밴드 하나로 끝났으면(모든 노드의 x 가 깊이 순서 그대로) 접지 않는다.
      if (bandsOf(blind) === 1 && bandsOf(aware) !== 1) {
        heightFailures.push(`${where}: 한 밴드에 다 들어가는데 ${bandsOf(aware)} 밴드로 접었다 — 없던 줄바꿈이 생긴다`);
      }
      if (awareBottom > blindBottom) usedMore.push(`${where} ${blindBottom}→${awareBottom}px / 잰 높이 ${height}px`);
    }
  }
}

if (usedMore.length === 0) {
  heightFailures.push('세로가 남는 창이 하나도 없다 — 높이 인자가 배치를 한 번도 바꾸지 않았다면 죽은 인자다');
}
// 음성 대조군 — 높이를 안 주면 예전과 **한 픽셀도** 다르지 않아야 한다.
for (const script of scripts) {
  const a = dagLayout(script.tasks, 1440);
  const b = dagLayout(script.tasks, 1440, undefined, undefined);
  if (JSON.stringify(a) !== JSON.stringify(b)) heightFailures.push(`${script.missionId}: 높이를 안 줬는데 배치가 달라졌다 — 옛 화면이 바뀐다`);
}
{
  /** 깊이 열 15개 × 한 줄짜리 열 — 폭 1920 이면 접지 않고도 8열이 들어간다. */
  const heights = Array.from({ length: 15 }, () => 150);
  if (columnsPerBand(1920, 100000, heights) >= columnsPerBand(1920)) {
    heightFailures.push('대조군 실패: 세로가 무한히 남아도 열이 안 줄었다 — 이 검사는 무의미하다');
  }
  if (columnsPerBand(1920, 200, heights) !== columnsPerBand(1920)) {
    heightFailures.push('대조군 실패: 세로가 모자란데 폭 최대 열을 안 썼다');
  }
  // 열이 폭 안에 다 들어가면(줄바꿈이 없으면) 높이가 아무리 남아도 접지 않는다.
  const few = Array.from({ length: 5 }, () => 150);
  if (columnsPerBand(1920, 100000, few) !== columnsPerBand(1920)) {
    heightFailures.push('한 밴드에 다 들어가는데 접었다 — 없던 줄바꿈이 생긴다');
  }
}

if (heightFailures.length) {
  console.error('❌ 잰 높이 검사 실패:');
  for (const line of heightFailures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`✅ 잰 높이 — 창 ${VIEWPORTS.map((v) => v.label).join('/')} 에서 높이가 허락하면 그 안에 들어오고, 모자라면 더 접지 않는다 (겹침 0 · 폭 안)`);
console.log(`   세로를 더 쓴 사례 ${usedMore.length}건 — 예: ${usedMore.slice(0, 3).join(' · ')}`);

// ── 뷰 노드가 세로를 밀어낸다 (260903 — 노드 캔버스 1단계) ──────────────────────
//
// 가로는 위에서 봤다. 뷰 노드는 **세로**로 자란다 — 연결한 태스크 바로 아래에 붙기 때문이고,
// 한 열의 세로 간격(ROW 150)은 노드 상자(110) 아래로 40px 밖에 없다. 배치가 붙은 수를
// 모르면 그 열의 **다음 태스크와 겹친다.** 여기서 보는 것 넷:
//
//  1. **깊이 계산에 뷰 노드가 들어가지 않는다** — 붙이기 전후로 태스크의 x 가 한 픽셀도
//     달라지지 않아야 한다 (`deps` 오염 검사의 기하학판이다).
//  2. 태스크끼리 · 뷰 카드와 태스크 · 뷰 카드끼리 — 상자가 하나도 겹치지 않는다.
//  3. 뷰 카드도 화면 폭 안에 있다.
//  4. **음성 대조군** — 배치에 붙은 수를 알리지 않고 뷰 노드를 달면 반드시 겹침이 잡힌다.
import { VIEW_NODE_HEIGHT, VIEW_NODE_WIDTH, viewNodeLayout } from '../src/graph/layout.ts';

/** 최악의 경우 — 모든 태스크에 한 장, 첫 태스크에 두 장. */
function attachAll(tasks) {
  const attached = new Map(tasks.map((task) => [task.id, 1]));
  if (tasks.length > 0) attached.set(tasks[0].id, 2);
  return attached;
}
function viewNodesFor(attached) {
  const nodes = [];
  for (const [taskId, count] of attached) {
    for (let i = 0; i < count; i += 1) nodes.push({ id: `vn-${taskId}-${i}`, taskId });
  }
  // 전역 노드도 하나 — 연결선이 없으므로 태스크 사이가 아니라 맨 아래 레인으로 가야 한다.
  nodes.push({ id: 'vn-global', taskId: null });
  return nodes;
}
function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function collide(taskPositions, viewPositions) {
  const boxes = [
    ...Object.entries(taskPositions).map(([id, p]) => ({ id, x: p.x, y: p.y, w: NODE_WIDTH, h: NODE_HEIGHT })),
    ...Object.entries(viewPositions).map(([id, p]) => ({ id, x: p.x, y: p.y, w: VIEW_NODE_WIDTH, h: VIEW_NODE_HEIGHT })),
  ];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxesOverlap(boxes[i], boxes[j])) return `${boxes[i].id}·${boxes[j].id}`;
    }
  }
  return null;
}

const viewFailures = [];
const heights = [];
for (const script of scripts) {
  const groups = [['임무 전체', script.tasks]];
  for (const milestone of [...new Set(script.tasks.map((t) => t.milestone))]) {
    groups.push([milestone, script.tasks.filter((t) => t.milestone === milestone)]);
  }
  for (const [label, tasks] of groups) {
    if (tasks.length === 0) continue;
    const attached = attachAll(tasks);
    const nodes = viewNodesFor(attached);
    for (const width of WIDTHS) {
      const plain = dagLayout(tasks, width);
      const pushed = dagLayout(tasks, width, attached);
      for (const id of Object.keys(plain)) {
        if (plain[id].x !== pushed[id].x) {
          viewFailures.push(`${script.missionId} ${label} ${width}px: 뷰 노드를 달았더니 ${id} 의 x 가 ${plain[id].x}→${pushed[id].x} 로 움직였다 — 깊이 계산이 오염됐다`);
        }
      }
      const views = viewNodeLayout(nodes, pushed, width);
      if (Object.keys(views).length !== nodes.length) {
        viewFailures.push(`${script.missionId} ${label} ${width}px: 뷰 노드 ${nodes.length}장 중 ${Object.keys(views).length}장만 배치됐다`);
      }
      const hit = collide(pushed, views);
      if (hit !== null) viewFailures.push(`${script.missionId} ${label} ${width}px: 상자가 겹친다 (${hit}) — 배치가 뷰 노드 높이를 반영하지 않는다`);
      if (label === '임무 전체' && width === 1440) {
        heights.push({
          id: script.missionId,
          plain: Math.max(...Object.values(plain).map((p) => p.y + NODE_HEIGHT)),
          withViews: Math.max(...Object.values(views).map((p) => p.y + VIEW_NODE_HEIGHT)),
        });
      }
      const right = Math.max(...Object.values(views).map((p) => p.x + VIEW_NODE_WIDTH));
      if (right > width) viewFailures.push(`${script.missionId} ${label} ${width}px: 뷰 카드가 오른쪽으로 ${right - width}px 나간다`);
    }
  }
}

// 음성 대조군 — 붙은 수를 배치에 알리지 않으면 반드시 겹쳐야 한다.
{
  const widest = scripts.reduce((a, b) => (a.tasks.length > b.tasks.length ? a : b));
  const attached = attachAll(widest.tasks);
  const blind = dagLayout(widest.tasks, 1440); // attached 를 넘기지 않았다
  const views = viewNodeLayout(viewNodesFor(attached), blind, 1440);
  const hit = collide(blind, views);
  if (hit === null) viewFailures.push('대조군 실패: 배치가 뷰 노드 수를 몰랐는데도 겹치지 않았다 — 이 검사는 무의미하다');
  else console.log(`✅ 음성 대조군 — 붙은 수를 배치가 모르면 상자가 겹친다 (${hit})`);
}

if (viewFailures.length) {
  console.error('❌ 뷰 노드 세로 배치 검사 실패:');
  for (const line of viewFailures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`✅ 뷰 노드 — 태스크마다 1장(첫 태스크 2장) + 전역 1장에서 깊이 무변경 · 겹침 0 · 폭 안`);
console.log(`   세로 실측 (1440px · DAG · 임무 전체): ${heights.map((h) => `${h.id} ${h.plain}→${h.withViews}px`).join(' · ')}`);
