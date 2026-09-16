// 이식: web-dashboard/shared/pipeline-contract.ts @ 700ed91 — 무수정
/**
 * shared/pipeline-contract.ts
 *
 * REQ-1002 — 편집기 초안과 F4 파이프라인 계약(`contracts/pipeline.schema.json`) 사이의
 * **무손실 왕복**.
 *
 * 지키는 규칙 둘.
 *  1. **표준형은 계약이다.** 초안은 새 그래프 형식이 아니라
 *     `{ pipeline: <계약 그대로>, layout: <편집기 전용> }` 두 칸으로 나뉜 봉투다.
 *     `pipeline`에 들어가는 것은 계약 스키마가 아는 키뿐이고, 좌표 같은 편집기 고유
 *     정보는 `layout`에만 있다. 계약이 오염되면 백엔드 실물 계약이 왔을 때
 *     "HTTP 어댑터만 교체"가 성립하지 않는다.
 *  2. **직렬화는 이 파일 한 곳에만 있다.** 화면과 목 게이트웨이가 같은 함수를 쓴다.
 *     양쪽이 각자 직렬화하면 왕복이 어긋나는 순간을 잡을 수 없다.
 *
 * 이 파일은 브라우저·Node 어느 쪽에도 의존하지 않는다(DOM·fs 금지). 그래서 `src/`와
 * `mock-gateway/` 양쪽에서 그대로 import한다.
 */

// ── 계약 그대로의 타입 ───────────────────────────────────────────────────────
// contracts/pipeline.schema.json 과 1:1이다. 여기에 키를 더하면 계약이 깨진다.

export type NodeKind = 'source' | 'transform' | 'sink';
export type ExecutionLocation = 'server' | 'client';
export type QueryMode = 'instant' | 'range' | 'stream';
export type SerializationFormat = 'json' | 'cbor' | 'protobuf' | 'msgpack';

export type SourceConfig = {
  dataSourceRef: string;
  queryMode: QueryMode;
  query: string;
  timeoutMs?: number;
};
export type TransformConfig = {
  operator: string;
  params?: Record<string, unknown>;
};
export type SinkConfig = {
  rendererType: string;
  componentRef: string;
  fieldRef: string;
  rendererConfig?: Record<string, unknown>;
};

export type ContractNode = {
  id: string;
  kind: NodeKind;
  executionLocation: ExecutionLocation;
  source?: SourceConfig;
  transform?: TransformConfig;
  sink?: SinkConfig;
};

export type ContractEdge = { from: string; to: string };

export type PipelineContract = {
  id: string;
  version: string;
  displayName?: string;
  description?: string;
  serializationFormat: SerializationFormat;
  extensionPoint?: 'E5';
  nodes: ContractNode[];
  edges: ContractEdge[];
};

// ── 편집기 전용 영역 ─────────────────────────────────────────────────────────

/** 노드 좌표. **계약 객체 안에 들어가지 않는다** (REQ-1002). */
export type NodeLayout = { x: number; y: number };

/** 편집기가 들고 다니는 초안. 계약 본문과 편집기 레이아웃이 물리적으로 갈려 있다. */
export type PipelineDraft = {
  pipeline: PipelineContract;
  layout: Record<string, NodeLayout>;
};

// ── 카탈로그 ─────────────────────────────────────────────────────────────────

/**
 * 포트 타입은 **컴포넌트 디스크립터의 필드 타입 어휘**를 그대로 쓴다
 * (`number` · `string` · `boolean` · `enum` · `object` · `array` · `binary-stream`).
 * 렌더러가 `acceptsFieldTypes`로 받는 것도 같은 어휘라서, 코드에 타입 표를 다시
 * 적지 않고도 source 출력과 sink 입력을 맞댈 수 있다 (REQ-1003 · REQ-1004).
 */
export type PortType = string;

export type CatalogNode = {
  /** 카탈로그 키. 계약 노드만 있으면 `catalogKeyOf()`로 되계산할 수 있어야 한다. */
  type: string;
  label: string;
  kind: NodeKind;
  /** 입력 포트가 받는 필드 타입들. source는 입력이 없으므로 null. */
  accepts: PortType[] | null;
  /** 출력 포트가 내보내는 필드 타입. sink는 출력이 없으므로 null. */
  emits: PortType | null;
  executionLocation: ExecutionLocation;
  /** 이 항목이 어느 등록 파일에서 파생됐는가. 목이라는 사실과 근거를 함께 드러낸다. */
  derivedFrom: string[];
  /** 계약 노드에 채워 넣을 kind별 기본 설정. 카탈로그가 이 값을 제공한다. */
  defaults: { source?: SourceConfig; transform?: TransformConfig; sink?: SinkConfig };
};

