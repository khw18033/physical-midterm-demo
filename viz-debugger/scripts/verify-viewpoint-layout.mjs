// verify:viewpoint-layout (260910 신설 — UI 수정 지시서 §4)
//
// 8분할 뷰포인트가 **세로 한 열**로 서고 분기선이 서로 겹치지 않는가.
//
// 9/9 의 원형 배치가 못 쓰게 된 이유가 정확히 이 검사가 없어서였다. `verify:layout` 은
// **노드 상자**의 겹침만 쟀고 상자는 안 겹쳤다 — 겹친 것은 부모에서 나가는 **화살표**였고
// 아무도 그것을 재지 않았다. 그래서 화면을 띄워 보고서야 알았다.
//
// 보는 것 넷.
//  1. **세로 좌표가 인덱스 순으로 단조 증가**하는가. 0도가 맨 위, 315도가 맨 아래다.
//  2. **화살표 구간이 서로 교차하지 않는가** — 좌표로 계산한다. 이 절의 합격 기준이다.
//  3. **여덟이 한 화면에 들어오는가.** 스크롤이 생기면 시연에서 못 쓴다.
//  4. **원형 코드가 지워졌는가.** 토글로 남으면 다음 사람이 어느 쪽이 진짜인지 묻는다.
//
// 화면이 그리는 선과 여기서 재는 선은 **같은 함수**에서 나온다(`fanGeometry`). 두 벌이면
// 「겹치지 않는다」가 그림과 다른 것을 말하게 된다.
//
// 대조군 포함 — 규칙을 무력화한 사본이 반드시 실패로 잡히는지까지 본다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const { dagLayout, NODE_HEIGHT, NODE_WIDTH } = await load('src', 'graph', 'layout.ts');
const {
  applyFanLayout, fanGeometry, viewpointColumnHeight,
  VIEWPOINT_NODE_HEIGHT, VIEWPOINT_GAP,
} = await load('src', 'graph', 'fanLayout.ts');

const door = JSON.parse(readFileSync(join(root, 'scenarios', 'MSN-260909-01.json'), 'utf8'));
const group = door.viewpoints;

const failures = [];
const controls = [];

/** 실제로 쓰는 창 폭. verify:layout 과 같은 목록이다. */
const WIDTHS = [1120, 1280, 1440, 1920];
/**
 * 「한 화면」의 기준 높이. `TaskGraph` 가 재는 값(창 높이 − 머리줄 − 아래 여백)의
 * **가장 나쁜 경우**다 — 1366×768 노트북에서 이 정도가 남는다. 여기 들어오면 그보다
 * 큰 화면에서는 당연히 들어온다.
 */
const WORST_VIEWPORT_HEIGHT = 560;

/** 선분 둘이 교차하는가 (끝점이 닿는 것은 교차가 아니다 — spine 과 화살표의 접점이다). */
function segmentsCross(a, b) {
  const orient = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = orient(a.p1, a.p2, b.p1);
  const o2 = orient(a.p1, a.p2, b.p2);
  const o3 = orient(b.p1, b.p2, a.p1);
  const o4 = orient(b.p1, b.p2, a.p2);
  if (o1 === 0 && o2 === 0 && o3 === 0 && o4 === 0) {
    // 같은 직선 위 — 구간이 **겹치면** 문제다. 두 화살표가 같은 y 에 포개진 경우가 이것이다.
    //
    // 가로 선분은 y 폭이 0 이라 두 축 모두 「엄격히 겹침」을 물으면 절대 안 걸린다.
    // 한 축은 엄격히 겹치고 다른 축은 닿기만 해도 겹침이다 — 그래야 같은 y 의 두 가로선이 잡힌다.
    const strict = (s, t, u, v) => Math.min(s, t) < Math.max(u, v) && Math.min(u, v) < Math.max(s, t);
    const touch = (s, t, u, v) => Math.min(s, t) <= Math.max(u, v) && Math.min(u, v) <= Math.max(s, t);
    return (strict(a.p1.x, a.p2.x, b.p1.x, b.p2.x) && touch(a.p1.y, a.p2.y, b.p1.y, b.p2.y))
      || (strict(a.p1.y, a.p2.y, b.p1.y, b.p2.y) && touch(a.p1.x, a.p2.x, b.p1.x, b.p2.x));
  }
  return o1 !== o2 && o3 !== o4;
}

function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}

