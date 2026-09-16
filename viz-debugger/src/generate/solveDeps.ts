/**
 * src/generate/solveDeps.ts (260904 신설 — 마일스톤 분리 지시서 §5)
 *
 * **`deps` 를 모델이 만들게 하지 않는다.** 모델은 노드 목록만 내고, 의존은 여기서 규칙으로
 * 계산한다.
 *
 * ## 왜 규칙인가
 *
 * 대본 1편의 병렬 가지(`T-14b`·`T-14c`)는 `worldTimeline` 34s/44s 의 `in_view` 변화가
 * 근거였다. 그런데 `VZ-G-02` 는 **실행 전**에 DAG 를 만든다 — worldTimeline 이 없다.
 * 근거 없는 상태에서 `deps` 배열을 직접 내게 하면 순환·고아 노드·엉뚱한 합류가 나온다.
 *
 * 부수 효과 둘이 크다.
 *  - **모델이 순환을 만들 수 없다.** 모든 의존은 **목록에서 자기보다 앞선 노드**만
 *    가리키므로 순환이 구조적으로 불가능하다. `graph/layout.ts` 의 `depths()` 무한 재귀
 *    위험이 원천에서 사라진다.
 *  - **이 규칙 세트가 그대로 `VZ-G-03` 검증기의 규칙이 된다.** 생성과 검증이 자연히 갈라진다.
 *
 * ## 병렬은 만들어지는 것이 아니라 남는 것이다
 *
 * 지시서의 마지막 규칙 —「제약이 없으면 매달지 않는다」— 이 요점이다. `T-14b`(위치 발행)와
 * `T-14c`(카메라 시야 이탈)가 갈라지는 이유가 「다른 자원이라 서로 기다릴 필요가 없다」로
 * 설명되고, 이것은 **실행 기록 없이 성립한다.**
 *
 * 그 「제약 없음」이 실제로 생기는 자리는 **`sense` 하나뿐**이다 — 관측은 입력이라
 * 기다릴 것이 없다. 나머지 넷은 각자 앞선 것을 기다린다(아래 `UPSTREAM`).
 *
 * ## 규칙 다섯 (지시서 §5 표 · 복원 결과에 맞춰 보강한 자리는 그때그때 적었다)
 *
 * | 규칙 | 내용 |
 * |---|---|
 * | 자원 순차 | 같은 `target` 의 `act` 끼리는 순서를 지킨다 |
 * | 관측 선행 | `decide` 는 자기가 쓰는 `sense` 뒤에 온다 |
 * | 검증 후행 | `verify` 는 대응하는 `act` 뒤에 온다 |
 * | 마일스톤 경계 | 마일스톤 안에서 매달릴 곳이 없는 노드는 이전 마일스톤의 **끝 노드**에 매달린다 |
 * | 그 외 | 제약이 없으면 매달지 않는다 |
 *
 * **지시서에서 보강한 곳 둘** (`verify:dep-rules` 의 복원 결과가 근거다):
 *
 *  1. **「구동 인가」와 「보고 후행」을 더했다.** 지시서 표에는 `act`·`report` 가 무엇 뒤에
 *     오는지가 없다. 그대로 두면 대본 1편 MS-A 의 `T-11b`(주행)가 `T-11a`(경로 계획) 뒤에
 *     오는 것을 복원하지 못한다. 판정·관측이 구동을 허가하고, 보고는 그 마일스톤에서
 *     확정된 것 뒤에 온다 — 둘 다 실행 기록 없이 성립하는 제약이다.
 *  2. **마일스톤 경계를 「첫 노드」가 아니라 「매달릴 곳이 없는 노드 전부」로 읽었다.**
 *     첫 노드만 매달면 대본 1편 MS-D 의 `T-14b`·`T-14c` 가 임무에서 떨어져 나가고,
 *     그러면 MS-E 의 **합류가 사라진다** — 지시서가 예로 든 바로 그 합류다.
 *
 * 순수 함수다. React 도 저장소도 대본 파일도 모른다 — `verify:dep-rules` 가 Node 에서
 * 그대로 돌린다.
 */

import type { NodeKind } from '../model/types.ts';