export type ValidationIssue = { code: string; message: string; nodes: string[] };

// ── 카탈로그 키 ──────────────────────────────────────────────────────────────

/**
 * 계약 노드 → 카탈로그 키. 계약에는 `type` 같은 편집기 낱말이 없으므로
 * **설정값에서 키를 되계산**한다. 이게 성립해야 계약 JSON만 받아도 초안을 복원할 수 있다.
 */
export function catalogKeyOf(node: ContractNode): string {
  if (node.kind === 'source' && node.source) {
    return 'source:' + node.source.dataSourceRef + ':' + node.source.queryMode + ':' + node.source.query;
  }
  if (node.kind === 'transform' && node.transform) return 'transform:' + node.transform.operator;
  if (node.kind === 'sink' && node.sink) return 'sink:' + node.sink.rendererType;
  return node.kind + ':<설정 없음>';
}

/**
 * 카탈로그 항목 찾기. 정확히 일치하는 키가 없으면 **질의 문자열을 뺀 앞자리**로 되짚는다 —
 * 사용자가 질의만 바꾼 노드도 여전히 같은 종류이기 때문이다.
 */
export function resolveCatalog(catalog: readonly CatalogNode[], node: ContractNode): CatalogNode | null {
  const key = catalogKeyOf(node);
  const exact = catalog.find((c) => c.type === key);
  if (exact) return exact;
  if (node.kind === 'source' && node.source) {
    const prefix = 'source:' + node.source.dataSourceRef + ':' + node.source.queryMode + ':';
    return catalog.find((c) => c.type.startsWith(prefix)) ?? null;
  }
  return null;
}

// ── 직렬화: 초안 → 계약 ──────────────────────────────────────────────────────

function pickSource(v: SourceConfig): SourceConfig {
  const out: SourceConfig = { dataSourceRef: v.dataSourceRef, queryMode: v.queryMode, query: v.query };
  if (v.timeoutMs !== undefined) out.timeoutMs = v.timeoutMs;
  return out;
}
function pickTransform(v: TransformConfig): TransformConfig {
  const out: TransformConfig = { operator: v.operator };
  if (v.params !== undefined) out.params = JSON.parse(JSON.stringify(v.params)) as Record<string, unknown>;
  return out;
}
function pickSink(v: SinkConfig): SinkConfig {
  const out: SinkConfig = { rendererType: v.rendererType, componentRef: v.componentRef, fieldRef: v.fieldRef };
  if (v.rendererConfig !== undefined) out.rendererConfig = JSON.parse(JSON.stringify(v.rendererConfig)) as Record<string, unknown>;
  return out;
}

/**
 * 초안 → 계약 JSON.
 *
 * **계약이 아는 키만 골라 다시 세운다.** 통째로 복사하지 않는 이유는, 어딘가에서
 * 노드 객체에 `x`를 붙여도 여기서 걸러지게 하기 위해서다. `additionalProperties: false`인
 * 계약에서 이 방어가 없으면 스키마 검증이 통째로 실패한다.
 */