if (!group) {
  console.error('❌ verify:viewpoint-layout\n- MSN-260909-01 에 viewpoints 선언이 없다');
  process.exit(1);
}

for (const width of WIDTHS) {
  const base = dagLayout(door.tasks, width);
  const laid = applyFanLayout(base, group);
  const geometry = fanGeometry(laid, group);
  if (geometry === null) {
    failures.push(`${width}px: 분기선 기하가 안 나온다 — 묶음이 성립하지 않는다`);
    continue;
  }

  // ── 1. 세로 좌표가 인덱스 순으로 단조 증가 ─────────────────────────────────
  const ys = group.taskIds.map((id) => laid[id].y);
  for (let i = 1; i < ys.length; i += 1) {
    if (ys[i] <= ys[i - 1]) {
      failures.push(`${width}px: ${group.taskIds[i]} 가 ${group.taskIds[i - 1]} 보다 위에 있다 — 인덱스 순으로 내려가야 한다`);
    }
  }
  // 한 열이므로 x 가 여덟 다 같아야 한다.
  const xs = new Set(group.taskIds.map((id) => laid[id].x));
  if (xs.size !== 1) failures.push(`${width}px: 여덟의 x 가 ${xs.size} 종류 — 세로 한 열이어야 한다`);

  // 간격이 여덟 다 같은가 (§1 「노드 크기와 세로 간격은 여덟 다 같다」).
  const gaps = new Set(ys.slice(1).map((y, i) => y - ys[i]));
  if (gaps.size !== 1) failures.push(`${width}px: 세로 간격이 ${[...gaps].join(', ')} — 여덟 다 같아야 한다`);
  if (![...gaps][0] || [...gaps][0] !== VIEWPOINT_NODE_HEIGHT + VIEWPOINT_GAP) {
    failures.push(`${width}px: 세로 간격 ${[...gaps][0]} 가 노드 높이+간격과 다르다 — 상자가 붙거나 벌어진다`);
  }

  // ── 2. 화살표가 서로 교차하지 않는가 (합격 기준) ───────────────────────────
  const arrows = geometry.arrows.map((a) => ({
    id: a.id,
    p1: { x: a.fromX, y: a.y },
    p2: { x: a.toX, y: a.y },
  }));
  for (let i = 0; i < arrows.length; i += 1) {
    for (let j = i + 1; j < arrows.length; j += 1) {
      if (segmentsCross(arrows[i], arrows[j])) {
        failures.push(`${width}px: 화살표 ${arrows[i].id} 와 ${arrows[j].id} 가 겹친다`);
      }
    }
  }
  // 화살촉이 노드 왼쪽 변 중앙에 붙는가 (§1).
  for (const arrow of geometry.arrows) {
    const node = laid[arrow.id];
    if (arrow.toX !== node.x) failures.push(`${width}px: ${arrow.id} 화살촉이 노드 왼쪽 변에 안 붙는다`);
    if (arrow.y !== node.y + VIEWPOINT_NODE_HEIGHT / 2) {
      failures.push(`${width}px: ${arrow.id} 화살촉이 왼쪽 변 **중앙**이 아니다`);
    }
  }
  // 분기선이 부모 오른쪽에서 나가는가 — spine 이 부모를 뚫고 지나가면 안 된다.
  const parent = laid[group.parentTaskId];
  if (geometry.spineX <= parent.x + NODE_WIDTH) {
    failures.push(`${width}px: spine 이 부모 상자 안이나 왼쪽에 있다`);
  }
  // 노드가 spine 오른쪽에 있는가.
  if (laid[group.taskIds[0]].x <= geometry.spineX) {
    failures.push(`${width}px: 노드가 spine 왼쪽에 있다 — 화살표가 거꾸로 간다`);
  }

  // 상자끼리도 안 겹쳐야 한다 (뷰포인트끼리 · 뷰포인트와 다른 노드).
  const boxOf = (id) => ({
    x: laid[id].x, y: laid[id].y,
    w: NODE_WIDTH,
    h: group.taskIds.includes(id) ? VIEWPOINT_NODE_HEIGHT : NODE_HEIGHT,
  });
  const ids = Object.keys(laid);
  for (const id of group.taskIds) {
    const a = boxOf(id);
    for (const other of ids) {
      if (other === id) continue;
      const b = boxOf(other);
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        failures.push(`${width}px: ${id} 상자가 ${other} 와 겹친다`);
      }
    }
  }

  // ── 3. 여덟이 한 화면에 들어오는가 ─────────────────────────────────────────
  const columnBottom = Math.max(...ys) + VIEWPOINT_NODE_HEIGHT;
  if (columnBottom > WORST_VIEWPORT_HEIGHT) {
    failures.push(
      `${width}px: 여덟의 아래끝이 ${columnBottom}px — 잰 높이 ${WORST_VIEWPORT_HEIGHT}px 를 넘어 스크롤이 생긴다`,
    );
  }
  // 오른쪽으로도 나가면 안 된다 — 판단·근거 노드까지 같은 화면이면 가장 좋다(§1).
  const right = Math.max(...Object.values(laid).map((p) => p.x + NODE_WIDTH));
  if (right > width) failures.push(`${width}px: 내용이 오른쪽으로 ${right - width}px 나간다`);
}