/** 모델이 내는 것. 마일스톤별로 **일렬로** 온다 — 그 순서가 곧 계획의 순서다. */
export type GeneratedNode = {
  id: string;
  title: string;
  nodeKind: NodeKind;
  /** 대상 장비. 없는 노드(임무 종료 처리 등)는 null — 그 자체가 하나의 자원으로 묶인다. */
  target: string | null;
  milestoneId: string;
};

/**
 * 마일스톤에 적힌 계획 주석 (260908 · 분기와 되풀이 2단계 · `milestone.schema.json`).
 *
 * **노드에 얹지 않고 따로 받는다.** 노드마다 같은 값을 복사해 넣으면 그 둘이 어긋날 수
 * 있고, 어긋난 순간 규칙이 조용히 다른 그래프를 만든다.
 */
export type MilestonePlan = {
  id: string;
  /** 이 마일스톤이 **어느 마일스톤의 어느 판정 결과로 들어오는가.** 갈래는 배타적이다. */
  branch?: { from: string; when: 'pass' | 'fail' };
  /** 이 마일스톤이 끝났을 때 **어디로 되돌아가는가.** `deps` 가 아니라 `refEdges` 로 나간다. */
  repeatOf?: { to: string; when: 'pass' | 'fail' };
};

/** 되돌아가는 참조 엣지. **`deps` 가 아니다** — `layout.ts` 의 `depths()` 가 무한 재귀한다. */
export type SolvedRefEdge = { from: string; to: string; label: string; note?: string };

export type RuleId = 'upstream' | 'resource' | 'milestone-boundary';

export type SolveResult = {
  /** 노드 id → 의존 노드 id 들. 전이 축약이 끝난 최소 집합이다. */
  deps: Record<string, string[]>;
  /** 규칙별로 낸 엣지 수(축약 전). 규칙이 실제로 도는지 사람이 확인하는 자리. */
  byRule: Record<RuleId, number>;
  /** 전이 축약으로 지운 엣지 수. 이미 조상인 것을 두 번 적지 않는다. */
  reduced: number;
  /** 마일스톤 블록. 같은 마일스톤이 떨어져 두 번 나오면 블록도 둘이다(2편의 재탐색 루프). */
  blocks: Array<{ milestoneId: string; nodeIds: string[] }>;
  /**
   * 되돌아가는 참조 엣지 (260908). **주석이 없으면 언제나 비어 있다** — 지어내지 않는다(§5).
   * `deps` 와 섞지 않는 이유는 `SolvedRefEdge` 에 적었다.
   */
  refEdges: SolvedRefEdge[];
  /**
   * 앞을 안 가리켜서 **무시한** 주석의 수.
   *
   * 모델은 없는 마일스톤이나 **뒤**를 가리킬 수 있다. 그대로 매달면 순환이 생기므로
   * 버리는데, **조용히 버리면 왜 안 갈렸는지 아무도 모른다.** 0이 정상이다.
   */
  ignoredPlan: number;
};

/**
 * 어떤 종류가 어떤 종류를 기다리는가.
 *
 * **`sense` 만 비어 있다.** 관측은 입력이라 기다릴 것이 없고, 그래서 병렬이 생기는 자리도
 * 여기 하나다. 나머지 넷은 자기 앞의 「확정된 것」을 기다린다.
 */
const UPSTREAM: Record<NodeKind, readonly NodeKind[]> = {
  /** 관측은 입력이다 — 제약 없음. 병렬은 여기서 남는다. */
  sense: [],
  /** 관측 선행 — 판정은 자기가 쓰는 관측 뒤에. 판정이 이어지면 그 순서도 지킨다. */
  decide: ['sense', 'decide'],
  /** 구동 인가 — 판정·관측이 구동을 허가한다. 검증 뒤의 다음 구동, 구동끼리의 순서도 여기다. */
  act: ['decide', 'sense', 'act', 'verify'],
  /** 검증 후행 — 검증은 대응하는 구동 뒤에. 검증이 이어지면 그 순서도 지킨다. */
  verify: ['act', 'verify'],
  /** 보고 후행 — 보고는 그 마일스톤에서 확정된 것 뒤에 온다. */
  report: ['sense', 'decide', 'act', 'verify', 'report'],
};