export function toContract(draft: PipelineDraft): PipelineContract {
  const p = draft.pipeline;
  // 키 순서를 스키마 선언 순서에 맞춘다. 왕복이 **바이트 단위로** 같아야
  // "무손실"이라는 말을 문자열 비교로 확인할 수 있고, 화면에 띄운 계약 JSON도
  // 등록된 예시 파일과 같은 모양으로 읽힌다.
  return {
    id: p.id,
    version: p.version,
    ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    serializationFormat: p.serializationFormat,
    ...(p.extensionPoint !== undefined ? { extensionPoint: p.extensionPoint } : {}),
    nodes: p.nodes.map((n) => {
      const node: ContractNode = { id: n.id, kind: n.kind, executionLocation: n.executionLocation };
      if (n.kind === 'source' && n.source) node.source = pickSource(n.source);
      if (n.kind === 'transform' && n.transform) node.transform = pickTransform(n.transform);
      if (n.kind === 'sink' && n.sink) node.sink = pickSink(n.sink);
      return node;
    }),
    edges: p.edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

// ── 역직렬화: 계약 → 초안 ────────────────────────────────────────────────────

/** 좌표가 없는 노드에 줄 자리. kind 순서대로 열을 나눠 겹치지 않게만 놓는다. */
function autoLayout(pipeline: PipelineContract): Record<string, NodeLayout> {
  const column: Record<NodeKind, number> = { source: 0, transform: 1, sink: 2 };
  const rowOf = new Map<number, number>();
  const layout: Record<string, NodeLayout> = {};
  for (const node of pipeline.nodes) {
    const col = column[node.kind];
    const row = rowOf.get(col) ?? 0;
    rowOf.set(col, row + 1);
    layout[node.id] = { x: 40 + col * 270, y: 40 + row * 110 };
  }
  return layout;
}

/**
 * 계약 JSON → 초안. `layout`을 함께 주면 좌표까지 복원되고, 없으면 자동 배치한다.
 * 계약에 없는 노드의 좌표는 버리고, 계약에 있는데 좌표가 없는 노드는 채운다 —
 * 그래야 계약이 항상 노드 집합의 기준이 된다.
 */
export function fromContract(pipeline: PipelineContract, layout?: Record<string, NodeLayout>): PipelineDraft {
  const fallback = autoLayout(pipeline);
  const merged: Record<string, NodeLayout> = {};
  for (const node of pipeline.nodes) {
    const given = layout?.[node.id];
    merged[node.id] = given ? { x: given.x, y: given.y } : fallback[node.id];
  }
  return { pipeline: toContract({ pipeline, layout: {} }), layout: merged };
}

/** 초안 동일성 비교용 지문. 계약 본문과 레이아웃을 **함께** 본다. */
export function draftFingerprint(draft: PipelineDraft): string {
  return JSON.stringify({ pipeline: toContract(draft), layout: draft.layout });
}

/** 계약 본문만의 지문. 시험 실행 증명이 무엇에 걸려 있는지를 정하는 값이다. */
export function contractFingerprint(pipeline: PipelineContract): string {
  return JSON.stringify(toContract({ pipeline, layout: {} }));
}

// ── 검증 (REQ-1004) ──────────────────────────────────────────────────────────

/** 두 노드를 이을 수 있는가. 이을 수 없으면 사유 문자열을 돌려준다. */
export function connectionRefusal(
  from: { id: string; kind: NodeKind; emits: PortType | null; label: string },
  to: { id: string; kind: NodeKind; accepts: PortType[] | null; label: string },
): string | null {
  if (from.id === to.id) return '자기 자신에 연결할 수 없다';
  if (from.kind === 'sink' || from.emits === null) return 'sink 노드에는 출력이 없다';
  if (to.kind === 'source' || to.accepts === null) return 'source 노드에는 입력이 없다';
  if (!to.accepts.includes(from.emits)) return '타입 불일치: ' + from.emits + ' → ' + to.accepts.join('|');
  return null;
}

/**
 * 계약형 그래프 검증. **초안이 아니라 계약을 받는다** — 목 게이트웨이가 받는 것도
 * 계약이고, 실물 백엔드가 받을 것도 계약이기 때문이다.
 *
 * 포트 타입은 카탈로그에서 끌어온다. 카탈로그가 디스크립터·렌더러에서 파생되므로
 * 여기에도 타입 표가 없다.
 */
export function validateContract(pipeline: PipelineContract, catalog: readonly CatalogNode[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const node of pipeline.nodes) {
    if (ids.has(node.id)) issues.push({ code: 'duplicate_node', message: '중복 노드 id: ' + node.id, nodes: [node.id] });
    ids.add(node.id);
  }

  // kind별 설정이 계약대로 채워졌는가. 스키마의 allOf(if/then)와 같은 검사다.
  for (const node of pipeline.nodes) {
    const config = node.kind === 'source' ? node.source : node.kind === 'transform' ? node.transform : node.sink;
    if (config === undefined) {
      issues.push({ code: 'config_required', message: node.id + ': ' + node.kind + ' 설정이 비어 있다', nodes: [node.id] });
    }
    for (const stray of (['source', 'transform', 'sink'] as const).filter((k) => k !== node.kind && node[k] !== undefined)) {
      issues.push({ code: 'config_conflict', message: node.id + ': kind=' + node.kind + '인데 ' + stray + ' 설정이 있다', nodes: [node.id] });
    }
  }

  const resolved = new Map<string, CatalogNode>();
  for (const node of pipeline.nodes) {
    const entry = resolveCatalog(catalog, node);
    if (entry === null) {
      issues.push({ code: 'unknown_node', message: node.id + ': 카탈로그에 없는 노드 (' + catalogKeyOf(node) + ')', nodes: [node.id] });
      continue;
    }
    resolved.set(node.id, entry);
  }

  const byId = new Map(pipeline.nodes.map((n) => [n.id, n]));
  const labelOf = (id: string) => resolved.get(id)?.label ?? id;
  if (!pipeline.nodes.some((n) => n.kind === 'source')) issues.push({ code: 'source_required', message: 'source 노드가 필요하다', nodes: [] });
  if (!pipeline.nodes.some((n) => n.kind === 'sink')) issues.push({ code: 'sink_required', message: 'sink 노드가 필요하다', nodes: [] });

  const adjacency = new Map<string, string[]>();
  for (const edge of pipeline.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      issues.push({ code: 'missing_node', message: edge.from + ' → ' + edge.to + ': 존재하지 않는 노드', nodes: [edge.from, edge.to] });
      continue;
    }
    adjacency.set(from.id, [...(adjacency.get(from.id) ?? []), to.id]);
    if (from.kind === 'sink' || to.kind === 'source') {
      issues.push({ code: 'direction', message: 'sink에서 나가거나 source로 들어갈 수 없다', nodes: [from.id, to.id] });
    }
    const fromEntry = resolved.get(from.id);
    const toEntry = resolved.get(to.id);
    if (!fromEntry || !toEntry) continue;
    const emits = fromEntry.emits;
    const accepts = toEntry.accepts;
    if (emits === null || accepts === null || !accepts.includes(emits)) {
      const shown = accepts === null ? '없음' : accepts.join('|');
      issues.push({
        code: 'type_mismatch',
        message: fromEntry.label + '(' + (emits ?? '없음') + ') → ' + toEntry.label + '(' + shown + ') 타입 불일치',
        nodes: [from.id, to.id],
      });
    }
  }

  for (const node of pipeline.nodes) {
    const incoming = pipeline.edges.some((e) => e.to === node.id);
    const outgoing = pipeline.edges.some((e) => e.from === node.id);
    if (node.kind !== 'source' && !incoming) issues.push({ code: 'input_required', message: labelOf(node.id) + ': 입력 연결이 필요하다', nodes: [node.id] });
    if (node.kind !== 'sink' && !outgoing) issues.push({ code: 'output_required', message: labelOf(node.id) + ': 출력 연결이 필요하다', nodes: [node.id] });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (pipeline.nodes.some((n) => visit(n.id))) issues.push({ code: 'cycle', message: '순환 연결은 실행할 수 없다', nodes: [] });
  return issues;
}

// ── 초안 편집 도우미 ─────────────────────────────────────────────────────────

/** 카탈로그 항목으로 계약 노드를 만든다. **기본값은 카탈로그가 준다** (REQ-1002·1003). */
export function nodeFromCatalog(entry: CatalogNode, id: string): ContractNode {
  const node: ContractNode = { id, kind: entry.kind, executionLocation: entry.executionLocation };
  if (entry.kind === 'source' && entry.defaults.source) node.source = pickSource(entry.defaults.source);
  if (entry.kind === 'transform' && entry.defaults.transform) node.transform = pickTransform(entry.defaults.transform);
  if (entry.kind === 'sink' && entry.defaults.sink) node.sink = pickSink(entry.defaults.sink);
  return node;
}

/** 계약의 노드 id 규약(`^[a-zA-Z_][a-zA-Z0-9_-]*$`)을 지키는 새 id. */
export function nextNodeId(pipeline: PipelineContract, kind: NodeKind): string {
  let n = pipeline.nodes.length + 1;
  while (pipeline.nodes.some((node) => node.id === kind + '_' + n)) n += 1;
  return kind + '_' + n;
}