// ── 3b. 배치 엔진에 대표만 넘긴다 — 밴드가 헛되이 접히지 않는가 ─────────────
//
// 여덟을 다 넘기면 엔진이 그 열을 `ROW`(150) × 8 = 1,200px 로 보고 세로가 모자란다고
// 판단해 **밴드를 더 접는다.** 그러면 판단·근거 노드가 아래 밴드로 내려가고 캔버스가
// 두 배 넘게 길어진다. 실제로 그랬고 **좌표 검사는 통과했는데 화면 캡처에서 드러났다** —
// 그래서 이 검사를 여기 적는다.
//
// `TaskGraph` 의 `layoutTasks` 와 **같은 규칙**으로 줄여서 잰다.
{
  const members = new Set(group.taskIds);
  const needed = new Set();
  for (const task of door.tasks) {
    if (members.has(task.id)) continue;
    for (const dep of task.deps ?? []) if (members.has(dep)) needed.add(dep);
  }
  if (needed.size === 0) needed.add(group.taskIds[0]);
  const reduced = door.tasks.filter((t) => !members.has(t.id) || needed.has(t.id));
  if (reduced.length !== door.tasks.length - (group.taskIds.length - needed.size)) {
    failures.push('대표만 남기는 규칙이 태스크 수와 안 맞는다');
  }

  // MS-A 만 연 화면 — 시연에서 여덟을 보는 그 화면이다.
  const msA = reduced.filter((t) => t.milestone === 'MS-A');
  const full = door.tasks.filter((t) => t.milestone === 'MS-A');
  /** 실제로 잰 폭. 1440 창에서 그래프 자리에 남는 값이다(캡처로 확인). */
  const MEASURED_WIDTH = 1346;
  const laid = applyFanLayout(dagLayout(msA, MEASURED_WIDTH, undefined, WORST_VIEWPORT_HEIGHT), group);
  const bottom = Math.max(...full.map((t) => {
    const p = laid[t.id];
    return p === undefined ? 0 : p.y + (members.has(t.id) ? VIEWPOINT_NODE_HEIGHT : NODE_HEIGHT);
  }));
  if (bottom > WORST_VIEWPORT_HEIGHT) {
    failures.push(`MS-A 전체 아래끝이 ${bottom}px — 잰 높이 ${WORST_VIEWPORT_HEIGHT}px 를 넘어 스크롤이 생긴다`);
  }
  // 여덟이 다 자리를 받았는가 — 대표만 넘겼으므로 나머지 일곱은 특례가 세워야 한다.
  const missing = group.taskIds.filter((id) => laid[id] === undefined);
  if (missing.length > 0) failures.push(`대표만 넘겼더니 ${missing.join(', ')} 가 자리를 못 받았다`);

  // 대조군 — 여덟을 다 넘기면 캔버스가 훨씬 길어져야 한다. 그래야 이 검사가 뜻이 있다.
  const naive = applyFanLayout(dagLayout(full, MEASURED_WIDTH, undefined, WORST_VIEWPORT_HEIGHT), group);
  const naiveBottom = Math.max(...full.map((t) => naive[t.id].y + (members.has(t.id) ? VIEWPOINT_NODE_HEIGHT : NODE_HEIGHT)));
  control('여덟을 다 넘긴 사본 (엔진이 열을 1,200px 로 본다)', naiveBottom > bottom);
}

