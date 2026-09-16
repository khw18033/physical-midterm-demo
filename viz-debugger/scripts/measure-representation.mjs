// 표현 방식 실측 — **검사가 아니라 산출물이다** (260904).
//
// 회의록 §10의 「그래프 형태 vs 트리 형태」 미결이 **그래프로** 닫혔다. 근거는 회의록
// 자신에게 있다 — §4-3이 요구한 「여러 갈래가 다시 하나의 박스로 모이는 형태」가 곧 합류이고,
// 부모가 하나뿐인 것이 트리의 정의라 **트리는 합류를 표현할 수 없다**(요구사항정의서 §7.10).
//
// 그 결론을 주장이 아니라 **숫자로** 낸다. 이 스크립트가 논문 §3-2 요인 ①의 산출물이고,
// 요구사항정의서 §7.10 과 `논문진행_디버깅가시화_260826.md` §3-2 의 표가 이 출력이다.
//
// **`treeLayout()` 을 화면이 아니라 여기서 부른다.** 그것이 이 파일이 있는 이유의 절반이다 —
// 함수는 지우지 않고 호출부만 화면에서 `scripts/` 로 옮겼다. `verify-layout.mjs` 가 이미
// `layout.ts` 를 Node 에서 직접 import 해 돌리고 있어 같은 패턴이다.
//
// 재는 것 넷 (대본마다):
//   노드 수 · 합류 · 되돌아감 · 트리로 펼쳤을 때 노드 수(배수)
//
// 그리고 참고로 **두 배치를 같은 폭에서 실제로 돌려** 세로가 얼마나 되는지 함께 낸다.
// 표현 비용은 노드 수만이 아니라 화면에서 차지하는 자리이기도 하기 때문이다.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dagLayout, treeLayout, NODE_HEIGHT } from '../src/graph/layout.ts';
import { graphShape, treeExpansion } from '../src/graph/shape.ts';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * 대본 넷. 앞의 하나는 HCI 전달본(`MSN-260826-01`)이라 `SCRIPT_IDS` 목록에는 없지만
 * **표현 비교에는 들어간다** — 교수님께 실제로 보여 드린 화면이 그것이기 때문이다.
 */
const SCRIPTS = ['MSN-260826-01', 'MSN-260831-01', 'MSN-260831-02', 'MSN-260831-03'];

/**
 * 요구사항정의서 §7.10 · 논문 §3-2 에 적힌 값. **어긋나면 문서가 거짓이 된다** —
 * 대본이 바뀌었으면 문서도 같이 고쳐야 하므로 여기서 알린다.
 */
const DOCUMENTED = {
  'MSN-260826-01': { nodes: 7, merges: 1, loops: 0, tree: 11 },
  'MSN-260831-01': { nodes: 17, merges: 1, loops: 0, tree: 31 },
  'MSN-260831-02': { nodes: 18, merges: 0, loops: 1, tree: 18 },
  'MSN-260831-03': { nodes: 16, merges: 0, loops: 0, tree: 16 },
};

/** 참고 측정에 쓰는 폭. 실제로 쓰는 외부 모니터다. */
const WIDTH = 1440;

const rows = [];
const drift = [];

for (const id of SCRIPTS) {
  const script = JSON.parse(await readFile(join(root, 'scenarios', `${id}.json`), 'utf8'));
  const tasks = script.tasks;
  const shape = graphShape(tasks, script.refEdges ?? []);
  const tree = treeExpansion(tasks);
  const ratio = tree / shape.nodes;

  // **여기가 `treeLayout()` 의 호출부다.** 화면이 아니라 이 도구가 부른다.
  const bottom = (positions) => Math.max(...Object.values(positions).map((p) => p.y + NODE_HEIGHT));
  const dagHeight = bottom(dagLayout(tasks, WIDTH));
  const treeHeight = bottom(treeLayout(tasks, WIDTH));

  rows.push({ id, ...shape, tree, ratio, dagHeight, treeHeight });

  const expected = DOCUMENTED[id];
  if (expected === undefined) continue;
  for (const [key, value] of [['nodes', shape.nodes], ['merges', shape.merges], ['loops', shape.loops], ['tree', tree]]) {
    if (expected[key] !== value) drift.push(`${id} ${key}: 문서 ${expected[key]} · 실측 ${value}`);
  }
}

const pad = (text, width) => String(text).padStart(width);

console.log('표현 방식 실측 — 우리 임무 데이터에서 트리가 무엇을 잃는가');
console.log('');
console.log('대본             노드   합류  되돌아감   트리로 펼치면');
console.log('─────────────────────────────────────────────────────────────');
for (const row of rows) {
  const expanded = row.loops > 0 && row.ratio === 1
    ? `${pad(row.tree, 2)} (×${row.ratio.toFixed(2)}) — 되돌아감 표현 불가`
    : `${pad(row.tree, 2)} (×${row.ratio.toFixed(2)})`;
  console.log(`${row.id}  ${pad(row.nodes, 4)}  ${pad(row.merges, 4)}  ${pad(row.loops, 6)}   ${expanded}`);
}
console.log('');
console.log('합류가 있으면 트리는 그 아래를 경로 수만큼 복제한다 — 부모가 하나뿐인 것이 트리의');
console.log('정의이기 때문이다. 되돌아감은 복제로도 표현되지 않는다(×1.00 인데 잃는다).');
console.log('배수 ×1.00 이면서 합류·되돌아감이 없는 편은 두 표현이 구조적으로 **완전히 같다** —');
console.log('화면에 배치 모드 토글을 둬도 그 편에서는 아무 일도 하지 않았다는 뜻이다.');
console.log('');
console.log(`참고 — 같은 폭(${WIDTH}px)에서 두 배치를 실제로 돌렸을 때의 세로:`);
for (const row of rows) {
  console.log(`  ${row.id}  DAG ${pad(row.dagHeight, 5)}px  ·  트리 ${pad(row.treeHeight, 5)}px  (×${(row.treeHeight / row.dagHeight).toFixed(2)})`);
}

if (drift.length > 0) {
  console.error('');
  console.error('❌ 문서에 적힌 값과 어긋난다 — 대본이 바뀌었으면 아래 둘도 같이 고쳐야 한다:');
  console.error('   요구사항정의서.md §7.10 · 논문진행_디버깅가시화_260826.md §3-2');
  for (const line of drift) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('');
console.log('✅ 요구사항정의서 §7.10 · 논문 §3-2 에 적힌 값과 일치');