/**
 * 마일스톤 블록. **같은 마일스톤 id 가 떨어져 두 번 나오면 블록도 둘이다** —
 * 대본 2편은 재탐색 루프라 `MS-D` 가 두 번 등장한다. 그것을 한 덩어리로 뭉치면
 * 뒤 블록이 앞 블록의 미래에 의존하게 되고 순환이 생긴다.
 */
function blocksOf(nodes: readonly GeneratedNode[]): Array<{ milestoneId: string; indices: number[] }> {
  const blocks: Array<{ milestoneId: string; indices: number[] }> = [];
  for (const [index, node] of nodes.entries()) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.milestoneId === node.milestoneId) last.indices.push(index);
    else blocks.push({ milestoneId: node.milestoneId, indices: [index] });
  }
  return blocks;
}

/**
 * 노드 목록 → `deps`.
 *
 * 모든 엣지는 **목록에서 앞선 노드**만 가리킨다. 그래서 결과는 항상 DAG 다 —
 * 순환 검사가 필요 없다는 뜻이 아니라, 순환이 나오면 그건 이 함수의 버그라는 뜻이다
 * (`verify:dep-rules` 가 무작위 목록으로도 그것을 본다).
 */
export function solveDeps(nodes: readonly GeneratedNode[], plan: readonly MilestonePlan[] = []): SolveResult {
  const blocks = blocksOf(nodes);
  // 주석은 마일스톤 id 로 찾는다. **안 주면 아래 규칙 전부가 지금까지와 글자 하나 다르지
  // 않게 돈다** — 그것이 이 인자가 선택인 이유이고, 기존 복원이 안 흔들리는 근거다.
  const planOf = new Map(plan.map((entry) => [entry.id, entry]));
  const refEdges: SolvedRefEdge[] = [];
  let ignoredPlan = 0;
  const raw = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set<string>()]));
  const byRule: Record<RuleId, number> = { upstream: 0, resource: 0, 'milestone-boundary': 0 };

  // ── 규칙 1~4 — 블록 안의 선행 (관측 선행 · 구동 인가 · 검증 후행 · 보고 후행) ──
  for (const block of blocks) {
    for (const [position, index] of block.indices.entries()) {
      const node = nodes[index];
      const upstream = UPSTREAM[node.nodeKind] ?? [];
      if (upstream.length === 0) continue; // sense — 제약이 없으면 매달지 않는다
      // **가장 가까운 앞선 것 하나.** 더 앞의 것은 전이로 이미 조상이다.
      for (let back = position - 1; back >= 0; back -= 1) {
        const candidate = nodes[block.indices[back]];
        if (upstream.includes(candidate.nodeKind)) {
          raw.get(node.id)!.add(candidate.id);
          byRule.upstream += 1;
          break;
        }
      }
    }
  }

  // ── 규칙: 자원 순차 — 같은 target 의 act 끼리 (임무 전체) ────────────────────
  // 블록 안에서는 위 규칙이 이미 잡지만, 마일스톤을 건너는 같은 자원의 구동은 여기서 잡는다.
  // 대개는 경계 규칙이 만든 경로에 이미 들어 있어 전이 축약에서 지워진다 — 그래도 규칙은
  // 남겨 둔다. 지워졌다는 사실 자체가 「경계가 자원 순서를 이미 지키고 있다」는 확인이다.
  const lastAct = new Map<string, string>();
  for (const node of nodes) {
    if (node.nodeKind !== 'act') continue;
    const key = node.target ?? '(대상 없음)';
    const previous = lastAct.get(key);
    if (previous !== undefined) {
      raw.get(node.id)!.add(previous);
      byRule.resource += 1;
    }
    lastAct.set(key, node.id);
  }

  // ── 규칙: 마일스톤 경계 ──────────────────────────────────────────────────────
  //
  // 블록 안에서 매달릴 곳이 없는 노드는 **앞 블록의 끝 노드 전부**에 매달린다.
  // 「첫 노드만」이면 sense 여럿이 임무에서 떨어져 나가고 다음 마일스톤의 합류가 사라진다.
  //
  // **「앞 블록」이 어느 블록인가**를 정하는 것이 260908 에 바뀐 자리다. 주석이 없으면
  // 직전 하나이고(지금까지와 같다), 주석이 있으면 셋으로 갈린다 — 아래 `predecessorsOf`.

  /** 그 블록의 **끝 노드**들 — 블록 안에서 뒤따르는 것이 없는 노드. */
  const endsOf = (block: { indices: number[] }): string[] => {
    const ids = block.indices.map((index) => nodes[index].id);
    const hasSuccessor = new Set<string>();
    for (const index of block.indices) {
      for (const dep of raw.get(nodes[index].id)!) if (ids.includes(dep)) hasSuccessor.add(dep);
    }
    return ids.filter((id) => !hasSuccessor.has(id));
  };

  /**
   * 그 마일스톤의 **마지막 블록 번호** (`before` 앞에서). 같은 마일스톤이 떨어져 두 번
   * 나올 수 있다 — 2편의 `MS-D` 가 그렇다.
   *
   * `findLastIndex` 를 안 쓴다: `tsconfig` 의 `lib` 이 ES2022 라 타입이 없다. 런타임에는
   * 있지만 **타입 검사가 못 보는 것을 쓰면 그 줄만 검사 밖에 놓인다.**
   */
  const lastBlockOf = (milestoneId: string, before: number): number => {
    for (let index = Math.min(before, blocks.length) - 1; index >= 0; index -= 1) {
      if (blocks[index].milestoneId === milestoneId) return index;
    }
    return -1;
  };

  /**
   * 이 블록이 매달릴 앞 블록들.
   *
   *  1. **갈래** — 이 마일스톤이 `branch.from` 을 적었으면 **그 마일스톤에만** 매달린다.
   *     형제 갈래에는 안 매달린다: 그것이 「둘 중 하나」와 「둘 다 차례로」를 가르는 자리이고,
   *     10단계 §7 이 찾은 실패가 정확히 여기였다.
   *  2. **합류** — 갈래가 아닌 블록 바로 앞에 **같은 판정을 가리키는 갈래들이 이어져
   *     있으면** 그 갈래 **전부**의 끝에 매달린다. 하나에만 매달면 안 지나간 갈래가
   *     임무에서 떨어져 나간다.
   *  3. 그 외 — 직전 블록 하나 (지금까지의 규칙).
   *
   * **앞을 안 가리키는 주석은 무시한다.** 없는 마일스톤이나 뒤를 가리키면 매달 곳이 없거나
   * 순환이 생긴다 — 모델이 낼 수 있는 값이므로 규칙이 견뎌야 하고, 버린 사실은 센다.
   */
  const predecessorsOf = (order: number): number[] => {
    const own = planOf.get(blocks[order].milestoneId);
    if (own?.branch !== undefined) {
      const at = lastBlockOf(own.branch.from, order);
      if (at >= 0) return [at];
      ignoredPlan += 1; // 앞에 없는 마일스톤을 가리켰다 — 직전 블록으로 물러선다
      return [order - 1];
    }
    // 합류 — 바로 앞에 이어진 갈래들을 모은다.
    const siblings: number[] = [];
    let from: string | null = null;
    for (let back = order - 1; back >= 0; back -= 1) {
      const branch = planOf.get(blocks[back].milestoneId)?.branch;
      if (branch === undefined) break;
      if (from === null) from = branch.from;
      else if (branch.from !== from) break;
      siblings.unshift(back);
    }
    return siblings.length > 0 ? siblings : [order - 1];
  };

  for (const [order, block] of blocks.entries()) {
    if (order === 0) continue;
    const ends = predecessorsOf(order).flatMap((at) => endsOf(blocks[at]));
    for (const index of block.indices) {
      const node = nodes[index];
      const own = raw.get(node.id)!;
      const inBlock = [...own].some((dep) => block.indices.some((other) => nodes[other].id === dep));
      if (inBlock) continue;
      for (const end of ends) {
        own.add(end);
        byRule['milestone-boundary'] += 1;
      }
    }
  }

  // ── 규칙: 되돌아감 — **`deps` 가 아니라 `refEdges` 로 낸다** ──────────────────
  //
  // `layout.ts` 의 `depths()` 가 순환에서 무한 재귀한다(5단계에 겪었고 대본 2편 주석에
  // 적혀 있다). 그래서 되돌아가는 것은 그리기 전용 참조 엣지로만 편다 — 이 규칙이
  // `deps` 를 **한 글자도** 건드리지 않는 것이 순환 불가능 보장을 지키는 방법이다.
  //
  // 펴는 규칙은 「**끝 노드 → 첫 노드**」다. 1단계가 대본 2편으로 확인했다:
  // 마일스톤 `MS-F --(fail)--> MS-C` 를 이렇게 펴면 `T-27c → T-23a` 이고, 그것이 사람이
  // 손으로 적은 엣지와 글자까지 같다.
  for (const [order, block] of blocks.entries()) {
    const repeat = planOf.get(block.milestoneId)?.repeatOf;
    if (repeat === undefined) continue;
    // 같은 마일스톤이 떨어져 두 번 나오면 **마지막 블록**에서 되돌아간다.
    if (lastBlockOf(block.milestoneId, blocks.length) !== order) continue;
    const at = blocks.findIndex((other) => other.milestoneId === repeat.to);
    if (at < 0 || at >= order) { ignoredPlan += 1; continue; } // 앞으로 되돌아갈 수 없다
    const from = endsOf(block).slice(-1)[0];
    const to = nodes[blocks[at].indices[0]].id;
    if (from === undefined || to === undefined) { ignoredPlan += 1; continue; }
    refEdges.push({
      from,
      to,
      label: `${block.milestoneId} 판정이 ${repeat.when} 이면 ${repeat.to} 로`,
      note: 'deps 에 넣으면 layout.depths() 가 무한 재귀한다 — 점선 참조 엣지로만 그린다',
    });
  }

  // ── 전이 축약 ────────────────────────────────────────────────────────────────
  // 이미 조상인 것을 명시하지 않는다. 대본의 정답 DAG 도 축약된 모양이라, 이걸 안 하면
  // 자원 순차가 낸 「먼 조상」이 그대로 남아 복원이 어긋난다.
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const reachable = new Map<string, Set<string>>();
  const ancestorsOf = (id: string): Set<string> => {
    const cached = reachable.get(id);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    for (const dep of raw.get(id) ?? []) {
      out.add(dep);
      for (const deeper of ancestorsOf(dep)) out.add(deeper);
    }
    reachable.set(id, out);
    return out;
  };
  // 앞에서부터 채워야 재귀가 얕다 — 엣지는 늘 앞을 가리키므로 순서대로면 캐시가 항상 맞는다.
  for (const node of nodes) ancestorsOf(node.id);

  let reduced = 0;
  const deps: Record<string, string[]> = {};
  for (const node of nodes) {
    const own = [...(raw.get(node.id) ?? [])];
    const kept = own.filter((dep) => {
      // 다른 의존을 통해 이미 닿는 곳이면 지운다.
      const viaOther = own.some((other) => other !== dep && ancestorsOf(other).has(dep));
      if (viaOther) reduced += 1;
      return !viaOther;
    });
    deps[node.id] = kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  return {
    deps,
    byRule,
    reduced,
    blocks: blocks.map((block) => ({ milestoneId: block.milestoneId, nodeIds: block.indices.map((index) => nodes[index].id) })),
    refEdges,
    ignoredPlan,
  };
}

/**
 * 순환이 있는가. `solveDeps()` 의 결과에는 **있으면 안 된다** — 있으면 이 파일의 버그다.
 * `VZ-G-03` 검증기가 모델이 직접 낸 `deps` 를 받을 때도 같은 함수를 쓴다.
 */
export function hasCycle(deps: Readonly<Record<string, readonly string[]>>): boolean {
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') return true;
    state.set(id, 'open');
    for (const dep of deps[id] ?? []) if (dep in deps && visit(dep)) return true;
    state.set(id, 'done');
    return false;
  };
  return Object.keys(deps).some((id) => visit(id));
}