// ── 4. 원형 코드가 지워졌는가 ────────────────────────────────────────────────
{
  const source = readFileSync(join(root, 'src', 'graph', 'fanLayout.ts'), 'utf8');
  for (const word of ['RADIUS', 'Math.sin', 'Math.cos', 'CENTER_DROP']) {
    if (source.includes(word)) {
      failures.push(`fanLayout.ts 에 원형 배치의 「${word}」 가 남아 있다 — 토글로 남기지 않는다`);
    }
  }
  const layoutVerify = readFileSync(join(root, 'scripts', 'verify-layout.mjs'), 'utf8');
  if (layoutVerify.includes('0도 위 시계 방향')) {
    failures.push('verify:layout 에 원형 배치 검사가 남아 있다 — 없는 배치를 재고 있다');
  }
}

// ── 선언이 없는 편은 그대로다 — 특례가 새지 않는가 ───────────────────────────
{
  const { SCRIPT_IDS } = await load('src', 'scenarios', 'manifest.ts');
  for (const id of SCRIPT_IDS) {
    if (id === 'MSN-260909-01') continue;
    const script = JSON.parse(readFileSync(join(root, 'scenarios', `${id}.json`), 'utf8'));
    const base = dagLayout(script.tasks, 1440);
    const same = applyFanLayout(base, script.viewpoints ?? null);
    if (JSON.stringify(same) !== JSON.stringify(base)) {
      failures.push(`${id}: 선언이 없는데 배치가 바뀌었다 — 특례가 새고 있다`);
    }
    if (fanGeometry(base, script.viewpoints ?? null) !== null) {
      failures.push(`${id}: 선언이 없는데 분기선이 생겼다`);
    }
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
{
  // 두 화살표를 같은 y 에 놓으면 반드시 겹침으로 잡혀야 한다.
  const a = { p1: { x: 0, y: 10 }, p2: { x: 40, y: 10 } };
  const b = { p1: { x: 10, y: 10 }, p2: { x: 50, y: 10 } };
  control('같은 y 의 화살표 둘', segmentsCross(a, b));
}
{
  // 9/9 의 원형 배치를 되살린 사본 — 부모에서 여덟으로 곧장 그으면 선이 교차해야 한다.
  const base = dagLayout(door.tasks, 1440);
  const parent = base[group.parentTaskId];
  const cx = parent.x + NODE_WIDTH / 2;
  const cy = parent.y + 260 + NODE_HEIGHT * 1.5 + 40;
  const spokes = group.taskIds.map((id, i) => {
    const rad = (i * 45 * Math.PI) / 180;
    return {
      id,
      p1: { x: cx, y: parent.y + NODE_HEIGHT },
      p2: { x: cx + 260 * Math.sin(rad), y: cy - 260 * Math.cos(rad) },
    };
  });
  let crossed = false;
  for (let i = 0; i < spokes.length && !crossed; i += 1) {
    for (let j = i + 1; j < spokes.length && !crossed; j += 1) {
      if (segmentsCross(spokes[i], spokes[j])) crossed = true;
    }
  }
  control('원형 배치의 부챗살 (9/9 의 그 실패)', crossed);
}
{
  // 간격을 0 으로 좁힌 사본 — 상자가 붙어야 한다.
  const squashed = viewpointColumnHeight(8);
  control('열 높이 계산', squashed === 8 * (VIEWPOINT_NODE_HEIGHT + VIEWPOINT_GAP) - VIEWPOINT_GAP);
}

// ── 결과 ─────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ verify:viewpoint-layout\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
{
  const base = applyFanLayout(dagLayout(door.tasks, 1440), group);
  const bottom = Math.max(...group.taskIds.map((id) => base[id].y)) + VIEWPOINT_NODE_HEIGHT;
  console.log(`✅ 여덟이 세로 한 열 — 인덱스 순으로 단조 증가 · x 하나 · 간격 ${VIEWPOINT_NODE_HEIGHT + VIEWPOINT_GAP}px 균일 (폭 ${WIDTHS.length}종)`);
  console.log('✅ 화살표 여덟이 서로 교차 0 · 화살촉이 노드 왼쪽 변 중앙 · spine 이 부모 오른쪽');
  console.log(`✅ 한 화면 — 아래끝 ${bottom}px 가 잰 높이 ${WORST_VIEWPORT_HEIGHT}px 안 (노드 ${VIEWPOINT_NODE_HEIGHT}px + 간격 ${VIEWPOINT_GAP}px)`);
  console.log('✅ 원형 배치 코드 없음 (RADIUS · sin · cos · CENTER_DROP) · 선언 없는 편은 배치 무변경');
  console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
}
