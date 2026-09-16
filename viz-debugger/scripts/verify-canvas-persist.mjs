// 캔버스 구성 보존 (260903 — 노드 캔버스 1단계) — **놓아 둔 것이 사라지지 않는가.**
//
// `VZ-N-04` 는 「캔버스 구성은 마일스톤별로 보존되며 새로고침·재접속 후에도 유지되어야
// 한다」이다. 사용자가 만든 것이 조용히 사라지는 것이 이 화면에서 제일 나쁜 실패다.
//
// 여기서 보는 것 다섯:
//  1. **3층** — ② 사용자 구성 → ① 대본 기본 구성 → 빈 캔버스. 읽는 순서와 이기는 순서.
//  2. **슬롯** — 마일스톤마다 다른 구성이고 「임무 전체」는 별도 슬롯(`__mission__`)이다.
//     마일스톤을 옮겼다 돌아오면 그대로 있어야 한다.
//  3. **실패 셋** — 저장소 막힘 · 연결한 태스크 소실 · 스키마 변경 (지시서 §4).
//  4. **자동 배치가 다시 계산돼도 뷰 노드를 지우지 않는가** — 태스크의 `movedPositions` 는
//     보고 있는 태스크 집합이 바뀌면 버려진다(그 자리는 남의 자리가 되니 맞다). 뷰 노드는
//     사용자가 놓은 것이라 같이 버리면 "내가 만든 게 사라졌다"가 된다. **두 저장소가
//     분리돼 있는지**를 본다.
//
//     *(260904 — **판정 계기가 옮겨 갔다.** 예전에는 「DAG↔트리 전환」이 계기였는데 배치 모드
//     토글이 없어졌다(요구사항정의서 §7.10). **규칙은 그대로 살아야 한다** — 검사를 같이
//     지우면 폭이 바뀔 때 뷰 노드가 날아가는 회귀를 아무도 못 잡는다. 그래서 계기를
//     **「창 폭 변경 · 보기 범위(마일스톤↔임무 전체) 전환」**으로 옮겼다.)*
//  5. 음성 대조군 — 위 판정들이 실제로 실패를 잡는가.
//
// 규칙은 전부 `src/canvas/persist.ts` 의 순수 함수라 여기서 그대로 돌린다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANVAS_SCHEMA_VERSION,
  MISSION_SLOT,
  canvasKey,
  clearCanvas,
  emptyCanvas,
  loadCanvas,
  parseCanvas,
  reconcile,
  saveCanvas,
} from '../src/canvas/persist.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
/** 주석을 걷어낸 소스. 이 저장소의 주석은 「왜 layoutMode 가 아닌가」를 길게 적는다. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ 	]*\/\/.*$/gm, '');

const MISSION = 'MSN-260831-01';
const node = (id, taskId = 'T-11a', x = null, y = null) => ({ id, kind: 'device-risk', taskId, x, y });

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}
/** 사파리 비공개 창처럼 **접근 자체가 던지는** 저장소. */
function blockedStorage() {
  const boom = () => { throw new Error('저장소가 막혀 있다'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}
const noDefaults = () => null;
const withDefault = () => ({ version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-default'), node('vn-default-2')] });
const ids = (config) => config.nodes.map((item) => item.id).join(',');
const TASKS = new Set(['T-11a', 'T-11b']);

// ── ① 3층: ② → ① → 빈 캔버스 ─────────────────────────────────────────────────
{
  const storage = fakeStorage();
  const deps = { storage, defaults: withDefault };
  // 사용자 구성이 없으면 대본 기본 구성이 뜬다.
  const first = loadCanvas(MISSION, 'MS-C', TASKS, deps);
  check(first.source === 'default' && first.config.nodes.length === 2, `층 ①이 안 뜬다: ${first.source}`);
  // 사용자가 하나 놓으면 그것이 **항상** 이긴다.
  saveCanvas(MISSION, 'MS-C', { version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-mine')] }, deps);
  const second = loadCanvas(MISSION, 'MS-C', TASKS, deps);
  check(second.source === 'user' && ids(second.config) === 'vn-mine', `층 ②가 ①을 못 이긴다: ${second.source} ${ids(second.config)}`);
  // 층 ③ 되돌리기 — ②를 지우면 다시 ①이다.
  clearCanvas(MISSION, 'MS-C', deps);
  const third = loadCanvas(MISSION, 'MS-C', TASKS, deps);
  check(third.source === 'default' && third.config.nodes.length === 2, `되돌리기 뒤 층 ①로 안 간다: ${third.source}`);
  // 기본 구성도 없으면 빈 캔버스다. **던지지 않는다.**
  const bare = loadCanvas(MISSION, 'MS-C', TASKS, { storage, defaults: noDefaults });
  check(bare.source === 'empty' && bare.config.nodes.length === 0, `빈 캔버스가 아니다: ${bare.source}`);
  console.log('✅ 3층 — 사용자 구성 > 대본 기본 구성 > 빈 캔버스 · 되돌리기가 ②만 지운다');
}

// ── ② 슬롯: 마일스톤별 · 「임무 전체」는 따로 ──────────────────────────────────
{
  const deps = { storage: fakeStorage(), defaults: noDefaults };
  const keys = new Set([
    canvasKey(MISSION, 'MS-C'),
    canvasKey(MISSION, 'MS-D'),
    canvasKey(MISSION, MISSION_SLOT),
    canvasKey('MSN-260831-02', 'MS-C'),
  ]);
  check(keys.size === 4, '슬롯 키가 겹친다 — 다른 마일스톤·임무가 서로 덮는다');
  saveCanvas(MISSION, 'MS-C', { version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-c')] }, deps);
  saveCanvas(MISSION, MISSION_SLOT, { version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-all'), node('vn-all-2')] }, deps);
  // 마일스톤을 옮겼다(MS-D 는 비어 있다) 돌아온다.
  const away = loadCanvas(MISSION, 'MS-D', TASKS, deps);
  check(away.config.nodes.length === 0, 'MS-D 에 MS-C 의 구성이 새어 들어왔다');
  const back = loadCanvas(MISSION, 'MS-C', TASKS, deps);
  check(ids(back.config) === 'vn-c', `마일스톤을 옮겼다 돌아오니 구성이 사라졌다: ${ids(back.config)}`);
  const whole = loadCanvas(MISSION, MISSION_SLOT, TASKS, deps);
  check(whole.config.nodes.length === 2, '「임무 전체」 슬롯이 마일스톤 슬롯에 먹혔다');
  console.log('✅ 슬롯 — 마일스톤별로 나뉘고 「임무 전체」는 별도 슬롯. 옮겼다 돌아와도 산다');
}

// ── ③ 좌표가 새로고침을 넘는다 ────────────────────────────────────────────────
{
  const storage = fakeStorage();
  saveCanvas(MISSION, 'MS-C', { version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-moved', 'T-11a', 640, 320)] }, { storage, defaults: noDefaults });
  // 새로고침 = 같은 칸을 처음부터 다시 읽는 것.
  const again = loadCanvas(MISSION, 'MS-C', TASKS, { storage, defaults: noDefaults });
  const moved = again.config.nodes[0];
  check(moved.x === 640 && moved.y === 320, `옮긴 자리가 새로고침을 못 넘었다: ${JSON.stringify(moved)}`);
  console.log('✅ 새로고침 — 놓은 자리(좌표)까지 그대로 돌아온다');
}

// ── ④ 실패 1: 저장소가 막혀 있다 → 기본 구성으로 조용히 진행 ──────────────────
{
  for (const [label, storage] of [['없음', null], ['던짐', blockedStorage()]]) {
    const deps = { storage, defaults: withDefault };
    let load = null;
    try {
      load = loadCanvas(MISSION, 'MS-C', TASKS, deps);
    } catch (error) {
      failures.push(`저장소(${label})에서 적재가 던졌다: ${error.message}`);
      continue;
    }
    check(load.writable === false, `저장소(${label})인데 writable 이 true 다`);
    check(load.config.nodes.length === 2, `저장소(${label})에서 기본 구성으로 뜨지 않았다`);
    check(saveCanvas(MISSION, 'MS-C', emptyCanvas(), deps) === false, `저장소(${label})인데 저장이 성공했다고 답한다`);
    let cleared = true;
    try { clearCanvas(MISSION, 'MS-C', deps); } catch { cleared = false; }
    check(cleared, `저장소(${label})에서 되돌리기가 던졌다`);
  }
  console.log('✅ 실패 1 — 저장소가 없거나 던져도 기본 구성으로 뜨고, 저장 실패를 숨기지 않는다');
}

// ── ⑤ 실패 2: 연결한 태스크가 사라졌다 → 지우지 않고 전역으로 강등 ─────────────
{
  const config = { version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-live', 'T-11a'), node('vn-orphan', 'T-99z'), node('vn-global', null)] };
  const settled = reconcile(config, TASKS);
  check(settled.config.nodes.length === 3, '태스크가 사라졌다고 뷰 노드를 지웠다 — 지우면 안 된다');
  const orphan = settled.config.nodes.find((item) => item.id === 'vn-orphan');
  check(orphan.taskId === null, '사라진 태스크에 붙은 노드가 전역으로 강등되지 않았다');
  check(settled.config.nodes.find((item) => item.id === 'vn-live').taskId === 'T-11a', '살아 있는 연결까지 끊었다');
  check(settled.notices.length === 1 && settled.notices[0].includes('T-99z'), `사유 한 줄에 사라진 태스크 id 가 없다: ${settled.notices[0]}`);
  // 적재 도중의 빈 목록에 반응해 강등하면 그 강등이 그대로 저장돼 되돌릴 수 없다.
  const guarded = reconcile(config, new Set());
  check(guarded.config.nodes.every((item, index) => item.taskId === config.nodes[index].taskId), '태스크 목록이 비었을 때도 강등했다 — 적재 도중에 연결이 다 끊긴다');
  console.log('✅ 실패 2 — 사라진 태스크의 노드는 지우지 않고 전역으로 강등 + 사유 한 줄 (빈 목록에는 반응하지 않는다)');
}

// ── ⑥ 실패 3: 스키마가 바뀌었다 → 버리고 기본 구성 + 한 줄 안내 ────────────────
{
  const cases = [
    ['옛 판', JSON.stringify({ version: 99, nodes: [node('vn-old')] })],
    ['깨진 JSON', '{nodes:'],
    ['모양이 다름', JSON.stringify({ version: CANVAS_SCHEMA_VERSION, nodes: 'nope' })],
  ];
  for (const [label, raw] of cases) {
    const parsed = parseCanvas(raw);
    check(parsed.config === null, `${label}: 버리지 않았다`);
    check(typeof parsed.notice === 'string' && parsed.notice.length > 0, `${label}: 한 줄 안내가 없다 — 조용히 사라지면 안 된다`);
  }
  // 성한 것은 그대로 읽힌다. 알 수 없는 종류(다른 빌드에서 만든 것)도 버리지 않고, 망가진 한 칸만 거른다.
  const good = parseCanvas(JSON.stringify({
    version: CANVAS_SCHEMA_VERSION,
    nodes: [node('vn-a'), { ...node('vn-b'), kind: 'unknown-kind' }, { id: 'broken' }],
  }));
  check(good.config !== null && ids(good.config) === 'vn-a,vn-b', `성한 구성을 못 읽거나 망가진 한 칸을 안 걸렀다: ${good.config === null ? 'null' : ids(good.config)}`);
  // 저장된 것이 없으면 안내도 없다 — 첫 방문에 경고가 뜨면 안 된다.
  check(parseCanvas(null).notice === null, '저장된 것이 없는데 안내가 뜬다');
  console.log('✅ 실패 3 — 판이 다르거나 깨졌으면 버리고 한 줄로 알린다. 성한 구성과 첫 방문은 조용하다');
}

// ── ⑦ 자동 배치가 다시 계산돼도 뷰 노드가 살아 있다 (두 저장소의 분리) ─────────
//
// **260904 — 계기가 바뀌었다.** 배치 모드 토글(DAG/트리)이 없어지면서 옛 계기가 사라졌지만
// 규칙은 그대로다: **자동 배치가 다시 계산돼도 사용자가 놓은 뷰 노드는 안 지워진다.**
// 이제 그 계기는 둘이다.
//
//   가. **창 폭(·높이) 변경** — 접기가 다시 계산된다. 여기서 뷰 노드가 날아가면
//       창을 줄였다 늘린 것만으로 "내가 만든 게 사라졌다"가 된다. **이 검사를 지우면
//       그 회귀를 아무도 못 잡는다.**
//   나. **보기 범위 전환**(마일스톤 ↔ 임무 전체) — 태스크 집합이 통째로 달라진다.
//       태스크의 이동 위치는 여기서 버려지는 것이 맞고(남의 자리가 된다), 뷰 노드는
//       **슬롯이 다르므로 각자 자기 자리에 그대로 남아** 돌아오면 다시 보여야 한다.
{
  /** 뷰 노드 저장소가 화면 크기를 아는가 — 알면 폭이 바뀔 때 같이 버려질 길이 생긴다. */
  const knowsViewport = (source) => /layoutWidth|layoutHeight|availableWidth|availableHeight|innerWidth/.test(source);
  for (const file of ['persist.ts', 'useCanvas.ts', 'defaults.ts']) {
    check(!knowsViewport(read('src', 'canvas', file)), `src/canvas/${file} 이 화면 크기를 안다 — 뷰 노드 저장소가 창 크기에 묶이면 폭이 바뀔 때 사라진다`);
  }
  const graph = read('src', 'graph', 'TaskGraph.tsx');
  // 가 — 창 크기는 **초기화 계기가 아니다.** 태스크의 이동조차 폭·높이로는 안 버린다.
  const resetDeps = [...graph.matchAll(/setMovedPositions\(\{\}\),\s*\[([^\]]*)\]/g)].map((hit) => hit[1]);
  check(resetDeps.length === 1, `실행 노드 이동 초기화가 ${resetDeps.length}곳이다 — 계기는 하나여야 한다`);
  if (resetDeps.length === 1) {
    check(!/layoutWidth|layoutHeight/.test(resetDeps[0]), `창 크기가 실행 노드 이동 초기화의 계기다 (${resetDeps[0]}) — 창을 줄였다 늘리면 노드가 제자리로 돌아간다`);
    // 나 — 보고 있는 태스크 집합이 바뀌면 버린다. 그 자리는 남의 자리가 된다.
    check(/taskSetKey/.test(resetDeps[0]), `실행 노드 이동 초기화의 계기가 태스크 집합이 아니다 (${resetDeps[0]})`);
  }
  check(/const taskSetKey = tasks\.map\(/.test(graph), '태스크 집합 키가 id 목록에서 나오지 않는다 — 배열 정체성만 바뀌어도 되돌아간다');
  // 뷰 노드의 좌표는 저장된 값이 이긴다. 폭이 바뀌어도 초기화 대상이 아니다.
  check(graph.includes('node.x !== null && node.y !== null'), '뷰 노드가 저장된 좌표를 쓰지 않는다');
  const resetsViews = /setViewDrag\([^)]*\),\s*\[(layoutWidth|layoutHeight|taskSetKey)\]/.test(graph);
  check(!resetsViews, '뷰 노드 상태가 폭 변경·범위 전환에서 초기화된다');
  // 배치 모드는 정말 없어졌는가 — 남아 있으면 옛 계기가 조용히 살아 있는 것이다.
  check(!/layoutMode/.test(stripComments(graph)), 'TaskGraph 에 layoutMode 가 남았다 — 토글은 없어졌다 (§7.10)');
  check(!/layoutMode/.test(stripComments(read('src', 'main.tsx'))), 'main.tsx 에 layoutMode 가 남았다 — 토글은 없어졌다 (§7.10)');

  // 나 — **범위 전환은 슬롯이 다르다.** 마일스톤에서 만든 것이 임무 전체로 새지 않고,
  //      돌아오면 그대로 있다. (②가 슬롯 분리를 보고, 여기서는 왕복을 본다.)
  {
    const deps = { storage: fakeStorage(), defaults: noDefaults };
    saveCanvas(MISSION, 'MS-C', { version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-in-milestone')] }, deps);
    const whole = loadCanvas(MISSION, MISSION_SLOT, TASKS, deps);
    check(whole.config.nodes.length === 0, '범위를 「임무 전체」로 바꿨더니 마일스톤의 뷰 노드가 새어 들어왔다');
    saveCanvas(MISSION, MISSION_SLOT, { version: CANVAS_SCHEMA_VERSION, nodes: [node('vn-in-mission')] }, deps);
    const back = loadCanvas(MISSION, 'MS-C', TASKS, deps);
    check(ids(back.config) === 'vn-in-milestone', `범위를 바꿨다 돌아오니 뷰 노드가 사라졌다: ${ids(back.config)}`);
  }

  // 음성 대조군 둘 — 판정이 실제로 잡는가.
  if (!knowsViewport('const cols = columnsPerBand(layoutWidth);')) {
    failures.push('대조군 실패: 화면 크기를 아는 소스를 판정이 놓쳤다 — 이 검사는 무의미하다');
  }
  if (!/layoutWidth|layoutHeight/.test('attached, tasks, layoutWidth')) {
    failures.push('대조군 실패: 창 크기를 계기로 삼은 의존 배열을 판정이 놓쳤다');
  }
  console.log('✅ 자동 배치 재계산 — 뷰 노드 저장소는 창 크기를 모르고, 폭 변경은 실행 노드 이동조차 되돌리지 않는다');
  console.log('✅ 보기 범위 전환 — 슬롯이 달라 새지 않고, 돌아오면 그대로 있다 (배치 모드 토글은 없어졌다)');
}

if (failures.length) {
  console.error('❌ 캔버스 구성 보존 검사 실패:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
// ── 크기도 좌표와 같은 자리에 남는다 (260911 지시 4) ────────────────────────
//
// 파워포인트처럼 테두리를 끌어 노드 크기를 바꾼다. 그 값이 좌표와 **다른 자리**에 있으면
// 옮기고 나서 크기를 바꿨을 때 새로고침 뒤 크기만 사라진다.
//
// **이미 저장된 구성에는 이 칸이 없다.** 그것을 「못 읽는 것」으로 치면 사람이 짜 둔 배치가
// 통째로 날아간다 — 크기는 있어도 되고 없어도 된다.
{
  const withSize = parseCanvas(JSON.stringify({
    version: CANVAS_SCHEMA_VERSION,
    nodes: [{ id: 'vn-1', kind: 'control', taskId: null, x: 10, y: 20, w: 260, h: 154 }],
  }));
  const node = withSize.config?.nodes[0];
  if (node?.w !== 260 || node?.h !== 154) failures.push(`크기를 안 읽는다 — ${JSON.stringify(node)}`);

  // 크기 칸이 없는 옛 구성도 그대로 읽힌다.
  const legacy = parseCanvas(JSON.stringify({
    version: CANVAS_SCHEMA_VERSION,
    nodes: [{ id: 'vn-2', kind: 'control', taskId: null, x: 10, y: 20 }],
  }));
  if (legacy.config?.nodes.length !== 1) failures.push('크기 칸이 없는 옛 구성을 버린다 — 짜 둔 배치가 날아간다');

  // 말이 안 되는 크기는 버린다 — 0이나 음수면 노드가 사라져 보인다.
  const bad = parseCanvas(JSON.stringify({
    version: CANVAS_SCHEMA_VERSION,
    nodes: [{ id: 'vn-3', kind: 'control', taskId: null, x: 0, y: 0, w: 0, h: -5 }],
  }));
  if (bad.config?.nodes.length !== 0) failures.push('0이나 음수 크기를 받아들인다 — 노드가 사라져 보인다');

  // 훅에 저장하는 길이 있는가 — 화면만 바뀌고 안 남으면 새로고침에 사라진다.
  const hook = readFileSync(join(root, 'src', 'canvas', 'useCanvas.ts'), 'utf8');
  if (!/resize\(id: string, size:/.test(hook)) failures.push('캔버스 훅에 크기를 저장하는 길이 없다');
}

console.log('✅ 크기가 좌표와 같은 자리에 남는다 — 옛 구성(크기 없음)도 그대로 읽고, 0·음수는 버린다');
console.log(`✅ 통과 — 캔버스 구성 3층 · 슬롯 · 실패 셋 · 창 폭 변경·보기 범위 전환 (스키마 v${CANVAS_SCHEMA_VERSION})`);
