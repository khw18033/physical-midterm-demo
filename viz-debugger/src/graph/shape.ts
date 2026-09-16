/**
 * src/graph/shape.ts (260904 — 추가 개선 4)
 *
 * **이 임무가 어떻게 생겼는가.** 머리줄이 고정 문구(「분기와 합류가 있는 태스크 DAG」)를
 * 걸고 있었는데, 그 문장은 대본에 따라 거짓이 된다 — 3편은 합류가 하나도 없다.
 *
 * ## 화면은 자기 모양만 말한다
 *
 * 배치 모드 토글(DAG/트리)이 없어졌다. 회의록 §10의 「그래프 형태 vs 트리 형태」 미결이
 * **그래프로 닫혔기** 때문이다 — 회의록 §4-3이 요구한 「여러 갈래가 다시 하나의 박스로
 * 모이는 형태」가 합류이고, 부모가 하나뿐인 것이 트리의 정의라 트리는 합류를 표현할 수 없다
 * (요구사항정의서 §7.10).
 *
 * 그래서 **화면에서는 트리를 언급하지 않는다.** 없는 기능을 설명하면 "그게 뭔데?"가 생긴다.
 * 머리줄은 그 임무 자신의 모양(노드 수 · 합류 · 되돌아감)만 적는다. 트리와의 비교는
 * **측정 도구와 논문에서만** 다룬다 — `scripts/measure-representation.mjs`.
 */

import type { RefEdge, Task } from '../model/types.ts';

export type GraphShape = {
  /** 지금 보고 있는 범위의 노드 수. */
  nodes: number;
  /** **합류** — 들어오는 화살표가 둘 이상인 노드. 트리가 표현하지 못하는 바로 그것이다. */
  merges: number;
  /** **되돌아감** — 참조 엣지(`refEdges`). `deps` 가 아니라서 깊이 계산에는 안 들어간다. */
  loops: number;
};

/**
 * 범위 안의 모양. `deps` 중 **그 범위 안에 실재하는 것**만 센다 — 마일스톤 하나만 보고 있을
 * 때 밖으로 나간 의존까지 세면 화면에 없는 합류를 있다고 적게 된다.
 */
export function graphShape(tasks: readonly Task[], refEdges: readonly RefEdge[] = []): GraphShape {
  const present = new Set(tasks.map((task) => task.id));
  let merges = 0;
  for (const task of tasks) {
    if (task.deps.filter((dep) => present.has(dep)).length > 1) merges += 1;
  }
  const loops = refEdges.filter((edge) => present.has(edge.from) && present.has(edge.to)).length;
  return { nodes: tasks.length, merges, loops };
}

/**
 * 머리줄 한 줄. **트리라는 말이 여기 들어가면 안 된다.**
 * 합류도 되돌아감도 없으면 「일직선」이다 — 없는 것을 「합류 0」이라고 적으면 읽는 사람이
 * 무엇과 비교되고 있는지 묻게 된다.
 */
export function shapeLabel(shape: GraphShape): string {
  const parts: string[] = [`${shape.nodes}노드`];
  if (shape.merges > 0) parts.push(`합류 ${shape.merges}`);
  if (shape.loops > 0) parts.push(`되돌아감 ${shape.loops}`);
  if (shape.merges === 0 && shape.loops === 0) parts.push('일직선');
  return `태스크 DAG — ${parts.join(' · ')}`;
}

/**
 * **트리로 펼치면 노드가 몇 개가 되는가** — 측정 전용이다.
 *
 * 부르는 곳은 `scripts/measure-representation.mjs` **하나뿐이고 화면이 아니다.**
 * `treeLayout()` 이 `graph/layout.ts` 에 남아 있되 호출부가 `scripts/` 로 옮겨 간 것과
 * 같은 이유다 — 「트리를 만들지 않은 이유」를 주장이 아니라 숫자로 내기 위해 계산은 남긴다.
 *
 * 트리는 노드마다 부모가 하나여야 하므로, 합류가 있으면 그 아래가 **경로 수만큼 복제된다.**
 * 그래서 펼친 노드 수는 「뿌리에서 그 노드까지의 서로 다른 경로 수」의 합이다.
 */
export function treeExpansion(tasks: readonly Task[]): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const paths = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    // 순환 방어선 — `deps` 에 루프가 들어와도 멎지 않는다 (`layout.ts` 의 depths() 와 같은 이유).
    memo.set(id, 1);
    const deps = (byId.get(id)?.deps ?? []).filter((dep) => byId.has(dep));
    const count = deps.length === 0 ? 1 : deps.reduce((sum, dep) => sum + paths(dep), 0);
    memo.set(id, count);
    return count;
  };
  return tasks.reduce((sum, task) => sum + paths(task.id), 0);
}
