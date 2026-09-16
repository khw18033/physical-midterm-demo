/**
 * src/data/pipelineEditor.ts
 *
 * VZ-U-04 — 편집기는 HTTP 계약만 알고 실제 실행기·저장소를 직접 만지지 않는다.
 *
 * 주고받는 그래프는 전부 **F4 계약형**이다. 편집기 좌표는 계약 객체 안이 아니라
 * `layout`으로 나란히 실려 간다 (REQ-1002). 직렬화 자체는
 * `shared/pipeline-contract.ts` 한 곳에만 있고 목 게이트웨이가 같은 함수를 쓴다.
 */

import { GATEWAY } from '../transport/index.ts';
import {
  connectionRefusal,
  fromContract,
  resolveCatalog,
  toContract,
  type CatalogNode,
  type ContractNode,
  type NodeLayout,
  type PipelineContract,
  type PipelineDraft,
  type PortType,
  type ValidationIssue,
} from '../../shared/pipeline-contract.ts';

export {
  catalogKeyOf,
  draftFingerprint,
  fromContract,
  nextNodeId,
  nodeFromCatalog,
  resolveCatalog,
  toContract,
} from '../../shared/pipeline-contract.ts';
export type {
  CatalogNode,
  ContractNode,
  NodeLayout,
  PipelineContract,
  PipelineDraft,
  PortType,
  ValidationIssue,
} from '../../shared/pipeline-contract.ts';

export type CatalogResponse = {
  nodes: CatalogNode[];
  /** 파생된 포트 타입 어휘. 화면이 타입 표를 따로 갖지 않는 근거. */
  port_types: PortType[];
  /** 카탈로그를 만든 등록 파일들. 목이라는 사실과 근거를 화면에 드러내는 재료. */
  registration_sources: string[];
  note: string;
};

export type PipelineState = {
  active: PipelineContract | null;
  previous: PipelineContract | null;
  activeLayout: Record<string, NodeLayout>;
  previousLayout: Record<string, NodeLayout>;
  audit: Array<{ action: string; graph_id: string; version: string; at: string; actor: string }>;
};

export type TestResult = {
  ok: boolean;
  issues: ValidationIssue[];
  token: string | null;
  outputs: Array<{ node_id: string; status: string; rows: number; elapsed_ms: number }>;
  /** 목 실행기라는 사실. 화면이 이 문구를 그대로 보여준다. */
  executor?: string;
};

/** REQ-1007 — 반영된 그래프의 역방향 관측. 시험 결과와 **다른 응답**이다. */
export type NodeObservation = {
  node_id: string;
  kind: 'source' | 'transform' | 'sink';
  bound_to: string | null;
  received: number;
  last_at: string | null;
  last_value: string | null;
  origin: 'live' | 'mock-propagated' | 'none';
};
export type ObservationReport = {
  graph_id: string | null;
  version: string | null;
  since: string | null;
  executor: string;
  nodes: NodeObservation[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(GATEWAY.http + path, init);
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body;
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

export const fetchNodeCatalog = () => api<CatalogResponse>('/pipelines/catalog');
export const fetchPipelineState = () => api<PipelineState>('/pipelines/state');
export const fetchObservation = () => api<ObservationReport>('/pipelines/observation');

/** 초안을 계약으로 직렬화해서 보낸다. **좌표는 계약 바깥으로 간다.** */
export const testPipeline = (draft: PipelineDraft) => api<TestResult>('/pipelines/test', post({ graph: toContract(draft) }));
export const commitPipeline = (draft: PipelineDraft, token: string) =>
  api<{ ok: true; message: string; state: PipelineState }>('/pipelines/commit', post({ graph: toContract(draft), layout: draft.layout, token }));
export const rollbackPipeline = () => api<{ ok: true; message: string; state: PipelineState }>('/pipelines/rollback', post());

/** 운영 상태 응답 → 초안. 계약과 레이아웃을 다시 합쳐 화면이 쓰는 형태로 만든다. */
export function draftFromState(state: PipelineState): PipelineDraft | null {
  return state.active === null ? null : fromContract(state.active, state.activeLayout);
}

/** UI가 두 노드를 이어도 되는지 물을 때. 사유 문자열이 그대로 화면에 뜬다 (REQ-1004). */
export function canConnect(catalog: readonly CatalogNode[], from: ContractNode, to: ContractNode): string | null {
  const fromEntry = resolveCatalog(catalog, from);
  const toEntry = resolveCatalog(catalog, to);
  if (!fromEntry || !toEntry) return '카탈로그에 없는 노드라 타입을 확인할 수 없다';
  return connectionRefusal(
    { id: from.id, kind: from.kind, emits: fromEntry.emits, label: fromEntry.label },
    { id: to.id, kind: to.kind, accepts: toEntry.accepts, label: toEntry.label },
  );
}

/**
 * 첫 진입용 초안. **카탈로그에서 고른다** — 어떤 노드가 있는지 코드가 알고 있으면
 * REQ-1003이 다시 깨진다. 맞는 짝이 없으면 빈 초안을 주고 화면이 그 사실을 말한다.
 */
export function starterDraft(catalog: readonly CatalogNode[]): PipelineDraft {
  const empty: PipelineContract = { id: 'starter-draft', version: '1.0.0', serializationFormat: 'json', nodes: [], edges: [] };
  const sources = catalog.filter((n) => n.kind === 'source');
  const pair = sources
    .map((source) => ({ source, sink: catalog.find((n) => n.kind === 'sink' && source.emits !== null && n.accepts?.includes(source.emits)) }))
    .find((p) => p.sink !== undefined);
  if (!pair || !pair.sink) return fromContract(empty);

  const emits = pair.source.emits;
  const transform = catalog.find((n) => n.kind === 'transform' && emits !== null && n.accepts?.includes(emits) && n.emits === emits);

  const nodes: ContractNode[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  const add = (entry: CatalogNode, id: string) => {
    const node: ContractNode = { id, kind: entry.kind, executionLocation: entry.executionLocation };
    if (entry.defaults.source) node.source = { ...entry.defaults.source };
    if (entry.defaults.transform) node.transform = { ...entry.defaults.transform };
    if (entry.defaults.sink) node.sink = { ...entry.defaults.sink };
    nodes.push(node);
    return id;
  };
  const src = add(pair.source, 'source_1');
  const mid = transform ? add(transform, 'transform_1') : null;
  const out = add(pair.sink, 'sink_1');
  if (mid) {
    edges.push({ from: src, to: mid }, { from: mid, to: out });
  } else {
    edges.push({ from: src, to: out });
  }

  return fromContract({
    id: 'starter-draft',
    version: '1.0.0',
    displayName: '카탈로그에서 만든 첫 초안',
    serializationFormat: 'json',
    nodes,
    edges,
  });
}
